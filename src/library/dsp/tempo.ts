import { fft } from '../../engine/fft';
import type { TempoCandidate, TempoEstimate } from '../types';
import { resample } from './pcm';

/**
 * Tempo, beat phase and downbeat from decoded audio, in pure TypeScript (runs
 * in Node and in the browser). Written here from the published methods:
 *
 *  1. Onset strength — spectral flux of a log-compressed magnitude STFT
 *     (Klapuri 1999; Böck, Krebs & Schedl 2012) at an 11 025 Hz analysis rate,
 *     256-sample (23 ms) Hann frames every 64 samples (172 frames/s), computed
 *     separately in three bands (< 150 Hz kick/bass, 150 Hz–2 kHz snare/body,
 *     > 2 kHz hats) and summed as band *means*, so the few bass bins count as
 *     much as the many hat bins. A ±¼ s moving-average high-pass and
 *     half-wave rectification follow (Ellis 2007, "Beat tracking by dynamic
 *     programming"). Separately, a time-domain low band (4th-order 150 Hz
 *     low-pass, ~46 ms triangular power window, rise of its log amplitude)
 *     gives a kick/bass onset envelope; a 23 ms FFT frame is too short to
 *     resolve bass, and its few low bins ripple under a sustained chord.
 *
 *  2. Periodicity — the unbiased autocorrelation (ACF) of that envelope
 *     (Ellis 2007 §3.1), mixed with the ACF of the low-band envelope at up to
 *     2 : 1, in proportion to how periodic the low band is. The kick carries
 *     the metrical level: with kicks on every beat and offbeat hats of similar
 *     strength, the full band alone is an 8th-note pulse that fits a 1½-beat
 *     period about as well as the beat (the 174 → 116 error). The metrical family is picked by a harmonic sum: the
 *     mean ACF at 1, 2, 3 and 4 periods (each read as the max within ±k/2
 *     frames), times the tempo prior below, over 40–220 BPM. A true beat
 *     divides the bar, so its multiples land on bar repeats; a syncopation
 *     (a kick 1½ beats after another, as in boom-bap and DnB) doesn't, which
 *     keeps those patterns out of the ⅔-tempo trap that the raw ACF falls in.
 *
 *  3. Octave choice — see OCTAVE RULE below.
 *
 *  4. Precision — the Fourier tempogram (Grosche & Müller 2011): the magnitude
 *     of the envelope's DFT at the beat frequency and its first three harmonics,
 *     over the whole (Hann-windowed) track, searched on a 0.05 then 0.005 BPM
 *     grid with parabolic interpolation, starting from the period read off the
 *     ACF peak at 4 beats. Over minutes this is far sharper than an ACF lag.
 *     Within 0.15 of an integer, and if the integer fits at least 97 % as well,
 *     the tempo snaps to it (most dance music is produced at integer BPM).
 *
 *  5. Beat phase — the phase of the beat-frequency DFT coefficient (moved by
 *     half a beat if the low band's onsets sit clearly on the other half: an
 *     offbeat hat louder than the kick flips the full band's phase), refined by
 *     maximising a comb (sum of envelope at φ + n·P) over ±¼ beat in ¼-frame
 *     steps, corrected by the envelope's latency (LATENCY). firstBeat is the
 *     first grid beat at or after the music starts.
 *
 *  6. Downbeat (heuristic, 4/4 assumed) — see DOWNBEAT RULE below.
 *
 *  7. Confidence — the margin of the chosen family's harmonic-sum salience
 *     over the best periodicity that isn't metrically related (not a whole
 *     number of beats, nor ½, ⅓, ¼ beat), the rival scored only on its own
 *     unrelated multiples; scaled down when the pulse itself is weak. A weak
 *     pulse is not a null: rubato or sparse music still gets its best estimate,
 *     with a low confidence, so the caller can show it as uncertain.
 *
 *  8. Stability — the same fine search on up to four ~30 s windows (windows
 *     without a pulse, e.g. a breakdown, are skipped); the RMS spread of their
 *     tempi maps to 0…1 as exp(−(rms / 0.4 BPM)²).
 *
 * OCTAVE RULE. The ACF of a periodic pattern peaks at the beat, at 2, 4 … beats
 * and (more weakly) at the half beat, so which level is "the tempo" is a
 * convention. The family members (×⅛ … ×8 of the dominant periodicity) inside
 * the reporting range [min, max) — default [75, 200) — are scored as
 *   score = ACF(period) × prior,  prior = exp(−½·(log2(bpm / 128) / 0.7)²),
 * a log-Gaussian over tempo in octaves (the resonance-curve prior of Ellis
 * 2007 / Klapuri et al. 2006, here centred at 128 BPM rather than 120 and
 * narrower, because the target is DJ conventions). In effect:
 *   • 115–135 house/techno: the only member in range;
 *   • dubstep/trap/half-time at 140 (kick 1, snare 3): 70 is below 75, so 140;
 *     likewise a 70 BPM groove reads 140 (pass { min: 60 } to keep it at 70);
 *   • DnB 170–175: the half (85–87) has about as much periodicity as 174 —
 *     snares repeat every two beats, kicks and hats every beat — so the prior's
 *     lean towards 128 decides for 174, and 87 is offered as a candidate;
 *   • hip-hop 85–100: the double (170–200) only carries hat and kick/hat
 *     cross-terms, well under the beat's ACF, so the beat wins despite the prior.
 * Candidates: the chosen tempo first (salience 1), then half and double always,
 * and ⅔, 3⁄2 or other strong periodicities scoring ≥ 0.3, each scored as
 * harmonic-sum salience × prior relative to the chosen tempo (capped at 1: a 1
 * on 87 next to a chosen 174 means "just as plausible").
 *
 * DOWNBEAT RULE (heuristic). For each of the four beat phases k of a 4/4 bar,
 * sum over every 4th beat the rise in linear low-band (< 150 Hz, time domain)
 * and mid-band (150 Hz–2 kHz) amplitude: mean over the ¼ beat after the beat minus the ¼
 * beat before it. The backbeat pair (2 and 4) is the one where the mid band
 * (snares) is strong relative to the low band, so the downbeat is in the other
 * pair; within it, the "one" is the phase with the larger low-band rise (a
 * bass note or a heavier kick on the one). With no clear backbeat (ratio
 * within 15 %), the largest low-band rise of all four wins. Tracks whose one
 * isn't marked in the low end get an arbitrary but consistent phase.
 *
 * NULL RULE. estimateTempo returns null only for audio with nothing to count:
 * under MIN_SECONDS (6 s), silence (< −70 dBFS RMS), stationary noise of any
 * colour (whitened spectral flatness > NOISE_FLATNESS — music measures
 * 0.02–0.3, noise ≈ 0.56 — and an onset envelope without outliers, so drums
 * under heavy hiss still count), or no transients at all (a pad or drone: the onset
 * envelope's 99.5th percentile under MIN_ONSET). Everything else gets a tempo.
 *
 * MIT, like the rest of Platter: no code from Essentia, madmom, libKeyFinder
 * or other GPL / non-commercial projects.
 */

