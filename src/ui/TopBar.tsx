import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { DjEngine } from '../engine/engine';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { useFrame, type FrameLoop } from './frame';
import { MidiPanel } from './MidiPanel';
import { saveFile } from './save';
import { formatTime } from './Waveforms';
import s from '../platter.module.css';

export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Q · P', action: 'Cue (hold to preview)' },
  { keys: 'W · O', action: 'Play / pause' },
  { keys: 'E · I', action: 'Sync' },
  { keys: 'A S · K L', action: 'Bend slower / faster (hold)' },
  { keys: 'D · J', action: 'Loop on / off' },
  { keys: 'Z X · N M', action: 'Beat jump back / forward' },
  { keys: '1–4 · 7–0', action: 'Hot cues (Shift to clear)' },
  { keys: 'F · H', action: 'Beat FX on / off' },
  { keys: 'C · ,', action: 'Censor (hold)' },
  { keys: 'V · .', action: 'Slip on / off' },
  { keys: '[ ]', action: 'Crossfader left / right (Shift: all the way)' },
  { keys: '\\', action: 'Crossfader to centre' },
];

const noSubscribe = () => () => {};
/** Browser capability, read once per render without subscribing. */
const useCapability = (check: () => boolean) => useSyncExternalStore(noSubscribe, check, () => false);

export function TopBar({ session, loop }: { session: DjSession; loop: FrameLoop }) {
  const m = useStore(session.mixer);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const clock = useRef<HTMLSpanElement>(null);
  const masterId = useId();
  const cueId = useId();

  useFrame(loop, () => {
    const st = session.mixer.get();
    if (clock.current) clock.current.textContent = st.recording ? formatTime((performance.now() - st.recordStarted) / 1000) : '';
  });

  const cueValue = m.cueRouting.kind === 'device' ? `device:${m.cueRouting.deviceId}` : m.cueRouting.kind;
  const canMaster = useCapability(DjEngine.canPickMasterDevice);
  const canCueDevice = useCapability(DjEngine.canPickCueDevice);

  return (
    <header className={s.topBar}>
      <div className={s.brand}>
        <h1 className={s.title}>Platter</h1>
        <span className={s.status} role="status">
          {m.audio === 'idle' && 'Two demo tracks are cued. Press play on either deck.'}
          {m.audio === 'starting' && 'Starting audio…'}
          {m.audio === 'running' && 'Audio running'}
          {m.audio === 'error' && (m.audioError ?? 'Audio could not start')}
          {m.audio !== 'error' && m.audioError ? ` · ${m.audioError}` : ''}
          {saveNote ? ` · ${saveNote}` : ''}
        </span>
      </div>

      <div className={s.topActions}>
        <button
          type="button"
          className={`${s.toggle} ${s.recBtn}`}
          aria-pressed={m.recording}
          onClick={() => void session.toggleRecording()}
          aria-label={m.recording ? 'Stop recording the mix' : 'Record the mix'}
        >
          <span className={s.recDot} aria-hidden="true" /> Rec <span ref={clock} className={s.recClock} />
        </button>
        {m.lastRecording && !m.recording && (
          <button
            type="button"
            className={s.action}
            onClick={() => {
              const rec = m.lastRecording!;
              setSaveNote(null);
              void saveFile(rec.name, rec.blob, rec.url).then(setSaveNote);
            }}
          >
            Save mix
          </button>
        )}

        <details className={s.popover}>
          <summary className={s.action}>Outputs</summary>
          <div className={s.popPanel}>
            {canMaster && (
              <div className={s.field}>
                <label htmlFor={masterId}>Master out</label>
                <select
                  id={masterId}
                  value={m.masterDevice}
                  onChange={(e) => void session.setMasterDevice(e.target.value)}
                >
                  <option value="">System default</option>
                  {m.devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className={s.field}>
              <label htmlFor={cueId}>Headphones (cue)</label>
              <select
                id={cueId}
                value={cueValue}
                onChange={(e) => {
                  const v = e.target.value;
                  void session.setCueRouting(
                    v === 'off' || v === 'split' ? { kind: v } : { kind: 'device', deviceId: v.slice('device:'.length) },
                  );
                }}
              >
                <option value="off">Off</option>
                <option value="split">Split: master left, cue right</option>
                {canCueDevice &&
                  m.devices.map((d) => (
                    <option key={d.deviceId} value={`device:${d.deviceId}`}>
                      {d.label}
                    </option>
                  ))}
              </select>
            </div>
            <button type="button" className={s.action} onClick={() => void session.refreshDevices(true)}>
              Find audio devices
            </button>
            <p className={s.popNote}>
              With one output, use Split and a stereo-to-dual-mono splitter cable. With a second interface, pick it for
              the headphones. Browsers only name outputs after a microphone permission — it is released straight away
              and nothing is recorded.
            </p>
          </div>
        </details>

        <details className={s.popover}>
          <summary className={s.action}>MIDI</summary>
          <div className={`${s.popPanel} ${s.popWide}`}>
            <MidiPanel session={session} />
          </div>
        </details>

        <details className={s.popover}>
          <summary className={s.action}>Keys</summary>
          <div className={s.popPanel}>
            <p className={s.popNote}>Deck A · Deck B</p>
            <dl className={s.keys}>
              {SHORTCUTS.map((k) => (
                <div key={k.keys} className={s.keyRow}>
                  <dt>
                    <kbd>{k.keys}</kbd>
                  </dt>
                  <dd>{k.action}</dd>
                </div>
              ))}
            </dl>
            <p className={s.popNote}>
              Focused knobs and sliders take the arrow keys; double-click resets them. Drag a record to scratch.
            </p>
          </div>
        </details>
      </div>
    </header>
  );
}
