import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { AudiusPanel } from './AudiusPanel';
import { browse, closeBrowse, type Source } from './browse';
import { SoundCloudPanel } from './SoundCloudPanel';
import s from '../platter.module.css';

const SOURCES: { id: Source; label: string }[] = [
  { id: 'soundcloud', label: 'SoundCloud' },
  { id: 'audius', label: 'Audius' },
];

/**
 * "Browse music": a sheet that slides in from the right over the library, so
 * the decks stay in view (and playable) while you pick the next track. It
 * stays mounted once opened, so a search is still there when you come back.
 */
export function MusicFlyout({ session }: { session: DjSession }) {
  const { open, source } = useStore(browse);
  const [mounted, setMounted] = useState(open);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  // On open: remember what had focus and move into the sheet; on close, go back.
  useEffect(() => {
    if (!open) return;
    setMounted(true);
    opener.current = document.activeElement;
    const id = requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>(`#src-panel-${browse.get().source} input[type="search"], #src-panel-${browse.get().source} [data-autofocus]`);
      (first ?? panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      const back = opener.current as HTMLElement | null;
      if (back?.isConnected) back.focus();
    };
  }, [open]);

  if (!mounted) return null;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeBrowse();
    }
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = SOURCES.findIndex((x) => x.id === source);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = SOURCES[(next + SOURCES.length) % SOURCES.length];
    browse.set({ source: t.id });
    document.getElementById(`src-tab-${t.id}`)?.focus();
  };

  return (
    <aside
      ref={panel}
      className={s.flyout}
      data-open={open}
      aria-label="Browse music"
      inert={!open}
      aria-hidden={!open}
      onKeyDown={onKey}
    >
      <header className={s.flyoutHead}>
        <h2 className={s.flyoutTitle}>Browse music</h2>
        <button type="button" className={s.flyoutClose} onClick={closeBrowse} aria-label="Close browse music">
          ✕
        </button>
        <div className={s.sourceTabs} role="tablist" aria-label="Music source">
          {SOURCES.map((t) => (
            <button
              key={t.id}
              id={`src-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={source === t.id}
              aria-controls={`src-panel-${t.id}`}
              tabIndex={source === t.id ? 0 : -1}
              className={s.sourceTab}
              onClick={() => browse.set({ source: t.id })}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      {/* Both stay mounted, so switching source keeps each one's list and search. */}
      <div id="src-panel-soundcloud" role="tabpanel" aria-labelledby="src-tab-soundcloud" className={s.flyoutBody} hidden={source !== 'soundcloud'}>
        <SoundCloudPanel session={session} />
      </div>
      <div id="src-panel-audius" role="tabpanel" aria-labelledby="src-tab-audius" className={s.flyoutBody} hidden={source !== 'audius'}>
        <AudiusPanel session={session} />
      </div>
    </aside>
  );
}
