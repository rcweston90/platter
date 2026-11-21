import { fft } from '../engine/fft';
import type { AutoSlice, PcmLike, Peaks } from './types';

/**
 * The slicer's signal processing: waveform peaks, transient detection, auto
 * slicing, slice extraction and WAV export. Pure TypeScript over PcmLike (an
 * AudioBuffer, or plain channel arrays in tests), so it runs in Node and in
 * the browser alike, on the main thread or in a worker.
 *
 * Transients follow the published recipe for onset detection (Bello et al.
 * 2005, "A tutorial on onset detection in music signals"; Böck, Krebs &
 * Schedl 2012, "Evaluating the online capabilities of onset detection
 * methods"; Böck & Widmer 2013, "Maximum filter vibrato suppression" for the
 * SuperFlux max filter): log-compressed spectral flux, an adaptive threshold,
 * peak picking — then each onset is moved back to where the attack actually
 * starts, because a slice that begins a few ms late loses its click.
 *
 * MIT, like the rest of Platter: written here from the papers, no code from
 * aubio, madmom, Essentia or other GPL projects.
 */

/* ── Peaks ─────────────────────────────────────────────────────────────── */

/** The channels' data arrays, in order. */
function channelsOf(pcm: PcmLike): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < pcm.numberOfChannels; c++) out.push(pcm.getChannelData(c));
  return out;
}

/**
 * Min/max peaks of the channel-mixed signal, `binSize` samples per bin
 * (default 256 — 5.8 ms at 44.1 kHz, fine enough for a zoomed-in slice).
 * One pass, no allocation per sample: a 6-minute stereo track takes ~30 ms.
 */
