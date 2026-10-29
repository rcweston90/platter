
import { useRef } from 'react';
import { eqLabel, filterLabel, meterLevel, readPeak, trimDb, type CrossfaderCurve } from '../engine/mixer';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { useFrame, type FrameLoop } from './frame';
import { Knob } from './Knob';
import s from '../platter.module.css';

const db = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} dB`;
const levelText = (v: number) => (v <= 0 ? 'off' : db(40 * Math.log10(v / 0.8)));
const CURVES: { id: CrossfaderCurve; label: string; hint: string }[] = [
  { id: 'power', label: 'Smooth', hint: 'Constant-power blend, a slight dip in the middle' },
  { id: 'full', label: 'Full', hint: 'Both decks at full level in the middle' },
  { id: 'cut', label: 'Cut', hint: 'Scratch curve: each side opens fully within the last few percent' },
];

/** A peak meter: level with a fast attack, slow fall, and a held peak. */
function useMeter(loop: FrameLoop, read: () => AnalyserNode | null) {
  const cover = useRef<HTMLSpanElement>(null);
  const hold = useRef<HTMLSpanElement>(null);
  const state = useRef({ level: 0, peak: 0, peakAge: 0 });
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
    if (cover.current) cover.current.style.height = `${(1 - m.level) * 100}%`;
    if (hold.current) hold.current.style.bottom = `${m.peak * 100}%`;
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
        <Knob label="Hi" name={`Channel ${deck} high EQ`} value={c.high} min={0} max={1} defaultValue={0.5} bipolar format={eqLabel} onChange={(high) => set({ high })} />
        <Knob label="Mid" name={`Channel ${deck} mid EQ`} value={c.mid} min={0} max={1} defaultValue={0.5} bipolar format={eqLabel} onChange={(mid) => set({ mid })} />
        <Knob label="Low" name={`Channel ${deck} low EQ`} value={c.low} min={0} max={1} defaultValue={0.5} bipolar format={eqLabel} onChange={(low) => set({ low })} />
        <Knob label="Filter" name={`Channel ${deck} filter`} value={c.filter} min={-1} max={1} defaultValue={0} bipolar format={filterLabel} onChange={(filter) => set({ filter })} />
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
            aria-valuetext={c.fader <= 0 ? 'off' : db(40 * Math.log10(c.fader))}
          />
          <Meter loop={loop} read={() => session.engine?.channels[i].meter ?? null} label={`Channel ${deck} level meter`} />
        </div>
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
        <div className={s.masterMeters} role="group" aria-label="Master level">
          <Meter loop={loop} read={() => session.engine?.masterMeters[0] ?? null} label="Master left level meter" />
          <Meter loop={loop} read={() => session.engine?.masterMeters[1] ?? null} label="Master right level meter" />
          <span className={s.meterCaption} aria-hidden="true">
            Mst
          </span>
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
      <div className={s.curves} role="group" aria-label="Crossfader curve">
        {CURVES.map((c) => (
          <button key={c.id} type="button" aria-pressed={m.curve === c.id} className={s.mini} title={c.hint} onClick={() => session.setCurve(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
    </section>
  );
}
