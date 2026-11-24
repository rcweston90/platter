import { beatsLabel, FX_META } from '../engine/fx';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import s from '../platter.module.css';
import b from './beatfx.module.css';

/**
 * The deck's FX button: puts the mixer's Beat FX on this deck and turns it
 * on (or off, if it's already on here), and says what the effect is. The
 * effect itself is set in the mixer (BeatFxPanel).
 */
export function FxStrip({ session, index }: { session: DjSession; index: 0 | 1 }) {
  const deck = index === 0 ? 'A' : 'B';
  const st = useStore(session.fx.store);
  const here = st.channel === deck;
  const on = here && (st.on || st.pad.engaged);
  const meta = FX_META[st.type];
  const where = st.channel === 'M' ? 'the master' : `deck ${st.channel}`;
  return (
    <div className={s.fxStrip} role="group" aria-label={`Deck ${deck} beat FX`}>
      <span className={b.deckFx} data-here={here || undefined}>
        <span className={b.deckFxName}>
          {meta.label}
          {meta.timed && <span className={b.deckFxBeats}> {beatsLabel(session.fx.liveBeats(st))}</span>}
        </span>
        <span className={b.deckFxWhere}>{here ? 'Beat FX on this deck' : `Beat FX on ${where}`}</span>
      </span>
      <button
        type="button"
        className={`${s.toggle} ${s.fxOn}`}
        aria-pressed={on}
        onClick={() => session.fx.toggleFor(deck)}
        aria-label={`Deck ${deck} effect ${on ? 'off' : 'on'}`}
        title={here ? undefined : `Moves the Beat FX from ${where} to this deck`}
      >
        FX
      </button>
    </div>
  );
}
