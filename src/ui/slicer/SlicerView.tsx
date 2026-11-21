import { useEffect, useId, useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import { MAX_BPM, MIN_BPM, SNAPS } from '../../slicer/model';
import type { Studio } from '../../slicer/studio';
import type { Snap } from '../../slicer/types';
import { useFrame, type FrameLoop } from '../frame';
import { Arranger } from './Arranger';
import { SliceWorkspace } from './SliceWorkspace';
import v from './slicer.module.css';

const TEXT_ENTRY = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function isTyping(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t instanceof HTMLInputElement && TEXT_ENTRY.has(t.type);
}

/** Bars.beats.sixteenths, 1-based, like every DAW's counter. */
function counter(beat: number, meter: number) {
  const b = Math.max(0, beat);
  const bar = Math.floor(b / meter) + 1;
  const inBar = Math.floor(b % meter) + 1;
  const six = Math.floor((b % 1) * 4) + 1;
  return `${bar}.${inBar}.${six}`;
}

/**
 * The slicer: a full-window studio over the decks (which keep playing). Chop
 * your own audio in the top half, arrange the slices with drum lanes in the
 * bottom half, and render the result or send it back to the decks.
 */
export function SlicerView({ studio, session, loop }: { studio: Studio; session: DjSession; loop: FrameLoop }) {
  const st = useStore(studio.store);
  const p = st.project;
  const root = useRef<HTMLElement>(null);
  const pos = useRef<HTMLSpanElement>(null);
  const [split, setSplit] = useState(0.5);
  const bpmId = useId();
  const snapId = useId();
  const swingId = useId();
  const levelId = useId();
  const nameId = useId();

  useFrame(loop, () => {
    if (pos.current) pos.current.textContent = counter(studio.position(), p.meter);
  });

  // Focus lands in the view when it opens, so its keys work at once.
  useEffect(() => {
    root.current?.focus();
  }, []);

  // The studio's keys while the view is open (the decks' keys are off: the
  // rig is inert underneath).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.defaultPrevented) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (e.code === 'Space' && !mod && !e.altKey) {
        // A focused button would also "click" on Space: the transport wins.
        if (e.target instanceof HTMLButtonElement && e.target.closest('[data-own-space]')) return;
        return run(() => studio.toggle());
      }
      if (mod && k === 'z' && !e.shiftKey) return run(() => studio.undo());
      if (mod && ((k === 'z' && e.shiftKey) || k === 'y')) return run(() => studio.redo());
      if (mod && k === 'd') return run(() => studio.duplicateClips());
      if (mod && k === 'a') return run(() => studio.selectAll());
      if (mod && k === 'e') return run(() => studio.splitAt());
      if (mod && k === 'l') return run(() => studio.loopSelection());
      if (mod && k === 'u') return run(() => studio.quantize());
      if (mod || e.altKey) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && studio.store.get().selection.length) return run(() => studio.deleteClips());
      if (e.key === 'Escape') {
        const s = studio.store.get();
        if (s.audition) return run(() => studio.stopAudition());
        if (s.selection.length) return run(() => studio.select([]));
        if (s.playing) return run(() => studio.stop());
        return run(() => studio.close());
      }
      if (e.key === 'Home') return run(() => studio.seek(studio.store.get().project.loop.on ? studio.store.get().project.loop.start : 0));
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [studio]);

  // Drag the divider between the editor and the arranger.
  const startResize = (e: React.PointerEvent) => {
    const el = root.current?.querySelector<HTMLElement>('[data-slicer-body]');
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(Math.min(0.75, Math.max(0.25, (ev.clientY - rect.top) / rect.height)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <section ref={root} className={v.view} aria-label="Slicer" tabIndex={-1} data-slicer>
      <header className={v.bar}>
        <button type="button" className={v.back} onClick={() => studio.close()} title="Back to the decks (Esc)">
          <BackIcon /> Decks
        </button>

        <div className={v.project}>
          <label htmlFor={nameId} className={v.srOnly}>
            Project name
          </label>
          <input
            id={nameId}
            className={v.name}
            value={p.name}
            onChange={(e) => studio.rename(e.target.value)}
            onBlur={() => studio.endGesture()}
            spellCheck={false}
          />
          <details className={v.menu}>
            <summary className={v.btn} aria-label="Projects">
              Projects <Caret />
            </summary>
            <div className={v.menuPanel}>
              <div className={v.menuRow}>
                <button type="button" className={v.btn} onClick={(e) => (studio.newProject(), closeMenu(e))}>
                  New
                </button>
                <button type="button" className={v.btn} onClick={(e) => (studio.duplicateProject(), closeMenu(e))}>
                  Duplicate
                </button>
                <button
                  type="button"
                  className={`${v.btn} ${v.danger}`}
                  onClick={(e) => {
                    if (window.confirm(`Delete “${p.name}”? Its clips and slices go; your audio files don’t.`)) void studio.deleteProject(p.id);
                    closeMenu(e);
                  }}
                >
                  Delete
                </button>
              </div>
              <ul className={v.projects}>
                {st.projects.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={v.projectItem}
                      aria-current={m.id === p.id || undefined}
                      onClick={(e) => (void studio.openProject(m.id), closeMenu(e))}
                    >
                      <span>{m.name}</span>
                      <span className={v.dim}>
                        {m.clips} clip{m.clips === 1 ? '' : 's'} · {new Date(m.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </div>

        <div className={v.transport} data-own-space>
          <button
            type="button"
            className={`${v.play} ${st.playing ? v.playing : ''}`}
            aria-pressed={st.playing}
            onClick={() => studio.toggle()}
            aria-label={st.playing ? 'Stop (Space)' : 'Play (Space)'}
            title={st.playing ? 'Stop (Space)' : 'Play (Space)'}
          >
            {st.playing ? <StopIcon /> : <PlayIcon />}
          </button>
          <span ref={pos} className={v.counter} aria-label="Position (bar, beat, sixteenth)">
            1.1.1
          </span>
          <button
            type="button"
            className={v.btn}
            aria-pressed={p.loop.on}
            onClick={() => studio.setLoop({ on: !p.loop.on })}
            title="Loop the bracketed bars (Cmd/Ctrl+L loops the selection)"
          >
            <LoopIcon /> Loop
          </button>
          <button type="button" className={v.btn} aria-pressed={st.metronome} onClick={() => studio.setMetronome(!st.metronome)} title="Metronome click">
            <ClickIcon /> Click
          </button>
        </div>

        <div className={v.fields}>
          <div className={v.field}>
            <label htmlFor={bpmId}>BPM</label>
            <input
              id={bpmId}
              type="number"
              min={MIN_BPM}
              max={MAX_BPM}
              step={0.1}
              value={p.bpm}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= MIN_BPM) studio.setBpm(n);
              }}
              onBlur={() => studio.endGesture()}
            />
          </div>
          <div className={v.field}>
            <label htmlFor={snapId}>Grid</label>
            <select id={snapId} value={p.snap} onChange={(e) => studio.setSnap(Number(e.target.value) as Snap)}>
              {SNAPS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className={v.field}>
            <label htmlFor={swingId}>Swing {p.swing}%</label>
            <input id={swingId} type="range" min={50} max={75} value={p.swing} onChange={(e) => studio.setSwing(Number(e.target.value))} onPointerUp={() => studio.endGesture()} />
          </div>
          <div className={v.field}>
            <label htmlFor={levelId}>Level</label>
            <input id={levelId} type="range" min={0} max={1} step={0.01} value={p.level} onChange={(e) => studio.setLevel(Number(e.target.value))} onPointerUp={() => studio.endGesture()} />
          </div>
        </div>

        <div className={v.edits}>
          <button type="button" className={v.btn} disabled={!st.canUndo} onClick={() => studio.undo()} aria-label="Undo" title="Undo (Cmd/Ctrl+Z)">
            <UndoIcon />
          </button>
          <button type="button" className={v.btn} disabled={!st.canRedo} onClick={() => studio.redo()} aria-label="Redo" title="Redo (Shift+Cmd/Ctrl+Z)">
            <UndoIcon flip />
          </button>
          <details className={v.menu}>
            <summary className={`${v.btn} ${v.primary}`}>
              Export <Caret />
            </summary>
            <div className={`${v.menuPanel} ${v.right}`}>
              <button type="button" className={v.menuItem} disabled={!!st.busy || !p.clips.length} onClick={(e) => (void studio.exportWav('song'), closeMenu(e))}>
                Save the song as WAV<span className={v.dim}>24-bit, the whole arrangement</span>
              </button>
              <button type="button" className={v.menuItem} disabled={!!st.busy || !p.clips.length} onClick={(e) => (void studio.exportWav('loop'), closeMenu(e))}>
                Save the loop as WAV<span className={v.dim}>Cut to loop seamlessly</span>
              </button>
              <hr className={v.rule} />
              <button type="button" className={v.menuItem} disabled={!!st.busy || !p.clips.length} onClick={(e) => (void studio.sendToCrate('song'), closeMenu(e))}>
                Send the song to the crate<span className={v.dim}>Then load it on a deck</span>
              </button>
              <button type="button" className={v.menuItem} disabled={!!st.busy || !p.clips.length} onClick={(e) => (void studio.sendToCrate('loop'), closeMenu(e))}>
                Send the loop to the crate<span className={v.dim}>A seamless loop for a deck</span>
              </button>
            </div>
          </details>
        </div>
      </header>

      <div className={v.body} data-slicer-body style={{ gridTemplateRows: `${split}fr 8px ${1 - split}fr` }}>
        <div className={v.pane}>
          <SliceWorkspace studio={studio} session={session} loop={loop} />
        </div>
        <div
          className={v.divider}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the editor and the timeline"
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={Math.round(split * 100)}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') setSplit((x) => Math.max(0.25, x - 0.05));
            if (e.key === 'ArrowDown') setSplit((x) => Math.min(0.75, x + 0.05));
          }}
        />
        <div className={v.pane}>
          <Arranger studio={studio} session={session} loop={loop} />
        </div>
      </div>

      <footer className={v.status} role="status">
        {st.busy ? <span className={v.busy}>{st.busy}</span> : st.note ? <span>{st.note}</span> : <span className={v.dim}>{hint(st.playing)}</span>}
      </footer>
    </section>
  );
}

function hint(playing: boolean) {
  return playing
    ? 'Space stops · Cmd/Ctrl+E splits at the playhead · Cmd/Ctrl+L loops the selection'
    : 'Click a slice to hear it, drag it to a lane · keys 1–0 and Q–P play slices · Space plays the song';
}

function closeMenu(e: React.MouseEvent) {
  (e.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
}

const BackIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
    <path d="M12 4l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Caret = () => (
  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
    <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const PlayIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path d="M6 4l10 6-10 6z" fill="currentColor" />
  </svg>
);
const StopIcon = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" />
  </svg>
);
const LoopIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
    <path d="M4 9a4 4 0 0 1 4-4h7m-2-2l2 2-2 2M16 11a4 4 0 0 1-4 4H5m2 2l-2-2 2-2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ClickIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
    <path d="M7 17h6l-1.5-12h-3zM10 9l4-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const UndoIcon = ({ flip }: { flip?: boolean }) => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
    <path d="M7 5L3 9l4 4M3 9h9a5 5 0 0 1 0 10h-2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
