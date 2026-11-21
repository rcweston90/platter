import { keyName, parseCamelot, shiftKey } from '../engine/key';
import { flowSimilarity, type SoundPrint } from './sound/embed';

/**
 * Which tracks mash or mix well with a given one, and why.
 *
 * Three things decide it, the way a DJ checks them:
 *   key     — the Camelot wheel: same key, relative major/minor, a fifth either
 *             way, the diagonal, then the "energy boost" jumps (+2, +7).
 *             A key shift of a semitone or two (Platter's key ♭/♯, with key
 *             lock) can turn a clash into a match, at a small cost.
 *   tempo   — how far the second track has to be stretched to meet the first,
 *             trying it at normal, half and double time; ±6% is the default
 *             reach (what a pitch fader at ±8 covers comfortably).
 *   energy  — 1…10; close is smooth, a step up builds, a big gap is a gear change.
 * Genre adds a small nudge when both tracks share one.
 *
 * Sound, when both tracks have a sound print (src/library/sound — an open
 * audio model listening to them in the browser): how close the next track's
 * intro sits to this one's outro, and how alike the two are overall, ranked
 * against the rest of the pool. It's a fourth vote, not a veto: key and tempo
 * still decide whether a pair can be mixed at all.
 *
 * An energy direction (keep it level, build, bring it down) changes what
 * counts as a good energy step.
 */

export interface MixTrack {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  key: string | null;
  energy: number | null;
  genre?: string | null;
  /** What the audio model hears in it; absent until it's been listened to. */
  sound?: SoundPrint | null;
}

/** Where the set should go next. */
export type EnergyDirection = 'any' | 'hold' | 'build' | 'drop';

export type KeyRelation =
  | 'same'
  | 'relative'
  | 'fifth-up'
  | 'fifth-down'
  | 'diagonal'
  | 'boost-2'
  | 'semitone'
  | 'clash'
  | 'unknown';

export type TempoRelation = 'same' | 'half' | 'double';

export interface Match {
  track: MixTrack;
  /** 0…1 overall. */
  score: number;
  keyScore: number;
  tempoScore: number;
  energyScore: number;
  /** 0…1: how close it sounds, ranked against the pool; null without sound prints. */
  soundScore: number | null;
  /** Raw sound similarity (see flowSimilarity); null without sound prints. */
  similarity: number | null;
  keyRelation: KeyRelation;
  /** Semitones to shift the match's key (with key lock) for `keyRelation`; 0 = as is. */
  keyShift: number;
  tempoRelation: TempoRelation;
  /** Percent to change the match's speed so its beats meet the seed's (signed). */
  stretchPct: number | null;
  /** The match's tempo once stretched, i.e. the seed's tempo (or its half/double). */
  playsAt: number | null;
  /** Plain-language reasons, most important first. */
  reasons: string[];
}

export interface MatchOptions {
  /** Furthest stretch to allow, in percent (default 6). */
  maxStretchPct?: number;
  /** Allow fixing a key clash by shifting ±1–2 semitones (default true). */
  allowKeyShift?: boolean;
  /** Most matches to return (default 25). */
  limit?: number;
  /** Keep tracks whose tempo or key is unknown, at a lower score (default false). */
  includeUnknown?: boolean;
  /** Where the energy should go (default 'any': close is best, either way). */
  direction?: EnergyDirection;
  /** Track ids to leave out (already played, already on a deck). */
  exclude?: ReadonlySet<string>;
}

const KEY_SCORE: Record<KeyRelation, number> = {
  same: 1,
  relative: 0.92,
  'fifth-up': 0.88,
  'fifth-down': 0.88,
  diagonal: 0.72,
  'boost-2': 0.55,
  semitone: 0.42,
  clash: 0.05,
  unknown: 0.35,
};

