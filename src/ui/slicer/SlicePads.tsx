import { useEffect, useRef } from 'react';
import { peaksColumns } from '../../slicer/dsp';
import { sliceAt, sliceRange } from '../../slicer/model';
import type { Studio } from '../../slicer/studio';
import type { Peaks, Source } from '../../slicer/types';
import { fitCanvas, useFrame, type FrameLoop } from '../frame';
import { BANK, bankName, exactSlice, fmtLen, PAD_KEYS, sliceColor } from './chopKit';
import { setSliceDrag } from './dnd';
import { StepTag } from './SlicerGuide';

/** Bank letters shown as a row up to this many; past it, arrows. */
const MAX_LETTERS = 8;
import w from './workspace.module.css';

export { PAD_KEYS };

interface Props {
  studio: Studio;
  source: Source;
  peaks: Peaks | undefined;
  /** The selected slice. */
  slice: number | null;
  bank: number;
  onBank: (b: number) => void;
  loop: FrameLoop;
  /** A finger: no HTML5 drag (iOS has none), no hover. */
  touch: boolean;
}

/**
 * The slices as an instrument: a 4×4 grid of pads in the shape of the keys
 * that play them, in banks of 16. Pads sound on press, light while their
 * slice sounds (also while the whole sample plays through them), and drag
 * onto a lane on desktop.
 */
export function SlicePads({ studio, source, peaks, slice, bank, onBank, loop, touch }: Props) {
  const grid = useRef<HTMLDivElement>(null);
  const n = source.slices.length;
  const banks = Math.max(1, Math.ceil(n / BANK));
  const first = bank * BANK;
  const latest = useRef(source);
  latest.current = source;
  const lit = useRef(-1);

  // Thumbnails: redrawn when the slices, the bank or the audio change, never per frame.
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
      if (!peaks || cw < 2 || i >= source.slices.length) return;
      const [a, b] = sliceRange(source, i);
      const cols = Math.max(1, Math.floor(cw / 2));
      const { min, max } = peaksColumns(peaks, a, b, cols);
      let peak = 0.001;
      for (let k = 0; k < cols; k++) peak = Math.max(peak, max[k], -min[k]);
      const mid = ch / 2;
      const scale = (ch / 2 - 1) / peak;
      g.fillStyle = sliceColor(source, i);
      g.beginPath();
      for (let x = 0; x < cols; x++) {
        const top = Math.max(0.5, max[x] * scale);
        const bot = Math.max(0.5, -min[x] * scale);
        g.rect(x * 2, mid - top, 1.25, top + bot);
      }
      g.fill();
    });
  }, [source, peaks, bank, n]);

  // Which pad is sounding, and how far through: set on the DOM by the frame
  // loop (no React renders). A pad's own audition lights it; the whole sample
  // playing lights each pad in turn as the playhead crosses its slice.
  useFrame(loop, () => {
    const root = grid.current;
    if (!root) return;
    const src = latest.current;
    const au = studio.store.get().audition;
    const pos = au && au.sourceId === src.id ? studio.auditionPosition() : null;
    let idx = -1;
    let f = 0;
    if (au && pos) {
      idx = exactSlice(src, au.start, au.end);
      if (idx < 0) idx = sliceAt(src, pos.time);
      const [a, b] = sliceRange(src, idx);
      f = Math.min(1, Math.max(0, (pos.time - a) / (b - a || 1)));
    }
    if (idx !== lit.current) {
      root.querySelector(`[data-pad-btn="${lit.current}"]`)?.removeAttribute('data-lit');
      root.querySelector(`[data-pad-btn="${idx}"]`)?.setAttribute('data-lit', '');
      lit.current = idx;
    }
    const bar = idx >= 0 ? root.querySelector<HTMLElement>(`[data-pad-btn="${idx}"] [data-prog]`) : null;
    if (bar) bar.style.transform = `scaleX(${f})`;
  });

  // Re-light after a re-render replaced the pad elements.
  useEffect(() => {
    if (lit.current >= 0) grid.current?.querySelector(`[data-pad-btn="${lit.current}"]`)?.setAttribute('data-lit', '');
  });

  const play = (i: number) => studio.auditionSlice(source.id, i);

  return (
    <div className={w.padsBox} aria-label={`Pads for ${source.name}`} role="group">
      <div className={w.padsHead}>
        <StepTag step="pads" />
        <span className={w.padsRange}>{n > BANK ? `${first + 1}–${Math.min(n, first + BANK)} of ${n}` : `${n} slice${n === 1 ? '' : 's'}`}</span>
      </div>
      {banks > 1 &&
        (banks <= MAX_LETTERS ? (
          <div className={w.banks} role="radiogroup" aria-label="Pad bank">
            {Array.from({ length: banks }, (_, b) => (
              <button
                key={b}
                type="button"
                role="radio"
                aria-checked={b === bank}
                aria-label={`Bank ${bankName(b)}: slices ${b * BANK + 1} to ${Math.min(n, (b + 1) * BANK)}`}
                onClick={() => onBank(b)}
                title={`Slices ${b * BANK + 1}–${Math.min(n, (b + 1) * BANK)}`}
              >
                {bankName(b)}
              </button>
            ))}
          </div>
        ) : (
          <div className={w.bankPager} role="group" aria-label="Pad bank">
            <button type="button" disabled={bank === 0} onClick={() => onBank(bank - 1)} aria-label="Previous bank">
              ‹
            </button>
            <span aria-live="polite">
              Bank {bankName(bank)} · {bank + 1} of {banks}
            </span>
            <button type="button" disabled={bank >= banks - 1} onClick={() => onBank(bank + 1)} aria-label="Next bank">
              ›
            </button>
          </div>
        ))}
      <div className={w.pads} ref={grid} data-touch={touch || undefined}>
        {Array.from({ length: BANK }, (_, k) => {
          const i = first + k;
          if (i >= n) return <span key={k} className={w.padEmpty} aria-hidden="true" />;
          const [a, b] = sliceRange(source, i);
          const key = PAD_KEYS[k];
          return (
            <button
              key={k}
              type="button"
              data-pad-btn={i}
              className={w.pad}
              style={{ '--pad': sliceColor(source, i) } as React.CSSProperties}
              aria-pressed={i === slice}
              draggable={!touch}
              onDragStart={(e) => {
                setSliceDrag(e.dataTransfer, { sourceId: source.id, start: a, end: b }, `${source.name} · ${i + 1}`);
                studio.selectSlice(i);
              }}
              onPointerDown={(e) => {
                // Pads sound on press, like hardware; a drag still starts from here.
                if (e.button !== 0) return;
                play(i);
              }}
              onContextMenu={(e) => touch && e.preventDefault()}
              onKeyDown={(e) => {
                // Space plays the pad (not the song); Enter adds it to the timeline.
                if (e.key === ' ') {
                  e.preventDefault();
                  play(i);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  studio.selectSlice(i);
                  studio.appendSlice(source.id, i);
                }
              }}
              onClick={(e) => {
                // Pointer presses already played on pointerdown.
                if (e.detail === 0) play(i);
              }}
              aria-label={`Slice ${i + 1}, ${fmtLen(b - a)}, key ${key}`}
              title={touch ? undefined : `Slice ${i + 1} · ${fmtLen(b - a)} · key ${key} — press to play, drag onto a lane`}
            >
              <span className={w.padNum}>{i + 1}</span>
              <kbd className={w.padKey} aria-hidden="true">
                {key}
              </kbd>
              <canvas data-pad={i} className={w.padWave} aria-hidden="true" />
              <span className={w.padProg} data-prog aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
