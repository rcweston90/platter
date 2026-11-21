import { createExtractor, type Extractor } from './features';

/**
 * A track's "sound print": what an open audio model (LAION's CLAP, see
 * worker.ts) hears in three 10-second windows of it.
 *
 *   intro  where the track starts properly (from its first downbeat)
 *   body   the middle, where it sits most of the time
 *   outro  near the end, where a DJ would be mixing out of it
 *
 * Each is a unit-length vector, so two prints compare with a dot product.
 * Pure: the model is passed in (a Runner), so this runs and is tested
 * without ONNX Runtime.
 */

export const PRINT_VERSION = 'clap-htsat-unfused-q8-1';

export interface SoundPrint {
  /** Which model and windowing made it; prints from another don't compare. */
  version: string;
  intro: Float32Array;
  body: Float32Array;
  outro: Float32Array;
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

/** Window length in seconds (CLAP's). */
export const WINDOW_S = 10;

export interface Window {
  name: 'intro' | 'body' | 'outro';
  /** Start, seconds. */
  start: number;
}

/**
 * Where the three windows go in a track `duration` seconds long. Short tracks
 * get overlapping (or identical) windows; that's fine, they just agree.
 */
export function pickWindows(duration: number, firstDownbeat = 0): Window[] {
  const last = Math.max(0, duration - WINDOW_S);
  const clamp = (t: number) => Math.min(last, Math.max(0, t));
  // Intro: from the first downbeat, skipping a silent or count-in start.
  const intro = clamp(firstDownbeat);
  // Outro: the stretch a DJ mixes out over, ending ~20 s before the end
  // (fade-outs and tails say little about how it sounds).
  const outro = clamp(duration - WINDOW_S - Math.min(20, duration * 0.08));
  const body = clamp(duration / 2 - WINDOW_S / 2);
  return [
    { name: 'intro', start: intro },
    { name: 'body', start: body },
    { name: 'outro', start: outro },
  ];
}

/** Cuts the windows out of mono audio at `rate` Hz (the model's 48 kHz). */
export function cutWindows(mono: Float32Array, rate: number, windows: Window[]): Float32Array[] {
  const len = Math.round(WINDOW_S * rate);
  return windows.map((w) => {
    const s = Math.min(Math.max(0, mono.length - len), Math.max(0, Math.round(w.start * rate)));
    return mono.slice(s, s + len);
  });
}

export function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  const out = new Float32Array(v.length);
  if (n > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Cosine similarity of two unit vectors (−1…1). */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

let extractor: Extractor | null = null;

/**
 * Runs the model on the three windows (each 10 s of 48 kHz mono) and returns
 * the print. One window per run: the export's batch size needn't be dynamic.
 */
export async function embedWindows(runner: Runner, tensor: MakeTensor, windows: Float32Array[], ex: Extractor = (extractor ??= createExtractor())): Promise<SoundPrint> {
  if (!windows.length) throw new Error('No audio to listen to');
  const input = runner.inputNames.includes('input_features') ? 'input_features' : runner.inputNames[0];
  const name = runner.outputNames.includes('audio_embeds') ? 'audio_embeds' : runner.outputNames[0];
  const vecs: Float32Array[] = [];
  for (const w of windows) {
    const outputs = await runner.run({ [input]: tensor(ex.features(w), [1, 1, ex.frames, ex.config.feature_size]) });
    const out = outputs[name];
    const data = out.data as Float32Array;
    const dim = out.dims[out.dims.length - 1];
    if (!dim || data.length !== dim) throw new Error(`Unexpected model output shape [${out.dims.join(', ')}]`);
    vecs.push(normalise(Float32Array.from(data)));
  }
  return { version: PRINT_VERSION, intro: vecs[0], body: vecs[1] ?? vecs[0], outro: vecs[2] ?? vecs[vecs.length - 1] };
}

/**
 * How well `next` would follow `current`, by sound: mostly how `next`'s
 * intro sits against `current`'s outro (where the two will overlap), plus
 * how alike the two are overall. −1…1, in practice 0.2…0.95.
 */
export function flowSimilarity(current: SoundPrint, next: SoundPrint): number {
  return 0.6 * cosine(current.outro, next.intro) + 0.4 * cosine(current.body, next.body);
}
