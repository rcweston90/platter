import { PitchDetector } from 'pitchy';
import { fft } from '../fft';
import { detectOnsets } from '../../slicer/dsp';
import { midiOf } from './analyse';

/**
 * Beat pitch per stem: what each part of a split track plays, read from that
 * part alone, so a hat never pulls a bass note up and a pad never hides a
 * vocal.
 *
 *   · Drums: every hit, sorted into kick, snare (and claps) and hats (and
 *     cymbals) by where its new energy lands. A kick under a hat is both, so
 *     one hit can light two rows.
 *   · Bass and vocals: a pitch track every 12 ms (the McLeod pitch method,
 *     pitchy, MIT), octave slips mended, then cut into notes where the pitch
 *     moves, the sound stops or the part re-attacks. Vocals keep the track
 *     itself too, so slides and vibrato show.
 *   · Other (keys, pads, plucks, leads): several notes at once. Each frame's
 *     spectral peaks vote for the notes whose harmonics they fit (a harmonic
 *     sum, after Klapuri 2006); the strongest note is taken, its harmonics
 *     are taken out, and the next is found, up to four. Notes then run on
 *     while their pitch stays and break where the part re-attacks.
 *
 * "Other" is never stored: like the deck, it is the mix less the three
 * stems. Everything runs at half the track's rate (≈ 22 kHz), pure
 * TypeScript, in the hits worker. A six-minute track takes a few seconds.
 */

/** Bumped when the analysis changes, so cached results are thrown away. */
export const STEM_HITS_VERSION = 1;

export type DrumKind = 'kick' | 'snare' | 'hat';
export const DRUM_KINDS: DrumKind[] = ['kick', 'snare', 'hat'];

export interface DrumHit {
  t: number;
  end: number;
  kind: DrumKind;
  /** How hard, next to that kind's other hits, 0…1. */
  level: number;
}

export interface StemNote {
  t: number;
  end: number;
  /** MIDI note number, fractional (69 = A4). */
  semi: number;
  /** How loud, next to the part's other notes, 0…1. */
  level: number;
}

/** A part's pitch every `hop` seconds from `t0`; NaN where nothing is sung or played. */
export interface PitchTrack {
  t0: number;
  hop: number;
  semis: Float32Array;
}

export interface StemPart {
  notes: StemNote[];
  track: PitchTrack | null;
}

export interface StemHits {
  drums: DrumHit[];
  bass: StemPart;
  vocals: StemPart;
  /** Null when the full mix wasn't there to take the stems from. */
  other: StemPart | null;
}

export interface StemInput {
  /** The whole track, mono, at `mixRate`. */
  mix: Float32Array | null;
  mixRate: number;
  /** Drums, bass, vocals, mono 16-bit, at `stemRate` (the order separate.ts keeps). */
  stems: Int16Array[];
  stemRate: number;
}

/* ── Parts ─────────────────────────────────────────────────────────────── */

/**
 * The four parts at half rate. Stems are read at the mix's sample positions
 * the way the deck reads them (straight-line between stem samples), so
 * "other" is exactly what the deck plays when the other three are muted.
 * Halving is a [¼ ½ ¼] low-pass then every second sample.
 */
export function partsOf(inp: StemInput) {
  const base = inp.mix ? inp.mixRate : inp.stemRate;
  const ratio = inp.stemRate / base;
  const len = inp.mix ? inp.mix.length : Math.floor(inp.stems[0].length / ratio);
  const D = base >= 32000 ? 2 : 1;
  const n = Math.floor(len / D);
  const out = [0, 1, 2, 3].map(() => new Float32Array(n));
  const [drums, bass, vocals, other] = out;
  const S = inp.stems;
  const sl = S[0].length;
  const at = (s: Int16Array, i: number) => {
    const p = i * ratio;
    const j = Math.floor(p);
    if (j + 1 >= sl) return j < sl ? s[j] / 32768 : 0;
    const u = p - j;
    return (s[j] * (1 - u) + s[j + 1] * u) / 32768;
  };
  const taps = D === 2 ? [-1, 0, 1] : [0];
  const wts = D === 2 ? [0.25, 0.5, 0.25] : [1];
  for (let j = 0; j < n; j++) {
    const c = j * D;
    let d = 0;
    let b = 0;
    let v = 0;
    let o = 0;
    for (let q = 0; q < taps.length; q++) {
      const i = c + taps[q];
      if (i < 0 || i >= len) continue;
      const w = wts[q];
      const sd = at(S[0], i);
      const sb = at(S[1], i);
      const sv = at(S[2], i);
      d += w * sd;
      b += w * sb;
      v += w * sv;
      if (inp.mix) o += w * (inp.mix[i] - sd - sb - sv);
    }
    drums[j] = d;
    bass[j] = b;
    vocals[j] = v;
    other[j] = o;
  }
  return { rate: base / D, drums, bass, vocals, other: inp.mix ? other : null };
}

