import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Deck } from '../../engine/deck';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import { usePrefersReducedMotion } from '../hooks';
import { TRACK_MIME } from '../DeckPanel';
import { useDropTarget } from '../frame';
import { addFiles } from './CrateActions';
import { crateBrowser, crateSlot, setCrateView, type CrateView } from './model';
import { TrackBrowser } from './TrackBrowser';
import { usePhone } from '../Phone';
import c from './crate.module.css';

/**
 * The crate's floating window, after the media dock on rcweston.com: one
 * surface with three shapes. A pill in the corner opens into a mini window
 * (the track list beside the decks), which expands to full screen. It is a
 * single element whose box moves, never two views swapping, so expanding
 * keeps your search, scroll and place in the list. Opened from the page, it
 * grows out of the crate; closed, it lands back in it.
 */

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: number;
}

const PILL_W = 216;
const PILL_H = 48;
/** How long the surface takes to change shape (matches --morph in the CSS). */
const MORPH_MS = 420;

function boxFor(view: CrateView, vw: number, vh: number): Box {
  const narrow = vw < 600;
  if (view === 'full') {
    const m = narrow ? 0 : 12;
    return { top: m, left: m, width: vw - m * 2, height: vh - m * 2, radius: narrow ? 0 : 12 };
  }
  if (view === 'mini') {
    if (narrow) {
      const height = Math.min(Math.round(vh * 0.74), vh - 16);
      return { top: vh - 8 - height, left: 8, width: vw - 16, height, radius: 12 };
    }
    const width = Math.min(460, vw - 32);
    const height = Math.min(640, vh - 32);
    return { top: vh - 16 - height, left: vw - 16 - width, width, height, radius: 12 };
  }
  const m = narrow ? 12 : 16;
  return { top: vh - m - PILL_H, left: vw - m - PILL_W, width: PILL_W, height: PILL_H, radius: PILL_H / 2 };
}

const rectBox = (r: DOMRect): Box => ({ top: r.top, left: r.left, width: r.width, height: r.height, radius: 8 });

/** An element on screen enough to fly into or out of. */
function inView(el: HTMLElement | null): DOMRect | null {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;
  const shown = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  return shown > Math.min(r.height, window.innerHeight) * 0.3 ? r : null;
}

/** Where the window lands when it closes: the page crate if it's on screen,
 *  else the Tracks button in the top bar, else (null) the corner pill. */
function landingRect(): Box | null {
  const { el, launcher } = crateSlot.get();
  const slot = inView(el);
  if (slot) return rectBox(slot);
  const btn = inView(launcher);
  return btn ? { ...rectBox(btn), radius: 6 } : null;
}

function useViewport() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

/** True while the element is on screen. */
function useOnScreen(el: HTMLElement | null) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(false);
      return;
    }
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return visible;
}

/** Opens the floating track list. `from` is what was pressed, so the window
 *  grows out of it; left out, it grows out of the page crate when that's on
 *  screen. */
export function openCrate(view: 'mini' | 'full' = 'mini', from?: Element | null) {
  const st = crateBrowser.get();
  if (st.view === view) return;
  if (st.view === 'page') dockFlight.from = from ? from.getBoundingClientRect() : inView(crateSlot.get().el);
  setCrateView(view);
}

/** Where the next opening flies from (the page crate), set just before. */
const dockFlight: { from: DOMRect | null } = { from: null };

