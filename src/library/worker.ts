/// <reference lib="webworker" />
import { analyzePcm } from './analyze';
import { peaksOf } from '../engine/peaks';
import type { WavePeaks } from '../engine/types';
import type { Pcm, TrackAnalysis, TrackTags } from './types';

/** Library analysis off the main thread, so the decks never stutter while a
 *  big folder is being worked through. One job at a time per worker; the
 *  client keeps one or two of these. `peaks` also draws the waveform here
 *  (engine/peaks.ts), from the same copy of the audio. */

export interface AnalyzeJob {
  id: number;
  sampleRate: number;
  channels: Float32Array[];
  tags: TrackTags;
  peaks?: boolean;
}

export type AnalyzeResult =
  | { id: number; analysis: TrackAnalysis | null; peaks: WavePeaks | null; error?: string }
  | { id: number; error: string; peaks?: undefined; analysis?: undefined };

self.onmessage = (e: MessageEvent<AnalyzeJob>) => {
  const { id, sampleRate, channels, tags } = e.data;
  let peaks: WavePeaks | null = null;
  try {
    if (e.data.peaks) peaks = peaksOf(channels[0], channels[1] ?? channels[0], sampleRate);
    const pcm: Pcm = { sampleRate, channels };
    const analysis = analyzePcm(pcm, tags);
    const out: AnalyzeResult = { id, analysis, peaks };
    (self as unknown as Worker).postMessage(out, peaks ? [peaks.low.buffer, peaks.mid.buffer, peaks.high.buffer] : []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The waveform may be fine even when the reading failed.
    const out: AnalyzeResult = peaks ? { id, analysis: null, peaks, error: msg } : { id, error: msg };
    (self as unknown as Worker).postMessage(out, peaks ? [peaks.low.buffer, peaks.mid.buffer, peaks.high.buffer] : []);
  }
};