const ANALYSIS_RATE = 11025;
const FRAME = 256;
const HOP = 64;
const LOG_GAMMA = 100; // log(1 + γ|X|) compression
const LOW_HZ = 150;
const MID_HZ = 2000;
/** Below this length there isn't enough to tell a tempo. */
const MIN_SECONDS = 6;
/** RMS below this (−70 dBFS) is silence. */
const SILENCE_RMS = 10 ** (-70 / 20);
/** Band-mean log flux an onset must reach (a soft kick or hat is ~1–5). */
export const MIN_ONSET = 0.6;
/** A harmonic-sum salience at or below this is no clearer than noise:
 *  confidence starts above it. */
const MIN_CLARITY = 0.03;
/** Whitened spectral flatness above this is stationary noise (see estimateTempo). */
const NOISE_FLATNESS = 0.45;
/** …and an onset envelope whose 99.5th percentile is less than this many
 *  16–84 % ranges above its median (noise ≈ 2.3). */
const NOISE_PEAKINESS = 3.5;
/** Weight of the low-band ACF against the full band's, when the low band is periodic. */
const LOW_WEIGHT = 2;
const PRIOR_CENTRE = 128;
const PRIOR_SIGMA = 0.7; // octaves
const HARMONIC_WEIGHTS = [1, 1, 0.5, 0.5];
/** Seconds the envelope's peak trails the acoustic onset. Negative: the flux
 *  peaks when an onset is most of the way into the window, i.e. before the
 *  frame centre that timestamps the frame (measured on synthetic kicks, hats
 *  and snares: the comb peak sits 5.2 ms ahead of the true beat). */
const LATENCY = -0.0052;

export interface OnsetEnvelope {
  /** Frames per second. */
  fps: number;
  /** Seconds from the audio start to frame 0's timestamp. */
  t0: number;
  /** Combined onset strength (band means summed), raw. */
  env: Float32Array;
  /** < 150 Hz flux. */
  low: Float32Array;
  /** 150 Hz–2 kHz flux. */
  mid: Float32Array;
  /** > 2 kHz flux. */
  high: Float32Array;
  /** Linear amplitude below 150 Hz per frame, from a 4th-order low-pass and a
   *  ~46 ms triangular power window centred on the frame (time domain: a
   *  23 ms FFT frame can't resolve bass, and its bins ripple with the window
   *  position). */
  lowAmp: Float32Array;
  /** Half-wave-rectified rise of log(lowAmp) over 2 frames: the kick/bass onset
   *  envelope used to weight the metrical level. */
  lowRise: Float32Array;
  /** Linear amplitude of the 150 Hz–2 kHz bins, per frame. */
  midAmp: Float32Array;
  /** Mean spectral flatness of frames whitened by the long-term spectrum:
   *  ≈ 0.56 (e^−γ) for any stationary noise, well below for music. */
  whiteFlatness: number;
}

const envCache = new WeakMap<Float32Array, { sampleRate: number; oe: OnsetEnvelope }>();

