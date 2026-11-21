/**
 * The slicer's project model: pure functions over the plain data in
 * types.ts, so the studio (studio.ts) can keep every edit undoable by
 * swapping whole project values, and tests can run without a browser.
 */
import { CATEGORY_LABEL, getSound } from '../engine/sounds/catalog';
import type { Clip, Lane, LaneKind, Project, Snap, Source } from './types';

export const uid = (p = '') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const MIN_BPM = 50;
export const MAX_BPM = 200;
export const SNAPS: { value: Snap; label: string }[] = [
  { value: 4, label: 'Bar' },
  { value: 1, label: '1/4' },
  { value: 0.5, label: '1/8' },
  { value: 0.25, label: '1/16' },
  { value: 0.125, label: '1/32' },
  { value: 0, label: 'Off' },
];

/** The sounds the drum lanes of a new project start with: the boom-bap kit. */
const STARTER_DRUMS: { name: string; sound: string }[] = [
  { name: 'Kick', sound: 'syn:boombap:kick' },
  { name: 'Snare', sound: 'syn:boombap:snare' },
  { name: 'Hats', sound: 'syn:boombap:chh' },
];

/** The CSS colour a sound's category wears everywhere in Platter. */
export function soundColor(soundId: string | null): string {
  const cat = soundId ? getSound(soundId)?.category : undefined;
  return cat ? `var(--cat-${cat})` : 'var(--cat-none)';
}

export function makeLane(kind: LaneKind, name: string, sound: string | null = null): Lane {
  return {
    id: uid('l'),
    name,
    kind,
    sound,
    color: kind === 'drum' ? soundColor(sound) : 'var(--dj-b)',
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
  };
}

export function newProject(name = 'Untitled chop'): Project {
  const now = Date.now();
  return {
    v: 1,
    id: uid('p'),
    name,
    bpm: 90,
    meter: 4,
    bars: 8,
    swing: 50,
    sources: [],
    lanes: [makeLane('audio', 'Sample 1'), makeLane('audio', 'Sample 2'), ...STARTER_DRUMS.map((d) => makeLane('drum', d.name, d.sound))],
    clips: [],
    loop: { on: true, start: 0, end: 16 },
    snap: 0.25,
    level: 0.8,
    createdAt: now,
    updatedAt: now,
  };
}

/** A drum lane named after its sound's category ("Kick", "Hat" …). */
export function drumLaneFor(soundId: string): Lane {
  const info = getSound(soundId);
  const name = info ? CATEGORY_LABEL[info.category].replace(/s$/, '') : 'Drums';
  return makeLane('drum', name, soundId);
}

/* ── Slices ─────────────────────────────────────────────────────────────── */

/** Slice i of a source as [start, end) seconds. */
export function sliceRange(src: Source, i: number): [number, number] {
  const s = src.slices;
  return [s[i] ?? 0, s[i + 1] ?? src.duration];
}

/** The slice containing time t. */
export function sliceAt(src: Source, t: number): number {
  const s = src.slices;
  let i = 0;
  while (i + 1 < s.length && s[i + 1] <= t) i++;
  return i;
}

/** Normalises slice points: sorted, unique (10 ms apart), inside the source, starting at 0. */
export function cleanSlices(points: number[], duration: number): number[] {
  const out = [0];
  for (const p of [...points].sort((a, b) => a - b)) {
    if (!(p > 0) || (duration > 0 && p >= duration - 0.01)) continue;
    if (p - out[out.length - 1] < 0.01) continue;
    out.push(p);
  }
  return out;
}

/* ── Timing ─────────────────────────────────────────────────────────────── */

export const secPerBeat = (bpm: number) => 60 / bpm;

/** How fast a clip plays its source (1 = as recorded). */
export function clipRate(clip: Clip, src: Source | undefined, bpm: number): number {
  let r = 2 ** (clip.semitones / 12);
  if (clip.sync && src?.bpm) r *= bpm / src.bpm;
  return r;
}

/** A clip's length on the timeline, in beats. */
export function clipBeats(clip: Clip, src: Source | undefined, bpm: number): number {
  return ((clip.end - clip.start) / clipRate(clip, src, bpm)) * (bpm / 60);
}

