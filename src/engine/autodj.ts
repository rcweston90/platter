import type { DjSession } from './session';
import { createStore, type Store } from './store';

export const TRANSITION_BARS = [8, 16, 32] as const;

export interface AutoDjState {
  on: boolean;
  /** Track ids still to play, next first. */
  queue: string[];
  bars: number;
  /** One line for the panel: what Auto-DJ is doing now. */
  status: string;
}

const TICK_MS = 50;
const KILL = 0.02; // EQ knob position for a killed band
const FLAT = 0.5;

/**
 * Auto-DJ: plays the queue, mixing each track into the next the way a DJ
 * would. The next track waits on the idle deck, synced to the playing one;
 * `bars` before the end it starts on its cue point (the first beat), the
 * crossfader travels across over those bars, and the bass lines swap at the
 * halfway point so the two never fight.
 */
export class AutoDj {
  readonly store: Store<AutoDjState> = createStore<AutoDjState>({ on: false, queue: [], bars: 16, status: 'Off' });
  private timer: number | null = null;
  private mix: { from: 0 | 1; start: number; seconds: number; swapped: boolean } | null = null;

  constructor(private session: DjSession) {}

  enqueue(id: string) {
    const { queue } = this.store.get();
    if (!queue.includes(id)) this.store.set({ queue: [...queue, id] });
  }

  dequeue(id: string) {
    this.store.set({ queue: this.store.get().queue.filter((q) => q !== id) });
  }

  move(id: string, dir: -1 | 1) {
    const queue = [...this.store.get().queue];
    const i = queue.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= queue.length) return;
    [queue[i], queue[j]] = [queue[j], queue[i]];
    this.store.set({ queue });
  }

  setBars(bars: number) {
    this.store.set({ bars });
  }

  async setOn(on: boolean) {
    if (!on) {
      this.stop('Off');
      return;
    }
    // Deck A is index 0 — compare with null, never test truthiness.
    if (!this.store.get().queue.length && this.playingDeck() === null) {
      this.store.set({ status: 'Add tracks to the queue first.' });
      return;
    }
    this.store.set({ on: true, status: 'Starting…' });
    if (this.playingDeck() === null) {
      // Nothing playing: the first queued track starts on deck A.
      const first = this.store.get().queue[0];
      this.dequeue(first);
      this.session.setCrossfader(-1);
      await this.session.loadToDeck(first, 0, true);
    }
    this.timer = window.setInterval(() => void this.tick(), TICK_MS);
  }

  private stop(status: string) {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.mix) this.finishMix();
    this.store.set({ on: false, status });
  }

  private playingDeck(): 0 | 1 | null {
    const [a, b] = this.session.decks.map((d) => d.store.get().playing);
    if (a && b) return this.session.mixer.get().crossfader > 0 ? 1 : 0;
    return a ? 0 : b ? 1 : null;
  }

  private async tick() {
    const { session } = this;
    if (this.mix) {
      this.stepMix();
      return;
    }
    const from = this.playingDeck();
    if (from === null) {
      this.stop('Stopped: nothing is playing.');
      return;
    }
    const to = (1 - from) as 0 | 1;
    const out = session.decks[from];
    const into = session.decks[to];
    const { queue, bars } = this.store.get();
    const next = queue[0];

    if (!next) {
      const left = out.store.get().track!.duration - out.position();
      this.store.set({ status: `Last track — ${Math.ceil(left)} s left. Queue more to keep going.` });
      return;
    }
    // Make sure the next track is waiting on the idle deck, audio and all —
    // an armed deck shows the track but would load it late, mid-mix.
    const waiting = into.store.get().track?.id === next && into.hasAudio;
    if (!waiting && !into.store.get().loading && !into.store.get().playing) {
      this.store.set({ status: 'Cueing the next track…' });
      await session.loadToDeck(next, to);
      return;
    }
    if (into.store.get().loading || !into.store.get().track) return;

    const beat = 60 / (out.effectiveBpm() ?? 120);
    const seconds = bars * 4 * beat;
    const left = out.store.get().track!.duration - out.position();
    if (left > seconds + beat) {
      this.store.set({ status: `Mixing into “${into.store.get().track!.title}” in ${Math.ceil(left - seconds)} s` });
      return;
    }

    // Go: sync, kill the incoming bass, start on the cue point.
    into.setSync(true);
    session.setChannel(to, { low: KILL });
    into.seek(into.store.get().cue);
    into.play();
    this.dequeue(next);
    this.mix = { from, start: performance.now(), seconds, swapped: false };
    this.store.set({ status: `Mixing ${bars} bars into “${into.store.get().track!.title}”` });
  }

  private stepMix() {
    const m = this.mix!;
    const t = Math.min(1, (performance.now() - m.start) / 1000 / m.seconds);
    const to = (1 - m.from) as 0 | 1;
    const dir = m.from === 0 ? 1 : -1;
    this.session.setCrossfader(-dir + 2 * dir * t);
    if (!m.swapped && t >= 0.5) {
      m.swapped = true;
      this.session.setChannel(to, { low: FLAT });
      this.session.setChannel(m.from, { low: KILL });
    }
    if (t >= 1) this.finishMix();
  }

  private finishMix() {
    const m = this.mix;
    if (!m) return;
    this.mix = null;
    const out = this.session.decks[m.from];
    out.pause();
    this.session.setChannel(m.from, { low: FLAT });
    this.session.setChannel((1 - m.from) as 0 | 1, { low: FLAT });
    this.session.setCrossfader(m.from === 0 ? 1 : -1);
    if (this.store.get().on) this.store.set({ status: 'Mixed. Cueing the next track…' });
  }
}