/** Onset-strength envelope (band-wise log spectral flux). Cached per input array. */
export function onsetEnvelope(mono: Float32Array, sampleRate: number): OnsetEnvelope {
  const hit = envCache.get(mono);
  if (hit && hit.sampleRate === sampleRate) return hit.oe;
  let x = mono;
  let sr = sampleRate;
  if (sampleRate > ANALYSIS_RATE * 1.05) {
    x = resample(mono, sampleRate, ANALYSIS_RATE, 3);
    sr = ANALYSIS_RATE;
  }
  const out = bandFlux(x, sr);
  const { amp, rise } = lowBand(x, sr, out.env.length);
  out.lowAmp = amp;
  out.lowRise = rise;
  envCache.set(mono, { sampleRate, oe: out });
  return out;
}

function bandFlux(x: Float32Array, sr: number): OnsetEnvelope {
  const half = FRAME / 2;
  const nFrames = x.length >= FRAME ? Math.floor((x.length - FRAME) / HOP) + 1 : 0;
  const low = new Float32Array(nFrames);
  const mid = new Float32Array(nFrames);
  const high = new Float32Array(nFrames);
  const env = new Float32Array(nFrames);
  const midAmp = new Float32Array(nFrames);
  const lowHi = Math.max(2, Math.round((LOW_HZ * FRAME) / sr));
  const midHi = Math.max(lowHi + 1, Math.min(half, Math.round((MID_HZ * FRAME) / sr)));
  const nLow = lowHi - 1; // bins 1 … lowHi−1
  const nMid = midHi - lowHi;
  const nHigh = half - midHi;
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(half);
  let cur = new Float64Array(half);
  let nxt = new Float64Array(half);
  let first = true;
  // Every 8th frame's power spectrum, kept for the whitened-flatness test.
  const SAMPLE_EVERY = 8;
  const kept: Float64Array[] = [];

  const flux = (m: number, a: Float64Array, b: Float64Array) => {
    // b = this frame's log magnitudes, a = the previous frame's.
    let l = 0;
    let md = 0;
    let h = 0;
    for (let k = 1; k < lowHi; k++) {
      const d = b[k] - a[k];
      if (d > 0) l += d;
    }
    for (let k = lowHi; k < midHi; k++) {
      const d = b[k] - a[k];
      if (d > 0) md += d;
    }
    for (let k = midHi; k < half; k++) {
      const d = b[k] - a[k];
      if (d > 0) h += d;
    }
    l /= nLow;
    md /= nMid || 1;
    h /= nHigh || 1;
    low[m] = l;
    mid[m] = md;
    high[m] = h;
    env[m] = l + md + h;
  };

  // Two real frames per complex FFT: z = a + i·b → A[k] = (Z[k] + conj Z[N−k]) / 2,
  // B[k] = (Z[k] − conj Z[N−k]) / 2i.
  for (let m = 0; m < nFrames; m += 2) {
    const o1 = m * HOP;
    const has2 = m + 1 < nFrames;
    const o2 = o1 + HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = x[o1 + i] * win[i];
      im[i] = has2 ? x[o2 + i] * win[i] : 0;
    }
    fft(re, im);
    let mpA = 0, mpB = 0;
    for (let k = 0; k < half; k++) {
      const j = (FRAME - k) & (FRAME - 1);
      const zr = re[k];
      const zi = im[k];
      const nr = re[j];
      const ni = im[j];
      const ar = 0.5 * (zr + nr);
      const ai = 0.5 * (zi - ni);
      const br = 0.5 * (zi + ni);
      const bi = -0.5 * (zr - nr);
      const pa = ar * ar + ai * ai;
      const pb = br * br + bi * bi;
      cur[k] = Math.log1p(LOG_GAMMA * Math.sqrt(pa));
      nxt[k] = Math.log1p(LOG_GAMMA * Math.sqrt(pb));
      if (k >= lowHi && k < midHi) {
        mpA += pa;
        mpB += pb;
      }
    }
    if (m % SAMPLE_EVERY === 0) {
      const spec = new Float64Array(half);
      for (let k = 1; k < half; k++) {
        const j = (FRAME - k) & (FRAME - 1);
        const ar = 0.5 * (re[k] + re[j]);
        const ai = 0.5 * (im[k] - im[j]);
        spec[k] = ar * ar + ai * ai;
      }
      kept.push(spec);
    }
    midAmp[m] = Math.sqrt(mpA);
    if (has2) midAmp[m + 1] = Math.sqrt(mpB);
    if (first) {
      prev.set(cur);
      first = false;
    }
    flux(m, prev, cur);
    if (has2) flux(m + 1, cur, nxt);
    const t = prev;
    prev = has2 ? nxt : cur;
    if (has2) {
      nxt = t;
    } else {
      cur = t;
    }
  }
  return {
    fps: sr / HOP,
    t0: FRAME / 2 / sr,
    env,
    low,
    mid,
    high,
    lowAmp: new Float32Array(0),
    lowRise: new Float32Array(0),
    midAmp,
    whiteFlatness: whitenedFlatness(kept, half),
  };
}