/* ── Shared bits ───────────────────────────────────────────────────────── */

const pcm = (x: Float32Array, sr: number) => ({ sampleRate: sr, length: x.length, numberOfChannels: 1, getChannelData: () => x });

function percentile(xs: ArrayLike<number>, p: number) {
  const a = Array.from(xs).filter(Number.isFinite).sort((m, n) => m - n);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
}

/** dB to 0…1: `range` dB under `ref` reads 0, `ref` and up reads 1. */
const levelOf = (db: number, ref: number, range: number) => Math.min(1, Math.max(0, (db - ref + range) / range));

const hannCache = new Map<number, Float64Array>();
function hann(L: number) {
  let w = hannCache.get(L);
  if (!w) {
    w = new Float64Array(L);
    for (let i = 0; i < L; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / L);
    hannCache.set(L, w);
  }
  return w;
}

/** Loudness every `hop` samples over `win` samples (dB, RMS), by running sum. */
function rmsTrack(x: Float32Array, win: number, hop: number) {
  const n = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const db = new Float32Array(n);
  const cum = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cum[i + 1] = cum[i] + x[i] * x[i];
  for (let k = 0; k < n; k++) db[k] = 10 * Math.log10(Math.max(0, cum[k * hop + win] - cum[k * hop]) / win + 1e-12);
  return db;
}

/**
 * `x` at 1/`d` of its rate: a box low-pass `d` wide twice over (nulls at each
 * multiple of the new rate, −13 dB and more above its half), then every
 * `d`th sample. Plenty for pitch, which only needs the low harmonics.
 */
function decimate(x: Float32Array, d: number) {
  if (d <= 1) return x;
  const n = Math.floor(x.length / d);
  const a = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i] - (i >= d ? x[i - d] : 0);
    a[i] = s / d;
  }
  const out = new Float32Array(n);
  s = 0;
  for (let i = 0, j = 0; i < x.length; i++) {
    s += a[i] - (i >= d ? a[i - d] : 0);
    if (i % d === d - 1 && j < n) out[j++] = s / d;
  }
  // Two boxes delay d − 1 samples, so out[j] is centred on x[j·d]: no shift.
  return out;
}

/* ── Drums ─────────────────────────────────────────────────────────────── */

/** Band edges (Hz): kick body, snare body and crack, hat sizzle. */
const KICK_HI = 150;
const HAT_LO = 5000;
/** A kick is within this of the track's loud kicks (dB). */
const KICK_FLOOR = 18;
/** A snare over a kick within this of the loud snares (dB). */
const KIND_FLOOR = 14;
/** Any drum this far under its band's loud hits (dB) is too quiet to show. */
const QUIET = 36;
/** With no split in the track to go by: how far over its usual spill a band must sit (dB). */
const SPILL_MARGIN = 6;
/** A hit with no kick or snare under it is a snare when its mid band is this near its highs (dB). */
const SNARE_OVER_HAT = -3;
/** Hats over a kick (whose highs are next to nothing) within this of the loud hats (dB). */
const HAT_OVER_KICK = 28;

export function analyseDrums(x: Float32Array, sr: number): DrumHit[] {
  return classifyDrums(drumRows(x, sr));
}

