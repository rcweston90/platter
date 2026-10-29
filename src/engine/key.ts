import { fft } from './fft';

/**
 * Musical key, detected and shown the way DJs read it: Camelot codes (8A =
 * A minor, 8B = C major). Two tracks mix harmonically when their codes share
 * a number, or share a letter and sit one number apart.
 *
 * Detection: a pitch-class profile (chroma) of the whole track from the
 * spectral peaks of an FFT, with the bass weighted up because it names the tonic when the chords alone
 * fit two keys, correlated against the Krumhansl–Kessler major and minor key profiles in
 * all 12 rotations; the best of the 24 wins. It is the textbook method — the
 * good open-source key finders (libKeyFinder, Essentia) are GPL/AGPL, so this
 * one is written here, MIT like the rest.
 */

// Krumhansl & Kessler (1982) probe-tone profiles, tonic first.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Camelot number by tonic pitch class (C = 0).
const MAJOR_NUM = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const MINOR_NUM = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const MAJOR_NAME = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_NAME = ['Cm', 'C♯m', 'Dm', 'E♭m', 'Em', 'Fm', 'F♯m', 'Gm', 'G♯m', 'Am', 'B♭m', 'Bm'];

export interface Key {
  /** Tonic pitch class, C = 0. */
  pc: number;
  minor: boolean;
}

export function camelot(k: Key): string {
  return `${(k.minor ? MINOR_NUM : MAJOR_NUM)[k.pc]}${k.minor ? 'A' : 'B'}`;
}

export function parseCamelot(code: string): Key | null {
  const m = /^(\d{1,2})([AB])$/i.exec(code.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const minor = m[2].toUpperCase() === 'A';
  const pc = (minor ? MINOR_NUM : MAJOR_NUM).indexOf(num);
  return pc < 0 ? null : { pc, minor };
}

export function keyName(code: string): string {
  const k = parseCamelot(code);
  return k ? (k.minor ? MINOR_NAME : MAJOR_NAME)[k.pc] : '';
}

/** Parses "Am", "F#m", "Db", "C♯ minor", "Ebmaj" … as used in tags and
 *  Rekordbox's Tonality field. */
export function parseKeyName(name: string): Key | null {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(m(?:in(?:or)?)?|maj(?:or)?)?\s*$/.exec(name.replace(/\s+/g, ' ').replace(/ minor$/i, 'm'));
  if (!m) return parseCamelot(name);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const minor = !!m[3] && m[3].toLowerCase().startsWith('m') && !m[3].toLowerCase().startsWith('maj');
  return { pc: (base + acc + 12) % 12, minor };
}

/** The key `semitones` higher (negative: lower). */
export function shiftKey(code: string, semitones: number): string {
  const k = parseCamelot(code);
  if (!k) return code;
  return camelot({ pc: (((k.pc + Math.round(semitones)) % 12) + 12) % 12, minor: k.minor });
}

/** Harmonic-mixing compatibility: same key, relative major/minor, or a
 *  fifth either way (±1 on the wheel). */
export function compatible(a: string, b: string): boolean {
  const x = /^(\d+)([AB])$/.exec(a);
  const y = /^(\d+)([AB])$/.exec(b);
  if (!x || !y) return false;
  const na = Number(x[1]);
  const nb = Number(y[1]);
  if (na === nb) return true;
  const d = (((na - nb) % 12) + 12) % 12;
  return x[2] === y[2] && (d === 1 || d === 11);
}

/** Smallest shift (−6…+6 semitones) that makes `code` compatible with `target`. */
export function nearestCompatibleShift(code: string, target: string): number {
  for (const s of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) {
    if (compatible(shiftKey(code, s), target)) return s;
  }
  return 0;
}

function pearson(x: number[], y: number[]) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy || 1);
}

const FRAME = 8192; // at 11 025 Hz: 1.35 Hz bins, fine enough to separate semitones down to C2
const HOP = 4096;
const LOW_HZ = 65; // C2
const HIGH_HZ = 2100; // ~C7
const BASS_HZ = 262; // up to middle C: the bass line names the tonic
const BASS_WEIGHT = 2; // when the chords alone fit two keys (F minor vs C minor)

/** Detects the key of a decoded track. Returns a Camelot code, or null for
 *  silence or no tonal content. */
export function detectKey(buf: AudioBuffer): string | null {
  // Mono at a quarter rate: chroma lives below 2 kHz.
  const factor = Math.max(1, Math.floor(buf.sampleRate / 11025));
  const sr = buf.sampleRate / factor;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = Math.floor(buf.length / factor);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += L[i * factor + k] + R[i * factor + k];
    x[i] = s / (2 * factor);
  }

  const lo = Math.ceil((LOW_HZ * FRAME) / sr);
  const hi = Math.floor((HIGH_HZ * FRAME) / sr);
  const mags = new Float64Array(hi + 2);

  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const chroma = new Array(12).fill(0);
  const frame = new Array(12).fill(0);
  for (let start = 0; start + FRAME <= n; start += HOP) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let mean = 0;
    for (let b = lo - 1; b <= hi + 1; b++) {
      mags[b] = Math.hypot(re[b], im[b]);
      mean += mags[b];
    }
    mean /= hi - lo + 3;
    frame.fill(0);
    let total = 0;
    // Only spectral peaks above the frame's noise floor count: hats, claps
    // and kick sweeps are broadband and would otherwise flatten the profile.
    for (let b = lo; b <= hi; b++) {
      const m = mags[b];
      if (m < 2 * mean || m <= mags[b - 1] || m < mags[b + 1]) continue;
      // Parabolic interpolation puts the peak between bins.
      const a = mags[b - 1];
      const c = mags[b + 1];
      const offset = (0.5 * (a - c)) / (a - 2 * m + c || 1);
      const f = ((b + offset) * sr) / FRAME;
      const midi = 69 + 12 * Math.log2(f / 440);
      if (Math.abs(midi - Math.round(midi)) > 0.35) continue;
      const w = Math.sqrt(m) * (f < BASS_HZ ? BASS_WEIGHT : 1);
      frame[((Math.round(midi) % 12) + 12) % 12] += w;
      total += w;
    }
    // Normalise per frame so loud sections don't outvote the rest.
    if (total > 1e-6) for (let p = 0; p < 12; p++) chroma[p] += frame[p] / total;
  }
  if (chroma.every((v) => v === 0)) return null;

  let best: Key | null = null;
  let bestR = -Infinity;
  for (let pc = 0; pc < 12; pc++) {
    const rotated = chroma.map((_, i) => chroma[(i + pc) % 12]);
    const rMaj = pearson(rotated, MAJOR);
    const rMin = pearson(rotated, MINOR);
    if (rMaj > bestR) {
      bestR = rMaj;
      best = { pc, minor: false };
    }
    if (rMin > bestR) {
      bestR = rMin;
      best = { pc, minor: true };
    }
  }
  return best && bestR > 0.2 ? camelot(best) : null;
}
