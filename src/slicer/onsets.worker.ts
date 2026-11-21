/**
 * Transient detection off the main thread: about a second on a six-minute
 * track, long enough to freeze the slicer if it ran in the page. Gets each
 * track once, as one mono channel (detectOnsets mixes to mono anyway), and
 * keeps it: re-chopping as a slider moves sends only the settings.
 */
import { detectOnsets } from './dsp';

interface Job {
  id: number;
  /** Which audio: the same key reuses the mono sent before. */
  key: number;
  sampleRate: number;
  /** Sent with the first job for a key only. */
  mono?: Float32Array;
  sensitivity: number;
  minGap: number;
  maxCount?: number;
}

/** The last few tracks' audio, newest last. */
const kept = new Map<number, { sampleRate: number; mono: Float32Array }>();

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, key, sampleRate, mono, sensitivity, minGap, maxCount } = e.data;
  try {
    if (mono) {
      kept.delete(key);
      kept.set(key, { sampleRate, mono });
      while (kept.size > 3) kept.delete(kept.keys().next().value!);
    }
    const audio = kept.get(key);
    if (!audio) {
      self.postMessage({ id, error: 'resend' });
      return;
    }
    const points = detectOnsets(
      { sampleRate: audio.sampleRate, length: audio.mono.length, numberOfChannels: 1, getChannelData: () => audio.mono },
      { sensitivity, minGap, maxCount },
    );
    self.postMessage({ id, points });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
