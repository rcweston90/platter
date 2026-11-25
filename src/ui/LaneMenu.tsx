import { useEffect, useId, useRef, useState } from 'react';
import { STEM_LABELS, type StemName } from '../engine/stems';
import { useStore } from '../engine/store';
import { PitchIcon } from './icons';
import { LANE_MODE_HINTS, LANE_MODE_LABELS, LANE_MODES, laneView, setLaneMode, toggleShown } from './laneView';
import s from '../platter.module.css';

/** Top to bottom, as the lanes stack. */
const PARTS: StemName[] = ['vocals', 'other', 'bass', 'drums'];

/**
 * The beat pitch button by the zoom: opens a small panel to pick the view
 * (off, the mix, a lane per part, paired, all in one), which parts to draw,
 * and whether a part you mute fades with it.
 */
export function LaneMenu() {
  const view = useStore(laneView);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const stemViews = view.mode !== 'off' && view.mode !== 'mix';
  return (
    <div className={s.laneMenuWrap} ref={wrap}>
      <button
        ref={button}
        type="button"
        className={`${s.mini} ${s.pitchToggle}`}
        data-on={view.mode !== 'off' || undefined}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label="Beat pitch lanes"
        title="Beat pitch lanes"
        onClick={() => setOpen((o) => !o)}
      >
        <PitchIcon />
      </button>
      {open && (
        <div className={s.laneMenu} id={id} role="dialog" aria-label="Beat pitch lanes">
          <p className={s.laneMenuHead}>Beat pitch</p>
          <div className={s.laneModes} role="radiogroup" aria-label="View">
            {LANE_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={view.mode === m}
                className={s.laneMode}
                title={LANE_MODE_HINTS[m]}
                onClick={() => setLaneMode(m)}
              >
                {LANE_MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <p className={s.laneMenuHint}>{LANE_MODE_HINTS[view.mode]}. Stem views show once a track’s stems are in.</p>
          <div className={s.laneParts} role="group" aria-label="Parts to draw">
            {PARTS.map((p) => (
              <button
                key={p}
                type="button"
                className={s.lanePart}
                data-stem={p}
                aria-pressed={view.show[p]}
                disabled={!stemViews}
                onClick={() => toggleShown(p)}
              >
                {STEM_LABELS[p]}
              </button>
            ))}
          </div>
          <label className={s.laneFollow}>
            <input type="checkbox" checked={view.follow} disabled={!stemViews} onChange={(e) => laneView.set({ follow: e.target.checked })} />
            Fade the parts you mute
          </label>
        </div>
      )}
    </div>
  );
}
