import { HOT_BANK_SIZE, HOT_CUES, MEMORY_CUES, emptyCues, type HotCue, type TrackCues } from './types';

/**
 * Hot cue banks, colours and the saved form of a track's cues.
 *
 * A deck has HOT_BANKS banks of HOT_BANK_SIZE pads: A–H, then I–P, so every
 * cue has its own letter on the pads and the waveforms. Each cue keeps a
 * colour from CUE_COLORS (the --dj-hot-N tokens in global.css, in the same
 * order); a new cue takes its slot's colour, and the first four match the
 * fixed pad colours Platter had before cues had colours of their own.
 */

/** Colour names, in token order: CUE_COLORS[i] is var(--dj-hot-{i + 1}). */
export const CUE_COLORS = [
  'Rose',
  'Mint',
  'Sky',
  'Lilac',
  'Amber',
  'Lime',
  'Lagoon',
  'Coral',
  'Orchid',
  'Iris',
  'Sand',
  'Slate',
] as const;

/** The same colours as RGB, for matching a Rekordbox cue's colour. Keep in
 *  step with the --dj-hot-N tokens in global.css. */
const CUE_RGB: [number, number, number][] = [
  [0xff, 0x6b, 0x86],
  [0x45, 0xd8, 0x8c],
  [0x5e, 0xc4, 0xff],
  [0xc9, 0x9b, 0xff],
  [0xff, 0xb3, 0x47],
  [0xb5, 0xe6, 0x55],
  [0x3f, 0xd0, 0xc4],
  [0xff, 0x8a, 0x5c],
  [0xf7, 0x8f, 0xd2],
  [0x8b, 0x96, 0xff],
  [0xe8, 0xd5, 0xa8],
  [0x9a, 0xa5, 0xb8],
];

export const cueColorVar = (color: number) => `var(--dj-hot-${color + 1})`;

/** The colour a new cue in `slot` takes: the slot's place in its bank. */
export const defaultCueColor = (slot: number) => slot % HOT_BANK_SIZE;

/** A–H for the first bank, I–P for the second. */
export const hotLetter = (slot: number) => String.fromCharCode(65 + slot);

export const bankLabel = (bank: number) => `${hotLetter(bank * HOT_BANK_SIZE)}–${hotLetter(bank * HOT_BANK_SIZE + HOT_BANK_SIZE - 1)}`;

/** The palette entry nearest an RGB colour. */
export function nearestCueColor(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  CUE_RGB.forEach(([cr, cg, cb], i) => {
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isColor = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < CUE_COLORS.length;

function hotFrom(h: unknown, slot: number): HotCue | null {
  // Before banks, a hot cue was just its time.
  if (isTime(h)) return { t: h, color: defaultCueColor(slot) };
  if (!h || typeof h !== 'object') return null;
  const o = h as { t?: unknown; color?: unknown; loop?: unknown };
  if (!isTime(o.t)) return null;
  const cue: HotCue = { t: o.t, color: isColor(o.color) ? o.color : defaultCueColor(slot) };
  const l = o.loop as { end?: unknown; beats?: unknown } | null | undefined;
  if (l && typeof l === 'object' && isTime(l.end) && l.end > o.t && typeof l.beats === 'number' && l.beats > 0) {
    cue.loop = { end: l.end, beats: l.beats };
  }
  return cue;
}

/** Sorted, without near-duplicates, at most MEMORY_CUES. */
export function tidyMemory(times: readonly number[]): number[] {
  const out: number[] = [];
  for (const t of [...times].filter(isTime).sort((a, b) => a - b)) {
    if (!out.length || t - out[out.length - 1] > 0.01) out.push(t);
  }
  return out.slice(0, MEMORY_CUES);
}

/**
 * Any saved form of a track's cues, as it is now. Reads the old form (four
 * hot cues as plain numbers, no memory cues) into the first slots with their
 * old colours, and pads or trims to HOT_CUES slots, so nothing saved is lost.
 */
export function normaliseCues(raw: unknown): TrackCues {
  const out = emptyCues();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { main?: unknown; hot?: unknown; memory?: unknown };
  if (isTime(r.main)) out.main = r.main;
  if (Array.isArray(r.hot)) r.hot.slice(0, HOT_CUES).forEach((h, i) => (out.hot[i] = hotFrom(h, i)));
  if (Array.isArray(r.memory)) out.memory = tidyMemory(r.memory as number[]);
  return out;
}