export function drumRows(x: Float32Array, sr: number) {
  const onsets = detectOnsets(pcm(x, sr), { sensitivity: 0.55, minGap: 0.03 });
  if (!onsets.length) return [];
  const N = Math.max(256, 2 ** Math.round(Math.log2((sr * 2048) / 44100)));
  const half = N >> 1;
  const binHz = sr / N;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const env = rmsTrack(x, Math.round(sr * 0.005), Math.round(sr * 0.005));
  const envHop = 0.005;

  const rows: { t: number; end: number; e: [number, number, number] }[] = [];
  for (let h = 0; h < onsets.length; h++) {
    const t = onsets[h];
    const c = Math.round(t * sr);
    const g = Math.round(0.003 * sr);
    const next = h + 1 < onsets.length ? Math.round(onsets[h + 1] * sr) : x.length;
    const L = Math.max(Math.round(0.02 * sr), Math.min(N, next - c - 2 * g));
    const w = hann(L);
    re.fill(0);
    im.fill(0);
    let ws = 0;
    for (let i = 0; i < L; i++) {
      const ia = c - g - L + i;
      const ib = c + g + i;
      re[i] = ia >= 0 ? x[ia] * w[i] : 0;
      im[i] = ib < x.length ? x[ib] * w[i] : 0;
      ws += w[i] * w[i];
    }
    fft(re, im);
    const e: [number, number, number] = [0, 0, 0];
    for (let k = 1; k < half; k++) {
      const j = N - k;
      const ar = 0.5 * (re[k] + re[j]);
      const ai = 0.5 * (im[k] - im[j]);
      const br = 0.5 * (im[k] + im[j]);
      const bi = -0.5 * (re[k] - re[j]);
      const d = (br * br + bi * bi - ar * ar - ai * ai) / ws;
      if (d <= 0) continue;
      const f = k * binHz;
      if (f < 30) continue;
      e[f < KICK_HI ? 0 : f < HAT_LO ? 1 : 2] += d;
    }
    // How long it rings: until 20 dB under its peak, or the next hit.
    const k0 = Math.floor(t / envHop);
    let peak = -Infinity;
    let kp = k0;
    for (let k = k0; k < Math.min(env.length, k0 + 8); k++) if (env[k] > peak) ((peak = env[k]), (kp = k));
    let k = kp;
    const kEnd = Math.min(env.length, Math.ceil(next / sr / envHop), k0 + Math.round(0.8 / envHop));
    while (k < kEnd && env[k] > peak - 20) k++;
    rows.push({ t, end: Math.max(t + 0.03, Math.min(next / sr, k * envHop)), e });
  }
  return rows;
}

/** Each hit's band levels next to that band's loud hits (dB), for tests. */
export function drumLevels(rows: { e: [number, number, number] }[]) {
  const refs = [0, 1, 2].map((b) => 10 * Math.log10(percentile(rows.map((r) => r.e[b]).filter((v) => v > 0), 0.9) + 1e-20));
  return { refs, n: rows.map((r) => r.e.map((v, b) => 10 * Math.log10(v + 1e-20) - refs[b])) };
}

/**
 * Where a spread of band differences splits in two (dB): the middle of the
 * widest gap with at least `minFrac` of them either side, or null when it
 * doesn't split. Hits with a second drum under them sit apart from hits
 * without, by however much that drum adds.
 */
function gapSplit(vals: number[], minGap = 2.5, minFrac = 0.08): number | null {
  const v = vals.filter(Number.isFinite).sort((m, n) => m - n);
  const lo = Math.max(1, Math.ceil(v.length * minFrac));
  let best = minGap;
  let at: number | null = null;
  for (let i = lo; i <= v.length - lo; i++) {
    const g = v[i] - v[i - 1];
    if (g > best) {
      best = g;
      at = (v[i] + v[i - 1]) / 2;
    }
  }
  return at;
}

/**
 * Which drums each hit holds. Each band is read next to that band's loud
 * hits, and a band a louder drum spills into (a kick's sweep into the
 * snare's band, a snare's noise into the hats') counts only when it sits
 * clearly above that spill: where the track's own hits split into "with"
 * and "without", or failing a split, by a margin.
 */
