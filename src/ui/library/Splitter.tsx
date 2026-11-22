import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { useStore } from '../../engine/store';
import { DOCK_MIN, defaultDockHeight, dockHeight, setDockHeight, toggleDockMax } from './dock';
import l from './library.module.css';

/** What the open sheet may cover: from the bottom of the window (above the
 *  phone's play dock) up to just under what's pinned at the top, so the
 *  waveforms always stay in view. */
function bounds(pinned: HTMLElement | null, below: number) {
  const vh = window.innerHeight;
  // Its bottom edge where it is now (on a phone, at the top of the page, under
  // the top bar), so the deck tabs and waveforms stay in view when it opens.
  const top = pinned ? pinned.getBoundingClientRect().bottom : 0;
  const max = Math.max(DOCK_MIN, Math.round(vh - below - Math.max(top, 8) - 8));
  return { vh, max };
}

/**
 * The open sheet's height, in px: what it was dragged to (kept between
 * visits), or the default, held inside what the window allows. `below` is
 * what the sheet sits on (the phone's play dock), `pinned` what it must not
 * cover at the top.
 */
export function useSheetSize(pinned: RefObject<HTMLElement | null>, below: number) {
  const { px, max: maxed } = useStore(dockHeight);
  const [room, setRoom] = useState(() => bounds(null, below));
  useEffect(() => {
    const on = () => setRoom(bounds(pinned.current, below));
    on();
    window.addEventListener('resize', on);
    // The top bar can wrap as its status changes, which moves the waveforms.
    const el = pinned.current;
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(on) : null;
    if (el) ro?.observe(el);
    return () => {
      window.removeEventListener('resize', on);
      ro?.disconnect();
    };
  }, [pinned, below]);
  const want = maxed ? room.max : (px ?? defaultDockHeight(room.vh));
  return { height: Math.max(DOCK_MIN, Math.min(want, room.max)), max: room.max, maxed };
}

/**
 * The handle along the top of the open library. Drag it, or focus it and use
 * the arrow keys (Shift for bigger steps, Home and End for the limits).
 * Double-click gives the library all the room under the waveforms, and
 * again puts it back.
 */
export function Splitter({ height, max }: { height: number; max: number }) {
  const drag = useRef<{ y: number; h: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const set = (h: number) => setDockHeight(Math.max(DOCK_MIN, Math.min(max, h)));

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
      title="Drag to resize the library · double-click to give it all the room"
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
