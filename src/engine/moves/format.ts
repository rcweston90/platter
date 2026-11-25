/**
 * A move mix: what a DJ did, not what it sounded like. It is the state of
 * the rig when recording started, then every control change after it, each
 * stamped with the audio clock (seconds since the start). Replaying it
 * applies the same moves on the same schedule, so it is tiny next to an
 * audio recording, and it only sounds like the original where the listener
 * has the same tracks: the demos, or tracks in their own crate.
 *
 * This file is the format alone: the types, the checks a file or link from
 * someone else has to pass before anything is replayed from it, and the
 * .plattermix file and #mix= link encodings. Recording and replay are in
 * ./index.ts.
 *
 * Everything from outside is untrusted: a move names a method that replay
 * will call, so only the moves listed in MOVES get through, each with its
 * arguments checked.
 */

import { isFxType, type FxBands, type FxType } from '../fx';
import type { ChannelState, CrossfaderCurve } from '../mixer';
import type { FxChannel } from '../beatfx';

export const MIX_FORMAT = 'platter-mix';
export const MIX_VERSION = 1;
/** The file name ending for a shared move mix. */
export const MIX_EXT = '.plattermix';
/** The hash a link carries a mix in: #mix=… */
export const MIX_HASH = 'mix=';
/** The longest link Copy link will make, in characters. Long enough for a
 *  few minutes of busy mixing; short enough to paste into a chat, an email
 *  or any browser's address bar. Longer mixes go as a file. */
export const LINK_LIMIT = 16_000;
/** The most a file or link may unpack to: a guard against a hostile one. */
const MAX_JSON = 8_000_000;
const MAX_MOVES = 400_000;

export interface MixTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  /** One of Platter's demo tracks, which every listener has. */
  demo: boolean;
}

export interface LoopSnap {
  active: boolean;
  start: number;
  end: number;
  beats: number;
  edge: 'in' | 'out' | null;
}

export interface DeckSnap {
  /** MixTrack id, or null for an empty deck. */
  track: string | null;
  pos: number;
  playing: boolean;
  cue: number;
  pitch: number;
  range: number;
  speed: 33 | 45;
  keyLock: boolean;
  keyShift: number;
  sync: boolean;
  quantize: boolean;
  quantizeBeats: number;
  slip: boolean;
  autoLoop: number;
  jumpBeats: number;
  hotBank: number;
  hotGate: boolean;
  loop: LoopSnap;
}

export interface FxSnap {
  type: FxType;
  channel: FxChannel;
  on: boolean;
  depth: number;
  beats: number;
  bands: FxBands;
  quantize: boolean;
  dir: 1 | -1;
}

export interface MixSnap {
  decks: [DeckSnap, DeckSnap];
  channels: [ChannelState, ChannelState];
  crossfader: number;
  curve: CrossfaderCurve;
  master: number;
  fx: FxSnap;
}

/** One control change. `m` names it (see MOVES), `d` is the deck or
 *  channel (0 = A, 1 = B), `a` its arguments, `x` what replay needs to make
 *  it land the same way on someone else's rig. */
export interface Move {
  t: number;
  m: string;
  d?: 0 | 1;
  a?: unknown[];
  x?: { cue?: number | null; hot?: { t: number; end?: number } | null; loop?: LoopSnap };
}

export interface MoveMix {
  kind: 'moves';
  v: 1;
  id: string;
  name: string;
  createdAt: number;
  /** Length of the recording, in seconds. */
  seconds: number;
  tracks: MixTrack[];
  start: MixSnap;
  moves: Move[];
  /** Came from a link or a file rather than this browser's Rec moves. */
  shared?: boolean;
}

/* ── Checking what comes in ─────────────────────────────────────────────── */

type Check = (v: unknown) => boolean;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const range = (lo: number, hi: number): Check => (v) => num(v) && (v as number) >= lo && (v as number) <= hi;
const bool: Check = (v) => typeof v === 'boolean';
const dir: Check = (v) => v === 1 || v === -1;
const int = (lo: number, hi: number): Check => (v) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const oneOf = (...xs: unknown[]): Check => (v) => xs.includes(v);
const orNull = (c: Check): Check => (v) => v === null || c(v);
const str: Check = (v) => typeof v === 'string' && v.length > 0 && v.length < 200;
const optional = (c: Check): Check => (v) => v === undefined || c(v);

