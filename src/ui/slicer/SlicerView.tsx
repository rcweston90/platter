import { useEffect, useId, useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import { MAX_BPM, MIN_BPM, SNAPS } from '../../slicer/model';
import type { Studio, StudioState } from '../../slicer/studio';
import type { Snap } from '../../slicer/types';
import { useFrame, type FrameLoop } from '../frame';
import { Arranger } from './Arranger';
import { SliceWorkspace } from './SliceWorkspace';
import { useIsPhone } from './usePhone';
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
      if (e.shiftKey && !mod && !e.altKey && e.code === 'KeyR') return run(() => studio.setRecording(!studio.store.get().recording));
      if (e.key === '?' && !mod) return run(() => setKeysOpen((o) => !o));
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

  const phone = useIsPhone();
  const [area, setArea] = useState<'chop' | 'arrange'>('chop');
  const [keysOpen, setKeysOpen] = useState(false);
  const src = st.project.sources.find((s) => s.id === st.sourceId);

  const exportItems = (
    <>
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
      {!p.clips.length && <p className={v.menuNote}>Put some slices on the timeline first.</p>}
    </>
  );

  const songSummary = `${fmtBpm(p.bpm)} BPM · ${SNAPS.find((s) => s.value === p.snap)?.label ?? 'Off'}`;
  const songFields = (
    <>
        <div className={v.field}>
        <label htmlFor={bpmId}>Tempo (BPM)</label>
        <input
          id={bpmId}
          type="number"
          inputMode="decimal"
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
    </>
  );

  const song = (
    <details className={v.menu}>
      <summary className={v.btn} title="Song tempo, grid, swing and level">
        <span className={v.songSum}>{songSummary}</span> <Caret />
      </summary>
      <div className={`${v.menuPanel} ${v.songPanel}`}>{songFields}</div>
    </details>
  );

  const phoneMenu = (
    <details className={v.menu}>
      <summary className={`${v.btn} ${v.icon}`} aria-label="Song settings and export" title="Song settings and export">
        <MoreIcon />
      </summary>
      <div className={`${v.menuPanel} ${v.songPanel}`}>
        <div className={v.menuRow}>
          <span className={v.songSum}>{songSummary}</span>
        </div>
        {songFields}
        <div className={v.menuRow}>
          <button type="button" className={v.btn} aria-pressed={p.loop.on} onClick={() => studio.setLoop({ on: !p.loop.on })}>
            <LoopIcon /> Loop
          </button>
          <button type="button" className={v.btn} aria-pressed={st.metronome} onClick={() => studio.setMetronome(!st.metronome)}>
            <ClickIcon /> Click
          </button>
        </div>
        <hr className={v.rule} />
        {exportItems}
      </div>
    </details>
  );

  const projects = (
    <details className={v.menu}>
      <summary className={`${v.btn} ${v.ghost}`} aria-label="Projects" title="Projects">
        {phone ? <Caret /> : <>Projects <Caret /></>}
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
              <button type="button" className={v.projectItem} aria-current={m.id === p.id || undefined} onClick={(e) => (void studio.openProject(m.id), closeMenu(e))}>
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
  );

  const exportMenu = (
    <details className={v.menu}>
      <summary className={`${v.btn} ${v.primary}`}>
        Export <Caret />
      </summary>
      <div className={`${v.menuPanel} ${v.right}`}>{exportItems}</div>
    </details>
  );

  const rec = (
    <button
      type="button"
      className={`${v.rec} ${st.recording ? v.recOn : ''}`}
      aria-pressed={st.recording}
      onClick={() => studio.setRecording(!st.recording)}
      aria-label={st.recording ? 'Stop recording (Shift+R)' : 'Record pads into the timeline (Shift+R)'}
      title={st.recording ? 'Stop recording (Shift+R)' : 'Record: play the pads and they land on the timeline (Shift+R)'}
    >
      <RecIcon />
      {!phone && <span>Rec</span>}
    </button>
  );

  const undoRedo = (
    <>
      <button type="button" className={`${v.btn} ${v.icon}`} disabled={!st.canUndo} onClick={() => studio.undo()} aria-label="Undo" title="Undo (Cmd/Ctrl+Z)">
        <UndoIcon />
      </button>
      <button type="button" className={`${v.btn} ${v.icon}`} disabled={!st.canRedo} onClick={() => studio.redo()} aria-label="Redo" title="Redo (Shift+Cmd/Ctrl+Z)">
        <UndoIcon flip />
      </button>
    </>
  );

  // On a phone a note shows as a toast over the tab bar: let it go after a moment.
  useEffect(() => {
    if (!phone || !st.note) return;
    const t = window.setTimeout(() => studio.clearNote(), 3500);
    return () => window.clearTimeout(t);
  }, [phone, st.note, studio]);

  const message = st.busy ? <span className={v.busy}>{st.busy}</span> : st.note ? <span>{st.note}</span> : null;

  return (
    <section ref={root} className={`${v.view} ${phone ? v.phone : ''}`} aria-label="Slicer" tabIndex={-1} data-slicer data-layout={phone ? 'phone' : 'desk'}>
      <header className={v.bar}>
        <button type="button" className={v.back} onClick={() => studio.close()} title="Back to the decks (Esc)" aria-label="Back to the decks">
          <BackIcon /> {!phone && 'Decks'}
        </button>
        <div className={v.project}>
          <label htmlFor={nameId} className={v.srOnly}>
            Project name
          </label>
          <input id={nameId} className={v.name} value={p.name} onChange={(e) => studio.rename(e.target.value)} onBlur={() => studio.endGesture()} spellCheck={false} />
          {projects}
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
          {rec}
          <span ref={pos} className={v.counter} aria-label="Position (bar, beat, sixteenth)">
            1.1.1
          </span>
          {!phone && (
            <>
              <button type="button" className={v.btn} aria-pressed={p.loop.on} onClick={() => studio.setLoop({ on: !p.loop.on })} title="Loop the bracketed bars (Cmd/Ctrl+L loops the selection)">
                <LoopIcon /> Loop
              </button>
              <button type="button" className={v.btn} aria-pressed={st.metronome} onClick={() => studio.setMetronome(!st.metronome)} title="Metronome click">
                <ClickIcon /> Click
              </button>
            </>
          )}
          {!phone && song}
        </div>
        <div className={v.edits}>
          {!phone && undoRedo}
          {!phone && (
            <button type="button" className={`${v.btn} ${v.icon}`} onClick={() => setKeysOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
              ?
            </button>
          )}
          {phone ? phoneMenu : exportMenu}
        </div>
      </header>
      {phone ? (
        <div className={v.body} data-slicer-body>
          <div className={v.pane} data-area={area}>
            {area === 'chop' ? <SliceWorkspace studio={studio} session={session} loop={loop} /> : <Arranger studio={studio} session={session} loop={loop} />}
          </div>
        </div>
      ) : (
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
      )}
      {phone ? (
        <footer className={v.tabbar}>
          {message && (
            <div className={v.toast} role="status">
              {message}
            </div>
          )}
          <button type="button" className={`${v.btn} ${v.icon}`} disabled={!st.canUndo} onClick={() => studio.undo()} aria-label="Undo">
            <UndoIcon />
          </button>
          <div className={v.tabs} role="tablist" aria-label="Slicer area">
            <button type="button" role="tab" aria-selected={area === 'chop'} className={v.tab} onClick={() => setArea('chop')}>
              <ChopIcon /> Chop
              {src && src.slices.length > 1 && <span className={v.badge}>{src.slices.length}</span>}
            </button>
            <button type="button" role="tab" aria-selected={area === 'arrange'} className={v.tab} onClick={() => setArea('arrange')}>
              <ArrangeIcon /> Arrange
              {p.clips.length > 0 && <span className={v.badge}>{p.clips.length}</span>}
            </button>
          </div>
          <button type="button" className={`${v.btn} ${v.icon}`} disabled={!st.canRedo} onClick={() => studio.redo()} aria-label="Redo">
            <UndoIcon flip />
          </button>
        </footer>
      ) : (
        <footer className={v.status} role="status">
          {message ?? <span className={v.dim}>{hint(st)}</span>}
        </footer>
      )}
      {keysOpen && <Shortcuts onClose={() => setKeysOpen(false)} />}
    </section>
  );
}

function fmtBpm(bpm: number) {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1);
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play or stop the song'],
  ['1 2 3 4 · Q W E R · A S D F · Z X C V', 'Play the pads (they mirror the 4×4 grid)'],
  ['← →', 'Pick the previous or next slice'],
  ['Enter', 'Put the picked slice at the end of the timeline'],
  ['/', 'Cut where the sample is sounding'],
  ['Shift+R', 'Record: pads you play land on the timeline'],
  ['Cmd/Ctrl+Z · Shift+Cmd/Ctrl+Z', 'Undo · redo'],
  ['Cmd/Ctrl+D', 'Duplicate the selected clips'],
  ['Cmd/Ctrl+E', 'Split clips at the playhead'],
  ['Cmd/Ctrl+L', 'Loop the selection'],
  ['Cmd/Ctrl+U', 'Snap the selected clips to the grid'],
  ['Delete', 'Delete the selected clips'],
  ['Home', 'Back to the start'],
  ['Esc', 'Stop the sound, clear the selection, then close'],
  ['?', 'This list'],
];

