import { beatsLabel, FX_BEATS, FX_TYPES, type FxState, type FxType } from '../engine/fx';
import type { DjSession } from '../engine/session';
import { Knob } from './Knob';
import s from '../platter.module.css';

/** The deck's Beat FX: type, length in beats, depth, on. */
export function FxStrip({ session, index, fx }: { session: DjSession; index: 0 | 1; fx: FxState }) {
  const deck = index === 0 ? 'A' : 'B';
  const set = (patch: Partial<FxState>) => session.setChannel(index, { fx: { ...fx, ...patch } });
  const at = FX_BEATS.indexOf(fx.beats as (typeof FX_BEATS)[number]);
  const step = (dir: -1 | 1) => {
    const next = FX_BEATS[Math.min(FX_BEATS.length - 1, Math.max(0, at + dir))];
    if (next !== fx.beats) set({ beats: next });
  };
  const id = `fx-type-${deck}`;
  return (
    <div className={s.fxStrip} role="group" aria-label={`Deck ${deck} beat FX`}>
      <label htmlFor={id} className={s.srOnly}>
        Deck {deck} effect
      </label>
      <select id={id} className={s.fxSelect} value={fx.type} onChange={(e) => set({ type: e.target.value as FxType })}>
        {FX_TYPES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <div className={s.fxBeats}>
        <button type="button" className={s.mini} onClick={() => step(-1)} disabled={at <= 0} aria-label="Shorter (fewer beats)">
          ‹
        </button>
        <span className={s.fxBeatValue} aria-live="polite" aria-label={`${beatsLabel(fx.beats)} beat`}>
          {beatsLabel(fx.beats)}
        </span>
        <button
          type="button"
          className={s.mini}
          onClick={() => step(1)}
          disabled={at >= FX_BEATS.length - 1}
          aria-label="Longer (more beats)"
        >
          ›
        </button>
      </div>
      <Knob
        label="Depth"
        name={`Deck ${deck} effect depth`}
        value={fx.depth}
        min={0}
        max={1}
        defaultValue={0.5}
        size="sm"
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(depth) => set({ depth })}
      />
      <button
        type="button"
        className={`${s.toggle} ${s.fxOn}`}
        aria-pressed={fx.on}
        onClick={() => set({ on: !fx.on })}
        aria-label={`Deck ${deck} effect ${fx.on ? 'off' : 'on'}`}
      >
        FX
      </button>
    </div>
  );
}
