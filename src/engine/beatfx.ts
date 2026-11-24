/**
 * The mixer's Beat FX section: one effect unit (fx.ts) and everything that
 * plays it — which channel it's on, its tempo (the deck's, or tapped), FX
 * quantize, per-effect beat values and the X-pad. React renders `store`; the
 * unit hears about changes through `push`.
 *
 * Why one shared unit rather than one per deck: it's how a club mixer's
 * Beat FX works, and it's the only design that can also sit on the master
 * bus without a third set of nodes; the graph already had an insert point on
 * each channel, so those became slots and the master got one more.
 */

import type { Deck } from './deck';
import type { DjEngine } from './engine';
import {
  ALL_BANDS,
  defaultFxBeats,
  FX_MAX_BPM,
  FX_META,
  FX_MIN_BPM,
  isFxType,
  nearestBeats,
  type FxBands,
  type FxParams,
  type FxType,
} from './fx';
import { getValue, setValue } from './library';
import { createStore, type Store } from './store';

export type FxChannel = 'A' | 'B' | 'M';

export const FX_CHANNELS: { id: FxChannel; label: string; name: string }[] = [
  { id: 'A', label: 'A', name: 'Deck A' },
  { id: 'B', label: 'B', name: 'Deck B' },
  { id: 'M', label: 'Mst', name: 'Master' },
];

/** The X-pad while a finger (or a key) is on it. */
export interface FxPad {
  /** The held zone's beat value. */
  beats: number | null;
  /** The slide, 0–1, once the press has turned into a drag. */
  x: number | null;
  /** The pad switched the effect on and will switch it off on release. */
  engaged: boolean;
}

export interface BeatFxState {
  type: FxType;
  channel: FxChannel;
  on: boolean;
  /** Level / depth, 0–1. Starts dry. */
  depth: number;
  /** Each effect's own beat value, remembered when you switch away. */
  beats: Record<FxType, number>;
  bands: FxBands;
  quantize: boolean;
  /** Mobius: rising (+1) or falling (−1). */
  dir: 1 | -1;
  /** Auto follows the channel's deck; tap uses the tapped tempo. */
  tempo: 'auto' | 'tap';
  tapBpm: number | null;
  /** The tempo the effect is timed to right now, and where it comes from. */
  bpm: number | null;
  bpmFrom: 'deck' | 'tap' | 'none';
  pad: FxPad;
}

/** What's saved between visits (never on/off, never the pad). */
type Saved = Pick<BeatFxState, 'type' | 'channel' | 'depth' | 'beats' | 'bands' | 'quantize' | 'dir' | 'tempo' | 'tapBpm'> & { v: 1 };

const FALLBACK_BPM = 120;
const NO_PAD: FxPad = { beats: null, x: null, engaged: false };

