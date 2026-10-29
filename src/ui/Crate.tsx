
import { useId, useMemo, useRef, useState } from 'react';
import { compatible, keyName } from '../engine/key';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import type { TrackRecord } from '../engine/types';
import { TRACK_MIME } from './DeckPanel';
import { canLinkFolder } from '../engine/folder';
import { useDropTarget } from './frame';
import { saveFile } from './save';
import { formatTime } from './Waveforms';
import s from '../platter.module.css';

type SortKey = 'added' | 'title' | 'artist' | 'bpm' | 'key' | 'duration';

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist', className: s.colArtist },
  { key: 'bpm', label: 'BPM', className: s.colNum },
  { key: 'key', label: 'Key', className: s.colNum },
  { key: 'duration', label: 'Time', className: `${s.colNum} ${s.colTime}` },
];

function compare(a: TrackRecord, b: TrackRecord, key: SortKey) {
  switch (key) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'artist':
      return a.artist.localeCompare(b.artist);
    case 'bpm':
      return (a.bpm ?? Infinity) - (b.bpm ?? Infinity);
    case 'key': {
      // Round the Camelot wheel: 1A, 1B, 2A, 2B …
      const n = (k: string | null) => (k ? parseInt(k, 10) * 2 + (k.endsWith('B') ? 1 : 0) : Infinity);
      return n(a.key) - n(b.key);
    }
    case 'duration':
      return a.duration - b.duration;
    default:
      return a.addedAt - b.addedAt;
  }
}

