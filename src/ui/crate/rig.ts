import type { DjSession } from '../../engine/session';
import { useStore, useStoreSelect } from '../../engine/store';
import type { Reference } from './model';

export interface Rig {
  /** What a new track is matched against: the deck you'd mix out of. */
  ref: Reference | null;
  /** Where Enter (or a double-click) sends a track: the deck that isn't live. */
  target: 0 | 1 | null;
  playing: [boolean, boolean];
  /** "A", "B", "A B" or "" for a crate track. */
  loadedOn: (id: string) => string;
  queue: string[];
}

/**
 * The decks as the track list needs to see them. The reference is the deck
 * that's playing (the louder side of the crossfader if both are), else the
 * loaded deck the crossfader leans towards; the load target is the other one.
 */
export function useRig(session: DjSession): Rig {
  const a = useStore(session.decks[0].store);
  const b = useStore(session.decks[1].store);
  const crossfader = useStoreSelect(session.mixer, (m) => Math.sign(m.crossfader));
  const { queue } = useStore(session.autoDj.store);
  const [deckA, deckB] = session.decks;

  let refIdx: 0 | 1 | null;
  if (a.playing && b.playing) refIdx = crossfader > 0 ? 1 : 0;
  else if (a.playing) refIdx = 0;
  else if (b.playing) refIdx = 1;
  else if (a.track && b.track) refIdx = crossfader > 0 ? 1 : 0;
  else refIdx = a.track ? 0 : b.track ? 1 : null;

  const refDeck = refIdx === null ? null : refIdx === 0 ? deckA : deckB;
  const ref: Reference | null = refDeck
    ? { deck: refIdx === 0 ? 'A' : 'B', bpm: refDeck.effectiveBpm(), key: refDeck.effectiveKey() }
    : null;

  let target: 0 | 1 | null;
  if (a.playing && b.playing) target = null;
  else if (a.playing) target = 1;
  else if (b.playing) target = 0;
  else if (refIdx !== null) target = refIdx === 0 ? 1 : 0;
  else target = 0;

  return {
    ref,
    target,
    playing: [a.playing, b.playing],
    loadedOn: (id) => [a.track?.id === id ? 'A' : null, b.track?.id === id ? 'B' : null].filter(Boolean).join(' '),
    queue,
  };
}
