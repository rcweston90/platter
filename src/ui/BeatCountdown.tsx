import { useRef } from 'react';
import { hotLetter } from '../engine/cues';
import { countdownBeats, countdownTarget } from '../engine/countdown';
import type { Deck } from '../engine/deck';
import { setText, useFrame, type FrameLoop } from './frame';
import s from '../platter.module.css';

/**
 * Bars and beats to what's next on the deck: the end of the running loop,
 * else the next hot cue or memory cue ahead — "8.2" is 8 bars and 2 beats.
 * Written straight to the DOM each frame; React renders it once.
 */
export function BeatCountdown({ deck, loop }: { deck: Deck; loop: FrameLoop }) {
  const box = useRef<HTMLSpanElement>(null);
  const tag = useRef<HTMLSpanElement>(null);
  const num = useRef<HTMLSpanElement>(null);
  const said = useRef('');

  useFrame(loop, () => {
    const el = box.current;
    if (!el) return;
    const st = deck.store.get();
    const target = st.track && st.bpm ? countdownTarget(st, deck.position(), deck.beatLength()) : null;
    if (!target) {
      setText(tag.current, '');
      setText(num.current, '–.–');
      el.dataset.kind = 'none';
      el.style.removeProperty('--cd');
      if (said.current !== 'none') {
        said.current = 'none';
        el.setAttribute('aria-label', `Deck ${deck.label} countdown: no cue ahead`);
      }
      return;
    }
    const { text, bars, rest } = countdownBeats(target.t - deck.position(), deck.beatLength());
    const what = target.kind === 'loop' ? 'LOOP' : target.kind === 'memory' ? 'MEM' : hotLetter(target.slot!);
    setText(tag.current, what);
    setText(num.current, text);
    el.dataset.kind = target.kind;
    if (target.kind === 'hot') el.style.setProperty('--cd', `var(--dj-hot-${(st.hotCues[target.slot!]?.color ?? 0) + 1})`);
    else el.style.removeProperty('--cd');
    // The label changes once a beat at most.
    const words = `${target.kind === 'loop' ? 'Loop end' : target.kind === 'memory' ? 'Memory cue' : `Hot cue ${what}`} in ${bars} ${bars === 1 ? 'bar' : 'bars'} ${rest} ${rest === 1 ? 'beat' : 'beats'}`;
    if (words !== said.current) {
      said.current = words;
      el.setAttribute('aria-label', `Deck ${deck.label} countdown: ${words}`);
    }
  });

  return (
    <span
      ref={box}
      className={s.countdown}
      role="img"
      data-kind="none"
      aria-label={`Deck ${deck.label} countdown: no cue ahead`}
      title="Bars.beats to the next hot cue or memory cue — or to the end of the running loop"
    >
      <span ref={tag} className={s.countdownTag} />
      <span ref={num} className={s.countdownNum}>
        –.–
      </span>
    </span>
  );
}
