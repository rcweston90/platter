import { useEffect, useRef, useState } from 'react';
import type { DjSession } from '../engine/session';
import { shallowEqual, useStore, useStoreSelect } from '../engine/store';
import { formatClock, mixFile, mixLink, readMixFile, type MoveMix } from '../engine/moves';
import { setText, useFrame, type FrameLoop } from './frame';
import { openLibrary } from './library/dock';
import { saveFile } from './save';
import s from '../platter.module.css';
import m from './movemix.module.css';

/*
 * Move mixes in the UI: the Rec moves button in the top bar, the replay
 * bar (and its missing-tracks question), and each mix's row in the
 * Recordings tab. The recording and replay themselves are engine/moves.
 */

/** Rec moves: records what you do, not what it sounds like. */
export function MovesRecButton({ session, loop }: { session: DjSession; loop: FrameLoop }) {
  const { recording, recordStarted, replay } = useStoreSelect(
    session.moves.store,
    (st) => ({ recording: st.recording, recordStarted: st.recordStarted, replay: !!st.replay }),
    shallowEqual,
  );
  const clock = useRef<HTMLSpanElement>(null);
  useFrame(loop, () => setText(clock.current, recording ? formatClock((performance.now() - recordStarted) / 1000) : ''));
  return (
    <button
      type="button"
      className={`${s.toggle} ${m.movesBtn}`}
      aria-pressed={recording}
      disabled={!!replay && !recording}
      onClick={() => void session.moves.toggleRecording()}
      aria-label={recording ? 'Stop recording moves' : 'Record your moves'}
      title="Record every move you make (not the sound), to replay or share"
    >
      <span className={m.movesDot} aria-hidden="true" /> Rec moves <span ref={clock} className={s.recClock} />
    </button>
  );
}

/** What a mix needs: which of its tracks this crate has. */
function useTrackStatus(session: DjSession, mix: MoveMix) {
  useStore(session.crate);
  const found = session.moves.resolve(mix);
  return mix.tracks.map((t) => ({ t, have: found.get(t.id) !== undefined }));
}

export const SHARE_NOTE =
  'A move mix carries your moves, not the music: it replays only the demo tracks and tracks the listener has in their own crate.';

