import { useEffect, useId, useRef, useState } from 'react';
import { STEM_LABELS, STEMS, type StemName } from '../../engine/stems';
import type { Studio, StudioState } from '../../slicer/studio';
import type { AutoSlice, Source } from '../../slicer/types';
import { MAX_HITS } from '../../slicer/dsp';
import { BANK, bankName, Glyph, ICON } from './chopKit';
import { Popover } from './Popover';
import { StepTag } from './SlicerGuide';
import w from './workspace.module.css';

type Mode = AutoSlice['mode'];

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: 'transients',
    label: 'Hits',
    hint: 'Cut on the hits: drums, plucks, syllables',
  },
  { id: 'grid', label: 'Beats', hint: 'Cut on the sample’s beat grid' },
  { id: 'equal', label: 'Equal', hint: 'Cut into equal parts' },
];
const BEATS = [
  { beats: 0.25, label: '¼' },
  { beats: 0.5, label: '½' },
  { beats: 1, label: '1' },
  { beats: 2, label: '2' },
  { beats: 4, label: 'Bar' },
];
const COUNTS = [4, 8, 16, 32];
const GAPS = [
  { s: 0.02, label: '20' },
  { s: 0.05, label: '50' },
  { s: 0.1, label: '100' },
  { s: 0.25, label: '250' },
];
/** The sensitivity slider re-chops this long after it stops moving. */
const SWEEP_MS = 120;

interface Params {
  sensitivity: number;
  minGap: number;
  beats: number;
  count: number;
}

function initial(src: Source): Params {
  // Starting values for a mode the sample wasn't chopped with; the current
  // mode's come from the source itself.
  // Hits no closer than an eighth note at the sample's tempo (as the first
  // chop does), so a fresh switch to Hits gives pads, not drum-roll crumbs.
  const eighth = src.bpm ? Math.round(Math.max(0.05, Math.min(0.3, 30 / src.bpm)) * 1000) / 1000 : 0.1;
  const p: Params = { sensitivity: 0.5, minGap: eighth, beats: 1, count: 16 };
  const c = src.chop;
  if (c?.mode === 'transients') Object.assign(p, { sensitivity: c.sensitivity, minGap: c.minGap });
  if (c?.mode === 'grid') p.beats = c.beats;
  if (c?.mode === 'equal') p.count = c.count;
  return p;
}

const settings = (mode: Mode, p: Params): AutoSlice =>
  mode === 'transients' ? { mode, sensitivity: p.sensitivity, minGap: p.minGap } : mode === 'grid' ? { mode, beats: p.beats } : { mode, count: p.count };

interface Props {
  studio: Studio;
  state: StudioState;
  src: Source;
  ready: boolean;
  phone: boolean;
  /** Phone: the sample's name opens the sample sheet. */
  onPickSource?: () => void;
}

/**
 * One calm row: the sample, its tempo, how it's chopped and the one control
 * that tunes the chop. Every control re-chops at once (no Apply): the pads
 * change under your fingers.
 */
