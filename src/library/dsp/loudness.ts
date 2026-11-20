import type { EnergyEstimate, LoudnessEstimate, Pcm, TempoEstimate } from '../types';
import { fft } from '../../engine/fft';
import { toMono } from './pcm';
import { MIN_ONSET, onsetEnvelope, percentile } from './tempo';

/**
 * Loudness (ITU-R BS.1770-4 / EBU R128) and a 1…10 energy heuristic.
 * Pure TypeScript; runs in Node and in the browser.
 */

/** Floor for silence and for anything quieter (JSON can't carry −Infinity). */
export const LUFS_FLOOR = -70;
/** Sample-peak floor for digital silence, dBFS. */
export const PEAK_FLOOR = -120;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages of BS.1770-4 for any sample rate. The standard
 * publishes coefficients for 48 kHz only; these are the analogue prototypes
 * those coefficients come from (a +4 dB high shelf near 1.68 kHz, and the
 * RLB second-order high-pass near 38 Hz), re-discretised by the bilinear
 * transform with K = tan(π f0 / fs) — the derivation documented by pyloudnorm
 * and libebur128. At 48 kHz it reproduces the published values
 * (b = 1.53512486, −2.69169619, 1.19839281; a = −1.69065929, 0.73248077 and
 * b = 1, −2, 1; a = −1.99004745, 0.99007225).
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf.
  let f0 = 1681.974450955533;
  const G = 3.999843853973347; // dB
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass (its numerator stays 1, −2, 1, unnormalised, as in the standard).
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

/** BS.1770 channel weights: L, R, C = 1, surrounds 1.41, LFE excluded (5.1 order L R C LFE Ls Rs). */
function channelWeights(n: number): number[] {
  if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
  if (n === 5) return [1, 1, 1, 1.41, 1.41];
  return new Array(n).fill(1);
}

const toLufs = (power: number) => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);

/**
 * Integrated loudness (BS.1770-4: 400 ms blocks, 75 % overlap, absolute gate
 * −70 LUFS, relative gate −10 LU), sample peak, and loudness range (EBU Tech
 * 3342: 3 s short-term blocks every 100 ms, absolute gate −70 LUFS, relative
 * gate −20 LU, LRA = 95th − 10th percentile).
 *
 * Silence, or audio that never clears the absolute gate, reads LUFS_FLOOR
 * (−70) rather than −Infinity so the record stays valid JSON; peak floors at
 * PEAK_FLOOR. A mono file is measured as one channel (the BS.1770 definition,
 * ~3 dB below the same audio as dual mono).
 */
export function measureLoudness(pcm: Pcm): LoudnessEstimate {
  const sr = pcm.sampleRate;
  const chans = pcm.channels;
  const len = chans.length ? chans[0].length : 0;
  const weights = channelWeights(chans.length);
  const [s1, s2] = kWeighting(sr);

  // 100 ms segments of weighted, K-filtered energy; blocks are sums of segments.
  const segCount = Math.floor((len * 10) / sr);
  const seg = new Float64Array(segCount);
  const bound = (k: number) => Math.round((k * sr) / 10);
  let peak = 0;
  for (let c = 0; c < chans.length; c++) {
    const x = chans[c];
    const g = weights[c];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // stage 1 state
    let u1 = 0, u2 = 0, z1 = 0, z2 = 0; // stage 2 state
    let k = 0;
    let end = segCount > 0 ? bound(1) : len;
    let acc = 0;
    for (let i = 0; i < len; i++) {
      const v = x[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      const y = s1.b0 * v + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      const z = s2.b0 * y + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * z1 - s2.a2 * z2;
      u2 = u1; u1 = y; z2 = z1; z1 = z;
      if (g !== 0) acc += z * z;
      if (i + 1 === end && k < segCount) {
        seg[k] += g * acc;
        acc = 0;
        k++;
        end = k < segCount ? bound(k + 1) : len;
      }
    }
  }
  const segLen = new Float64Array(segCount);
  for (let k = 0; k < segCount; k++) segLen[k] = bound(k + 1) - bound(k);

  const blockPowers = (nSeg: number) => {
    const out: number[] = [];
    for (let j = 0; j + nSeg <= segCount; j++) {
      let e = 0;
      let n = 0;
      for (let k = j; k < j + nSeg; k++) {
        e += seg[k];
        n += segLen[k];
      }
      out.push(e / n);
    }
    return out;
  };

  // Integrated.
  const gated = (powers: number[], relLU: number) => {
    const abs = powers.filter((p) => toLufs(p) > -70);
    if (!abs.length) return { level: -Infinity, kept: [] as number[] };
    const rel = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) + relLU;
    const kept = abs.filter((p) => toLufs(p) > rel);
    const level = kept.length ? toLufs(kept.reduce((a, b) => a + b, 0) / kept.length) : -Infinity;
    return { level, kept };
  };
  const integ = gated(blockPowers(4), -10).level;

  // Loudness range.
  let lra = 0;
  const st = gated(blockPowers(30), -20).kept.map(toLufs).sort((a, b) => a - b);
  if (st.length >= 2) {
    const q = (p: number) => {
      const pos = p * (st.length - 1);
      const i = Math.floor(pos);
      return i + 1 < st.length ? st[i] + (st[i + 1] - st[i]) * (pos - i) : st[i];
    };
    lra = Math.max(0, q(0.95) - q(0.1));
  }

  return {
    lufs: Number.isFinite(integ) ? Math.max(LUFS_FLOOR, integ) : LUFS_FLOOR,
    peakDb: peak > 0 ? Math.max(PEAK_FLOOR, 20 * Math.log10(peak)) : PEAK_FLOOR,
    lra,
  };
}

