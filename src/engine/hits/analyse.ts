import { PitchDetector } from 'pitchy';
import { fft } from '../fft';
import { detectOnsets } from '../../slicer/dsp';

/**
 * Beat pitch: every hit in a track, and how high or low it sounds.
 *
 * 1. Hits are the slicer's transients (detectOnsets: SuperFlux-style spectral
 *    flux, adaptive threshold, each moved back to its attack), at the
 *    sensitivity that finds every drum hit.
 * 2. Each hit is heard as what it adds: the power spectrum just after the
 *    attack minus the one just before it, rises only. A hat over a held bass
 *    note is the hat, not the bass.
 * 3. A hit that starts a clear note (an 808, a pluck, a stab, a tuned kick)
 *    is placed at that note: a harmonic sum over what it added picks the
 *    note, and the McLeod pitch method (pitchy, MIT) sharpens it when the two
 *    agree. It counts as a note only when most of the added energy sits on
 *    that note's harmonics.
 * 4. Any other hit (a snare, a hat, a clap) is placed at the centre of what
 *    it added, on a log-frequency scale: a kick reads low, a snare in the
 *    middle, a hat high, and a brighter hat higher than a duller one.
 *
 * Pure TypeScript over a mono Float32Array, so it runs in a worker and in
 * Node alike. A six-minute track takes about a second.
 */

export interface BeatHit {
  /** Start of the hit's attack, track seconds. */
  t: number;
  /** Where the hit stops counting: the next hit, at most HOLD seconds on. */
  end: number;
  /** Frequency it is drawn at: the note's f0 when tonal, else the centre of
   *  the sound it added (Hz). */
  hz: number;
  /** The same as a MIDI note number, fractional (69 = A4 = 440 Hz). */
  semi: number;
  /** True when the hit starts a clear note at `hz`. */
  tonal: boolean;
  /** How hard it hits next to the track's other hits, 0…1. */
  level: number;
}

/** Bumped when the analysis changes, so cached results are thrown away. */
export const HITS_VERSION = 1;

/** Longest a hit is drawn for when nothing follows it (s). */
const HOLD = 0.5;
/** Gap either side of the attack that neither window reads (s). */
const GUARD = 0.004;
/** How far into a hit its note is read (s), when the hit is long enough. */
const SETTLE = 0.03;
/** Shortest analysis window (s): hits closer than this share a window. */
const MIN_WIN = 0.03;
/** Frequencies a hit's centre is taken over. */
const LO_HZ = 30;
const HI_HZ = 12000;
/** Notes a hit can be tuned to: C1 (32.7 Hz) to C7. */
const F0_LO_MIDI = 24;
const F0_HI_MIDI = 96;
const F0_MAX = 2100;
/** Harmonics summed per candidate note. */
const HARMONICS = 8;
/** Share of the hit's new energy on one note's harmonics for it to be that
 *  note, when the time-domain pitch agrees; and with no agreement. Noise
 *  lands about a quarter of its energy on any note's harmonics. */
const HARMONICITY = 0.55;
const HARMONICITY_ALONE = 0.75;
/** Hits this far under the track's loud hits (dB) read as level 0. */
const LEVEL_RANGE = 30;

