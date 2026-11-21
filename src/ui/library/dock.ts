import { useEffect, useState } from 'react';
import { createStore } from '../../engine/store';

/**
 * The library dock: on a laptop or bigger, the rig fills the window like DJ
 * software does. The waveforms stay pinned at the top, the decks and mixer
 * scroll in the middle, and the library is docked along the bottom with a
 * handle to give it more or less of the screen. Smaller screens keep the
 * long page, with the library under the decks.
 */

/** When the docked layout applies. Matches the media query in platter.module.css. */
export const DOCK_QUERY = '(min-width: 900px) and (min-height: 600px)';

/** The library's smallest height: a header, a search row and a few rows. */
export const DOCK_MIN = 240;
/** What the rig keeps above the dock at the very least, past the pinned waveforms. */
export const RIG_MIN = 96;

const STORAGE = 'platter.libraryHeight';

function readSaved(): number | null {
  try {
    const v = Number(localStorage.getItem(STORAGE));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** The dock's height in px; null = the default (about two fifths of the window). */
export const dockHeight = createStore<{ px: number | null; max: boolean }>({ px: readSaved(), max: false });

export function setDockHeight(px: number | null) {
  dockHeight.set({ px, max: false });
  try {
    if (px === null) localStorage.removeItem(STORAGE);
    else localStorage.setItem(STORAGE, String(Math.round(px)));
  } catch {
    // Private windows and blocked storage: the size just won't carry over.
  }
}

export const toggleDockMax = () => dockHeight.set({ max: !dockHeight.get().max });

/** The default share of the window: enough rows to choose from with the decks still in view. */
export const defaultDockHeight = (vh: number) => Math.round(Math.max(DOCK_MIN, Math.min(vh * 0.42, 560)));

/** True while the docked layout applies. */
export function useDocked() {
  const [docked, setDocked] = useState(() => typeof matchMedia === 'function' && matchMedia(DOCK_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(DOCK_QUERY);
    const on = () => setDocked(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return docked;
}

/** An element's width, kept up to date (0 until it's laid out). Takes a
 *  callback ref, so it follows the element when a layout swaps it out. */
export function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}