/** How `b` relates to `a` on the Camelot wheel. */
export function keyRelation(a: string | null, b: string | null): KeyRelation {
  const x = a && /^(\d{1,2})([AB])$/.exec(a);
  const y = b && /^(\d{1,2})([AB])$/.exec(b);
  if (!x || !y) return 'unknown';
  const na = Number(x[1]);
  const nb = Number(y[1]);
  const d = (((nb - na) % 12) + 12) % 12; // steps clockwise from a to b
  const sameLetter = x[2] === y[2];
  if (sameLetter) {
    if (d === 0) return 'same';
    if (d === 1) return 'fifth-up';
    if (d === 11) return 'fifth-down';
    if (d === 2) return 'boost-2';
    if (d === 7) return 'semitone';
    return 'clash';
  }
  if (d === 0) return 'relative';
  // 8A ↔ 9B and 8B ↔ 7A: six of seven notes shared.
  if ((x[2] === 'A' && d === 1) || (x[2] === 'B' && d === 11)) return 'diagonal';
  return 'clash';
}

const KEY_WHY: Record<KeyRelation, (a: string, b: string) => string> = {
  same: (a) => `Same key (${label(a)}): every note fits, so vocals and melodies can sit on top of each other.`,
  relative: (a, b) => `${label(a)} → ${label(b)}: relative major/minor, the same seven notes with a different home.`,
  'fifth-up': (a, b) => `${label(a)} → ${label(b)}: a fifth up, six of seven notes shared; lifts the mood.`,
  'fifth-down': (a, b) => `${label(a)} → ${label(b)}: a fifth down, six of seven notes shared; settles the mood.`,
  diagonal: (a, b) => `${label(a)} → ${label(b)}: a diagonal move, six of seven notes shared; good for a blend, careful with long vocal overlaps.`,
  'boost-2': (a, b) => `${label(a)} → ${label(b)}: two steps round the wheel, an "energy boost"; mix it quickly rather than layering.`,
  semitone: (a, b) => `${label(a)} → ${label(b)}: a semitone up, the classic key-change lift; cut or drop into it, don't layer.`,
  clash: (a, b) => `${label(a)} and ${label(b)} clash; keep melodies apart (drums or a quick cut only).`,
  unknown: () => 'Key unknown for one of the two; trust your ears.',
};

function label(code: string) {
  const n = keyName(code);
  return n ? `${code}, ${n}` : code;
}

/** Best stretch to meet `seed` BPM, trying the match at normal, half and double time. */
export function tempoFit(seed: number, other: number): { relation: TempoRelation; stretchPct: number; playsAt: number } {
  const options: { relation: TempoRelation; bpm: number }[] = [
    { relation: 'same', bpm: other },
    { relation: 'double', bpm: other * 2 },
    { relation: 'half', bpm: other / 2 },
  ];
  let best = { relation: 'same' as TempoRelation, stretchPct: Infinity, playsAt: seed };
  for (const o of options) {
    const pct = (seed / o.bpm - 1) * 100;
    // A small preference for playing the track as it is.
    const cost = Math.abs(pct) + (o.relation === 'same' ? 0 : 0.75);
    const bestCost = Math.abs(best.stretchPct) + (best.relation === 'same' ? 0 : 0.75);
    if (cost < bestCost) best = { relation: o.relation, stretchPct: pct, playsAt: seed };
  }
  return best;
}

function round(n: number, places = 1) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** 0…1 for an energy step of `d` (next minus current), given the direction wanted. */
export function energyFit(d: number, direction: EnergyDirection = 'any'): number {
  switch (direction) {
    case 'hold':
      return Math.max(0, 1 - Math.abs(d) / 3);
    case 'build':
    case 'drop': {
      const up = direction === 'build' ? d : -d;
      if (up >= 1 && up <= 2) return 1;
      if (up === 0) return 0.6;
      if (up === 3) return 0.75;
      if (up > 3) return 0.45;
      return Math.max(0, 0.35 + 0.15 * up); // the wrong way
    }
    default:
      return Math.max(0, 1 - Math.abs(d) / 6);
  }
}