export function midiOf(hz: number) {
  return 69 + 12 * Math.log2(hz / 440);
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "A1", "C#3": the nearest note to a MIDI number. */
export function noteName(semi: number) {
  const n = Math.round(semi);
  return `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** "55 Hz", "2.4 kHz". */
export function formatHz(hz: number) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

/**
 * A note's f0 from its harmonics' peaks: each peak's centre by a parabola
 * through log power, divided by its harmonic number, averaged with weight
 * h · amplitude (a high harmonic pins f0 h times finer than the bins can).
 */
function sharpen(p: Float64Array, f: number, binHz: number): number {
  let sw = 0;
  let sf = 0;
  for (let h = 1; h <= HARMONICS && h * f < HI_HZ; h++) {
    let i = Math.round((h * f) / binHz);
    for (const j of [i - 1, i + 1]) if (j > 0 && j < p.length - 1 && p[j] > p[i]) i = j;
    if (i < 1 || i >= p.length - 1 || !(p[i] > 0)) continue;
    const a = Math.log(p[i - 1] + 1e-30);
    const b = Math.log(p[i]);
    const c = Math.log(p[i + 1] + 1e-30);
    const d = a - 2 * b + c;
    const k = d < 0 ? i + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : i;
    const est = (k * binHz) / h;
    // A peak that isn't this harmonic (more than a third of a semitone out).
    if (Math.abs(12 * Math.log2(est / f)) > 0.6) continue;
    const w = h * Math.sqrt(p[i]);
    sw += w;
    sf += w * est;
  }
  return sw > 0 ? sf / sw : f;
}

export function analyseHits(mono: Float32Array, sampleRate: number): BeatHit[] {
  const sr = sampleRate;
  const len = mono.length;
  const onsets = detectOnsets(
    { sampleRate: sr, length: len, numberOfChannels: 1, getChannelData: () => mono },
    // 0.5: every drum hit, not a pad's slow beating (see deltaFor). 40 ms
    // apart at most 1/32 notes at 190 BPM, flams merged.
    { sensitivity: 0.5, minGap: 0.04 },
  );
  if (!onsets.length) return [];

  // ~93 ms at any rate: 2048 at 22.05 kHz, 4096 at 44.1/48 kHz. Ten cycles of
  // a 100 Hz kick, and bins under 12 Hz apart, so the note check can tell a
  // 50 Hz kick from a 60 Hz one.
  const N = Math.max(512, 2 ** Math.round(Math.log2((sr * 4096) / 44100)));
  const half = N >> 1;
  const binHz = sr / N;
  const kLo = Math.max(1, Math.floor(LO_HZ / binHz));
  const kHi = Math.min(half - 1, Math.ceil(HI_HZ / binHz));
  const logF = new Float64Array(half);
  for (let k = 1; k < half; k++) logF[k] = Math.log2(k * binHz);

  // Hann windows, one per length in use, cached.
  const wins = new Map<number, Float64Array>();
  const hann = (L: number) => {
    let w = wins.get(L);
    if (!w) {
      w = new Float64Array(L);
      for (let i = 0; i < L; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / L);
      wins.set(L, w);
    }
    return w;
  };
  const detectors = new Map<number, PitchDetector<Float32Array>>();
  const detector = (L: number) => {
    let d = detectors.get(L);
    if (!d) {
      d = PitchDetector.forFloat32Array(L);
      d.minVolumeAbsolute = 1e-4;
      d.clarityThreshold = 0.5;
      detectors.set(L, d);
    }
    return d;
  };

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const pre = new Float64Array(half);
  const post = new Float64Array(half);
  const diff = new Float64Array(half);

  /** Power spectra of two spans of `L` samples, Hann-windowed and normalised
   *  so a window's length doesn't change the level: one complex FFT for both
   *  (z = a + i·b → A = (Z[k] + conj Z[N−k]) / 2, B = (Z[k] − conj Z[N−k]) / 2i). */
  const spectra = (a0: number, b0: number, L: number) => {
    const w = hann(L);
    re.fill(0);
    im.fill(0);
    let ws = 0;
    for (let i = 0; i < L; i++) {
      const ia = a0 + i;
      const ib = b0 + i;
      re[i] = ia >= 0 && ia < len ? mono[ia] * w[i] : 0;
      im[i] = ib >= 0 && ib < len ? mono[ib] * w[i] : 0;
      ws += w[i] * w[i];
    }
    fft(re, im);
    const g = 1 / (ws || 1);
    for (let k = 0; k < half; k++) {
      const j = (N - k) & (N - 1);
      const ar = 0.5 * (re[k] + re[j]);
      const ai = 0.5 * (im[k] - im[j]);
      const br = 0.5 * (im[k] + im[j]);
      const bi = -0.5 * (re[k] - re[j]);
      pre[k] = (ar * ar + ai * ai) * g;
      post[k] = (br * br + bi * bi) * g;
    }
  };

  const span = new Float32Array(N);
  const out: (BeatHit & { db: number })[] = [];
  for (let h = 0; h < onsets.length; h++) {
    const t = onsets[h];
    const c = Math.round(t * sr);
    const g = Math.round(GUARD * sr);
    const next = h + 1 < onsets.length ? Math.round(onsets[h + 1] * sr) : len;
    // Windows as long as the hit lets them be, the same length either side so
    // the two levels compare.
    const room = next - c - 2 * g;
    const L = Math.max(Math.round(MIN_WIN * sr), Math.min(N, room));
    spectra(c - g - L, c + g, L);

    let total = 0;
    let wSum = 0;
    let wLog = 0;
    for (let k = 1; k < half; k++) {
      const d = post[k] - pre[k];
      diff[k] = d > 0 ? d : 0;
      total += diff[k];
      if (k >= kLo && k <= kHi && diff[k] > 0) {
        // Magnitude, not power: weighting by power would let the bass under
        // every hit decide where a snare sits.
        const m = Math.sqrt(diff[k]);
        wSum += m;
        wLog += m * logF[k];
      }
    }
    if (!(total > 0) || !(wSum > 0)) continue;
    let hz = 2 ** (wLog / wSum);
    let tonal = false;

    // A note? Harmonic sum over what the hit added (Hermes' subharmonic
    // summation): the note whose harmonics hold the most new energy. Read on
    // the rises only, so a kick's tail under a pluck doesn't pull the pluck
    // an octave down.
    // Magnitude at a frequency between bins, read off the line between them:
    // a max over the neighbours makes every candidate within a bin tie, and
    // down low a bin is a semitone wide.
    const amp = (f: number) => {
      const k = f / binHz;
      const i = Math.floor(k);
      if (i < 1 || i >= half - 1) return 0;
      const u = k - i;
      return Math.sqrt(diff[i]) * (1 - u) + Math.sqrt(diff[i + 1]) * u;
    };
    let bestF = 0;
    let bestS = 0;
    let peakA = 0;
    for (let k = kLo; k <= Math.min(kHi, Math.ceil(F0_MAX / binHz)); k++) peakA = Math.max(peakA, Math.sqrt(diff[k]));
    for (let m = F0_LO_MIDI; m <= F0_HI_MIDI; m += 0.25) {
      const f = 440 * 2 ** ((m - 69) / 12);
      const a1 = amp(f);
      // The fundamental has to be there: a missing one makes every
      // subharmonic look as good.
      if (a1 < 0.2 * peakA) continue;
      let sc = 0;
      let wt = 1;
      for (let hn = 1; hn <= HARMONICS && hn * f < HI_HZ; hn++, wt *= 0.84) sc += wt * amp(hn * f);
      if (sc > bestS) {
        bestS = sc;
        bestF = f;
      }
    }
    if (bestF) {
      // How much of what the hit added sits on that note's harmonics.
      let on = 0;
      let all = 0;
      const top = Math.min(HI_HZ, (HARMONICS + 0.5) * bestF);
      for (let k = Math.max(1, Math.floor((0.9 * bestF) / binHz)); k <= Math.min(half - 1, Math.ceil(top / binHz)); k++) {
        all += diff[k];
        const r = (k * binHz) / bestF;
        const hn = Math.round(r);
        if (hn >= 1 && hn <= HARMONICS && Math.abs(r - hn) <= Math.max(0.035 * hn, (1.5 * binHz) / bestF)) on += diff[k];
      }
      const harmonicity = all > 0 ? on / all : 0;
      // McLeod in the time domain after the attack, the longest power of two
      // that fits before the next hit: sharper than the bins when it agrees.
      // It starts a little after the attack, where a kick has settled on its
      // note and a pluck's pick noise has died away.
      const settle = Math.round(Math.min(SETTLE * sr, room / 4));
      const pl = 2 ** Math.floor(Math.log2(Math.max(256, Math.min(N, room - settle))));
      for (let i = 0; i < pl; i++) {
        const j = c + g + settle + i;
        span[i] = j < len ? mono[j] : 0;
      }
      const [f0, clarity] = detector(pl).findPitch(span.subarray(0, pl), sr);
      const agrees = clarity >= 0.6 && f0 > 0 && Math.abs(midiOf(f0) - midiOf(bestF)) < 1;
      if (harmonicity >= HARMONICITY && (agrees || harmonicity >= HARMONICITY_ALONE)) {
        tonal = true;
        // Without McLeod's word, from where its harmonics actually peak.
        hz = agrees ? f0 : sharpen(diff, bestF, binHz);
      }
    }
    out.push({ t, end: Math.min(next / sr, t + HOLD), hz, semi: midiOf(hz), tonal, level: 0, db: 10 * Math.log10(total) });
  }
  if (!out.length) return [];

  // Level against the track's loud hits (95th percentile), so one huge hit
  // doesn't flatten the rest.
  const dbs = out.map((o) => o.db).sort((a, b) => a - b);
  const ref = dbs[Math.min(dbs.length - 1, Math.floor(dbs.length * 0.95))];
  return out.map(({ db, ...hit }) => ({ ...hit, level: Math.min(1, Math.max(0, (db - ref + LEVEL_RANGE) / LEVEL_RANGE)) }));
}
