import { useEffect, useId, useRef, useState } from 'react';
import { STEM_LABELS, STEMS, type StemName } from '../../engine/stems';
import { sliceRange } from '../../slicer/model';
import type { Studio, StudioState } from '../../slicer/studio';
import type { AutoSlice, Source } from '../../slicer/types';
import { useDropTarget, type FrameLoop } from '../frame';
import { SliceWave, fmtTime } from './SliceWave';
import w from './workspace.module.css';

type Mode = AutoSlice['mode'];

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'transients', label: 'Hits', hint: 'Cut on transients: drum hits, plucks, syllables' },
  { id: 'grid', label: 'Beats', hint: 'Cut on the sample’s beat grid' },
  { id: 'equal', label: 'Equal', hint: 'Cut into equal parts' },
];
const GRID_STEPS = [
  { beats: 0.25, label: '1/16' },
  { beats: 0.5, label: '1/8' },
  { beats: 1, label: '1/4' },
  { beats: 2, label: '1/2' },
  { beats: 4, label: '1 bar' },
  { beats: 8, label: '2 bars' },
];
const EQUAL_COUNTS = [4, 8, 16, 32];
const MIN_GAPS = [
  { s: 0.02, label: '20 ms' },
  { s: 0.05, label: '50 ms' },
  { s: 0.1, label: '100 ms' },
  { s: 0.25, label: '250 ms' },
  { s: 0.5, label: '500 ms' },
];

const hasFiles = (types: readonly string[]) => types.includes('Files');

interface Props {
  studio: Studio;
  state: StudioState;
  loop: FrameLoop;
  onOpenFiles: () => void;
  onFiles: (files: File[]) => void;
  onBrowse: () => void;
}

/** The selected sample: tempo, stems, auto-slice, the waveform and what to do with a slice. */
export function SliceEditor({ studio, state, loop, onOpenFiles, onFiles, onBrowse }: Props) {
  const src = studio.source(state.sourceId);
  const box = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useDropTarget(box, hasFiles, setOver, (dt) => onFiles(Array.from(dt.files)));

  return (
    <div ref={box} className={w.editor} data-over={over}>
      {src ? <Editor key={src.id} studio={studio} state={state} src={src} loop={loop} /> : <Empty onBrowse={onBrowse} onOpenFiles={onOpenFiles} />}
    </div>
  );
}

function Empty({ onBrowse, onOpenFiles }: { onBrowse: () => void; onOpenFiles: () => void }) {
  return (
    <div className={w.emptyState}>
      <svg viewBox="0 0 64 32" aria-hidden="true" className={w.emptyArt}>
        <path d="M2 16h6l3-9 4 18 4-14 3 8 3-5 4 10 4-16 4 12 3-6 3 4h17" />
        <path d="M22 3v26M40 3v26" className={w.emptyCut} />
      </svg>
      <h2>Pick a track from your crate or open a FLAC to start chopping</h2>
      <p>Then auto-slice it on the hits or the beat, click slices to hear them and drag them onto the lanes below.</p>
      <div className={w.emptyActions}>
        <button type="button" className={w.primary} onClick={onBrowse}>
          Browse the crate
        </button>
        <button type="button" className={w.btn} onClick={onOpenFiles}>
          Open audio files…
        </button>
      </div>
      <p className={w.fine}>Or drop audio files here. They stay in this browser.</p>
    </div>
  );
}

