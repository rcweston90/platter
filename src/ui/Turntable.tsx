
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { JOG_MODES, SPEEDS, type Deck, type JogMode } from '../engine/deck';
import { useStore } from '../engine/store';
import { useFrame, type FrameLoop } from './frame';
import s from '../platter.module.css';

/** One revolution at 33⅓ rpm: 1.8 s of audio passes under the needle. At 45
 *  the same groove passes 1.35× faster, so the record spins 1.35× faster too. */
const SECONDS_PER_REV = 1.8;
const ARM_REST = -6; // degrees: parked beside the record
const ARM_START = 16; // on the outer groove
const ARM_END = 36; // near the label
/** Past this fraction of the platter's radius a hand is on the rim (the
 *  strobe edge outside the record), which bends rather than scratches. */
const RIM = 0.9;
/** Rim and CDJ-mode bend: a hand turning one revolution a second bends as
 *  far as the nudge buttons; faster bends further, up to twice that. */
const BEND_PER_TURN = 1;
/** A hand that stops turning stops bending after this long. */
const BEND_IDLE_MS = 120;

const JOG_LABEL: Record<JogMode, string> = { vinyl: 'Vinyl', cdj: 'CDJ' };
const JOG_TITLE: Record<JogMode, string> = {
  vinyl: 'Vinyl: a hand on top of the record holds it and scratches; the rim bends the pitch',
  cdj: 'CDJ: the top of the platter bends the pitch like the rim; it never stops the track',
};

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
  const grab = useRef<{
    cx: number;
    cy: number;
    last: number;
    total: number;
    id: number;
    /** Scratch (hold the record) or bend (turn it faster or slower). */
    kind: 'scratch' | 'bend';
    at: number;
    v: number;
    idle: number;
  } | null>(null);
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
    // The rim bends; the top scratches in vinyl mode and bends in CDJ mode.
    // A stopped record moves under the hand either way, to find a spot.
    const rim = Math.hypot(e.clientX - cx, e.clientY - cy) > (r.width / 2) * RIM;
    const kind = !st.playing || (!rim && st.jogMode === 'vinyl') ? 'scratch' : 'bend';
    grab.current = { cx, cy, last: angleOf(e, cx, cy), total: 0, id: e.pointerId, kind, at: e.timeStamp, v: 0, idle: 0 };
    if (kind === 'scratch') deck.touch(true);
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
    if (g.kind === 'scratch') {
      deck.scratch((g.total / 360) * SECONDS_PER_REV);
      return;
    }
    // Bend by how fast the hand turns the platter, smoothed over a few moves.
    const dt = Math.max(1, e.timeStamp - g.at);
    g.at = e.timeStamp;
    const turns = (d / 360) * (1000 / dt);
    g.v = g.v * 0.6 + Math.max(-2, Math.min(2, turns * BEND_PER_TURN)) * 0.4;
    deck.setBend(g.v);
    // The platter reads out which way it's bent, as for an arrow-key nudge.
    setNudge(Math.abs(g.v) > 0.05 ? Math.sign(g.v) : 0);
    window.clearTimeout(g.idle);
    g.idle = window.setTimeout(() => {
      if (grab.current !== g) return;
      g.v = 0;
      deck.setBend(0);
      setNudge(0);
    }, BEND_IDLE_MS);
  };

  const release = (e: PointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    grab.current = null;
    if (g.kind === 'scratch') deck.touch(false);
    else {
      window.clearTimeout(g.idle);
      deck.setBend(0);
      setNudge(0);
    }
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
      <div className={s.speedGroup} role="group" aria-label={`Deck ${deck.label} platter speed`}>
        {SPEEDS.map((rpm) => (
          <button
            key={rpm}
            type="button"
            className={s.speedBtn}
            aria-pressed={st.speed === rpm}
            aria-label={rpm === 33 ? '33⅓ rpm' : '45 rpm'}
            title={rpm === 33 ? '33⅓ rpm: the record as cut' : '45 rpm: 1.35× faster, on top of the pitch fader'}
            onClick={() => deck.setSpeed(rpm)}
          >
            {rpm}
          </button>
        ))}
      </div>
      <div className={s.jogGroup} role="group" aria-label={`Deck ${deck.label} jog mode`}>
        {JOG_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={`${s.speedBtn} ${s.jogBtn}`}
            aria-pressed={st.jogMode === mode}
            title={JOG_TITLE[mode]}
            onClick={() => deck.setJogMode(mode)}
          >
            {JOG_LABEL[mode]}
          </button>
        ))}
      </div>
      <div
        className={`${s.platter} ${held ? s.platterHeld : ''} ${st.track ? '' : s.platterEmpty}`}
        data-jog={st.jogMode}
        role="slider"
        tabIndex={0}
        aria-label={`Deck ${deck.label} platter — ${
          st.jogMode === 'vinyl' ? 'drag the record to scratch' : 'turn it to bend the pitch'
        }, or turn the rim to bend; hold an arrow key to nudge`}
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
