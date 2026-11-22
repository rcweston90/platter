import { useEffect, useState } from 'react';
import { createStore } from '../../engine/store';

/**
 * The library flyout. The library (crate, Up next, Mashups, Auto-DJ and
 * Recordings) used to sit under the decks, so reaching it meant scrolling
 * past them. Now it's a sheet pinned to the bottom of the window on every
 * screen: closed, only its header shows (the tabs and the two decks), and a
 * tab, the chevron, the Tracks button, T or / slides it up over the lower
 * part of the rig. The top bar and the waveforms always stay in view above
 * it. Its height, whether it's open and the last tab carry over between
 * visits.
 *
 * On a laptop or bigger the rest of the rig still fills the window the way
 * DJ software does: the top bar and waveforms are pinned and the decks,
 * mixer and pads scroll in the middle ("docked"). Smaller screens keep the
 * long page.
 */

/** When the window-filling layout applies. Matches the media query in platter.module.css. */
export const DOCK_QUERY = '(min-width: 900px) and (min-height: 600px)';

/** The open sheet's smallest height: a header, a search row and a few rows. */
export const DOCK_MIN = 240;
/** The closed sheet: just its header. Matches --lib-bar in library.module.css. */
export const LIB_BAR = 53;

export type LibraryTab = 'crate' | 'upnext' | 'mashups' | 'queue' | 'recordings';
const TABS: LibraryTab[] = ['crate', 'upnext', 'mashups', 'queue', 'recordings'];

const HEIGHT_KEY = 'platter.libraryHeight';
const STATE_KEY = 'platter.library';

function readSaved(): number | null {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function readState(): { open: boolean; tab: LibraryTab } {
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as { open?: unknown; tab?: unknown } | null;
    return {
      open: v?.open === true,
      tab: TABS.includes(v?.tab as LibraryTab) ? (v!.tab as LibraryTab) : 'crate',
    };
  } catch {
    return { open: false, tab: 'crate' };
  }
}

/** The open sheet's height in px; null = the default. `max` = as tall as it can go. */
export const dockHeight = createStore<{ px: number | null; max: boolean }>({ px: readSaved(), max: false });

export function setDockHeight(px: number | null) {
  dockHeight.set({ px, max: false });
  try {
    if (px === null) localStorage.removeItem(HEIGHT_KEY);
    else localStorage.setItem(HEIGHT_KEY, String(Math.round(px)));
  } catch {
    // Private windows and blocked storage: the size just won't carry over.
  }
}

export const toggleDockMax = () => dockHeight.set({ max: !dockHeight.get().max });

/** The default open height: most of the window, with the decks' tops still in view. */
export const defaultDockHeight = (vh: number) => Math.round(Math.max(DOCK_MIN, Math.min(vh * 0.58, 720)));

/** Whether the flyout is open, and which tab it shows. */
export const libraryFlyout = createStore<{ open: boolean; tab: LibraryTab }>(readState());

libraryFlyout.subscribe(() => {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(libraryFlyout.get()));
  } catch {
    // As above: it just won't carry over.
  }
});

/** Opens the flyout, on `tab` if given (else the last one). */
export const openLibrary = (tab?: LibraryTab) => libraryFlyout.set({ open: true, ...(tab ? { tab } : {}) });
export const closeLibrary = () => libraryFlyout.set({ open: false });
export const toggleLibrary = () => libraryFlyout.set({ open: !libraryFlyout.get().open });

/** True while the window-filling layout applies. */
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
