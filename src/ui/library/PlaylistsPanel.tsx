import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Playlist } from '../../engine/playlists';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import type { TrackRecord } from '../../engine/types';
import { useRig, type Rig } from '../crate/rig';
import { TRACK_MIME } from '../DeckPanel';
import { formatTime } from '../Waveforms';
import { HistoryView } from './HistoryView';
import { useWidth } from './dock';
import { PlaylistIcon } from './AddToPlaylist';
import { PLAYLIST_MIME, PLAYLIST_ROW_MIME, flashNote, pickHistory, pickList, playlistsView, sessionLabel } from './playlistsModel';
import p from './playlists.module.css';

/** Below this width the sidebar becomes a row along the top. */
const SIDE_FROM = 620;

/**
 * The Playlists tab: your playlists down the side with the play history
 * under them, and the one you pick beside them. Tracks go into a playlist
 * from the crate (the playlist button on a row, or a row dragged onto a
 * playlist here from the crate's mini window or full screen), and load onto
 * a deck from here just as they do from the crate.
 */
export function PlaylistsPanel({ session }: { session: DjSession }) {
  const { lists, loaded } = useStore(session.playlists.store);
  const hist = useStore(session.history.store);
  const { pick, note } = useStore(playlistsView);
  const rig = useRig(session);
  const [outer, width] = useWidth();
  const narrow = width > 0 && width < SIDE_FROM;
  const sessions = useMemo(() => session.history.sessions(), [session, hist.entries]);
  const currentCount = sessions.find((x) => x.session === hist.session)?.entries.length ?? 0;
  const past = sessions.filter((x) => x.session !== hist.session);

  // What's shown: the pick if it still exists, else the first playlist, else the history.
  const list = pick?.kind === 'list' ? lists.find((l) => l.id === pick.id) : undefined;
  const shown: { kind: 'list'; list: Playlist } | { kind: 'history'; session: number } =
    list
      ? { kind: 'list', list }
      : pick?.kind === 'history'
        ? { kind: 'history', session: pick.session !== null && past.some((x) => x.session === pick.session) ? pick.session : hist.session }
        : lists[0]
          ? { kind: 'list', list: lists[0] }
          : { kind: 'history', session: hist.session };

  const create = () => {
    const pl = session.playlists.create();
    playlistsView.set({ pick: { kind: 'list', id: pl.id }, renaming: pl.id });
  };

  return (
    <div ref={outer} className={p.layout} data-narrow={narrow || undefined}>
      <nav className={p.side} aria-label="Playlists and history">
        <div className={p.sideTop}>
          <p className={p.sideHead}>Playlists</p>
          <button type="button" className={p.newBtn} onClick={create} title="Start a new playlist">
            + New
          </button>
        </div>
        <ul className={p.sideList} aria-label="Playlists">
          {lists.map((l, i) => (
            <SideItem
              key={l.id}
              session={session}
              list={l}
              index={i}
              on={shown.kind === 'list' && shown.list.id === l.id}
            />
          ))}
          {loaded && !lists.length && <li className={p.sideNone}>None yet</li>}
        </ul>
        <p className={p.sideHead}>History</p>
        <ul className={p.sideList} aria-label="History">
          <li>
            <button
              type="button"
              className={p.sideItem}
              aria-pressed={shown.kind === 'history' && shown.session === hist.session}
              onClick={() => pickHistory(null)}
            >
              <span className={p.sideName}>This session</span>
              <span className={p.count}>{currentCount}</span>
            </button>
          </li>
          {past.map((x) => (
            <li key={x.session}>
              <button
                type="button"
                className={p.sideItem}
                aria-pressed={shown.kind === 'history' && shown.session === x.session}
                onClick={() => pickHistory(x.session)}
              >
                <span className={p.sideName}>{sessionLabel(x.session)}</span>
                <span className={p.count}>{x.entries.length}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className={p.main}>
        {shown.kind === 'list' ? (
          <PlaylistView key={shown.list.id} session={session} list={shown.list} rig={rig} played={hist.played} index={lists.indexOf(shown.list)} total={lists.length} />
        ) : (
          <HistoryView
            session={session}
            sessionId={shown.session}
            current={shown.session === hist.session}
            entries={sessions.find((x) => x.session === shown.session)?.entries ?? []}
            rig={rig}
          />
        )}
        <p className={p.note} role="status">
          {note}
        </p>
      </div>
    </div>
  );
}

/** Whether a drag carries a track: a crate row, or a row of another playlist. */
const carriesTrack = (e: DragEvent) => e.dataTransfer.types.includes(TRACK_MIME);

/** A playlist in the sidebar: pick it, drag it to reorder, or drop a crate track on it. */
function SideItem({ session, list, index, on }: { session: DjSession; list: Playlist; index: number; on: boolean }) {
  const [over, setOver] = useState(false);
  const onDragOver = (e: DragEvent) => {
    if (carriesTrack(e)) e.dataTransfer.dropEffect = 'copy';
    else if (e.dataTransfer.types.includes(PLAYLIST_MIME)) e.dataTransfer.dropEffect = 'move';
    else return;
    e.preventDefault();
    setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    setOver(false);
    const moved = e.dataTransfer.getData(PLAYLIST_MIME);
    if (moved) {
      e.preventDefault();
      if (moved !== list.id) session.playlists.moveList(moved, index);
      return;
    }
    const id = e.dataTransfer.getData(TRACK_MIME);
    if (!id || !carriesTrack(e)) return;
    e.preventDefault();
    const title = session.crate.get().tracks.find((t) => t.id === id)?.title ?? 'The track';
    flashNote(session.playlists.add(list.id, [id]) ? `Added ${title} to ${list.name}` : `${title} is already in ${list.name}`);
  };
  return (
    <li>
      <button
        type="button"
        className={p.sideItem}
        aria-pressed={on}
        data-over={over || undefined}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PLAYLIST_MIME, list.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => pickList(list.id)}
        title="Drag to reorder, or drop a track from the crate here"
      >
        <span className={p.sideIcon} aria-hidden="true">
          <PlaylistIcon />
        </span>
        <span className={p.sideName}>{list.name}</span>
        <span className={p.count}>{list.trackIds.length}</span>
      </button>
    </li>
  );
}

/** One playlist: its name (renamable), its tracks in order, and the controls for both. */
function PlaylistView({
  session,
  list,
  rig,
  played,
  index,
  total,
}: {
  session: DjSession;
  list: Playlist;
  rig: Rig;
  played: ReadonlySet<string>;
  index: number;
  total: number;
}) {
  const { tracks } = useStore(session.crate);
  const { renaming } = useStore(playlistsView);
  const [confirm, setConfirm] = useState(false);
  const [drop, setDrop] = useState<{ at: number } | null>(null);
  const [active, setActive] = useState(0);
  const listEl = useRef<HTMLOListElement>(null);
  const focusAfter = useRef<number | null>(null);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const rows = list.trackIds.map((id) => byId.get(id)).filter((t): t is TrackRecord => !!t);
  const seconds = rows.reduce((s, t) => s + (t.duration || 0), 0);
  const playedHere = rows.filter((t) => played.has(t.id)).length;
  const editing = renaming === list.id;

  // After a keyboard move, focus follows the row to its new place.
  useEffect(() => {
    if (focusAfter.current === null) return;
    listEl.current?.querySelector<HTMLElement>(`[data-row="${focusAfter.current}"]`)?.focus();
    focusAfter.current = null;
  });

  const load = (t: TrackRecord, deck: 0 | 1 | null) => {
    if (deck === null || t.status === 'error' || rig.playing[deck]) return;
    void session.loadToDeck(t.id, deck);
  };
  // Row numbers count the tracks shown; the playlist's own order may also
  // hold a track that's just leaving the crate, so move by id.
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= rows.length || !rows[from]) return;
    session.playlists.moveTrack(list.id, list.trackIds.indexOf(rows[from].id), list.trackIds.indexOf(rows[to].id));
  };
  const focusRow = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setActive(n);
    listEl.current?.querySelector<HTMLElement>(`[data-row="${n}"]`)?.focus();
  };

  const onRowKey = (e: KeyboardEvent<HTMLLIElement>, i: number, t: TrackRecord) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey) return;
    const act: Record<string, () => void> = e.altKey
      ? {
          ArrowUp: () => {
            move(i, i - 1);
            focusAfter.current = Math.max(0, i - 1);
            setActive(Math.max(0, i - 1));
          },
          ArrowDown: () => {
            move(i, i + 1);
            focusAfter.current = Math.min(rows.length - 1, i + 1);
            setActive(Math.min(rows.length - 1, i + 1));
          },
        }
      : {
          ArrowUp: () => focusRow(i - 1),
          ArrowDown: () => focusRow(i + 1),
          Home: () => focusRow(0),
          End: () => focusRow(rows.length - 1),
          ArrowLeft: () => load(t, 0),
          ArrowRight: () => load(t, 1),
          Enter: () => load(t, rig.target),
          Delete: () => session.playlists.removeTrack(list.id, t.id),
          Backspace: () => session.playlists.removeTrack(list.id, t.id),
        };
    const fn = act[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  /** Where a drop over row `i` lands: before it in its top half, after it below. */
  const dropAt = (e: DragEvent<HTMLElement>, i: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? i : i + 1;
  };
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(PLAYLIST_ROW_MIME) || e.dataTransfer.types.includes(TRACK_MIME);
  const onDragOver = (e: DragEvent<HTMLElement>, at: number) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(PLAYLIST_ROW_MIME) ? 'move' : 'copy';
    if (drop?.at !== at) setDrop({ at });
  };
  const onDrop = (e: DragEvent<HTMLElement>, at: number) => {
    setDrop(null);
    const row = e.dataTransfer.getData(PLAYLIST_ROW_MIME);
    if (row) {
      e.preventDefault();
      e.stopPropagation();
      const [from_list, from_i] = row.split(' ');
      const from = Number(from_i);
      if (from_list !== list.id || !Number.isFinite(from)) return;
      // Taking the row out first shifts everything after it up by one.
      move(from, at > from ? at - 1 : at);
      return;
    }
    const id = e.dataTransfer.getData(TRACK_MIME);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const title = byId.get(id)?.title ?? 'The track';
    const fullAt = at < rows.length ? list.trackIds.indexOf(rows[at].id) : list.trackIds.length;
    flashNote(session.playlists.add(list.id, [id], fullAt) ? `Added ${title} to ${list.name}` : `${title} is already in ${list.name}`);
  };

  const safeActive = Math.min(active, Math.max(0, rows.length - 1));

  return (
    <section className={p.view} aria-label={`Playlist ${list.name}`}>
      <header className={p.head}>
        {editing ? (
          <form
            className={p.renameForm}
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get('name');
              if (typeof v === 'string') session.playlists.rename(list.id, v);
              playlistsView.set({ renaming: null });
            }}
          >
            <input
              name="name"
              className={p.renameInput}
              defaultValue={list.name}
              maxLength={80}
              aria-label="Playlist name"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => e.currentTarget.form?.requestSubmit()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  playlistsView.set({ renaming: null });
                }
              }}
            />
          </form>
        ) : (
          <h3 className={p.title} onDoubleClick={() => playlistsView.set({ renaming: list.id })} title="Double-click to rename">
            {list.name}
          </h3>
        )}
        <span className={p.meta}>
          {rows.length} track{rows.length === 1 ? '' : 's'}
          {seconds > 0 && ` · ${formatTime(seconds)}`}
          {playedHere > 0 && ` · ${playedHere} played`}
        </span>
        <div className={p.headActions}>
          {confirm ? (
            <>
              <span className={p.confirmText}>Delete “{list.name}”?</span>
              <button
                type="button"
                className={p.action}
                data-danger
                onClick={() => {
                  session.playlists.remove(list.id);
                  flashNote(`Deleted ${list.name}`);
                }}
              >
                Delete
              </button>
              <button type="button" className={p.action} data-quiet onClick={() => setConfirm(false)} autoFocus>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className={p.action} data-quiet onClick={() => playlistsView.set({ renaming: list.id })} disabled={editing}>
                Rename
              </button>
              <button
                type="button"
                className={p.mini}
                onClick={() => session.playlists.moveList(list.id, index - 1)}
                disabled={index <= 0}
                aria-label={`Move ${list.name} up the list of playlists`}
                title="Move this playlist up"
              >
                ▴
              </button>
              <button
                type="button"
                className={p.mini}
                onClick={() => session.playlists.moveList(list.id, index + 1)}
                disabled={index >= total - 1}
                aria-label={`Move ${list.name} down the list of playlists`}
                title="Move this playlist down"
              >
                ▾
              </button>
              <button type="button" className={p.action} data-quiet onClick={() => setConfirm(true)}>
                Delete
              </button>
            </>
          )}
        </div>
      </header>
      {rows.length ? (
        <>
          <ol
            ref={listEl}
            className={p.rows}
            aria-label={`Tracks in ${list.name}`}
            onDragOver={(e) => onDragOver(e, rows.length)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
            }}
            onDrop={(e) => onDrop(e, rows.length)}
          >
            {rows.map((t, i) => {
              const on = rig.loadedOn(t.id);
              const was = played.has(t.id);
              const tab = i === safeActive ? 0 : -1;
              return (
                <li
                  key={t.id}
                  data-row={i}
                  tabIndex={tab}
                  className={p.row}
                  data-loaded={on || undefined}
                  data-played={was || undefined}
                  data-drop={drop?.at === i ? 'before' : drop?.at === i + 1 && i === rows.length - 1 ? 'after' : undefined}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PLAYLIST_ROW_MIME, `${list.id} ${i}`);
                    // Also a track: it can go straight onto a deck.
                    e.dataTransfer.setData(TRACK_MIME, t.id);
                    e.dataTransfer.effectAllowed = 'copyMove';
                  }}
                  onDragEnd={() => setDrop(null)}
                  onDragOver={(e) => onDragOver(e, dropAt(e, i))}
                  onDrop={(e) => onDrop(e, dropAt(e, i))}
                  onFocus={() => setActive(i)}
                  onKeyDown={(e) => onRowKey(e, i, t)}
                  onDoubleClick={(e) => {
                    if (!(e.target as HTMLElement).closest('button')) load(t, rig.target);
                  }}
                  aria-label={`${i + 1}. ${t.title}${t.artist ? `, ${t.artist}` : ''}${t.bpm ? `, ${t.bpm.toFixed(0)} BPM` : ''}${t.key ? `, ${t.key}` : ''}${was ? ', played this session' : ''}${on ? `, on deck ${on}` : ''}`}
                >
                  <span className={p.num} aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className={p.titles}>
                    <span className={p.titleLine}>
                      {was && (
                        <span className={p.tick} title="Played this session" aria-hidden="true">
                          ✓
                        </span>
                      )}
                      <span className={p.trackTitle}>{t.title}</span>
                      {on &&
                        on.split(' ').map((d) => (
                          <span key={d} className={p.onDeck} data-deck={d} title={`Loaded on deck ${d}`}>
                            {d}
                          </span>
                        ))}
                    </span>
                    <span className={p.artist}>{t.artist || 'Unknown artist'}</span>
                  </span>
                  <span className={p.facts} aria-hidden="true">
                    <span className={p.fact}>{t.bpm ? t.bpm.toFixed(1) : '—'}</span>
                    <span className={p.fact} data-key>
                      {t.key ?? '—'}
                    </span>
                    <span className={p.fact}>{t.duration ? formatTime(t.duration) : '—'}</span>
                  </span>
                  <span className={p.rowActions}>
                    {([0, 1] as const).map((d) => {
                      const L = d === 0 ? 'A' : 'B';
                      return (
                        <button
                          key={L}
                          type="button"
                          className={p.load}
                          data-deck={L}
                          data-target={rig.target === d || undefined}
                          tabIndex={tab}
                          disabled={t.status === 'error' || rig.playing[d]}
                          title={rig.playing[d] ? `Deck ${L} is playing` : `Load on deck ${L} (${d === 0 ? '←' : '→'})`}
                          onClick={() => load(t, d)}
                          aria-label={`Load ${t.title} on deck ${L}`}
                        >
                          {L}
                        </button>
                      );
                    })}
                    <button type="button" className={p.mini} tabIndex={tab} disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${t.title} up`} title="Move up (Alt+↑)">
                      ▴
                    </button>
                    <button
                      type="button"
                      className={p.mini}
                      tabIndex={tab}
                      disabled={i === rows.length - 1}
                      onClick={() => move(i, i + 1)}
                      aria-label={`Move ${t.title} down`}
                      title="Move down (Alt+↓)"
                    >
                      ▾
                    </button>
                    <button
                      type="button"
                      className={p.remove}
                      tabIndex={tab}
                      onClick={() => session.playlists.removeTrack(list.id, t.id)}
                      aria-label={`Take ${t.title} out of ${list.name}`}
                      title="Take out of this playlist (Delete)"
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
          <p className={p.legend} aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> pick <kbd>←</kbd> deck A <kbd>→</kbd> deck B <kbd>Alt</kbd>+<kbd>↑</kbd>
            <kbd>↓</kbd> move · drag rows to reorder, or onto a deck
          </p>
        </>
      ) : (
        <div
          className={p.empty}
          data-over={drop ? true : undefined}
          onDragOver={(e) => onDragOver(e, 0)}
          onDragLeave={() => setDrop(null)}
          onDrop={(e) => onDrop(e, 0)}
        >
          <p className={p.emptyTitle}>Nothing in it yet</p>
          <p className={p.emptyText}>
            In the crate, press the playlist button on a row (
            <span className={p.inlineIcon}>
              <PlaylistIcon />
            </span>
            ) and pick this playlist. Or drag rows here from the crate’s mini window or full screen.
          </p>
        </div>
      )}
    </section>
  );
}
