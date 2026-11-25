/**
 * Beat pitch off the main thread: a second or two on a long track, a few
 * more per stem, which would stall the platters and waveforms in the page.
 * Nothing is kept between jobs: a track's audio is tens of megabytes.
 */
import { analyseHits } from './analyse';
import { analyseStems } from './stems';

export type ToHitsWorker =
  | { type: 'mix'; id: number; mono: Float32Array; sampleRate: number }
  /** `mix`: the whole track, mono, for "other" (the track less the stems). */
  | { type: 'stems'; id: number; stems: Int16Array[]; stemRate: number; mix: Float32Array | null; mixRate: number };

self.onmessage = (e: MessageEvent<ToHitsWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'mix') self.postMessage({ id: m.id, hits: analyseHits(m.mono, m.sampleRate) });
    else self.postMessage({ id: m.id, stems: analyseStems({ mix: m.mix, mixRate: m.mix ? m.mixRate : m.stemRate, stems: m.stems, stemRate: m.stemRate }) });
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err) });
  }
};
