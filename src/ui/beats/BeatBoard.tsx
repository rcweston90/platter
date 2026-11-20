import { useRef, useState, type PointerEvent } from 'react';
import { LANES, PATTERNS, type StepValue, type TempoSource } from '../../engine/beatboard';
import { BANK_NAMES, BANKS, PADS_PER_BANK } from '../../engine/sampler';
import type { DjSession } from '../../engine/session';
import { getSound } from '../../engine/sounds/catalog';
import { ROLE_LABEL } from '../../engine/sounds/characters';
import { GROOVES } from '../../engine/sounds/grooves';
import { useStore } from '../../engine/store';
import { useFrame, type FrameLoop } from '../frame';
import { Knob } from '../Knob';
import s from './beats.module.css';

const TEMPOS: { id: TempoSource; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Lock to the deck you can hear; free when neither plays' },
  { id: 'A', label: 'A', hint: 'Lock to deck A' },
  { id: 'B', label: 'B', hint: 'Lock to deck B' },
  { id: 'free', label: 'Free', hint: 'Its own tempo' },
];

/**
 * The beat board: sixteen lanes, one per pad of a bank, by sixteen or
 * thirty-two steps. Click or drag across steps to paint; Shift (or the
 * Accent tool) for an accent. It locks to the decks' beat grid, so it plays
 * in time with the record, not just at the same tempo.
 */
