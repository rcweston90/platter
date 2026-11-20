import type { Deck } from './deck';
import type { DjEngine } from './engine';
import { getValue, setValue } from './library';
import { PADS_PER_BANK, type Sampler } from './sampler';
import { getSound } from './sounds/catalog';
import type { Role } from './sounds/characters';
import { GROOVES, parseLane } from './sounds/grooves';
import { createStore, type Store } from './store';

/**
 * The beat board: a 16-lane step sequencer playing one bank of the sampler.
 * It locks to a deck — the tempo and the beat grid, so step 1 lands on the
 * track's downbeat and a hot-cue jump or loop takes the beat with it — or
 * runs on its own clock when no deck is playing.
 *
 * Timing is the lookahead pattern from Chris Wilson's "A Tale of Two Clocks"
 * (github.com/cwilso/metronome, MIT): a coarse JS timer schedules every hit a
 * little ahead on the sample-accurate audio clock. Swing is MPC-style: 50% is
 * straight, 66% a triplet shuffle, 75% dotted; it delays every second 16th.
 * The step-grid workflow follows Hydrogen and LMMS's beat editors (UX only,
 * no code: both are GPL).
 */

export const LANES = PADS_PER_BANK;
export const PATTERNS = 8;
export const MAX_STEPS = 32;
export type StepCount = 16 | 32;
/** Off, on, accent. */
export type StepValue = 0 | 1 | 2;
export type TempoSource = 'auto' | 'A' | 'B' | 'free';

export interface Pattern {
  length: StepCount;
  /** [lane][step], always MAX_STEPS long. */
  steps: StepValue[][];
}

export interface Lane {
  /** 0–1. */
  gain: number;
  mute: boolean;
  solo: boolean;
}

export interface BeatState {
  playing: boolean;
  recording: boolean;
  /** Which sampler bank the lanes play. */
  bank: number;
  patterns: Pattern[];
  current: number;
  /** A pattern waiting for the end of the bar. */
  queued: number | null;
  lanes: Lane[];
  /** 50–75. */
  swing: number;
  tempo: TempoSource;
  freeBpm: number;
  /** 0–1, 0.8 = 0 dB. */
  level: number;
  /** The deck it is locked to right now, if any. */
  following: 0 | 1 | null;
  /** The tempo it is playing at, to 0.1 BPM. */
  bpm: number;
}

interface Saved {
  v: 1;
  bank: number;
  patterns: Pattern[];
  current: number;
  lanes: Lane[];
  swing: number;
  tempo: TempoSource;
  freeBpm: number;
  level: number;
}

const LOOKAHEAD = 0.12;
const TICK_MS = 25;

const emptyPattern = (length: StepCount = 16): Pattern => ({
  length,
  steps: Array.from({ length: LANES }, () => Array<StepValue>(MAX_STEPS).fill(0)),
});

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Which lane plays a groove's role: the pad whose role matches, else one whose sound fits. */
const ROLE_FALLBACK: Partial<Record<Role, string[]>> = {
  kick: ['kick'],
  snare: ['snare', 'clap'],
  clap: ['clap', 'snare'],
  chh: ['hat'],
  ohh: ['hat'],
  rim: ['perc'],
  shaker: ['perc'],
  percA: ['perc'],
  percB: ['perc'],
  bass: ['bass'],
};

export class BeatBoard {
  readonly store: Store<BeatState>;
  private engine: DjEngine | null = null;
  private timer = 0;
  /** The next absolute step to schedule (step 0 = the deck's first beat). */
  private next = 0;
  /** Free-running clock: step `step` sounds at context time `time`. */
  private anchor: { time: number; step: number; sps: number } | null = null;
  private locked: 0 | 1 | null = null;
  /** Scheduled steps, for the playhead and for recording. */
  private history: { when: number; step: number; index: number }[] = [];
  private taps: number[] = [];
  private saveTimer = 0;
  private ready = false;