function classifyDrums(rows: { t: number; end: number; e: [number, number, number] }[]): DrumHit[] {
  const { n } = drumLevels(rows);
  const kick = n.map(([nl]) => nl > -KICK_FLOOR);
  const ks = n.filter((_, i) => kick[i]).map(([nl, nm]) => nm - nl);
  const tKS = gapSplit(ks) ?? (ks.length ? median(ks) + SPILL_MARGIN : 0);
  const free = n.filter((_, i) => !kick[i]).map(([, nm, nh]) => nm - nh);
  const tS = gapSplit(free) ?? SNARE_OVER_HAT;
  const snare = n.map(([nl, nm, nh], i) => (kick[i] ? nm - nl >= tKS && nm > -KIND_FLOOR : nm - nh >= tS && nm > -QUIET) && nm > -QUIET);
  const sh = n.filter((_, i) => snare[i]).map(([, nm, nh]) => nh - nm);
  const tSH = gapSplit(sh) ?? (sh.length ? median(sh) + SPILL_MARGIN : 0);
  const out: DrumHit[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const [nl, nm, nh] = n[i];
    const hat = nh > -QUIET && (snare[i] ? nh - nm >= tSH : kick[i] ? nh > -HAT_OVER_KICK : true);
    const kinds: [DrumKind, number][] = [];
    if (kick[i]) kinds.push(['kick', nl]);
    if (snare[i]) kinds.push(['snare', nm]);
    if (hat) kinds.push(['hat', nh]);
    if (!kinds.length) {
      const b = [nl, nm, nh].indexOf(Math.max(nl, nm, nh));
      kinds.push([DRUM_KINDS[b], [nl, nm, nh][b]]);
    }
    for (const [kind, lv] of kinds) out.push({ t: r.t, end: r.end, kind, level: levelOf(lv, 0, 30) });
  }
  return out;
}

/* ── One voice at a time: bass and vocals ──────────────────────────────── */

interface MonoOpts {
  /** Lowest and highest note the part can play (Hz). */
  fmin: number;
  fmax: number;
  /** Window (s): two periods of `fmin` at least. */
  win: number;
  /** Clarity (0…1) a frame needs to count as a note. */
  clarity: number;
  /** Shortest note kept (s). */
  minDur: number;
  /** Semitones the pitch may wander inside one note before it's a new one. */
  split: number;
  keepTrack: boolean;
  /** Pitch is read at this rate or above (Hz): fast, and four times `fmax` is plenty. */
  rate: number;
}

const BASS: MonoOpts = { fmin: 28, fmax: 420, win: 0.07, clarity: 0.8, minDur: 0.04, split: 0.7, keepTrack: false, rate: 5000 };
const VOCALS: MonoOpts = { fmin: 70, fmax: 1200, win: 0.046, clarity: 0.82, minDur: 0.06, split: 1.2, keepTrack: true, rate: 10000 };
const HOP = 0.0116;
/** Frames this far under the part's loud frames (dB) are silence. */
const GATE = 38;

function median(a: number[]) {
  const s = a.slice().sort((m, n) => m - n);
  return s.length ? s[s.length >> 1] : NaN;
}

export function analyseMono(full: Float32Array, fullRate: number, o: MonoOpts): StemPart {
  const d = Math.max(1, Math.floor(fullRate / o.rate));
  const x = decimate(full, d);
  const sr = fullRate / d;
  const W = Math.round(o.win * sr);
  const H = Math.max(1, Math.round(HOP * sr));
  const n = Math.max(0, Math.floor((x.length - W) / H) + 1);
  const hop = H / sr;
  const t0 = W / 2 / sr;
  const semis = new Float32Array(n).fill(NaN);
  if (!n) return { notes: [], track: o.keepTrack ? { t0, hop, semis } : null };
  const db = rmsTrack(x, W, H);
  const ref = percentile(db, 0.95);
  const gate = Math.max(-70, ref - GATE);
  const det = PitchDetector.forFloat32Array(W);
  det.minVolumeAbsolute = 1e-5;
  det.clarityThreshold = 0.6;
  for (let k = 0; k < n; k++) {
    if (db[k] < gate) continue;
    const [f0, cl] = det.findPitch(x.subarray(k * H, k * H + W), sr);
    if (cl >= o.clarity && f0 >= o.fmin && f0 <= o.fmax) semis[k] = midiOf(f0);
  }
  // Mend octave slips: a frame an octave off its neighbours' median comes back.
  const fixed = semis.slice();
  for (let k = 0; k < n; k++) {
    if (Number.isNaN(semis[k])) continue;
    const near: number[] = [];
    for (let j = Math.max(0, k - 4); j <= Math.min(n - 1, k + 4); j++) if (j !== k && !Number.isNaN(semis[j])) near.push(semis[j]);
    if (!near.length) {
      fixed[k] = NaN; // a lone voiced frame is noise
      continue;
    }
    const m = median(near);
    const d = semis[k] - m;
    if (Math.abs(Math.abs(d) - 12) < 1) fixed[k] = semis[k] - 12 * Math.sign(d);
    else if (Math.abs(Math.abs(d) - 19) < 1 || Math.abs(Math.abs(d) - 24) < 1) fixed[k] = NaN;
  }
  const onsets = detectOnsets(pcm(full, fullRate), { sensitivity: 0.45, minGap: 0.05 });
  const notes = segment(fixed, db, onsets, { t0, hop }, o);
  return { notes, track: o.keepTrack ? { t0, hop, semis: fixed } : null };
}

