/**
 * Transient detection off the main thread: about a second on a six-minute
 * track, long enough to freeze the slicer if it ran in the page. Gets the
 * track as one mono channel (detectOnsets mixes to mono anyway).
 */
import { detectOnsets } from './dsp';

interface Job {
  id: number;
  sampleRate: number;
  mono: Float32Array;
  sensitivity: number;
  minGap: number;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, sampleRate, mono, sensitivity, minGap } = e.data;
  try {
    const points = detectOnsets(
      { sampleRate, length: mono.length, numberOfChannels: 1, getChannelData: () => mono },
      { sensitivity, minGap },
    );
    self.postMessage({ id, points });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
