import { useState, type KeyboardEvent } from 'react';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { AudiusPanel } from './AudiusPanel';
import { Crate } from './Crate';
import { QueuePanel } from './QueuePanel';
import { RecordingsPanel } from './RecordingsPanel';
import s from '../platter.module.css';

type Tab = 'crate' | 'audius' | 'queue' | 'recordings';

/** The lower half: crate, Audius, the Auto-DJ queue and recorded mixes. */
export function Library({ session }: { session: DjSession }) {
  const [tab, setTab] = useState<Tab>('crate');
  const { queue, on } = useStore(session.autoDj.store);
  const { list } = useStore(session.recordings);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'crate', label: 'Crate' },
    { id: 'audius', label: 'Audius' },
    { id: 'queue', label: `Auto-DJ${on ? ' ●' : ''}${queue.length ? ` (${queue.length})` : ''}` },
    { id: 'recordings', label: `Recordings${list.length ? ` (${list.length})` : ''}` },
  ];
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    setTab(t.id);
    document.getElementById(`lib-tab-${t.id}`)?.focus();
  };
  return (
    <section className={s.library} aria-label="Library">
      <div className={s.tabs} role="tablist" aria-label="Library">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`lib-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`lib-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={s.tab}
            onClick={() => setTab(t.id)}
            onKeyDown={onKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id={`lib-panel-${tab}`} role="tabpanel" aria-labelledby={`lib-tab-${tab}`}>
        {tab === 'crate' && <Crate session={session} />}
        {tab === 'audius' && <AudiusPanel session={session} />}
        {tab === 'queue' && <QueuePanel session={session} />}
        {tab === 'recordings' && <RecordingsPanel session={session} />}
      </div>
    </section>
  );
}
