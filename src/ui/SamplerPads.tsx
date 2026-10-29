import { useRef, useState } from 'react';
import { PADS } from '../engine/sampler';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { useDropTarget } from './frame';
import { Knob } from './Knob';
import s from '../platter.module.css';

function Pad({ session, i, editing }: { session: DjSession; i: number; editing: boolean }) {
  const { pads } = useStore(session.sampler.store);
  const pad = pads[i];
  const ref = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  useDropTarget(
    ref,
    (types) => types.includes('Files'),
    setOver,
    (data) => {
      const f = data.files[0];
      if (f) void session.sampler.setCustom(i, f);
    },
  );
  return (
    <div className={s.padCell}>
      <button
        ref={ref}
        type="button"
        className={`${s.samplePad} ${over ? s.samplePadOver : ''}`}
        data-custom={pad.custom}
        onPointerDown={(e) => {
          if (e.button !== 0 || editing) return;
          void session.triggerPad(i);
        }}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && !editing) {
            e.preventDefault();
            void session.triggerPad(i);
          }
        }}
        onClick={() => editing && file.current?.click()}
        aria-label={editing ? `Choose a sound for pad ${i + 1}` : `Sampler pad ${i + 1}: ${pad.name}`}
        title={editing ? 'Choose an audio file for this pad' : 'Drop an audio file here to replace this sound'}
      >
        <span className={s.padNum}>{i + 1}</span>
        <span className={s.padName}>{pad.name}</span>
      </button>
      {editing && pad.custom && (
        <button type="button" className={s.padReset} onClick={() => void session.sampler.reset(i)} aria-label={`Reset pad ${i + 1} to its built-in sound`}>
          Reset
        </button>
      )}
      <input
        ref={file}
        type="file"
        accept="audio/*"
        hidden
        aria-label={`Sound file for pad ${i + 1}`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void session.sampler.setCustom(i, f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** The sampler, on the mixer: eight one-shot pads into the master. */
export function SamplerPads({ session }: { session: DjSession }) {
  const { level } = useStore(session.sampler.store);
  const [editing, setEditing] = useState(false);
  return (
    <section className={s.sampler} aria-label="Sampler">
      <div className={s.samplerHead}>
        <h2 className={s.samplerTitle}>Sampler</h2>
        <button type="button" className={s.mini} aria-pressed={editing} onClick={() => setEditing(!editing)}>
          {editing ? 'Done' : 'Edit'}
        </button>
        <Knob
          label="Level"
          name="Sampler level"
          value={level}
          min={0}
          max={1}
          defaultValue={0.7}
          size="sm"
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => session.sampler.setLevel(v)}
        />
      </div>
      <div className={s.padGrid}>
        {Array.from({ length: PADS }, (_, i) => (
          <Pad key={i} session={session} i={i} editing={editing} />
        ))}
      </div>
    </section>
  );
}