const SECONDS = range(0, 24 * 3600);
const BEATS = range(1 / 64, 256);
const CHANNEL_KEYS: Record<string, Check> = {
  trim: range(0, 1),
  high: range(0, 1),
  mid: range(0, 1),
  low: range(0, 1),
  filter: range(-1, 1),
  fader: range(0, 1),
  cue: bool,
};
const LEVEL_KEYS: Record<string, Check> = { master: range(0, 1), cueMix: range(0, 1), cueLevel: range(0, 1) };

/** Where a move goes: a deck's method, the mixer, the Beat FX unit, or replay itself. */
export type MoveTarget = 'deck' | 'mixer' | 'fx' | 'replay';

/** Every move replay knows, with its arguments' checks. */
export const MOVES: Record<string, { on: MoveTarget; args: Check[] }> = {
  // Deck transport
  load: { on: 'deck', args: [str, bool] },
  play: { on: 'deck', args: [] },
  pause: { on: 'deck', args: [] },
  cueDown: { on: 'deck', args: [] },
  cueUp: { on: 'deck', args: [] },
  brake: { on: 'deck', args: [optional(range(0, 10))] },
  spinback: { on: 'deck', args: [optional(range(0, 10))] },
  seek: { on: 'deck', args: [SECONDS] },
  beatJump: { on: 'deck', args: [dir] },
  alignBars: { on: 'deck', args: [] },
  eject: { on: 'deck', args: [] },
  memJump: { on: 'deck', args: [SECONDS] },
  // Hot cues
  hotCueDown: { on: 'deck', args: [int(0, 63)] },
  hotCueUp: { on: 'deck', args: [int(0, 63)] },
  setHotBank: { on: 'deck', args: [int(0, 7)] },
  setHotGate: { on: 'deck', args: [bool] },
  // Loops
  toggleLoop: { on: 'deck', args: [] },
  exitLoop: { on: 'deck', args: [] },
  reloop: { on: 'deck', args: [] },
  loopInDown: { on: 'deck', args: [] },
  loopInUp: { on: 'deck', args: [] },
  loopOut: { on: 'deck', args: [] },
  stepLoop: { on: 'deck', args: [dir] },
  setLoopBeats: { on: 'deck', args: [BEATS] },
  setLoopEdge: { on: 'deck', args: [oneOf('in', 'out'), SECONDS, optional(bool)] },
  nudgeLoopEdge: { on: 'deck', args: [dir, optional(bool)] },
  selectLoopEdge: { on: 'deck', args: [oneOf('in', 'out', null)] },
  roll: { on: 'deck', args: [orNull(BEATS)] },
  setJumpBeats: { on: 'deck', args: [BEATS] },
  setQuantizeBeats: { on: 'deck', args: [BEATS] },
  // Tempo, key and the switches
  setPitch: { on: 'deck', args: [range(-1, 1)] },
  setRange: { on: 'deck', args: [range(0.01, 1)] },
  setSpeed: { on: 'deck', args: [oneOf(33, 45)] },
  setBend: { on: 'deck', args: [range(-1, 1)] },
  setKeyShift: { on: 'deck', args: [int(-12, 12)] },
  setKeyLock: { on: 'deck', args: [bool] },
  setSync: { on: 'deck', args: [bool] },
  resetSyncOffset: { on: 'deck', args: [] },
  setSlip: { on: 'deck', args: [bool] },
  setReverse: { on: 'deck', args: [bool] },
  censor: { on: 'deck', args: [bool] },
  setQuantize: { on: 'deck', args: [bool] },
  // The record
  touch: { on: 'deck', args: [bool] },
  scratch: { on: 'deck', args: [range(-3600, 3600)] },
  // Mixer
  ch: { on: 'mixer', args: [(k) => typeof k === 'string' && k in CHANNEL_KEYS, () => true] },
  xf: { on: 'mixer', args: [range(-1, 1)] },
  curve: { on: 'mixer', args: [oneOf('power', 'full', 'cut')] },
  level: { on: 'mixer', args: [(k) => typeof k === 'string' && k in LEVEL_KEYS, range(0, 1)] },
  // Beat FX
  'fx.setType': { on: 'fx', args: [isFxType] },
  'fx.setChannel': { on: 'fx', args: [oneOf('A', 'B', 'M')] },
  'fx.setOn': { on: 'fx', args: [bool] },
  'fx.setDepth': { on: 'fx', args: [range(0, 1)] },
  'fx.setBeats': { on: 'fx', args: [range(1 / 64, 128)] },
  'fx.setBand': { on: 'fx', args: [oneOf('low', 'mid', 'high'), bool] },
  'fx.setQuantize': { on: 'fx', args: [bool] },
  'fx.setDir': { on: 'fx', args: [dir] },
  'fx.tap': { on: 'fx', args: [] },
  'fx.setAuto': { on: 'fx', args: [] },
  'fx.padPress': { on: 'fx', args: [range(1 / 64, 128)] },
  'fx.padSlide': { on: 'fx', args: [range(0, 1)] },
  'fx.padRelease': { on: 'fx', args: [] },
  // Where the playhead really was: replay corrects drift with these.
  pos: { on: 'replay', args: [SECONDS] },
};

