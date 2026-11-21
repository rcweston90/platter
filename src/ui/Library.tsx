import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DjSession } from '../engine/session';
import { shallowEqual, useStore, useStoreSelect } from '../engine/store';
import { Crate } from './Crate';
import { openCrate } from './crate/CrateDock';
import { crateBrowser } from './crate/model';
import { focusCrateSearch, searchFocus } from './crate/TrackBrowser';
import { DeckTargets } from './library/DeckTargets';
import { dockHeight, toggleDockMax, useWidth } from './library/dock';
import { MashupsPanel } from './library/MashupsPanel';
import { UpNextPanel } from './library/UpNextPanel';
import { QueuePanel } from './QueuePanel';
import { RecordingsPanel } from './RecordingsPanel';
import l from './library/library.module.css';

type Tab = 'crate' | 'upnext' | 'mashups' | 'queue' | 'recordings';

/** Library width from which Up next rides beside the crate instead of behind a tab. */
export const RAIL_FROM = 1080;
/** Library width from which the deck targets fit in its header. */
const TARGETS_FROM = 720;

/**
 * The library: the crate, what to play next, mashup matching, the Auto-DJ
 * queue and recorded mixes. Docked along the bottom of the window on a
 * laptop or bigger (see library/dock), at the end of the page on a phone.
 * Wide enough, Up next sits beside the crate as a rail, so the best next
 * tracks are always in view while you browse. Online music is in the Browse
 * music flyout.
 */
export function Library({ session, docked }: { session: DjSession; docked: boolean }) {
  const [tab, setTab] = useState<Tab>('crate');
  // Not the status line: Auto DJ rewrites it while it counts down a mix.
  const { queue, on } = useStoreSelect(session.autoDj.store, ({ queue, on }) => ({ queue, on }), shallowEqual);
  const { list } = useStore(session.recordings);
  const { view } = useStore(crateBrowser);
  const { max } = useStore(dockHeight);
  const [el, width] = useWidth();
  const wide = width >= RAIL_FROM;
  const rail = tab === 'crate' && view === 'page' && wide;

  // "/" means the crate's search: from another tab, come back to the crate first.
  const current = useRef(tab);
  current.current = tab;
  useEffect(() => {
    const go = () => {
      if (current.current === 'crate') return;
      setTab('crate');
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
    setTab(t.id);
    document.getElementById(`lib-tab-${t.id}`)?.focus();
  };

  return (
    <section ref={el} className={l.library} data-library data-docked={docked || undefined} data-rail={rail || undefined} aria-label="Library">
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
          {docked && (
            <button
              type="button"
              className={l.iconBtn}
              aria-pressed={max}
              onClick={toggleDockMax}
              aria-label="Give the library the whole window"
              title={max ? 'Give the decks their room back (or double-click the handle)' : 'Give the library the whole window (or double-click the handle)'}
            >
              {max ? <RestoreIcon /> : <MaxIcon />}
            </button>
          )}
        </div>
      </header>
      <div className={l.body}>
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
  );
}

const FullIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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
