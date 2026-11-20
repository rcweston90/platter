import { useRef, type PointerEvent } from 'react';
import { STEM_LABELS, STEMS, type DeckStems, type StemName } from '../engine/stems';
import { useStore } from '../engine/store';
import s from '../platter.module.css';
import t from './stems.module.css';

const PHASE: Record<string, string> = {
  download: 'Getting model',
  prepare: 'Preparing',
  separate: 'Splitting',
};

/**
 * One deck's stems row: split the track, then tap a part to mute it, or
 * long-press (or Shift/Alt-click) to hear it alone.
 */
export function StemsControl({ stems, label }: { stems: DeckStems; label: string }) {
  const st = useStore(stems.store);
  const press = useRef<{ timer: number | null; long: boolean }>({ timer: null, long: false });
  if (st.status === 'none') return null;
  const busy = st.status === 'download' || st.status === 'prepare' || st.status === 'separate';

  const down = (stem: StemName) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const p = press.current;
    p.long = false;
    p.timer = window.setTimeout(() => {
      p.long = true;
      stems.soloStem(stem);
    }, 450);
  };
  const up = () => {
    const p = press.current;
    if (p.timer !== null) window.clearTimeout(p.timer);
    p.timer = null;
  };

  return (
    <div className={s.keyRow} role="group" aria-label={`Deck ${label} stems`}>
      <span className={s.keyLabel}>Stems</span>
      {st.status === 'ready' ? (
        <>
          {STEMS.map((stem) => (
            <button
              key={stem}
              type="button"
              className={`${s.mini} ${t.stem} ${st.solo === stem ? t.solo : ''}`}
              aria-pressed={stems.heard(stem)}
              title={`${STEM_LABELS[stem]}: tap to mute, hold or Shift-click to solo`}
              onPointerDown={down(stem)}
              onPointerUp={up}
              onPointerCancel={up}
              onClick={(e) => {
                if (press.current.long) return;
                if (e.shiftKey || e.altKey) stems.soloStem(stem);
                else stems.toggle(stem);
              }}
            >
              {STEM_LABELS[stem]}
            </button>
          ))}
          <button type="button" className={s.mini} onClick={() => stems.resetMix()} aria-label="Hear every part" title="Hear every part">
            All
          </button>
        </>
      ) : busy ? (
        <>
          <span className={t.status} role="status">
            {PHASE[st.status]} {Math.round(st.progress * 100)}%
          </span>
          <button type="button" className={s.mini} onClick={() => stems.cancel()}>
            Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          className={s.mini}
          onClick={() => void stems.split()}
          disabled={st.status === 'blocked'}
          title={st.status === 'blocked' ? st.message ?? undefined : 'Split into vocals, drums, bass and other'}
        >
          Split
        </button>
      )}
      {(st.status === 'blocked' || st.status === 'error') && st.message && <p className={t.note}>{st.message}</p>}
      {st.status === 'ready' && st.seconds !== null && (
        <p className={t.note}>
          Split in {Math.round(st.seconds)} s on the {st.backend === 'webgpu' ? 'GPU' : 'CPU'}. Held in memory for this deck only.
        </p>
      )}
      {st.status === 'download' && <p className={t.note}>First time only: the separation model is about 170 MB.</p>}
    </div>
  );
}
