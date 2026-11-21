import { useEffect, useRef } from 'react';
import { peaksColumns } from '../../slicer/dsp';
import { sliceRange } from '../../slicer/model';
import type { Audition, Studio } from '../../slicer/studio';
import { SLICE_COLORS, type Peaks, type Source } from '../../slicer/types';
import { fitCanvas, useFrame, type FrameLoop } from '../frame';
import { setSliceDrag } from './dnd';
import w from './workspace.module.css';

/** Keys that play slices 1–20, MPC style: the number row, then Q–P. */
export const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];

interface Props {
  studio: Studio;
  source: Source;
  peaks: Peaks | undefined;
  slice: number | null;
  audition: Audition | null;
  loop: FrameLoop;
}

/** The slices as pads: click or key to play, drag onto a lane to place. */
export function SlicePads({ studio, source, peaks, slice, audition, loop }: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const n = source.slices.length;
  const hex = SLICE_COLORS[source.color % SLICE_COLORS.length];

  // Which pad is sounding: the audition covers exactly that slice's range.
  const lit =
    audition && audition.sourceId === source.id
      ? source.slices.findIndex((_, i) => {
          const [a, b] = sliceRange(source, i);
          return Math.abs(a - audition.start) < 0.005 && Math.abs(b - audition.end) < 0.005;
        })
      : -1;

  // Thumbnails: redrawn when the slices or the audio change, never per frame.
  useEffect(() => {
    const root = grid.current;
    if (!root) return;
    root.querySelectorAll<HTMLCanvasElement>('canvas[data-pad]').forEach((c) => {
      const i = Number(c.dataset.pad);
      const { w: cw, h: ch, dpr } = fitCanvas(c);
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cw, ch);
      if (!peaks || cw < 2) return;
      const [a, b] = sliceRange(source, i);
      const cols = Math.max(1, Math.floor(cw));
      const { min, max } = peaksColumns(peaks, a, b, cols);
      let peak = 0.001;
      for (let k = 0; k < cols; k++) peak = Math.max(peak, max[k], -min[k]);
      const mid = ch / 2;
      const scale = (ch / 2 - 1) / peak;
      g.fillStyle = hex;
      g.beginPath();
      for (let x = 0; x < cols; x++) {
        const top = Math.max(0.5, max[x] * scale);
        const bot = Math.max(0.5, -min[x] * scale);
        g.rect(x, mid - top, 1, top + bot);
      }
      g.fill();
    });
  }, [source, peaks, hex, n]);

  // The sounding pad's progress bar, moved by the frame loop (no re-render).
  useFrame(loop, () => {
    const root = grid.current;
    if (!root) return;
    const bar = root.querySelector<HTMLElement>('[data-prog="on"]');
    if (!bar) return;
    const a = studio.auditionPosition();
    const au = studio.store.get().audition;
    if (!a || !au) return;
    const len = au.end - au.start || 1;
    const f = Math.min(1, Math.max(0, (a.time - au.start) / len));
    bar.style.transform = `scaleX(${f})`;
  });

  // Keep the selected pad in view.
  useEffect(() => {
    if (slice === null) return;
    grid.current?.querySelector<HTMLElement>(`[data-pad-btn="${slice}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [slice]);

  return (
    <div className={w.pads} ref={grid} role="group" aria-label={`Slice pads for ${source.name}`} style={{ '--src': hex } as React.CSSProperties}>
      {source.slices.map((_, i) => {
        const [a, b] = sliceRange(source, i);
        const key = PAD_KEYS[i];
        return (
          <button
            key={i}
            type="button"
            data-pad-btn={i}
            className={w.pad}
            aria-pressed={i === slice}
            data-lit={i === lit}
            draggable
            onDragStart={(e) => {
              setSliceDrag(e.dataTransfer, { sourceId: source.id, start: a, end: b }, `${source.name} · ${i + 1}`);
              studio.selectSlice(i);
            }}
            onPointerDown={(e) => {
              // Pads sound on press, like hardware; a drag still starts from here.
              if (e.button !== 0) return;
              studio.auditionSlice(source.id, i);
            }}
            onKeyDown={(e) => {
              // Space plays the pad (not the song); Enter adds it to the timeline.
              if (e.key === ' ') {
                e.preventDefault();
                studio.auditionSlice(source.id, i);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                studio.selectSlice(i);
                studio.appendSlice(source.id, i);
              }
            }}
            onClick={(e) => {
              // Pointer presses already played on pointerdown.
              if (e.detail === 0) studio.auditionSlice(source.id, i);
            }}
            aria-label={`Slice ${i + 1}, ${(b - a).toFixed(2)} seconds${key ? `, key ${key.toUpperCase()}` : ''}`}
            title={`Slice ${i + 1} · ${(b - a).toFixed(2)} s — click to play, drag onto a lane${key ? ` · key ${key.toUpperCase()}` : ''}`}
          >
            <span className={w.padTop}>
              <span className={w.padNum}>{i + 1}</span>
              {key && <kbd className={w.padKey}>{key.toUpperCase()}</kbd>}
            </span>
            <canvas data-pad={i} className={w.padWave} aria-hidden="true" />
            <span className={w.padLen}>{fmtLen(b - a)}</span>
            <span className={w.padProg} data-prog={i === lit ? 'on' : 'off'} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

const fmtLen = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
