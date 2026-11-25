/**
 * Scroll to nudge: a mouse wheel or a two-finger trackpad scroll over a
 * deck's platter. While the deck plays, it bends the tempo for a moment, like
 * a hand on the platter's edge or a jog wheel's rim — scroll down to push it
 * ahead, up to hold it back, and it eases back to the fader's tempo a moment
 * after the scrolling stops. With Shift held and the deck paused, it moves the
 * playhead instead (a scrub), to inch to a spot without playing it.
 *
 * Only a scroll that does something is taken from the page: over a paused
 * record without Shift, or over a deck with no audio, the page scrolls as it
 * always did. Nothing outside the platter is touched.
 */

/** A wheel notch (100 px) bends by the full nudge; a trackpad's small steps by less. */
export const WHEEL_PX_FULL_BEND = 100;
/** Seconds of track a pixel of Shift-scroll moves: a wheel notch is 0.2 s. */
export const SCRUB_S_PER_PX = 0.002;
/** The bend lets go this long after the last scroll event. */
export const BEND_RELEASE_MS = 120;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  shiftKey: boolean;
}

/** The scroll's size in pixels, along whichever axis moved more: with Shift,
 *  most browsers turn a vertical wheel into a horizontal one. */
export function wheelPixels(e: WheelLike): number {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  return d * scale;
}

export type WheelAction = { kind: 'bend'; amount: number } | { kind: 'scrub'; seconds: number } | null;

/** What a scroll over the platter does, from the deck's state. `amount` is
 *  −1 … 1 of the deck's bend (deck.setBend). */
export function wheelAction(e: WheelLike, deck: { playing: boolean; hasAudio: boolean }): WheelAction {
  if (!deck.hasAudio) return null;
  const px = wheelPixels(e);
  if (!px) return null;
  if (deck.playing) return { kind: 'bend', amount: Math.max(-1, Math.min(1, px / WHEEL_PX_FULL_BEND)) };
  if (e.shiftKey) return { kind: 'scrub', seconds: px * SCRUB_S_PER_PX };
  return null;
}

export interface NudgeTarget {
  readonly hasAudio: boolean;
  store: { get(): { playing: boolean } };
  setBend(dir: number): void;
  shift(seconds: number): void;
}

/**
 * One platter's wheel handling. `handle` returns whether it used the event
 * (the caller then stops the page scrolling). Timers are injectable for tests.
 */
export class ScrollNudge {
  private timer: ReturnType<typeof setTimeout> | null = null;
  bending = 0;

  constructor(
    private deck: NudgeTarget,
    private onBend: (amount: number) => void = () => {},
    private timers: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (t) => clearTimeout(t),
    },
  ) {}

  handle(e: WheelLike): boolean {
    const act = wheelAction(e, { playing: this.deck.store.get().playing, hasAudio: this.deck.hasAudio });
    if (!act) return false;
    if (act.kind === 'scrub') {
      this.deck.shift(act.seconds);
      return true;
    }
    // A run of trackpad events holds the strongest recent push in the same
    // direction rather than flickering with each small step.
    const same = Math.sign(act.amount) === Math.sign(this.bending);
    const amount = same && Math.abs(this.bending) > Math.abs(act.amount) ? this.bending * 0.85 + act.amount * 0.15 : act.amount;
    this.setBend(amount);
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => this.release(), BEND_RELEASE_MS);
    return true;
  }

  /** Lets go of a bend now (the platter was grabbed, or unmounted). */
  release() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    if (this.bending) this.setBend(0);
  }

  private setBend(amount: number) {
    this.bending = amount;
    this.deck.setBend(amount);
    this.onBend(amount);
  }
}