class MixError extends Error {}
const fail = (why: string): never => {
  throw new MixError(why);
};

function checkLoop(v: unknown): LoopSnap {
  const l = v as LoopSnap;
  if (!l || typeof l !== 'object' || !bool(l.active) || !SECONDS(l.start) || !SECONDS(l.end) || !num(l.beats) || !oneOf('in', 'out', null)(l.edge ?? null))
    fail('a loop in it is malformed');
  return { active: l.active, start: l.start, end: l.end, beats: l.beats, edge: l.edge ?? null };
}

function checkMove(v: unknown, deckCount: number, trackIds: Set<string>): Move {
  if (!v || typeof v !== 'object') fail('a move in it is malformed');
  const o = v as Record<string, unknown>;
  if (!SECONDS(o.t)) fail('a move has a bad time');
  const spec = typeof o.m === 'string' && Object.prototype.hasOwnProperty.call(MOVES, o.m) ? MOVES[o.m] : null;
  if (!spec) fail(`it has a move Platter doesn’t know (${String(o.m).slice(0, 30)})`);
  const a = o.a === undefined ? [] : o.a;
  if (!Array.isArray(a) || a.length > spec!.args.length) fail(`a ${o.m} move has the wrong arguments`);
  (a as unknown[]).forEach((x, i) => spec!.args[i](x) || fail(`a ${o.m} move has a bad argument`));
  for (let i = (a as unknown[]).length; i < spec!.args.length; i++) if (!spec!.args[i](undefined)) fail(`a ${o.m} move is missing an argument`);
  const needsDeck = spec!.on === 'deck' || spec!.on === 'replay' || o.m === 'ch';
  if (needsDeck && !int(0, deckCount - 1)(o.d)) fail(`a ${o.m} move names no deck`);
  if (o.m === 'ch' && !CHANNEL_KEYS[(a as unknown[])[0] as string]((a as unknown[])[1])) fail('a mixer move has a bad value');
  if (o.m === 'load' && !trackIds.has((a as unknown[])[0] as string)) fail('a load names a track the mix doesn’t list');
  const move: Move = { t: o.t as number, m: o.m as string };
  if (needsDeck) move.d = o.d as 0 | 1;
  if ((a as unknown[]).length) move.a = [...(a as unknown[])];
  if (o.x && typeof o.x === 'object') {
    const x = o.x as Record<string, unknown>;
    const out: NonNullable<Move['x']> = {};
    if (x.cue !== undefined) out.cue = orNull(SECONDS)(x.cue) ? (x.cue as number | null) : fail('a cue in it is malformed');
    if (x.hot !== undefined) {
      const h = x.hot as { t?: unknown; end?: unknown } | null;
      if (h !== null && (!h || !SECONDS(h.t) || !optional(SECONDS)(h.end))) fail('a hot cue in it is malformed');
      out.hot = h === null ? null : { t: h.t as number, ...(h.end !== undefined ? { end: h.end as number } : {}) };
    }
    if (x.loop !== undefined) out.loop = checkLoop(x.loop);
    move.x = out;
  }
  return move;
}