export function BeatBoard({ session, loop }: { session: DjSession; loop: FrameLoop }) {
  const board = session.beats;
  const b = useStore(board.store);
  const { pads } = useStore(session.sampler.store);
  const grid = useRef<HTMLDivElement>(null);
  const now = useRef<number | null>(null);
  const paint = useRef<StepValue | null>(null);
  const [accentTool, setAccentTool] = useState(false);
  const [copyTo, setCopyTo] = useState(false);
  const pat = b.patterns[b.current];
  const soloed = b.lanes.some((l) => l.solo);

  // The playhead: whichever step you're hearing, lit across the grid.
  useFrame(loop, () => {
    const step = board.heardStep();
    if (step === now.current || !grid.current) return;
    grid.current.querySelectorAll('[data-now]').forEach((el) => el.removeAttribute('data-now'));
    now.current = step;
    if (step !== null) grid.current.querySelectorAll(`[data-col="${step}"]`).forEach((el) => el.setAttribute('data-now', ''));
  });

  const startPaint = (e: PointerEvent<HTMLButtonElement>, lane: number, step: number) => {
    if (e.button !== 0) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const v = pat.steps[lane][step];
    const accent = e.shiftKey || accentTool;
    const next: StepValue = accent ? (v === 2 ? 0 : 2) : v ? 0 : 1;
    paint.current = next;
    board.setStep(lane, step, next);
    const end = () => {
      paint.current = null;
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointerup', end);
  };

  const follow =
    b.following !== null ? `Locked to deck ${b.following === 0 ? 'A' : 'B'}` : b.tempo === 'A' || b.tempo === 'B' ? `Waiting for deck ${b.tempo}` : 'Free tempo';

  return (
    <section className={s.board} aria-label="Beat board">
      <div className={s.transport}>
        <button
          type="button"
          className={s.play}
          aria-pressed={b.playing}
          onClick={async () => {
            await session.ensureEngine();
            board.toggle();
          }}
          aria-label={b.playing ? 'Stop the beat board' : 'Play the beat board'}
        >
          <span aria-hidden="true">{b.playing ? '■' : '▶'}</span>
        </button>
        <button type="button" className={s.rec} aria-pressed={b.recording} onClick={() => board.setRecording(!b.recording)} title="While playing, pads you hit are written into the pattern">
          <span className={s.recDot} aria-hidden="true" /> Rec
        </button>
        <div className={s.tempo}>
          <span className={s.bpm} aria-live="off">
            {b.bpm.toFixed(1)}
            <small>BPM</small>
          </span>
          <span className={s.follow} data-locked={b.following !== null}>
            {follow}
          </span>
        </div>
        <div className={s.seg} role="group" aria-label="Beat board tempo">
          {TEMPOS.map((t) => (
            <button key={t.id} type="button" aria-pressed={b.tempo === t.id} title={t.hint} onClick={() => board.setTempo(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {b.tempo === 'free' || b.following === null ? (
          <label className={s.bpmField}>
            <span className={s.srOnly}>Free tempo, BPM</span>
            <input type="number" min={40} max={220} step={0.1} value={b.freeBpm} onChange={(e) => board.setFreeBpm(Number(e.target.value))} aria-label="Free tempo, BPM" />
          </label>
        ) : null}
        <button type="button" className={s.chip} onClick={() => board.tap()} title="Tap the beat to set a free tempo">
          Tap
        </button>
        <div className={s.swing}>
          <label htmlFor="beat-swing">Swing</label>
          <input id="beat-swing" type="range" min={50} max={75} step={1} value={b.swing} onChange={(e) => board.setSwing(Number(e.target.value))} aria-valuetext={`${b.swing}%`} />
          <output htmlFor="beat-swing">{b.swing}%</output>
        </div>
        <Knob
          label="Level"
          name="Beat board level"
          value={b.level}
          min={0}
          max={1}
          defaultValue={0.8}
          size="sm"
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => board.setLevel(v)}
        />
      </div>

      <div className={s.patternBar}>
        <div className={s.patterns} role="group" aria-label="Patterns">
          {Array.from({ length: PATTERNS }, (_, i) => {
            const used = b.patterns[i].steps.some((r) => r.some(Boolean));
            return (
              <button
                key={i}
                type="button"
                className={s.patBtn}
                aria-pressed={b.current === i}
                data-queued={b.queued === i}
                data-used={used}
                onClick={() => {
                  if (copyTo) {
                    board.copyPattern(b.current, i);
                    setCopyTo(false);
                    board.selectPattern(i);
                  } else board.selectPattern(i);
                }}
                aria-label={copyTo ? `Copy pattern ${b.current + 1} to ${i + 1}` : `Pattern ${i + 1}${b.queued === i ? ', plays next bar' : ''}`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
        <button type="button" className={s.chip} aria-pressed={copyTo} onClick={() => setCopyTo(!copyTo)}>
          {copyTo ? 'Copy to…' : 'Copy'}
        </button>
        <button type="button" className={s.chip} onClick={() => board.clearPattern()}>
          Clear
        </button>
        <div className={s.seg} role="group" aria-label="Steps">
          {([16, 32] as const).map((n) => (
            <button key={n} type="button" aria-pressed={pat.length === n} onClick={() => board.setLength(n)}>
              {n}
            </button>
          ))}
        </div>
        <label className={s.selectWrap}>
          <span>Groove</span>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) board.applyGroove(e.target.value);
            }}
            aria-label="Start from a groove"
          >
            <option value="">Start from…</option>
            {GROOVES.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label className={s.selectWrap}>
          <span>Plays bank</span>
          <select value={b.bank} onChange={(e) => board.setBank(Number(e.target.value))} aria-label="Bank the beat board plays">
            {Array.from({ length: BANKS }, (_, i) => (
              <option key={i} value={i}>
                {BANK_NAMES[i]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={s.chip} aria-pressed={accentTool} onClick={() => setAccentTool(!accentTool)} title="Paint accents (or hold Shift)">
          Accent
        </button>
      </div>

      <div className={s.gridScroll}>
        <div ref={grid} className={s.grid} style={{ ['--steps' as string]: pat.length }} role="grid" aria-label={`Pattern ${b.current + 1}, ${pat.length} steps`}>
          <div className={s.gridRow} role="row" aria-hidden="true">
            <span className={s.laneHead} />
            {Array.from({ length: pat.length }, (_, k) => (
              <span key={k} className={s.stepNum} data-col={k} data-beat={k % 4 === 0}>
                {k % 4 === 0 ? k / 4 + 1 : ''}
              </span>
            ))}
          </div>
          {Array.from({ length: LANES }, (_, lane) => {
            const pad = pads[b.bank * PADS_PER_BANK + lane];
            const info = pad.sound ? getSound(pad.sound) : undefined;
            // A kit's own sounds go by their part (Kick, Closed hat); the kit is on the pads.
            const name = info ? (info.kit && pad.role ? ROLE_LABEL[pad.role] : info.name) : `Pad ${lane + 1}`;
            const l = b.lanes[lane];
            const quiet = l.mute || (soloed && !l.solo);
            return (
              <div key={lane} className={s.gridRow} role="row" data-cat={info?.category ?? 'none'} data-quiet={quiet} data-empty={!info}>
                <div className={s.laneHead} role="rowheader">
                  <button type="button" className={s.laneName} onPointerDown={() => void session.hitPad(b.bank * PADS_PER_BANK + lane)} title={`Hear ${name}`}>
                    {name}
                  </button>
                  <button type="button" className={s.ms} aria-pressed={l.mute} onClick={() => board.setLane(lane, { mute: !l.mute })} aria-label={`Mute ${name}`}>
                    M
                  </button>
                  <button type="button" className={s.ms} data-solo aria-pressed={l.solo} onClick={() => board.setLane(lane, { solo: !l.solo })} aria-label={`Solo ${name}`}>
                    S
                  </button>
                  <LaneMenu session={session} lane={lane} name={name} />
                </div>
                {Array.from({ length: pat.length }, (_, k) => {
                  const v = pat.steps[lane][k];
                  return (
                    <button
                      key={k}
                      type="button"
                      role="gridcell"
                      className={s.step}
                      data-col={k}
                      data-v={v}
                      data-beat={k % 4 === 0}
                      data-bar={Math.floor(k / 4) % 2}
                      aria-pressed={v > 0}
                      aria-label={`${name}, step ${k + 1}${v === 2 ? ', accent' : ''}`}
                      onPointerDown={(e) => startPaint(e, lane, k)}
                      onPointerEnter={(e) => {
                        if (paint.current !== null && e.buttons & 1) board.setStep(lane, k, paint.current);
                      }}
                      onClick={(e) => {
                        // Keyboard only: pointer clicks were handled on pointerdown.
                        if (e.detail === 0) board.cycleStep(lane, k, e.shiftKey || accentTool);
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function LaneMenu({ session, lane, name }: { session: DjSession; lane: number; name: string }) {
  const board = session.beats;
  const { lanes } = useStore(board.store);
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  return (
    <div className={s.laneMenu}>
      <button type="button" className={s.ms} aria-expanded={open} aria-label={`More for ${name}`} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className={s.menu} role="menu" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <button type="button" role="menuitem" onClick={act(() => board.fillLane(lane, 4))}>
            Every beat
          </button>
          <button type="button" role="menuitem" onClick={act(() => board.fillLane(lane, 2))}>
            Every 8th
          </button>
          <button type="button" role="menuitem" onClick={act(() => board.fillLane(lane, 4, 2))}>
            Offbeats
          </button>
          <button type="button" role="menuitem" onClick={act(() => board.fillLane(lane, 1))}>
            Every 16th
          </button>
          <button type="button" role="menuitem" onClick={act(() => board.rotateLane(lane, -1))}>
            Nudge left
          </button>
          <button type="button" role="menuitem" onClick={act(() => board.rotateLane(lane, 1))}>
            Nudge right
          </button>
          <button type="button" role="menuitem" onClick={act(() => board.clearLane(lane))}>
            Clear lane
          </button>
          <label className={s.menuRange}>
            <span>Lane volume</span>
            <input type="range" min={0} max={1} step={0.01} value={lanes[lane].gain} onChange={(e) => board.setLane(lane, { gain: Number(e.target.value) })} aria-label={`${name} lane volume`} />
          </label>
        </div>
      )}
    </div>
  );
}
