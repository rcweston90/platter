import type { WavePeaks } from './types';

/**
 * Phrases: the 8/16/32-bar sections a dance track is built from — intro,
 * verse, build, drop, breakdown, outro — read off the waveform's band
 * envelopes and the beat grid. A heuristic, not a transcription: it finds
 * where the energy changes on 8-bar lines and names each section by how it
 * sits against the rest of the track. It needs no audio, only the peaks the
 * waveform already has, so a five-minute track takes a millisecond or two.
 */

export type PhraseKind = 'intro' | 'verse' | 'build' | 'drop' | 'break' | 'outro';

export interface Phrase {
  /** Seconds into the track (clamped to the track). */
  start: number;
  end: number;
  /** Length in bars. */
  bars: number;
  kind: PhraseKind;
}

/** Phrases as saved with a track: valid for the tempo and grid they were read with. */
export interface PhraseCache {
  v: number;
  bpm: number;
  gridOffset: number;
  list: Phrase[];
}

/** Bumped when the heuristic changes, so saved phrases are read again. */
export const PHRASE_VERSION = 1;

export const PHRASE_LABEL: Record<PhraseKind, string> = {
  intro: 'Intro',
  verse: 'Verse',
  build: 'Build',
  drop: 'Drop',
  break: 'Break',
  outro: 'Outro',
};

/** Bars per block: phrase edges fall on these lines. */
const BLOCK = 8;
/** Longest phrase before it's split: 32 bars. */
const MAX_BLOCKS = 4;

/** The cached phrases when they were read with this tempo and grid, else null. */
export function cachedPhrases(cache: PhraseCache | null | undefined, bpm: number | null, gridOffset: number): Phrase[] | null {
  if (!cache || !bpm || cache.v !== PHRASE_VERSION) return null;
  return Math.abs(cache.bpm - bpm) < 1e-6 && Math.abs(cache.gridOffset - gridOffset) < 1e-6 ? cache.list : null;
}

export function phraseCache(peaks: WavePeaks, bpm: number, gridOffset: number, duration: number): PhraseCache {
  return { v: PHRASE_VERSION, bpm, gridOffset, list: detectPhrases(peaks, bpm, gridOffset, duration) };
}

/** The phrase playing at `t`, if any. */
export function phraseAt(list: readonly Phrase[] | null | undefined, t: number): Phrase | null {
  if (!list) return null;
  for (const p of list) if (t >= p.start && t < p.end) return p;
  return null;
}

/**
 * Splits the track into phrases. Bars come from the grid (gridOffset is a
 * bar's "one"); phrase edges sit on 8-bar lines, counted from whichever of
 * the eight possible starting bars puts the most change in level on the
 * lines. Each 8-bar block is named by its level against the rest of the
 * track, then neighbours with the same name join, up to 32 bars.
 */
