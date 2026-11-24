import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { FX_CHANNELS, type BeatFx, type BeatFxState } from '../engine/beatfx';
import { beatsLabel, beatsMs, FX_GROUPS, FX_META, FX_TYPES, nearestBeats, type FxBands, type FxType } from '../engine/fx';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { BEAT_FX_GUIDE, InfoTip } from './DeckGuide';
import { ChevronIcon } from './icons';
import { Knob } from './Knob';
import s from '../platter.module.css';
import b from './beatfx.module.css';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const CHANNEL_COLOUR = { A: 'var(--dj-a)', B: 'var(--dj-b)', M: 'var(--dj-text)' } as const;
const BANDS: { id: keyof FxBands; label: string; name: string }[] = [
  { id: 'low', label: 'Low', name: 'low band' },
  { id: 'mid', label: 'Mid', name: 'mid band' },
  { id: 'high', label: 'Hi', name: 'high band' },
];

/** "375 ms" — one beat value at the tempo the effect is timed to. */
export function timeLabel(bpm: number | null, beats: number) {
  return `${Math.round(beatsMs(bpm ?? 120, beats))} ms`;
}

/**
 * The mixer's Beat FX: the channel it's on, the effect and its beat value,
 * TIME and tempo, the X-pad, the bands, level, quantize and on.
 */
