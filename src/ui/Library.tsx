import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { DjSession } from '../engine/session';
import { shallowEqual, useStore, useStoreSelect } from '../engine/store';
import { Crate } from './Crate';
import { openCrate } from './crate/CrateDock';
import { crateBrowser } from './crate/model';
import { focusCrateSearch, searchFocus } from './crate/TrackBrowser';
import { DeckTargets } from './library/DeckTargets';
import { closeLibrary, dockHeight, libraryFlyout, openLibrary, toggleDockMax, toggleLibrary, useWidth, type LibraryTab } from './library/dock';
import { Splitter } from './library/Splitter';
import { MashupsPanel } from './library/MashupsPanel';
import { UpNextPanel } from './library/UpNextPanel';
import { QueuePanel } from './QueuePanel';
import { RecordingsPanel } from './RecordingsPanel';
import l from './library/library.module.css';

type Tab = LibraryTab;

/** Library width from which Up next rides beside the crate instead of behind a tab. */
export const RAIL_FROM = 1080;
/** Library width from which the deck targets fit in its header. */
const TARGETS_FROM = 720;

/**
 * The library: the crate, what to play next, mashup matching, the Auto-DJ
 * queue and recorded mixes, in a flyout pinned to the bottom of the window
 * (see library/dock). Closed, only its header shows, so the tabs and the
 * two decks are always one click away without scrolling; a tab, the chevron,
 * T or / slides it up over the lower part of the rig, to the height its
 * handle was dragged to. Wide enough, Up next sits beside the crate as a
 * rail, so the best next tracks are always in view while you browse. Online
 * music is in the Browse music flyout.
 */
export function Library({ session, height, max }: { session: DjSession; height: number; max: number }) {
  const { open, tab } = useStore(libraryFlyout);
  const setTab = (t: Tab) => openLibrary(t);
  // Not the status line: Auto DJ rewrites it while it counts down a mix.
  const { queue, on } = useStoreSelect(session.autoDj.store, ({ queue, on }) => ({ queue, on }), shallowEqual);
  const { list } = useStore(session.recordings);
  const { view } = useStore(crateBrowser);
  const { max: maxed } = useStore(dockHeight);
  const [el, width] = useWidth();
  const wide = width >= RAIL_FROM;
  const rail = tab === 'crate' && view === 'page' && wide;
  const toggleBtn = useRef<HTMLButtonElement>(null);

  // "/" means the crate's search: open the library on the crate first (unless
  // the mini window or full screen has the list out).
  const current = useRef(tab);
  current.current = tab;
  useEffect(() => {
    const go = () => {
      if (crateBrowser.get().view !== 'page' || (current.current === 'crate' && libraryFlyout.get().open)) return;
      openLibrary('crate');
      requestAnimationFrame(() => focusCrateSearch());
    };
    searchFocus.listeners.add(go);
    return () => void searchFocus.listeners.delete(go);
  }, []);

  const tabs: { id: Tab; label: string; badge?: number; live?: boolean }[] = [
    { id: 'crate', label: 'Crate' },
    { id: 'upnext', label: 'Up next' },
    { id: 'mashups', label: 'Mashups' },
    { id: 'queue', label: 'Auto-DJ', live: on, badge: queue.length || undefined },
    { id: 'recordings', label: 'Recordings', badge: list.length || undefined },
  ];
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    const t = tabs[(next + tabs.length) % tabs.length];
    libraryFlyout.set({ tab: t.id });
    document.getElementById(`lib-tab-${t.id}`)?.focus();
  };

  // Esc puts it away, and focus goes to the chevron rather than nowhere.
  const onSheetKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
    e.stopPropagation();
    const inside = e.currentTarget.contains(document.activeElement);
    closeLibrary();
    if (inside) toggleBtn.current?.focus();
  };

  return (
    // The frame is the sheet's open size and clips it while it's closed, so
    // the hidden part never covers what's under it (the phone's play dock).
    <div className={l.frame} data-open={open || undefined} style={{ '--lib-h': `${height}px` } as React.CSSProperties}>
    <section
      ref={el}
      className={l.library}
      data-library
      data-open={open || undefined}
      data-rail={rail || undefined}
      aria-label="Library"
      onKeyDown={onSheetKey}
    >
      {open && <Splitter height={height} max={max} />}
      <header className={l.bar}>
        <div className={l.tabs} role="tablist" aria-label="Library">
          {tabs.map((t) => (
            <button
              key={t.id}
              id={`lib-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`lib-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={l.tab}
              title={t.id === 'upnext' && wide ? 'Up next is beside the crate; this opens it at full size, with its options' : undefined}
              onClick={() => setTab(t.id)}
              onKeyDown={onKey}
            >
              {t.label}
              {t.live && (
                <span className={l.live}>
                  <span className={l.srOnly}> on</span>
                </span>
              )}
              {t.badge ? <span className={l.badge}> {t.badge}</span> : null}
            </button>
          ))}
        </div>
        {width >= TARGETS_FROM && <DeckTargets session={session} />}
        <div className={l.tools}>
          {tab === 'crate' && (
            <button
              type="button"
              className={l.iconBtn}
              onClick={(e) => openCrate('full', e.currentTarget)}
              aria-label="Browse the crate full screen"
              title="Full screen, with folders"
            >
              <FullIcon />
            </button>
          )}
          {open && (
            <button
              type="button"
              className={`${l.iconBtn} ${l.maxBtn}`}
              aria-pressed={maxed}
              onClick={toggleDockMax}
              aria-label="Give the library all the room under the waveforms"
              title={maxed ? 'Give the decks their room back (or double-click the handle)' : 'Give the library all the room under the waveforms (or double-click the handle)'}
            >
              {maxed ? <RestoreIcon /> : <MaxIcon />}
            </button>
          )}
          <button
            ref={toggleBtn}
            type="button"
            className={`${l.iconBtn} ${l.toggle}`}
            aria-expanded={open}
            aria-controls="lib-body"
            onClick={toggleLibrary}
            aria-label={open ? 'Close the library' : 'Open the library'}
            title={open ? 'Close the library (T or Esc)' : 'Open the library (T)'}
          >
            <ChevronIcon />
          </button>
        </div>
      </header>
      <div id="lib-body" className={l.body} inert={!open || undefined}>
        <div id={`lib-panel-${tab}`} className={l.panel} data-tab={tab} role="tabpanel" aria-labelledby={`lib-tab-${tab}`}>
          {tab === 'crate' && <Crate session={session} />}
          {tab === 'upnext' && <UpNextPanel session={session} />}
          {tab === 'mashups' && <MashupsPanel session={session} />}
          {tab === 'queue' && <QueuePanel session={session} />}
          {tab === 'recordings' && <RecordingsPanel session={session} />}
        </div>
        {rail && (
          <aside className={l.rail} aria-label="Up next">
            <UpNextPanel session={session} variant="rail" onMore={() => setTab('upnext')} />
          </aside>
        )}
      </div>
    </section>
    </div>
  );
}

const FullIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ChevronIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M5 12.5l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const MaxIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M5 11l5-5 5 5M5 16l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const RestoreIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M5 4l5 5 5-5M5 9l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
