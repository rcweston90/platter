import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import HoverPlugin from 'wavesurfer.js/dist/plugins/hover.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.js';
import ZoomPlugin from 'wavesurfer.js/dist/plugins/zoom.js';
import { sliceAt, sliceRange } from '../../slicer/model';
import type { Studio } from '../../slicer/studio';
import { SLICE_COLORS, type Source } from '../../slicer/types';
import { fitCanvas, useFrame, type FrameLoop } from '../frame';
import { setSliceDrag } from './dnd';
import w from './workspace.module.css';

/**
 * The slice editor's waveform, on wavesurfer.js (BSD-3) with its Regions,
 * Timeline, Zoom and Hover plugins. Wavesurfer only draws: it's fed the
 * studio's precomputed peaks and never gets a URL, so it owns no audio — the
 * studio plays every audition, and we move wavesurfer's cursor to match.
 * The beat grid is ours (a canvas over the visible part of the waveform):
 * wavesurfer has no grid, and its wrapper can be far wider than a canvas may be.
 */

const TIMELINE_H = 18;
/** Room for the horizontal scrollbar under the timeline when zoomed in. */
const SCROLLBAR_H = 12;
const MAX_ZOOM = 4000; // px per second
const ZOOM_STEP = 1.6;

export function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export const fmtTime = (t: number, ms = true) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${(ms ? s.toFixed(2) : Math.floor(s).toString()).padStart(ms ? 5 : 2, '0')}`;
};

interface Props {
  studio: Studio;
  source: Source;
  /** The selected slice. */
  slice: number | null;
  meter: number;
  loop: FrameLoop;
  /** Where the user last clicked (seconds), for "Slice here". */
  pointer: number | null;
  onPointer: (t: number) => void;
}

export function SliceWave({ studio, source, slice, meter, loop, pointer, onPointer }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLCanvasElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const regions = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const list = useRef<Region[]>([]);
  const [readyTick, setReadyTick] = useState(0);
  // Event handlers outlive renders: they read the latest props from here.
  const latest = useRef({ source, slice, meter, pointer, onPointer });
  latest.current = { source, slice, meter, pointer, onPointer };
  const auditioning = useRef(false);
  const lastCursor = useRef(-1);

  const id = source.id;
  const duration = studio.buffer(id)?.duration || source.duration;

  /* ── Create / destroy ─────────────────────────────────────────────────── */
  useEffect(() => {
    const el = host.current;
    const peaks = studio.peaks(id);
    if (!el || !peaks || !(duration > 0)) return;
    const css = getComputedStyle(document.documentElement);
    const token = (n: string, fallback: string) => css.getPropertyValue(n).trim() || fallback;
    const hex = SLICE_COLORS[latest.current.source.color % SLICE_COLORS.length];
    const height = () => Math.max(40, el.clientHeight - TIMELINE_H - SCROLLBAR_H);

    const reg = RegionsPlugin.create();
    const inst = WaveSurfer.create({
      container: el,
      height: height(),
      // The studio's peaks as two channels: maxima drawn up, minima down.
      peaks: [peaks.max, peaks.min],
      duration,
      normalize: true,
      waveColor: hex,
      progressColor: hex,
      cursorColor: token('--dj-playhead', '#ff4747'),
      cursorWidth: 2,
      interact: true,
      dragToSeek: false,
      autoScroll: true,
      autoCenter: false,
      plugins: [
        reg,
        TimelinePlugin.create({
          height: TIMELINE_H,
          style: { color: token('--dj-dim', '#a4a8ae'), fontFamily: token('--font-mono', 'monospace') },
          formatTimeCallback: (t) => fmtTime(t, false),
          secondaryLabelOpacity: 0.5,
        }),
        ZoomPlugin.create({ maxZoom: MAX_ZOOM, exponentialZooming: true, iterations: 30 }),
        HoverPlugin.create({
          lineColor: 'rgba(255, 255, 255, 0.45)',
          labelBackground: token('--dj-panel-3', '#282b30'),
          labelColor: token('--dj-text', '#eceae4'),
          labelSize: 11,
          formatTimeCallback: (t) => fmtTime(t),
        }),
      ],
    });
    ws.current = inst;
    regions.current = reg;
    list.current = [];
    auditioning.current = false;
    lastCursor.current = -1;

    inst.on('error', () => undefined);
    inst.on('ready', () => {
      inst.setTime(latest.current.pointer ?? 0);
      setReadyTick((n) => n + 1);
    });
    // Click: select and hear the slice under the pointer; it also parks the
    // cursor there, which is where "Slice here" cuts.
    inst.on('click', (relX) => {
      const src = latest.current.source;
      const t = relX * inst.getDuration();
      latest.current.onPointer(t);
      studio.auditionSlice(src.id, sliceAt(src, t));
    });
    inst.on('dblclick', (relX) => {
      studio.addSlice(latest.current.source.id, relX * inst.getDuration());
    });
    // Dragging the right edge of region i moves slice point i + 1. moveSlice
    // merges a drag into one undo step; endGesture closes it.
    reg.on('region-update', (r, side) => {
      const i = list.current.indexOf(r);
      if (i < 0 || side !== 'end') return;
      studio.moveSlice(latest.current.source.id, i + 1, r.end);
    });
    reg.on('region-updated', () => studio.endGesture());

    const redrawGrid = () => drawGrid();
    inst.on('scroll', redrawGrid);
    inst.on('zoom', () => (fitLabels(), drawGrid()));
    inst.on('redraw', () => (fitLabels(), drawGrid()));

    const ro = new ResizeObserver(() => {
      const h = height();
      if (inst.options.height !== h) inst.setOptions({ height: h });
      drawGrid();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      // destroy() is terminal (and rejects an unfinished load, which
      // wavesurfer swallows for the constructor's own load).
      inst.destroy();
      if (ws.current === inst) {
        ws.current = null;
        regions.current = null;
        list.current = [];
      }
    };
    // Recreate only for new audio (another source, or its audio read again):
    // slice edits update the regions in place.
  }, [studio, id, duration, studio.peaks(id)]);

  /* ── Regions follow the slices ────────────────────────────────────────── */
  useEffect(() => {
    const reg = regions.current;
    const inst = ws.current;
    if (!reg || !inst || !readyTick) return;
    const src = source;
    const n = src.slices.length;
    const hex = SLICE_COLORS[src.color % SLICE_COLORS.length];
    const colorOf = (i: number) => hexA(hex, i === slice ? 0.34 : i % 2 ? 0.16 : 0.07);
    if (list.current.length !== n || list.current.some((r) => r.isRemoved)) {
      reg.clearRegions();
      list.current = src.slices.map((_, i) => {
        const [a, b] = sliceRange(src, i);
        const r = reg.addRegion({
          id: `slice-${i}`,
          start: a,
          end: b,
          color: colorOf(i),
          drag: false,
          // One handle per boundary: region i's right edge is slice point i + 1.
          resize: i < n - 1,
          resizeStart: false,
          resizeEnd: i < n - 1,
          content: chip(studio, src.id, i),
          // Labels that don't fit are hidden (fitLabels), not stacked.
          avoidOverlapping: false,
        });
        wireHandle(studio, r, () => latest.current.source.id, i + 1);
        return r;
      });
    } else {
      list.current.forEach((r, i) => {
        const [a, b] = sliceRange(src, i);
        if (Math.abs(r.start - a) > 1e-6 || Math.abs(r.end - b) > 1e-6) r.setOptions({ start: a, end: b });
        const c = colorOf(i);
        if (r.color !== c) r.setOptions({ color: c });
      });
    }
    fitLabels();
    list.current.forEach((r, i) => {
      if (!r.element) return;
      r.element.style.boxShadow = i === slice ? `inset 0 0 0 1px ${hexA(hex, 0.9)}` : '';
      r.element.dataset.selected = String(i === slice);
    });
  }, [studio, source, slice, readyTick]);

  // Bring the selected slice into view (keyboard navigation can leave it off-screen).
  useEffect(() => {
    const inst = ws.current;
    if (!inst || slice === null || !readyTick) return;
    const [a, b] = sliceRange(source, slice);
    const pps = inst.getWrapper().clientWidth / (inst.getDuration() || 1);
    const left = inst.getScroll();
    const width = inst.getWidth();
    if (a * pps < left || b * pps > left + width) inst.setScroll(Math.max(0, a * pps - width * 0.1));
    // Only on a new selection, not on every slice edit.
  }, [slice, readyTick]);

  useEffect(() => drawGrid());

  /* ── The cursor follows the audition ──────────────────────────────────── */
  useFrame(loop, () => {
    const inst = ws.current;
    if (!inst) return;
    const a = studio.auditionPosition();
    if (a && a.sourceId === latest.current.source.id) {
      auditioning.current = true;
      // Skip sub-pixel moves: setTime restyles the cursor and progress mask.
      if (Math.abs(a.time - lastCursor.current) > 0.002) {
        lastCursor.current = a.time;
        inst.setTime(a.time);
      }
    } else if (auditioning.current) {
      auditioning.current = false;
      lastCursor.current = -1;
      inst.setTime(latest.current.pointer ?? 0);
    }
  });

  /** Hides the numbers of slices too narrow to hold one at this zoom, and
   *  thins the boundary lines when slices crowd together. */
  function fitLabels() {
    const inst = ws.current;
    const el = host.current;
    if (!inst || !el) return;
    const pps = inst.getWrapper().clientWidth / (inst.getDuration() || 1);
    let narrow = 0;
    for (const r of list.current) {
      const px = (r.end - r.start) * pps;
      if (px < 8) narrow++;
      if (r.content) r.content.style.visibility = px < 26 ? 'hidden' : '';
    }
    el.toggleAttribute('data-dense', narrow > list.current.length / 3);
  }

  /* ── Beat grid ────────────────────────────────────────────────────────── */
  function drawGrid() {
    const c = grid.current;
    const inst = ws.current;
    if (!c) return;
    const { w: cw, h: ch, dpr } = fitCanvas(c);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const src = latest.current.source;
    const dur = inst?.getDuration() ?? 0;
    if (!inst || !src.bpm || !(dur > 0)) return;
    const pps = inst.getWrapper().clientWidth / dur;
    const spb = 60 / src.bpm;
    if (spb * pps < 5) return; // too dense to read
    const t0 = inst.getScroll() / pps;
    const t1 = t0 + cw / pps;
    const meterN = latest.current.meter || 4;
    const first = Math.ceil((t0 - src.gridOffset) / spb);
    for (let n = first; src.gridOffset + n * spb <= t1; n++) {
      const t = src.gridOffset + n * spb;
      if (t < 0) continue;
      const x = Math.round((t - t0) * pps) + 0.5;
      const bar = ((n % meterN) + meterN) % meterN === 0;
      g.fillStyle = bar ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)';
      g.fillRect(x - 0.5, 0, 1, ch);
    }
  }

  /* ── Zoom buttons ─────────────────────────────────────────────────────── */
  const zoomBy = (f: number | 0) => {
    const inst = ws.current;
    if (!inst || !readyTick) return;
    const dur = inst.getDuration();
    const width = inst.getWidth();
    const pps = inst.getWrapper().clientWidth / dur;
    // Keep the cursor (or the middle of the view) where it is on screen.
    const cursor = latest.current.pointer;
    const left = inst.getScroll();
    const anchor = cursor !== null && cursor * pps >= left && cursor * pps <= left + width ? cursor : (left + width / 2) / pps;
    const anchorX = anchor * pps - left;
    const next = f === 0 ? 0 : Math.min(MAX_ZOOM, pps * f);
    if (next !== 0 && next * dur <= width) inst.zoom(0);
    else inst.zoom(next);
    const nextPps = inst.getWrapper().clientWidth / dur;
    inst.setScroll(Math.max(0, anchor * nextPps - anchorX));
  };

  return (
    <div className={w.waveBox}>
      <div
        ref={host}
        className={w.wave}
        tabIndex={0}
        role="group"
        aria-roledescription="waveform"
        aria-label={`${source.name}: ${source.slices.length} slice${source.slices.length === 1 ? '' : 's'}. Click to hear a slice, double-click to add a slice point, left and right arrows pick a slice.`}
      />
      <canvas ref={grid} className={w.grid} style={{ height: `calc(100% - ${TIMELINE_H + SCROLLBAR_H}px)` }} aria-hidden="true" />
      <div className={w.zoom}>
        <button type="button" className={w.zoomBtn} onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out" title="Zoom out (or scroll the wheel)">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 10h10" />
          </svg>
        </button>
        <button type="button" className={w.zoomBtn} onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in" title="Zoom in (or scroll the wheel, or pinch)">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 10h10M10 5v10" />
          </svg>
        </button>
        <button type="button" className={w.zoomBtn} onClick={() => zoomBy(0)} aria-label="Fit the whole sample" title="Fit the whole sample">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 7V4h3M17 7V4h-3M3 13v3h3M17 13v3h-3" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** A region's label: the slice number, and the handle to drag it to the timeline. */
function chip(studio: Studio, sourceId: string, i: number): HTMLElement {
  const el = document.createElement('div');
  el.textContent = String(i + 1);
  el.draggable = true;
  el.title = `Slice ${i + 1} — drag onto a lane to place it`;
  // Keep the region's own pointer handling (and wavesurfer's) out of a drag.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('dragstart', (e) => {
    const src = studio.source(sourceId);
    if (!src || !e.dataTransfer) return;
    const [start, end] = sliceRange(src, i);
    setSliceDrag(e.dataTransfer, { sourceId, start, end }, `${src.name} · ${i + 1}`);
    studio.selectSlice(i);
  });
  return el;
}

/** Alt/Option-click on a boundary removes that slice point. */
function wireHandle(studio: Studio, r: Region, sourceId: () => string, point: number) {
  const handle = r.element?.querySelector<HTMLElement>('[part~="region-handle-right"]');
  if (!handle) return;
  handle.title = 'Drag to move this slice point · Alt/Option-click to remove it';
  handle.addEventListener('click', (e) => {
    if (!e.altKey) return;
    e.stopPropagation();
    e.preventDefault();
    studio.removeSlice(sourceId(), point);
  });
}
