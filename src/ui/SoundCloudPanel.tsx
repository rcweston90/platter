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
import { formatTime } from './Waveforms';
import s from '../platter.module.css';

type View = { kind: 'likes' } | { kind: 'uploads' } | { kind: 'playlists' } | { kind: 'playlist'; list: ScPlaylist } | { kind: 'search'; q: string };

const label = (v: View) =>
  v.kind === 'likes' ? 'your likes' : v.kind === 'uploads' ? 'your uploads' : v.kind === 'playlists' ? 'your playlists' : v.kind === 'playlist' ? `“${v.list.title}”` : `“${v.q}”`;

/** Your SoundCloud: likes, playlists and uploads, onto the decks where the artist allows it. */
export function SoundCloudPanel({ session }: { session: DjSession }) {
  const auth = useStore(soundcloud);
  useEffect(() => void checkSoundCloud(), []);

  if (auth.state === 'checking') {
    return (
      <div className={s.panelBody}>
        <p className={s.crateNote} role="status">
          Checking SoundCloud…
        </p>
      </div>
    );
  }
  if (auth.state === 'unavailable') {
    return (
      <div className={s.panelBody}>
        <p className={s.crateNote}>
          SoundCloud needs Platter’s server side, which runs on its Vercel site with the SoundCloud app keys set. This copy is a static page, so it can’t
          sign in.
        </p>
      </div>
    );
  }
  if (auth.state !== 'signed-in') {
    return (
      <div className={s.panelBody}>
        <div className={s.crateHead}>
          <button type="button" className={s.action} disabled={auth.state === 'signing-in'} onClick={() => void signInToSoundCloud()}>
            {auth.state === 'signing-in' ? 'Signing in…' : 'Sign in with SoundCloud'}
          </button>
        </div>
        <p className={s.crateNote} role="status">
          {auth.error ? `${auth.error} ` : ''}
          Sign in to see your likes, playlists and uploads. Your own tracks, and tracks whose artist chose a Creative Commons license that allows remixes,
          can go on the decks; SoundCloud’s terms keep everything else on{' '}
          <a href="https://soundcloud.com" target="_blank" rel="noopener noreferrer">
            SoundCloud
          </a>
          . Audio streams each time a track loads and is never saved.
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
  const searchId = useId();
  const onlyId = useId();

  const run = <T,>(fn: (signal: AbortSignal) => Promise<ScPage<T>>, apply: (page: ScPage<T>) => number, what: string, append = false) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    if (!append) setStatus(`Loading ${what}…`);
    fn(ctl.signal)
      .then((page) => {
        const n = apply(page);
        setNext(page.next);
        setStatus(n ? '' : `Nothing in ${what}.`);
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
      run((sig) => myPlaylists(sig), (p) => (setLists(p.items), p.items.length), label(v));
      return;
    }
    setLists([]);
    const fn =
      v.kind === 'likes'
        ? likedTracks
        : v.kind === 'uploads'
          ? myUploads
          : v.kind === 'playlist'
            ? (sig: AbortSignal) => playlistTracks(v.list.urn, sig)
            : (sig: AbortSignal) => searchTracks(v.q, sig);
    run(fn, (p) => (setTracks(p.items), p.items.length), label(v));
  };

  const more = () => {
    if (!next) return;
    if (view.kind === 'playlists') run((sig) => myPlaylists(sig, next), (p) => (setLists((l) => [...l, ...p.items]), p.items.length), label(view), true);
    else run((sig) => moreTracks(next, sig), (p) => (setTracks((t) => [...t, ...p.items]), p.items.length), label(view), true);
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

  const shown = mixableOnly ? tracks.filter((t) => t.mixable) : tracks;
  const hidden = tracks.length - shown.length;

  return (
    <div className={s.panelBody}>
      <form
        className={s.crateHead}
        onSubmit={(e) => {
          e.preventDefault();
          const q = query.trim();
          if (q) show({ kind: 'search', q });
        }}
      >
        <label htmlFor={searchId} className={s.srOnly}>
          Search SoundCloud
        </label>
        <input id={searchId} type="search" className={s.search} placeholder="Search SoundCloud" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" className={s.action} disabled={busy || !query.trim()}>
          Search
        </button>
      </form>
      <div className={s.genres} role="group" aria-label="Your SoundCloud">
        {(['likes', 'playlists', 'uploads'] as const).map((k) => (
          <button key={k} type="button" className={s.mini} aria-pressed={view.kind === k} onClick={() => show({ kind: k })}>
            {k === 'likes' ? 'Likes' : k === 'playlists' ? 'Playlists' : 'Your uploads'}
          </button>
        ))}
        {view.kind === 'playlist' && (
          <button type="button" className={s.mini} aria-pressed onClick={() => show({ kind: 'playlists' })}>
            ‹ {view.list.title}
          </button>
        )}
        <label htmlFor={onlyId} className={s.scToggle}>
          <input id={onlyId} type="checkbox" checked={mixableOnly} onChange={(e) => setMixableOnly(e.target.checked)} /> Playable on decks only
        </label>
      </div>
      <p className={s.crateNote} role="status">
        {status || (view.kind === 'playlists' ? `${lists.length} playlists.` : `${shown.length} tracks in ${label(view)}${hidden ? ` (${hidden} hidden)` : ''}.`)}{' '}
        Signed in as{' '}
        <a href={user?.link} target="_blank" rel="noopener noreferrer">
          {user?.name}
        </a>{' '}
        on SoundCloud ·{' '}
        <button type="button" className={s.linkBtn} onClick={() => void signOutOfSoundCloud()}>
          Sign out
        </button>
        . Tracks stream from SoundCloud and are never saved; each links back to its artist.
      </p>

      {view.kind === 'playlists' && lists.length > 0 && (
        <ul className={s.audiusList}>
          {lists.map((p) => (
            <li key={p.urn} className={s.audiusRow}>
              {p.artwork ? <img src={p.artwork} alt="" className={s.audiusArt} loading="lazy" /> : <span className={s.audiusArt} />}
              <span className={s.audiusMeta}>
                <span className={s.rowTitle}>{p.title}</span>
                <span className={s.dim}>
                  {p.count} track{p.count === 1 ? '' : 's'}
                </span>
              </span>
              <span className={s.audiusActions}>
                <button type="button" className={s.loadBtn} onClick={() => show({ kind: 'playlist', list: p })} aria-label={`Open ${p.title}`}>
                  Open
                </button>
                <a className={s.rowLink} href={p.link} target="_blank" rel="noopener noreferrer" aria-label={`${p.title} on SoundCloud`}>
                  ↗
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}

      {view.kind !== 'playlists' && shown.length > 0 && (
        <ul className={s.audiusList}>
          {shown.map((t) => (
            <li key={t.urn} className={s.audiusRow} data-mixable={t.mixable}>
              {t.artwork ? <img src={t.artwork} alt="" className={s.audiusArt} loading="lazy" /> : <span className={s.audiusArt} />}
              <span className={s.audiusMeta}>
                <span className={s.rowTitle}>{t.title}</span>
                <span className={s.dim}>
                  {t.artist} · {formatTime(t.duration)} · {t.mine ? 'your upload' : t.licenseName}
                </span>
                {t.reason && <span className={s.dim}>{t.reason}</span>}
              </span>
              <span className={s.audiusActions}>
                {t.mixable && (
                  <>
                    <button type="button" className={s.loadBtn} data-deck="A" disabled={a.playing} onClick={() => void load(t, 0)} aria-label={`Load ${t.title} on deck A`}>
                      A
                    </button>
                    <button type="button" className={s.loadBtn} data-deck="B" disabled={b.playing} onClick={() => void load(t, 1)} aria-label={`Load ${t.title} on deck B`}>
                      B
                    </button>
                    <button type="button" className={s.loadBtn} onClick={() => void session.addSoundCloud(t)} aria-label={`Add ${t.title} to the crate`}>
                      +
                    </button>
                  </>
                )}
                <a className={s.rowLink} href={t.link} target="_blank" rel="noopener noreferrer" aria-label={`${t.title} by ${t.artist} on SoundCloud`}>
                  {t.mixable ? '↗' : 'Play on SoundCloud ↗'}
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}

      {next && (
        <button type="button" className={s.action} disabled={busy} onClick={more}>
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