function checkDeck(v: unknown, trackIds: Set<string>): DeckSnap {
  const d = v as DeckSnap;
  if (!d || typeof d !== 'object') fail('a deck in it is malformed');
  const ok =
    (d.track === null || (typeof d.track === 'string' && trackIds.has(d.track))) &&
    SECONDS(d.pos) &&
    bool(d.playing) &&
    SECONDS(d.cue) &&
    range(-1, 1)(d.pitch) &&
    range(0.01, 1)(d.range) &&
    oneOf(33, 45)(d.speed) &&
    bool(d.keyLock) &&
    int(-12, 12)(d.keyShift) &&
    bool(d.sync) &&
    bool(d.quantize) &&
    BEATS(d.quantizeBeats) &&
    bool(d.slip) &&
    BEATS(d.autoLoop) &&
    BEATS(d.jumpBeats) &&
    int(0, 7)(d.hotBank) &&
    bool(d.hotGate);
  if (!ok) fail('a deck in it is malformed');
  return { ...d, loop: checkLoop(d.loop) };
}

function checkChannel(v: unknown): ChannelState {
  const c = v as ChannelState;
  if (!c || typeof c !== 'object' || !Object.keys(CHANNEL_KEYS).every((k) => CHANNEL_KEYS[k]((c as unknown as Record<string, unknown>)[k])))
    fail('a mixer channel in it is malformed');
  return { trim: c.trim, high: c.high, mid: c.mid, low: c.low, filter: c.filter, fader: c.fader, cue: c.cue };
}

function checkFx(v: unknown): FxSnap {
  const f = v as FxSnap;
  const ok =
    !!f &&
    isFxType(f.type) &&
    oneOf('A', 'B', 'M')(f.channel) &&
    bool(f.on) &&
    range(0, 1)(f.depth) &&
    range(1 / 64, 128)(f.beats) &&
    !!f.bands &&
    bool(f.bands.low) &&
    bool(f.bands.mid) &&
    bool(f.bands.high) &&
    bool(f.quantize) &&
    dir(f.dir);
  if (!ok) fail('its Beat FX settings are malformed');
  return { type: f.type, channel: f.channel, on: f.on, depth: f.depth, beats: f.beats, bands: { ...f.bands }, quantize: f.quantize, dir: f.dir };
}

/** A mix from a file or a link, checked through; throws with a reason a
 *  person can read when it isn't one. */