  constructor(
    private sampler: Sampler,
    private decks: [Deck, Deck],
    /** How loud each deck is on the master (fader × crossfader), for Auto. */
    private weight: (i: 0 | 1) => number,
  ) {
    this.store = createStore<BeatState>({
      playing: false,
      recording: false,
      bank: 1,
      patterns: Array.from({ length: PATTERNS }, () => emptyPattern()),
      current: 0,
      queued: null,
      lanes: Array.from({ length: LANES }, () => ({ gain: 0.8, mute: false, solo: false })),
      swing: 54,
      tempo: 'auto',
      freeBpm: 120,
      level: 0.8,
      following: null,
      bpm: 120,
    });
    this.applyGroove('four', 0);
    sampler.onHit((h) => {
      if (h.from !== 'live') return;
      const s = this.store.get();
      if (!s.playing || !s.recording) return;
      const lane = h.pad - s.bank * PADS_PER_BANK;
      if (lane < 0 || lane >= LANES) return;
      this.recordHit(lane);
    });
  }

  async init() {
    const saved = await getValue<Saved>('beats-v1');
    if (saved?.v === 1 && saved.patterns?.length === PATTERNS) {
      this.store.set({
        bank: saved.bank,
        patterns: saved.patterns,
        current: Math.min(PATTERNS - 1, saved.current | 0),
        lanes: saved.lanes,
        swing: saved.swing,
        tempo: saved.tempo,
        freeBpm: saved.freeBpm,
        level: saved.level,
      });
    }
    this.ready = true;
    this.store.subscribe(() => this.scheduleSave());
  }

