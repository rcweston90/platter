import { useEffect, useId, useRef, useState } from 'react';
import type { DjSession } from '../engine/session';
import {
  checkSoundCloud,
  likedTracks,
  moreTracks,
  myPlaylists,
  myUploads,
  playlistTracks,
  searchTracks,
  signInToSoundCloud,
  signOutOfSoundCloud,
  soundcloud,
  type ScPage,
  type ScPlaylist,
  type ScTrack,
} from '../engine/soundcloud';
import { useStore } from '../engine/store';
import { SearchBar } from './SearchBar';
import { TrackRow } from './TrackRow';
import { formatTime } from './Waveforms';
import s from '../platter.module.css';

type Shelf = 'likes' | 'playlists' | 'uploads';
type View = { kind: Shelf } | { kind: 'playlist'; list: ScPlaylist } | { kind: 'search'; q: string };

const SHELVES: { id: Shelf; label: string }[] = [
  { id: 'likes', label: 'Likes' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'uploads', label: 'Your uploads' },
];

const label = (v: View) =>
  v.kind === 'likes' ? 'your likes' : v.kind === 'uploads' ? 'your uploads' : v.kind === 'playlists' ? 'your playlists' : v.kind === 'playlist' ? `“${v.list.title}”` : v.kind === 'search' ? `“${v.q}”` : '';

/** Your SoundCloud: search, likes, playlists and uploads, onto the decks where the artist allows it. */
export function SoundCloudPanel({ session }: { session: DjSession }) {
  const auth = useStore(soundcloud);
  useEffect(() => void checkSoundCloud(), []);

  if (auth.state === 'checking') {
    return (
      <p className={s.sourceNote} role="status">
        Checking SoundCloud…
      </p>
    );
  }
  if (auth.state === 'unavailable') {
    return (
      <div className={s.sourceEmpty}>
        <p className={s.sourceEmptyTitle}>SoundCloud isn’t available on this copy</p>
        <p className={s.sourceNote}>It needs Platter’s Vercel site, where the SoundCloud app keys are set. This copy is a static page, so it can’t sign in.</p>
      </div>
    );
  }
  if (auth.state !== 'signed-in') {
    return (
      <div className={s.sourceEmpty}>
        <p className={s.sourceEmptyTitle}>Play your SoundCloud on the decks</p>
        <p className={s.sourceNote}>Sign in to search SoundCloud and see your likes, playlists and uploads.</p>
        <button type="button" className={s.primaryBtn} data-autofocus disabled={auth.state === 'signing-in'} onClick={() => void signInToSoundCloud()}>
          {auth.state === 'signing-in' ? 'Signing in…' : 'Sign in with SoundCloud'}
        </button>
        {auth.error && (
          <p className={s.sourceError} role="alert">
            {auth.error}
          </p>
        )}
        <p className={s.sourceNote}>
          Your own uploads, and tracks whose artist chose a Creative Commons license that allows remixes, load onto the decks. SoundCloud’s terms keep every
          other track on SoundCloud, so those link out. Audio streams each time a track loads and is never saved.
        </p>
      </div>
    );
  }
  return <Browser session={session} />;
}

