/// <reference lib="webworker" />
import { analyzePcm } from './analyze';
import type { Pcm, TrackAnalysis, TrackTags } from './types';

/** Library analysis off the main thread, so the decks never stutter while a
 *  big folder is being worked through. One job at a time. */

export interface AnalyzeJob {
  id: number;
  sampleRate: number;
  channels: Float32Array[];
  tags: TrackTags;
}

export type AnalyzeResult = { id: number; analysis: TrackAnalysis } | { id: number; error: string };

self.onmessage = (e: MessageEvent<AnalyzeJob>) => {
  const { id, sampleRate, channels, tags } = e.data;
  try {
    const pcm: Pcm = { sampleRate, channels };
    const analysis = analyzePcm(pcm, tags);
    (self as unknown as Worker).postMessage({ id, analysis } satisfies AnalyzeResult);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies AnalyzeResult);
  }
};
