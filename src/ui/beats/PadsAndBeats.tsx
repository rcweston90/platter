import type { DjSession } from '../../engine/session';
import type { FrameLoop } from '../frame';
import { BeatBoard } from './BeatBoard';
import { Pads } from './Pads';
import s from './beats.module.css';

/**
 * Pads & beats: the sampler's 64 pads and the beat board, under the decks.
 * The layout borrows from the MPC and Maschine workflow — pads on the left,
 * the sequence of the same bank on the right — as Hydrogen and LMMS do in
 * open source (UX only; no code from either, both are GPL).
 */
export function PadsAndBeats({ session, loop }: { session: DjSession; loop: FrameLoop }) {
  return (
    <section className={s.section} aria-labelledby="pads-beats-title">
      <h2 id="pads-beats-title" className={s.title}>
        Pads &amp; beats
      </h2>
      <div className={s.layout}>
        <Pads session={session} />
        <BeatBoard session={session} loop={loop} />
      </div>
    </section>
  );
}
