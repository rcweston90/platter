import { useMemo, useState } from 'react';
import { tracklistName, tracklistText, type HistoryEntry } from '../../engine/history';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import type { Rig } from '../crate/rig';
import { saveFile } from '../save';
import { clock, flashNote, pickHistory, sessionLabel } from './playlistsModel';
import p from './playlists.module.css';

/**
 * One session of play history: each track that played for a minute, when it
 * started and on which deck, in the order you played them. Export it as a
 * plain-text tracklist, or clear it.
 */
export function HistoryView({
  session,
  sessionId,
  current,
  entries,
  rig,
}: {
  session: DjSession;
  sessionId: number;
  current: boolean;
  entries: HistoryEntry[];
  rig: Rig;
}) {
  const { tracks } = useStore(session.crate);
  const [confirm, setConfirm] = useState<'session' | 'all' | null>(null);
  const inCrate = useMemo(() => new Set(tracks.map((t) => t.id)), [tracks]);
  const hasAny = session.history.store.get().entries.length > 0;
  const rows = [...entries].sort((a, b) => a.startedAt - b.startedAt);

  const exportList = () => {
    const text = tracklistText(rows);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    void saveFile(tracklistName(rows[0]?.startedAt ?? sessionId), blob, url).then((msg) => {
      flashNote(msg ?? `Saved the tracklist (${rows.length} track${rows.length === 1 ? '' : 's'})`);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  };

  const load = (id: string, deck: 0 | 1) => {
    if (rig.playing[deck] || !inCrate.has(id)) return;
    void session.loadToDeck(id, deck);
  };

  return (
    <section className={p.view} aria-label={current ? 'History of this session' : `History of ${sessionLabel(sessionId)}`}>
      <header className={p.head}>
        <h3 className={p.title}>{current ? 'This session' : sessionLabel(sessionId)}</h3>
        <span className={p.meta}>
          {rows.length} track{rows.length === 1 ? '' : 's'}
          {rows.length > 0 && ` · from ${clock(rows[0].startedAt)}`}
        </span>
        <div className={p.headActions}>
          {confirm ? (
            <>
              <span className={p.confirmText}>{confirm === 'all' ? 'Clear all history?' : 'Clear this session?'}</span>
              <button
                type="button"
                className={p.action}
                data-danger
                onClick={() => {
                  session.history.clear(confirm === 'all' ? undefined : sessionId);
                  flashNote(confirm === 'all' ? 'Cleared all history' : 'Cleared this session’s history');
                  setConfirm(null);
                  pickHistory(null);
                }}
              >
                Clear
              </button>
              <button type="button" className={p.action} data-quiet onClick={() => setConfirm(null)} autoFocus>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className={p.action} onClick={exportList} disabled={!rows.length} title="Download this session as a plain-text tracklist">
                Export tracklist
              </button>
              <button type="button" className={p.action} data-quiet onClick={() => setConfirm('session')} disabled={!rows.length}>
                Clear session
              </button>
              <button type="button" className={p.action} data-quiet onClick={() => setConfirm('all')} disabled={!hasAny}>
                Clear all
              </button>
            </>
          )}
        </div>
      </header>
      {rows.length ? (
        <ol className={p.rows} aria-label="Played tracks">
          {rows.map((e, i) => {
            const here = inCrate.has(e.trackId);
            return (
              <li key={e.id} className={p.row} data-history>
                <span className={p.num} aria-hidden="true">
                  {i + 1}
                </span>
                <span className={p.when}>
                  <time dateTime={new Date(e.startedAt).toISOString()}>{clock(e.startedAt)}</time>
                </span>
                <span className={p.deckTag} data-deck={e.deck} title={`Played on deck ${e.deck}`}>
                  {e.deck}
                  <span className={p.srOnly}> deck</span>
                </span>
                <span className={p.titles}>
                  <span className={p.titleLine}>
                    <span className={p.trackTitle}>{e.title}</span>
                  </span>
                  <span className={p.artist}>
                    {e.artist || 'Unknown artist'}
                    {!here && ' · no longer in the crate'}
                  </span>
                </span>
                <span className={p.facts} aria-hidden="true">
                  <span className={p.fact}>{e.bpm ? e.bpm.toFixed(1) : '—'}</span>
                  <span className={p.fact} data-key>
                    {e.key ?? '—'}
                  </span>
                </span>
                <span className={p.rowActions}>
                  {here &&
                    ([0, 1] as const).map((d) => {
                      const L = d === 0 ? 'A' : 'B';
                      return (
                        <button
                          key={L}
                          type="button"
                          className={p.load}
                          data-deck={L}
                          disabled={rig.playing[d]}
                          title={rig.playing[d] ? `Deck ${L} is playing` : `Load on deck ${L}`}
                          onClick={() => load(e.trackId, d)}
                          aria-label={`Load ${e.title} on deck ${L}`}
                        >
                          {L}
                        </button>
                      );
                    })}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className={p.empty}>
          <p className={p.emptyTitle}>{current ? 'Nothing played yet' : 'Nothing here'}</p>
          <p className={p.emptyText}>
            A track joins the history once it has played on a deck for {Math.round(session.history.threshold / 1000)} seconds, counting only time it was
            actually playing. Tracks played this session get a tick in the crate and in playlists. A new session starts when the page loads, or after two
            hours with nothing playing.
          </p>
        </div>
      )}
    </section>
  );
}