function Browser({ session }: { session: DjSession }) {
  const { user } = useStore(soundcloud);
  const [view, setView] = useState<View>({ kind: 'likes' });
  const [tracks, setTracks] = useState<ScTrack[]>([]);
  const [lists, setLists] = useState<ScPlaylist[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [mixableOnly, setMixableOnly] = useState(false);
  const [query, setQuery] = useState('');
  const abort = useRef<AbortController | null>(null);
  const a = useStore(session.decks[0].store);
  const b = useStore(session.decks[1].store);
  const onlyId = useId();

  const run = <T,>(fn: (signal: AbortSignal) => Promise<ScPage<T>>, apply: (page: ScPage<T>) => void, what: string, append = false) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    if (!append) setStatus(`Loading ${what}…`);
    fn(ctl.signal)
      .then((page) => {
        apply(page);
        setNext(page.next);
        setStatus('');
      })
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') return;
        setStatus(err instanceof Error && err.name === 'SoundCloudError' ? err.message : 'Couldn’t reach SoundCloud. Check your connection and try again.');
      })
      .finally(() => {
        if (abort.current === ctl) setBusy(false);
      });
  };

  const show = (v: View) => {
    setView(v);
    setNext(null);
    if (v.kind === 'playlists') {
      setTracks([]);
      run((sig) => myPlaylists(sig), (p) => setLists(p.items), label(v));
      return;
    }
    setLists([]);
    if (!(v.kind === 'search' && view.kind === 'search')) setTracks([]);
    const fn =
      v.kind === 'likes'
        ? likedTracks
        : v.kind === 'uploads'
          ? myUploads
          : v.kind === 'playlist'
            ? (sig: AbortSignal) => playlistTracks(v.list.urn, sig)
            : v.kind === 'search'
              ? (sig: AbortSignal) => searchTracks(v.q, sig)
              : likedTracks;
    run(fn, (p) => setTracks(p.items), label(v));
  };

  const more = () => {
    if (!next) return;
    if (view.kind === 'playlists') run((sig) => myPlaylists(sig, next), (p) => setLists((l) => [...l, ...p.items]), label(view), true);
    else run((sig) => moreTracks(next, sig), (p) => setTracks((t) => [...t, ...p.items]), label(view), true);
  };

  useEffect(() => {
    show({ kind: 'likes' });
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async (t: ScTrack, deck: 0 | 1) => {
    const id = await session.addSoundCloud(t);
    if (id) void session.loadToDeck(id, deck);
  };

  const mixable = tracks.filter((t) => t.mixable).length;
  const shown = mixableOnly ? tracks.filter((t) => t.mixable) : tracks;
  const shelf = view.kind === 'playlist' ? 'playlists' : view.kind;

  const summary =
    status ||
    (view.kind === 'playlists'
      ? `${lists.length} playlist${lists.length === 1 ? '' : 's'}`
      : tracks.length
        ? `${tracks.length} tracks in ${label(view)} · ${mixable} can go on the decks`
        : `Nothing in ${label(view)}.`);

  return (
    <div className={s.sourceBody}>
      <div className={s.sourceTop}>
        <SearchBar
          label="Search SoundCloud"
          placeholder="Search tracks and artists"
          value={query}
          onChange={setQuery}
          busy={busy && view.kind === 'search'}
          onSearch={(q) => show({ kind: 'search', q })}
          onClear={() => {
            setQuery('');
            if (view.kind === 'search') show({ kind: 'likes' });
          }}
        />
        <div className={s.shelfRow}>
          <div className={s.segmented} role="group" aria-label="Your SoundCloud">
            {SHELVES.map((t) => (
              <button key={t.id} type="button" className={s.segment} aria-pressed={shelf === t.id} onClick={() => show({ kind: t.id })}>
                {t.label}
              </button>
            ))}
          </div>
          <label htmlFor={onlyId} className={s.switch}>
            <input id={onlyId} type="checkbox" role="switch" checked={mixableOnly} onChange={(e) => setMixableOnly(e.target.checked)} />
            <span>Mixable only</span>
          </label>
        </div>
        {view.kind === 'playlist' && (
          <button type="button" className={s.backLink} onClick={() => show({ kind: 'playlists' })}>
            ‹ All playlists <span className={s.dim}>/ {view.list.title}</span>
          </button>
        )}
        {view.kind === 'search' && <p className={s.resultsFor}>Results for “{view.q}”</p>}
        <p className={s.sourceNote} role="status">
          {summary}
        </p>
      </div>

      {view.kind === 'playlists' && lists.length > 0 && (
        <ul className={s.trackList}>
          {lists.map((p) => (
            <li key={p.urn} className={s.trackRow}>
              {p.artwork ? <img src={p.artwork} alt="" className={s.trackArt} loading="lazy" /> : <span className={s.trackArt} aria-hidden="true" />}
              <button type="button" className={s.playlistOpen} onClick={() => show({ kind: 'playlist', list: p })} aria-label={`Open ${p.title}`}>
                <span className={s.trackRowTitle}>{p.title}</span>
                <span className={s.trackRowArtist}>
                  {p.count} track{p.count === 1 ? '' : 's'}
                </span>
              </button>
              <div className={s.trackActions}>
                <a className={s.trackLink} href={p.link} target="_blank" rel="noopener noreferrer" aria-label={`${p.title} on SoundCloud`}>
                  ↗
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {view.kind !== 'playlists' && shown.length > 0 && (
        <ul className={s.trackList}>
          {shown.map((t) => (
            <TrackRow
              key={t.urn}
              title={t.title}
              artist={t.artist}
              artwork={t.artwork}
              meta={[formatTime(t.duration), t.bpm ? `${t.bpm} BPM` : '', t.genre, t.mine ? 'Your upload' : t.licenseName]}
              badge={t.mixable ? { text: 'Mixable', tone: 'go' } : { text: 'SoundCloud only', tone: 'muted' }}
              note={t.reason}
              load={
                t.mixable
                  ? {
                      a: () => void load(t, 0),
                      b: () => void load(t, 1),
                      add: () => void session.addSoundCloud(t),
                      aDisabled: a.playing,
                      bDisabled: b.playing,
                    }
                  : undefined
              }
              link={t.link}
              linkLabel={t.mixable ? '↗' : 'Play on SoundCloud ↗'}
              linkName={`${t.title} by ${t.artist} on SoundCloud`}
            />
          ))}
        </ul>
      )}

      {view.kind !== 'playlists' && tracks.length > 0 && shown.length === 0 && (
        <p className={s.sourceNote}>None of these can go on the decks. Turn off “Mixable only” to see them, or try your uploads.</p>
      )}

      {next && (
        <button type="button" className={s.moreBtn} disabled={busy} onClick={more}>
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}

      <p className={s.sourceFoot}>
        Signed in as{' '}
        <a href={user?.link} target="_blank" rel="noopener noreferrer">
          {user?.name}
        </a>{' '}
        on SoundCloud ·{' '}
        <button type="button" className={s.linkBtn} onClick={() => void signOutOfSoundCloud()}>
          Sign out
        </button>
        . Tracks stream from SoundCloud, are never saved, and link back to their artist.
      </p>
    </div>
  );
}
