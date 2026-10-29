
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Deck } from '../engine/deck';
import { useStore } from '../engine/store';
import { useFrame, type FrameLoop } from './frame';
import s from '../platter.module.css';

/** One revolution at 33⅓ rpm: 1.8 s of audio passes under the needle. */
const SECONDS_PER_REV = 1.8;
const ARM_REST = -6; // degrees: parked beside the record
const ARM_START = 16; // on the outer groove
const ARM_END = 36; // near the label

/**
 * The platter. Its rotation is the playhead (position / 1.8 s × 360°), so it
 * spins, slows, stops and reverses exactly as the audio does — including under
 * your hand. Grab the record to scratch: the pointer's angle around the
 * spindle becomes a target position the worklet's playhead chases.
 */
export function Turntable({ deck, loop, still }: { deck: Deck; loop: FrameLoop; still: boolean }) {
  const st = useStore(deck.store);
  const spin = useRef<HTMLDivElement>(null);
  const arm = useRef<HTMLDivElement>(null);
  const grab = useRef<{ cx: number; cy: number; last: number; total: number; id: number } | null>(null);
  const [held, setHeld] = useState(false);
  const [nudge, setNudge] = useState(0);

  useFrame(loop, () => {
    const track = deck.store.get().track;
    const pos = track ? deck.position() : 0;
    if (spin.current) {
      spin.current.style.transform = still ? '' : `rotate(${((pos / SECONDS_PER_REV) * 360) % 360}deg)`;
    }
    if (arm.current) {
      const a = track ? ARM_START + (pos / track.duration) * (ARM_END - ARM_START) : ARM_REST;
      arm.current.style.transform = `rotate(${a}deg)`;
    }
  });

  const angleOf = (e: PointerEvent, cx: number, cy: number) => (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !st.track) return;
    const r = e.currentTarget.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { cx, cy, last: angleOf(e, cx, cy), total: 0, id: e.pointerId };
    deck.touch(true);
    setHeld(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    const a = angleOf(e, g.cx, g.cy);
    let d = a - g.last;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    g.last = a;
    g.total += d;
    deck.scratch((g.total / 360) * SECONDS_PER_REV);
  };

  const release = (e: PointerEvent<HTMLDivElement>) => {
    if (!grab.current || grab.current.id !== e.pointerId) return;
    grab.current = null;
    deck.touch(false);
    setHeld(false);
  };

  // Keyboard stand-in for a hand on the platter's edge: hold an arrow to nudge.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    deck.setBend(dir);
    setNudge(dir);
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].includes(e.key)) return;
    deck.setBend(0);
    setNudge(0);
  };

  return (
    <div className={s.plinth} data-deck={deck.label}>
      <div className={s.plinthLights} aria-hidden="true">
        <span className={st.playing ? s.lightOn : s.light}>33</span>
        <span className={s.light}>45</span>
      </div>
      <div
        className={`${s.platter} ${held ? s.platterHeld : ''} ${st.track ? '' : s.platterEmpty}`}
        role="slider"
        tabIndex={0}
        aria-label={`Deck ${deck.label} platter — drag the record to scratch; hold an arrow key to nudge`}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={nudge}
        aria-valuetext={nudge === 0 ? 'not nudging' : nudge > 0 ? 'nudging faster' : 'nudging slower'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => {
          if (nudge) {
            deck.setBend(0);
            setNudge(0);
          }
        }}
      >
        <div ref={spin} className={s.spin}>
          <div className={s.strobe} aria-hidden="true" />
          <div className={s.record} aria-hidden="true">
            <div className={s.grooves} />
            <div className={s.label}>
              {st.track?.artUrl ? (
                <img src={st.track.artUrl} alt="" className={s.labelArt} draggable={false} />
              ) : (
                <span className={s.labelText}>{deck.label}</span>
              )}
              <span className={s.spindle} />
            </div>
          </div>
        </div>
      </div>
      <div ref={arm} className={s.tonearm} aria-hidden="true">
        <span className={s.armPivot} />
        <span className={s.armTube} />
        <span className={s.armHead} />
      </div>
    </div>
  );
}
