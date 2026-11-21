import { useEffect, useId, useMemo, useRef } from 'react';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import { canLinkFolder } from '../../engine/folder';
import { openBrowse } from '../browse';
import { CrateActions } from './CrateActions';
import { SOURCE_LABEL, crateBrowser, energyOf, filterTracks, foldersOf, sourceOf, type SourceKind } from './model';
import { useRig } from './rig';
import { ROW_H, TrackList } from './TrackList';
import c from './crate.module.css';

type Mode = 'page' | 'mini' | 'full';

const KINDS: SourceKind[] = ['folder', 'file', 'soundcloud', 'audius', 'demo'];

/** Asks the open track list to put the cursor in its search field. */
export const searchFocus = { request: 0, listeners: new Set<() => void>() };
export function focusCrateSearch() {
  searchFocus.request++;
  searchFocus.listeners.forEach((fn) => fn());
}

/**
 * The track list with everything around it: search, source and harmonic
 * filters, analysis progress and the empty states. The same component in
 * the page, the mini window and full screen; `mode` decides how much fits.
 */
export function TrackBrowser({ session, mode }: { session: DjSession; mode: Mode }) {
  const { tracks, loaded, note } = useStore(session.crate);
  const st = useStore(crateBrowser);
  const rig = useRig(session);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchId = useId();

  const rows = useMemo(() => filterTracks(tracks, st, rig.ref), [tracks, st, rig.ref?.bpm, rig.ref?.key]);
  const counts = useMemo(() => {
    const m = new Map<SourceKind, number>();
    tracks.forEach((t) => m.set(sourceOf(t), (m.get(sourceOf(t)) ?? 0) + 1));
    return m;
  }, [tracks]);
  const folders = useMemo(() => (mode === 'full' ? foldersOf(tracks) : []), [tracks, mode]);
  const showEnergy = useMemo(() => tracks.some((t) => energyOf(t) !== null), [tracks]);
  const analysing = tracks.filter((t) => t.status === 'analysing').length;
  const kinds = KINDS.filter((k) => counts.get(k));
  const filtered = !!(st.query.trim() || st.source || st.folder !== null || st.matchKey || st.matchBpm);

  // Opening the mini window or full screen puts you straight in the search.
  useEffect(() => {
    const go = () => search.current?.focus();
    searchFocus.listeners.add(go);
    if (mode !== 'page') requestAnimationFrame(go);
    return () => void searchFocus.listeners.delete(go);
  }, [mode]);

  const clearFilters = () => crateBrowser.set({ query: '', source: null, folder: null, matchKey: false, matchBpm: false });
  const focusFirstRow = () => {
    const row = list.current?.querySelector<HTMLElement>('[data-row]');
    if (row) {
      if (list.current) list.current.scrollTop = 0;
      row.focus();
    }
  };

  const sourceChips = kinds.length > 1 && mode !== 'full' && (
    <div className={c.chips} role="group" aria-label="Source">
      <button type="button" className={c.chip} aria-pressed={!st.source} onClick={() => crateBrowser.set({ source: null })}>
        All <span className={c.count}>{tracks.length}</span>
      </button>
      {kinds.map((k) => (
        <button
          key={k}
          type="button"
          className={c.chip}
          data-kind={k}
          aria-pressed={st.source === k}
          onClick={() => crateBrowser.set({ source: st.source === k ? null : k })}
        >
          {SOURCE_LABEL[k]} <span className={c.count}>{counts.get(k)}</span>
        </button>
      ))}
    </div>
  );

  // Full screen shows the folder in its sidebar; elsewhere a folder picked
  // there would filter invisibly, so it gets a chip to take it off.
  const folderChip = st.folder !== null && mode !== 'full' && (
    <button
      type="button"
      className={c.chip}
      aria-pressed="true"
      onClick={() => crateBrowser.set({ folder: null })}
      aria-label={`Folder ${st.folder || 'top level'}: show every folder`}
      title="Show every folder"
    >
      {st.folder ? st.folder.slice(st.folder.lastIndexOf('/') + 1) : 'Top level'} ✕
    </button>
  );

  const ref = rig.ref;
  const matchChips = (
    <div className={c.chips} role="group" aria-label={ref ? `Match deck ${ref.deck}` : 'Match a deck'}>
      <span className={c.chipLabel} data-deck={ref?.deck}>
        {ref ? (
          <>
            Mix with <b>{ref.deck}</b>
          </>
        ) : (
          'Mix with'
        )}
      </span>
      <button
        type="button"
        className={c.chip}
        aria-pressed={st.matchKey && !!ref?.key}
        disabled={!ref?.key}
        title={ref?.key ? `Only keys that mix with ${ref.key} (same, relative, or a fifth away)` : 'Load a track on a deck to match its key'}
        onClick={() => crateBrowser.set({ matchKey: !st.matchKey })}
      >
        Key{ref?.key ? <span className={c.count}>{ref.key}</span> : null}
      </button>
      <button
        type="button"
        className={c.chip}
        aria-pressed={st.matchBpm && !!ref?.bpm}
        disabled={!ref?.bpm}
        title={ref?.bpm ? `Only tempos within 6% of ${ref.bpm.toFixed(1)} BPM, counting half and double time` : 'Load a track on a deck to match its tempo'}
        onClick={() => crateBrowser.set({ matchBpm: !st.matchBpm })}
      >
        Tempo{ref?.bpm ? <span className={c.count}>{ref.bpm.toFixed(0)}±6%</span> : null}
      </button>
    </div>
  );

  let body;
  if (!loaded) {
    body = (
      <div className={c.skeleton} aria-busy="true" aria-label="Loading the crate">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} style={{ height: ROW_H }} />
        ))}
      </div>
    );
  } else if (!tracks.length) {
    body = (
      <div className={c.empty}>
        <p className={c.emptyTitle}>Your crate is empty</p>
        <p className={c.emptyText}>Drop audio files here or onto a deck. They stay in this browser; nothing is uploaded.</p>
        <div className={c.emptyActions}>
          <CrateActions session={session} compact />
        </div>
        {!canLinkFolder() && (
          <p className={c.emptyText}>
            Or{' '}
            <button type="button" className={c.linkBtn} onClick={() => openBrowse()}>
              browse SoundCloud and Audius
            </button>
            .
          </p>
        )}
      </div>
    );
  } else if (!rows.length) {
    body = (
      <div className={c.empty}>
        <p className={c.emptyTitle}>{st.query.trim() ? `Nothing matches “${st.query.trim()}”` : 'No tracks fit these filters'}</p>
        <p className={c.emptyText}>
          {st.matchKey || st.matchBpm
            ? `Nothing in ${st.source || st.folder !== null ? 'this part of ' : ''}the crate mixes with deck ${ref?.deck ?? ''} yet.`
            : 'Try fewer words, or another source.'}
        </p>
        <div className={c.emptyActions}>
          <button type="button" className={c.action} onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <TrackList
        session={session}
        rows={rows}
        mode={mode}
        rig={rig}
        showEnergy={showEnergy}
        sort={st.sort}
        listRef={list}
        onExitTop={() => search.current?.focus()}
      />
    );
  }

  const toolbar = (
    <div className={c.toolbar}>
      <div className={c.searchWrap}>
        <label htmlFor={searchId} className={c.srOnly}>
          Search the crate
        </label>
        <span className={c.searchIcon} aria-hidden="true">
          ⌕
        </span>
        <input
          ref={search}
          id={searchId}
          type="search"
          className={c.search}
          placeholder={mode === 'mini' ? 'Search the crate' : 'Search title, artist, album, genre or key'}
          value={st.query}
          onChange={(e) => crateBrowser.set({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
              e.preventDefault();
              focusFirstRow();
            } else if (e.key === 'Escape' && st.query) {
              e.stopPropagation();
              crateBrowser.set({ query: '' });
            }
          }}
        />
        {st.query ? (
          <button type="button" className={c.searchClear} onClick={() => crateBrowser.set({ query: '' })} aria-label="Clear search">
            ✕
          </button>
        ) : (
          mode !== 'page' && (
            <kbd className={c.kbd} aria-hidden="true">
              /
            </kbd>
          )
        )}
      </div>
      {mode === 'full' && <CrateActions session={session} />}
    </div>
  );

  const status = (
    <div className={c.status}>
      <span className={c.countLine} aria-live="polite">
        {filtered ? (
          <>
            <b>{rows.length}</b> of {tracks.length}
          </>
        ) : (
          <>
            <b>{tracks.length}</b> track{tracks.length === 1 ? '' : 's'}
          </>
        )}
        {filtered && (
          <button type="button" className={c.linkBtn} onClick={clearFilters}>
            Clear
          </button>
        )}
      </span>
      {analysing > 0 && (
        <span className={c.progress} title="Finding tempo and key, one track at a time">
          <span className={c.progressText}>
            Reading tempo and key · {tracks.length - analysing} of {tracks.length} done
          </span>
          <span className={c.progressBar} aria-hidden="true">
            <span style={{ width: `${((tracks.length - analysing) / Math.max(1, tracks.length)) * 100}%` }} />
          </span>
        </span>
      )}
      {note && <span className={c.note}>{note}</span>}
    </div>
  );

  const legend = mode !== 'page' && rows.length > 0 && (
    <p className={c.legend} aria-hidden="true">
      <kbd>↑</kbd>
      <kbd>↓</kbd> pick <kbd>←</kbd> deck A <kbd>→</kbd> deck B <kbd>Enter</kbd>{' '}
      {rig.target === null ? 'both decks are playing' : `deck ${rig.target === 0 ? 'A' : 'B'}`}
      {mode === 'full' && (
        <>
          {' '}
          <kbd>+</kbd> queue · drag a row onto a deck
        </>
      )}
    </p>
  );

  if (mode === 'full') {
    return (
      <div className={c.fullLayout}>
        <nav className={c.sidebar} aria-label="Crate sections">
          <p className={c.sideHead}>Sources</p>
          <ul className={c.sideList}>
            <li>
              <button type="button" className={c.sideItem} aria-pressed={!st.source && st.folder === null} onClick={() => crateBrowser.set({ source: null, folder: null })}>
                All tracks <span className={c.count}>{tracks.length}</span>
              </button>
            </li>
            {kinds.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  className={c.sideItem}
                  data-kind={k}
                  aria-pressed={st.source === k && st.folder === null}
                  onClick={() => crateBrowser.set({ source: k, folder: null })}
                >
                  <span className={c.dot} data-kind={k} aria-hidden="true" />
                  {SOURCE_LABEL[k]} <span className={c.count}>{counts.get(k)}</span>
                </button>
              </li>
            ))}
          </ul>
          {folders.length > 1 && (
            <>
              <p className={c.sideHead}>Folders</p>
              <ul className={c.sideList}>
                {folders.map((f) => (
                  <li key={f.path}>
                    <button
                      type="button"
                      className={c.sideItem}
                      style={{ paddingLeft: 12 + f.depth * 14 }}
                      aria-pressed={st.folder === f.path}
                      title={f.path || 'Top level of the linked folder'}
                      onClick={() => crateBrowser.set({ folder: st.folder === f.path ? null : f.path, source: null })}
                    >
                      <span className={c.folderName}>{f.name}</span> <span className={c.count}>{f.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </nav>
        <div className={c.main}>
          {toolbar}
          <div className={c.filterRow}>{matchChips}</div>
          {status}
          <div className={c.listArea}>{body}</div>
          {legend}
        </div>
      </div>
    );
  }

  return (
    <div className={c.browser} data-mode={mode}>
      {toolbar}
      <div className={c.filterRow}>
        {matchChips}
        {sourceChips}
        {folderChip}
      </div>
      {status}
      <div className={c.listArea}>{body}</div>
      {legend}
    </div>
  );
}