function segment(semis: Float32Array, db: Float32Array, onsets: number[], tk: { t0: number; hop: number }, o: MonoOpts): StemNote[] {
  const { t0, hop } = tk;
  const notes: { t: number; end: number; semi: number; db: number }[] = [];
  let cur: number[] = [];
  let curDb = -Infinity;
  let start = -1;
  let gap = 0;
  let away = 0;
  let oi = 0;
  const close = (k: number) => {
    if (cur.length && start >= 0) {
      const t = t0 + start * hop - hop / 2;
      const end = t0 + k * hop + hop / 2;
      // The middle of the note names it: a slide in or out doesn't.
      const a = Math.floor(cur.length * 0.2);
      const b = Math.max(a + 1, Math.ceil(cur.length * 0.8));
      if (end - t >= o.minDur) notes.push({ t, end, semi: median(cur.slice(a, b)), db: curDb });
    }
    cur = [];
    curDb = -Infinity;
    start = -1;
    away = 0;
  };
  let last = -1;
  for (let k = 0; k < semis.length; k++) {
    const s = semis[k];
    const time = t0 + k * hop;
    // A re-attack between the last frame and this one.
    let hitHere = false;
    while (oi < onsets.length && onsets[oi] <= time) {
      if (onsets[oi] > time - hop) hitHere = true;
      oi++;
    }
    if (Number.isNaN(s)) {
      if (cur.length && ++gap > 2) close(last);
      continue;
    }
    gap = 0;
    if (cur.length) {
      const ref = median(cur.slice(-6));
      if (Math.abs(s - ref) > o.split) away++;
      else away = 0;
      const elapsed = (k - start) * hop;
      if ((hitHere && elapsed >= o.minDur) || away >= 3) {
        const back = away >= 3 ? 3 : 0;
        const keep = cur.slice(-back || cur.length);
        if (back) cur = cur.slice(0, -back);
        close(last - back);
        if (back) {
          start = k - back;
          cur = keep;
        }
      }
    }
    if (!cur.length) start = k;
    cur.push(s);
    curDb = Math.max(curDb, db[k]);
    last = k;
  }
  if (cur.length) close(last);
  // Starts onto the hit that began them, when one is close.
  let j = 0;
  for (const nt of notes) {
    while (j < onsets.length && onsets[j] < nt.t - 0.06) j++;
    if (j < onsets.length && Math.abs(onsets[j] - nt.t) <= 0.06) nt.t = onsets[j];
  }
  const ref = percentile(notes.map((nt) => nt.db), 0.9);
  return notes.map((nt) => ({ t: nt.t, end: Math.max(nt.t + 0.03, nt.end), semi: nt.semi, level: levelOf(nt.db, ref, 30) }));
}

/* ── Several voices at once: other ─────────────────────────────────────── */

const POLY_VOICES = 4;
const POLY_LO = 36; // C2
const POLY_HI = 96; // C7
const POLY_HARMONICS = 10;
/** Candidate notes per semitone. */
const POLY_RES = 4;
/** A note struck again jumps at least this much in strength. */
const REATTACK = 1.25;

interface Peak {
  f: number;
  a: number;
}