/**
 * Energy 1…10, a documented heuristic in the spirit of Mixed In Key's energy
 * level — for comparing tracks, not a measurement. Five features, each mapped
 * linearly to 0…1 and clamped, then weighted:
 *   loudness   0.30   integrated LUFS, −16 → 0 … −6 → 1 (modern masters sit
 *                     between, so the range is narrow on purpose)
 *   density    0.30   onsets per second, log scale, 1/s → 0 … 10/s → 1
 *   brightness 0.15   spectral centroid, 1 kHz → 0 … 4 kHz → 1
 *   low end    0.10   share of power below 150 Hz, 0.15 → 0 … 0.6 → 1
 *   tempo      0.15   100 → 0 … 140 BPM → 1 (0.25 with no tempo)
 *   energy = 1 + round(9 × Σ^1.3), so 1…10; the exponent spreads the top.
 * Worked through for typical feature values: ambient (−14 LUFS, < 1 onset/s,
 * no beat) ≈ 2, mellow house (−11 LUFS, 4/s, 120 BPM) ≈ 5, peak-time techno
 * (−7 LUFS, 8/s, 130 BPM, bright) ≈ 8. Not yet calibrated on a real library —
 * tune the ranges, not the code shape, when it is.
 *
 * onsetRate: peaks of the onset envelope (tempo.ts) at least MIN_ONSET strong
 * and 1.5× the local (±¼ s) mean, at least 50 ms apart. brightness: per-frame centroid (2048-point
 * FFT every 250 ms, bins quieter than −50 dB under the frame's peak ignored),
 * averaged weighted by frame RMS, frames under −60 dBFS skipped.
 */
export function measureEnergy(pcm: Pcm, loud: LoudnessEstimate, tempo?: TempoEstimate | null): EnergyEstimate {
  const mono = toMono(pcm);
  const sr = pcm.sampleRate;
  const duration = mono.length / sr;
  if (!(duration > 0)) return { energy: 1, onsetRate: 0, brightness: 0, lowEnd: 0 };

  // Onset rate.
  let onsetRate = 0;
  {
    const oe = onsetEnvelope(mono, sr);
    const e = oe.env;
    const n = e.length;
    if (n > 0) {
      const floor = Math.max(MIN_ONSET, 0.08 * percentile(e, 0.99));
      const half = Math.round(oe.fps * 0.25);
      const cs = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + e[i];
      const gap = Math.round(oe.fps * 0.05);
      let last = -Infinity;
      let count = 0;
      for (let i = 1; i < n - 1; i++) {
        const v = e[i];
        if (v < floor || v < e[i - 1] || v < e[i + 1]) continue;
        const a = Math.max(0, i - half);
        const b = Math.min(n, i + half + 1);
        const localMean = (cs[b] - cs[a]) / (b - a);
        if (v < 1.5 * localMean) continue;
        let isMax = true;
        for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (e[j] > v) isMax = false;
        if (!isMax || i - last < gap) continue;
        last = i;
        count++;
      }
      onsetRate = count / duration;
    }
  }

  // Brightness and low end.
  let brightness = 0;
  let lowEnd = 0;
  {
    const N = 2048;
    const hop = Math.max(N, Math.round(sr * 0.25));
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const binHz = sr / N;
    const lo20 = Math.max(1, Math.round(20 / binHz));
    const lo150 = Math.round(150 / binHz);
    const top = Math.min(N / 2, Math.round(16000 / binHz));
    const minRms = 10 ** (-60 / 20);
    let wSum = 0;
    let cSum = 0;
    let pLow = 0;
    let pAll = 0;
    const mag = new Float64Array(N / 2);
    for (let o = 0; o + N <= mono.length; o += hop) {
      let ss = 0;
      for (let i = 0; i < N; i++) {
        const v = mono[o + i];
        ss += v * v;
        re[i] = v * win[i];
        im[i] = 0;
      }
      const rms = Math.sqrt(ss / N);
      if (rms < minRms) continue;
      fft(re, im);
      let mMax = 0;
      for (let k = lo20; k < top; k++) {
        const m = Math.hypot(re[k], im[k]);
        mag[k] = m;
        if (m > mMax) mMax = m;
        const p = m * m;
        pAll += p;
        if (k < lo150) pLow += p;
      }
      const thr = mMax * 10 ** (-50 / 20);
      let num = 0;
      let den = 0;
      for (let k = lo20; k < top; k++) {
        const m = mag[k];
        if (m < thr) continue;
        num += m * k * binHz;
        den += m;
      }
      if (den > 0) {
        cSum += rms * (num / den);
        wSum += rms;
      }
    }
    brightness = wSum > 0 ? cSum / wSum : 0;
    lowEnd = pAll > 0 ? pLow / pAll : 0;
  }

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const fLoud = clamp01((loud.lufs + 16) / 10);
  const fDensity = onsetRate > 0 ? clamp01(Math.log10(onsetRate)) : 0;
  const fBright = clamp01((brightness - 1000) / 3000);
  const fLow = clamp01((lowEnd - 0.15) / 0.45);
  const fTempo = tempo ? clamp01((tempo.bpm - 100) / 40) : 0.25;
  const raw = 0.3 * fLoud + 0.3 * fDensity + 0.15 * fBright + 0.1 * fLow + 0.15 * fTempo;
  const energy = Math.max(1, Math.min(10, 1 + Math.round(9 * raw ** 1.3)));
  return { energy, onsetRate, brightness, lowEnd };
}
