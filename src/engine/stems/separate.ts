/**
 * HTDemucs source separation, segment by segment, straight into 16-bit stems.
 *
 * The model (Meta's Hybrid Transformer Demucs, MIT) sees a fixed 7.8 s
 * window of 44.1 kHz stereo and returns four parts: drums, bass, other and
 * vocals, each the sum of a waveform branch and a spectrogram branch. The
 * spectrogram in and out is spectral.ts (the same transforms as demucs-web,
 * MIT, about twice as fast); the loop around it is ours, so a long track
 * never needs four Float32 copies at once. Windows overlap by a quarter and
 * are cross-faded.
 *
 * Pipelined: while the model works on one segment (on the GPU), the next
 * segment's input and the last one's output are worked out here, so our
 * JavaScript adds little to the model's own time. (On the CPU backend the
 * model holds the thread, and the two simply take turns.)
 *
 * Only drums, bass and vocals are kept. "Other" is the track minus those
 * three — what Demucs itself guarantees, near enough — so with every part
 * turned up the deck plays the original file, not a reconstruction.
 *
 * Pure: no ONNX Runtime import, so it runs (and is tested) anywhere. Nothing
 * here is stored; the caller holds the result in memory only.
 */
import { CONSTANTS } from 'demucs-web';
import { SpectralIn, SpectralOut, type ModelInput } from './spectral';

export const MODEL_RATE = CONSTANTS.SAMPLE_RATE; // 44100
const SEG = CONSTANTS.TRAINING_SAMPLES; // 343 980 samples ≈ 7.8 s
const STRIDE = Math.floor(SEG * (1 - CONSTANTS.SEGMENT_OVERLAP));
const FADE = Math.floor(SEG - STRIDE); // the overlap, cross-faded linearly
const SPEC = 4 * CONSTANTS.MODEL_SPEC_BINS * CONSTANTS.MODEL_SPEC_FRAMES;

/** The parts kept, in this order (model track index in brackets): drums [0], bass [1], vocals [3]. */
export const KEPT = [0, 1, 3] as const;

export interface StemPcm {
  left: Int16Array;
  right: Int16Array;
}

interface TensorLike {
  dims: readonly number[];
  data: unknown;
}

/** The bit of an ONNX Runtime InferenceSession this needs. */
export interface Runner {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
}

export type MakeTensor = (data: Float32Array, dims: number[]) => unknown;

/** How the worker words a failed model download, so the background queue can tell it from a bad track. */
export const MODEL_FAILED = 'The stems model couldn’t be downloaded';
export const MODEL_OFFLINE = `${MODEL_FAILED} (no connection).`;
export const modelFailed = (message: string) => message.startsWith(MODEL_FAILED);

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

export function segmentCount(samples: number) {
  return samples <= SEG ? 1 : Math.ceil((samples - SEG) / STRIDE) + 1;
}

/** Cross-fade weight of sample `i` of segment `k` (of `n`), `len` long. */
function windowAt(i: number, len: number, k: number, n: number) {
  const fadeIn = k === 0 ? 1 : Math.min(1, (i + 1) / FADE);
  const fadeOut = k === n - 1 ? 1 : Math.min(1, (len - i) / FADE);
  return Math.min(fadeIn, fadeOut);
}

const toI16 = (v: number) => (v >= 1 ? 32767 : v <= -1 ? -32767 : Math.round(v * 32767));

/** Lets the model's own work (an await inside run()) carry on between our chunks. */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

export interface SeparateOptions {
  onProgress?: (done: number, total: number) => void;
  cancelled?: () => boolean;
  /** Adds the milliseconds spent in our own transforms (not the model), for measuring. */
  timing?: { dsp: number };
}

/**
 * Splits 44.1 kHz stereo into drums, bass and vocals (see KEPT).
 * `cancelled` is polled between segments; throws Cancelled.
 */