  private scheduleSave() {
    if (!this.ready) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const s = this.store.get();
      const saved: Saved = { v: 1, bank: s.bank, patterns: s.patterns, current: s.current, lanes: s.lanes, swing: s.swing, tempo: s.tempo, freeBpm: s.freeBpm, level: s.level };
      void setValue('beats-v1', saved);
    }, 600);
  }

  attach(engine: DjEngine) {
    this.engine = engine;
  }

  /* ── Transport ────────────────────────────────────────────────────────── */

  play() {
    if (!this.engine || this.store.get().playing) return;
    this.sampler.warm(this.store.get().bank);
    this.anchor = null;
    this.locked = null;
    this.history = [];
    this.store.set({ playing: true, queued: null });
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.history = [];
    if (this.store.get().playing) this.store.set({ playing: false, queued: null, following: null });
  }

  toggle() {
    if (this.store.get().playing) this.stop();
    else this.play();
  }

  /** The deck to lock to now, if any. */
  private source(): 0 | 1 | null {
    const { tempo } = this.store.get();
    if (tempo === 'free') return null;
    const usable = (i: 0 | 1) => {
      const d = this.decks[i];
      const st = d.store.get();
      return st.playing && !!st.bpm && d.rate() > 0.3;
    };
    if (tempo === 'A' || tempo === 'B') {
      const i = tempo === 'A' ? 0 : 1;
      return usable(i) ? i : null;
    }
    const a = usable(0);
    const b = usable(1);
    if (a && b) {
      // A synced deck follows the other, so the other leads; else the louder one.
      if (this.decks[0].store.get().sync !== this.decks[1].store.get().sync) return this.decks[0].store.get().sync ? 1 : 0;
      if (this.locked !== null && Math.abs(this.weight(0) - this.weight(1)) < 0.25) return this.locked;
      return this.weight(0) >= this.weight(1) ? 0 : 1;
    }
    return a ? 0 : b ? 1 : null;
  }

  private tick() {
    const engine = this.engine;
    const s = this.store.get();
    if (!engine || !s.playing) return;
    const ctx = engine.ctx;
    const now = engine.now();
    const horizon = ctx.currentTime + LOOKAHEAD;
    const swingAt = (k: number, sps: number) => (k % 2 !== 0 ? ((s.swing - 50) / 50) * sps : 0);
    const src = this.source();
    let bpm: number;

    if (src !== null) {
      const d = this.decks[src];
      const st = d.store.get();
      const beat = 60 / st.bpm!;
      const rate = d.rate();
      const sNow = ((d.position() - st.gridOffset) / beat) * 4;
      const sps = beat / 4 / rate;
      bpm = st.bpm! * rate;
      // Took over from the free clock, or the deck jumped (cue, loop, beat jump).
      if (this.locked !== src || this.next < sNow - 1 || this.next > sNow + 6) this.next = Math.ceil(sNow);
      this.locked = src;
      for (;;) {
        const t = now + (this.next - sNow) * sps + swingAt(this.next, sps);
        if (t > horizon) break;
        if (t >= ctx.currentTime - 0.008) this.fire(this.next, t);
        this.next++;
      }
      this.anchor = { time: now + (this.next - sNow) * sps, step: this.next, sps };
    } else {
      bpm = this.locked !== null ? s.bpm : s.freeBpm;
      if (this.locked !== null) this.store.set({ freeBpm: Math.round(bpm * 10) / 10 });
      this.locked = null;
      const sps = 60 / bpm / 4;
      if (!this.anchor) this.anchor = { time: ctx.currentTime + 0.06, step: this.next = 0, sps };
      else if (Math.abs(this.anchor.sps - sps) > 1e-6) {
        // Tempo change: keep the next step where it is, change the spacing after it.
        this.anchor = { time: this.anchor.time + (this.next - this.anchor.step) * this.anchor.sps, step: this.next, sps };
      }
      const a = this.anchor;
      for (;;) {
        const t = a.time + (this.next - a.step) * a.sps + swingAt(this.next, a.sps);
        if (t > horizon) break;
        if (t >= ctx.currentTime - 0.008) this.fire(this.next, t);
        this.next++;
      }
    }

    const shown = Math.round(bpm * 10) / 10;
    if (shown !== s.bpm || src !== s.following) this.store.set({ bpm: shown, following: src });
  }

  private fire(step: number, when: number) {
    let s = this.store.get();
    let pat = s.patterns[s.current];
    let index = mod(step, pat.length);
    if (index === 0 && s.queued !== null) {
      this.store.set({ current: s.queued, queued: null });
      s = this.store.get();
      pat = s.patterns[s.current];
      index = mod(step, pat.length);
    }
    this.history.push({ when, step, index });
    if (this.history.length > 96) this.history.splice(0, this.history.length - 96);
    const soloed = s.lanes.some((l) => l.solo);
    const level = (s.level / 0.8) ** 2;
    for (let l = 0; l < LANES; l++) {
      const v = pat.steps[l][index];
      const lane = s.lanes[l];
      if (!v || lane.mute || (soloed && !lane.solo)) continue;
      void this.sampler.hit(s.bank * PADS_PER_BANK + l, { when, velocity: v === 2 ? 1 : 0.72, from: 'board', gain: lane.gain * level * 1.25 });
    }
  }

  /** The step being heard now, or null when stopped. */
  heardStep(): number | null {
    if (!this.engine || !this.store.get().playing) return null;
    const now = this.engine.now();
    let found: number | null = null;
    for (const h of this.history) {
      if (h.when <= now + 0.004) found = h.index;
      else break;
    }
    return found;
  }

  /* ── Recording ────────────────────────────────────────────────────────── */

  setRecording(on: boolean) {
    this.store.set({ recording: on });
  }

  /** Puts a live pad hit on the nearest step to what you heard. */
  private recordHit(lane: number) {
    if (!this.engine || !this.history.length) return;
    const heard = this.engine.now();
    let best = this.history[0];
    for (const h of this.history) if (Math.abs(h.when - heard) < Math.abs(best.when - heard)) best = h;
    const s = this.store.get();
    const steps = s.patterns[s.current].steps[lane];
    if (steps[best.index]) return;
    this.setStep(lane, best.index, 1);
  }

  /* ── Editing ──────────────────────────────────────────────────────────── */

  private editPattern(fn: (p: Pattern) => Pattern, which = this.store.get().current) {
    const patterns = [...this.store.get().patterns];
    patterns[which] = fn(patterns[which]);
    this.store.set({ patterns });
  }

  setStep(lane: number, step: number, value: StepValue) {
    this.editPattern((p) => {
      const steps = p.steps.map((row, l) => (l === lane ? row.map((v, i) => (i === step ? value : v)) : row));
      return { ...p, steps };
    });
  }

  /** Click: off → on → off. Accent comes from Shift, or the accent tool. */
  cycleStep(lane: number, step: number, accent = false) {
    const v = this.store.get().patterns[this.store.get().current].steps[lane][step];
    this.setStep(lane, step, accent ? (v === 2 ? 0 : 2) : v ? 0 : 1);
  }

  setLength(length: StepCount) {
    this.editPattern((p) => {
      if (length === p.length) return p;
      // Doubling copies the bar, the way hardware does, so nothing goes quiet.
      const steps = length > p.length ? p.steps.map((row) => row.map((v, i) => (i < p.length ? v : row[i - p.length]))) : p.steps;
      return { length, steps };
    });
  }

  clearPattern() {
    this.editPattern((p) => emptyPattern(p.length));
  }

  copyPattern(from: number, to: number) {
    const src = this.store.get().patterns[from];
    this.editPattern(() => ({ length: src.length, steps: src.steps.map((r) => [...r]) }), to);
  }

  /** Switch now when stopped; at the end of the bar while playing. */
  selectPattern(i: number) {
    const s = this.store.get();
    if (!s.playing || i === s.current) this.store.set({ current: i, queued: null });
    else this.store.set({ queued: i === s.queued ? null : i });
  }

  clearLane(lane: number) {
    this.editPattern((p) => ({ ...p, steps: p.steps.map((r, l) => (l === lane ? r.map(() => 0 as StepValue) : r)) }));
  }

  /** Every `every` steps from `offset` (1 = all sixteenths, 4 = quarter notes). */
  fillLane(lane: number, every: number, offset = 0) {
    this.editPattern((p) => ({
      ...p,
      steps: p.steps.map((r, l) => (l === lane ? r.map((_, i) => (i >= offset && (i - offset) % every === 0 ? 1 : 0) as StepValue) : r)),
    }));
  }

  /** Shifts a lane by one step, wrapping round. */
  rotateLane(lane: number, by: 1 | -1) {
    this.editPattern((p) => ({
      ...p,
      steps: p.steps.map((r, l) => {
        if (l !== lane) return r;
        const out = [...r];
        for (let i = 0; i < p.length; i++) out[mod(i + by, p.length)] = r[i];
        return out;
      }),
    }));
  }

  setLane(lane: number, patch: Partial<Lane>) {
    const lanes = [...this.store.get().lanes];
    lanes[lane] = { ...lanes[lane], ...patch };
    this.store.set({ lanes });
  }

  setBank(bank: number) {
    this.store.set({ bank });
    this.sampler.warm(bank);
  }

  setSwing(swing: number) {
    this.store.set({ swing: Math.max(50, Math.min(75, Math.round(swing))) });
  }

  setTempo(tempo: TempoSource) {
    this.store.set({ tempo });
  }

  setFreeBpm(bpm: number) {
    this.store.set({ freeBpm: Math.max(40, Math.min(220, Math.round(bpm * 10) / 10)) });
  }

  setLevel(level: number) {
    this.store.set({ level });
  }

  /** Tap tempo for the free clock: the average of the last few taps. */
  tap() {
    const t = performance.now();
    this.taps = this.taps.filter((x) => t - x < 2500);
    this.taps.push(t);
    if (this.taps.length < 2) return;
    const gaps = this.taps.slice(1).map((x, i) => x - this.taps[i]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    this.store.set({ tempo: 'free' });
    this.setFreeBpm(60000 / avg);
  }

  /** Writes a starter groove onto the current pattern, matched to the kit's pads. */
  applyGroove(id: string, which = this.store.get().current) {
    const g = GROOVES.find((x) => x.id === id);
    if (!g) return;
    const bank = this.store.get().bank;
    const pads = this.sampler.store.get().pads.slice(bank * PADS_PER_BANK, (bank + 1) * PADS_PER_BANK);
    const used = new Set<number>();
    const laneFor = (role: Role) => {
      let l = pads.findIndex((p, i) => !used.has(i) && p.role === role);
      if (l < 0) {
        const cats = ROLE_FALLBACK[role] ?? [];
        l = pads.findIndex((p, i) => !used.has(i) && p.sound && cats.includes(getSound(p.sound)?.category ?? ''));
      }
      if (l >= 0) used.add(l);
      return l;
    };
    const length: StepCount = Object.values(g.lanes).some((t) => t && t.length > 16) ? 32 : 16;
    const p = emptyPattern(length);
    for (const [role, text] of Object.entries(g.lanes) as [Role, string][]) {
      const lane = laneFor(role);
      if (lane < 0) continue;
      p.steps[lane] = parseLane(text, MAX_STEPS) as StepValue[];
    }
    this.editPattern(() => p, which);
    this.setSwing(g.swing);
  }
}