/** The track list: add files, search, sort, drag onto a deck or load with a button. */
export function Crate({ session }: { session: DjSession }) {
  const { tracks, loaded, note: crateNote } = useStore(session.crate);
  const { queue } = useStore(session.autoDj.store);
  const importInput = useRef<HTMLInputElement>(null);
  const a = useStore(session.decks[0].store);
  const b = useStore(session.decks[1].store);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'added', dir: 1 });
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchId = useId();

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? tracks.filter((t) => `${t.title} ${t.artist} ${t.fileName}`.toLowerCase().includes(q)) : tracks;
    return [...list].sort((x, y) => compare(x, y, sort.key) * sort.dir);
  }, [tracks, query, sort]);

  const add = (files: File[]) => {
    void session.addFiles(files).then((n) => {
      setNote(n ? null : 'Those files don’t look like audio.');
    });
  };

  const section = useRef<HTMLElement>(null);
  useDropTarget(
    section,
    (types) => types.includes('Files'),
    setOver,
    (data) => data.files.length && add(Array.from(data.files)),
  );

  const sortBy = (key: SortKey) =>
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  // What's playing sets the harmonic reference: the louder side of the
  // crossfader if both decks run.
  const mixer = useStore(session.mixer);
  const [deckA, deckB] = session.decks;
  const playingRef = a.playing && b.playing ? (mixer.crossfader > 0 ? deckB : deckA) : a.playing ? deckA : b.playing ? deckB : null;
  const refKey = playingRef?.effectiveKey() ?? null;

  const loadedOn = (id: string) => [a.track?.id === id ? 'A' : null, b.track?.id === id ? 'B' : null].filter(Boolean).join(' ');

  return (
    <section ref={section} className={`${s.crate} ${over ? s.crateOver : ''}`} aria-label="Crate">
      <header className={s.crateHead}>
        <h2 className={s.crateTitle}>Crate</h2>
        <label htmlFor={searchId} className={s.srOnly}>
          Search the crate
        </label>
        <input
          id={searchId}
          type="search"
          className={s.search}
          placeholder="Search title or artist"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className={s.action} onClick={() => fileInput.current?.click()}>
          Add music
        </button>
        {canLinkFolder() && (
          <button type="button" className={s.action} onClick={() => void session.linkFolder()} title="Link a folder: the crate reads your files in place">
            Link folder
          </button>
        )}
        <button
          type="button"
          className={s.action}
          onClick={() => importInput.current?.click()}
          title="Import cues, tempo and key from a Platter backup (.json) or a Rekordbox collection (.xml)"
        >
          Import
        </button>
        <button
          type="button"
          className={s.action}
          onClick={() => {
            const { name, blob } = session.exportBackup();
            const url = URL.createObjectURL(blob);
            void saveFile(name, blob, url).then((msg) => {
              setNote(msg);
              window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
            });
          }}
          title="Save cue points, tempo, keys, settings and MIDI mappings (not the audio)"
        >
          Backup
        </button>
        <input
          ref={importInput}
          type="file"
          accept=".json,.xml,application/json,text/xml"
          hidden
          aria-label="Backup or Rekordbox file to import"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void session.importFile(f);
            e.target.value = '';
          }}
        />
        {!session.hasAllDemos() && loaded && (
          <button type="button" className={s.action} onClick={() => session.addDemos()}>
            Add demo tracks
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.mp3,.wav,.aif,.aiff,.flac,.ogg,.opus,.m4a,.aac"
          multiple
          hidden
          aria-label="Audio files to add to the crate"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </header>
      <p className={s.crateNote}>
        Drop audio files anywhere on the crate or straight onto a deck. They stay in this browser — nothing is
        uploaded.{crateNote ? ` ${crateNote}` : ''}{note ? ` ${note}` : ''}
      </p>

      {loaded && !tracks.length ? (
        <p className={s.crateEmpty}>The crate is empty. Add some music, or bring back the demo tracks.</p>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    className={c.className}
                    aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                  >
                    <button type="button" className={s.sortBtn} onClick={() => sortBy(c.key)}>
                      {c.label}
                      <span aria-hidden="true">{sort.key === c.key ? (sort.dir === 1 ? ' ▴' : ' ▾') : ''}</span>
                    </button>
                  </th>
                ))}
                <th className={s.colActions}>
                  <span className={s.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const on = loadedOn(t.id);
                return (
                  <tr
                    key={t.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TRACK_MIME, t.id);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    className={on ? s.rowLoaded : undefined}
                  >
                    <td>
                      <span className={s.rowTitle}>{t.title}</span>
                      {t.link && (
                        <a className={s.rowLink} href={t.link} target="_blank" rel="noopener noreferrer" aria-label={`${t.title} on Audius`}>
                          Audius ↗
                        </a>
                      )}
                      {on && <span className={s.rowOn}>on {on}</span>}
                      <span className={s.rowArtistInline}>{t.artist}</span>
                    </td>
                    <td className={s.colArtist}>{t.artist || '—'}</td>
                    <td className={s.colNum}>
                      {t.status === 'analysing' ? (
                        <span className={s.dim}>analysing…</span>
                      ) : t.status === 'error' ? (
                        <span className={s.rowError} title={t.error}>
                          can’t read
                        </span>
                      ) : t.bpm ? (
                        t.bpm.toFixed(1)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={s.colNum}>
                      {t.key ? (
                        <span
                          className={s.rowKey}
                          data-match={refKey ? compatible(t.key, refKey) : undefined}
                          title={`${keyName(t.key)}${refKey ? (compatible(t.key, refKey) ? ` — mixes with ${refKey}` : ` — clashes with ${refKey}`) : ''}`}
                        >
                          {t.key}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={`${s.colNum} ${s.colTime}`}>{t.duration ? formatTime(t.duration) : '—'}</td>
                    <td className={s.colActions}>
                      <button
                        type="button"
                        className={s.loadBtn}
                        data-deck="A"
                        disabled={t.status === 'error' || a.playing}
                        title={a.playing ? 'Deck A is playing' : undefined}
                        onClick={() => void session.loadToDeck(t.id, 0)}
                        aria-label={`Load ${t.title} on deck A`}
                      >
                        A
                      </button>
                      <button
                        type="button"
                        className={s.loadBtn}
                        data-deck="B"
                        disabled={t.status === 'error' || b.playing}
                        title={b.playing ? 'Deck B is playing' : undefined}
                        onClick={() => void session.loadToDeck(t.id, 1)}
                        aria-label={`Load ${t.title} on deck B`}
                      >
                        B
                      </button>
                      <button
                        type="button"
                        className={s.loadBtn}
                        aria-pressed={queue.includes(t.id)}
                        disabled={t.status === 'error'}
                        onClick={() => (queue.includes(t.id) ? session.autoDj.dequeue(t.id) : session.autoDj.enqueue(t.id))}
                        aria-label={queue.includes(t.id) ? `Take ${t.title} off the Auto-DJ queue` : `Queue ${t.title} for Auto-DJ`}
                        title="Auto-DJ queue"
                      >
                        {queue.includes(t.id) ? `Q${queue.indexOf(t.id) + 1}` : '+Q'}
                      </button>
                      <button
                        type="button"
                        className={s.removeBtn}
                        disabled={!!on}
                        onClick={() => session.removeTrack(t.id)}
                        aria-label={`Remove ${t.title} from the crate`}
                        title={on ? 'Loaded on a deck' : 'Remove from the crate'}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
