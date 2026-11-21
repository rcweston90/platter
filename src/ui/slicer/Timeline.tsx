import { useEffect, useMemo, useRef, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { getSound } from '../../engine/sounds/catalog';
import { useStore } from '../../engine/store';
import { clipBeats, clipLabel, clipRate, makeClip, snapBeat, soundColor, songBeats, swung } from '../../slicer/model';
import type { Studio } from '../../slicer/studio';
import { SLICE_COLORS, type Clip, type Lane, type Project, type Source } from '../../slicer/types';
import { fitCanvas, readPalette, useFrame, type FrameLoop, type Palette } from '../frame';
import { hasSliceDrag, readSliceDrag, type SliceDragPayload } from './dnd';
import { colorResolver, drawWave, MAX_CACHED_W, waveImage } from './timelineDraw';
import st from './arranger.module.css';

/** Ruler height; bar numbers above RULER_SPLIT, the loop brace below. */
export const RULER = 32;
const RULER_SPLIT = 17;
/** Lane header column (matches .content's first grid column). */
export const HEADER_W = 236;
const MIN_PPB = 3;
const MAX_PPB = 480;
/** Trim handles at each end of a clip, px. */
const EDGE_PX = 7;
/** Movement before a press becomes a drag, px. */
const DRAG_PX = 3;
/** Shortest clip a trim leaves, seconds. */
const MIN_SEC = 0.01;
const INK = 'rgba(14, 15, 17, 0.72)';

export interface TimelineControl {
  zoomBy(factor: number): void;
  fit(): void;
}

/** A clip where it's drawn: lane index, display start (swung on drum lanes) and length in beats. */
interface Box {
  clip: Clip;
  src: Source | undefined;
  lane: Lane;
  li: number;
  at: number;
  len: number;
}

type Gesture =
  | { kind: 'seek' }
  | { kind: 'loop'; mode: 'start' | 'end' | 'move' | 'new'; downBeat: number; downX: number; orig: Project['loop']; moved: boolean }
  | {
      kind: 'move';
      hitId: string;
      ids: string[];
      orig: Map<string, Clip>;
      downBeat: number;
      downLane: number;
      downX: number;
      moved: boolean;
      alt: boolean;
      duplicated: boolean;
      collapse: boolean;
      key: string;
    }
  | { kind: 'trim'; edge: 'left' | 'right'; hitId: string; ids: string[]; orig: Map<string, Clip>; downX: number; moved: boolean; key: string }
  | { kind: 'empty'; li: number; beat: number; downX: number; downY: number; moved: boolean; additive: boolean; base: string[]; shift: boolean }
  | { kind: 'paint'; laneId: string; srcId: string; sound: string; last: number; key: string };

// The slice being dragged from the editor. Browsers hide drag data until the
// drop, but it's readable in dragstart, so a document listener (which runs
// after the editor's own) keeps it here to size the drop preview.
let dragPayload: SliceDragPayload | null = null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Bar.beat.sixteenth, 1-based. */
export function posLabel(beat: number, meter: number) {
  const b = Math.max(0, beat);
  return `${Math.floor(b / meter) + 1}.${Math.floor(b % meter) + 1}.${Math.floor((b % 1) * 4 + 1e-6) + 1}`;
}

function lengthLabel(beats: number, meter: number) {
  if (beats >= meter && Math.abs(beats / meter - Math.round(beats / meter)) < 0.01) {
    const n = Math.round(beats / meter);
    return `${n} bar${n === 1 ? '' : 's'}`;
  }
  return `${Math.round(beats * 100) / 100} beat${Math.abs(beats - 1) < 0.005 ? '' : 's'}`;
}

/** Grid spacing for this zoom: the finest of the usual steps at least 7px apart. */
function gridStep(ppb: number, meter: number) {
  for (const s of [0.0625, 0.125, 0.25, 0.5, 1]) if (s * ppb >= 7) return s;
  for (let bars = 1; ; bars *= 2) if (bars * meter * ppb >= 7) return bars * meter;
}

function layoutBoxes(p: Project): Box[] {
  const src = new Map(p.sources.map((s) => [s.id, s]));
  const lanes = new Map(p.lanes.map((l, i) => [l.id, [l, i] as const]));
  const out: Box[] = [];
  for (const clip of p.clips) {
    const hit = lanes.get(clip.laneId);
    if (!hit) continue;
    const [lane, li] = hit;
    const s = src.get(clip.sourceId);
    out.push({ clip, src: s, lane, li, at: lane.kind === 'drum' ? swung(clip.at, p.swing) : clip.at, len: clipBeats(clip, s, p.bpm) });
  }
  return out;
}

interface Props {
  studio: Studio;
  loop: FrameLoop;
  laneH: number;
  draw: boolean;
  follow: boolean;
  onToggleDraw: () => void;
  control: RefObject<TimelineControl | null>;
  corner: ReactNode;
  headers: ReactNode;
}

/**
 * The arrangement: a ruler with the loop brace, lanes of clips on the beat
 * grid and the playhead. Drawn on two canvases (the arrangement, redrawn when
 * something changes; the playhead and drag previews, every frame) pinned over
 * a natively scrolling box sized to the song, so scrolling is the browser's
 * and the lane headers scroll with the lanes. Invisible buttons, one per
 * clip, carry names, focus and the keyboard.
 */
export function Timeline({ studio, loop, laneH, draw, follow, onToggleDraw, control, corner, headers }: Props) {
  const state = useStore(studio.store);
  const p = state.project;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const baseCv = useRef<HTMLCanvasElement>(null);
  const overCv = useRef<HTMLCanvasElement>(null);
  const view = useRef({ ppb: 0, cw: -1, ch: -1, viewW: 0, viewH: 0, sl: 0, st: 0, drawnSl: -1, drawnSt: -1, dirty: true });
  const colors = useRef<{ pal: Palette; resolve: (v: string, f?: string) => string; label: string; panel: string } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointer = useRef<{ x: number; y: number; shift: boolean; alt: boolean } | null>(null);
  const ghost = useRef<{ li: number; at: number; len: number } | null>(null);
  const marquee = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const lastDown = useRef({ id: '', at: 0 });
  const boxCache = useRef<{ p: Project | null; boxes: Box[] }>({ p: null, boxes: [] });

  const boxes = (proj: Project) => {
    if (boxCache.current.p !== proj) boxCache.current = { p: proj, boxes: layoutBoxes(proj) };
    return boxCache.current.boxes;
  };
  const proj = () => studio.store.get().project;
  const dirty = () => {
    view.current.dirty = true;
    loop.kick();
  };

  /* ── Geometry (canvas-local px ↔ beats and lanes) ───────────────────── */

  const xToBeat = (x: number) => (x + view.current.sl) / view.current.ppb;
  const beatToX = (b: number) => b * view.current.ppb - view.current.sl;
  const laneAt = (y: number) => Math.floor((y - RULER + view.current.st) / laneH);
  const laneTop = (i: number) => RULER + i * laneH - view.current.st;
  const snapOf = (b: number, free: boolean, mode: 'round' | 'floor' = 'round') => (free ? b : snapBeat(b, proj().snap, mode));
  const local = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitTest = (x: number, y: number): { box: Box; zone: 'body' | 'left' | 'right' } | null => {
    if (y < RULER) return null;
    const li = laneAt(y);
    const s = studio.store.get();
    const all = boxes(s.project).filter((b) => b.li === li);
    // Selected clips are drawn on top, so they win.
    const sel = new Set(s.selection);
    all.sort((a, b) => Number(sel.has(a.clip.id)) - Number(sel.has(b.clip.id)));
    for (let i = all.length - 1; i >= 0; i--) {
      const b = all[i];
      const x0 = beatToX(b.at);
      const w = Math.max(3, b.len * view.current.ppb);
      if (x < x0 - 1 || x > x0 + w + 1) continue;
      const e = w >= 14 ? Math.min(EDGE_PX, w / 4) : 0;
      return { box: b, zone: e && x <= x0 + e ? 'left' : e && x >= x0 + w - e ? 'right' : 'body' };
    }
    return null;
  };

  /* ── Layout, zoom ──────────────────────────────────────────────────── */

  const layout = () => {
    const sc = scroller.current;
    const ct = content.current;
    const sg = stage.current;
    if (!sc || !ct || !sg) return;
    const v = view.current;
    const pr = proj();
    const viewW = Math.max(0, sc.clientWidth - HEADER_W);
    const viewH = sc.clientHeight;
    v.cw = sc.clientWidth;
    v.ch = sc.clientHeight;
    if (!v.ppb && viewW > 0) v.ppb = clamp(viewW / (songBeats(pr) + pr.meter / 2), MIN_PPB, MAX_PPB);
    if (!v.ppb) return;
    const beats = Math.max(songBeats(pr), pr.loop.end) + 8 * pr.meter;
    const trackW = Math.max(viewW, Math.ceil(beats * v.ppb));
    const contentH = Math.max(viewH, RULER + (pr.lanes.length + 1) * laneH);
    ct.style.width = `${HEADER_W + trackW}px`;
    ct.style.height = `${contentH}px`;
    ct.style.setProperty('--ppb', String(v.ppb));
    sg.style.width = `${viewW}px`;
    sg.style.height = `${viewH}px`;
    v.viewW = viewW;
    v.viewH = viewH;
  };

  const zoomTo = (ppb: number, x: number) => {
    const sc = scroller.current;
    const v = view.current;
    if (!sc || !v.ppb) return;
    const next = clamp(ppb, MIN_PPB, MAX_PPB);
    if (Math.abs(next - v.ppb) < 1e-6) return;
    const beat = (sc.scrollLeft + x) / v.ppb;
    v.ppb = next;
    layout();
    sc.scrollLeft = Math.max(0, beat * next - x);
    v.sl = sc.scrollLeft;
    dirty();
  };

  /** Zooms around the playhead when it's in view, else the middle. */
  const zoomBy = (f: number) => {
    const v = view.current;
    const px = beatToX(studio.position());
    zoomTo(v.ppb * f, px >= 0 && px <= v.viewW ? px : v.viewW / 2);
  };

  const fit = () => {
    const sc = scroller.current;
    const v = view.current;
    if (!sc || !v.viewW) return;
    const pr = proj();
    v.ppb = clamp(v.viewW / (songBeats(pr) + pr.meter / 2), MIN_PPB, MAX_PPB);
    layout();
    sc.scrollLeft = 0;
    dirty();
  };

  useEffect(() => {
    control.current = { zoomBy, fit };
  });

  /* ── Drawing ───────────────────────────────────────────────────────── */

  const clipColor = (b: Box, C: NonNullable<typeof colors.current>) => {
    if (b.lane.kind === 'drum') return C.resolve(b.lane.color, '#5ec4ff');
    if (b.src?.origin.kind === 'sound') return C.resolve(soundColor(b.src.origin.soundId));
    return SLICE_COLORS[b.src?.color ?? 0] ?? SLICE_COLORS[0];
  };

  const drawClip = (g: CanvasRenderingContext2D, b: Box, selected: boolean, heard: boolean, w: number, h: number, dpr: number) => {
    const C = colors.current!;
    const s = studio.store.get();
    const pr = s.project;
    const v = view.current;
    const c = b.clip;
    const x = beatToX(b.at);
    const cw = Math.max(3, b.len * v.ppb);
    if (x > w || x + cw < 0) return;
    const y = laneTop(b.li) + 2;
    const ch = laneH - 4;
    if (y > h || y + ch < RULER) return;
    const color = clipColor(b, C);
    const status = b.src ? s.audio[b.src.id]?.status : 'missing';
    const broken = !b.src || status === 'missing' || status === 'error';
    g.globalAlpha = heard ? 1 : 0.38;
    g.save();
    g.beginPath();
    g.roundRect(x, y, cw, ch, Math.min(3, cw / 2));
    g.fillStyle = broken ? C.resolve('var(--dj-rec)') : color;
    g.fill();
    g.clip();
    // Drum hits are the lane's own sound: no name strip, all waveform.
    const ownHit = b.lane.kind === 'drum' && b.src?.origin.kind === 'sound';
    const hh = !ownHit && cw >= 22 && laneH >= 36 ? 13 : 0;
    if (hh) {
      g.fillStyle = 'rgba(0, 0, 0, 0.2)';
      g.fillRect(x, y, cw, hh);
    }
    const wy = y + hh + 1;
    const wh = ch - hh - 2;
    const peaks = b.src && !broken ? studio.peaks(b.src.id) : undefined;
    if (peaks && wh > 3) {
      if (cw * dpr <= MAX_CACHED_W) {
        const img = waveImage(peaks, c.start, c.end, c.reverse, cw, wh, dpr, INK);
        if (img) g.drawImage(img, x, wy, cw, wh);
      } else {
        // Wider than a cached bitmap: draw only what's on screen.
        const vx0 = Math.max(x, 0);
        const vx1 = Math.min(x + cw, w);
        const tAt = (px: number) => {
          const f = (px - x) / cw;
          return c.reverse ? c.end - f * (c.end - c.start) : c.start + f * (c.end - c.start);
        };
        if (vx1 > vx0) drawWave(g, peaks, tAt(vx0), tAt(vx1), vx0, wy, vx1 - vx0, wh, INK, dpr);
      }
    } else {
      // No audio yet (or gone): hatching instead of a waveform.
      g.strokeStyle = 'rgba(0, 0, 0, 0.22)';
      g.lineWidth = 1;
      g.beginPath();
      const x0 = Math.max(x, -ch);
      for (let k = x0 - ((x0 - x) % 8); k < Math.min(x + cw, w); k += 8) {
        g.moveTo(k, y + ch);
        g.lineTo(k + ch, y);
      }
      g.stroke();
    }
    // Fades (source seconds → beats → px).
    const spb = (60 / pr.bpm) * clipRate(c, b.src, pr.bpm);
    const fi = Math.min(cw / 2, (c.fadeIn / spb) * v.ppb);
    const fo = Math.min(cw / 2, (c.fadeOut / spb) * v.ppb);
    g.fillStyle = 'rgba(0, 0, 0, 0.3)';
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g.lineWidth = 1;
    if (fi > 1.5) {
      g.beginPath();
      g.moveTo(x, y + ch);
      g.lineTo(x + fi, y);
      g.lineTo(x, y);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(x, y + ch);
      g.lineTo(x + fi, y);
      g.stroke();
    }
    if (fo > 1.5) {
      g.beginPath();
      g.moveTo(x + cw, y + ch);
      g.lineTo(x + cw - fo, y);
      g.lineTo(x + cw, y);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(x + cw, y + ch);
      g.lineTo(x + cw - fo, y);
      g.stroke();
    }
    if (hh && cw > 26) {
      // The label sticks to the left edge of the view, like a DAW's.
      g.fillStyle = C.resolve('var(--dj-ink)', '#0e0f11');
      g.font = `600 11px ${C.label}`;
      g.textBaseline = 'middle';
      const lx = Math.max(x, 0) + 5;
      g.fillText(`${c.reverse ? '⇠ ' : ''}${clipLabel(c, b.src)}`, lx, y + hh / 2 + 0.5);
    }
    g.restore();
    g.beginPath();
    if (selected) {
      g.strokeStyle = C.resolve('var(--dj-text)', '#fff');
      g.lineWidth = 2;
      g.roundRect(x + 1, y + 1, Math.max(1, cw - 2), ch - 2, 3);
    } else {
      g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      g.lineWidth = 1;
      g.roundRect(x + 0.5, y + 0.5, Math.max(1, cw - 1), ch - 1, 3);
    }
    g.stroke();
    g.globalAlpha = 1;
  };

  const drawRuler = (g: CanvasRenderingContext2D, w: number, pr: Project) => {
    const C = colors.current!;
    const pal = C.pal;
    const v = view.current;
    const ppb = v.ppb;
    g.fillStyle = C.panel;
    g.fillRect(0, 0, w, RULER);
    g.fillStyle = 'rgba(0, 0, 0, 0.28)';
    g.fillRect(0, RULER_SPLIT, w, RULER - RULER_SPLIT);
    const b0 = v.sl / ppb;
    const b1 = (v.sl + w) / ppb;
    const meter = pr.meter;
    let every = 1;
    while (every * meter * ppb < 40) every *= 2;
    g.font = `500 11px ${pal.mono}`;
    g.textBaseline = 'middle';
    // Beat ticks.
    if (ppb >= 9) {
      g.fillStyle = 'rgba(255, 255, 255, 0.22)';
      for (let n = Math.ceil(b0); n <= b1; n++) if (n % meter) g.fillRect(Math.round(beatToX(n)), RULER_SPLIT - 5, 1, 5);
    }
    if (ppb >= 48) {
      g.fillStyle = 'rgba(164, 168, 174, 0.55)';
      for (let n = Math.ceil(b0); n <= b1; n++) if (n % meter) g.fillText(`${Math.floor(n / meter) + 1}.${(n % meter) + 1}`, beatToX(n) + 3, 8);
    }
    // Bars.
    for (let n = Math.floor(b0 / meter); n * meter <= b1; n++) {
      const x = Math.round(beatToX(n * meter));
      const major = n % every === 0;
      g.fillStyle = major ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.22)';
      g.fillRect(x, major ? 0 : RULER_SPLIT - 8, 1, major ? RULER_SPLIT : 8);
      if (major) {
        g.fillStyle = pal.text || '#a4a8ae';
        g.fillText(String(n + 1), x + 4, 8.5);
      }
    }
    // Loop brace.
    const ls = beatToX(pr.loop.start);
    const le = beatToX(pr.loop.end);
    const by = RULER_SPLIT + 2;
    const bh = RULER - RULER_SPLIT - 5;
    if (le > 0 && ls < w) {
      g.beginPath();
      g.roundRect(ls, by, Math.max(2, le - ls), bh, 3);
      g.fillStyle = pr.loop.on ? pal.cue || '#ffc23d' : 'rgba(255, 255, 255, 0.16)';
      g.fill();
      if (!pr.loop.on) {
        g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        g.lineWidth = 1;
        g.stroke();
      }
      // Grips at both ends.
      g.fillStyle = pr.loop.on ? 'rgba(14, 15, 17, 0.55)' : 'rgba(255, 255, 255, 0.4)';
      if (le - ls > 14) {
        g.fillRect(ls + 2, by + 2, 2, bh - 4);
        g.fillRect(le - 4, by + 2, 2, bh - 4);
      }
    }
    // Song end.
    const xe = Math.round(beatToX(songBeats(pr)));
    if (xe >= 0 && xe <= w) {
      g.fillStyle = 'rgba(255, 255, 255, 0.75)';
      g.fillRect(xe, 0, 1, RULER);
      g.beginPath();
      g.moveTo(xe + 1, 0);
      g.lineTo(xe + 9, 0);
      g.lineTo(xe + 1, 8);
      g.fill();
      g.font = `600 9px ${C.label}`;
      g.fillText('END', xe + 10, 5);
    }
    g.fillStyle = 'rgba(255, 255, 255, 0.14)';
    g.fillRect(0, RULER - 1, w, 1);
  };

  const drawBase = () => {
    const cv = baseCv.current;
    const C = colors.current;
    if (!cv || !C) return;
    const { w, h, dpr } = fitCanvas(cv);
    const g = cv.getContext('2d');
    if (!g || !w || !h) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = studio.store.get();
    const pr = s.project;
    const v = view.current;
    v.drawnSl = v.sl;
    v.drawnSt = v.st;
    v.dirty = false;
    const ppb = v.ppb;
    g.fillStyle = C.pal.bg || '#0a0b0d';
    g.fillRect(0, 0, w, h);
    const b0 = v.sl / ppb;
    const b1 = (v.sl + w) / ppb;

    g.save();
    g.beginPath();
    g.rect(0, RULER, w, h - RULER);
    g.clip();
    // Lanes.
    const anySolo = pr.lanes.some((l) => l.solo);
    pr.lanes.forEach((lane, i) => {
      const top = laneTop(i);
      if (top > h || top + laneH < RULER) return;
      g.fillStyle = i % 2 ? 'rgba(255, 255, 255, 0.025)' : 'rgba(255, 255, 255, 0.008)';
      g.fillRect(0, top, w, laneH);
      if (lane.kind === 'drum') {
        g.globalAlpha = 0.07;
        g.fillStyle = C.resolve(lane.color);
        g.fillRect(0, top, w, laneH);
        g.globalAlpha = 1;
      }
      g.fillStyle = 'rgba(255, 255, 255, 0.07)';
      g.fillRect(0, top + laneH - 1, w, 1);
    });
    // Every other bar a shade lighter, then the grid.
    const meter = pr.meter;
    g.fillStyle = 'rgba(255, 255, 255, 0.018)';
    for (let n = Math.floor(b0 / meter); n * meter < b1; n++) if (n % 2) g.fillRect(beatToX(n * meter), RULER, meter * ppb, h);
    const step = gridStep(ppb, meter);
    for (let n = Math.ceil(b0 / step); n * step <= b1; n++) {
      const b = n * step;
      const bar = Math.abs(b / meter - Math.round(b / meter)) < 1e-6;
      const beat = Math.abs(b - Math.round(b)) < 1e-6;
      g.fillStyle = bar ? 'rgba(255, 255, 255, 0.15)' : beat ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.03)';
      g.fillRect(Math.round(beatToX(b)), RULER, 1, h - RULER);
    }
    // The loop, then everything past the song's end dimmed.
    if (pr.loop.on) {
      const ls = beatToX(pr.loop.start);
      const le = beatToX(pr.loop.end);
      g.fillStyle = C.pal.cue || '#ffc23d';
      g.globalAlpha = 0.045;
      g.fillRect(ls, RULER, le - ls, h);
      g.globalAlpha = 0.35;
      g.fillRect(Math.round(ls), RULER, 1, h);
      g.fillRect(Math.round(le), RULER, 1, h);
      g.globalAlpha = 1;
    }
    const xe = beatToX(songBeats(pr));
    if (xe < w) {
      g.fillStyle = 'rgba(0, 0, 0, 0.32)';
      g.fillRect(Math.max(0, xe), RULER, w, h);
    }
    // Clips: selected ones last, on top.
    const sel = new Set(s.selection);
    const all = boxes(pr);
    for (const pass of [false, true])
      for (const b of all) {
        if (sel.has(b.clip.id) !== pass) continue;
        const heard = anySolo ? b.lane.solo : !b.lane.mute;
        drawClip(g, b, pass, heard, w, h, dpr);
      }
    g.restore();
    drawRuler(g, w, pr);
  };

  const drawOverlay = () => {
    const cv = overCv.current;
    const C = colors.current;
    if (!cv || !C) return;
    const { w, h, dpr } = fitCanvas(cv);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const s = studio.store.get();
    const v = view.current;
    // Drop preview.
    const gh = ghost.current;
    if (gh) {
      const x = beatToX(gh.at);
      const y = laneTop(gh.li) + 2;
      const cw = Math.max(6, gh.len * v.ppb);
      g.fillStyle = 'rgba(255, 255, 255, 0.12)';
      g.strokeStyle = C.resolve('var(--dj-focus)', '#ffe066');
      g.lineWidth = 1.5;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.roundRect(x, y, cw, laneH - 4, 3);
      g.fill();
      g.stroke();
      g.setLineDash([]);
      if (gh.li >= s.project.lanes.length) {
        g.fillStyle = C.resolve('var(--dj-focus)', '#ffe066');
        g.font = `600 12px ${C.label}`;
        g.textBaseline = 'middle';
        g.fillText('New lane', x + 6, y + (laneH - 4) / 2);
      }
    }
    // Marquee (kept in content px, so it survives scrolling).
    const m = marquee.current;
    if (m) {
      const x0 = Math.min(m.x0, m.x1) - v.sl;
      const y0 = Math.min(m.y0, m.y1) - v.st;
      g.fillStyle = 'rgba(255, 224, 102, 0.08)';
      g.strokeStyle = 'rgba(255, 224, 102, 0.8)';
      g.lineWidth = 1;
      g.fillRect(x0, Math.max(RULER, y0), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      g.strokeRect(Math.round(x0) + 0.5, Math.round(Math.max(RULER, y0)) + 0.5, Math.round(Math.abs(m.x1 - m.x0)), Math.round(Math.abs(m.y1 - m.y0)));
    }
    // Playhead (or, stopped, where play starts).
    const x = Math.round(beatToX(studio.position()));
    if (x >= -6 && x <= w + 6) {
      g.fillStyle = C.pal.playhead || '#ff4747';
      g.globalAlpha = s.playing ? 1 : 0.75;
      g.fillRect(x, 0, 1.5, h);
      g.beginPath();
      g.moveTo(x - 5, 0);
      g.lineTo(x + 6.5, 0);
      g.lineTo(x + 0.75, 8);
      g.fill();
      g.globalAlpha = 1;
    }
  };

  const frame = () => {
    const sc = scroller.current;
    if (!sc || !colors.current) return;
    const v = view.current;
    const s = studio.store.get();
    if (sc.clientWidth !== v.cw || sc.clientHeight !== v.ch) v.dirty = true;
    if (v.dirty || !v.ppb) layout();
    if (!v.ppb) return;
    const g = gesture.current;
    // Page along with the playhead.
    if (s.playing && follow && !g) {
      const px = studio.position() * v.ppb;
      if (px < sc.scrollLeft || px > sc.scrollLeft + v.viewW * 0.92) sc.scrollLeft = Math.max(0, px - v.viewW * 0.08);
    }
    // Scroll while a drag holds near either edge.
    const pt = pointer.current;
    if (g && pt && (g.kind === 'paint' || ('moved' in g && g.moved))) {
      const dx = pt.x < 24 ? -Math.ceil((24 - pt.x) / 2) : pt.x > v.viewW - 24 ? Math.ceil((pt.x - v.viewW + 24) / 2) : 0;
      if (dx) {
        sc.scrollLeft += dx;
        v.sl = sc.scrollLeft;
        applyMove(pt.x, pt.y, pt.shift);
      }
    }
    v.sl = sc.scrollLeft;
    v.st = sc.scrollTop;
    if (v.dirty || v.sl !== v.drawnSl || v.st !== v.drawnSt) drawBase();
    drawOverlay();
    if (s.playing || s.audition || g) loop.kick();
  };
  useFrame(loop, frame);

  // Colours from the tokens (re-read if the theme attribute ever flips).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => {
      const root = el.closest('[data-dj-root]') ?? document.documentElement;
      const resolve = colorResolver(root);
      colors.current = {
        pal: readPalette(root),
        resolve,
        label: resolve('var(--font-label)', 'sans-serif'),
        panel: resolve('var(--dj-panel-2)', '#1d1f23'),
      };
      dirty();
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => studio.store.subscribe(dirty), [studio]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(dirty, [laneH]); // eslint-disable-line react-hooks/exhaustive-deps

  // Native listeners: scroll (passive) and wheel/pinch zoom (must cancel).
  const fns = useRef({ zoomTo, layout });
  useEffect(() => {
    fns.current = { zoomTo, layout };
  });
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const onScroll = () => loop.kick();
    const wheel = (e: WheelEvent) => {
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * k;
      const dx = e.deltaX * k;
      const sg = stage.current;
      if ((e.ctrlKey || e.metaKey) && sg) {
        // Ctrl+wheel, Cmd+wheel and trackpad pinch: zoom around the pointer.
        e.preventDefault();
        const r = sg.getBoundingClientRect();
        const x = clamp(e.clientX - r.left, 0, view.current.viewW);
        fns.current.zoomTo(view.current.ppb * Math.exp(-clamp(dy, -60, 60) * 0.008), x);
        return;
      }
      // With every lane in view, a plain wheel scrolls through time.
      if (!e.shiftKey && Math.abs(dy) > Math.abs(dx) && sc.scrollHeight <= sc.clientHeight + 1) {
        e.preventDefault();
        sc.scrollLeft += dy;
      }
    };
    // Safari's trackpad pinch.
    let pinchFrom = 0;
    const gStart = (e: Event) => {
      e.preventDefault();
      pinchFrom = view.current.ppb;
    };
    const gChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as Event & { scale?: number }).scale ?? 1;
      fns.current.zoomTo(pinchFrom * scale, view.current.viewW / 2);
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('wheel', wheel, { passive: false });
    sc.addEventListener('gesturestart', gStart);
    sc.addEventListener('gesturechange', gChange);
    return () => {
      sc.removeEventListener('scroll', onScroll);
      sc.removeEventListener('wheel', wheel);
      sc.removeEventListener('gesturestart', gStart);
      sc.removeEventListener('gesturechange', gChange);
    };
  }, [loop]);

  // Remember what's being dragged out of the editor (see dragPayload).
  useEffect(() => {
    const start = (e: globalThis.DragEvent) => {
      dragPayload = readSliceDrag(e.dataTransfer);
    };
    const end = () => {
      dragPayload = null;
      if (ghost.current) {
        ghost.current = null;
        loop.kick();
      }
    };
    document.addEventListener('dragstart', start);
    document.addEventListener('dragend', end);
    return () => {
      document.removeEventListener('dragstart', start);
      document.removeEventListener('dragend', end);
    };
  }, [loop]);

  /* ── Pointer gestures ──────────────────────────────────────────────── */

  const focusClip = (id: string, scroll = false) => {
    const el = content.current?.querySelector<HTMLButtonElement>(`[data-clip="${CSS.escape(id)}"]`);
    el?.focus({ preventScroll: !scroll });
  };

  const auditionClip = (c: Clip) => {
    const pr = proj();
    const src = studio.source(c.sourceId);
    const rate = clipRate(c, src, pr.bpm);
    void studio.audition(c.sourceId, c.start, c.end, { reverse: c.reverse, semitones: 12 * Math.log2(rate) });
  };

  const setCursor = (x: number, y: number, alt: boolean) => {
    const sg = stage.current;
    if (!sg) return;
    let cur = 'default';
    const pr = proj();
    if (y < RULER) {
      if (y < RULER_SPLIT) cur = 'pointer';
      else {
        const ls = beatToX(pr.loop.start);
        const le = beatToX(pr.loop.end);
        cur = Math.abs(x - ls) <= 6 || Math.abs(x - le) <= 6 ? 'ew-resize' : x > ls && x < le ? 'pointer' : 'crosshair';
      }
    } else {
      const hit = hitTest(x, y);
      if (hit) cur = hit.zone === 'body' ? (alt ? 'copy' : 'grab') : 'ew-resize';
      else if (pr.lanes[laneAt(y)]?.kind === 'drum') cur = 'cell';
    }
    if (sg.style.cursor !== cur) sg.style.cursor = cur;
  };

  /** Adds one drum hit of a paint stroke (one undo step for the stroke). */
  const paintAt = (g: Extract<Gesture, { kind: 'paint' }>, at: number) => {
    studio.edit((q) => {
      if (q.clips.some((c) => c.laneId === g.laneId && Math.abs(c.at - at) < 1e-3)) return q;
      const src = q.sources.find((s) => s.id === g.srcId);
      if (!src) return q;
      const end = src.duration || studio.buffer(src.id)?.duration || getSound(g.sound)?.seconds || 1;
      return { ...q, clips: [...q.clips, makeClip(src, g.laneId, at, 0, end)] };
    }, g.key);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !view.current.ppb) return;
    // Our own focus handling below; the default would focus the scroller.
    e.preventDefault();
    const { x, y } = local(e);
    const s = studio.store.get();
    const pr = s.project;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = { x, y, shift: e.shiftKey, alt: e.altKey };
    const key = Date.now().toString(36);

    if (y < RULER) {
      scroller.current?.focus({ preventScroll: true });
      const b = xToBeat(x);
      if (y < RULER_SPLIT) {
        gesture.current = { kind: 'seek' };
        studio.seek(Math.max(0, snapOf(b, e.shiftKey)));
        return;
      }
      const ls = beatToX(pr.loop.start);
      const le = beatToX(pr.loop.end);
      const mode = Math.abs(x - le) <= 6 ? 'end' : Math.abs(x - ls) <= 6 ? 'start' : x > ls && x < le ? 'move' : 'new';
      gesture.current = { kind: 'loop', mode, downBeat: b, downX: x, orig: { ...pr.loop }, moved: false };
      return;
    }

    const hit = hitTest(x, y);
    if (hit) {
      const id = hit.box.clip.id;
      const now = performance.now();
      const double = lastDown.current.id === id && now - lastDown.current.at < 350;
      lastDown.current = { id, at: now };
      let sel = s.selection;
      let collapse = false;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        sel = sel.includes(id) ? sel.filter((k) => k !== id) : [...sel, id];
        studio.select(sel);
      } else if (!sel.includes(id)) {
        sel = [id];
        studio.select(sel);
      } else collapse = sel.length > 1;
      if (!sel.includes(id)) {
        scroller.current?.focus({ preventScroll: true });
        return;
      }
      focusClip(id);
      if (double) {
        auditionClip(hit.box.clip);
        return;
      }
      const orig = new Map(pr.clips.filter((c) => sel.includes(c.id)).map((c) => [c.id, c]));
      gesture.current =
        hit.zone === 'body'
          ? { kind: 'move', hitId: id, ids: sel, orig, downBeat: xToBeat(x), downLane: hit.box.li, downX: x, moved: false, alt: e.altKey, duplicated: false, collapse, key: `drag:${key}` }
          : { kind: 'trim', edge: hit.zone, hitId: id, ids: sel, orig, downX: x, moved: false, key: `trim:${key}` };
      if (hit.zone === 'body') e.currentTarget.style.cursor = e.altKey ? 'copy' : 'grabbing';
      return;
    }

    scroller.current?.focus({ preventScroll: true });
    const li = laneAt(y);
    const lane = pr.lanes[li];
    if (lane?.kind === 'drum' && lane.sound && (draw || e.metaKey || e.ctrlKey)) {
      const srcId = studio.addSound(lane.sound);
      if (!srcId) return;
      const at = Math.max(0, snapOf(xToBeat(x), e.shiftKey, 'floor'));
      const g: Gesture = { kind: 'paint', laneId: lane.id, srcId, sound: lane.sound, last: at, key: `paint:${key}` };
      gesture.current = g;
      paintAt(g, at);
      return;
    }
    gesture.current = {
      kind: 'empty',
      li,
      beat: xToBeat(x),
      downX: x + view.current.sl,
      downY: y + view.current.st,
      moved: false,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
      base: s.selection,
      shift: e.shiftKey,
    };
  };

  function applyMove(x: number, y: number, shift: boolean) {
    const g = gesture.current;
    if (!g) return;
    const pr = proj();
    const v = view.current;
    switch (g.kind) {
      case 'seek':
        studio.seek(Math.max(0, snapOf(xToBeat(x), shift)));
        return;
      case 'loop': {
        if (!g.moved && Math.abs(x - g.downX) < DRAG_PX) return;
        g.moved = true;
        const b = xToBeat(x);
        const sb = Math.max(0, snapOf(b, shift));
        const min = pr.snap || 0.25;
        if (g.mode === 'start') studio.setLoop({ start: Math.min(sb, g.orig.end - min), end: g.orig.end });
        else if (g.mode === 'end') studio.setLoop({ start: g.orig.start, end: Math.max(sb, g.orig.start + min) });
        else if (g.mode === 'move') {
          const d = Math.max(-g.orig.start, snapOf(g.orig.start + (b - g.downBeat), shift) - g.orig.start);
          studio.setLoop({ start: g.orig.start + d, end: g.orig.end + d });
        } else {
          const a = Math.max(0, snapOf(g.downBeat, shift));
          if (Math.abs(sb - a) < min / 2) return;
          studio.setLoop({ on: true, start: Math.min(a, sb), end: Math.max(a, sb) });
        }
        return;
      }
      case 'move': {
        const li = clamp(laneAt(y), 0, pr.lanes.length - 1);
        if (!g.moved && Math.abs(x - g.downX) < DRAG_PX && li === g.downLane) return;
        g.moved = true;
        const anchor = g.orig.get(g.hitId)!;
        const lanes = new Map(pr.lanes.map((l, i) => [l.id, i]));
        const origs = [...g.orig.values()];
        let d = snapOf(anchor.at + (xToBeat(x) - g.downBeat), shift) - anchor.at;
        d = Math.max(d, -Math.min(...origs.map((c) => c.at)));
        const idx = origs.map((c) => lanes.get(c.laneId) ?? 0);
        const dl = clamp(li - g.downLane, -Math.min(...idx), pr.lanes.length - 1 - Math.max(...idx));
        if (g.alt && !g.duplicated) {
          // Alt-drag copies: copies stay put, the originals move.
          g.duplicated = true;
          const copies = origs.map((c) => ({ ...c, id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}` }));
          studio.edit((q) => ({ ...q, clips: [...q.clips, ...copies] }), g.key);
        }
        studio.updateClips(
          origs.map((c, k) => ({ id: c.id, patch: { at: c.at + d, laneId: pr.lanes[idx[k] + dl].id } })),
          g.key,
        );
        return;
      }
      case 'trim': {
        if (!g.moved && Math.abs(x - g.downX) < DRAG_PX) return;
        g.moved = true;
        const src = (c: Clip) => pr.sources.find((s) => s.id === c.sourceId);
        const hitC = g.orig.get(g.hitId)!;
        const edgeBeat = snapOf(xToBeat(x), shift);
        const hitLen = clipBeats(hitC, src(hitC), pr.bpm);
        const d = g.edge === 'left' ? edgeBeat - hitC.at : edgeBeat - (hitC.at + hitLen);
        const changes = [...g.orig.values()].map((c) => {
          const s = src(c);
          const spb = (60 / pr.bpm) * clipRate(c, s, pr.bpm);
          const dur = s?.duration || studio.buffer(c.sourceId)?.duration || Infinity;
          let ds = d * spb;
          if (g.edge === 'left') {
            // The audio stays where it is: moving the left edge moves `at` with it.
            ds = Math.max(ds, -c.at * spb);
            if (!c.reverse) {
              const start = clamp(c.start + ds, 0, c.end - MIN_SEC);
              return { id: c.id, patch: { start, at: c.at + (start - c.start) / spb } };
            }
            const end = clamp(c.end - ds, c.start + MIN_SEC, dur);
            return { id: c.id, patch: { end, at: c.at + (c.end - end) / spb } };
          }
          if (!c.reverse) return { id: c.id, patch: { end: clamp(c.end + ds, c.start + MIN_SEC, dur) } };
          return { id: c.id, patch: { start: clamp(c.start - ds, 0, c.end - MIN_SEC) } };
        });
        studio.updateClips(changes, g.key);
        return;
      }
      case 'empty': {
        const cx = x + v.sl;
        const cy = y + v.st;
        if (!g.moved && Math.hypot(cx - g.downX, cy - g.downY) < DRAG_PX) return;
        g.moved = true;
        marquee.current = { x0: g.downX, y0: g.downY, x1: cx, y1: cy };
        const b0 = Math.min(g.downX, cx) / v.ppb;
        const b1 = Math.max(g.downX, cx) / v.ppb;
        const l0 = Math.floor((Math.min(g.downY, cy) - RULER) / laneH);
        const l1 = Math.floor((Math.max(g.downY, cy) - RULER) / laneH);
        const ids = boxes(pr)
          .filter((b) => b.li >= l0 && b.li <= l1 && b.at < b1 && b.at + b.len > b0)
          .map((b) => b.clip.id);
        studio.select(g.additive ? [...new Set([...g.base, ...ids])] : ids);
        loop.kick();
        return;
      }
      case 'paint': {
        const step = pr.snap || 0.25;
        const at = Math.max(0, snapOf(xToBeat(x), shift, 'floor'));
        if (Math.abs(at - g.last) < 1e-6) return;
        // Fill every grid step between the last hit and here (fast strokes).
        const dir = at > g.last ? 1 : -1;
        for (let b = g.last + dir * step; dir > 0 ? b <= at + 1e-6 : b >= at - 1e-6; b += dir * step) paintAt(g, b);
        g.last = at;
        return;
      }
    }
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!stage.current) return;
    const { x, y } = local(e);
    pointer.current = { x, y, shift: e.shiftKey, alt: e.altKey };
    if (!gesture.current) setCursor(x, y, e.altKey);
    else applyMove(x, y, e.shiftKey);
  };

  const finish = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    pointer.current = null;
    if (marquee.current) marquee.current = null;
    if (g && !cancelled) {
      const pr = proj();
      if (g.kind === 'loop' && !g.moved) {
        if (g.mode === 'new') studio.seek(Math.max(0, snapOf(g.downBeat, e.shiftKey)));
        else studio.setLoop({ on: !pr.loop.on });
      } else if (g.kind === 'move' && !g.moved && g.collapse) studio.select([g.hitId]);
      else if (g.kind === 'empty' && !g.moved) {
        const lane = pr.lanes[g.li];
        if (lane?.kind === 'drum' && lane.sound) {
          const at = Math.max(0, snapOf(g.beat, g.shift, 'floor'));
          const there = pr.clips.find((c) => c.laneId === lane.id && Math.abs(c.at - at) < 1e-3);
          if (there) studio.select([there.id]);
          else studio.addHit(lane.id, at);
        } else {
          if (!g.additive) studio.select([]);
          studio.seek(Math.max(0, snapOf(g.beat, g.shift)));
        }
      }
    }
    studio.endGesture();
    const { x, y } = local(e);
    setCursor(x, y, e.altKey);
    dirty();
  };

  /* ── Dropping slices from the editor ───────────────────────────────── */

  const dropSpot = (e: DragEvent<HTMLDivElement>) => {
    const { x, y } = local(e);
    const pr = proj();
    const li = clamp(laneAt(y), 0, pr.lanes.length);
    const at = Math.max(0, snapOf(xToBeat(x), e.shiftKey));
    return { li, at };
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasSliceDrag(e.dataTransfer) || !view.current.ppb) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { li, at } = dropSpot(e);
    const pr = proj();
    let len = 1;
    const src = dragPayload && pr.sources.find((s) => s.id === dragPayload!.sourceId);
    if (src && dragPayload) len = clipBeats(makeClip(src, '', 0, dragPayload.start, dragPayload.end), src, pr.bpm);
    const prev = ghost.current;
    if (!prev || prev.li !== li || prev.at !== at || prev.len !== len) {
      ghost.current = { li, at, len };
      loop.kick();
    }
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (stage.current?.contains(e.relatedTarget as Node | null)) return;
    ghost.current = null;
    loop.kick();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const payload = readSliceDrag(e.dataTransfer);
    ghost.current = null;
    loop.kick();
    if (!payload) return;
    e.preventDefault();
    const { li, at } = dropSpot(e);
    const pr = proj();
    const laneId = pr.lanes[li]?.id ?? studio.addLane('audio');
    const id = studio.addClip(payload.sourceId, laneId, at, payload.start, payload.end);
    if (!id) studio.store.set({ note: 'That slice’s audio isn’t in this project any more.' });
    scroller.current?.focus({ preventScroll: true });
  };

  /* ── Keyboard ──────────────────────────────────────────────────────── */

  const items = useMemo(() => [...layoutBoxes(p)].sort((a, b) => a.li - b.li || a.at - b.at), [p]);
  const order = items.map((b) => b.clip.id);
  const selected = new Set(state.selection);
  const tabStop = order.find((id) => selected.has(id)) ?? order[0];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const clipId = t.dataset.clip;
    if (t !== scroller.current && !clipId) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const s = studio.store.get();
    const pr = s.project;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    let sel = s.selection.filter((id) => pr.clips.some((c) => c.id === id));
    if (clipId && !sel.includes(clipId) && e.key !== 'Tab') {
      sel = [clipId];
      studio.select(sel);
    }
    const keepInView = () => requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    switch (e.key) {
      case 'Tab': {
        if (!order.length) return;
        const i = clipId ? order.indexOf(clipId) : -1;
        if (!clipId && e.shiftKey) return;
        const j = e.shiftKey ? i - 1 : i + 1;
        // Off either end, Tab leaves the timeline as usual.
        if (j < 0 || j >= order.length) return;
        handled();
        studio.select([order[j]]);
        focusClip(order[j], true);
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        handled();
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const step = e.shiftKey ? pr.meter : pr.snap || 0.25;
        if (!sel.length) {
          studio.seek(Math.max(0, snapBeat(studio.position(), step, 'round') + dir * step));
          return;
        }
        const clips = pr.clips.filter((c) => sel.includes(c.id));
        const d = Math.max(dir * step, -Math.min(...clips.map((c) => c.at)));
        studio.updateClips(clips.map((c) => ({ id: c.id, patch: { at: c.at + d } })), 'nudge');
        keepInView();
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!sel.length) return;
        handled();
        const lanes = new Map(pr.lanes.map((l, i) => [l.id, i]));
        const clips = pr.clips.filter((c) => sel.includes(c.id));
        const idx = clips.map((c) => lanes.get(c.laneId) ?? 0);
        const dl = clamp(e.key === 'ArrowUp' ? -1 : 1, -Math.min(...idx), pr.lanes.length - 1 - Math.max(...idx));
        if (!dl) return;
        studio.updateClips(clips.map((c, k) => ({ id: c.id, patch: { laneId: pr.lanes[idx[k] + dl].id } })), 'nudge-lane');
        keepInView();
        return;
      }
      case 'Enter': {
        const c = pr.clips.find((x) => x.id === (clipId ?? sel[0]));
        if (!c) return;
        handled();
        auditionClip(c);
        return;
      }
      case 'b':
      case 'B':
        handled();
        onToggleDraw();
        return;
      case '=':
      case '+':
        handled();
        zoomBy(1.25);
        return;
      case '-':
      case '_':
        handled();
        zoomBy(0.8);
        return;
    }
  };

  const laneOf = new Map(p.lanes.map((l) => [l.id, l]));
  const empty = !p.clips.length;

  return (
    <div
      ref={scroller}
      className={st.scroller}
      tabIndex={0}
      role="group"
      aria-label="Timeline"
      aria-describedby="slicer-timeline-help"
      onKeyDown={onKeyDown}
    >
      <div ref={content} className={st.content} style={{ ['--lane-h' as string]: `${laneH}px` }}>
        <div className={st.corner}>{corner}</div>
        <div className={st.headers}>{headers}</div>
        <div
          ref={stage}
          className={st.stage}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(e, false)}
          onPointerCancel={(e) => finish(e, true)}
          onPointerLeave={() => {
            if (!gesture.current && stage.current) stage.current.style.cursor = 'default';
          }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <canvas ref={baseCv} className={st.canvas} aria-hidden="true" />
          <canvas ref={overCv} className={st.canvas} aria-hidden="true" />
          {empty && (
            <p className={st.empty}>
              <strong>Drag slices here</strong>, or click a drum lane to add hits
            </p>
          )}
        </div>
        <div className={st.clipLayer} role="group" aria-label={`Clips (${p.clips.length})`}>
          {items.map((b) => (
            <button
              key={b.clip.id}
              type="button"
              data-clip={b.clip.id}
              className={st.clipBtn}
              tabIndex={b.clip.id === tabStop ? 0 : -1}
              aria-pressed={selected.has(b.clip.id)}
              aria-label={`${clipLabel(b.clip, b.src)}, ${laneOf.get(b.clip.laneId)?.name ?? 'lane'}, at ${posLabel(b.clip.at, p.meter)}, ${lengthLabel(b.len, p.meter)}${b.clip.reverse ? ', reversed' : ''}`}
              style={{
                left: `calc(var(--ppb) * ${b.at}px)`,
                width: `calc(var(--ppb) * ${b.len}px)`,
                top: b.li * laneH + 2,
                height: laneH - 4,
              }}
              onFocus={(e) => {
                // Keyboard focus selects; a click has already chosen the selection.
                if (e.currentTarget.matches(':focus-visible') && !studio.store.get().selection.includes(b.clip.id)) studio.select([b.clip.id]);
              }}
            />
          ))}
        </div>
      </div>
      <p id="slicer-timeline-help" className={st.srOnly}>
        Tab moves between clips. Arrow keys move the selected clips by the grid (Shift: by a bar), up and down move them between lanes, Enter plays one. B
        turns drawing on drum lanes on or off; minus and equals zoom.
      </p>
    </div>
  );
}
