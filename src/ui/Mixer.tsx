
import { useRef, type CSSProperties } from 'react';
import {
  eqLabel,
  faderLabel,
  filterLabel,
  FILTER_LOCK,
  meterLevel,
  readPeak,
  trimDb,
  type CrossfaderCurve,
  type EqMode,
  type FaderCurve,
  type XfAssign,
} from '../engine/mixer';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { BeatFxPanel } from './BeatFxPanel';
import { InfoTip, MIXER_GUIDE } from './DeckGuide';
import { useFrame, type FrameLoop } from './frame';
import { Knob } from './Knob';
import s from '../platter.module.css';
import x from './mixer.module.css';

const db = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} dB`;
const levelText = (v: number) => (v <= 0 ? 'off' : db(40 * Math.log10(v / 0.8)));
interface Choice<T> {
  id: T;
  label: string;
  hint: string;
}
const CURVES: Choice<CrossfaderCurve>[] = [
  { id: 'power', label: 'Smooth', hint: 'Constant-power blend, a slight dip in the middle' },
  { id: 'full', label: 'Full', hint: 'Both decks at full level in the middle' },
  { id: 'cut', label: 'Cut', hint: 'Scratch curve: each side opens fully within the last few percent' },
];
const EQ_TYPES: Choice<EqMode>[] = [
  { id: 'iso', label: 'Iso', hint: 'Isolator: a band turned fully down is gone' },
  { id: 'eq', label: 'EQ', hint: 'Classic EQ: shelves and a mid, −26 dB at most, no kill' },
];
const FADER_CURVES: Choice<FaderCurve>[] = [
  { id: 'slow', label: 'Slow', hint: 'Slow rise: most of the level comes in near the top' },
  { id: 'linear', label: 'Lin', hint: 'Linear: loudness rises evenly along the fader' },
  { id: 'fast', label: 'Fast', hint: 'Fast cut: full level a few millimetres off the bottom' },
];
const ASSIGNS: (Choice<XfAssign> & { colour: string })[] = [
  { id: 'A', label: 'A', hint: 'Follows the crossfader’s A side', colour: 'var(--dj-a)' },
  { id: 'thru', label: 'Thru', hint: 'Ignores the crossfader', colour: 'var(--dj-text)' },
  { id: 'B', label: 'B', hint: 'Follows the crossfader’s B side', colour: 'var(--dj-b)' },
];

/** A row of joined buttons, one of them pressed. */
function Segmented<T extends string>({
  label,
  choices,
  value,
  onPick,
  className,
}: {
  label: string;
  choices: (Choice<T> & { colour?: string })[];
  value: T;
  onPick: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`${x.seg} ${className ?? ''}`} role="group" aria-label={label}>
      {choices.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={value === c.id}
          title={c.hint}
          style={c.colour ? ({ '--seg': c.colour } as CSSProperties) : undefined}
          onClick={() => onPick(c.id)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** A peak meter: level with a fast attack, slow fall, and a held peak. */
function useMeter(loop: FrameLoop, read: () => AnalyserNode | null) {
  const cover = useRef<HTMLSpanElement>(null);
  const hold = useRef<HTMLSpanElement>(null);
  const state = useRef({ level: 0, peak: 0, peakAge: 0 });
  const shown = useRef({ level: -1, peak: -1 });
  useFrame(loop, () => {
    const a = read();
    const m = state.current;
    const target = a ? meterLevel(readPeak(a)) : 0;
    m.level = target > m.level ? target : Math.max(target, m.level - 0.025);
    if (m.level >= m.peak) {
      m.peak = m.level;
      m.peakAge = 0;
    } else if (++m.peakAge > 45) {
      m.peak = Math.max(m.level, m.peak - 0.01);
    }
    // Written only when they move, as transforms (see .meterCover).
    const level = Math.round(m.level * 400) / 400;
    const peak = Math.round(m.peak * 400) / 400;
    if (cover.current && level !== shown.current.level) cover.current.style.transform = `scaleY(${1 - level})`;
    if (hold.current && peak !== shown.current.peak) hold.current.style.transform = `translateY(${-peak * 100}%)`;
    shown.current = { level, peak };
  });
  return { cover, hold };
}

function Meter({ loop, read, label }: { loop: FrameLoop; read: () => AnalyserNode | null; label: string }) {
  const { cover, hold } = useMeter(loop, read);
  return (
    <span className={s.meter} role="img" aria-label={label}>
      <span ref={cover} className={s.meterCover} />
      <span ref={hold} className={s.meterHold} />
    </span>
  );
}

export function Mixer({ session, loop }: { session: DjSession; loop: FrameLoop }) {
  const m = useStore(session.mixer);

  const eq = (v: number) => eqLabel(v, m.eqMode);

  const channel = (i: 0 | 1) => {
    const c = m.channels[i];
    const deck = i === 0 ? 'A' : 'B';
    const set = (patch: Partial<typeof c>) => session.setChannel(i, patch);
    return (
      <div className={s.channel} data-deck={deck} role="group" aria-label={`Channel ${deck}`}>
        <span className={s.channelBadge} aria-hidden="true">
          {deck}
        </span>
        <Knob label="Trim" name={`Channel ${deck} trim`} value={c.trim} min={0} max={1} defaultValue={0.5} bipolar size="sm" format={(v) => db(trimDb(v))} onChange={(trim) => set({ trim })} />
        <Knob label="Hi" name={`Channel ${deck} high EQ`} value={c.high} min={0} max={1} defaultValue={0.5} bipolar format={eq} onChange={(high) => set({ high })} />
        <Knob label="Mid" name={`Channel ${deck} mid EQ`} value={c.mid} min={0} max={1} defaultValue={0.5} bipolar format={eq} onChange={(mid) => set({ mid })} />
        <Knob label="Low" name={`Channel ${deck} low EQ`} value={c.low} min={0} max={1} defaultValue={0.5} bipolar format={eq} onChange={(low) => set({ low })} />
        <Knob
          label="Filter"
          name={`Channel ${deck} filter`}
          value={c.filter}
          min={-1}
          max={1}
          defaultValue={0}
          bipolar
          detent={FILTER_LOCK / 2}
          format={filterLabel}
          onChange={(filter) => set({ filter })}
        />
        <button type="button" className={`${s.toggle} ${s.cueToggle}`} aria-pressed={c.cue} onClick={() => set({ cue: !c.cue })} aria-label={`Channel ${deck} headphone cue`}>
          Cue
        </button>
        <div className={s.faderRow}>
          <input
            type="range"
            className={s.fader}
            min={0}
            max={1}
            step={0.005}
            value={c.fader}
            onChange={(e) => set({ fader: Number(e.target.value) })}
            aria-label={`Channel ${deck} volume`}
            aria-valuetext={faderLabel(c.fader, m.faderCurve)}
          />
          <Meter loop={loop} read={() => session.engine?.channels[i].meter ?? null} label={`Channel ${deck} level meter`} />
        </div>
        <Segmented
          label={`Channel ${deck} crossfader assign`}
          className={x.assign}
          choices={ASSIGNS}
          value={m.xfAssign[i]}
          onPick={(a) => session.setXfAssign(i, a)}
        />
      </div>
    );
  };

  return (
    <section className={s.mixer} aria-label="Mixer">
      <div className={s.mixerTop}>
        <Knob label="Master" name="Master level" value={m.master} min={0} max={1} defaultValue={0.8} size="sm" format={levelText} onChange={(master) => session.setLevels({ master })} />
        <Knob label="Cue mix" name="Headphones: cue ↔ master blend" value={m.cueMix} min={0} max={1} defaultValue={0.25} size="sm" format={(v) => `${Math.round((1 - v) * 100)}% cue · ${Math.round(v * 100)}% master`} onChange={(cueMix) => session.setLevels({ cueMix })} />
        <Knob label="Phones" name="Headphone level" value={m.cueLevel} min={0} max={1} defaultValue={0.8} size="sm" format={levelText} onChange={(cueLevel) => session.setLevels({ cueLevel })} />
      </div>
      <div className={s.mixerBody}>
        {channel(0)}
        <div className={x.centre}>
          <InfoTip label="Mixer guide" title="Mixer" sections={[MIXER_GUIDE]} deck="A" hover className={x.info} />
          <div className={s.masterMeters} role="group" aria-label="Master level">
            <Meter loop={loop} read={() => session.engine?.masterMeters[0] ?? null} label="Master left level meter" />
            <Meter loop={loop} read={() => session.engine?.masterMeters[1] ?? null} label="Master right level meter" />
            <span className={s.meterCaption} aria-hidden="true">
              Mst
            </span>
          </div>
        </div>
        {channel(1)}
      </div>
      <div className={s.xfaderRow}>
        <span className={s.xfEnd} aria-hidden="true">
          A
        </span>
        <input
          type="range"
          className={s.xfader}
          min={-1}
          max={1}
          step={0.01}
          value={m.crossfader}
          onChange={(e) => session.setCrossfader(Number(e.target.value))}
          onDoubleClick={() => session.setCrossfader(0)}
          aria-label="Crossfader"
          aria-valuetext={m.crossfader === 0 ? 'centre' : m.crossfader < 0 ? `${Math.round(-m.crossfader * 100)}% to deck A` : `${Math.round(m.crossfader * 100)}% to deck B`}
        />
        <span className={s.xfEnd} aria-hidden="true">
          B
        </span>
      </div>
      {/* The set-and-forget switches, small and out of the way of the strip. */}
      <div className={x.switches} role="group" aria-label="Mixer switches">
        <div className={x.switch}>
          <Segmented label="EQ type" choices={EQ_TYPES} value={m.eqMode} onPick={(v) => session.setEqMode(v)} />
          <span className={x.caption} aria-hidden="true">
            EQ
          </span>
        </div>
        <div className={x.switch}>
          <Segmented label="Channel fader curve" choices={FADER_CURVES} value={m.faderCurve} onPick={(v) => session.setFaderCurve(v)} />
          <span className={x.caption} aria-hidden="true">
            Ch curve
          </span>
        </div>
        <div className={x.switch}>
          <Segmented label="Crossfader curve" choices={CURVES} value={m.curve} onPick={(v) => session.setCurve(v)} />
          <span className={x.caption} aria-hidden="true">
            X curve
          </span>
        </div>
      </div>
      <BeatFxPanel session={session} />
    </section>
  );
}
