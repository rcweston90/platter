import type { Deck } from '../engine/deck';
import type { DjSession } from '../engine/session';
import { createStore, type Store } from '../engine/store';
import { controlById, readControl, resolveValue, type ControlValue, type GuideControl } from './registry';
import { addRing, removeRing } from './rings';

/**
 * The action runner: timed moves on controls, in beats and bars of the
 * playing deck's tempo. "Crossfader to centre over 8 bars", "kill deck A's
 * low at the next bar" — several at once, each ringed and tagged with its
 * value while it moves, with a status line and a Stop.
 *
 * Time is counted in beats on a clock that follows the tempo deck: while
 * that deck plays steadily the clock is its own beat position, so moves land
 * with the music; across a jump, a loop's wrap or a stop it carries on at the
 * deck's tempo by the wall clock, so a scratch never runs a fade backwards.
 * Moves are applied once per animation frame (about 16 ms), close enough for
 * a fade or a kill on the bar.
 *
 * The user always wins. Any press, key or wheel outside the guide's panel
 * stops the run, and so does a moved control turning up at a value the
 * runner didn't set (a MIDI fader, a keyboard shortcut).
 */

export type MoveStart = 'now' | 'next_beat' | 'next_bar';

/** One move, as a model or the demo asks for it. */
export interface MoveSpec {
  /** Registry id. */
  control: string;
  /** Target: a number, a preset name, true/false, a choice. */
  to: unknown;
  /** When to start counting: now (default), the next beat, the next bar. */
  start?: MoveStart;
  /** Beats after that start before this move begins. */
  after_beats?: number;
  /** Beats to get there; 0 (default) jumps there. Toggles and choices always jump. */
  over_beats?: number;
}

export interface RunMoveView {
  id: string;
  name: string;
  state: 'waiting' | 'moving' | 'done';
}

export interface RunState {
  running: boolean;
  /** One line: where the run is, or how it ended. */
  status: string;
  /** How it ended, once it has. */
  ended: 'done' | 'stopped' | 'touched' | null;
  moves: RunMoveView[];
}

interface LiveMove {
  c: GuideControl;
  to: ControlValue;
  /** On the run's beat clock. */
  at: number;
  over: number;
  state: RunMoveView['state'];
  from: number;
  /** What the runner last left the control at, to notice a hand on it. */
  last: number;
}

const BEATS_PER_BAR = 4;
const DEFAULT_BPM = 120;

const mod = (a: number, n: number) => ((a % n) + n) % n;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const beatsText = (b: number) =>
  b % BEATS_PER_BAR === 0 && b >= BEATS_PER_BAR ? plural(b / BEATS_PER_BAR, 'bar') : plural(Math.round(b * 100) / 100, 'beat');

/** Inside the guide's panel: presses there (Stop, chips, typing) aren't a hand on the rig. */
const inGuide = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-booth-guide]');

export class MoveRunner {
  readonly store: Store<RunState> = createStore<RunState>({ running: false, status: '', ended: null, moves: [] });
  /** Called when a run starts, with the controls it moves (to show them on a phone). */
  onStart?: (controls: GuideControl[]) => void;

  private moves: LiveMove[] = [];
  private raf = 0;
  private beats = 0;
  private lastPos: number | null = null;
  private lastT = 0;
  private tempo: Deck | null = null;
  private status = '';
  /** Where bar 1 starts on the run's clock: the next bar, when a move waits for it. */
  private origin = 0;

  constructor(private session: DjSession) {}

  /** The deck whose tempo the run counts in: the one asked for, else the
   *  playing deck (the sync leader when both play), else deck A. */
  tempoDeck(from: 'A' | 'B' | 'auto' = 'auto'): Deck {
    const [A, B] = this.session.decks;
    if (from === 'A') return A;
    if (from === 'B') return B;
    const a = A.store.get();
    const b = B.store.get();
    if (a.playing && b.playing) return a.sync && !b.sync ? B : A;
    if (b.playing) return B;
    return A;
  }

  /** Checks moves without running them; errors name each bad one. */
  check(specs: MoveSpec[]): { errors: string[] } {
    const errors: string[] = [];
    if (!Array.isArray(specs) || specs.length === 0) errors.push('no moves given');
    else
      specs.forEach((m, i) => {
        const c = typeof m?.control === 'string' ? controlById(m.control) : undefined;
        if (!c) errors.push(`move ${i + 1}: unknown control "${String(m?.control)}"`);
        else if (resolveValue(c, m.to) === null) errors.push(`move ${i + 1}: ${c.name} can't take ${JSON.stringify(m.to)}`);
        if (m?.start && !['now', 'next_beat', 'next_bar'].includes(m.start)) errors.push(`move ${i + 1}: start must be now, next_beat or next_bar`);
      });
    return { errors };
  }