export function CrateDock({ session }: { session: DjSession }) {
  const { view } = useStore(crateBrowser);
  const { tracks } = useStore(session.crate);
  const still = usePrefersReducedMotion();
  const { w, h } = useViewport();
  const { el: slotEl, launcher } = useStore(crateSlot);
  const slotVisible = useOnScreen(slotEl);
  const launcherVisible = useOnScreen(launcher);
  const [override, setOverride] = useState<{ box: Box; instant: boolean } | null>(null);
  const [landing, setLanding] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const pillBtn = useRef<HTMLButtonElement>(null);
  const prevView = useRef(view);
  const [dragOver, setDragOver] = useState(false);
  const phone = usePhone();

  // Grow out of the page crate: start on its rect, then let the box transition.
  useLayoutEffect(() => {
    const before = prevView.current;
    prevView.current = view;
    if (before !== 'page' || view === 'page') return;
    const from = dockFlight.from;
    dockFlight.from = null;
    if (!from || still) return;
    setOverride({ box: rectBox(from), instant: true });
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setOverride(null)));
    return () => cancelAnimationFrame(raf);
  }, [view, still]);

  // Full screen owns the page: the rig behind can't take focus or scroll, but
  // its keyboard shortcuts keep working (they listen on the window).
  useEffect(() => {
    if (view !== 'full') return;
    const root = surface.current?.closest('[data-dj-root]');
    const others = root ? Array.from(root.children).filter((el) => !el.contains(surface.current)) : [];
    others.forEach((el) => el.setAttribute('inert', ''));
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      others.forEach((el) => el.removeAttribute('inert'));
      html.style.overflow = overflow;
    };
  }, [view]);

  const close = () => {
    const to = landingRect();
    const back = () => {
      setCrateView('page');
      requestAnimationFrame(() => {
        const btn = pillBtn.current;
        const { el, launcher: top } = crateSlot.get();
        if (inView(el)) el?.querySelector<HTMLElement>('input[type="search"]')?.focus();
        else if (inView(top)) top?.focus();
        else btn?.focus();
      });
    };
    if (!to || still) return back();
    // Land back where it came from, then hand over.
    setLanding(true);
    setOverride({ box: to, instant: false });
    window.setTimeout(() => {
      setLanding(false);
      setOverride(null);
      back();
    }, MORPH_MS);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || view === 'page') return;
    e.stopPropagation();
    if (view === 'full') setCrateView('mini');
    else close();
  };

  useDropTarget(
    surface,
    (types) => view !== 'page' && types.includes('Files') && !types.includes(TRACK_MIME),
    setDragOver,
    (data) => addFiles(session, Array.from(data.files)),
  );

  const open = view !== 'page';
  // The pill is for when nothing else in view opens the list: the page crate
  // and the top bar's Tracks button both off screen. It never sits over the
  // rig at rest. On a phone the bottom edge is the rig's play and crossfader
  // dock, and each deck has its own Tracks button, so there's no pill.
  const pillHidden = !open && !landing && (phone || slotVisible || launcherVisible || !tracks.length);
  const box = override?.box ?? boxFor(landing ? 'mini' : view, w, h);
  const shape = landing ? 'landing' : view === 'page' ? 'pill' : view;

  return (
    <div
      ref={surface}
      className={c.dock}
      data-shape={shape}
      data-hidden={pillHidden || undefined}
      data-instant={override?.instant || still || undefined}
      data-over={dragOver || undefined}
      style={{ top: box.top, left: box.left, width: box.width, height: box.height, borderRadius: box.radius }}
      role={open ? 'dialog' : undefined}
      aria-modal={view === 'full' ? true : undefined}
      aria-label={open ? 'Track list' : undefined}
      aria-hidden={pillHidden || undefined}
      inert={pillHidden || undefined}
      onKeyDown={onKey}
    >
      {open || landing ? (
        <div key="panel" className={c.dockContent} data-leaving={landing || undefined}>
          <header className={c.dockHead}>
            <h2 className={c.dockTitle}>
              Crate <span className={c.count}>{tracks.length}</span>
            </h2>
            {view === 'full' && <DeckChips session={session} />}
            <div className={c.dockButtons}>
              {view === 'mini' ? (
                <button type="button" className={c.iconBtn} onClick={() => setCrateView('full')} aria-label="Expand to full screen" title="Expand to full screen">
                  <ExpandIcon />
                </button>
              ) : (
                <button type="button" className={c.iconBtn} onClick={() => setCrateView('mini')} aria-label="Shrink to mini window" title="Shrink to mini window (Esc)">
                  <ShrinkIcon />
                </button>
              )}
              <button type="button" className={c.iconBtn} onClick={close} aria-label="Close the track list" title={view === 'mini' ? 'Close (Esc)' : 'Close'}>
                <CloseIcon />
              </button>
            </div>
          </header>
          <TrackBrowser session={session} mode={view === 'full' ? 'full' : 'mini'} />
        </div>
      ) : (
        <button
          key="pill"
          ref={pillBtn}
          type="button"
          className={c.pill}
          onClick={() => openCrate('mini')}
          aria-label={`Open the track list, ${tracks.length} tracks (/)`}
          title="Open the track list (/)"
        >
          <CrateIcon />
          <span className={c.pillLabel}>Tracks</span>
          <span className={c.pillCount}>{tracks.length}</span>
          <span className={c.pillHint} aria-hidden="true">
            /
          </span>
        </button>
      )}
    </div>
  );
}

/** What's on the decks, kept in view while the list covers them. Drop a row
 *  on one to load it there. */
function DeckChips({ session }: { session: DjSession }) {
  return (
    <div className={c.deckChips}>
      {session.decks.map((d) => (
        <DeckChip key={d.index} session={session} deck={d} />
      ))}
    </div>
  );
}

function DeckChip({ session, deck }: { session: DjSession; deck: Deck }) {
  const st = useStore(deck.store);
  const el = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const L = deck.index === 0 ? 'A' : 'B';
  useDropTarget(
    el,
    (types) => types.includes(TRACK_MIME),
    setOver,
    (data) => {
      const id = data.getData(TRACK_MIME);
      if (id && !deck.store.get().playing) void session.loadToDeck(id, deck.index);
    },
  );
  const bpm = deck.effectiveBpm();
  const key = deck.effectiveKey();
  return (
    <div ref={el} className={c.deckChip} data-deck={L} data-over={over || undefined} data-playing={st.playing || undefined}>
      <span className={c.deckLetter}>{L}</span>
      <span className={c.deckInfo}>
        <span className={c.deckTitle}>{st.loading ? 'Loading…' : st.track?.title ?? 'Empty'}</span>
        <span className={c.deckMeta}>
          {st.playing ? 'Playing' : st.track ? 'Cued' : 'Drop a track here'}
          {bpm ? ` · ${bpm.toFixed(1)}` : ''}
          {key ? ` · ${key}` : ''}
        </span>
      </span>
    </div>
  );
}

const CrateIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className={c.pillIcon}>
    <rect x="3" y="3" width="3" height="14" rx="1" fill="currentColor" />
    <rect x="8" y="5" width="3" height="12" rx="1" fill="currentColor" opacity="0.75" />
    <rect x="13" y="3.5" width="3" height="13.5" rx="1" fill="currentColor" opacity="0.5" transform="rotate(8 14.5 10)" />
  </svg>
);
const ExpandIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ShrinkIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M16 9h-5V4M4 11h5v5M11 9l6-6M9 11l-6 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
  </svg>
);
