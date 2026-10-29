import { describeKey, MIDI_ACTIONS } from '../engine/midi';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import s from '../platter.module.css';

const GROUPS = [...new Set(MIDI_ACTIONS.map((a) => a.group))];

/** MIDI learn: connect a controller, then teach each action a control. */
export function MidiPanel({ session }: { session: DjSession }) {
  const m = useStore(session.midi.store);
  const { midi } = session;
  return (
    <div className={s.midiPanel}>
      {!m.supported ? (
        <p className={s.popNote}>This browser has no Web MIDI. Use Chrome, Edge or Firefox for a controller.</p>
      ) : !m.connected ? (
        <>
          <button type="button" className={s.action} onClick={() => void midi.connect()}>
            Connect MIDI
          </button>
          <p className={s.popNote}>
            Any class-compliant controller works. After connecting, press Learn next to an action and move the knob,
            fader or button you want for it. Mappings are saved in this browser and included in backups.
          </p>
        </>
      ) : (
        <p className={s.popNote}>{m.inputs.length ? `Connected: ${m.inputs.join(', ')}` : 'Connected — no controller found yet. Plug one in.'}</p>
      )}
      {m.error && (
        <p className={s.popNote} role="status">
          {m.error}
        </p>
      )}
      {m.learning && (
        <p className={s.learning} role="status">
          Move a control on your controller for “{MIDI_ACTIONS.find((a) => a.id === m.learning)?.label}”…
        </p>
      )}
      <div className={s.midiList}>
        {GROUPS.map((g) => (
          <div key={g} role="group" aria-label={g}>
            <h3 className={s.midiGroup}>{g}</h3>
            {MIDI_ACTIONS.filter((a) => a.group === g).map((a) => {
              const key = m.bindings[a.id];
              const learning = m.learning === a.id;
              return (
                <div key={a.id} className={s.midiRow}>
                  <span className={s.midiLabel}>{a.label}</span>
                  <span className={s.midiKey}>{key ? describeKey(key) : '—'}</span>
                  <button
                    type="button"
                    className={s.mini}
                    aria-pressed={learning}
                    disabled={!m.connected}
                    onClick={() => midi.learn(learning ? null : a.id)}
                    aria-label={learning ? `Stop learning ${a.label}` : `Learn ${g} ${a.label}`}
                  >
                    {learning ? 'Cancel' : 'Learn'}
                  </button>
                  <button type="button" className={s.mini} disabled={!key} onClick={() => midi.clear(a.id)} aria-label={`Clear ${g} ${a.label}`}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {Object.keys(m.bindings).length > 0 && (
        <button type="button" className={s.action} onClick={() => midi.clearAll()}>
          Clear all mappings
        </button>
      )}
    </div>
  );
}
