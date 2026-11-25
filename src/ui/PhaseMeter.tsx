import { useRef } from 'react';
import { wrapHalf, type Deck } from '../engine/deck';
import { setText, useFrame, type FrameLoop } from './frame';
import s from '../platter.module.css';

/** Within this many beats, the beats count as together. */
const TOGETHER = 0.02;

/**
 * How far deck B's beat is from deck A's, in beats (−½…½; positive = B
 * early), read at double or half time when that's the closer match. Null
 * unless both decks play with a tempo.
 */
export function phaseOffset(a: Deck, b: Deck): number | null {
  const sa = a.store.get();
  const sb = b.store.get();
  if (!sa.track || !sb.track || !sa.playing || !sb.playing || !sa.bpm || !sb.bpm) return null;
  const ratio = b.effectiveBpm()! / a.effectiveBpm()!;
  const mul = 2 ** Math.max(-1, Math.min(1, Math.round(Math.log2(ratio))));
  const pa = a.beatPosition();
  const pb = b.beatPosition();
  return pa == null || pb == null ? null : wrapHalf(pb - pa * mul);
}

/**
 * The phase meter: a small bar, centred when B's beats land on A's, its
 * marker sliding right when B runs early and left when it's late, with the
 * offset in beats. Shown only while both decks play.
 */
export function PhaseMeter({ decks, loop }: { decks: [Deck, Deck]; loop: FrameLoop }) {
  const box = useRef<HTMLSpanElement>(null);
  const val = useRef<HTMLSpanElement>(null);
  const shown = useRef<string>('');

  useFrame(loop, () => {
    const el = box.current;
    if (!el) return;
    const e = phaseOffset(decks[0], decks[1]);
    if (e === null) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    if (el.hidden) el.hidden = false;
    el.style.setProperty('--phase', e.toFixed(4));
    el.dataset.tone = Math.abs(e) <= TOGETHER ? 'ok' : 'warn';
    const text = `${e >= 0 ? '+' : '−'}${Math.abs(e).toFixed(2)}`;
    setText(val.current, text);
    if (text !== shown.current) {
      shown.current = text;
      el.setAttribute('aria-label', `Phase: deck B ${Math.abs(e) <= TOGETHER ? 'on deck A’s beat' : `${Math.abs(e).toFixed(2)} of a beat ${e > 0 ? 'early' : 'late'} against deck A`}`);
    }
  });

  return (
    <span ref={box} className={s.phaseMeter} role="img" hidden aria-label="Phase meter" title="Phase: how far deck B's beats are from deck A's, in beats. Centred is together; right is B early, left is B late.">
      <span className={s.phaseTrack} aria-hidden="true">
        <span className={s.phaseFill} />
        <span className={s.phaseMark} />
      </span>
      <span ref={val} className={s.phaseValue} aria-hidden="true" />
    </span>
  );
}