  /** Starts a run (stopping any run already going). */
  run(specs: MoveSpec[], opts: { tempoFrom?: 'A' | 'B' | 'auto' } = {}): { ok: true; summary: string } | { ok: false; error: string } {
    const { errors } = this.check(specs);
    if (errors.length) return { ok: false, error: errors.join('; ') };
    if (this.store.get().running) this.stop('Replaced by a new run.', 'stopped');

    const deck = this.tempoDeck(opts.tempoFrom);
    this.tempo = deck;
    this.beats = 0;
    this.lastT = performance.now();
    this.lastPos = deck.store.get().playing ? deck.beatPosition() : null;
    // How far the next beat and the next bar are, on the tempo deck's grid.
    const phase = this.lastPos;
    const toBeat = phase === null ? 0 : mod(-phase, 1);
    const toBar = phase === null ? 0 : mod(-phase, BEATS_PER_BAR);
    const anchor = (s: MoveStart | undefined) => (s === 'next_bar' ? toBar : s === 'next_beat' ? toBeat : 0);

    this.moves = specs.map((m) => {
      const c = controlById(m.control)!;
      return {
        c,
        to: resolveValue(c, m.to)!,
        at: anchor(m.start) + Math.max(0, Number(m.after_beats) || 0),
        over: c.kind === 'range' ? Math.max(0, Number(m.over_beats) || 0) : 0,
        state: 'waiting',
        from: 0,
        last: 0,
      } satisfies LiveMove;
    });
    this.origin = specs.some((m) => m.start === 'next_bar') ? toBar : 0;
    // Same start time: in the order given.
    this.moves.sort((a, b) => a.at - b.at);

    const length = Math.max(...this.moves.map((m) => m.at + m.over)) - this.origin;
    const bpm = Math.round(deck.effectiveBpm() ?? DEFAULT_BPM);
    const summary = `${plural(this.moves.length, 'move')} over ${beatsText(Math.max(1, Math.ceil(length)))} at ${bpm} BPM (deck ${deck.label}${deck.effectiveBpm() ? '' : ', no tempo yet: 120'})`;
    this.status = '';
    this.store.set({ running: true, ended: null, status: `Starting: ${summary}`, moves: this.views() });

    for (const c of new Set(this.moves.map((m) => m.c))) addRing({ id: c.id, tone: 'move', text: () => this.tag(c) });
    this.onStart?.(this.moves.map((m) => m.c));

    window.addEventListener('pointerdown', this.onHand, true);
    window.addEventListener('keydown', this.onHand, true);
    window.addEventListener('wheel', this.onHand, { capture: true, passive: true });
    this.tick();
    return { ok: true, summary };
  }

  /** Stops the run where it is: every control stays where it got to. */
  stop(why = 'Stopped.', ended: 'stopped' | 'touched' = 'stopped') {
    if (!this.store.get().running) return false;
    this.finish(why, ended);
    return true;
  }

  dispose() {
    this.stop();
  }

  private finish(status: string, ended: RunState['ended']) {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('pointerdown', this.onHand, true);
    window.removeEventListener('keydown', this.onHand, true);
    window.removeEventListener('wheel', this.onHand, true);
    for (const m of this.moves) removeRing(m.c.id);
    this.store.set({ running: false, ended, status, moves: this.views() });
  }

  private onHand = (e: Event) => {
    if (inGuide(e.target)) return;
    // Modifier keys alone (a Shift held to read a tooltip) aren't a move.
    if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    this.stop('Stopped: you took over the controls.', 'touched');
  };

  private views(): RunMoveView[] {
    return this.moves.map((m) => ({ id: m.c.id, name: m.c.name, state: m.state }));
  }

  /** A ringed control's tag: its value while it moves, else what's coming. */
  private tag(c: GuideControl): string {
    const mine = this.moves.filter((m) => m.c === c);
    const m = mine.find((x) => x.state === 'moving') ?? mine.find((x) => x.state === 'waiting') ?? mine[mine.length - 1];
    const now = c.kind === 'press' ? 'pressed' : readControl(this.session, c).text;
    if (m.state === 'waiting') {
      const target = this.describe(m.c, m.to);
      const wait = m.at - this.beats;
      return `${m.c.name}: → ${target} in ${wait < 1 ? 'under a beat' : beatsText(Math.ceil(wait))}`;
    }
    return `${m.c.name}: ${now}`;
  }

