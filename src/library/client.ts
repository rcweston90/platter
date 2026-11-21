import type { AnalyzeJob, AnalyzeResult } from './worker';
import type { TrackAnalysis, TrackTags } from './types';

/** Runs library analysis in a worker (falls back to the main thread where
 *  workers can't start, e.g. some test harnesses). */

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (a: TrackAnalysis) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<AnalyzeResult>) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      if ('error' in e.data) job.reject(new Error(e.data.error));
      else job.resolve(e.data.analysis);
    };
    worker.onerror = () => {
      for (const job of waiting.values()) job.reject(new Error('The analysis worker stopped.'));
      waiting.clear();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
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

/** Analyses a decoded buffer. The channel data is copied, so the buffer stays usable. */
export async function analyzeBuffer(buf: AudioBuffer, tags: TrackTags): Promise<TrackAnalysis> {
  const channels: Float32Array[] = [];
  for (let i = 0; i < Math.min(2, buf.numberOfChannels); i++) channels.push(await copyChannel(buf.getChannelData(i)));
  const w = getWorker();
  if (!w) {
    const { analyzePcm } = await import('./analyze');
    return analyzePcm({ sampleRate: buf.sampleRate, channels }, tags);
  }
  const id = nextId++;
  return new Promise<TrackAnalysis>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    const job: AnalyzeJob = { id, sampleRate: buf.sampleRate, channels, tags };
    w.postMessage(job, channels.map((c) => c.buffer as ArrayBuffer));
  });
}