export function analysePoly(full: Float32Array, fullRate: number): StemPart {
  // Peaks up to 5 kHz are all the voting needs: half rate is enough.
  const dec = Math.max(1, Math.floor(fullRate / 11000));
  const x = decimate(full, dec);
  const sr = fullRate / dec;
  const N = Math.max(512, 2 ** Math.round(Math.log2((sr * 4096) / 44100)));
  const Z = N * 2; // zero-padded, for finer peak positions
  const half = Z >> 1;
  const binHz = sr / Z;
  const H = Math.round(HOP * 2 * sr);
  const hop = H / sr;
  const n = Math.max(0, Math.floor((x.length - N) / H) + 1);
  const t0 = N / 2 / sr;
  const re = new Float64Array(Z);
  const im = new Float64Array(Z);
  const w = hann(N);
  const mag = new Float64Array(half);
  const nc = (POLY_HI - POLY_LO) * POLY_RES + 1;
  const sal = new Float64Array(nc);
  const db = rmsTrack(x, N, H);
  const gate = Math.max(-70, percentile(db, 0.95) - GATE);
  const frames: { semi: number; s: number }[][] = [];
  const allSal: number[] = [];

  for (let k = 0; k < n; k++) {
    const found: { semi: number; s: number }[] = [];
    frames.push(found);
    if (db[k] < gate) continue;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[k * H + i] * w[i];
    fft(re, im);
    let top = 0;
    for (let b = 1; b < half; b++) {
      mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      if (mag[b] > top) top = mag[b];
    }
    if (!(top > 0)) continue;
    // Peaks: local maxima over the whitened floor, positions by parabola.
    const peaks: Peak[] = [];
    const fLo = 0.9 * 440 * 2 ** ((POLY_LO - 69) / 12);
    for (let b = Math.max(2, Math.floor(fLo / binHz)); b < half - 1 && b * binHz < Math.min(8000, sr * 0.45); b++) {
      const m = mag[b];
      if (m < top * 0.02 || m < mag[b - 1] || m <= mag[b + 1]) continue;
      const a = Math.log(mag[b - 1] + 1e-12);
      const c = Math.log(mag[b + 1] + 1e-12);
      const lm = Math.log(m);
      const d = a - 2 * lm + c;
      const off = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      peaks.push({ f: (b + off) * binHz, a: Math.sqrt(m / top) });
    }
    if (!peaks.length) continue;
    let first = 0;
    for (let v = 0; v < POLY_VOICES; v++) {
      sal.fill(0);
      const fund = new Float64Array(nc);
      for (const p of peaks) {
        if (p.a <= 0) continue;
        for (let h = 1; h <= POLY_HARMONICS; h++) {
          const m = midiOf(p.f / h);
          const ci = Math.round((m - POLY_LO) * POLY_RES);
          if (ci < -1 || ci > nc) continue;
          const g = p.a * (1 / (0.6 + 0.4 * h));
          for (let dc = -1; dc <= 1; dc++) {
            const j = ci + dc;
            if (j < 0 || j >= nc) continue;
            const wt = dc === 0 ? 1 : 0.5;
            sal[j] += g * wt;
            if (h === 1) fund[j] = Math.max(fund[j], p.a * wt);
          }
        }
      }
      let best = -1;
      let bs = 0;
      for (let j = 0; j < nc; j++) {
        // A note needs its own fundamental: otherwise its octave below wins on the even harmonics.
        if (fund[j] < 0.12) continue;
        if (sal[j] > bs) {
          bs = sal[j];
          best = j;
        }
      }
      if (best < 0) break;
      if (v === 0) first = bs;
      else if (bs < first * 0.3) break;
      const semi = POLY_LO + best / POLY_RES;
      // Exact pitch from its fundamental's peak.
      const f0 = 440 * 2 ** ((semi - 69) / 12);
      let fine = semi;
      let near = Infinity;
      for (const p of peaks) {
        const d = Math.abs(midiOf(p.f) - semi);
        if (d < 0.5 && d < near) {
          near = d;
          fine = midiOf(p.f);
        }
      }
      found.push({ semi: fine, s: bs });
      allSal.push(bs);
      // Take its harmonics out: the fundamental wholly, the rest by half
      // (another note may share them: C's third harmonic is G's second).
      for (const p of peaks) {
        const r = p.f / f0;
        const hn = Math.round(r);
        if (hn >= 1 && hn <= POLY_HARMONICS && Math.abs(r - hn) < 0.03 * hn + 0.02) p.a *= hn === 1 ? 0 : 0.5;
      }
    }
  }

  // Notes: a pitch held from frame to frame, broken where the part re-attacks.
  const onsets = detectOnsets(pcm(full, fullRate), { sensitivity: 0.5, minGap: 0.05 });
  const sref = percentile(allSal, 0.9) || 1;
  const open = new Map<number, { start: number; last: number; semis: number[]; s: number; recent: number[]; miss: number }>();
  const out: StemNote[] = [];
  const emit = (key: number) => {
    const nt = open.get(key)!;
    open.delete(key);
    const t = t0 + nt.start * hop - hop / 2;
    const end = t0 + nt.last * hop + hop / 2;
    if (end - t < 0.05) return;
    out.push({ t, end, semi: nt.semis.reduce((a, b) => a + b, 0) / nt.semis.length, level: levelOf(20 * Math.log10(nt.s / sref + 1e-9), 0, 24) });
  };
  let oi = 0;
  let hitBefore = false;
  for (let k = 0; k < frames.length; k++) {
    const time = t0 + k * hop;
    let hitNow = false;
    while (oi < onsets.length && onsets[oi] <= time) {
      if (onsets[oi] > time - hop) hitNow = true;
      oi++;
    }
    // A frame straddling the attack may not have risen yet: the next one counts too.
    const hit = hitNow || hitBefore;
    hitBefore = hitNow;
    const seen = new Set<number>();
    for (const f of frames[k]) {
      const key = Math.round(f.semi);
      if (seen.has(key)) continue;
      seen.add(key);
      const nt = open.get(key);
      // A hit breaks only the notes it struck again (they jump in level),
      // not a chord ringing on under a new pluck.
      if (nt && hit && (k - nt.start) * hop >= 0.05 && f.s > Math.min(...nt.recent) * REATTACK) emit(key);
      const cur = open.get(key);
      if (cur) {
        cur.last = k;
        cur.miss = 0;
        cur.semis.push(f.semi);
        cur.s = Math.max(cur.s, f.s);
        cur.recent.push(f.s);
        if (cur.recent.length > 3) cur.recent.shift();
      } else open.set(key, { start: k, last: k, semis: [f.semi], s: f.s, recent: [f.s], miss: 0 });
    }
    for (const [key, nt] of open) {
      if (seen.has(key)) continue;
      if (++nt.miss > 1) emit(key);
    }
  }
  for (const key of [...open.keys()]) emit(key);
  out.sort((a, b) => a.t - b.t || a.semi - b.semi);
  // Starts onto the hit that began them.
  let j = 0;
  for (const nt of out) {
    while (j < onsets.length && onsets[j] < nt.t - 0.07) j++;
    for (let q = j; q < onsets.length && onsets[q] <= nt.t + 0.07; q++) {
      if (Math.abs(onsets[q] - nt.t) <= 0.07) {
        nt.t = onsets[q];
        break;
      }
    }
  }
  // Two pieces of one note snapped onto the same hit: one note.
  const last = new Map<number, StemNote>();
  const kept: StemNote[] = [];
  for (const nt of out) {
    const key = Math.round(nt.semi);
    const prev = last.get(key);
    if (prev && nt.t - prev.t < 0.06) {
      prev.end = Math.max(prev.end, nt.end);
      prev.level = Math.max(prev.level, nt.level);
      continue;
    }
    last.set(key, nt);
    kept.push(nt);
  }
  return { notes: kept, track: null };
}

/* ── All four ──────────────────────────────────────────────────────────── */

export function analyseStems(inp: StemInput): StemHits {
  const p = partsOf(inp);
  return {
    drums: analyseDrums(p.drums, p.rate),
    bass: analyseMono(p.bass, p.rate, BASS),
    vocals: analyseMono(p.vocals, p.rate, VOCALS),
    other: p.other ? analysePoly(p.other, p.rate) : null,
  };
}
