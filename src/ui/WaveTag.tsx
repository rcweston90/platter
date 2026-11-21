import type { Deck } from '../engine/deck';
import { useStore } from '../engine/store';
import s from '../platter.module.css';

/**
 * The label on a scrolling waveform: the deck, its part in sync and the
 * tempo you hear. "Leader" is the deck the other follows; "Sync" marks the
 * follower, with the deck it follows.
 */
export function WaveTag({ deck }: { deck: Deck }) {
  const st = useStore(deck.store);
  const other = useStore((deck.other ?? deck).store);
  const role = st.sync ? 'follower' : other.sync ? 'leader' : 'free';
  const bpm = deck.effectiveBpm();
  const lead = deck.other?.label ?? '';
  const waiting = role === 'follower' && !(other.track && other.bpm);
  const roleText = role === 'leader' ? 'Leader' : role === 'follower' ? `Sync ▸ ${lead}` : null;
  const said =
    role === 'leader'
      ? `deck ${deck.other?.label} follows it`
      : role === 'follower'
        ? waiting
          ? `synced, waiting for a track on deck ${lead}`
          : `synced to deck ${lead}`
        : 'not synced';
  return (
    <span className={s.waveTags} aria-label={`Deck ${deck.label}: ${said}${bpm ? `, ${bpm.toFixed(1)} BPM` : ''}`}>
      <span className={s.waveTag}>{deck.label}</span>
      {roleText && (
        <span className={s.waveRole} data-role={role} data-waiting={waiting || undefined}>
          {roleText}
        </span>
      )}
      {bpm && st.track ? <span className={s.waveBpm}>{bpm.toFixed(1)}</span> : null}
    </span>
  );
}
