import { useRef, useState } from 'react';
import type { Deck } from '../../engine/deck';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import { TRACK_MIME } from '../DeckPanel';
import { useDropTarget } from '../frame';
import { useRig } from '../crate/rig';
import l from './library.module.css';

/**
 * What's on each deck, in the library's own header, so it stays in view
 * however far the rig is scrolled. Each is a drop target: drag a row from
 * the list (or an Up next card) onto A or B to load it there. The deck that
 * Enter and double-click load to is marked "Next".
 */
export function DeckTargets({ session, compact = false }: { session: DjSession; compact?: boolean }) {
  const { target } = useRig(session);
  return (
    <div className={l.targets} data-compact={compact || undefined} role="group" aria-label="Decks">
      {session.decks.map((d) => (
        <DeckTarget key={d.index} session={session} deck={d} next={target === d.index} />
      ))}
    </div>
  );
}

function DeckTarget({ session, deck, next }: { session: DjSession; deck: Deck; next: boolean }) {
  const st = useStore(deck.store);
  const el = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const L = deck.index === 0 ? 'A' : 'B';
  useDropTarget(
    el,
    (types) => types.includes(TRACK_MIME),
    setOver,
    (data) => {
      const id = data.getData(TRACK_MIME);
      if (id && !deck.store.get().playing) void session.loadToDeck(id, deck.index);
    },
  );
  const bpm = deck.effectiveBpm();
  const key = deck.effectiveKey();
  const state = st.loading ? 'Loading' : st.playing ? 'Playing' : st.track ? 'Cued' : 'Empty';
  return (
    <div
      ref={el}
      className={l.target}
      data-deck={L}
      data-over={over || undefined}
      data-playing={st.playing || undefined}
      data-next={next || undefined}
      title={st.playing ? `Deck ${L} is playing` : `Drop a track here to load it on deck ${L}`}
      aria-label={`Deck ${L}: ${state}${st.track ? `, ${st.track.title}` : ''}${bpm ? `, ${bpm.toFixed(1)} BPM` : ''}${key ? `, ${key}` : ''}${next ? ', next to load' : ''}`}
    >
      <span className={l.targetLetter} aria-hidden="true">
        {L}
      </span>
      <span className={l.targetInfo} aria-hidden="true">
        <span className={l.targetTitle}>{st.loading ? 'Loading…' : (st.track?.title ?? 'Empty deck')}</span>
        <span className={l.targetMeta}>
          <span className={l.targetState}>{st.playing ? 'Live' : next ? 'Next' : st.track ? 'Cued' : 'Drop here'}</span>
          {bpm ? <span>{bpm.toFixed(1)}</span> : null}
          {key ? <span className={l.targetKey}>{key}</span> : null}
        </span>
      </span>
    </div>
  );
}