function initial(): BeatFxState {
  return {
    type: 'echo',
    channel: 'A',
    on: false,
    depth: 0,
    beats: defaultFxBeats(),
    bands: { ...ALL_BANDS },
    quantize: true,
    dir: 1,
    tempo: 'auto',
    tapBpm: null,
    bpm: null,
    bpmFrom: 'none',
    pad: NO_PAD,
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class BeatFx {
  readonly store: Store<BeatFxState> = createStore(initial());
  private engine: DjEngine | null = null;
  private unsubs: (() => void)[] = [];
  private saveTimer: number | null = null;
  private lastSaved = '';
  private taps: number[] = [];
  /** Context time (as heard) of the last tap: the tapped grid's anchor. */
  private tapAnchor: number | null = null;

  constructor(
    private decks: readonly [Deck, Deck],
    /** How loud each deck is in the master (fader × crossfader): the master follows the louder one's tempo. */
    private weight: (i: 0 | 1) => number,
    /** Where fader and crossfader moves are announced (the mixer's store). */
    private mix: { subscribe(fn: () => void): () => void },
  ) {}

  /** Restores saved settings and starts following the decks. Safe to call again after dispose. */
  async init() {
    this.unwatch();
    await this.restore();
    const follow = () => this.followTempo();
    this.unsubs.push(...this.decks.map((d) => d.store.subscribe(follow)));
    this.unsubs.push(this.mix.subscribe(() => this.store.get().channel === 'M' && follow()));
    this.unsubs.push(this.store.subscribe(() => this.scheduleSave()));
    follow();
    this.resync();
  }

  attach(engine: DjEngine) {
    this.engine = engine;
    this.followTempo();
    this.resync();
  }

  dispose() {
    this.unwatch();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.engine = null;
  }

  private unwatch() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  /** Tells the unit everything, as it stands. */
  private resync() {
    const e = this.engine;
    if (!e) return;
    e.routeFx(this.slot());
    e.fx.apply(this.params());
  }

  /* ── Controls ─────────────────────────────────────────────────────────── */

  setType(type: FxType) {
    if (type === this.store.get().type) return;
    this.update({ type, pad: NO_PAD });
  }

  setChannel(channel: FxChannel) {
    if (channel === this.store.get().channel) return;
    this.store.set({ channel });
    this.followTempo();
    this.engine?.routeFx(this.slot());
  }

  setOn(on: boolean) {
    const st = this.store.get();
    if (on === st.on && !st.pad.engaged) return;
    // The on button takes over from the pad: on stays on after the pad's
    // release, off is off at once.
    this.update({ on, pad: { ...st.pad, engaged: false } }, true);
  }

  /** On or off as you hear it (the pad's hold counts as on). */
  toggle() {
    const st = this.store.get();
    this.setOn(!(st.on || st.pad.engaged));
  }

  /** The deck's FX button, F / H / B and MIDI: on for this channel, or off if it's already on there. */
  toggleFor(channel: FxChannel) {
    const st = this.store.get();
    if (st.channel === channel) {
      this.toggle();
      return;
    }
    this.setChannel(channel);
    this.setOn(true);
  }

  /** Lit on a controller: on, and on this channel. */
  litFor(channel: FxChannel) {
    const st = this.store.get();
    return (st.on || st.pad.engaged) && st.channel === channel;
  }

  setDepth(depth: number) {
    this.update({ depth: clamp01(depth) });
  }

  setBeats(b: number) {
    const st = this.store.get();
    if (st.beats[st.type] === b) return;
    this.update({ beats: { ...st.beats, [st.type]: b } }, true);
  }

  stepBeats(dir: -1 | 1) {
    const st = this.store.get();
    const list = FX_META[st.type].beats;
    const at = list.indexOf(nearestBeats(list, st.beats[st.type]));
    const next = list[Math.min(list.length - 1, Math.max(0, at + dir))];
    this.setBeats(next);
  }

  /** Picks or drops a band; the last one can't be dropped. */
  setBand(band: keyof FxBands, on: boolean) {
    const bands = { ...this.store.get().bands, [band]: on };
    if (!bands.low && !bands.mid && !bands.high) return;
    this.update({ bands });
  }

  setQuantize(quantize: boolean) {
    this.store.set({ quantize });
  }

  setDir(dir: 1 | -1) {
    this.update({ dir });
  }

  /** Tap along: two taps set a tempo; every tap moves the grid's beat to it. */
  tap() {
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    this.tapAnchor = this.engine ? this.engine.now() : null;
    if (this.taps.length < 2) {
      if (this.store.get().tempo === 'tap') this.followTempo();
      return;
    }
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    const bpm = (60000 * (this.taps.length - 1)) / span;
    const tapBpm = Math.round(Math.min(FX_MAX_BPM, Math.max(FX_MIN_BPM, bpm)) * 10) / 10;
    this.store.set({ tempo: 'tap', tapBpm });
    this.followTempo();
  }

  /** Back to following the channel's deck. */
  setAuto() {
    this.taps = [];
    this.store.set({ tempo: 'auto' });
    this.followTempo();
  }

  /** X-pad: a zone pressed. Its beat value plays while held; an effect that was off comes on for the hold. */
  padPress(beats: number) {
    const st = this.store.get();
    const engaged = st.pad.beats !== null ? st.pad.engaged : !st.on;
    this.update({ pad: { beats, x: st.pad.x, engaged } }, true);
  }

  /** X-pad: the press became a drag; `x` is where along the pad, 0–1. */
  padSlide(x: number) {
    const st = this.store.get();
    if (st.pad.beats === null) return;
    this.update({ pad: { ...st.pad, x: clamp01(x) } });
  }

  /** X-pad: let go. The beat value and the slide go back; a pad-engaged effect goes off. */
  padRelease() {
    const st = this.store.get();
    if (st.pad.beats === null && !st.pad.engaged) return;
    this.update({ pad: NO_PAD }, true);
  }

  /* ── Tempo and the beat clock ─────────────────────────────────────────── */

  /** The beat value playing now (the pad's, while held). */
  liveBeats(st = this.store.get()) {
    return st.pad.beats ?? st.beats[st.type];
  }

  private slot(): 0 | 1 | 2 {
    const c = this.store.get().channel;
    return c === 'A' ? 0 : c === 'B' ? 1 : 2;
  }

  /** The deck whose tempo and beats the effect follows: the channel's, or for the master the loudest playing deck. */
  private source(): Deck | null {
    const c = this.store.get().channel;
    if (c === 'A') return this.decks[0];
    if (c === 'B') return this.decks[1];
    const [a, b] = this.decks;
    const playing = this.decks.filter((d) => d.store.get().playing && d.effectiveBpm());
    if (playing.length === 2) return this.weight(0) >= this.weight(1) ? a : b;
    if (playing.length === 1) return playing[0];
    return a.effectiveBpm() ? a : b.effectiveBpm() ? b : null;
  }

  private followTempo() {
    const st = this.store.get();
    let bpm: number | null = null;
    let bpmFrom: BeatFxState['bpmFrom'] = 'none';
    if (st.tempo === 'tap' && st.tapBpm) {
      bpm = st.tapBpm;
      bpmFrom = 'tap';
    } else {
      const deckBpm = this.source()?.effectiveBpm() ?? null;
      if (deckBpm) {
        bpm = Math.round(deckBpm * 10) / 10;
        bpmFrom = 'deck';
      }
    }
    this.store.set({ bpm, bpmFrom });
    this.engine?.fx.setBpm(bpm ?? FALLBACK_BPM);
  }

  /** Context time of the next beat to land a change on, or null when there's no beat to follow (stopped, no tempo). */
  private nextBeat(): number | null {
    const e = this.engine;
    if (!e) return null;
    const st = this.store.get();
    const bpm = st.bpm;
    if (!bpm) return null;
    const period = 60 / bpm;
    const heard = e.now();
    let t: number | null = null;
    if (st.bpmFrom === 'tap') {
      if (this.tapAnchor !== null) t = this.tapAnchor + Math.ceil((heard - this.tapAnchor) / period) * period;
    } else {
      const d = this.source();
      const bp = d && d.store.get().playing ? d.beatPosition() : null;
      if (bp !== null) t = heard + (Math.ceil(bp) - bp) * period;
    }
    if (t === null) return null;
    // Already being rendered: the one after.
    const soonest = e.ctx.currentTime + 0.004;
    while (t < soonest) t += period;
    return t;
  }

  /* ── Plumbing ─────────────────────────────────────────────────────────── */

  private params(st = this.store.get()): FxParams {
    return {
      type: st.type,
      beats: this.liveBeats(st),
      depth: st.depth,
      on: st.on || st.pad.engaged,
      x: st.pad.x,
      bands: st.bands,
      dir: st.dir,
    };
  }

  /** Sets state and tells the unit; `timed` changes land on the next beat with quantize on. */
  private update(patch: Partial<BeatFxState>, timed = false) {
    this.store.set(patch);
    const e = this.engine;
    if (!e) return;
    const st = this.store.get();
    const at = timed && st.quantize ? this.nextBeat() : null;
    e.fx.apply(this.params(st), at ?? e.ctx.currentTime);
  }

  private async restore() {
    let saved = await getValue<Partial<Saved>>('beatfx');
    if (!saved) {
      // Before the shared unit: deck A's own effect, from the old settings.
      const old = await getValue<{ fx?: { type?: unknown; beats?: unknown; depth?: unknown }[] }>('settings');
      const a = old?.fx?.[0];
      if (a && isFxType(a.type)) {
        saved = { type: a.type, depth: typeof a.depth === 'number' ? a.depth : 0 };
        if (typeof a.beats === 'number') saved.beats = { ...defaultFxBeats(), [a.type]: a.beats };
      }
    }
    if (!saved) return;
    const base = initial();
    const beats = defaultFxBeats();
    if (saved.beats && typeof saved.beats === 'object') {
      for (const id of Object.keys(beats) as FxType[]) {
        const b = (saved.beats as Partial<Record<FxType, unknown>>)[id];
        if (typeof b === 'number' && b > 0) beats[id] = nearestBeats(FX_META[id].beats, b);
      }
    }
    const bands = saved.bands && typeof saved.bands === 'object' ? { ...ALL_BANDS, ...saved.bands } : base.bands;
    this.store.set({
      type: isFxType(saved.type) ? saved.type : base.type,
      channel: saved.channel === 'A' || saved.channel === 'B' || saved.channel === 'M' ? saved.channel : base.channel,
      depth: typeof saved.depth === 'number' ? clamp01(saved.depth) : base.depth,
      beats,
      bands: bands.low || bands.mid || bands.high ? bands : base.bands,
      quantize: typeof saved.quantize === 'boolean' ? saved.quantize : base.quantize,
      dir: saved.dir === -1 ? -1 : 1,
      tempo: saved.tempo === 'tap' && typeof saved.tapBpm === 'number' ? 'tap' : 'auto',
      tapBpm: typeof saved.tapBpm === 'number' ? saved.tapBpm : null,
      on: false,
      pad: NO_PAD,
    });
    this.lastSaved = JSON.stringify(this.saved());
  }

  private saved(): Saved {
    const { type, channel, depth, beats, bands, quantize, dir, tempo, tapBpm } = this.store.get();
    return { v: 1, type, channel, depth, beats, bands, quantize, dir, tempo, tapBpm };
  }

  private scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const json = JSON.stringify(this.saved());
      if (json === this.lastSaved) return;
      this.lastSaved = json;
      void setValue('beatfx', this.saved());
    }, 400);
  }
}
