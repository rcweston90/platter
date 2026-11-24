import type { KeyboardEvent, PointerEvent } from 'react';
import { JUMP_BEATS, loopLabel, QUANTIZE_BEATS, type Deck } from '../engine/deck';
import { useStore } from '../engine/store';
import { ChevronIcon } from './icons';
import s from '../platter.module.css';
import l from './loops.module.css';

/*
 * A deck's loop section, three rows:
 *
 *   In · Out · Reloop   ½ · Loop 4 · 2×      — manual and beat loops
 *   ◂◂ · − Jump 16 + · ▸▸ · Q 1              — beat jump and its own size; quantise step
 *   ‹ · Edge · ›   hint                       — adjust the running loop's in or out edge
 *
 * Every control is a button with its own label, so the section reads the
 * same to a screen reader as it does on screen. The waveform takes a drag on
 * a loop edge too (see ScrollingWave).
 */

const beatsWord = (b: number) => `${loopLabel(b)} ${b === 1 ? 'beat' : 'beats'}`;

export function LoopControls({ deck }: { deck: Deck }) {
  const st = useStore(deck.store);
  const L = deck.label;
  const has = !!st.track;
  const lp = st.loop;
  const edge = lp.active ? st.loopEdge : null;
  const canReloop = lp.active || lp.end > lp.start;
  const size = lp.active ? lp.beats : st.autoLoop;
  const qi = (QUANTIZE_BEATS as readonly number[]).indexOf(st.quantizeBeats);
  const nextQ = QUANTIZE_BEATS[(qi + 1) % QUANTIZE_BEATS.length];

  // Loop In acts on press and on release (hold for a 4-beat loop).
  const inDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    deck.loopInDown();
  };
  const inKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
    e.preventDefault();
    deck.loopInDown();
  };
  const inKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => (e.key === ' ' || e.key === 'Enter') && deck.loopInUp();

  const nudgeKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (!edge || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    deck.nudgeLoopEdge(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey);
  };
  const pickNext = () => deck.selectLoopEdge(edge === null ? 'in' : edge === 'in' ? 'out' : null);

  return (
    // ← → nudge the picked edge from any key in the section (In and Out pick it).
    <div className={l.loops} role="group" aria-label={`Deck ${L} loop and beat jump`} onKeyDown={nudgeKeys}>
      <div className={l.row}>
        <button
          type="button"
          className={s.mini}
          disabled={!has}
          aria-pressed={lp.active ? edge === 'in' : st.loopInPoint !== null}
          aria-label={
            lp.active
              ? `Deck ${L}: ${edge === 'in' ? 'stop adjusting' : 'adjust'} the loop's in edge`
              : `Deck ${L} loop in — mark where the loop starts; hold for a 4-beat loop`
          }
          title={lp.active ? 'Pick the in edge to adjust' : 'Loop in: mark the start. Hold for a 4-beat loop'}
          onPointerDown={inDown}
          onPointerUp={() => deck.loopInUp()}
          onPointerCancel={() => deck.loopInUp()}
          onKeyDown={inKey}
          onKeyUp={inKeyUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          In
        </button>
        <button
          type="button"
          className={s.mini}
          disabled={!has || (!lp.active && st.loopInPoint === null)}
          aria-pressed={lp.active ? edge === 'out' : undefined}
          aria-label={
            lp.active
              ? `Deck ${L}: ${edge === 'out' ? 'stop adjusting' : 'adjust'} the loop's out edge`
              : `Deck ${L} loop out — end the loop here and start looping`
          }
          title={lp.active ? 'Pick the out edge to adjust' : 'Loop out: end the loop here and loop it'}
          onClick={() => deck.loopOut()}
        >
          Out
        </button>
        <button
          type="button"
          className={s.mini}
          disabled={!has || !canReloop}
          aria-label={lp.active ? `Deck ${L}: exit the loop` : `Deck ${L} reloop — back to the loop's start, looping again`}
          title={lp.active ? 'Exit: leave the loop and play on' : 'Reloop: back to the last loop and loop it again'}
          onClick={() => deck.reloop()}
        >
          {lp.active ? 'Exit' : 'Reloop'}
        </button>
        <button
          type="button"
          className={s.mini}
          onClick={() => deck.stepLoop(-1)}
          disabled={!deck.canStepLoop(-1)}
          aria-label="Halve loop length"
        >
          ½
        </button>
        <button
          type="button"
          className={`${s.toggle} ${l.loopBtn}`}
          aria-pressed={lp.active}
          disabled={!has}
          onClick={() => deck.toggleLoop()}
          aria-label={`${lp.active ? 'Exit' : 'Start'} ${loopLabel(size)}-beat loop`}
        >
          Loop {loopLabel(size)}
        </button>
        <button type="button" className={s.mini} onClick={() => deck.stepLoop(1)} disabled={!deck.canStepLoop(1)} aria-label="Double loop length">
          2×
        </button>
      </div>

      <div className={l.row}>
        <button
          type="button"
          className={s.mini}
          onClick={() => deck.beatJump(-1)}
          disabled={!has}
          aria-label={`Jump back ${loopLabel(st.jumpBeats)} beats`}
        >
          ◂◂
        </button>
        <span className={l.stepper}>
          <button
            type="button"
            className={s.mini}
            onClick={() => deck.stepJump(-1)}
            disabled={st.jumpBeats <= JUMP_BEATS[0]}
            aria-label="Smaller beat jump"
          >
            −
          </button>
          <span className={l.value} aria-live="polite">
            <span className={l.caption}>Jump</span>
            {loopLabel(st.jumpBeats)}
          </span>
          <button
            type="button"
            className={s.mini}
            onClick={() => deck.stepJump(1)}
            disabled={st.jumpBeats >= JUMP_BEATS[JUMP_BEATS.length - 1]}
            aria-label="Bigger beat jump"
          >
            +
          </button>
        </span>
        <button
          type="button"
          className={s.mini}
          onClick={() => deck.beatJump(1)}
          disabled={!has}
          aria-label={`Jump forward ${loopLabel(st.jumpBeats)} beats`}
        >
          ▸▸
        </button>
        <button
          type="button"
          className={s.mini}
          data-off={!st.quantize || undefined}
          onClick={() => deck.setQuantizeBeats(nextQ)}
          aria-label={`Deck ${L} quantise step ${beatsWord(st.quantizeBeats)}${st.quantize ? '' : ' (quantise is off)'} — press for ${beatsWord(nextQ)}`}
          title={`Quantise snaps to ${beatsWord(st.quantizeBeats)}${st.quantize ? '' : ' — turn Quant on to snap'}`}
        >
          Q {loopLabel(st.quantizeBeats)}
        </button>
      </div>

      <div className={`${l.row} ${l.adjust}`} role="group" aria-label={`Deck ${L} loop edge`}>
        <button
          type="button"
          className={s.mini}
          disabled={!edge}
          aria-label={`Move the loop's ${edge ?? 'picked'} edge earlier`}
          title="Earlier — one quantise step (Shift: 1 ms)"
          onClick={(e) => deck.nudgeLoopEdge(-1, e.shiftKey)}
        >
          <ChevronIcon dir={-1} />
        </button>
        <button
          type="button"
          className={`${s.mini} ${l.edge}`}
          disabled={!lp.active}
          aria-pressed={edge !== null}
          aria-label={`Loop edge to adjust: ${edge ?? 'none'} — press for ${edge === null ? 'in' : edge === 'in' ? 'out' : 'none'}`}
          onClick={pickNext}
        >
          {edge === 'in' ? 'In edge' : edge === 'out' ? 'Out edge' : 'Edge'}
        </button>
        <button
          type="button"
          className={s.mini}
          disabled={!edge}
          aria-label={`Move the loop's ${edge ?? 'picked'} edge later`}
          title="Later — one quantise step (Shift: 1 ms)"
          onClick={(e) => deck.nudgeLoopEdge(1, e.shiftKey)}
        >
          <ChevronIcon dir={1} />
        </button>
        <span className={l.hint}>
          {!lp.active ? 'Loop to adjust its edges' : edge ? '← → nudge · Shift: fine' : 'Pick In or Out, or drag an edge'}
        </span>
      </div>
    </div>
  );
}
