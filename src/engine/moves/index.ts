/**
 * Move mixes: recording what the DJ does, and doing it again.
 *
 * Recording hooks the rig's own control methods — the decks', the mixer's
 * (on the session) and the Beat FX unit's — rather than the UI, so a click,
 * a key, a MIDI controller and Auto-DJ are all heard the same way. Each
 * method is wrapped once, on the instance, when the session is built. Only
 * the outermost call is a move: a hot cue that seeks inside, or Sync that
 * lets go of the other deck, replays as the one press it was. Composite
 * controls (play/pause, the bank switch, FX on/off for a deck) aren't
 * wrapped at all, so they are logged as the primitive moves they make.
 *
 * Times are on the audio clock as heard (engine.now()), seconds from the
 * start. Continuous moves (faders, knobs, the pitch fader, scratching) are
 * thinned to one every COALESCE seconds per control, always keeping the
 * last. Every so often the recorder also notes where each playhead really
 * is (a `pos` move) — but only when it isn't where steady play would have
 * put it, so a long stretch of plain playing costs nothing.
 *
 * Replay applies the moves on schedule through the same methods, so every
 * control on screen moves as it did. The `pos` notes let it pull a deck
 * back if it drifts. The same wrappers notice a control touched by anyone
 * else while a replay runs: the replay stops there and the rig is theirs.
 */

import type { DjSession } from '../session';
import type { Deck } from '../deck';
import { newTrackId } from '../analysis';
import { loadMoveMixes, removeRecording, saveMoveMix } from '../library';
import { createStore, type Store } from '../store';
import { DEMOS } from '../demo';
import {
  MOVES,
  mixFromHash,
  type DeckSnap,
  type LoopSnap,
  type MixSnap,
  type MixTrack,
  type Move,
  type MoveMix,
} from './format';

export * from './format';

/** Seconds between kept values of one continuous control (25 a second). */
const COALESCE = 0.04;
/** Scratching moves faster than a fader: 50 a second. */
const COALESCE_SCRATCH = 0.02;
/** How often the recorder checks where the playheads are, in ms. */
const WATCH_MS = 100;
/** A playhead this far from steady play (seconds) is noted. */
const DRIFT = 0.02;
/** A playing deck gets a note at least this often even when steady (seconds). */
const KEYFRAME_MAX = 8;
/** Replay pulls a playing deck back when it's further off than this (seconds). */
const REPLAY_TOLERANCE = 0.04;
const REPLAY_TOLERANCE_STOPPED = 0.015;
/** No correcting a deck this soon after one of its moves: the worklet hasn't reported the move yet. */
const SETTLE = 0.08;
const SHORTEST = 1;

export interface ReplayState {
  id: string;
  name: string;
  seconds: number;
  /** Seconds into the mix. */
  at: number;
  phase: 'preparing' | 'playing';
}

export interface MissingPrompt {
  mixId: string;
  /** Tracks the mix uses that aren't in this crate. */
  missing: MixTrack[];
}

export interface MovesState {
  /** Newest first. */
  list: MoveMix[];
  recording: boolean;
  /** performance.now() when recording started, for the clock in the top bar. */
  recordStarted: number;
  replay: ReplayState | null;
  prompt: MissingPrompt | null;
  /** One line about what just happened (took over, finished, a bad link). */
  note: string | null;
  /** A mix that just arrived by link, offered for replay. */
  incoming: string | null;
}

type Fn = (...a: unknown[]) => unknown;
type Mode = 'log' | 'touch' | 'quiet';

interface Take {
  t0: number;
  start: MixSnap;
  moves: Move[];
  tracks: Map<string, MixTrack>;
  /** Last kept time of each continuous control. */
  last: Map<string, number>;
  pending: Map<string, { move: Move; timer: number }>;
  /** Where each playhead should be by steady play. */
  pred: [{ t: number; p: number; at: number } | null, { t: number; p: number; at: number } | null];
  touching: [boolean, boolean];
  watch: number;
}