export function detectPhrases(peaks: WavePeaks, bpm: number, gridOffset: number, duration: number): Phrase[] {
  if (!(bpm > 0) || !(duration > 0)) return [];
  const bar = 240 / bpm;
  const first = Math.floor(-gridOffset / bar + 1e-6); // the bar the track starts in
  // One past the last bar; a sliver of a bar at the very end doesn't count.
  const last = Math.ceil((duration - gridOffset) / bar - 0.05);
  const nBars = last - first;
  if (nBars < BLOCK) return [];
  const barStart = (b: number) => gridOffset + (first + b) * bar;

  // Per bar: the mean of each band's envelope, each band scaled to its
  // loudest bar. Lows are the kick and bass; mids and highs are what a drop
  // adds on top (leads, claps, open hats), so they weigh most in its level.
  const lo = new Float32Array(nBars);
  const mid = new Float32Array(nBars);
  const hi = new Float32Array(nBars);
  const n = Math.min(peaks.low.length, peaks.mid.length, peaks.high.length);
  for (let b = 0; b < nBars; b++) {
    const i0 = Math.max(0, Math.floor(Math.max(0, barStart(b)) * peaks.rate));
    const i1 = Math.min(n, Math.ceil(Math.min(duration, barStart(b + 1)) * peaks.rate));
    let l = 0;
    let m = 0;
    let h = 0;
    for (let i = i0; i < i1; i++) {
      l += peaks.low[i];
      m += peaks.mid[i];
      h += peaks.high[i];
    }
    const k = Math.max(1, i1 - i0);
    lo[b] = l / k;
    mid[b] = m / k;
    hi[b] = h / k;
  }
  for (const a of [lo, mid, hi]) {
    // A part bar at either end reads quiet: give it its neighbour's level.
    if (Math.min(duration, barStart(1)) - Math.max(0, barStart(0)) < bar * 0.5) a[0] = a[1];
    if (Math.min(duration, barStart(nBars)) - barStart(nBars - 1) < bar * 0.5) a[nBars - 1] = a[nBars - 2];
    let top = 0;
    for (const v of a) if (v > top) top = v;
    if (top > 0) for (let i = 0; i < a.length; i++) a[i] /= top;
  }
  const level = (b: number) => 0.25 * lo[b] + 0.3 * mid[b] + 0.45 * hi[b];

  // Which bar (mod 8) the phrases start on: the one whose lines carry the
  // biggest jumps in level. Bar 0 of the grid wins ties.
  let phase = 0;
  let best = -1;
  for (let p = 0; p < BLOCK; p++) {
    let score = 0;
    for (let b = 1; b < nBars; b++) {
      if ((((first + b - p) % BLOCK) + BLOCK) % BLOCK === 0) score += Math.abs(level(b) - level(b - 1)) + Math.abs(lo[b] - lo[b - 1]);
    }
    if (score > best + 1e-6) {
      best = score;
      phase = p;
    }
  }

  // 8-bar blocks on those lines. A stub of under 4 bars at either end joins
  // its neighbour.
  const edges: number[] = [0];
  for (let b = 1; b < nBars; b++) if ((((first + b - phase) % BLOCK) + BLOCK) % BLOCK === 0) edges.push(b);
  edges.push(nBars);
  if (edges.length > 2 && edges[1] - edges[0] < 4) edges.splice(1, 1);
  if (edges.length > 2 && edges[edges.length - 1] - edges[edges.length - 2] < 4) edges.splice(edges.length - 2, 1);
  const blocks = edges.slice(0, -1).map((b0, i) => {
    const b1 = edges[i + 1];
    let l = 0;
    let e = 0;
    for (let b = b0; b < b1; b++) {
      l += lo[b];
      e += level(b);
    }
    return { b0, b1, lo: l / (b1 - b0), level: e / (b1 - b0) };
  });

  // Name them. Drops are the loudest blocks with the low end in; a breakdown
  // loses the low end; what leads into a drop is its build; the ends of the
  // track are its intro and outro; anything else is a verse.
  const levels = blocks.map((b) => b.level);
  const top = Math.max(...levels);
  const floor = Math.min(...levels);
  const maxLo = Math.max(...blocks.map((b) => b.lo));
  const dropAt = top - 0.2 * (top - floor);
  const kinds: PhraseKind[] = blocks.map((b) =>
    b.lo < maxLo * 0.45 ? 'break' : b.level >= dropAt && top - floor > 0.15 ? 'drop' : 'verse',
  );
  const z = blocks.length - 1;
  // A track ends on its outro, even one as loud as the drops, unless that
  // would leave no drop at all.
  if (z >= 2 && kinds[z] === 'drop' && kinds.filter((k) => k === 'drop').length > 1) kinds[z] = 'outro';
  const firstDrop = kinds.indexOf('drop');
  const lastDrop = kinds.lastIndexOf('drop');
  for (let i = 0; i <= z; i++) {
    if (kinds[i] === 'drop' || kinds[i] === 'outro') continue;
    const intoDrop = kinds[i + 1] === 'drop';
    if (intoDrop && kinds[i] === 'verse' && i > 0) kinds[i] = 'build';
    else if (firstDrop >= 0 && i < firstDrop) kinds[i] = kinds[i] === 'break' && i > 0 ? 'break' : 'intro';
    else if (lastDrop >= 0 && i > lastDrop) kinds[i] = 'outro';
  }
  if (firstDrop < 0 && z >= 2) {
    // No clear drop: a flat track. Its ends are still its intro and outro.
    kinds[0] = 'intro';
    kinds[z] = 'outro';
  }

  // Neighbours with the same name join, up to 32 bars.
  const out: Phrase[] = [];
  blocks.forEach((blk, i) => {
    const prev = out[out.length - 1];
    const bars = blk.b1 - blk.b0;
    const end = round(Math.min(duration, barStart(blk.b1)));
    if (prev && prev.kind === kinds[i] && prev.bars + bars <= BLOCK * MAX_BLOCKS) {
      prev.end = end;
      prev.bars += bars;
    } else out.push({ start: round(Math.max(0, barStart(blk.b0))), end, bars, kind: kinds[i] });
  });
  return out;
}

const round = (t: number) => Math.round(t * 1000) / 1000;
