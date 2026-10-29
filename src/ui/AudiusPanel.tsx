import { useEffect, useId, useRef, useState } from 'react';
import { searchAudius, trendingAudius, type AudiusTrack } from '../engine/audius';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { formatTime } from './Waveforms';
import s from '../platter.module.css';

const GENRES = ['Electronic', 'House', 'Techno', 'Drum & Bass', 'Dubstep', 'Hip-Hop/Rap'];

/** Inside a sandboxed host (the claude.ai viewer) pages can't reach other sites. */
const sandboxed = () => typeof (window as unknown as { claude?: unknown }).claude !== 'undefined';

/** Browse and stream Audius — open, free music — straight onto the decks. */
export function AudiusPanel({ session }: { session: DjSession }) {
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState<string | null>(null);
  const [results, setResults] = useState<AudiusTrack[]>([]);
  const [status, setStatus] = useState<string>('Search Audius, or pick a genre to see what’s trending this week.');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const a = useStore(session.decks[0].store);
  const b = useStore(session.decks[1].store);
  const searchId = useId();

  const run = (fn: (signal: AbortSignal) => Promise<AudiusTrack[]>, label: string) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setStatus(`Loading ${label}…`);
    fn(ctl.signal)
      .then((list) => {
        setResults(list);
        setStatus(list.length ? `${list.length} tracks — ${label}.` : `Nothing found for ${label}.`);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') return;
        setResults([]);
        setStatus(
          sandboxed()
            ? 'This page can’t reach Audius: claude.ai keeps pages away from other sites. Open Platter on its own site to browse Audius.'
            : 'Couldn’t reach Audius. Check your connection and try again.',
        );
      })
      .finally(() => {
        if (abort.current === ctl) setBusy(false);
      });
  };

  useEffect(() => () => abort.current?.abort(), []);

  const load = async (t: AudiusTrack, deck: 0 | 1) => {
    const id = await session.addAudius(t);
    void session.loadToDeck(id, deck);
  };

  return (
    <div className={s.panelBody}>
      <form
        className={s.crateHead}
        onSubmit={(e) => {
          e.preventDefault();
          const q = query.trim();
          if (!q) return;
          setGenre(null);
          run((signal) => searchAudius(q, signal), `“${q}”`);
        }}
      >
        <label htmlFor={searchId} className={s.srOnly}>
          Search Audius
        </label>
        <input id={searchId} type="search" className={s.search} placeholder="Search Audius" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" className={s.action} disabled={busy || !query.trim()}>
          Search
        </button>
      </form>
      <div className={s.genres} role="group" aria-label="Trending by genre">
        {GENRES.map((g) => (
          <button
            key={g}
            type="button"
            className={s.mini}
            aria-pressed={genre === g}
            onClick={() => {
              setGenre(g);
              run((signal) => trendingAudius(g, signal), `trending in ${g}`);
            }}
          >
            {g}
          </button>
        ))}
      </div>
      <p className={s.crateNote} role="status">
        {status} Tracks stream from{' '}
        <a href="https://audius.co" target="_blank" rel="noopener noreferrer">
          Audius
        </a>
        ; adding one to the crate keeps a link back to the artist.
      </p>
      {results.length > 0 && (
        <ul className={s.audiusList}>
          {results.map((t) => (
            <li key={t.id} className={s.audiusRow}>
              {t.artwork ? <img src={t.artwork} alt="" className={s.audiusArt} loading="lazy" /> : <span className={s.audiusArt} />}
              <span className={s.audiusMeta}>
                <span className={s.rowTitle}>{t.title}</span>
                <span className={s.dim}>
                  {t.artist}
                  {t.genre ? ` · ${t.genre}` : ''} · {formatTime(t.duration)}
                </span>
              </span>
              <span className={s.audiusActions}>
                <button type="button" className={s.loadBtn} data-deck="A" disabled={a.playing} onClick={() => void load(t, 0)} aria-label={`Load ${t.title} on deck A`}>
                  A
                </button>
                <button type="button" className={s.loadBtn} data-deck="B" disabled={b.playing} onClick={() => void load(t, 1)} aria-label={`Load ${t.title} on deck B`}>
                  B
                </button>
                <button type="button" className={s.loadBtn} onClick={() => void session.addAudius(t)} aria-label={`Add ${t.title} to the crate`}>
                  +
                </button>
                <a className={s.rowLink} href={t.link} target="_blank" rel="noopener noreferrer" aria-label={`${t.title} on Audius`}>
                  ↗
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