/** A raw similarity on its own, when there's too little of a pool to rank against. */
const absoluteSound = (sim: number) => Math.max(0, Math.min(1, (sim - 0.35) / 0.55));

function soundReason(score: number): string | null {
  const pct = Math.round(score * 100);
  if (score >= 0.8) return `Sounds close: its opening is nearer this track's ending than ${Math.min(99, pct)}% of your library.`;
  if (score <= 0.2) return `Sounds quite different from this one; fine as a deliberate change of colour.`;
  return null;
}

/**
 * Scores one pair: how well `other` goes with `seed`. `soundScore` (0…1,
 * from suggestMatches' ranking) brings sound into it.
 */
export function scorePair(seed: MixTrack, other: MixTrack, opts: MatchOptions = {}, sound?: { score: number; similarity: number } | null): Match {
  const maxStretch = opts.maxStretchPct ?? 6;
  const allowShift = opts.allowKeyShift ?? true;
  const reasons: string[] = [];

  // Tempo
  let tempoScore = 0.3;
  let stretchPct: number | null = null;
  let playsAt: number | null = null;
  let tempoRelation: TempoRelation = 'same';
  let tempoReason = 'Tempo unknown for one of the two.';
  if (seed.bpm && other.bpm) {
    const fit = tempoFit(seed.bpm, other.bpm);
    stretchPct = round(fit.stretchPct, 2);
    playsAt = round(fit.playsAt, 2);
    tempoRelation = fit.relation;
    const abs = Math.abs(fit.stretchPct);
    tempoScore = abs > maxStretch ? 0 : 1 - (abs / maxStretch) ** 1.5;
    const asWhat =
      fit.relation === 'half'
        ? ` played half-time (${round(other.bpm, 1)} feels like ${round(other.bpm / 2, 1)})`
        : fit.relation === 'double'
          ? ` played double-time (${round(other.bpm, 1)} feels like ${round(other.bpm * 2, 1)})`
          : '';
    tempoReason =
      abs < 0.25
        ? `Same tempo${asWhat}: ${round(seed.bpm, 1)} BPM, no stretching needed.`
        : abs > maxStretch
          ? `${round(other.bpm, 1)} BPM is ${round(abs, 1)}% away${asWhat}, beyond the ${maxStretch}% reach.`
          : `${fit.stretchPct > 0 ? 'Speed' : 'Slow'} it ${fit.stretchPct > 0 ? 'up' : 'down'} ${round(abs, 1)}% to ${round(seed.bpm, 1)} BPM${asWhat}; key lock keeps its key.`;
  }

  // Key, optionally with a key shift on the match
  let relation = keyRelation(seed.key, other.key);
  let keyShift = 0;
  let keyScore = KEY_SCORE[relation];
  if (allowShift && seed.key && other.key && parseCamelot(other.key)) {
    for (const s of [1, -1, 2, -2]) {
      const r = keyRelation(seed.key, shiftKey(other.key, s));
      const sc = KEY_SCORE[r] - 0.12 * Math.abs(s);
      if (sc > keyScore) {
        keyScore = sc;
        relation = r;
        keyShift = s;
      }
    }
  }
  const shiftedKey = other.key && keyShift ? shiftKey(other.key, keyShift) : other.key;
  const keyReason =
    keyShift && seed.key && other.key && shiftedKey
      ? `Shift it ${keyShift > 0 ? 'up' : 'down'} ${Math.abs(keyShift)} semitone${Math.abs(keyShift) > 1 ? 's' : ''} (${other.key} → ${shiftedKey}): ${KEY_WHY[relation](seed.key, shiftedKey)}`
      : KEY_WHY[relation](seed.key ?? '?', other.key ?? '?');

  // Energy
  const direction = opts.direction ?? 'any';
  let energyScore = 0.6;
  let energyReason: string | null = null;
  if (seed.energy != null && other.energy != null) {
    const d = other.energy - seed.energy;
    energyScore = energyFit(d, direction);
    energyReason =
      d === 0
        ? `Same energy (${seed.energy}/10): a smooth blend.`
        : Math.abs(d) <= 2
          ? `Energy ${seed.energy} → ${other.energy}: ${d > 0 ? 'a lift' : 'a breather'}.`
          : `Energy ${seed.energy} → ${other.energy}: a big ${d > 0 ? 'jump up' : 'drop'}; works as a deliberate gear change.`;
  }

  const sameGenre = !!(seed.genre && other.genre && seed.genre.toLowerCase() === other.genre.toLowerCase());
  const soundScore = sound ? sound.score : null;
  let score =
    soundScore == null
      ? 0.45 * keyScore + 0.4 * tempoScore + 0.15 * energyScore
      : 0.36 * keyScore + 0.32 * tempoScore + 0.12 * energyScore + 0.2 * soundScore;
  score += sameGenre ? 0.03 : 0;
  if (tempoScore === 0) score *= 0.5; // out of reach: listed last if at all
  score = Math.max(0, Math.min(1, score));

  // Lead with whichever decides the pair.
  const keyFirst = keyScore >= tempoScore;
  reasons.push(...(keyFirst ? [keyReason, tempoReason] : [tempoReason, keyReason]));
  const sr = soundScore == null ? null : soundReason(soundScore);
  if (sr && soundScore! >= 0.8) reasons.splice(1, 0, sr);
  if (energyReason) reasons.push(energyReason);
  if (sr && soundScore! < 0.8) reasons.push(sr);
  if (sameGenre) reasons.push(`Both ${other.genre}.`);

  return {
    track: other,
    score: round(score, 3),
    keyScore: round(keyScore, 3),
    tempoScore: round(tempoScore, 3),
    energyScore: round(energyScore, 3),
    soundScore: soundScore == null ? null : round(soundScore, 3),
    similarity: sound ? round(sound.similarity, 3) : null,
    keyRelation: relation,
    keyShift,
    tempoRelation,
    stretchPct,
    playsAt,
    reasons,
  };
}

