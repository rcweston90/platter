/**
 * Beat pitch off the main thread: a second or two on a long track, which
 * would stall the platters and waveforms if it ran in the page.
 */
import { analyseHits } from './analyse';

self.onmessage = (e: MessageEvent<{ id: number; mono: Float32Array; sampleRate: number }>) => {
  const { id, mono, sampleRate } = e.data;
  try {
    self.postMessage({ id, hits: analyseHits(mono, sampleRate) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