function Editor({ studio, state, src, loop }: { studio: Studio; state: StudioState; src: Source; loop: FrameLoop }) {
  const audio = state.audio[src.id];
  const status = audio?.status ?? 'loading';
  const ready = status === 'ready' && !!studio.buffer(src.id);
  const [pointer, setPointer] = useState<number | null>(null);
  const slice = state.slice !== null && state.slice < src.slices.length ? state.slice : null;
  const duration = studio.buffer(src.id)?.duration || src.duration;

  return (
    <>
      <Toolbar studio={studio} state={state} src={src} ready={ready} />
      <div className={w.stage}>
        {ready ? (
          <SliceWave studio={studio} source={src} slice={slice} meter={state.project.meter} loop={loop} pointer={pointer} onPointer={setPointer} />
        ) : (
          <div className={w.waveState} role="status">
            {status === 'loading' && (
              <>
                <div className={w.shimmer} aria-hidden="true" />
                <p>Reading “{src.name}”…</p>
              </>
            )}
            {status === 'splitting' && (
              <>
                <p>
                  Splitting out the {src.stem ? STEM_LABELS[src.stem].toLowerCase() : 'stems'} · {Math.round((audio?.progress ?? 0) * 100)}%
                </p>
                <span
                  className={w.bigProgress}
                  role="progressbar"
                  aria-label="Splitting stems"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((audio?.progress ?? 0) * 100)}
                >
                  <span style={{ transform: `scaleX(${audio?.progress ?? 0})` }} />
                </span>
                <p className={w.fine}>Runs on this computer. It takes a minute or two for a whole song.</p>
              </>
            )}
            {(status === 'missing' || status === 'error') && (
              <>
                <p>{audio?.message ?? `“${src.name}” couldn’t be read.`}</p>
                <button type="button" className={w.primary} onClick={() => studio.retry(src.id)}>
                  Retry
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <SliceBar studio={studio} state={state} src={src} slice={slice} ready={ready} pointer={pointer} duration={duration} />
    </>
  );
}

/* ── Toolbar: tempo, stems, auto-slice ──────────────────────────────────── */

function Toolbar({ studio, state, src, ready }: { studio: Studio; state: StudioState; src: Source; ready: boolean }) {
  const bpmId = useId();
  const sensId = useId();
  const gapId = useId();
  const stepId = useId();
  const [mode, setMode] = useState<Mode>('transients');
  const [sensitivity, setSensitivity] = useState(0.5);
  const [minGap, setMinGap] = useState(0.05);
  const [beats, setBeats] = useState(1);
  const [count, setCount] = useState(16);
  const sound = src.origin.kind === 'sound';
  const busy = !!state.busy;

  const run = () => {
    const m: AutoSlice = mode === 'transients' ? { mode, sensitivity, minGap } : mode === 'grid' ? { mode, beats } : { mode, count };
    void studio.autoSlice(src.id, m);
  };
  const songBpm = state.project.bpm;

  return (
    <div className={w.toolbar}>
      <div className={w.group} aria-label="Sample">
        <h2 className={w.srcHeading} title={src.name}>
          {src.name}
        </h2>
        {src.key && (
          <span className={w.badge} title="Key (Camelot)">
            {src.key}
          </span>
        )}
      </div>

      <div className={w.group} role="group" aria-label="Sample tempo">
        <label htmlFor={bpmId} className={w.label}>
          BPM
        </label>
        <BpmField id={bpmId} value={src.bpm} onCommit={(v) => studio.setSourceBpm(src.id, v)} />
        <button
          type="button"
          className={w.btn}
          disabled={!src.bpm}
          onClick={() => src.bpm && studio.setSourceBpm(src.id, src.bpm / 2)}
          aria-label="Halve the sample tempo"
          title="Half the tempo"
        >
          ½×
        </button>
        <button
          type="button"
          className={w.btn}
          disabled={!src.bpm}
          onClick={() => src.bpm && studio.setSourceBpm(src.id, src.bpm * 2)}
          aria-label="Double the sample tempo"
          title="Double the tempo"
        >
          2×
        </button>
        <button
          type="button"
          className={w.btn}
          disabled={!src.bpm || Math.abs((src.bpm ?? 0) - songBpm) < 0.01}
          onClick={() => studio.matchSongToSource(src.id)}
          title={`Set the song tempo (${songBpm}) to this sample’s, so its slices play as recorded`}
        >
          Use as song tempo
        </button>
      </div>

      {!sound && (
        <div className={w.group}>
          <details className={w.menu}>
            <summary className={w.btn} title="Split out one part of this sample (vocals, drums, bass or the rest) as a new sample">
              {src.stem ? `Stem: ${STEM_LABELS[src.stem]}` : 'Stems'}
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className={w.caret}>
                <path d="M2 4l4 4 4-4" />
              </svg>
            </summary>
            <div className={w.menuPanel} role="group" aria-label="Split into stems">
              <p className={w.fine}>A new sample with just one part, split on this computer.</p>
              {STEMS.map((stem: StemName) => (
                <button
                  key={stem}
                  type="button"
                  className={w.menuItem}
                  aria-pressed={src.stem === stem}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    studio.addStem(src.id, stem);
                  }}
                >
                  {STEM_LABELS[stem]}
                </button>
              ))}
            </div>
          </details>
        </div>
      )}

      <div className={w.group} role="group" aria-label="Auto-slice">
        <span className={w.label}>Auto-slice</span>
        <div className={w.seg} role="radiogroup" aria-label="Slice on">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)} title={m.hint}>
              {m.label}
            </button>
          ))}
        </div>
        {mode === 'transients' && (
          <>
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
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
              aria-valuetext={`${Math.round(sensitivity * 100)}%`}
              title="Higher finds quieter hits"
            />
            <label htmlFor={gapId} className={w.srOnly}>
              Shortest slice
            </label>
            <select id={gapId} className={w.select} value={minGap} onChange={(e) => setMinGap(Number(e.target.value))} title="Shortest slice">
              {MIN_GAPS.map((g) => (
                <option key={g.s} value={g.s}>
                  ≥ {g.label}
                </option>
              ))}
            </select>
          </>
        )}
        {mode === 'grid' && (
          <>
            <label htmlFor={stepId} className={w.label}>
              Every
            </label>
            <select id={stepId} className={w.select} value={beats} onChange={(e) => setBeats(Number(e.target.value))}>
              {GRID_STEPS.map((g) => (
                <option key={g.beats} value={g.beats}>
                  {g.label}
                </option>
              ))}
            </select>
          </>
        )}
        {mode === 'equal' && (
          <div className={w.seg} role="radiogroup" aria-label="Number of slices">
            {EQUAL_COUNTS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={count === n} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className={w.primary}
          disabled={!ready || busy || (mode === 'grid' && !src.bpm)}
          onClick={run}
          title={mode === 'grid' && !src.bpm ? 'Set the sample’s BPM first' : undefined}
        >
          {state.busy === 'Finding the hits…' ? 'Finding…' : 'Auto-slice'}
        </button>
        <button type="button" className={w.btn} disabled={src.slices.length < 2} onClick={() => studio.clearSlices(src.id)}>
          Clear
        </button>
      </div>
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
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          e.preventDefault();
          setText(value ? String(value) : '');
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/* ── Slice bar: what to do with the selected slice ──────────────────────── */

interface BarProps {
  studio: Studio;
  state: StudioState;
  src: Source;
  slice: number | null;
  ready: boolean;
  pointer: number | null;
  duration: number;
}

function SliceBar({ studio, state, src, slice, ready, pointer, duration }: BarProps) {
  const n = src.slices.length;
  const sel = slice ?? 0;
  const [a, b] = sliceRange({ ...src, duration }, sel);
  const au = state.audition && state.audition.sourceId === src.id ? state.audition : null;
  const playingThis = !!au && Math.abs(au.start - a) < 0.005 && Math.abs(au.end - b) < 0.005;
  const looping = playingThis && au!.loop;
  const reversing = playingThis && au!.reverse;
  const canCut = ready && pointer !== null && pointer > 0.01 && pointer < duration - 0.01 && !src.slices.some((t) => Math.abs(t - pointer) < 0.01);

  return (
    <div className={w.sliceBar} role="toolbar" aria-label="Slice actions">
      <button
        type="button"
        className={w.btn}
        disabled={!canCut}
        onClick={() => pointer !== null && studio.addSlice(src.id, pointer)}
        title={pointer === null ? 'Click the waveform to place the cursor first (or double-click to cut there)' : `Add a slice point at ${fmtTime(pointer)}`}
      >
        <Glyph d="M10 3v14M6 6l4-3 4 3" /> Slice here
      </button>
      <span className={w.sliceInfo} aria-live="polite">
        {slice === null ? (
          <>
            <b>{n}</b> slice{n === 1 ? '' : 's'}
            <span className={w.dim}> · click one to pick it</span>
          </>
        ) : (
          <>
            <span title={`${fmtTime(a)}–${fmtTime(b)}`}>
              Slice <b>{sel + 1}</b>/{n}
              <span className={w.dim}> · {(b - a).toFixed(2)} s</span>
            </span>
          </>
        )}
      </span>
      <span className={w.barGroup}>
        <button
          type="button"
          className={w.btn}
          disabled={!ready}
          aria-pressed={playingThis && !looping && !reversing}
          aria-label={playingThis && !looping && !reversing ? 'Stop the slice' : 'Play the slice'}
          onClick={() => (playingThis && !looping && !reversing ? studio.stopAudition() : studio.auditionSlice(src.id, sel))}
          title="Play the slice (or its key, 1–0 / Q–P)"
        >
          {playingThis && !looping && !reversing ? <Glyph d="M6 6h8v8H6z" fill /> : <Glyph d="M7 5l8 5-8 5z" fill />}
          {playingThis && !looping && !reversing ? 'Stop' : 'Play'}
        </button>
        <button
          type="button"
          className={w.btn}
          disabled={!ready}
          aria-pressed={looping}
          aria-label="Loop the slice"
          onClick={() => (looping ? studio.stopAudition() : studio.auditionSlice(src.id, sel, { loop: true }))}
          title="Loop the slice"
        >
          <Glyph d="M4 9a4 4 0 0 1 4-4h7m-2-2 2 2-2 2M16 11a4 4 0 0 1-4 4H5m2 2-2-2 2-2" /> Loop
        </button>
        <button
          type="button"
          className={w.btn}
          disabled={!ready}
          aria-pressed={reversing}
          aria-label="Play the slice reversed"
          onClick={() => (reversing ? studio.stopAudition() : (studio.selectSlice(sel), void studio.audition(src.id, a, b, { reverse: true })))}
          title="Hear the slice backwards"
        >
          <Glyph d="M13 5l-8 5 8 5z" fill /> Reverse
        </button>
      </span>
      <span className={w.barGroup}>
        <button
          type="button"
          className={w.primary}
          disabled={!ready}
          onClick={() => (studio.selectSlice(sel), studio.appendSlice(src.id, sel))}
          title="Add the slice after the last clip on the first sample lane (Enter) — or drag it onto any lane"
        >
          <Glyph d="M10 4v12M4 10h12" /> Add to timeline
        </button>
        <button
          type="button"
          className={w.btn}
          disabled={!ready}
          onClick={() => void studio.sendToPads(src.id, slice === null ? src.slices.map((_, i) => i) : [slice])}
          title={slice === null ? 'Put every slice on the sampler’s pads, from the selected pad on' : 'Put this slice on the sampler’s selected pad'}
        >
          {slice === null ? `All ${n} to pads` : 'To pad'}
        </button>
        <button type="button" className={w.btn} disabled={!ready} onClick={() => void studio.saveSlice(src.id, sel)} title="Save the slice as a 24-bit WAV">
          Save WAV
        </button>
        <button
          type="button"
          className={w.btn}
          disabled={slice === null || slice === 0}
          onClick={() => slice !== null && studio.removeSlice(src.id, slice)}
          aria-label={slice ? `Remove the slice point at the start of slice ${slice + 1}` : 'Remove slice point'}
          title="Join this slice to the one before (or Alt/Option-click a boundary)"
        >
          <Glyph d="M5 5l10 10M15 5 5 15" /> Remove cut
        </button>
      </span>
    </div>
  );
}

const Glyph = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" className={fill ? w.glyphFill : w.glyph}>
    <path d={d} />
  </svg>
);