export async function separate(
  runner: Runner,
  tensor: MakeTensor,
  left: Float32Array,
  right: Float32Array,
  opts: SeparateOptions = {},
): Promise<StemPcm[]> {
  const total = left.length;
  const n = segmentCount(total);
  const out: StemPcm[] = KEPT.map(() => ({ left: new Int16Array(total), right: new Int16Array(total) }));
  const withSpec = runner.inputNames.length > 1;
  const timing = opts.timing;

  // Sum of the windows over each sample, to normalise the overlap-add.
  const weight = new Float32Array(total);
  for (let k = 0; k < n; k++) {
    const start = k * STRIDE;
    const len = Math.min(SEG, total - start);
    for (let i = 0; i < len; i++) weight[start + i] += windowAt(i, len, k, n);
  }

  const spIn = new SpectralIn();
  const spOut = new SpectralOut();
  const segL = new Float32Array(SEG);
  const segR = new Float32Array(SEG);
  // Two sets of inputs: one with the model, the next being made.
  const inputs: ModelInput[] = [0, 1].map(() => ({ waveform: new Float32Array(2 * SEG), magSpec: new Float32Array(withSpec ? SPEC : 0) }));
  const specL = new Float64Array(SEG);
  const specR = new Float64Array(SEG);

  const prepare = (k: number): ModelInput => {
    const t0 = performance.now();
    const start = k * STRIDE;
    const len = Math.min(SEG, total - start);
    segL.fill(0);
    segR.fill(0);
    segL.set(left.subarray(start, start + len));
    segR.set(right.subarray(start, start + len));
    const input = inputs[k % 2];
    if (withSpec) spIn.prepare(segL, segR, input);
    else {
      input.waveform.set(segL, 0);
      input.waveform.set(segR, SEG);
    }
    if (timing) timing.dsp += performance.now() - t0;
    return input;
  };

  const feeds = (input: ModelInput): Record<string, unknown> => {
    const f: Record<string, unknown> = { [runner.inputNames[0]]: tensor(input.waveform, [1, 2, SEG]) };
    if (withSpec) f[runner.inputNames[1]] = tensor(input.magSpec, [1, 4, CONSTANTS.MODEL_SPEC_BINS, CONSTANTS.MODEL_SPEC_FRAMES]);
    return f;
  };

  /** One segment's parts, into the stems (a part at a time, letting the model breathe). */
  const finish = async (k: number, results: Record<string, TensorLike>) => {
    const start = k * STRIDE;
    const len = Math.min(SEG, total - start);
    let time: TensorLike | null = null;
    let freq: TensorLike | null = null;
    for (const name of runner.outputNames) {
      const t = results[name];
      if (!t) continue;
      if (t.dims.length === 4 && t.dims[2] === 2) time = t;
      else if (t.dims.length === 5 && t.dims[2] === 4) freq = t;
    }
    if (!time) throw new Error('The stems model returned no waveform output.');
    const td = time.data as Float32Array;
    const [, tracks, chans, samples] = time.dims;
    if (tracks < 4 || chans !== 2) throw new Error('The stems model returned an unexpected shape.');
    for (let s = 0; s < KEPT.length; s++) {
      const t0 = performance.now();
      const t = KEPT[s];
      if (freq) spOut.istft(freq.data as Float32Array, t, len, specL, specR);
      const baseL = t * chans * samples;
      const baseR = baseL + samples;
      const o = out[s];
      for (let i = 0; i < len; i++) {
        const j = start + i;
        const w = windowAt(i, len, k, n) / weight[j];
        const l = (td[baseL + i] + (freq ? specL[i] : 0)) * w;
        const r = (td[baseR + i] + (freq ? specR[i] : 0)) * w;
        o.left[j] = toI16(o.left[j] / 32767 + l);
        o.right[j] = toI16(o.right[j] / 32767 + r);
      }
      if (timing) timing.dsp += performance.now() - t0;
      if (s < KEPT.length - 1) await breathe();
    }
    opts.onProgress?.(k + 1, n);
  };

  let next = prepare(0);
  let done: { k: number; results: Record<string, TensorLike> } | null = null;
  for (let k = 0; k < n; k++) {
    if (opts.cancelled?.()) throw new Cancelled();
    const running = runner.run(feeds(next));
    running.catch(() => undefined); // awaited below; an early failure isn't "unhandled" meanwhile
    // While it runs: the last segment's parts, then the next one's input.
    if (done) await finish(done.k, done.results);
    if (k + 1 < n) {
      await breathe();
      next = prepare(k + 1);
    }
    done = { k, results: await running };
  }
  if (done) await finish(done.k, done.results);
  return out;
}
