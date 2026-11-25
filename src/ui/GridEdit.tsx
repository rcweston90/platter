import type { Deck } from '../engine/deck';
import { useStore } from '../engine/store';
import { gridEdit, setGridEdit } from './gridEdit';
import s from '../platter.module.css';

const NUDGES = [
  { ms: -10, text: '−10', label: 'move the beat grid 10 ms earlier' },
  { ms: -1, text: '−1', label: 'move the beat grid 1 ms earlier' },
  { ms: 1, text: '+1', label: 'move the beat grid 1 ms later' },
  { ms: 10, text: '+10', label: 'move the beat grid 10 ms later' },
] as const;

/** The Grid button: opens and closes the deck's grid edit row. */
export function GridToggle({ deck }: { deck: Deck }) {
  const on = useStore(gridEdit).on[deck.index];
  const st = useStore(deck.store);
  return (
    <button
      type="button"
      className={s.mini}
      aria-pressed={on}
      disabled={!st.track}
      onClick={() => setGridEdit(deck.index, !on)}
      aria-label={`Deck ${deck.label} grid edit`}
      title="Edit the beat grid: nudge it, set the downbeat, halve or double the tempo"
    >
      Grid
    </button>
  );
}

/**
 * Grid edit: slide the beat grid in 1 or 10 ms steps, make the playhead a
 * bar's "one", halve or double the tempo. Every change is saved with the
 * track, and phrases are read again on the new grid. While it's open the
 * scrolling waveform numbers each beat in its bar.
 */
export function GridEditRow({ deck }: { deck: Deck }) {
  const on = useStore(gridEdit).on[deck.index];
  const st = useStore(deck.store);
  if (!on || !st.track) return null;
  const bar = st.bpm ? 240 / st.bpm : 0;
  const one = bar ? ((st.gridOffset % bar) + bar) % bar : 0;
  const D = `Deck ${deck.label}`;
  return (
    <div className={s.gridEdit} role="group" aria-label={`${D} grid edit`}>
      <span className={s.gridEditLabel}>Grid</span>
      <span className={s.gridEditSet}>
        {NUDGES.map((n) => (
          <button
            key={n.ms}
            type="button"
            className={s.mini}
            disabled={!st.bpm}
            onClick={() => deck.nudgeGrid(n.ms / 1000)}
            aria-label={`${D}: ${n.label}`}
            title={`${n.ms < 0 ? 'Earlier' : 'Later'} by ${Math.abs(n.ms)} ms`}
          >
            {n.text}
          </button>
        ))}
      </span>
      <button
        type="button"
        className={s.mini}
        disabled={!st.bpm}
        onClick={() => deck.setDownbeat()}
        aria-label={`${D}: make the playhead the downbeat`}
        title="Make the playhead a bar's 1 — pause on the downbeat first"
      >
        1 here
      </button>
      <span className={s.gridEditSet}>
        <button type="button" className={s.mini} onClick={() => deck.scaleBpm(0.5)} disabled={!st.bpm} aria-label={`${D}: halve the detected tempo`}>
          ÷2
        </button>
        <button type="button" className={s.mini} onClick={() => deck.scaleBpm(2)} disabled={!st.bpm} aria-label={`${D}: double the detected tempo`}>
          ×2
        </button>
      </span>
      <span className={s.gridEditRead} aria-label={st.bpm ? `${st.bpm.toFixed(2)} BPM, first downbeat at ${one.toFixed(3)} seconds` : 'No tempo yet'}>
        {st.bpm ? (
          <>
            {st.bpm.toFixed(2)} <span className={s.dim}>· 1 at</span> {one.toFixed(3)}s
          </>
        ) : (
          'Tap the tempo first'
        )}
      </span>
    </div>
  );
}
