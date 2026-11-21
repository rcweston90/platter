import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { useStore } from '../../engine/store';
import { DOCK_MIN, RIG_MIN, defaultDockHeight, dockHeight, setDockHeight, toggleDockMax } from './dock';
import l from './library.module.css';

/** The room the dock may take: from its own minimum up to everything under
 *  the pinned waveforms but a strip of the rig. */
function bounds(rig: HTMLElement | null) {
  const vh = window.innerHeight;
  const top = rig ? rig.getBoundingClientRect().top : 0;
  // 12px root padding at the bottom, 12px handle.
  const max = Math.max(DOCK_MIN, Math.round(vh - top - RIG_MIN - 24));
  return { vh, max };
}

/**
 * The dock's height for the docked layout, in px: what was dragged to (kept
 * between visits), or the default, held inside what the window allows.
 */
export function useDockSize(rig: RefObject<HTMLElement | null>, docked: boolean) {
  const { px, max: maxed } = useStore(dockHeight);
  const [room, setRoom] = useState(() => ({ vh: window.innerHeight, max: window.innerHeight }));
  useEffect(() => {
    if (!docked) return;
    const on = () => setRoom(bounds(rig.current));
    on();
    window.addEventListener('resize', on);
    // What's pinned above the rig (the top bar can wrap as its status changes).
    const pinned = rig.current?.parentElement?.firstElementChild;
    const ro = pinned && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(on) : null;
    if (pinned) ro?.observe(pinned);
    return () => {
      window.removeEventListener('resize', on);
      ro?.disconnect();
    };
  }, [rig, docked]);
  const want = maxed ? room.max : (px ?? defaultDockHeight(room.vh));
  return { height: Math.max(DOCK_MIN, Math.min(want, room.max)), max: room.max, maxed };
}

/**
 * The handle between the decks and the library. Drag it, or focus it and use
 * the arrow keys (Shift for bigger steps, Home and End for the limits).
 * Double-click gives the library the window, and again puts it back.
 */
export function Splitter({ height, max, rig }: { height: number; max: number; rig: RefObject<HTMLElement | null> }) {
  const drag = useRef<{ y: number; h: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const set = (h: number) => setDockHeight(Math.max(DOCK_MIN, Math.min(bounds(rig.current).max, h)));

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: height, id: e.pointerId };
    setDragging(true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    set(d.h - (e.clientY - d.y));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  useEffect(() => {
    if (!dragging) return;
    const html = document.documentElement;
    html.dataset.resizing = '';
    return () => {
      delete html.dataset.resizing;
    };
  }, [dragging]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 96 : 24;
    const act: Record<string, () => void> = {
      ArrowUp: () => set(height + step),
      ArrowDown: () => set(height - step),
      Home: () => set(DOCK_MIN),
      End: () => set(max),
      Enter: () => toggleDockMax(),
    };
    const fn = act[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  return (
    <div
      className={l.splitter}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Library height"
      aria-valuemin={DOCK_MIN}
      aria-valuemax={max}
      aria-valuenow={Math.round(height)}
      aria-valuetext={`${Math.round(height)} pixels`}
      tabIndex={0}
      data-dragging={dragging || undefined}
      title="Drag to resize the library · double-click to give it the window"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => toggleDockMax()}
      onKeyDown={onKey}
    >
      <span className={l.grip} aria-hidden="true" />
    </div>
  );
}
