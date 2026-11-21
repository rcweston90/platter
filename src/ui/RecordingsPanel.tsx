import { useEffect, useState, type SyntheticEvent } from 'react';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { saveFile } from './save';
import { formatTime } from './Waveforms';
import s from '../platter.module.css';

/** Every recorded mix, kept in this browser until deleted. */
export function RecordingsPanel({ session }: { session: DjSession }) {
  const { list } = useStore(session.recordings);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Object URLs for previews are made on demand and released when done.
  useEffect(() => () => (playing ? URL.revokeObjectURL(playing.url) : undefined), [playing]);

  if (!list.length) {
    return (
      <div className={s.panelBody}>
        <p className={s.crateEmpty}>No recordings yet. Press Rec in the top bar; every mix is kept here until you delete it.</p>
      </div>
    );
  }
  return (
    <div className={s.panelBody}>
      {note && (
        <p className={s.crateNote} role="status">
          {note}
        </p>
      )}
      <ul className={s.queueList}>
        {list.map((r) => (
          <li key={r.id} className={s.queueRow}>
            <span className={s.audiusMeta}>
              <span className={s.rowTitle}>{r.name}</span>
              <span className={s.dim}>
                {formatTime(r.seconds)} · {new Date(r.createdAt).toLocaleString()} · {formatSize(r.blob.size)}
              </span>
              {playing?.id === r.id && (
                // eslint-disable-next-line jsx-a11y/media-has-caption -- a DJ mix has no captions to offer
                <audio src={playing.url} controls autoPlay className={s.recPlayer} onLoadedMetadata={findDuration} />
              )}
            </span>
            <button
              type="button"
              className={s.mini}
              onClick={() => setPlaying(playing?.id === r.id ? null : { id: r.id, url: URL.createObjectURL(r.blob) })}
            >
              {playing?.id === r.id ? 'Close' : 'Listen'}
            </button>
            <button
              type="button"
              className={s.mini}
              onClick={() => {
                const url = URL.createObjectURL(r.blob);
                void saveFile(r.name, r.blob, url).then((msg) => {
                  setNote(msg);
                  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
                });
              }}
            >
              Save
            </button>
            <button type="button" className={s.removeBtn} onClick={() => session.deleteRecording(r.id)} aria-label={`Delete ${r.name}`}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const formatSize = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

/** A browser's own recordings (WebM from MediaRecorder) carry no length in
 *  their header, so the player shows 0:00 and can't seek. Asking for a point
 *  far past the end makes it read the file through and learn the length; then
 *  it goes back to the start and plays. */
function findDuration(e: SyntheticEvent<HTMLAudioElement>) {
  const a = e.currentTarget;
  if (Number.isFinite(a.duration)) return;
  const back = () => {
    if (!Number.isFinite(a.duration)) return;
    a.removeEventListener('durationchange', back);
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  };
  a.addEventListener('durationchange', back);
  a.currentTime = 1e7;
}
