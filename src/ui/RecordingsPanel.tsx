import { useEffect, useState, type SyntheticEvent } from 'react';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { saveFile } from './save';
import { formatTime } from './Waveforms';
import { MoveMixImport, MoveMixRow } from './MoveMixes';
import { InfoTip, MIX_MOVES_GUIDE } from './DeckGuide';
import s from '../platter.module.css';
import mm from './movemix.module.css';

/** Every recorded mix, kept in this browser until deleted: audio from Rec,
 *  and move mixes from Rec moves (MoveMixes.tsx), newest first. */
export function RecordingsPanel({ session }: { session: DjSession }) {
  const { list } = useStore(session.recordings);
  const { list: mixes } = useStore(session.moves.store);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Object URLs for previews are made on demand and released when done.
  useEffect(() => () => (playing ? URL.revokeObjectURL(playing.url) : undefined), [playing]);

  const head = (
    <div className={mm.panelHead}>
      <p>
        Rec keeps the sound. Rec moves keeps what you do (every fader, knob, pad and jump) as a small file that replays on the decks,
        and that you can send as a link.
      </p>
      <MoveMixImport session={session} onNote={setNote} />
      <InfoTip label="About move mixes" title="Move mixes" sections={[MIX_MOVES_GUIDE]} deck="A" />
    </div>
  );
  const rows = [
    ...list.map((r) => ({ kind: 'audio' as const, at: r.createdAt, r })),
    ...mixes.map((mix) => ({ kind: 'moves' as const, at: mix.createdAt, mix })),
  ].sort((a, b) => b.at - a.at);

  if (!rows.length) {
    return (
      <div className={s.panelBody}>
        {head}
        {note && (
          <p className={s.crateNote} role="status">
            {note}
          </p>
        )}
        <p className={s.crateEmpty}>No recordings yet. Press Rec or Rec moves in the top bar; every mix is kept here until you delete it.</p>
      </div>
    );
  }
  return (
    <div className={s.panelBody}>
      {head}
      {note && (
        <p className={s.crateNote} role="status">
          {note}
        </p>
      )}
      <ul className={s.queueList}>
        {rows.map((row) => {
          if (row.kind === 'moves') return <MoveMixRow key={row.mix.id} session={session} mix={row.mix} onNote={setNote} />;
          const r = row.r;
          return (
          <li key={r.id} className={s.queueRow} data-kind="audio">
            <span className={`${s.badge} ${mm.kind}`} data-tone="muted" title="Audio: a recording of the sound">
              Audio
            </span>
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
          );
        })}
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