export function clipEnd(clip: Clip, src: Source | undefined, bpm: number): number {
  return clip.at + clipBeats(clip, src, bpm);
}

export function snapBeat(beat: number, snap: Snap | number, mode: 'round' | 'floor' = 'round'): number {
  if (!snap) return beat;
  const f = mode === 'floor' ? Math.floor : Math.round;
  return f(beat / snap + 1e-9) * snap;
}

/** Where the song ends: the last clip's end, at least `bars`, in beats. */
export function songBeats(p: Project): number {
  const byId = new Map(p.sources.map((s) => [s.id, s]));
  let end = p.bars * p.meter;
  for (const c of p.clips) end = Math.max(end, clipEnd(c, byId.get(c.sourceId), p.bpm));
  return Math.ceil(end / p.meter) * p.meter;
}

/** Beat position with swing applied to off-beat sixteenths (drum lanes only). */
export function swung(beat: number, swing: number): number {
  if (swing <= 50) return beat;
  const sixteenth = beat / 0.25;
  const n = Math.round(sixteenth);
  if (Math.abs(sixteenth - n) > 1e-6 || n % 2 === 0) return beat;
  return beat + 0.5 * ((swing - 50) / 50) * 0.25;
}

/* ── Clips ──────────────────────────────────────────────────────────────── */

export function makeClip(src: Source, laneId: string, at: number, start: number, end: number): Clip {
  return {
    id: uid('c'),
    laneId,
    sourceId: src.id,
    at,
    start,
    end,
    gain: 1,
    semitones: 0,
    sync: src.origin.kind !== 'sound' && !!src.bpm,
    reverse: false,
    fadeIn: 0,
    fadeOut: 0,
  };
}

/** A clip's label on the timeline. */
export function clipLabel(clip: Clip, src: Source | undefined): string {
  if (clip.name) return clip.name;
  if (!src) return 'Missing audio';
  if (src.origin.kind === 'sound') return src.name;
  const i = src.slices.findIndex((t, k) => Math.abs(t - clip.start) < 0.005 && Math.abs((src.slices[k + 1] ?? src.duration) - clip.end) < 0.005);
  return i >= 0 ? `${src.name} · ${i + 1}` : src.name;
}

/** Splits a clip at timeline beat `beat`; returns the two halves, or null if the cut misses it. */
export function splitClip(clip: Clip, src: Source | undefined, bpm: number, beat: number): [Clip, Clip] | null {
  const len = clipBeats(clip, src, bpm);
  const into = beat - clip.at;
  if (into <= 0.001 || into >= len - 0.001) return null;
  const secs = (into * 60) / bpm * clipRate(clip, src, bpm);
  // Reversed clips play from the end backwards: the first half on the
  // timeline is the end of the source range.
  const cut = clip.reverse ? clip.end - secs : clip.start + secs;
  const a: Clip = clip.reverse ? { ...clip, start: cut, fadeIn: 0 } : { ...clip, end: cut, fadeOut: 0 };
  const b: Clip = clip.reverse ? { ...clip, id: uid('c'), at: beat, end: cut, fadeOut: 0 } : { ...clip, id: uid('c'), at: beat, start: cut, fadeIn: 0 };
  return [a, b];
}

/** Solo/mute: is this lane heard? */
export function laneHeard(lane: Lane, lanes: Lane[]): boolean {
  if (lanes.some((l) => l.solo)) return lane.solo;
  return !lane.mute;
}

export function sourceName(name: string, stem: Source['stem']): string {
  const part = stem ? ` (${stem[0].toUpperCase()}${stem.slice(1)})` : '';
  return `${name}${part}`;
}

/** Checks and repairs a project read back from storage. */
export function reviveProject(raw: unknown): Project | null {
  const p = raw as Project | null;
  if (!p || p.v !== 1 || !Array.isArray(p.sources) || !Array.isArray(p.lanes) || !Array.isArray(p.clips)) return null;
  const base = newProject(p.name);
  return {
    ...base,
    ...p,
    lanes: p.lanes.length ? p.lanes : base.lanes,
    clips: p.clips.filter((c) => p.sources.some((s) => s.id === c.sourceId) && p.lanes.some((l) => l.id === c.laneId)),
  };
}