/** Mean over frames of geometric / arithmetic mean of P_k / P̄_k (bins 1…half−1),
 *  P̄ the long-term mean spectrum; frames under −60 dB of the loudest skipped. */
function whitenedFlatness(frames: Float64Array[], half: number): number {
  if (!frames.length) return 0;
  const mean = new Float64Array(half);
  const energy = frames.map((f) => {
    let e = 0;
    for (let k = 1; k < half; k++) {
      mean[k] += f[k];
      e += f[k];
    }
    return e;
  });
  const maxE = Math.max(...energy);
  for (let k = 1; k < half; k++) mean[k] = mean[k] / frames.length + 1e-30;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < frames.length; i++) {
    if (energy[i] < maxE * 1e-6) continue;
    let lg = 0;
    let ar = 0;
    for (let k = 1; k < half; k++) {
      const w = frames[i][k] / mean[k] + 1e-12;
      lg += Math.log(w);
      ar += w;
    }
    const nb = half - 1;
    sum += Math.exp(lg / nb) / (ar / nb);
    count++;
  }
  return count ? sum / count : 0;
}

/** Low-band amplitude and onset rise per STFT frame (see OnsetEnvelope.lowAmp). */
function lowBand(x: Float32Array, sr: number, nFrames: number): { amp: Float32Array; rise: Float32Array } {
  // Two cascaded 2nd-order Butterworth low-passes at LOW_HZ (RBJ cookbook, Q = 1/√2).
  const w0 = (2 * Math.PI * LOW_HZ) / sr;
  const alpha = Math.sin(w0) / Math.SQRT2;
  const cw = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cw) / 2 / a0;
  const b1 = (1 - cw) / a0;
  const a1 = (-2 * cw) / a0;
  const a2 = (1 - alpha) / a0;
  const n = x.length;
  const pw = new Float64Array(n + 1); // cumulative power
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    const y = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    const z = b0 * y + b1 * u1 + b0 * u2 - a1 * z1 - a2 * z2;
    u2 = u1; u1 = y; z2 = z1; z1 = z;
    pw[i + 1] = pw[i] + z * z;
  }
  // Box of W samples, then a box of 4 frames over those: ~triangular, ~46 ms.
  const W = Math.max(8, Math.round(0.023 * sr));
  const box = new Float64Array(nFrames);
  for (let m = 0; m < nFrames; m++) {
    const c = m * HOP + FRAME / 2;
    const a = Math.max(0, Math.min(n, c - (W >> 1)));
    const b = Math.max(0, Math.min(n, c + (W >> 1)));
    box[m] = b > a ? (pw[b] - pw[a]) / (b - a) : 0;
  }
  const amp = new Float32Array(nFrames);
  const lv = new Float64Array(nFrames);
  const r = Math.max(1, Math.round(W / HOP / 2));
  for (let m = 0; m < nFrames; m++) {
    let s = 0;
    let k = 0;
    for (let j = m - r; j <= m + r; j++) {
      if (j < 0 || j >= nFrames) continue;
      s += box[j];
      k++;
    }
    amp[m] = Math.sqrt(k ? s / k : 0);
    lv[m] = Math.log1p(LOG_GAMMA * 90 * amp[m]);
  }
  const rise = new Float32Array(nFrames);
  for (let m = 2; m < nFrames; m++) {
    const d = lv[m] - lv[m - 2];
    rise[m] = d > 0 ? d : 0;
  }
  return { amp, rise };
}

