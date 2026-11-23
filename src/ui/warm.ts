import type { PointerEvent } from 'react';
import type { DjSession } from '../engine/session';

/**
 * Row props that decode a track ahead of its load (engine/preload.ts): when
 * the mouse rests on it for a moment, and at once on press (a double-click
 * or a drag to a deck follows). Touch only on press, so scrolling a list
 * decodes nothing.
 */
let timer: ReturnType<typeof setTimeout> | null = null;
const HOVER_MS = 220;

function clear() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

export function warmProps(session: DjSession, trackId: string) {
  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      clear();
      timer = setTimeout(() => session.warmTrack(trackId), HOVER_MS);
    },
    onPointerLeave: clear,
    onPointerDown: () => {
      clear();
      session.warmTrack(trackId);
    },
  };
}

/** Keyboard: the row the arrows rest on, once they stop. */
export function warmSoon(session: DjSession, trackId: string) {
  clear();
  timer = setTimeout(() => session.warmTrack(trackId), HOVER_MS + 80);
}