function Shortcuts({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
  }, []);
  return (
    <dialog ref={ref} className={v.keys} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label="Keyboard shortcuts">
      <div className={v.keysHead}>
        <h2>Keyboard shortcuts</h2>
        <button type="button" className={`${v.btn} ${v.icon}`} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <dl className={v.keyList}>
        {SHORTCUTS.map(([k, what]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}

function hint(st: StudioState) {
  if (st.recording) return 'Recording: play the pads and they land on the timeline · Space stops';
  if (st.playing) return 'Space stops · Shift+R records the pads · Cmd/Ctrl+E splits at the playhead';
  if (!st.project.sources.length) return 'Drop a FLAC or WAV, or pick a track from your crate · ? shows the shortcuts';
  return 'Play the pads with the keys · Shift+R records them into the song · ? shows the shortcuts';
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

const RecIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
    <circle cx="10" cy="10" r="6" fill="currentColor" />
  </svg>
);
const ChopIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <path d="M2 10h2l1.5-5 2 10 2-12 2 14 2-9 1.5 4H18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ArrangeIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <rect x="2" y="4" width="7" height="4" rx="1" fill="currentColor" />
    <rect x="10" y="4" width="8" height="4" rx="1" fill="currentColor" opacity=".55" />
    <rect x="5" y="12" width="9" height="4" rx="1" fill="currentColor" opacity=".8" />
  </svg>
);
const MoreIcon = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
    <circle cx="4.5" cy="10" r="1.7" fill="currentColor" />
    <circle cx="10" cy="10" r="1.7" fill="currentColor" />
    <circle cx="15.5" cy="10" r="1.7" fill="currentColor" />
  </svg>
);