interface Run {
  mix: MoveMix;
  /** Mix track id → crate track id, or null to skip it. */
  map: Map<string, string | null>;
  start: number;
  i: number;
  timer: number;
  /** A deck whose track was skipped sits the mix out until its next load. */
  skip: [boolean, boolean];
  loading: [boolean, boolean];
  queue: [Move[], Move[]];
  touching: [boolean, boolean];
  lastMove: [number, number];
  lastUi: number;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r3 = (v: number) => Math.round(v * 1e3) / 1e3;
const clean = (args: unknown[]) => {
  const out = args.map((a) => (typeof a === 'number' ? r4(a) : a));
  while (out.length && out[out.length - 1] === undefined) out.pop();
  return out;
};
/** 83 → "1:23". */
export const formatClock = (sec: number) => {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const sameTrack = (a: { title: string; artist: string }, b: { title: string; artist: string }) =>
  a.title.trim().toLowerCase() === b.title.trim().toLowerCase() && a.artist.trim().toLowerCase() === b.artist.trim().toLowerCase();

/* Deck methods by what recording does with them. */
const DECK_LOG = [
  'play', 'pause', 'cueDown', 'cueUp', 'brake', 'spinback', 'seek', 'beatJump', 'alignBars', 'eject',
  'hotCueDown', 'hotCueUp', 'setHotBank', 'setHotGate', 'stepMemoryCue',
  'toggleLoop', 'exitLoop', 'reloop', 'loopInDown', 'loopInUp', 'loopOut', 'stepLoop', 'setLoopBeats',
  'setLoopEdge', 'nudgeLoopEdge', 'selectLoopEdge', 'roll', 'setJumpBeats', 'setQuantizeBeats',
  'setPitch', 'setRange', 'setSpeed', 'setBend', 'setKeyShift', 'setKeyLock', 'setSync', 'resetSyncOffset',
  'setSlip', 'setReverse', 'censor', 'setQuantize', 'touch', 'scratch',
] as const;
/** Controls that change the track's own data, not the mix: they take over a replay but aren't recorded. */
const DECK_TOUCH = ['clearHotCue', 'setHotCueColor', 'addMemoryCue', 'deleteMemoryCue', 'tap', 'scaleBpm', 'nudgeGrid', 'shift'] as const;
/** Called by the rig itself (a load, analysis arriving, the sync lock
 *  pulling a follower in on a playhead report): neither a move nor a touch,
 *  and whatever they call inside isn't either. lockStep is private to the
 *  deck; it's reached the same way as the rest, on the instance. */
const DECK_QUIET = ['load', 'arm', 'applyAnalysis', 'destroy', 'lockStep'] as const;
/** Moves whose result on the loop is kept, so replay can make the loop land exactly. */
const LOOP_MOVES = new Set(['toggleLoop', 'exitLoop', 'reloop', 'loopOut', 'stepLoop', 'setLoopBeats', 'setLoopEdge', 'nudgeLoopEdge', 'beatJump']);
const CONTINUOUS: Record<string, number> = { setPitch: COALESCE, scratch: COALESCE_SCRATCH, setLoopEdge: COALESCE };
const FX_LOG = ['setType', 'setChannel', 'setOn', 'setDepth', 'setBeats', 'setBand', 'setQuantize', 'setDir', 'tap', 'setAuto', 'padPress', 'padSlide', 'padRelease'] as const;
const FX_CONTINUOUS = new Set(['setDepth', 'padSlide']);

export class MixMoves {
  readonly store: Store<MovesState> = createStore<MovesState>({
    list: [],
    recording: false,
    recordStarted: 0,
    replay: null,
    prompt: null,
    note: null,
    incoming: null,
  });
  /** How deep inside a wrapped control we are: only the outermost call counts. */
  private depth = 0;
  /** Replay is calling the controls: not a takeover. */
  private applying = false;
  private take: Take | null = null;
  private run: Run | null = null;
  private preparing: string | null = null;
  private inited = false;
  private noteTimer: number | null = null;
  private onHash = () => void this.openHash();

  constructor(private session: DjSession) {
    session.decks.forEach((deck) => this.instrumentDeck(deck));
    this.instrumentMixer();
    this.instrumentFx();
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  async init() {
    if (!this.inited) {
      this.inited = true;
      const list = await loadMoveMixes<MoveMix>();
      const have = new Set(list.map((m) => m.id));
      // A link opened before the list loaded may already be in the store.
      this.store.set({ list: [...this.store.get().list.filter((m) => !have.has(m.id)), ...list] });
    }
    window.addEventListener('hashchange', this.onHash);
    await this.openHash();
  }

  dispose() {
    window.removeEventListener('hashchange', this.onHash);
    this.stopReplay(null);
    if (this.take) this.endTake();
    this.store.set({ recording: false });
  }

  /* ── Hooks ────────────────────────────────────────────────────────────── */

  private wrap(obj: object, name: string, mode: Mode, log?: (args: unknown[], before: unknown) => void, pre?: (args: unknown[]) => unknown) {
    const o = obj as Record<string, Fn>;
    const orig = o[name];
    if (typeof orig !== 'function') return;
    o[name] = (...args: unknown[]) => {
      const outer = this.depth === 0;
      if (outer && mode !== 'quiet') this.touched();
      const recording = outer && mode === 'log' && !!this.take;
      const before = recording && pre ? pre(args) : undefined;
      this.depth++;
      try {
        return orig.apply(obj, args);
      } finally {
        this.depth--;
        if (recording && this.take) log?.(args, before);
      }
    };
  }

  private instrumentDeck(deck: Deck) {
    const st = () => deck.store.get();
    for (const name of DECK_LOG) {
      this.wrap(
        deck,
        name,
        'log',
        (args, before) => this.logDeck(deck, name, args, before),
        // What a press depends on that the listener's rig may not share: the cue point, the hot cue.
        (args) =>
          name === 'cueDown'
            ? st().cue
            : name === 'hotCueDown'
              ? (st().hotCues[args[0] as number] ?? null)
              : name === 'stepMemoryCue'
                ? st().cue
                : undefined,
      );
    }
    for (const name of DECK_TOUCH) this.wrap(deck, name, 'touch');
    for (const name of DECK_QUIET) this.wrap(deck, name, 'quiet');
  }

  private logDeck(deck: Deck, name: string, args: unknown[], before: unknown) {
    const d = deck.index;
    const st = deck.store.get();
    if (name === 'touch') this.take!.touching[d] = !!args[0];
    if (name === 'stepMemoryCue') {
      if (st.cue !== before) this.add({ t: this.rel(), m: 'memJump', d, a: [r4(st.cue)] });
      return;
    }
    const move: Move = { t: this.rel(), m: name, d };
    const a = clean(args);
    if (a.length) move.a = a;
    if (name === 'cueDown') move.x = { cue: r4(before as number) };
    if (name === 'hotCueDown') {
      const h = before as { t: number; loop?: { end: number } } | null;
      move.x = { hot: h ? { t: r4(h.t), ...(h.loop ? { end: r4(h.loop.end) } : {}) } : null };
    }
    if (LOOP_MOVES.has(name)) move.x = { ...move.x, loop: this.loopSnap(deck) };
    this.add(move, CONTINUOUS[name] ? `${name}${d}` : undefined, CONTINUOUS[name]);
  }

  private instrumentMixer() {
    const s = this.session;
    this.wrap(
      s,
      'setChannel',
      'log',
      (args) => {
        const [i, patch] = args as [0 | 1, Record<string, number | boolean>];
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) continue;
          this.add({ t: this.rel(), m: 'ch', d: i, a: [k, typeof v === 'number' ? r4(v) : v] }, `ch${i}${k}`);
        }
      },
    );
    this.wrap(s, 'setCrossfader', 'log', () => this.add({ t: this.rel(), m: 'xf', a: [r4(s.mixer.get().crossfader)] }, 'xf'));
    this.wrap(s, 'setCurve', 'log', (args) => this.add({ t: this.rel(), m: 'curve', a: [args[0]] }));
    this.wrap(s, 'setLevels', 'log', (args) => {
      for (const [k, v] of Object.entries(args[0] as Record<string, number>)) {
        if (typeof v === 'number') this.add({ t: this.rel(), m: 'level', a: [k, r4(v)] }, `level${k}`);
      }
    });
    this.wrap(
      s,
      'loadToDeck',
      'log',
      (args, before) => {
        const [id, i, play] = args as [string, 0 | 1, boolean | undefined];
        if (before) return; // refused: that deck was playing
        const rec = s.crate.get().tracks.find((t) => t.id === id);
        if (!rec) return;
        this.noteTrack(id);
        this.add({ t: this.rel(), m: 'load', d: i, a: [id, !!play] });
      },
      (args) => s.decks[args[1] as 0 | 1]?.store.get().playing,
    );
  }

  private instrumentFx() {
    const fx = this.session.fx;
    for (const name of FX_LOG) {
      this.wrap(fx, name, 'log', (args) => {
        const a = clean(args);
        this.add({ t: this.rel(), m: `fx.${name}`, ...(a.length ? { a } : {}) }, FX_CONTINUOUS.has(name) ? `fx${name}` : undefined);
      });
    }
  }

  /** A control was touched outside replay: that's a takeover. */
  private touched() {
    if (this.applying) return;
    if (this.run) {
      const at = this.store.get().replay?.at ?? 0;
      this.stopReplay(`You took over at ${formatClock(at)}. The decks are yours.`);
    } else if (this.preparing) {
      this.stopReplay('Replay stopped: a control was touched while it was getting ready.');
    }
  }

  /* ── Recording ────────────────────────────────────────────────────────── */

  private rel() {
    const e = this.session.engine;
    return r3(e && this.take ? e.now() - this.take.t0 : 0);
  }

  async toggleRecording() {
    if (this.take) return this.stopRecording();
    return this.startRecording();
  }

  async startRecording() {
    if (this.take) return;
    if (this.run || this.preparing) {
      this.say('Stop the replay before recording moves.');
      return;
    }
    const engine = await this.session.ensureEngine().catch(() => null);
    if (!engine || this.take) return;
    const take: Take = {
      t0: engine.now(),
      start: null as unknown as MixSnap,
      moves: [],
      tracks: new Map(),
      last: new Map(),
      pending: new Map(),
      pred: [null, null],
      touching: [false, false],
      watch: 0,
    };
    this.take = take;
    take.start = this.snapshot();
    take.start.decks.forEach((d, i) => {
      if (d.track) this.noteTrack(d.track);
      take.pred[i] = { t: 0, p: d.pos, at: 0 };
    });
    take.watch = window.setInterval(() => this.watchPlayheads(), WATCH_MS);
    this.store.set({ recording: true, recordStarted: performance.now(), note: null });
  }

  async stopRecording(): Promise<MoveMix | null> {
    const take = this.take;
    if (!take) return null;
    const seconds = this.rel();
    this.endTake();
    this.store.set({ recording: false });
    if (seconds < SHORTEST) {
      this.say('That was too short to keep. Record for at least a second.');
      return null;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const mix: MoveMix = {
      kind: 'moves',
      v: 1,
      id: newTrackId(),
      name: `Moves ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      createdAt: Date.now(),
      seconds,
      tracks: [...take.tracks.values()],
      start: take.start,
      moves: take.moves.sort((a, b) => a.t - b.t),
    };
    await this.keep(mix);
    return mix;
  }

  private endTake() {
    const take = this.take;
    if (!take) return;
    window.clearInterval(take.watch);
    for (const [key, p] of take.pending) {
      window.clearTimeout(p.timer);
      take.moves.push(p.move);
      take.pending.delete(key);
    }
    this.take = null;
  }

  /** Adds a move; with `key`, it's one control's continuous movement, thinned to one per `gap` seconds (the last always kept). */
  private add(move: Move, key?: string, gap = COALESCE) {
    const take = this.take;
    if (!take) return;
    if (!key) {
      take.moves.push(move);
      return;
    }
    const last = take.last.get(key) ?? -Infinity;
    const waiting = take.pending.get(key);
    if (!waiting && move.t - last >= gap) {
      take.moves.push(move);
      take.last.set(key, move.t);
      return;
    }
    if (waiting) {
      waiting.move = move;
      return;
    }
    const entry = {
      move,
      timer: window.setTimeout(
        () => {
          if (this.take !== take || take.pending.get(key) !== entry) return;
          take.pending.delete(key);
          take.moves.push(entry.move);
          take.last.set(key, entry.move.t);
        },
        Math.max(0, (last + gap - move.t) * 1000),
      ),
    };
    take.pending.set(key, entry);
  }

  private noteTrack(id: string) {
    const take = this.take;
    if (!take || take.tracks.has(id)) return;
    const rec = this.session.crate.get().tracks.find((t) => t.id === id);
    const deckTrack = this.session.decks.map((d) => d.store.get().track).find((t) => t?.id === id);
    const src = rec ?? deckTrack;
    if (!src) return;
    take.tracks.set(id, { id, title: src.title, artist: src.artist, duration: r3(src.duration), demo: !!rec?.demo || DEMOS.some((x) => x.id === id) });
  }

  /** Notes a playhead that isn't where steady play would have it: a jump, a scratch, sync pulling it in. */
  private watchPlayheads() {
    const take = this.take;
    const e = this.session.engine;
    if (!take || !e) return;
    const t = r3(e.now() - take.t0);
    for (const deck of this.session.decks) {
      const i = deck.index;
      const pred = take.pred[i];
      if (!deck.hasAudio || take.touching[i]) {
        take.pred[i] = null;
        continue;
      }
      const p = deck.position();
      const rate = deck.store.get().playing ? deck.rate() : 0;
      const expected = pred ? pred.p + rate * (t - pred.t) : NaN;
      const stale = rate !== 0 && pred !== null && t - pred.at > KEYFRAME_MAX;
      if (!pred || !(Math.abs(p - expected) <= DRIFT) || stale) {
        take.moves.push({ t, m: 'pos', d: i, a: [r3(p)] });
        take.pred[i] = { t, p, at: t };
      } else {
        // Steady: carry the prediction on at the current speed.
        take.pred[i] = { t, p: expected, at: pred.at };
      }
    }
  }

  private loopSnap(deck: Deck): LoopSnap {
    const { loop, loopEdge } = deck.store.get();
    return { active: loop.active, start: r4(loop.start), end: r4(loop.end), beats: r4(loop.beats), edge: loopEdge };
  }

  private snapshot(): MixSnap {
    const s = this.session;
    const deckSnap = (deck: Deck): DeckSnap => {
      const st = deck.store.get();
      return {
        track: st.track?.id ?? null,
        pos: r3(deck.position()),
        playing: st.playing,
        cue: r4(st.cue),
        pitch: r4(st.pitch),
        range: st.range,
        speed: st.speed,
        keyLock: st.keyLock,
        keyShift: st.keyShift,
        sync: st.sync,
        quantize: st.quantize,
        quantizeBeats: st.quantizeBeats,
        slip: st.slip,
        autoLoop: st.autoLoop,
        jumpBeats: st.jumpBeats,
        hotBank: st.hotBank,
        hotGate: st.hotGate,
        loop: this.loopSnap(deck),
      };
    };
    const m = s.mixer.get();
    const f = s.fx.store.get();
    return {
      decks: [deckSnap(s.decks[0]), deckSnap(s.decks[1])],
      channels: [{ ...m.channels[0] }, { ...m.channels[1] }],
      crossfader: r4(m.crossfader),
      curve: m.curve,
      master: r4(m.master),
      fx: { type: f.type, channel: f.channel, on: f.on, depth: r4(f.depth), beats: f.beats[f.type], bands: { ...f.bands }, quantize: f.quantize, dir: f.dir },
    };
  }

  /* ── The list ─────────────────────────────────────────────────────────── */

  private async keep(mix: MoveMix) {
    await saveMoveMix(mix);
    this.store.set({ list: [mix, ...this.store.get().list.filter((m) => m.id !== mix.id)] });
  }

  delete(id: string) {
    if (this.store.get().replay?.id === id) this.stopReplay(null);
    void removeRecording(id);
    const st = this.store.get();
    this.store.set({ list: st.list.filter((m) => m.id !== id), incoming: st.incoming === id ? null : st.incoming });
  }

  rename(id: string, name: string) {
    const mix = this.store.get().list.find((m) => m.id === id);
    const n = name.trim().slice(0, 120);
    if (!mix || !n || n === mix.name) return;
    void this.keep({ ...mix, name: n });
  }

  /** A mix from a file or a link: kept with the others, marked as shared. Same id twice is one mix. */
  async addShared(mix: MoveMix): Promise<MoveMix> {
    const have = this.store.get().list.find((m) => m.id === mix.id);
    if (have) return have;
    const kept = { ...mix, shared: true };
    await this.keep(kept);
    return kept;
  }

  /** Opens a #mix= link in the address bar, then takes it out of the address so a reload doesn't add it again. */
  private async openHash() {
    const hash = location.hash;
    if (!hash.startsWith('#mix=')) return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    try {
      const mix = await mixFromHash(hash);
      if (!mix) return;
      const kept = await this.addShared(mix);
      this.store.set({ incoming: kept.id });
    } catch (err) {
      this.say(err instanceof Error ? err.message : 'That mix link couldn’t be opened.');
    }
  }

  dismissIncoming() {
    this.store.set({ incoming: null });
  }

  private say(note: string | null, ms = 9000) {
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer);
    this.noteTimer = null;
    this.store.set({ note });
    if (note && ms) this.noteTimer = window.setTimeout(() => this.store.set({ note: null }), ms);
  }

  dismissNote() {
    this.say(null);
  }

  /** Which of a mix's tracks this crate has: crate id, or undefined where it's missing. Demos are always there (they're added back if they were removed). */
  resolve(mix: MoveMix): Map<string, string | undefined> {
    const tracks = this.session.crate.get().tracks;
    const out = new Map<string, string | undefined>();
    for (const t of mix.tracks) {
      const byId = tracks.find((c) => c.id === t.id);
      const demo = t.demo ? DEMOS.find((d) => d.id === t.id) : undefined;
      const byName = tracks.find((c) => sameTrack(c, t));
      out.set(t.id, byId?.id ?? (demo ? demo.id : byName?.id));
    }
    return out;
  }

  /* ── Replay ───────────────────────────────────────────────────────────── */

  /** Replays a mix. Tracks the crate doesn't have are asked about first
   *  (the prompt); `choices` answers it: a crate track to use instead, or
   *  null to skip that track. */
  async replay(id: string, choices?: Record<string, string | null>) {
    const mix = this.store.get().list.find((m) => m.id === id);
    if (!mix) return;
    if (this.take) {
      this.say('Stop recording moves before replaying a mix.');
      return;
    }
    this.stopReplay(null);
    await this.crateLoaded();
    const found = this.resolve(mix);
    const missing = mix.tracks.filter((t) => found.get(t.id) === undefined && !(choices && t.id in choices));
    if (missing.length) {
      this.store.set({ prompt: { mixId: id, missing }, incoming: null });
      return;
    }
    const map = new Map<string, string | null>();
    for (const t of mix.tracks) map.set(t.id, found.get(t.id) ?? choices?.[t.id] ?? null);
    if (mix.tracks.some((t) => t.demo && !this.session.crate.get().tracks.some((c) => c.id === t.id))) this.session.addDemos();
    this.store.set({ prompt: null, incoming: null, note: null });
    await this.begin(mix, map);
  }

  /** Resolves once the crate has loaded (a link can be opened before it has). */
  private crateLoaded(): Promise<void> {
    const crate = this.session.crate;
    if (crate.get().loaded) return Promise.resolve();
    return new Promise((done) => {
      const off = crate.subscribe(() => {
        if (!crate.get().loaded) return;
        off();
        done();
      });
    });
  }

  cancelPrompt() {
    this.store.set({ prompt: null });
  }

  private async begin(mix: MoveMix, map: Map<string, string | null>) {
    const s = this.session;
    const token = newTrackId();
    this.preparing = token;
    this.store.set({ replay: { id: mix.id, name: mix.name, seconds: mix.seconds, at: 0, phase: 'preparing' } });
    const live = () => this.preparing === token;
    const engine = await s.ensureEngine().catch(() => null);
    if (!engine || !live()) return this.failPrepare(token, 'Audio couldn’t start, so the mix can’t replay.');
    if (s.autoDj.store.get().on) await s.autoDj.setOn(false);
    // Tracks the mix loads later: decode them now, so their loads are quick when they come.
    for (const mv of mix.moves) {
      const to = mv.m === 'load' ? map.get(mv.a?.[0] as string) : null;
      if (to) s.warmTrack(to);
    }
    const start = mix.start;
    const skip: [boolean, boolean] = [false, false];
    this.applying = true;
    try {
      s.decks.forEach((d) => d.store.get().playing && d.pause());
    } finally {
      this.applying = false;
    }
    // Each deck's starting track, with its audio.
    for (const deck of s.decks) {
      const snap = start.decks[deck.index];
      if (!snap.track) {
        // Empty when the mix began: it sits out until the mix loads it.
        skip[deck.index] = true;
        continue;
      }
      const id = map.get(snap.track) ?? null;
      if (!id) {
        skip[deck.index] = true;
        continue;
      }
      const st = deck.store.get();
      if (st.track?.id !== id || !deck.hasAudio) {
        this.applying = true;
        let loading: Promise<void>;
        try {
          loading = s.loadToDeck(id, deck.index, false);
        } finally {
          this.applying = false;
        }
        await loading;
        if (!live()) return;
      }
      if (deck.store.get().track?.id !== id || !deck.hasAudio) skip[deck.index] = true;
    }
    if (!live()) return;
    this.applying = true;
    try {
      // Sync off on both first, so each pitch lands as recorded; then back on where it was.
      s.decks.forEach((d) => d.store.get().sync && d.setSync(false));
      for (const deck of s.decks) {
        if (skip[deck.index] || !deck.store.get().track) continue;
        this.applyDeck(deck, start.decks[deck.index]);
      }
      s.decks.forEach((d) => !skip[d.index] && start.decks[d.index].sync && d.setSync(true));
      start.channels.forEach((c, i) => s.setChannel(i as 0 | 1, c));
      s.setCurve(start.curve);
      s.setCrossfader(start.crossfader);
      s.setLevels({ master: start.master });
      this.applyFx(start);
    } finally {
      this.applying = false;
    }
    // Let the seeks land before the clock starts.
    await new Promise((r) => window.setTimeout(r, 160));
    if (!live()) return;
    this.preparing = null;
    const run: Run = {
      mix,
      map,
      start: engine.now(),
      i: 0,
      timer: 0,
      skip,
      loading: [false, false],
      queue: [[], []],
      touching: [false, false],
      lastMove: [-Infinity, -Infinity],
      lastUi: 0,
    };
    this.run = run;
    this.applying = true;
    try {
      s.decks.forEach((d) => !skip[d.index] && start.decks[d.index].playing && d.store.get().track && d.play());
    } finally {
      this.applying = false;
    }
    this.store.set({ replay: { id: mix.id, name: mix.name, seconds: mix.seconds, at: 0, phase: 'playing' } });
    run.timer = window.setInterval(() => this.tick(run), 5);
    const skipped = mix.tracks.filter((t) => map.get(t.id) === null);
    if (skipped.length) this.say(`Skipping ${skipped.map((t) => `“${t.title}”`).join(', ')}: that deck sits out while it would play.`);
  }

  private failPrepare(token: string, note: string) {
    if (this.preparing !== token) return;
    this.preparing = null;
    this.store.set({ replay: null });
    this.say(note);
  }

  private applyDeck(deck: Deck, d: DeckSnap) {
    const st = deck.store.get();
    if (st.loop.active) deck.exitLoop();
    if (st.reverse) deck.setReverse(false);
    deck.setRange(d.range);
    deck.setSpeed(d.speed);
    deck.setPitch(d.pitch);
    if (st.keyLock !== d.keyLock) void deck.setKeyLock(d.keyLock);
    if (st.keyShift !== d.keyShift) void deck.setKeyShift(d.keyShift);
    deck.setQuantize(d.quantize);
    deck.setQuantizeBeats(d.quantizeBeats);
    deck.setSlip(d.slip);
    deck.setLoopBeats(d.autoLoop);
    deck.setJumpBeats(d.jumpBeats);
    deck.setHotBank(d.hotBank);
    deck.setHotGate(d.hotGate);
    // The cue point as it was, for this replay only (not saved to the track).
    deck.store.set({ cue: d.cue });
    deck.seek(d.pos);
    if (d.loop.active) this.reconcileLoop(deck, d.loop);
  }

  private applyFx(start: MixSnap) {
    const fx = this.session.fx;
    const f = start.fx;
    fx.setOn(false);
    fx.padRelease();
    fx.setType(f.type);
    fx.setChannel(f.channel);
    fx.setDepth(f.depth);
    fx.setBeats(f.beats);
    // Bands on first: the last one can't be dropped.
    (['low', 'mid', 'high'] as const).forEach((b) => fx.setBand(b, true));
    (['low', 'mid', 'high'] as const).forEach((b) => !f.bands[b] && fx.setBand(b, false));
    fx.setQuantize(f.quantize);
    fx.setDir(f.dir);
    if (f.on) fx.setOn(true);
  }

  /** Makes a deck's loop the recorded one, whatever its own quantise or grid made of the press. */
  private reconcileLoop(deck: Deck, l: LoopSnap) {
    if (!l.active) {
      if (deck.store.get().loop.active) deck.exitLoop();
      return;
    }
    if (!deck.store.get().loop.active) deck.toggleLoop();
    const cur = deck.store.get().loop;
    if (!cur.active) return;
    if (Math.abs(cur.start - l.start) > 0.001 || Math.abs(cur.end - l.end) > 0.001) {
      deck.setLoopEdge('out', Math.max(l.end, cur.end));
      deck.setLoopEdge('in', l.start);
      deck.setLoopEdge('out', l.end);
    }
    if (deck.store.get().loopEdge !== l.edge) deck.selectLoopEdge(l.edge);
  }

  private tick(run: Run) {
    if (this.run !== run) return;
    const e = this.session.engine;
    if (!e) return this.stopReplay(null);
    const rel = e.now() - run.start;
    const moves = run.mix.moves;
    this.applying = true;
    try {
      while (run.i < moves.length && moves[run.i].t <= rel) {
        const mv = moves[run.i++];
        try {
          this.apply(run, mv, rel);
        } catch {
          // One move that can't land (a deck with nothing on it) doesn't stop the mix.
        }
        if (this.run !== run) return;
      }
    } finally {
      this.applying = false;
    }
    if (run.i >= moves.length && rel >= run.mix.seconds) {
      this.stopReplay('Replay finished. The decks are yours.');
      return;
    }
    if (rel - run.lastUi >= 0.25) {
      run.lastUi = rel;
      this.store.set({ replay: { id: run.mix.id, name: run.mix.name, seconds: run.mix.seconds, at: Math.min(rel, run.mix.seconds), phase: 'playing' } });
    }
  }

  private apply(run: Run, mv: Move, rel: number) {
    const s = this.session;
    const spec = MOVES[mv.m];
    const a = mv.a ?? [];
    if (!spec) return;
    if (spec.on === 'mixer') {
      if (mv.m === 'ch') s.setChannel(mv.d ?? 0, { [a[0] as string]: a[1] });
      else if (mv.m === 'xf') s.setCrossfader(a[0] as number);
      else if (mv.m === 'curve') s.setCurve(a[0] as 'power');
      else if (mv.m === 'level') s.setLevels({ [a[0] as string]: a[1] as number });
      return;
    }
    if (spec.on === 'fx') {
      const fn = (s.fx as unknown as Record<string, Fn>)[mv.m.slice(3)];
      if (typeof fn === 'function') fn.apply(s.fx, a);
      return;
    }
    const d = mv.d ?? 0;
    const deck = s.decks[d];
    if (mv.m === 'load') return this.replayLoad(run, deck, a[0] as string, !!a[1]);
    if (run.skip[d]) return;
    if (run.loading[d] || (!deck.hasAudio && deck.store.get().track)) {
      if (mv.m === 'pos') return;
      run.queue[d].push(mv);
      if (!run.loading[d]) this.replayLoadAudio(run, deck, deck.store.get().track!.id);
      return;
    }
    if (!deck.store.get().track) return;
    this.deckMove(run, deck, mv, rel);
  }

  private deckMove(run: Run, deck: Deck, mv: Move, rel: number) {
    const d = deck.index;
    const a = mv.a ?? [];
    if (mv.m === 'pos') return this.correct(run, deck, a[0] as number, rel - mv.t, rel);
    run.lastMove[d] = rel;
    switch (mv.m) {
      case 'cueDown': {
        const cue = mv.x?.cue;
        if (typeof cue === 'number' && Math.abs(deck.store.get().cue - cue) > 0.005) deck.store.set({ cue });
        deck.cueDown();
        break;
      }
      case 'hotCueDown': {
        const slot = a[0] as number;
        const hot = mv.x?.hot;
        // Marking an empty pad changes nothing you hear, and would write a cue into the listener's track.
        if (hot === null) break;
        const have = deck.store.get().hotCues[slot];
        const same = !!have && hot !== undefined && Math.abs(have.t - hot.t) < 0.005 && !!have.loop === (hot.end !== undefined);
        if (hot === undefined || same) deck.hotCueDown(slot);
        else {
          // The listener's pad holds something else (or nothing): go where the DJ's pad went.
          deck.seek(hot.t);
          if (hot.end !== undefined) this.reconcileLoop(deck, { active: true, start: hot.t, end: hot.end, beats: 0, edge: null });
        }
        break;
      }
      case 'memJump':
        deck.store.set({ cue: a[0] as number });
        deck.seek(a[0] as number);
        break;
      case 'touch':
        run.touching[d] = !!a[0];
        deck.touch(!!a[0]);
        break;
      default: {
        const fn = (deck as unknown as Record<string, Fn>)[mv.m];
        if (typeof fn === 'function') void fn.apply(deck, a);
      }
    }
    if (mv.x?.loop) this.reconcileLoop(deck, mv.x.loop);
  }

  /** A `pos` note: pull the deck back if it's drifted from where the DJ's was. */
  private correct(run: Run, deck: Deck, p: number, late: number, rel: number) {
    const d = deck.index;
    if (run.touching[d] || rel - run.lastMove[d] < SETTLE) return;
    const st = deck.store.get();
    if (st.roll !== null || st.reverse) return;
    // A synced follower is held on its leader's beat by the sync lock: pulling it here would only fight the lock.
    if (st.sync && deck.other?.store.get().playing) return;
    const want = p + (st.playing ? deck.rate() * Math.max(0, late) : 0);
    const here = deck.position();
    const tol = st.playing ? REPLAY_TOLERANCE : REPLAY_TOLERANCE_STOPPED;
    if (Math.abs(here - want) <= tol) return;
    // Inside a loop, near its ends, the two can be a lap apart for a moment: leave it.
    if (st.loop.active) {
      const edge = 0.08;
      if (want < st.loop.start || want > st.loop.end - edge || here > st.loop.end - edge || here < st.loop.start + edge) return;
    }
    deck.seek(want);
  }

  private replayLoad(run: Run, deck: Deck, id: string, play: boolean) {
    const d = deck.index;
    const to = run.map.get(id) ?? null;
    run.queue[d] = [];
    if (!to) {
      run.skip[d] = true;
      if (deck.store.get().playing) deck.pause();
      return;
    }
    run.skip[d] = false;
    if (deck.store.get().playing) deck.pause();
    this.replayLoadAudio(run, deck, to);
    if (play) run.queue[d].push({ t: 0, m: 'play', d });
  }

  /** Loads a deck's audio, holding its moves until it's in. */
  private replayLoadAudio(run: Run, deck: Deck, id: string) {
    const d = deck.index;
    run.loading[d] = true;
    const s = this.session;
    void s.loadToDeck(id, d, false).then(() => {
      if (this.run !== run) return;
      run.loading[d] = false;
      if (deck.store.get().track?.id !== id || !deck.hasAudio) {
        run.skip[d] = true;
        run.queue[d] = [];
        return;
      }
      const e = s.engine;
      const rel = e ? e.now() - run.start : 0;
      this.applying = true;
      try {
        for (const mv of run.queue[d].splice(0)) {
          try {
            this.deckMove(run, deck, mv, rel);
          } catch {
            // As in tick.
          }
        }
      } finally {
        this.applying = false;
      }
    });
  }

  /** Stops a replay (or one getting ready), leaving the rig as it is. */
  stopReplay(note: string | null = 'Replay stopped. The decks are yours.') {
    const was = !!this.run || !!this.preparing;
    if (this.run) window.clearInterval(this.run.timer);
    this.run = null;
    this.preparing = null;
    if (!was) return;
    this.store.set({ replay: null });
    if (note) this.say(note);
  }

  /** Where the replay is, for tests and the console. */
  get replaying() {
    return !!this.run;
  }
}
