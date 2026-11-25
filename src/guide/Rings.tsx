import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../engine/store';
import { controlById } from './registry';
import { rings } from './rings';
import g from './guide.module.css';

/**
 * Draws the rings: one outline per ringed control, placed over the control's
 * box every animation frame and tagged with its name or moving value. Fixed
 * to the window and outside the rig, so it never shifts the layout and never
 * takes a click (pointer-events: none).
 */
export function Rings() {
  const { list } = useStore(rings);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!list.length) return;
    let raf = 0;
    const frame = () => {
      const now = performance.now();
      const gone = list.filter((r) => r.until !== undefined && r.until < now);
      if (gone.length) {
        const ids = new Set(gone.map((r) => r.id));
        rings.set({ list: rings.get().list.filter((r) => !(ids.has(r.id) && r.until !== undefined && r.until < now)) });
        return;
      }
      for (const r of list) {
        const el = box.current?.querySelector<HTMLElement>(`[data-ring="${CSS.escape(r.id)}"]`);
        if (!el) continue;
        const target = controlById(r.id)?.find();
        const rect = target?.getBoundingClientRect();
        // Not drawn over whatever covers the control (the pinned waveforms,
        // the library sheet) or for a control that's scrolled out of sight.
        const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!rect || !target || !hit || (rect.width === 0 && rect.height === 0) || !(target.contains(hit) || hit.contains(target))) {
          el.style.visibility = 'hidden';
          continue;
        }
        el.style.visibility = 'visible';
        const pad = 4;
        el.style.transform = `translate(${rect.left - pad}px, ${rect.top - pad}px)`;
        el.style.width = `${rect.width + pad * 2}px`;
        el.style.height = `${rect.height + pad * 2}px`;
        const tag = el.firstElementChild as HTMLElement | null;
        const text = r.text?.() ?? controlById(r.id)?.name ?? r.id;
        if (tag && tag.textContent !== text) tag.textContent = text;
        // Tags of rings near the top of the window go underneath.
        if (rect.top < 34) el.dataset.below = '';
        else delete el.dataset.below;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [list]);

  return createPortal(
    <div ref={box} className={g.rings} aria-hidden="true">
      {list.map((r) => (
        <div key={r.id} className={g.ring} data-ring={r.id} data-tone={r.tone}>
          <span className={g.ringTag} />
        </div>
      ))}
    </div>,
    document.body,
  );
}