/** Moving-average high-pass (±`half` frames) and half-wave rectification. */
function novelty(env: Float32Array, half: number): Float64Array {
  const n = env.length;
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + env[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const v = env[i] - (cs[b] - cs[a]) / (b - a);
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

/** Unbiased autocorrelation of the mean-removed signal, normalised so lag 0 = 1. */
function autocorr(e: Float64Array, maxLag: number): Float64Array {
  const n = e.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += e[i];
  mean /= n || 1;
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = e[i] - mean;
  fft(re, im);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im); // power spectrum is real and even: the forward FFT gives the ACF × size
  const L = Math.min(maxLag, n - 1);
  const acf = new Float64Array(L + 1);
  const z = re[0] / n || 1;
  for (let l = 0; l <= L; l++) acf[l] = re[l] / (n - l) / z;
  return acf;
}

/** ACF peak near a lag (±`tol` frames, default max(1.5, 1 %)), parabolically interpolated. */
function acfPeak(acf: Float64Array, lag: number, tol = Math.max(1.5, lag * 0.01)): { lag: number; value: number } {
  const lo = Math.max(1, Math.floor(lag - tol));
  const hi = Math.min(acf.length - 2, Math.ceil(lag + tol));
  if (hi < lo) return { lag, value: 0 };
  let best = lo;
  for (let l = lo + 1; l <= hi; l++) if (acf[l] > acf[best]) best = l;
  const [a, b, c] = [acf[best - 1], acf[best], acf[best + 1]];
  const den = a - 2 * b + c;
  const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return { lag: best + d, value: Math.max(0, b - 0.25 * (a - c) * d) };
}

/** Weighted sum of DFT magnitudes of `e` at the beat frequency and its first
 *  three harmonics (HARMONIC_WEIGHTS), over frames [from, to). */
function coherence(e: Float64Array, fps: number, bpm: number, from = 0, to = e.length): number {
  const w = (2 * Math.PI * bpm) / 60 / fps;
  // Rotation by w per frame for harmonic 1; harmonics 2–4 are its powers.
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const c3 = Math.cos(3 * w), s3 = Math.sin(3 * w);
  const c4 = Math.cos(4 * w), s4 = Math.sin(4 * w);
  let r1 = Math.cos(w * from), i1 = Math.sin(w * from);
  let r2 = Math.cos(2 * w * from), i2 = Math.sin(2 * w * from);
  let r3 = Math.cos(3 * w * from), i3 = Math.sin(3 * w * from);
  let r4 = Math.cos(4 * w * from), i4 = Math.sin(4 * w * from);
  let a1 = 0, b1 = 0, a2 = 0, b2 = 0, a3 = 0, b3 = 0, a4 = 0, b4 = 0;
  for (let n = from; n < to; n++) {
    const v = e[n];
    if (v !== 0) {
      a1 += v * r1; b1 += v * i1;
      a2 += v * r2; b2 += v * i2;
      a3 += v * r3; b3 += v * i3;
      a4 += v * r4; b4 += v * i4;
    }
    let t = r1 * c1 - i1 * s1; i1 = r1 * s1 + i1 * c1; r1 = t;
    t = r2 * c2 - i2 * s2; i2 = r2 * s2 + i2 * c2; r2 = t;
    t = r3 * c3 - i3 * s3; i3 = r3 * s3 + i3 * c3; r3 = t;
    t = r4 * c4 - i4 * s4; i4 = r4 * s4 + i4 * c4; r4 = t;
  }
  const [h1, h2, h3, h4] = HARMONIC_WEIGHTS;
  return h1 * Math.hypot(a1, b1) + h2 * Math.hypot(a2, b2) + h3 * Math.hypot(a3, b3) + h4 * Math.hypot(a4, b4);
}

/** Best tempo near `bpm` (±`spanPct` %), on a 0.05 then 0.005 BPM grid. */
function refineTempo(e: Float64Array, fps: number, bpm: number, spanPct: number, from = 0, to = e.length) {
  const span = (bpm * spanPct) / 100;
  let best = bpm;
  let bestV = -1;
  for (let b = bpm - span; b <= bpm + span + 1e-9; b += 0.05) {
    const v = coherence(e, fps, b, from, to);
    if (v > bestV) {
      bestV = v;
      best = b;
    }
  }
  const grid: number[] = [];
  const vals: number[] = [];
  for (let b = best - 0.06; b <= best + 0.06 + 1e-9; b += 0.005) {
    grid.push(b);
    vals.push(coherence(e, fps, b, from, to));
  }
  let i = 0;
  for (let j = 1; j < vals.length; j++) if (vals[j] > vals[i]) i = j;
  let out = grid[i];
  let value = vals[i];
  if (i > 0 && i < vals.length - 1) {
    const [a, b, c] = [vals[i - 1], vals[i], vals[i + 1]];
    const den = a - 2 * b + c;
    if (den < 0) {
      const d = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
      out += d * 0.005;
      value = b - 0.25 * (a - c) * d;
    }
  }
  return { bpm: out, value };
}

/** Linear interpolation into a frame signal at a fractional frame index. */
function at(e: ArrayLike<number>, f: number): number {
  if (f < 0 || f > e.length - 1) return 0;
  const i = Math.floor(f);
  const u = f - i;
  return i + 1 < e.length ? e[i] * (1 - u) + e[i + 1] * u : e[i];
}

/** Max of a frame signal within ±r frames of a fractional index. */
function near(e: ArrayLike<number>, f: number, r: number): number {
  let m = 0;
  for (let i = Math.max(0, Math.round(f - r)); i <= Math.min(e.length - 1, Math.round(f + r)); i++) if (e[i] > m) m = e[i];
  return m;
}

export function percentile(x: ArrayLike<number>, p: number): number {
  if (!x.length) return 0;
  const s = Float64Array.from(x as ArrayLike<number>).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

function prior(bpm: number) {
  const o = Math.log2(bpm / PRIOR_CENTRE) / PRIOR_SIGMA;
  return Math.exp(-0.5 * o * o);
}

export function estimateTempo(mono: Float32Array, sampleRate: number, opts: { min?: number; max?: number } = {}): TempoEstimate | null {
  const min = opts.min ?? 75;
  const max = opts.max ?? 200;
  const duration = mono.length / sampleRate;
  if (!(duration >= MIN_SECONDS)) return null;

  let ss = 0;
  for (let i = 0; i < mono.length; i++) ss += mono[i] * mono[i];
  if (Math.sqrt(ss / mono.length) < SILENCE_RMS) return null;

  const oe = onsetEnvelope(mono, sampleRate);
  const { fps } = oe;
  // Stationary noise (any colour): its spectrum, whitened by its own long-term
  // average, is as flat as an exponential variate allows (e^−γ ≈ 0.56); music
  // measures 0.02–0.3. But drums under loud hiss read flat too, so it's noise
  // only if the onset envelope also has no outliers: its 99.5th percentile
  // sits ≈ 2.3 interquantile (16–84 %) ranges above the median for noise, ≥ 5
  // for drums mixed with noise at −20 dB.
  if (oe.whiteFlatness > NOISE_FLATNESS) {
    const p50 = percentile(oe.env, 0.5);
    const spread = percentile(oe.env, 0.84) - percentile(oe.env, 0.16);
    if (!(percentile(oe.env, 0.995) - p50 > NOISE_PEAKINESS * spread)) return null;
  }
  // No transients at all (a pad, a drone): the envelope's 99.5th percentile
  // stays under MIN_ONSET. Log compression makes this independent of level.
  if (percentile(oe.env, 0.995) < MIN_ONSET) return null;
  const e = novelty(oe.env, Math.round(fps * 0.25));
  const n = e.length;

  // ── Periodicity ────────────────────────────────────────────────────────
  const toLag = (bpm: number) => (fps * 60) / bpm;
  const toBpm = (lag: number) => (fps * 60) / lag;
  // Lags up to 4 × the 30 BPM period: the harmonic sum reads 4 periods, and
  // the candidates include half of a 75 BPM reading.
  const maxLag = Math.ceil(4 * toLag(30)) + 8;
  const acfFull = autocorr(e, maxLag);
  // The low band (kick, bass) carries the beat. With kicks on the beat and hats
  // on the offbeats at similar strength, the full-band envelope is an 8th-note
  // pulse, which fits a 1½-beat period as well as the beat; the kick alone
  // doesn't. So the ACF used from here on mixes in the low band's, weighted
  // by how periodic the low band is (up to 2 : 1 over the full band).
  const eLow = novelty(oe.lowRise, Math.round(fps * 0.25));
  const acfLow = autocorr(eLow, maxLag);
  let lowPeak = 0;
  for (let l = Math.floor(toLag(220)); l <= Math.ceil(toLag(40)) && l < acfLow.length; l++) lowPeak = Math.max(lowPeak, acfLow[l]);
  const wLow = LOW_WEIGHT * Math.max(0, Math.min(1, lowPeak / 0.3));
  const acf = new Float64Array(acfFull.length);
  for (let l = 0; l < acf.length; l++) acf[l] = (acfFull[l] + wLow * acfLow[l]) / (1 + wLow);
  const sal = (bpm: number) => (toLag(bpm) < acf.length - 2 ? acfPeak(acf, toLag(bpm)).value : 0);
  const salFull = (bpm: number) => (toLag(bpm) < acfFull.length - 2 ? acfPeak(acfFull, toLag(bpm)).value : 0);
  // Metrical salience of a period: the mean ACF at 1…4 periods. A true beat
  // divides the bar, so its multiples land on bar repeats; a syncopation
  // period (a kick 1½ beats after another) doesn't. This picks the family.
  const lagLo = Math.floor(toLag(220));
  const lagHi = Math.ceil(toLag(40));
  const hs = new Float64Array(lagHi + 2);
  // Each multiple k·l is read as the ACF's max within ±k/2 frames, so an
  // integer lag a fraction off the true period still finds the far peaks.
  const hsAt = (lag: number, skip?: (lag: number) => boolean) => {
    let v = 0;
    let m = 0;
    for (let k = 1; k <= 4; k++) {
      if (skip?.(k * lag)) continue;
      v += near(acf, k * lag, k / 2);
      m++;
    }
    return m ? v / m : 0;
  };
  for (let l = Math.max(1, lagLo - 1); l <= lagHi + 1; l++) hs[l] = hsAt(l);
  const hPeaks: { lag: number; value: number }[] = [];
  for (let l = lagLo; l <= lagHi; l++) {
    if (hs[l] > hs[l - 1] && hs[l] >= hs[l + 1] && hs[l] > 0) {
      const [a, b, c] = [hs[l - 1], hs[l], hs[l + 1]];
      const den = a - 2 * b + c;
      const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
      hPeaks.push({ lag: l + d, value: b - 0.25 * (a - c) * d });
    }
  }
  if (!hPeaks.length) return null;
  let dom = hPeaks[0];
  for (const p of hPeaks) if (p.value * prior(toBpm(p.lag)) > dom.value * prior(toBpm(dom.lag))) dom = p;
  const domBpm = toBpm(dom.lag);

  // ── Octave choice (see OCTAVE RULE) ────────────────────────────────────
  let chosen = 0;
  let bestScore = -1;
  for (let k = -3; k <= 3; k++) {
    const b = domBpm * 2 ** k;
    if (b < min || b >= max) continue;
    const score = sal(b) * prior(b);
    if (score > bestScore) {
      bestScore = score;
      chosen = b;
    }
  }
  if (!chosen) {
    // Range narrower than an octave and the family misses it: take the member nearest the range.
    let bestDist = Infinity;
    for (let k = -3; k <= 3; k++) {
      const b = domBpm * 2 ** k;
      const d = b < min ? Math.log2(min / b) : b >= max ? Math.log2(b / max) : 0;
      if (d < bestDist) {
        bestDist = d;
        chosen = b;
      }
    }
  }
  // Re-centre before the fine search: the period from the ACF peak at 4 periods
  // (4× the lag precision of reading one period), when that peak is there.
  {
    const L = toLag(chosen);
    if (4 * L < acf.length - 2) {
      const far = acfPeak(acf, 4 * L, 3);
      if (far.value > 0.5 * sal(chosen)) chosen = toBpm(far.lag / 4);
    }
  }

  // ── Precision ──────────────────────────────────────────────────────────
  const ew = new Float64Array(n);
  for (let i = 0; i < n; i++) ew[i] = e[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
  const fine = refineTempo(ew, fps, chosen, 1.2);
  let bpm = fine.bpm;
  const nearest = Math.round(bpm);
  if (Math.abs(bpm - nearest) <= 0.15 && Math.abs(bpm - nearest) > 1e-6) {
    if (coherence(ew, fps, nearest) >= 0.97 * fine.value) bpm = nearest;
  }

  // ── Beat phase ─────────────────────────────────────────────────────────
  const P = (fps * 60) / bpm; // frames per beat
  let xr = 0;
  let xi = 0;
  {
    const w = (2 * Math.PI) / P;
    for (let i = 0; i < n; i++) {
      xr += ew[i] * Math.cos(w * i);
      xi -= ew[i] * Math.sin(w * i);
    }
  }
  // e[i] ≈ Σ δ(i − φ − jP) ⇒ X = Σ e^{−iw(φ+jP)} ⇒ arg X = −wφ.
  let phase = ((-Math.atan2(xi, xr) / (2 * Math.PI)) * P + P) % P;
  if (wLow > 0) {
    // Kicks on the beat and hats on the offbeat are in antiphase at the beat
    // frequency, so the louder of the two sets the full band's phase. When
    // the low band is periodic, it decides between φ and φ + ½ beat.
    const nBeats = Math.floor(n / P);
    let on = 0;
    let off = 0;
    for (let j = -1; j <= nBeats; j++) {
      on += near(eLow, phase + j * P, P / 8);
      off += near(eLow, phase + (j + 0.5) * P, P / 8);
    }
    if (off > 1.5 * on) phase = (phase + P / 2) % P;
  }
  {
    // Comb refine over ±¼ beat, ¼-frame steps.
    let best = phase;
    let bestV = -1;
    const nBeats = Math.floor(n / P);
    for (let d = -P / 4; d <= P / 4; d += 0.25) {
      let v = 0;
      for (let j = -1; j <= nBeats; j++) v += at(e, phase + d + j * P);
      if (v > bestV) {
        bestV = v;
        best = phase + d;
      }
    }
    phase = ((best % P) + P) % P;
  }
  const beatSec = 60 / bpm;
  const grid = oe.t0 + phase / fps - LATENCY; // seconds of one beat on the grid
  // First beat: the first grid beat (at or after 0 s; a beat estimated a hair
  // before 0 s is clamped to 0) whose onset strength reaches 30 % of the median
  // beat's — where the beat actually starts, past any silence or a beatless intro.
  let j0 = Math.ceil((-0.03 - grid) / beatSec);
  const beatVals: number[] = [];
  for (let j = j0; ; j++) {
    const f = (grid + j * beatSec + LATENCY - oe.t0) * fps;
    if (f > n - 1) break;
    beatVals.push(near(e, f, 2));
  }
  const typical = percentile(beatVals, 0.5);
  let k0 = beatVals.findIndex((v) => v >= 0.3 * typical);
  if (k0 < 0) k0 = 0;
  j0 += k0;
  const firstBeat = Math.max(0, grid + j0 * beatSec);

  // ── Downbeat (see DOWNBEAT RULE) ───────────────────────────────────────
  const L = [0, 0, 0, 0];
  const M = [0, 0, 0, 0];
  {
    // Rise of linear band amplitude across each beat: mean over the ¼ beat
    // after it minus the ¼ beat before it, floored at 0. Linear (not log)
    // so a heavier kick or a bass note on the one counts for what it is.
    const q = Math.max(2, Math.round(P / 4));
    const rise = (a: Float32Array, f: number) => {
      const c = Math.round(f);
      let before = 0;
      let after = 0;
      for (let i = c - q; i < c; i++) before += i >= 0 && i < n ? a[i] : 0;
      for (let i = c; i < c + q; i++) after += i >= 0 && i < n ? a[i] : 0;
      return Math.max(0, after - before) / q;
    };
    for (let j = 0; ; j++) {
      const f = (firstBeat + j * beatSec + LATENCY - oe.t0) * fps - 1; // a frame early: catch the attack
      if (f + q > n - 1) break;
      L[j % 4] += rise(oe.lowAmp, f);
      M[j % 4] += rise(oe.midAmp, f);
    }
  }
  let downPhase = 0;
  {
    const rA = (L[0] + L[2]) / (M[0] + M[2] + 1e-9);
    const rB = (L[1] + L[3]) / (M[1] + M[3] + 1e-9);
    let pair: number[] = [0, 1, 2, 3];
    if (rA > rB * 1.15) pair = [0, 2];
    else if (rB > rA * 1.15) pair = [1, 3];
    downPhase = pair[0];
    for (const k of pair) if (L[k] > L[downPhase]) downPhase = k;
  }
  const firstDownbeat = firstBeat + downPhase * beatSec;

  // ── Confidence ─────────────────────────────────────────────────────────
  // Margin of the chosen family's metrical salience over the best periodicity
  // that isn't metrically related to it. Related lags: whole numbers of beats,
  // and ½, ⅓, ¼ beat. A rival is scored only on its multiples that aren't
  // related (a 1½-beat rival's 3- and 6-beat multiples belong to the beat).
  const beatLag = toLag(bpm);
  const related = (lag: number) => {
    const r = lag / beatLag;
    if (r >= 0.9) return Math.abs(r - Math.round(r)) < 0.04 * Math.round(r);
    const q = 1 / r;
    return [2, 3, 4].includes(Math.round(q)) && Math.abs(q - Math.round(q)) < 0.04 * Math.round(q);
  };
  const family = Math.max(hsAt(beatLag), hsAt(2 * beatLag));
  let rival = 0;
  for (const p of hPeaks) if (!related(p.lag)) rival = Math.max(rival, hsAt(p.lag, related));
  const margin = family > 0 ? Math.max(0, Math.min(1, (family - rival) / family)) : 0;
  // A weak pulse (clarity near the noise floor) can't be confident however clean the margin.
  const clarity = Math.max(0, Math.min(1, (family - MIN_CLARITY) / 0.2));
  const confidence = margin * clarity;

  // ── Candidates ─────────────────────────────────────────────────────────
  // Scored like the octave choice (metrical salience × prior), relative to the
  // chosen tempo, which is first with salience 1. Half and double always;
  // ⅔ and 3⁄2 and other strong periodicities when they score ≥ 0.3.
  const score = (b: number) => (toLag(b) * 4 < acf.length - 2 ? hsAt(toLag(b)) * prior(b) : 0);
  const s0 = score(bpm) || 1;
  const cands: TempoCandidate[] = [{ bpm, salience: 1 }];
  const add = (b: number, force: boolean) => {
    if (b < 20 || b > 400 || cands.some((c) => Math.abs(c.bpm / b - 1) < 0.01)) return;
    const s = Math.min(1, score(b) / s0);
    if (force || s >= 0.3) cands.push({ bpm: b, salience: s });
  };
  add(bpm / 2, true);
  add(bpm * 2, true);
  add((bpm * 2) / 3, false);
  add((bpm * 3) / 2, false);
  for (const p of [...hPeaks].sort((a, b) => b.value - a.value).slice(0, 4)) add(toBpm(p.lag), false);
  const candidates = [cands[0], ...cands.slice(1).sort((a, b) => b.salience - a.salience)].map((c) => ({
    bpm: round2(c.bpm),
    salience: Math.round(c.salience * 1000) / 1000,
  }));

  // ── Stability ──────────────────────────────────────────────────────────
  const stability = tempoStability(e, fps, bpm, duration, P, salFull(bpm));

  return {
    bpm: round2(bpm),
    confidence: Math.round(confidence * 1000) / 1000,
    candidates,
    firstBeat: Math.round(firstBeat * 10000) / 10000,
    firstDownbeat: Math.round(firstDownbeat * 10000) / 10000,
    stability: Math.round(stability * 1000) / 1000,
  };
}

function tempoStability(e: Float64Array, fps: number, bpm: number, duration: number, P: number, globalSal: number): number {
  const winSec = Math.min(30, Math.max(8, duration / 2));
  const nWin = duration >= 2 * winSec ? Math.min(4, Math.floor(duration / winSec)) : 2;
  const winFrames = Math.floor(winSec * fps);
  const n = e.length;
  const reads: number[] = [];
  for (let w = 0; w < nWin; w++) {
    const from = Math.round(((n - winFrames) * w) / Math.max(1, nWin - 1));
    const to = Math.min(n, from + winFrames);
    if (to - from < 4 * P) continue;
    // Skip windows with no pulse (a breakdown): local comb energy at the beat period.
    const seg = new Float64Array(to - from);
    for (let i = from; i < to; i++) {
      const u = (i - from + 0.5) / (to - from);
      seg[i - from] = e[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * u));
    }
    const local = autocorr(seg, Math.ceil(P * 1.05) + 2);
    const s = acfPeak(local, P).value;
    if (s < Math.max(MIN_CLARITY, 0.4 * globalSal)) continue;
    reads.push(refineTempo(seg, fps, bpm, 3).bpm);
  }
  if (reads.length < 2) return 0.5;
  let ss = 0;
  for (const r of reads) ss += (r - bpm) ** 2;
  const rms = Math.sqrt(ss / reads.length);
  return Math.exp(-((rms / 0.4) ** 2));
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}
