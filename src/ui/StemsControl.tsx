import { useEffect, useRef, type PointerEvent } from 'react';
import { STEM_LABELS, STEMS, type DeckStems, type StemName } from '../engine/stems';
import { useStore } from '../engine/store';
import s from '../platter.module.css';
import t from './stems.module.css';

const PHASE: Record<string, string> = {
  download: 'Getting model',
  prepare: 'Preparing',
  separate: 'Splitting',
};

/** Peak (0–1) to meter fill (0–1): −48 dB to full scale. */
const fill = (peak: number) => (peak > 0 ? Math.max(0, Math.min(1, 1 + (20 * Math.log10(peak)) / 48)) : 0);
/** How fast a meter falls, in fills per second. */
const FALL = 1.5;

/** While stems are ready, drive each part's meter from what the deck plays. */
function useStemMeters(stems: DeckStems, on: boolean) {
  const bars = useRef<Partial<Record<StemName, HTMLSpanElement | null>>>({});
  useEffect(() => {
    if (!on) return;
    const shown: Record<StemName, number> = { vocals: 0, drums: 0, bass: 0, other: 0 };
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const lv = stems.levels();
      for (const stem of STEMS) {
        const v = Math.max(fill(lv[stem]), shown[stem] - FALL * dt);
        shown[stem] = v;
        const el = bars.current[stem];
        if (el) {
          el.style.transform = `scaleX(${v.toFixed(3)})`;
          el.dataset.level = v.toFixed(2);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    stems.levels(); // drop whatever piled up while hidden
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stems, on]);
  return bars;
}

/**
 * One deck's stems row: split the track, then tap a part to mute it, or
 * long-press (or Shift/Alt-click) to hear it alone.
 */
export function StemsControl({ stems, label }: { stems: DeckStems; label: string }) {
  const st = useStore(stems.store);
  const press = useRef<{ timer: number | null; long: boolean }>({ timer: null, long: false });
  const bars = useStemMeters(stems, st.status === 'ready');
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
      {st.status === 'ready' ? (
        <>
          <span className={`${s.keyLabel} ${t.ready}`} role="status">
            Stems ready
          </span>
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
              <span className={t.meter} aria-hidden="true">
                <span className={t.fill} data-level="0" ref={(el) => void (bars.current[stem] = el)} />
              </span>
            </button>
          ))}
          <button type="button" className={s.mini} onClick={() => stems.resetMix()} aria-label="Hear every part" title="Hear every part">
            All
          </button>
        </>
      ) : busy ? (
        <>
          <span className={s.keyLabel}>Stems</span>
          <span className={t.status} role="status">
            {st.saved && st.status === 'prepare' ? 'Loading saved stems' : `${PHASE[st.status]} ${Math.round(st.progress * 100)}%`}
          </span>
          <button type="button" className={s.mini} onClick={() => stems.cancel()}>
            Stop
          </button>
        </>
      ) : (
        <>
          <span className={s.keyLabel}>Stems</span>
          <button
            type="button"
            className={s.mini}
            onClick={() => void stems.split()}
            disabled={st.status === 'blocked'}
            title={st.status === 'blocked' ? st.message ?? undefined : st.saved ? 'Already split: loads the saved stems at once' : 'Split into vocals, drums, bass and other'}
          >
            {st.saved ? 'Split (saved)' : 'Split'}
          </button>
        </>
      )}
      {(st.status === 'blocked' || st.status === 'error') && st.message && <p className={t.note}>{st.message}</p>}
      {st.status === 'ready' && (
        <p className={t.note}>
          {st.seconds === null
            ? 'Loaded the stems saved next to your music.'
            : `Split in ${Math.round(st.seconds)} s on the ${st.backend === 'webgpu' ? 'GPU' : 'CPU'}.`}{' '}
          Each bar shows what that part is playing; a muted part’s bar drops to nothing.
        </p>
      )}
      {st.status === 'download' && <p className={t.note}>First time only: the separation model is about 170 MB.</p>}
    </div>
  );
}