/** One move mix in the Recordings tab. */
export function MoveMixRow({ session, mix, onNote }: { session: DjSession; mix: MoveMix; onNote: (note: string | null) => void }) {
  const { replay } = useStore(session.moves.store);
  const tracks = useTrackStatus(session, mix);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = replay?.id === mix.id;
  const missing = tracks.filter((x) => !x.have).length;
  const realMoves = mix.moves.filter((mv) => mv.m !== 'pos').length;

  const copyLink = async () => {
    setBusy(true);
    setLink(null);
    try {
      const r = await mixLink(mix);
      if (!r.ok) {
        onNote(r.reason);
        return;
      }
      try {
        await navigator.clipboard.writeText(r.url);
        onNote(`Link copied (${Math.ceil(r.length / 1000)}k characters). ${SHARE_NOTE}`);
      } catch {
        // No clipboard here (permissions, an embedded page): show it to copy by hand.
        setLink(r.url);
        onNote(`Copy the link below. ${SHARE_NOTE}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`${s.queueRow} ${m.row}`} data-replaying={mine || undefined} data-kind="moves">
      <span className={`${s.badge} ${m.kind}`} data-tone="go" title="Moves: replays on the decks">
        Moves
      </span>
      <span className={s.audiusMeta}>
        <span className={s.rowTitle}>
          {mix.name}
          {mix.shared && <span className={m.shared}> · shared with you</span>}
        </span>
        <span className={s.dim}>
          {formatClock(mix.seconds)} · {new Date(mix.createdAt).toLocaleString()} · {realMoves} move{realMoves === 1 ? '' : 's'}
        </span>
        <span className={m.tracks}>
          {tracks.length ? (
            tracks.map(({ t, have }, i) => (
              <span key={t.id} data-missing={!have || undefined}>
                {i > 0 && ' · '}
                {t.title}
                {!have && <em> (not in your crate)</em>}
              </span>
            ))
          ) : (
            <span>No tracks</span>
          )}
        </span>
        {link && (
          <input
            className={m.linkField}
            readOnly
            value={link}
            aria-label={`Link to ${mix.name}`}
            onFocus={(e) => e.currentTarget.select()}
            autoFocus
          />
        )}
      </span>
      {mine ? (
        <button type="button" className={s.mini} onClick={() => session.moves.stopReplay()}>
          Stop
        </button>
      ) : (
        <button
          type="button"
          className={s.mini}
          onClick={() => void session.moves.replay(mix.id)}
          disabled={!!replay}
          title={missing ? `${missing} of its tracks aren’t in your crate: you’ll pick replacements or skip them` : 'Replay these moves on the decks'}
        >
          Replay
        </button>
      )}
      <button type="button" className={s.mini} onClick={() => void copyLink()} disabled={busy}>
        Copy link
      </button>
      <button
        type="button"
        className={s.mini}
        onClick={() => {
          const f = mixFile(mix);
          const url = URL.createObjectURL(f.blob);
          void saveFile(f.name, f.blob, url).then((msg) => {
            onNote(msg);
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          });
        }}
      >
        Download
      </button>
      <button type="button" className={s.removeBtn} onClick={() => session.moves.delete(mix.id)} aria-label={`Delete ${mix.name}`}>
        ×
      </button>
    </li>
  );
}

/** Import a .plattermix file someone sent. */
export function MoveMixImport({ session, onNote }: { session: DjSession; onNote: (note: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={s.action} onClick={() => input.current?.click()}>
        Import mix
      </button>
      <input
        ref={input}
        type="file"
        accept=".plattermix,.json,application/json"
        hidden
        aria-label="Import a move mix file"
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (!file) return;
          try {
            const mix = await session.moves.addShared(await readMixFile(file));
            onNote(`Imported “${mix.name}”. ${SHARE_NOTE}`);
          } catch (err) {
            onNote(err instanceof Error ? err.message : 'That file couldn’t be read.');
          }
        }}
      />
    </>
  );
}

/** The replay bar: what's replaying, the missing-tracks question, a mix that
 *  just arrived by link, and one line on what just happened. */
export function MoveMixBar({ session }: { session: DjSession }) {
  const { replay, prompt, note, incoming, list } = useStore(session.moves.store);
  const shared = incoming ? list.find((x) => x.id === incoming) : null;
  if (prompt) return <MissingTracks session={session} />;
  if (!replay && !shared && !note) return null;
  return (
    <div className={m.bar} role="region" aria-label="Move mix replay">
      {replay ? (
        <>
          <span className={m.live} aria-hidden="true" />
          <span className={m.barText} role="status">
            <strong>{replay.phase === 'preparing' ? 'Getting ready' : 'Replaying'}</strong> “{replay.name}”{' '}
            <span className={m.clock}>
              {formatClock(replay.at)} / {formatClock(replay.seconds)}
            </span>
            <span className={m.hint}> · Touch any control to take over</span>
          </span>
          <button type="button" className={s.mini} onClick={() => session.moves.stopReplay()}>
            Stop
          </button>
        </>
      ) : shared ? (
        <>
          <span className={m.barText} role="status">
            <strong>A mix was shared with you:</strong> “{shared.name}”. {SHARE_NOTE}
          </span>
          <button type="button" className={s.primaryBtn} onClick={() => void session.moves.replay(shared.id)}>
            Replay
          </button>
          <button
            type="button"
            className={s.mini}
            onClick={() => {
              session.moves.dismissIncoming();
              openLibrary('recordings');
            }}
          >
            Later
          </button>
        </>
      ) : (
        <>
          <span className={m.barText} role="status">
            {note}
          </span>
          <button type="button" className={s.removeBtn} onClick={() => session.moves.dismissNote()} aria-label="Dismiss">
            ×
          </button>
        </>
      )}
      {replay && note && <span className={m.subNote}>{note}</span>}
    </div>
  );
}

/** A mix uses tracks this crate doesn't have: pick one of yours for each, or skip it. */
function MissingTracks({ session }: { session: DjSession }) {
  const { prompt, list } = useStore(session.moves.store);
  const { tracks } = useStore(session.crate);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);
  if (!prompt) return null;
  const mix = list.find((x) => x.id === prompt.mixId);
  const sorted = [...tracks].filter((t) => t.status !== 'error').sort((a, b) => a.title.localeCompare(b.title));
  const go = () => {
    const choices: Record<string, string | null> = {};
    for (const t of prompt.missing) choices[t.id] = choice[t.id] || null;
    void session.moves.replay(prompt.mixId, choices);
  };
  return (
    <div className={m.backdrop} onKeyDown={(e) => e.key === 'Escape' && session.moves.cancelPrompt()}>
      <div className={m.dialog} role="dialog" aria-modal="true" aria-labelledby="mm-missing-title">
        <h2 id="mm-missing-title" className={m.dialogTitle}>
          {prompt.missing.length === 1 ? 'One track isn’t in your crate' : `${prompt.missing.length} tracks aren’t in your crate`}
        </h2>
        <p className={m.dialogText}>
          “{mix?.name ?? 'This mix'}” carries the moves, not the music. Pick one of your tracks to play in its place, or skip it: that deck
          sits out while it would have played. Demo tracks always replay.
        </p>
        <ul className={m.missingList}>
          {prompt.missing.map((t, i) => (
            <li key={t.id} className={m.missingRow}>
              <span className={s.audiusMeta}>
                <span className={s.rowTitle}>{t.title}</span>
                <span className={s.dim}>
                  {t.artist || 'Unknown artist'} · {formatClock(t.duration)}
                </span>
              </span>
              <select
                ref={i === 0 ? first : undefined}
                value={choice[t.id] ?? ''}
                aria-label={`Instead of ${t.title}`}
                onChange={(e) => setChoice({ ...choice, [t.id]: e.target.value })}
              >
                <option value="">Skip this track</option>
                {sorted.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                    {c.artist ? ` — ${c.artist}` : ''}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
        <div className={m.dialogActions}>
          <button type="button" className={s.action} onClick={() => session.moves.cancelPrompt()}>
            Cancel
          </button>
          <button type="button" className={s.primaryBtn} onClick={go}>
            Replay
          </button>
        </div>
      </div>
    </div>
  );
}