/** The best partners for `seed` from `pool`, best first. */
export function suggestMatches(seed: MixTrack, pool: MixTrack[], opts: MatchOptions = {}): Match[] {
  const limit = opts.limit ?? 25;
  const sounds = rankSounds(seed, pool, opts.exclude);
  const out: Match[] = [];
  for (const t of pool) {
    if (t.id === seed.id || opts.exclude?.has(t.id)) continue;
    if (!opts.includeUnknown && (!t.bpm || !t.key)) continue;
    const m = scorePair(seed, t, opts, sounds.get(t.id));
    if (!opts.includeUnknown && m.tempoScore === 0) continue;
    out.push(m);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Sound similarity of every pool track that has a print to `seed`, ranked:
 * 1 = the closest-sounding in the pool, 0 = the furthest. With fewer than
 * eight to rank, the raw similarity is mapped on its own.
 */
export function rankSounds(seed: MixTrack, pool: MixTrack[], exclude?: ReadonlySet<string>): Map<string, { score: number; similarity: number }> {
  const out = new Map<string, { score: number; similarity: number }>();
  if (!seed.sound) return out;
  const sims: { id: string; sim: number }[] = [];
  for (const t of pool) {
    if (t.id === seed.id || exclude?.has(t.id) || !t.sound || t.sound.version !== seed.sound.version) continue;
    sims.push({ id: t.id, sim: flowSimilarity(seed.sound, t.sound) });
  }
  if (sims.length < 8) {
    for (const s of sims) out.set(s.id, { score: absoluteSound(s.sim), similarity: s.sim });
    return out;
  }
  sims.sort((a, b) => a.sim - b.sim);
  sims.forEach((s, i) => out.set(s.id, { score: i / (sims.length - 1), similarity: s.sim }));
  return out;
}

/** One-word verdict for a score, for badges. */
export function verdict(score: number): 'great' | 'good' | 'possible' | 'stretch' {
  return score >= 0.85 ? 'great' : score >= 0.7 ? 'good' : score >= 0.5 ? 'possible' : 'stretch';
}
