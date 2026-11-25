import type { HotCue } from './types';

/**
 * The beat countdown: bars and beats from the playhead to what comes next —
 * the end of the running loop, else the next hot cue or memory cue ahead.
 * Read in beats of the track's grid, so it holds whatever the pitch.
 */

export interface CountdownTarget {
  /** Seconds into the track. */
  t: number;
  kind: 'loop' | 'hot' | 'memory';
  /** The hot cue's slot, for its letter and colour. */
  slot?: number;
}

/** Beat fraction under which a cue counts as reached (not still ahead). */
const PASSED = 0.02;

/** What the countdown counts to from `pos`, or null when nothing lies ahead. */
export function countdownTarget(
  st: { hotCues: readonly (HotCue | null)[]; memoryCues: readonly number[]; loop: { active: boolean; start: number; end: number } },
  pos: number,
  beatLen: number,
): CountdownTarget | null {
  const eps = beatLen * PASSED;
  if (st.loop.active && st.loop.end > st.loop.start && pos < st.loop.end) return { t: st.loop.end, kind: 'loop' };
  let best: CountdownTarget | null = null;
  for (let slot = 0; slot < st.hotCues.length; slot++) {
    const c = st.hotCues[slot];
    if (c && c.t > pos + eps && (!best || c.t < best.t)) best = { t: c.t, kind: 'hot', slot };
  }
  for (const m of st.memoryCues) {
    // A hot cue on the same spot wins: it has a letter and a colour.
    if (m > pos + eps && (!best || m < best.t - eps)) best = { t: m, kind: 'memory' };
  }
  return best;
}

/**
 * Whole beats to go, as bars and beats: 34 beats is 8 bars 2 beats, "8.2".
 * Counted up, so the number changes as each beat passes and reads "0.1" for
 * the last beat before the target.
 */
export function countdownBeats(remain: number, beatLen: number): { beats: number; bars: number; rest: number; text: string } {
  const beats = Math.max(0, Math.ceil(remain / beatLen - PASSED));
  const bars = Math.floor(beats / 4);
  const rest = beats % 4;
  return { beats, bars, rest, text: `${bars}.${rest}` };
}