export function BeatFxPanel({ session }: { session: DjSession }) {
  const fx = session.fx;
  const st = useStore(fx.store);
  const meta = FX_META[st.type];
  const beats = fx.liveBeats(st);
  const list = meta.beats;
  const at = list.indexOf(nearestBeats(list, st.beats[st.type]));
  const on = st.on || st.pad.engaged;
  const where = FX_CHANNELS.find((c) => c.id === st.channel)!;
  const bandCount = BANDS.filter((x) => st.bands[x.id]).length;
  const style = { '--deck': CHANNEL_COLOUR[st.channel] } as CSSProperties;

  return (
    <section className={b.panel} style={style} aria-label="Beat FX" data-on={on || undefined}>
      <div className={b.head}>
        <h2 className={b.title}>Beat FX</h2>
        <div className={b.channels} role="group" aria-label="Beat FX channel">
          {FX_CHANNELS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`${s.mini} ${b.channel}`}
              data-channel={c.id}
              aria-pressed={st.channel === c.id}
              aria-label={c.name}
              onClick={() => fx.setChannel(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <InfoTip label="Beat FX guide" title="Beat FX" sections={[BEAT_FX_GUIDE]} deck={st.channel === 'B' ? 'B' : 'A'} hover className={b.info} />
      </div>

      <div className={b.row}>
        <label htmlFor="beat-fx-type" className={s.srOnly}>
          Beat FX effect
        </label>
        <select id="beat-fx-type" className={`${s.fxSelect} ${b.select}`} value={st.type} onChange={(e) => fx.setType(e.target.value as FxType)}>
          {FX_GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {FX_TYPES.filter((t) => t.group === g).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className={s.fxBeats} role="group" aria-label="Beat value">
          <button type="button" className={s.mini} onClick={() => fx.stepBeats(-1)} disabled={at <= 0 || !meta.timed} aria-label="Shorter beat value">
            <ChevronIcon dir={-1} />
          </button>
          <span className={`${s.fxBeatValue} ${b.beatValue}`} aria-live="polite">
            <span className={s.srOnly}>{beatsLabel(beats)} beat{meta.timed ? `, time ${timeLabel(st.bpm, beats)}` : ''}</span>
            <span aria-hidden="true">{beatsLabel(beats)}</span>
            <span className={b.time} aria-hidden="true" title="Time: the beat value at the effect's tempo">
              {meta.timed ? timeLabel(st.bpm, beats) : '—'}
            </span>
          </span>
          <button type="button" className={s.mini} onClick={() => fx.stepBeats(1)} disabled={at >= list.length - 1 || !meta.timed} aria-label="Longer beat value">
            <ChevronIcon dir={1} />
          </button>
        </div>
      </div>

      <XPad fx={fx} st={st} />

      <div className={b.row}>
        <div className={b.bands} role="group" aria-label="Bands the effect is on">
          {BANDS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={s.mini}
              aria-pressed={st.bands[x.id]}
              aria-label={`Effect on the ${x.name}`}
              title={st.bands[x.id] && bandCount === 1 ? 'The effect needs at least one band' : undefined}
              onClick={() => fx.setBand(x.id, !st.bands[x.id])}
            >
              {x.label}
            </button>
          ))}
        </div>
        {st.type === 'mobius' && (
          <button
            type="button"
            className={s.mini}
            onClick={() => fx.setDir(st.dir === 1 ? -1 : 1)}
            aria-label={`Mobius ${st.dir === 1 ? 'rising' : 'falling'}; switch direction`}
            title="Mobius: rising (+) or falling (−)"
          >
            {st.dir === 1 ? '+' : '−'}
          </button>
        )}
        <span className={b.spacer} />
        <Knob label="Level" name="Beat FX level" value={st.depth} min={0} max={1} defaultValue={0} size="sm" format={(v) => (v <= 0 ? 'dry' : pct(v))} onChange={(v) => fx.setDepth(v)} />
      </div>

      <div className={b.row}>
        <div className={b.tempo} role="group" aria-label="Beat FX tempo">
          <button
            type="button"
            className={s.mini}
            aria-pressed={st.tempo === 'auto'}
            onClick={() => fx.setAuto()}
            title={st.channel === 'M' ? 'Follow the louder playing deck' : `Follow ${where.name.toLowerCase()}`}
          >
            Auto
          </button>
          <button type="button" className={s.mini} aria-pressed={st.tempo === 'tap'} onClick={() => fx.tap()} title="Tap on the beat, twice or more">
            Tap
          </button>
          <span className={b.bpm} aria-live="polite" data-none={st.bpm ? undefined : true}>
            <span className={b.bpmValue}>{st.bpm ? st.bpm.toFixed(1) : '—'}</span>
            <span className={b.bpmCap}>{st.bpm ? 'BPM' : 'no BPM'}</span>
            {!st.bpm && <span className={s.srOnly}>: timed to 120 BPM until you tap</span>}
          </span>
        </div>
        <button
          type="button"
          className={s.mini}
          aria-pressed={st.quantize}
          onClick={() => fx.setQuantize(!st.quantize)}
          aria-label="FX quantize"
          title="Quantize: switching on and off and beat changes land on the next beat"
        >
          Q
        </button>
        <button type="button" className={`${s.toggle} ${s.fxOn} ${b.on}`} aria-pressed={on} onClick={() => fx.toggle()} aria-label="Beat FX">
          On
        </button>
      </div>
    </section>
  );
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The X-pad: a strip of beat values. Press a zone and the effect plays that
 * beat value while you hold it (coming on for the hold if it was off); drag
 * along the strip and it slides the effect's X parameter; let go and both go
 * back. Pointer events, so mouse, pen and touch alike. From the keyboard:
 * hold Space or Enter on a zone, with ↑ ↓ to slide.
 */
function XPad({ fx, st }: { fx: BeatFx; st: BeatFxState }) {
  const meta = FX_META[st.type];
  const zones = meta.pad;
  const el = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x0: number; sliding: boolean } | null>(null);
  const keyHeld = useRef(false);

  useEffect(
    () => () => {
      if (drag.current || keyHeld.current) fx.padRelease();
    },
    [fx],
  );

  const along = (clientX: number) => {
    const r = el.current?.getBoundingClientRect();
    return r && r.width ? clamp01((clientX - r.left) / r.width) : 0.5;
  };
  const zoneAt = (x: number) => zones[Math.min(zones.length - 1, Math.floor(x * zones.length))];

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.pointerType === 'mouse' && e.button !== 0) || drag.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x0: e.clientX, sliding: false };
    fx.padPress(zoneAt(along(e.clientX)));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.sliding && Math.abs(e.clientX - d.x0) < 8) return;
    d.sliding = true;
    fx.padSlide(along(e.clientX));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    fx.padRelease();
  };

  const keyDown = (z: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      keyHeld.current = true;
      fx.padPress(z);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && keyHeld.current) {
      e.preventDefault();
      const x = fx.store.get().pad.x ?? 0.5;
      fx.padSlide(x + (e.key === 'ArrowUp' ? 0.1 : -0.1));
    }
  };
  const keyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === ' ' || e.key === 'Enter') && keyHeld.current) {
      e.preventDefault();
      keyHeld.current = false;
      fx.padRelease();
    }
  };
  const blur = () => {
    if (!keyHeld.current) return;
    keyHeld.current = false;
    fx.padRelease();
  };

  const set = st.beats[st.type];
  const caption =
    st.pad.x !== null ? `${meta.x} ${pct(st.pad.x)}` : st.pad.beats !== null ? `Holding ${beatsLabel(st.pad.beats)} · drag for ${meta.x.toLowerCase()}` : `X-pad · hold a beat, drag for ${meta.x.toLowerCase()}`;

  return (
    <div className={b.xpadWrap}>
      <div
        ref={el}
        className={b.xpad}
        role="group"
        aria-label={`X-pad: hold a beat value; drag, or ↑ ↓ while holding, for ${meta.x.toLowerCase()}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onLostPointerCapture={up}
      >
        {zones.map((z) => (
          <button
            key={z}
            type="button"
            className={b.zone}
            aria-pressed={st.pad.beats === z}
            data-set={z === set || undefined}
            aria-label={`Hold for ${beatsLabel(z)} beat`}
            onKeyDown={keyDown(z)}
            onKeyUp={keyUp}
            onBlur={blur}
          >
            {beatsLabel(z)}
          </button>
        ))}
        {st.pad.x !== null && <span className={b.mark} style={{ left: `${st.pad.x * 100}%` }} aria-hidden="true" />}
      </div>
      <p className={b.caption} aria-live="polite">
        {caption}
      </p>
    </div>
  );
}