export function ChopToolbar({ studio, state, src, ready, phone, onPickSource }: Props) {
  const [mode, setMode] = useState<Mode>(src.chop?.mode ?? 'transients');
  const [p, setP] = useState<Params>(() => initial(src));
  const timer = useRef(0);
  const pending = useRef<AutoSlice | null>(null);
  const sensId = useId();
  const [menu, setMenu] = useState<null | {
    kind: 'bpm' | 'more';
    el: HTMLElement;
  }>(null);

  // Settings changed elsewhere (undo, the first auto-chop landing): follow them.
  const chopKey = JSON.stringify(src.chop ?? null);
  useEffect(() => {
    if (!src.chop) return;
    setMode(src.chop.mode);
    setP((old) => ({ ...old, ...initial(src) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chopKey]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const chop = (m: AutoSlice) => {
    window.clearTimeout(timer.current);
    pending.current = null;
    void studio.autoSlice(src.id, m);
  };
  /** The slider: re-chop once it rests a moment (a sweep is one undo step). */
  const sweep = (m: AutoSlice) => {
    pending.current = m;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const next = pending.current;
      pending.current = null;
      if (next) void studio.autoSlice(src.id, next);
    }, SWEEP_MS);
  };
  const release = () => {
    const next = pending.current;
    window.clearTimeout(timer.current);
    pending.current = null;
    void (next ? studio.autoSlice(src.id, next) : Promise.resolve()).then(() => studio.endGesture());
  };

  const pick = (m: Mode) => {
    setMode(m);
    chop(settings(m, p));
  };
  const set = (patch: Partial<Params>, live = false) => {
    const next = { ...p, ...patch };
    setP(next);
    if (live) sweep(settings(mode, next));
    else chop(settings(mode, next));
  };

  const n = src.slices.length;
  const manual = src.chop === null && n > 1;
  const capped = src.chop?.mode === 'transients' && n >= MAX_HITS - 1;
  const finding = state.busy === 'Finding the hits…';
  const noBpm = !src.bpm;
  const sound = src.origin.kind === 'sound';
  const open = (kind: 'bpm' | 'more') => (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    setMenu((m) => (m?.kind === kind ? null : { kind, el }));
  };

  const control =
    mode === 'transients' ? (
      <span className={w.live}>
        <label htmlFor={sensId} className={w.label}>
          Sensitivity
        </label>
        <input
          id={sensId}
          type="range"
          className={w.range}
          min={0}
          max={1}
          step={0.01}
          value={p.sensitivity}
          disabled={!ready}
          onChange={(e) => set({ sensitivity: Number(e.target.value) }, true)}
          onPointerUp={release}
          onKeyUp={release}
          aria-valuetext={`${Math.round(p.sensitivity * 100)}%`}
          title="More finds quieter hits, less keeps only the loud ones"
          style={{ '--fill': `${p.sensitivity * 100}%` } as React.CSSProperties}
        />
      </span>
    ) : mode === 'grid' ? (
      <span className={w.live}>
        <span className={w.label} id={`${sensId}-every`}>
          Slice every
        </span>
        <span className={w.seg} role="radiogroup" aria-labelledby={`${sensId}-every`}>
          {BEATS.map((b) => (
            <button
              key={b.beats}
              type="button"
              role="radio"
              aria-checked={p.beats === b.beats}
              disabled={noBpm}
              onClick={() => set({ beats: b.beats })}
              aria-label={b.beats === 4 ? 'A bar' : `${b.label} beat${b.beats > 1 ? 's' : ''}`}
            >
              {b.label}
            </button>
          ))}
        </span>
        {p.beats !== 4 && <span className={w.unit}>beat{p.beats > 1 ? 's' : ''}</span>}
      </span>
    ) : (
      <span className={w.live}>
        <span className={w.label} aria-hidden="true">
          Into
        </span>
        <span className={w.seg} role="radiogroup" aria-label="Number of slices">
          {COUNTS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={p.count === c} onClick={() => set({ count: c })} disabled={!ready && !src.duration}>
              {c}
            </button>
          ))}
        </span>
        <span className={w.unit}>equal parts</span>
      </span>
    );

  // The first chop picks its own shortest slice (an eighth note): show it too.
  const gaps = GAPS.some((g) => Math.abs(g.s - p.minGap) < 1e-6)
    ? GAPS
    : [...GAPS, { s: p.minGap, label: String(Math.round(p.minGap * 1000)) }].sort((x, y) => x.s - y.s);

  const chopState = (
    <span className={w.chopState} aria-live="polite">
      {manual ? (
        <span className={w.manual} title="You moved slices by hand. Touch a chop control to chop again.">
          Manual
        </span>
      ) : null}
      <span
        className={w.sliceCount}
        data-busy={finding || undefined}
        title={
          capped
            ? `The ${MAX_HITS} strongest hits. Turn sensitivity down, or chop a shorter part, for different ones.`
            : n > 64
              ? 'A lot of slices: a whole track cut small. Try Hits, a longer slice, or Equal parts.'
              : undefined
        }
      >
        <b>{n}</b> slice{n === 1 ? '' : 's'}
        {capped ? <span className={w.dim}> · strongest</span> : null}
        {!phone && n > BANK ? <span className={w.dim}> · pad banks A–{bankName(Math.ceil(n / BANK) - 1)}</span> : null}
      </span>
    </span>
  );

  return (
    <div className={w.toolbar} data-phone={phone || undefined}>
      {!phone && <StepTag step="slices" />}
      <div className={w.tbSource}>
        {phone ? (
          <button type="button" className={w.srcPick} onClick={onPickSource} aria-label={`Sample: ${src.name}. Pick another sample`}>
            <span className={w.srcPickName}>{src.name}</span>
            <Glyph d={ICON.caret} />
          </button>
        ) : (
          <h2 className={w.srcHeading} title={src.name}>
            {src.name}
          </h2>
        )}
        <button
          type="button"
          className={w.chip}
          aria-haspopup="dialog"
          aria-expanded={menu?.kind === 'bpm'}
          onClick={open('bpm')}
          title="This sample’s own tempo (the song’s is at the top)"
        >
          {src.bpm ? (
            <>
              {!phone && <span className={w.dim}>Sample </span>}
              <b>{fmtBpm(src.bpm)}</b> BPM
            </>
          ) : (
            'Set BPM'
          )}
          {src.key && <span className={w.dim}> · {src.key}</span>}
          <Glyph d={ICON.caret} size={12} />
        </button>
        {phone && chopState}
        {phone && <MoreButton open={menu?.kind === 'more'} onClick={open('more')} />}
      </div>

      <div className={w.tbChop}>
        {phone ? (
          <StepTag step="slices" compact />
        ) : (
          <span className={w.label} aria-hidden="true">
            Cut on
          </span>
        )}
        <span className={w.seg} role="radiogroup" aria-label="Cut on">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              disabled={m.id === 'grid' && noBpm}
              onClick={() => pick(m.id)}
              title={m.id === 'grid' && noBpm ? 'Set the sample’s BPM first' : m.hint}
            >
              {m.label}
            </button>
          ))}
        </span>
        {control}
        {!phone && chopState}
      </div>

      {!phone && (
        <div className={w.tbEnd}>
          <MoreButton open={menu?.kind === 'more'} onClick={open('more')} />
        </div>
      )}

      {menu?.kind === 'bpm' && (
        <Popover anchor={menu.el} onClose={() => setMenu(null)} label="Sample tempo" className={w.chopPop}>
          <BpmPanel studio={studio} state={state} src={src} />
        </Popover>
      )}
      {menu?.kind === 'more' && (
        <Popover anchor={menu.el} onClose={() => setMenu(null)} label="More chop options" className={w.chopPop}>
          {mode === 'transients' && (
            <div className={w.popSection}>
              <span className={w.popLabel}>Shortest slice</span>
              <span className={w.seg} role="radiogroup" aria-label="Shortest slice">
                {gaps.map((g) => (
                  <button key={g.s} type="button" role="radio" aria-checked={Math.abs(p.minGap - g.s) < 1e-6} onClick={() => set({ minGap: g.s })}>
                    {g.label}
                  </button>
                ))}
              </span>
              <span className={w.unit}>ms</span>
            </div>
          )}
          {!sound && (
            <div className={w.popSection} data-col>
              <span className={w.popLabel}>Split out a stem</span>
              <p className={w.fine}>A new sample with one part of this one, split on this device.</p>
              <div className={w.popGrid}>
                {STEMS.map((stem: StemName) => (
                  <button
                    key={stem}
                    type="button"
                    className={w.btn}
                    aria-pressed={src.stem === stem}
                    onClick={() => {
                      setMenu(null);
                      studio.addStem(src.id, stem);
                    }}
                  >
                    {STEM_LABELS[stem]}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className={w.popSection} data-col>
            <button
              type="button"
              className={w.menuItem}
              disabled={n < 2}
              onClick={() => {
                setMenu(null);
                studio.clearSlices(src.id);
              }}
            >
              Clear all slices
              <span className={w.dim}>Start over: play the sample and tap Cut on the hits</span>
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}

function MoreButton({ open, onClick }: { open: boolean; onClick: (e: React.MouseEvent<HTMLElement>) => void }) {
  return (
    <button
      type="button"
      className={w.iconBtn}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onClick}
      aria-label="More chop options"
      title="Shortest slice, stems, clear"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="4.5" cy="10" r="1.4" />
        <circle cx="10" cy="10" r="1.4" />
        <circle cx="15.5" cy="10" r="1.4" />
      </svg>
    </button>
  );
}

const fmtBpm = (b: number) => (Math.abs(b - Math.round(b)) < 0.05 ? String(Math.round(b)) : b.toFixed(1));

function BpmPanel({ studio, state, src }: { studio: Studio; state: StudioState; src: Source }) {
  const id = useId();
  const song = state.project.bpm;
  const same = !!src.bpm && Math.abs(src.bpm - song) < 0.01;
  const rate = src.bpm ? song / src.bpm : 1;
  return (
    <div className={w.popSection} data-col>
      <label htmlFor={id} className={w.popLabel}>
        Sample tempo
      </label>
      <p className={w.fine}>
        {src.bpm
          ? same
            ? 'The tempo found in this sound. It matches the song’s, so slices play as recorded.'
            : `The tempo found in this sound. The song runs at ${fmtBpm(song)}, so slices with Sync tempo play ${rate < 1 ? 'slower and lower' : 'faster and higher'} (${rate.toFixed(2)}×), like a record.`
          : 'No tempo found. Type one to cut on Beats and to sync slices to the song.'}{' '}
        Often off by double or half: ½× and 2× fix that.
      </p>
      <div className={w.popRow}>
        <BpmField id={id} value={src.bpm} onCommit={(v) => studio.setSourceBpm(src.id, v)} />
        <button
          type="button"
          className={w.btn}
          disabled={!src.bpm}
          onClick={() => src.bpm && studio.setSourceBpm(src.id, src.bpm / 2)}
          aria-label="Halve the sample tempo"
        >
          ½×
        </button>
        <button
          type="button"
          className={w.btn}
          disabled={!src.bpm}
          onClick={() => src.bpm && studio.setSourceBpm(src.id, src.bpm * 2)}
          aria-label="Double the sample tempo"
        >
          2×
        </button>
      </div>
      <button type="button" className={w.menuItem} disabled={!src.bpm || same} onClick={() => studio.matchSongToSource(src.id)}>
        Use as song tempo
        <span className={w.dim}>{same ? 'The song already runs at this tempo' : `Song is ${fmtBpm(song)} BPM: slices then play as recorded`}</span>
      </button>
    </div>
  );
}

/** A BPM field that edits freely and commits on Enter or blur. */
function BpmField({ id, value, onCommit }: { id: string; value: number | null; onCommit: (v: number | null) => void }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => setText(value ? String(Math.round(value * 100) / 100) : ''), [value]);
  const commit = () => {
    const v = Number(text);
    if (!text.trim()) onCommit(null);
    else if (Number.isFinite(v) && v > 0) onCommit(v);
    else setText(value ? String(value) : '');
  };
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      className={w.bpm}
      min={25}
      max={400}
      step={0.01}
      placeholder="—"
      value={text}
      data-autofocus
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}
