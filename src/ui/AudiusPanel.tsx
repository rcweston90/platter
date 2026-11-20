import { useEffect, useRef, useState } from 'react';
import { searchAudius, trendingAudius, type AudiusTrack } from '../engine/audius';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { SearchBar } from './SearchBar';
import { TrackRow } from './TrackRow';
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
  const [status, setStatus] = useState<string>('Search, or pick a genre to see what’s trending this week.');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const a = useStore(session.decks[0].store);
  const b = useStore(session.decks[1].store);

  const run = (fn: (signal: AbortSignal) => Promise<AudiusTrack[]>, label: string) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setStatus(`Loading ${label}…`);
    fn(ctl.signal)
      .then((list) => {
        setResults(list);
        setStatus(list.length ? `${list.length} tracks: ${label}.` : `Nothing found for ${label}.`);
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
    <div className={s.sourceBody}>
      <div className={s.sourceTop}>
        <SearchBar
          label="Search Audius"
          placeholder="Search tracks and artists"
          value={query}
          onChange={setQuery}
          busy={busy && genre === null}
          onSearch={(q) => {
            setGenre(null);
            run((signal) => searchAudius(q, signal), `“${q}”`);
          }}
          onClear={() => setQuery('')}
        />
        <div className={s.genres} role="group" aria-label="Trending this week by genre">
          {GENRES.map((g) => (
            <button
              key={g}
              type="button"
              className={s.chip}
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
        <p className={s.sourceNote} role="status">
          {status}
        </p>
      </div>
      {results.length > 0 && (
        <ul className={s.trackList}>
          {results.map((t) => (
            <TrackRow
              key={t.id}
              title={t.title}
              artist={t.artist}
              artwork={t.artwork}
              meta={[formatTime(t.duration), t.genre]}
              load={{ a: () => void load(t, 0), b: () => void load(t, 1), add: () => void session.addAudius(t), aDisabled: a.playing, bDisabled: b.playing }}
              link={t.link}
              linkLabel="↗"
              linkName={`${t.title} by ${t.artist} on Audius`}
            />
          ))}
        </ul>
      )}
      <p className={s.sourceFoot}>
        Tracks stream from{' '}
        <a href="https://audius.co" target="_blank" rel="noopener noreferrer">
          Audius
        </a>
        , open and free music. Adding one to the crate keeps a link back to the artist.
      </p>
    </div>
  );
}