export function parseMix(data: unknown): MoveMix {
  try {
    const o = data as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.format !== MIX_FORMAT) fail('it isn’t a Platter move mix');
    if (o.v !== MIX_VERSION) fail('it was made by a newer Platter');
    if (!str(o.id) || typeof o.name !== 'string' || !num(o.createdAt) || !SECONDS(o.seconds)) fail('its header is malformed');
    if (!Array.isArray(o.tracks) || o.tracks.length > 2000) fail('its track list is malformed');
    const tracks: MixTrack[] = (o.tracks as unknown[]).map((t) => {
      const r = t as MixTrack;
      if (!r || !str(r.id) || typeof r.title !== 'string' || typeof r.artist !== 'string' || !SECONDS(r.duration) || !bool(r.demo))
        fail('a track in it is malformed');
      return { id: r.id, title: r.title.slice(0, 300), artist: r.artist.slice(0, 300), duration: r.duration, demo: r.demo };
    });
    const ids = new Set(tracks.map((t) => t.id));
    const s = o.start as MixSnap;
    if (!s || !Array.isArray(s.decks) || s.decks.length !== 2 || !Array.isArray(s.channels) || s.channels.length !== 2) fail('its starting state is malformed');
    if (!range(-1, 1)(s.crossfader) || !oneOf('power', 'full', 'cut')(s.curve) || !range(0, 1)(s.master)) fail('its starting mixer is malformed');
    const start: MixSnap = {
      decks: [checkDeck(s.decks[0], ids), checkDeck(s.decks[1], ids)],
      channels: [checkChannel(s.channels[0]), checkChannel(s.channels[1])],
      crossfader: s.crossfader,
      curve: s.curve,
      master: s.master,
      fx: checkFx(s.fx),
    };
    if (!Array.isArray(o.moves) || o.moves.length > MAX_MOVES) fail('its moves are malformed');
    const moves = (o.moves as unknown[]).map((m) => checkMove(m, 2, ids)).sort((a, b) => a.t - b.t);
    return {
      kind: 'moves',
      v: 1,
      id: o.id as string,
      name: (o.name as string).slice(0, 120) || 'Shared mix',
      createdAt: o.createdAt as number,
      seconds: o.seconds as number,
      tracks,
      start,
      moves,
    };
  } catch (err) {
    if (err instanceof MixError) throw new Error(`That isn’t a mix Platter can replay: ${err.message}.`);
    throw new Error('That isn’t a mix Platter can replay.');
  }
}

/** The mix as JSON for a file or link (without this browser's own flags). */
export function mixJson(mix: MoveMix): string {
  const { kind: _k, shared: _s, ...rest } = mix;
  return JSON.stringify({ format: MIX_FORMAT, ...rest, v: MIX_VERSION });
}

export function mixFileName(mix: MoveMix): string {
  const base = mix.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'platter-mix';
  return `${base}${MIX_EXT}`;
}

export function mixFile(mix: MoveMix): { name: string; blob: Blob } {
  return { name: mixFileName(mix), blob: new Blob([mixJson(mix)], { type: 'application/json' }) };
}

export async function readMixFile(file: Blob): Promise<MoveMix> {
  if (file.size > MAX_JSON) throw new Error('That file is too big to be a Platter move mix.');
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('That file isn’t a Platter move mix (it isn’t JSON).');
  }
  return parseMix(data);
}

/* ── Links ──────────────────────────────────────────────────────────────── */

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      void reader.cancel();
      throw new Error('too big');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad characters');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type LinkResult = { ok: true; url: string; length: number } | { ok: false; reason: string; length?: number };

/** A link that carries the whole mix in its hash, deflated and base64url'd. */
export async function mixLink(mix: MoveMix, base = `${location.origin}${location.pathname}${location.search}`): Promise<LinkResult> {
  if (!canCompress()) return { ok: false, reason: 'This browser can’t compress a mix into a link. Download it as a file instead.' };
  const packed = await pipe(new TextEncoder().encode(mixJson(mix)), new CompressionStream('deflate-raw'));
  const url = `${base}#${MIX_HASH}${toBase64Url(packed)}`;
  if (url.length > LINK_LIMIT) {
    return {
      ok: false,
      length: url.length,
      reason: `This mix is too long for a link (${Math.round(url.length / 1000)}k characters; links stop at ${LINK_LIMIT / 1000}k). Download it and send the file instead.`,
    };
  }
  return { ok: true, url, length: url.length };
}

/** The mix in a #mix= hash, or null when the hash holds none. Throws when it holds a broken one. */
export async function mixFromHash(hash: string): Promise<MoveMix | null> {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith(MIX_HASH)) return null;
  if (!canCompress()) throw new Error('This browser can’t open mix links. Ask for the .plattermix file instead.');
  let text: string;
  try {
    const bytes = await pipe(fromBase64Url(h.slice(MIX_HASH.length)), new DecompressionStream('deflate-raw'), MAX_JSON);
    text = new TextDecoder().decode(bytes);
  } catch {
    throw new Error('That mix link is broken or cut short. Ask for it again, or for the .plattermix file.');
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That mix link is broken or cut short.');
  }
  return parseMix(data);
}