export function buildPeaks(pcm: PcmLike, binSize = 256): Peaks {
  const size = Math.max(1, Math.floor(binSize));
  const n = pcm.length;
  const bins = Math.ceil(n / size);
  const min = new Float32Array(bins);
  const max = new Float32Array(bins);
  const chans = channelsOf(pcm);
  const nc = chans.length;
  if (nc === 0 || n === 0) return { sampleRate: pcm.sampleRate, binSize: size, min, max };
  const L = chans[0];
  const R = nc > 1 ? chans[1] : null;
  const g = 1 / nc;
  for (let b = 0, i = 0; b < bins; b++) {
    const stop = Math.min(n, i + size);
    let lo = Infinity;
    let hi = -Infinity;
    if (nc === 1) {
      for (; i < stop; i++) {
        const x = L[i];
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    } else if (nc === 2 && R) {
      for (; i < stop; i++) {
        const x = 0.5 * (L[i] + R[i]);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    } else {
      for (; i < stop; i++) {
        let x = 0;
        for (let c = 0; c < nc; c++) x += chans[c][i];
        x *= g;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { sampleRate: pcm.sampleRate, binSize: size, min, max };
}

/**
 * Reduce peaks over [startSec, endSec) to `columns` min/max pairs for drawing.
 * Each column takes the min of mins and max of maxes of every bin it touches,
 * so a column never under-draws a hit even when it's narrower than a bin
 * (zoomed right in, neighbouring columns then repeat the same bin). Parts of
 * the range outside the audio read 0.
 */
export function peaksColumns(
  p: Peaks,
  startSec: number,
  endSec: number,
  columns: number,
): { min: Float32Array; max: Float32Array } {
  const cols = Math.max(0, Math.floor(columns));
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  if (cols === 0 || !(endSec > startSec)) return { min, max };
  const nb = p.min.length;
  const binsPerSec = p.sampleRate / p.binSize;
  const b0 = startSec * binsPerSec;
  const step = ((endSec - startSec) * binsPerSec) / cols;
  for (let c = 0; c < cols; c++) {
    const from = b0 + c * step;
    const to = from + step;
    // Bins [first, last] overlap [from, to).
    const first = Math.floor(from);
    const last = Math.max(first, Math.ceil(to) - 1);
    let lo = Infinity;
    let hi = -Infinity;
    if (first < 0 || last >= nb) {
      // Partly (or wholly) outside the audio: that part is silence.
      lo = 0;
      hi = 0;
    }
    const a = Math.max(0, first);
    const z = Math.min(nb - 1, last);
    for (let b = a; b <= z; b++) {
      if (p.min[b] < lo) lo = p.min[b];
      if (p.max[b] > hi) hi = p.max[b];
    }
    min[c] = lo === Infinity ? 0 : lo;
    max[c] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}

/* ── Transients ────────────────────────────────────────────────────────── */

/** Log compression: log(1 + γ·amplitude), amplitude normalised so a full-
 *  scale sine reads 1. γ = 1000 puts −60 dBFS at log(2) — quiet noise
 *  floors barely register, a −30 dB hat still does. */
const LOG_GAMMA = 1000;
/** Band edges (Hz). Flux is averaged per band and the band means summed, so a
 *  kick's three low bins weigh as much as a hat's hundreds of high ones. */
const LOW_HZ = 200;
const MID_HZ = 2000;
const TOP_HZ = 16000;
/** The low band's mean counts half. Its 4–5 bins (43 Hz apart at 1024/44.1k)
 *  can't separate a bass note from a chord's low partials, and what they
 *  can't separate fluctuates frame to frame; a kick still clears the
 *  threshold on half weight plus its click in the bands above. */
const LOW_WEIGHT = 0.5;
/** Below this (band-mean log flux) nothing in the region is an onset: silence
 *  or a stationary noise floor. A soft hat at −30 dBFS is ~0.3. */
const MIN_FLUX = 0.04;
/** Adaptive threshold: local mean of the envelope over this window (s). */
const AVG_PRE = 0.1;
const AVG_POST = 0.07;
/** An onset is the largest flux within ± this (s). */
const MAX_HALF = 0.03;
/** Attack refinement: envelope blocks (s) and how far back the "before"
 *  level looks (s) — 12 ms spans a full cycle of anything above 83 Hz, so a
 *  bass note under a hit isn't mistaken for the hit's rise. */
const ATTACK_BLOCK = 0.001;
const ATTACK_LOOKBACK = 0.012;
/** Snap to a zero crossing within this (s), earlier side first. */
const ZC_RADIUS = 0.002;

/**
 * Sensitivity → delta, as a fraction of the region's loud-flux level (99th
 * percentile): 0 → 0.8 (only the biggest hits), 0.5 → 0.14 (every drum hit,
 * not a pad's slow beating), 1 → 0.024 (ghost notes, syllables, and some
 * false alarms). Exponential, so the slider feels even across its range.
 */
function deltaFor(sensitivity: number): number {
  const s = Math.min(1, Math.max(0, Number.isFinite(sensitivity) ? sensitivity : 0.5));
  return 0.8 * Math.pow(0.03, s);
}

/** FFT size for a rate: 1024 at 44.1/48 kHz (23 ms), 2048 at 88.2/96 kHz —
 *  the same window in time, so the threshold behaves the same at any rate. */
function frameFor(sr: number): number {
  return Math.max(256, 2 ** Math.round(Math.log2((sr * 1024) / 44100)));
}

/**
 * Onset (transient) times in seconds within [start, end) (default: the whole
 * buffer), sorted. Spectral flux (SuperFlux-style ±1-bin max filter,
 * half-wave rectified, band means summed, low band at half weight) → adaptive threshold (local mean +
 * delta, delta from `sensitivity` 0…1 where 1 = most onsets) → peak picking →
 * at least `minGap` seconds apart → each moved back to its attack start and
 * to a zero crossing within 2 ms. Audio just outside the region is read as
 * context, so a note already sounding at `start` isn't reported as an onset.
 */
export function detectOnsets(
  pcm: PcmLike,
  opts: { sensitivity: number; minGap: number; start?: number; end?: number },
): number[] {
  const sr = pcm.sampleRate;
  const len = pcm.length;
  const s0 = clampInt(Math.round((opts.start ?? 0) * sr), 0, len);
  const s1 = clampInt(Math.round((opts.end ?? len / sr) * sr), s0, len);
  if (s1 - s0 < Math.round(0.01 * sr) || pcm.numberOfChannels === 0) return [];

  const N = frameFor(sr);
  const hop = N >> 1;
  const half = N >> 1;
  const nFrames = Math.ceil((s1 - s0) / hop);
  // Mono over [s0 − N, s0 + nFrames·hop + N), zero outside the buffer. Frame
  // m (m ≥ −1) is centred on s0 + m·hop and starts at mono[m·hop + N/2].
  const base = s0 - N;
  const mono = monoSpan(pcm, base, nFrames * hop + 2 * N);

  const binHz = sr / N;
  const lowHi = Math.max(2, Math.round(LOW_HZ / binHz));
  const midHi = Math.max(lowHi + 1, Math.min(half, Math.round(MID_HZ / binHz)));
  const topHi = Math.max(midHi + 1, Math.min(half, Math.round(TOP_HZ / binHz)));
  const nLow = lowHi - 1;
  const nMid = midHi - lowHi;
  const nHigh = topHi - midHi;

  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const norm = (LOG_GAMMA * 4) / N; // γ · 2/Σw: a full-scale sine reads γ
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(topHi);
  let a = new Float64Array(topHi);
  let b = new Float64Array(topHi);
  const env = new Float32Array(nFrames);

  // Flux of `cur` over `prv`: positive differences only (a decay is not an
  // onset), against the previous frame max-filtered across ±1 bin, so
  // vibrato, pitch glides and two low partials beating in one bin don't read
  // as new notes (Böck & Widmer 2013).
  const flux = (prv: Float64Array, cur: Float64Array) => {
    let l = 0;
    let md = 0;
    let h = 0;
    for (let k = 1; k < topHi; k++) {
      let p = prv[k];
      if (k > 1 && prv[k - 1] > p) p = prv[k - 1];
      if (k + 1 < topHi && prv[k + 1] > p) p = prv[k + 1];
      const d = cur[k] - p;
      if (d > 0) {
        if (k < lowHi) l += d;
        else if (k < midHi) md += d;
        else h += d;
      }
    }
    return (LOW_WEIGHT * l) / nLow + md / (nMid || 1) + h / (nHigh || 1);
  };

  // Frames −1 … nFrames−1, two real frames per complex FFT
  // (z = x + i·y → X[k] = (Z[k] + conj Z[N−k]) / 2, Y[k] = (Z[k] − conj Z[N−k]) / 2i).
  for (let m = -1; m < nFrames; m += 2) {
    const o1 = (m + 1) * hop; // frame m starts at mono[m·hop + N/2], and hop = N/2
    const has2 = m + 1 < nFrames;
    const o2 = o1 + hop;
    for (let i = 0; i < N; i++) {
      re[i] = mono[o1 + i] * win[i];
      im[i] = has2 ? mono[o2 + i] * win[i] : 0;
    }
    fft(re, im);
    for (let k = 0; k < topHi; k++) {
      const j = (N - k) & (N - 1);
      const zr = re[k];
      const zi = im[k];
      const nr = re[j];
      const ni = im[j];
      const ar = 0.5 * (zr + nr);
      const ai = 0.5 * (zi - ni);
      const br = 0.5 * (zi + ni);
      const bi = -0.5 * (zr - nr);
      a[k] = Math.log1p(norm * Math.sqrt(ar * ar + ai * ai));
      b[k] = Math.log1p(norm * Math.sqrt(br * br + bi * bi));
    }
    if (m >= 0) env[m] = flux(prev, a);
    if (has2) env[m + 1] = flux(a, b);
    // Rotate buffers: the newest frame becomes `prev`.
    const t = prev;
    if (has2) {
      prev = b;
      b = t;
    } else {
      prev = a;
      a = t;
    }
  }

  // Nothing loud enough to call an onset anywhere: silence or a noise floor.
  let peak = 0;
  for (let m = 0; m < nFrames; m++) if (env[m] > peak) peak = env[m];
  if (peak < MIN_FLUX) return [];

  // Threshold: local mean + delta · (loud-flux level). The 99th percentile
  // rather than the max, so one huge hit doesn't hide the rest.
  const level = Math.max(quantile(env, 0.99), MIN_FLUX);
  const delta = deltaFor(opts.sensitivity) * level;
  const fps = sr / hop;
  const pre = Math.max(1, Math.round(AVG_PRE * fps));
  const post = Math.max(1, Math.round(AVG_POST * fps));
  const wMax = Math.max(1, Math.round(MAX_HALF * fps));
  const minGap = Math.max(0, opts.minGap || 0);
  const gapFrames = Math.max(1, Math.round(minGap * fps));
  const csum = new Float64Array(nFrames + 1);
  for (let m = 0; m < nFrames; m++) csum[m + 1] = csum[m] + env[m];

  // A frame whose window runs past the end of the buffer sees the audio stop
  // dead — a broadband click that isn't in the music. Don't pick those.
  const lastFrame = Math.min(nFrames, Math.floor((len - half - s0) / hop) + 1);
  const frames: number[] = [];
  for (let m = 0; m < lastFrame; m++) {
    const e = env[m];
    if (e < MIN_FLUX) continue;
    const lo = Math.max(0, m - pre);
    const hi = Math.min(nFrames, m + post + 1);
    const mean = (csum[hi] - csum[lo]) / (hi - lo);
    if (e < mean + delta) continue;
    // Local maximum; among equal values the first wins.
    let isMax = true;
    for (let k = Math.max(0, m - wMax); k <= Math.min(nFrames - 1, m + wMax); k++) {
      if (env[k] > e || (k < m && env[k] === e)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    // Within minGap of the previous onset: keep whichever is stronger.
    const prevM = frames.length ? frames[frames.length - 1] : -Infinity;
    if (m - prevM < gapFrames) {
      if (e > env[prevM]) frames[frames.length - 1] = m;
      continue;
    }
    frames.push(m);
  }

  // Refine each onset to its attack, then enforce minGap again (refinement
  // can only move onsets earlier, by up to a frame).
  const out: number[] = [];
  const gapSamples = Math.round(minGap * sr);
  let last = -Infinity;
  for (const m of frames) {
    const c = s0 + m * hop;
    const lo = Math.max(s0, c - N, last === -Infinity ? 0 : last + Math.round(0.005 * sr));
    const hi = Math.min(s1, c + hop);
    let at = hi > lo ? attackStart(mono, base, lo, hi, sr) : c;
    at = clampInt(at, s0, s1 - 1);
    if (last !== -Infinity && at - last < Math.max(1, gapSamples)) continue;
    out.push(at / sr);
    last = at;
  }
  return out;
}

/**
 * Where the attack starts, as an absolute sample index, searching [lo, hi).
 * A ~1 ms peak envelope is compared with its own maximum over the previous
 * 12 ms; the first block whose rise reaches half the largest rise holds the
 * attack, and inside it the first sample a quarter of the way up. This runs
 * on the first difference of the signal first (a +6 dB/octave tilt: a pad or
 * bass under the hit drops ~25 dB against a hat or a kick's click), and on
 * the plain signal when that shows no clear (2×) rise — a clickless sub kick.
 * Then back to a zero crossing within 2 ms.
 */
function attackStart(mono: Float32Array, base: number, lo: number, hi: number, sr: number): number {
  const blk = Math.max(8, Math.round(ATTACK_BLOCK * sr));
  const back = Math.max(1, Math.round(ATTACK_LOOKBACK / ATTACK_BLOCK));
  const from = lo - back * blk;
  const n = hi - from;
  const raw = new Float32Array(n);
  const dif = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = from + i - base;
    if (j >= 1 && j < mono.length) {
      raw[i] = mono[j];
      dif[i] = mono[j] - mono[j - 1];
    }
  }
  const hit = riseIn(dif, blk, back);
  const at = hit.ratio >= 2 ? hit.at : riseIn(raw, blk, back).at;
  return nearestZc(mono, base, at < 0 ? lo : from + at, sr);
}

/** The attack in `x` (see attackStart): its sample index (−1 if nothing
 *  rises) and how many times louder its block is than the 12 ms before it. */
function riseIn(x: Float32Array, blk: number, back: number): { at: number; ratio: number } {
  const nb = Math.ceil(x.length / blk);
  const e = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    let mx = 0;
    for (let i = k * blk, z = Math.min(x.length, i + blk); i < z; i++) {
      const v = Math.abs(x[i]);
      if (v > mx) mx = v;
    }
    e[k] = mx;
  }
  const rise = new Float32Array(nb);
  const before = new Float32Array(nb);
  let best = 0;
  for (let k = back; k < nb; k++) {
    let bmax = 0;
    for (let j = k - back; j < k; j++) if (e[j] > bmax) bmax = e[j];
    before[k] = bmax;
    rise[k] = e[k] - bmax;
    if (rise[k] > best) best = rise[k];
  }
  if (!(best > 0)) return { at: -1, ratio: 0 };
  let k = back;
  while (k < nb && rise[k] < 0.5 * best) k++;
  const thr = before[k] + 0.25 * (e[k] - before[k]);
  let at = k * blk;
  for (let i = k * blk, z = Math.min(x.length, i + blk); i < z; i++) {
    if (Math.abs(x[i]) >= thr) {
      at = i;
      break;
    }
  }
  return { at, ratio: e[k] / Math.max(before[k], 1e-9) };
}

/** Zero crossing near absolute sample `at` in the mono span, preferring the
 *  earlier side (a slice that starts early keeps its attack). */
function nearestZc(mono: Float32Array, base: number, at: number, sr: number): number {
  const r = Math.max(1, Math.round(ZC_RADIUS * sr));
  const i = at - base;
  for (let d = 0; d <= r; d++) {
    const j = i - d;
    if (j < 1 || j >= mono.length) continue;
    if (crosses(mono, j)) return base + pickCloser(mono, j);
  }
  return base + nearestZeroCrossing(mono, i, r);
}

/** True when the signal changes sign (or touches zero) between j − 1 and j. */
function crosses(x: Float32Array, j: number): boolean {
  const p = x[j - 1];
  const q = x[j];
  return q === 0 || (p < 0 && q > 0) || (p > 0 && q < 0);
}

/** Of samples j − 1 and j (a crossing), the one nearer zero. */
function pickCloser(x: Float32Array, j: number): number {
  return Math.abs(x[j - 1]) < Math.abs(x[j]) ? j - 1 : j;
}

/**
 * Nearest zero crossing (sample index) to sample `i` within ±radius samples
 * on channel data `ch` — the sample nearer zero of the pair that straddles
 * the crossing. Returns i if there is none (or i is out of range).
 */
export function nearestZeroCrossing(ch: Float32Array, i: number, radius: number): number {
  const n = ch.length;
  if (i < 0 || i >= n) return i;
  if (ch[i] === 0) return i;
  const r = Math.max(0, Math.floor(radius));
  for (let d = 0; d <= r; d++) {
    // Crossing between i − d − 1 and i − d (earlier side first at equal distance).
    const j1 = i - d;
    if (j1 >= 1 && crosses(ch, j1)) return pickCloser(ch, j1);
    const j2 = i + d + 1;
    if (j2 < n && crosses(ch, j2)) return pickCloser(ch, j2);
  }
  return i;
}

/** Mono mix of samples [from, from + count), zero where outside the buffer. */
function monoSpan(pcm: PcmLike, from: number, count: number): Float32Array {
  const out = new Float32Array(count);
  const a = Math.max(0, from);
  const z = Math.min(pcm.length, from + count);
  if (z <= a) return out;
  const nc = pcm.numberOfChannels;
  const g = 1 / nc;
  for (let c = 0; c < nc; c++) {
    const ch = pcm.getChannelData(c);
    for (let i = a; i < z; i++) out[i - from] += ch[i] * g;
  }
  return out;
}

function quantile(x: Float32Array, q: number): number {
  if (!x.length) return 0;
  const s = Float32Array.from(x).sort();
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ── Auto-slice ────────────────────────────────────────────────────────── */

/** Slice points closer than this are one point. */
const MERGE_SEC = 0.01;

/**
 * Slice points for an auto-slice mode over a source of `duration` seconds:
 * sorted, de-duplicated, starting with 0, every point < duration (points
 * within 10 ms of each other, or of the end, are dropped — a 5 ms slice is
 * a click, not a slice). 'grid' needs bpm, and extends the grid backwards
 * from gridOffset so a pickup before the first beat gets slices too.
 * 'transients' needs pcm. Returns [0] when it can't slice.
 */
export function autoSlicePoints(
  mode: AutoSlice,
  src: { duration: number; bpm: number | null; gridOffset: number },
  pcm?: PcmLike,
): number[] {
  const dur = src.duration;
  if (!(dur > 0)) return [0];
  let pts: number[] = [];
  if (mode.mode === 'equal') {
    const n = Math.max(1, Math.floor(mode.count));
    for (let i = 0; i < n; i++) pts.push((i * dur) / n);
  } else if (mode.mode === 'grid') {
    const bpm = src.bpm;
    if (!bpm || !(bpm > 0) || !(mode.beats > 0)) return [0];
    const step = (60 / bpm) * mode.beats;
    const off = Number.isFinite(src.gridOffset) ? src.gridOffset : 0;
    // First grid point at or after 0, then multiply (no accumulated drift).
    const k0 = Math.ceil((0 - off) / step - 1e-9);
    for (let k = k0; ; k++) {
      const t = off + k * step;
      if (t >= dur) break;
      if (t >= 0) pts.push(t);
      if (pts.length > 100000) break; // absurd settings: don't hang
    }
  } else if (mode.mode === 'transients') {
    if (!pcm) return [0];
    pts = detectOnsets(pcm, { sensitivity: mode.sensitivity, minGap: mode.minGap });
  }
  return tidyPoints(pts, dur);
}

/** Sort, keep [0, duration − 10 ms), merge points within 10 ms, start at 0. */
function tidyPoints(pts: number[], dur: number): number[] {
  const sorted = pts.filter((t) => Number.isFinite(t) && t > 0 && t < dur - MERGE_SEC).sort((x, y) => x - y);
  const out = [0];
  for (const t of sorted) if (t - out[out.length - 1] >= MERGE_SEC) out.push(t);
  return out;
}

/* ── Extraction and export ─────────────────────────────────────────────── */

/** Always-on fade at both ends of an extracted slice (s): enough to stop a
 *  click from a cut mid-waveform, too short to hear as a fade. */
const DECLICK = 0.002;

/**
 * A copy of [start, end) seconds of pcm as two Float32Arrays (mono is
 * duplicated, channels past the second are ignored), optionally reversed,
 * with linear fades (seconds) applied after reversing — so fadeIn is always
 * at the start of what you hear — plus a 2 ms de-click at both ends (a
 * longer fade already covers it).
 */
export function extractChannels(
  pcm: PcmLike,
  start: number,
  end: number,
  opts: { reverse?: boolean; fadeIn?: number; fadeOut?: number } = {},
): [Float32Array, Float32Array] {
  const sr = pcm.sampleRate;
  const a = clampInt(Math.round(start * sr), 0, pcm.length);
  const z = clampInt(Math.round(end * sr), a, pcm.length);
  const n = z - a;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  if (n === 0 || pcm.numberOfChannels === 0) return [L, R];
  L.set(pcm.getChannelData(0).subarray(a, z));
  R.set(pcm.numberOfChannels > 1 ? pcm.getChannelData(1).subarray(a, z) : L);
  if (opts.reverse) {
    L.reverse();
    R.reverse();
  }
  const fi = Math.min(n, Math.round(Math.max(opts.fadeIn ?? 0, DECLICK) * sr));
  const fo = Math.min(n, Math.round(Math.max(opts.fadeOut ?? 0, DECLICK) * sr));
  for (let i = 0; i < fi; i++) {
    const g = i / fi;
    L[i] *= g;
    R[i] *= g;
  }
  for (let i = 0; i < fo; i++) {
    const g = i / fo;
    L[n - 1 - i] *= g;
    R[n - 1 - i] *= g;
  }
  return [L, R];
}

/**
 * RIFF/WAVE file bytes, interleaved: 16- or 24-bit PCM (format 1) or 32-bit
 * float (format 3, with the fmt extension size and fact chunk the spec asks
 * for). Samples are clipped to [−1, 1]; 16-bit gets TPDF dither (±1 LSB
 * triangular) so quiet tails fade into noise rather than distortion. 24-bit
 * is far below audibility and isn't dithered. The dither noise is seeded, so
 * the same audio always gives the same bytes.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: 16 | 24 | 32 = 16): ArrayBuffer {
  const nc = Math.max(1, channels.length);
  const frames = channels.length ? Math.min(...channels.map((c) => c.length)) : 0;
  const bytesPer = bitDepth / 8;
  const isFloat = bitDepth === 32;
  const fmtSize = isFloat ? 18 : 16;
  const dataSize = frames * nc * bytesPer;
  const factSize = isFloat ? 12 : 0;
  const total = 12 + (8 + fmtSize) + factSize + 8 + dataSize + (dataSize & 1);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  let p = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i));
  };
  const u32 = (x: number) => {
    v.setUint32(p, x, true);
    p += 4;
  };
  const u16 = (x: number) => {
    v.setUint16(p, x, true);
    p += 2;
  };
  str('RIFF');
  u32(total - 8);
  str('WAVE');
  str('fmt ');
  u32(fmtSize);
  u16(isFloat ? 3 : 1);
  u16(nc);
  u32(sampleRate);
  u32(sampleRate * nc * bytesPer);
  u16(nc * bytesPer);
  u16(bitDepth);
  if (isFloat) {
    u16(0); // cbSize
    str('fact');
    u32(4);
    u32(frames);
  }
  str('data');
  u32(dataSize);

  const chans = channels.length ? channels : [new Float32Array(0)];
  if (bitDepth === 32) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nc; c++) {
        v.setFloat32(p, clip(chans[c][i]), true);
        p += 4;
      }
  } else if (bitDepth === 24) {
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nc; c++) {
        const s = clip(chans[c][i]);
        const q = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        v.setUint8(p, q & 0xff);
        v.setUint8(p + 1, (q >> 8) & 0xff);
        v.setUint8(p + 2, (q >> 16) & 0xff);
        p += 3;
      }
  } else {
    let seed = 0x9e3779b9;
    const rand = () => {
      // xorshift32 → [0, 1)
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < nc; c++) {
        const s = clip(chans[c][i]);
        const x = (s < 0 ? s * 0x8000 : s * 0x7fff) + (rand() - rand());
        const q = Math.max(-0x8000, Math.min(0x7fff, Math.round(x)));
        v.setInt16(p, q, true);
        p += 2;
      }
  }
  return buf;
}

function clip(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x || 0; // NaN → 0
}

/** Peak absolute sample across channels (for normalising an export). */
export function peakLevel(channels: Float32Array[]): number {
  let pk = 0;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > pk) pk = a;
    }
  return pk;
}

/* ── Loop tempo ────────────────────────────────────────────────────────── */

const LOOP_BARS = [1, 2, 4, 8, 16];
const LOOP_MIN_BPM = 70;
const LOOP_MAX_BPM = 160;

/**
 * Tempo guess for a short loop of `duration` seconds when there's no
 * analysis: assume it's a whole number of 4/4 bars (1, 2, 4, 8 or 16) and
 * take the bar count whose BPM is in 70–160, or nearest to it (in octaves).
 * The range is wider than an octave, so two counts can both fit (75 and 150):
 * then the one nearer 120 wins. Rounded to 0.01. Null under 0.5 s.
 */
export function guessLoopBpm(duration: number): number | null {
  if (!(duration >= 0.5) || !Number.isFinite(duration)) return null;
  let best = 0;
  let bestScore = Infinity;
  for (const bars of LOOP_BARS) {
    const bpm = (bars * 4 * 60) / duration;
    const out =
      bpm < LOOP_MIN_BPM ? Math.log2(LOOP_MIN_BPM / bpm) : bpm > LOOP_MAX_BPM ? Math.log2(bpm / LOOP_MAX_BPM) : 0;
    // Out-of-range distance dominates; nearness to 120 breaks ties.
    const score = out * 10 + Math.abs(Math.log2(bpm / 120));
    if (score < bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return Math.round(best * 100) / 100;
}