  private describe(c: GuideControl, v: ControlValue): string {
    switch (c.kind) {
      case 'range':
        return c.format(v as number);
      case 'toggle':
        return c.format ? c.format(v as boolean) : v ? 'on' : 'off';
      case 'choice':
        return c.choices.find((x) => x.value === v)?.label ?? String(v);
      case 'press':
        return 'press';
    }
  }

  /** Advances the beat clock from the tempo deck. */
  private clock() {
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastT) / 1000);
    this.lastT = now;
    const deck = this.tempo!;
    const bpm = deck.effectiveBpm() ?? DEFAULT_BPM;
    const wall = (dt * bpm) / 60;
    const pos = deck.store.get().playing ? deck.beatPosition() : null;
    let step = wall;
    // Steady play: follow the record's own beats (within reason).
    if (pos !== null && this.lastPos !== null) {
      const d = pos - this.lastPos;
      if (d >= 0 && d < wall * 2 + 0.05) step = d;
    }
    this.lastPos = pos;
    this.beats += step;
    return bpm;
  }

  private tick = () => {
    if (!this.store.get().running) return;
    const bpm = this.clock();
    const s = this.session;
    let changed = false;

    for (const m of this.moves) {
      if (m.state === 'done' || this.beats < m.at) continue;
      const c = m.c;
      if (m.state === 'waiting') {
        changed = true;
        // A newer move on the same control takes over from an older one.
        for (const o of this.moves) if (o !== m && o.c === c && o.state === 'moving') o.state = 'done';
        if (c.kind === 'range') {
          m.from = c.read(s);
          if (m.over <= 0) {
            c.write(s, m.to as number);
            m.state = 'done';
          } else {
            m.state = 'moving';
            m.last = m.from;
          }
        } else {
          if (c.kind === 'toggle') c.write(s, m.to as boolean);
          else if (c.kind === 'choice') c.write(s, m.to as string);
          else c.press(s);
          m.state = 'done';
        }
        if (m.state === 'done') this.ringDone(m);
        continue;
      }
      // Moving: a range on its way.
      if (c.kind !== 'range') continue;
      const here = c.read(s);
      if (Math.abs(here - m.last) > (c.max - c.min) * 0.004 + 1e-6) {
        this.stop(`Stopped: ${c.name} was moved by hand.`, 'touched');
        return;
      }
      const t = Math.min(1, (this.beats - m.at) / m.over);
      const v = m.from + ((m.to as number) - m.from) * t;
      c.write(s, c.integer ? Math.round(v) : v);
      m.last = c.read(s);
      if (t >= 1) {
        m.state = 'done';
        changed = true;
        this.ringDone(m);
      }
    }

    if (changed) this.store.set({ moves: this.views() });
    if (this.moves.every((m) => m.state === 'done')) {
      this.finish(`Done: ${plural(this.moves.length, 'move')}.`, 'done');
      return;
    }
    this.setStatus(bpm);
    this.raf = requestAnimationFrame(this.tick);
  };

  /** A finished move's ring stays a moment showing where it landed. */
  private ringDone(m: LiveMove) {
    const others = this.moves.some((o) => o !== m && o.c === m.c && o.state !== 'done');
    if (others) return;
    const text = `${m.c.name}: ${m.c.kind === 'press' ? 'pressed' : readControl(this.session, m.c).text}`;
    addRing({ id: m.c.id, tone: 'move', text: () => text, until: performance.now() + 900 });
  }

  private setStatus(bpm: number) {
    const at = this.beats - this.origin;
    const bar = Math.floor(at / BEATS_PER_BAR) + 1;
    const beat = Math.floor(mod(at, BEATS_PER_BAR)) + 1;
    const length = Math.max(...this.moves.map((m) => m.at + m.over)) - this.origin;
    const bars = Math.max(1, Math.ceil(length / BEATS_PER_BAR));
    const moving = this.moves.filter((m) => m.state === 'moving').map((m) => m.c.name);
    const waiting = this.moves.filter((m) => m.state === 'waiting').length;
    const what = moving.length ? `moving ${moving.join(', ')}` : waiting ? `${plural(waiting, 'move')} to come` : '';
    const where = at < 0 ? `Waiting for the next bar (${Math.ceil(-at)})` : `Bar ${Math.min(bar, bars)}.${beat} of ${bars}`;
    const text = `${where} · ${Math.round(bpm)} BPM, deck ${this.tempo!.label}${what ? ` · ${what}` : ''}`;
    if (text !== this.status) {
      this.status = text;
      this.store.set({ status: text });
    }
  }
}
