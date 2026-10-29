import { TRANSITION_BARS } from '../engine/autodj';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { formatTime } from './Waveforms';
import s from '../platter.module.css';

/** Auto-DJ: the queue, the transition length, and the switch. */
export function QueuePanel({ session }: { session: DjSession }) {
  const { on, queue, bars, status } = useStore(session.autoDj.store);
  const { tracks } = useStore(session.crate);
  const byId = new Map(tracks.map((t) => [t.id, t]));
  return (
    <div className={s.panelBody}>
      <div className={s.crateHead}>
        <button type="button" className={`${s.toggle} ${s.autoBtn}`} aria-pressed={on} onClick={() => void session.autoDj.setOn(!on)}>
          Auto-DJ {on ? 'on' : 'off'}
        </button>
        <span className={s.keyLabel}>Mix over</span>
        <div className={s.genres} role="group" aria-label="Transition length">
          {TRANSITION_BARS.map((b) => (
            <button key={b} type="button" className={s.mini} aria-pressed={bars === b} onClick={() => session.autoDj.setBars(b)}>
              {b} bars
            </button>
          ))}
        </div>
      </div>
      <p className={s.crateNote} role="status">
        {status}. Queue tracks with +Q in the crate; Auto-DJ syncs each one, starts it on its cue point and crossfades
        with a bass swap.
      </p>
      {queue.length > 0 ? (
        <ol className={s.queueList}>
          {queue.map((id, i) => {
            const t = byId.get(id);
            if (!t) return null;
            return (
              <li key={id} className={s.queueRow}>
                <span className={s.queueNum}>{i + 1}</span>
                <span className={s.audiusMeta}>
                  <span className={s.rowTitle}>{t.title}</span>
                  <span className={s.dim}>
                    {t.artist || '—'} · {t.bpm ? `${t.bpm.toFixed(1)} BPM` : 'BPM —'} · {t.key ?? '—'} · {t.duration ? formatTime(t.duration) : '—'}
                  </span>
                </span>
                <button type="button" className={s.mini} onClick={() => session.autoDj.move(id, -1)} disabled={i === 0} aria-label={`Move ${t.title} up`}>
                  ▴
                </button>
                <button type="button" className={s.mini} onClick={() => session.autoDj.move(id, 1)} disabled={i === queue.length - 1} aria-label={`Move ${t.title} down`}>
                  ▾
                </button>
                <button type="button" className={s.removeBtn} onClick={() => session.autoDj.dequeue(id)} aria-label={`Remove ${t.title} from the queue`}>
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className={s.crateEmpty}>The queue is empty.</p>
      )}
    </div>
  );
}
