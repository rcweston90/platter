import { useEffect, useRef, useState } from 'react';
import { BANK_NAMES, BANKS, CHOKE_GROUPS, PADS_PER_BANK } from '../../engine/sampler';
import type { DjSession } from '../../engine/session';
import { CATEGORY_LABEL, LIBRARY } from '../../engine/sounds/catalog';
import { ROLE_LABEL } from '../../engine/sounds/characters';
import { getKit, KITS } from '../../engine/sounds/kits';
import { useStore } from '../../engine/store';
import { useDropTarget } from '../frame';
import { Knob } from '../Knob';
import { openSounds } from './sounds';
import s from './beats.module.css';

const PAD_DRAG = 'application/x-platter-pad';

/** Flashes pads as they sound: now for a hand, on the beat for the board. */
function usePadFlash(session: DjSession, els: React.RefObject<(HTMLElement | null)[]>) {
  useEffect(
    () =>
      session.sampler.onHit((h) => {
        const el = els.current?.[h.pad];
        const engine = session.engine;
        if (!el || !engine || typeof el.animate !== 'function') return;
        const delay = Math.max(0, (h.when - engine.now()) * 1000);
        el.animate(
          [
            { boxShadow: `0 0 0 2px var(--pad-hue), 0 0 ${18 + 14 * h.velocity}px var(--pad-hue)`, filter: 'brightness(1.6)' },
            { boxShadow: '0 0 0 0 transparent', filter: 'brightness(1)' },
          ],
          { duration: 260, delay, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
        );
      }),
    [session, els],
  );
}

function Pad({ session, i, els }: { session: DjSession; i: number; els: React.RefObject<(HTMLElement | null)[]> }) {
  const { pads, selected, loading } = useStore(session.sampler.store);
  const pad = pads[i];
  const info = session.sampler.padSound(i);
  const ref = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  useDropTarget(
    ref,
    (types) => types.includes('Files') || types.includes(PAD_DRAG),
    setOver,
    (data) => {
      const from = data.getData(PAD_DRAG);
      if (from !== '') return session.sampler.movePad(Number(from), i);
      const f = data.files[0];
      if (f) void session.sampler.setCustom(i, f);
    },
  );
  const local = i % PADS_PER_BANK;
  const name = info?.name ?? 'Empty';
  const short = info?.kit && pad.role ? ROLE_LABEL[pad.role] : name;
  return (
    <button
      ref={(el) => {
        ref.current = el;
        if (els.current) els.current[i] = el;
      }}
      type="button"
      className={s.pad}
      data-cat={info?.category ?? 'none'}
      data-selected={selected === i}
      data-over={over}
      data-empty={!info}
      data-loading={!!pad.sound && loading.includes(pad.sound)}
      draggable={!!info}
      onDragStart={(e) => {
        e.dataTransfer.setData(PAD_DRAG, String(i));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        session.sampler.select(i);
        void session.hitPad(i);
      }}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          session.sampler.select(i);
          void session.hitPad(i);
        }
      }}
      aria-label={`Sampler pad ${local + 1}: ${name}`}
      title={info ? `${name}. Drag onto another pad to swap, or drop an audio file here.` : 'Drop an audio file here, or pick a sound in Sounds.'}
    >
      <span className={s.padTop}>
        <span className={s.padNum}>{local + 1}</span>
        {info?.key && <span className={s.padKey}>{info.key}</span>}
      </span>
      <span className={s.padName}>{short}</span>
      <span className={s.padCat}>{info ? CATEGORY_LABEL[info.category] : ' '}</span>
    </button>
  );
}

