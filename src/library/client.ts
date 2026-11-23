import type { AnalyzeJob, AnalyzeResult } from './worker';
import type { TrackAnalysis, TrackTags } from './types';
import type { WavePeaks } from '../engine/types';

/** Runs library analysis in a worker (falls back to the main thread where
 *  workers can't start, e.g. some test harnesses). Up to `analysisLanes()`
 *  workers, so two tracks can be read side by side on a machine with the
 *  cores and memory for it. */

interface Slot {
  worker: Worker;
  busy: number;
}

let slots: Slot[] = [];
let nextId = 1;
const waiting = new Map<number, { slot: Slot; resolve: (r: { analysis: TrackAnalysis | null; peaks: WavePeaks | null; error?: string }) => void; reject: (e: Error) => void }>();

/** How many tracks the crate analyses at once: two where there are cores and
 *  memory to spare (each holds a decoded track, a few hundred MB), else one.
 *  Under eight cores a second lane slows a deck load more than it helps. */
export function analysisLanes(): number {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const cores = nav?.hardwareConcurrency ?? 2;
  const mem = nav?.deviceMemory ?? 8; // Safari and Firefox don't say; desktops have room
  return cores >= 8 && mem >= 8 ? 2 : 1;
}

function spawn(): Slot | null {
  try {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, busy: 0 };
    worker.onmessage = (e: MessageEvent<AnalyzeResult>) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      slot.busy--;
      if (e.data.analysis === undefined) job.reject(new Error(e.data.error));
      else job.resolve({ analysis: e.data.analysis, peaks: e.data.peaks, error: e.data.error });
    };
    worker.onerror = () => {
      for (const [id, job] of waiting) {
        if (job.slot !== slot) continue;
        waiting.delete(id);
        job.reject(new Error('The analysis worker stopped.'));
      }
      slots = slots.filter((s) => s !== slot);
    };
    return slot;
  } catch {
    return null;
  }
}

/** The least busy worker, starting another while there's a lane free. */
function pick(): Slot | null {
  const idle = slots.find((s) => s.busy === 0);
  if (idle) return idle;
  if (slots.length < analysisLanes()) {
    const s = spawn();
    if (s) {
      slots.push(s);
      return s;
    }
  }
  return slots.reduce<Slot | null>((a, b) => (!a || b.busy < a.busy ? b : a), null);
}

/** Copies a channel a slice at a time, with a break between slices: one
 *  copy of a five-minute channel is tens of milliseconds, enough to stall the
 *  platters while a deck plays. */
async function copyChannel(src: Float32Array): Promise<Float32Array> {
  const out = new Float32Array(src.length);
  const SLICE = 1 << 20;
  for (let at = 0; at < src.length; at += SLICE) {
    out.set(src.subarray(at, Math.min(src.length, at + SLICE)), at);
    if (at + SLICE < src.length) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

async function run(buf: AudioBuffer, tags: TrackTags, peaks: boolean) {
  const channels: Float32Array[] = [];
  for (let i = 0; i < Math.min(2, buf.numberOfChannels); i++) channels.push(await copyChannel(buf.getChannelData(i)));
  const slot = pick();
  if (!slot) {
    const { analyzePcm } = await import('./analyze');
    const { peaksOf } = await import('../engine/peaks');
    const p = peaks ? peaksOf(channels[0], channels[1] ?? channels[0], buf.sampleRate) : null;
    try {
      return { analysis: analyzePcm({ sampleRate: buf.sampleRate, channels }, tags), peaks: p };
    } catch (err) {
      if (!p) throw err;
      return { analysis: null, peaks: p, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const id = nextId++;
  slot.busy++;
  return new Promise<{ analysis: TrackAnalysis | null; peaks: WavePeaks | null; error?: string }>((resolve, reject) => {
    waiting.set(id, { slot, resolve, reject });
    const job: AnalyzeJob = { id, sampleRate: buf.sampleRate, channels, tags, peaks };
    slot.worker.postMessage(job, channels.map((c) => c.buffer as ArrayBuffer));
  });
}

/** Analyses a decoded buffer. The channel data is copied, so the buffer stays usable. */
export async function analyzeBuffer(buf: AudioBuffer, tags: TrackTags): Promise<TrackAnalysis> {
  const r = await run(buf, tags, false);
  if (!r.analysis) throw new Error(r.error ?? 'Analysis failed.');
  return r.analysis;
}

/** The analysis and the waveform's peaks in one pass off the main thread.
 *  `analysis` is null (with `error`) when only the reading failed. */
export function analyzeWithPeaks(buf: AudioBuffer, tags: TrackTags) {
  return run(buf, tags, true);
}
