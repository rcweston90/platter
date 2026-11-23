import { EQ_HIGH_HZ, EQ_LOW_HZ } from './eq';
import type { WavePeaks } from './types';

/** Waveform bins per second: enough for the zoomed view to stay crisp at
 *  ~150 px/s without storing a full-resolution copy of the track. */
export const PEAK_RATE = 150;

/**
 * The three-band peak scan behind the coloured waveform (see computePeaks in
 * analysis.ts). Plain arrays in, so the library worker can run it beside the
 * rest of a track's analysis, off the main thread.
 */
export function peakScanner(L: Float32Array, R: Float32Array, sr: number) {
  const n = L.length;
  const binSize = sr / PEAK_RATE;
  const bins = Math.ceil(n / binSize);
  const low = new Float32Array(bins);
  const mid = new Float32Array(bins);
  const high = new Float32Array(bins);
  const aL = Math.exp((-2 * Math.PI * EQ_LOW_HZ) / sr);
  const aH = Math.exp((-2 * Math.PI * EQ_HIGH_HZ) / sr);
  let l1 = 0;
  let l2 = 0;
  let h1 = 0;
  let h2 = 0;
  let max = 0;
  let i = 0;
  return {
    /** Scans on up to sample `to`. */
    run(to: number) {
      for (; i < to; i++) {
        const x = (L[i] + R[i]) * 0.5;
        l1 = x + aL * (l1 - x);
        l2 = l1 + aL * (l2 - l1);
        h1 = x + aH * (h1 - x);
        h2 = h1 + aH * (h2 - h1);
        const b = (i / binSize) | 0;
        const lo = Math.abs(l2);
        const md = Math.abs(h2 - l2);
        const hi = Math.abs(x - h2);
        if (lo > low[b]) low[b] = lo;
        if (md > mid[b]) mid[b] = md;
        if (hi > high[b]) high[b] = hi;
        if (lo > max) max = lo;
        if (md > max) max = md;
      }
    },
    finish(): WavePeaks {
      const scale = max > 0 ? 255 / max : 0;
      const q = (src: Float32Array) => {
        const out = new Uint8Array(src.length);
        for (let k = 0; k < src.length; k++) out[k] = Math.min(255, src[k] * scale);
        return out;
      };
      return { rate: PEAK_RATE, low: q(low), mid: q(mid), high: q(high) };
    },
  };
}

/** The whole scan in one go (in a worker). */
export function peaksOf(L: Float32Array, R: Float32Array, sr: number): WavePeaks {
  const p = peakScanner(L, R, sr);
  p.run(L.length);
  return p.finish();
}