function Inspector({ session }: { session: DjSession }) {
  const { pads, selected } = useStore(session.sampler.store);
  const pad = pads[selected];
  const info = session.sampler.padSound(selected);
  const label = `${BANK_NAMES[Math.floor(selected / PADS_PER_BANK)]}${(selected % PADS_PER_BANK) + 1}`;
  return (
    <section className={s.inspector} aria-label={`Pad ${label}`} data-cat={info?.category ?? 'none'}>
      <div className={s.inspHead}>
        <span className={s.inspPad}>{label}</span>
        <div className={s.inspText}>
          <strong className={s.inspName}>{info?.name ?? 'Empty pad'}</strong>
          <span className={s.inspMeta}>
            {info ? `${CATEGORY_LABEL[info.category]}${info.key ? ` · ${info.key}` : ''}${info.credit ? ` · by ${info.credit}` : ''}` : 'Pick a sound for it'}
          </span>
        </div>
      </div>
      <div className={s.inspKnobs}>
        <Knob
          label="Vol"
          name={`Pad ${label} volume`}
          value={pad.gain}
          min={0}
          max={1.5}
          defaultValue={1}
          size="sm"
          format={(v) => (v === 0 ? 'off' : `${(20 * Math.log10(v)).toFixed(1)} dB`)}
          onChange={(v) => session.sampler.setPad(selected, { gain: v })}
        />
        <Knob
          label="Tune"
          name={`Pad ${label} tune`}
          value={pad.tune}
          min={-24}
          max={24}
          defaultValue={0}
          bipolar
          size="sm"
          format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)} st`}
          onChange={(v) => session.sampler.setPad(selected, { tune: Math.round(v) })}
        />
        <label className={s.choke}>
          <span>Choke</span>
          <select value={pad.choke} onChange={(e) => session.sampler.setPad(selected, { choke: Number(e.target.value) })} aria-label={`Pad ${label} choke group`}>
            <option value={0}>Off</option>
            {Array.from({ length: CHOKE_GROUPS }, (_, g) => (
              <option key={g} value={g + 1}>
                Group {g + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={s.inspActions}>
        <button type="button" className={s.chip} data-primary onClick={() => openSounds('sounds')}>
          Change sound
        </button>
        <button type="button" className={s.chip} disabled={!info} onClick={() => session.sampler.clearPad(selected)}>
          Clear
        </button>
      </div>
    </section>
  );
}

/** Sixteen pads a bank, four banks, a kit picker and the selected pad's settings. */
export function Pads({ session }: { session: DjSession }) {
  const { bank, bankKits, level } = useStore(session.sampler.store);
  const els = useRef<(HTMLElement | null)[]>([]);
  usePadFlash(session, els);
  const kit = bankKits[bank] ? getKit(bankKits[bank]!) : undefined;
  return (
    <div className={s.padsCol}>
      <div className={s.padsBar}>
        <div className={s.banks} role="group" aria-label="Pad bank">
          {Array.from({ length: BANKS }, (_, b) => (
            <button key={b} type="button" className={s.bank} aria-pressed={bank === b} onClick={() => session.sampler.setBank(b)} aria-label={`Bank ${BANK_NAMES[b]}`}>
              {BANK_NAMES[b]}
            </button>
          ))}
        </div>
        <label className={s.kitPick}>
          <span className={s.srOnly}>Kit on bank {BANK_NAMES[bank]}</span>
          <select
            value={kit?.id ?? ''}
            onChange={(e) => e.target.value && session.sampler.loadKit(bank, e.target.value)}
            aria-label={`Kit on bank ${BANK_NAMES[bank]}`}
          >
            {!kit && <option value="">Custom kit</option>}
            {KITS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={s.chip} data-primary onClick={() => openSounds('sounds')}>
          Sounds <span className={s.count}>{LIBRARY.length}</span>
        </button>
        <Knob
          label="Level"
          name="Sampler level"
          value={level}
          min={0}
          max={1}
          defaultValue={0.8}
          size="sm"
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => session.sampler.setLevel(v)}
        />
      </div>
      <div className={s.padGrid}>
        {Array.from({ length: PADS_PER_BANK }, (_, j) => (
          <Pad key={bank * PADS_PER_BANK + j} session={session} i={bank * PADS_PER_BANK + j} els={els} />
        ))}
      </div>
      <Inspector session={session} />
    </div>
  );
}
