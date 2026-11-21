/**
 * Canvas helpers for the arranger: clip waveforms (cached as small bitmaps,
 * so a drag only blits) and CSS colours resolved for the canvas.
 */
import { peaksColumns } from '../../slicer/dsp';
import type { Peaks } from '../../slicer/types';

/* ── Colours ──────────────────────────────────────────────────────────── */

/** Resolves "var(--cat-kick)" (or any CSS colour) to a value the canvas takes. */
export function colorResolver(el: Element) {
  const cs = getComputedStyle(el);
  const memo = new Map<string, string>();
  return (value: string, fallback = '#888') => {
    const hit = memo.get(value);
    if (hit) return hit;
    const m = /^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value.trim());
    const out = m ? cs.getPropertyValue(m[1]).trim() || m[2] || fallback : value || fallback;
    memo.set(value, out);
    return out;
  };
}

/* ── Waveforms ────────────────────────────────────────────────────────── */

const peakIds = new WeakMap<Peaks, number>();
let nextPeakId = 1;
const cache = new Map<string, HTMLCanvasElement>();
const MAX_CACHE = 400;
/** Wider clips are drawn straight onto the timeline, visible part only. */
export const MAX_CACHED_W = 2048;

/**
 * Draws a waveform from source time tA (at x) to tB (at x + w) as min/max
 * columns, one per device pixel. tB < tA draws it backwards (reversed clips).
 */
export function drawWave(g: CanvasRenderingContext2D, p: Peaks, tA: number, tB: number, x: number, y: number, w: number, h: number, color: string, dpr: number) {
  const cols = Math.max(1, Math.min(8192, Math.round(w * dpr)));
  const lo = Math.min(tA, tB);
  const hi = Math.max(tA, tB);
  if (!(hi > lo)) return;
  const { min, max } = peaksColumns(p, lo, hi, cols);
  const rev = tB < tA;
  const mid = y + h / 2;
  const half = (h / 2) * 0.94;
  const cw = w / cols;
  const px = 1 / dpr;
  g.fillStyle = color;
  g.beginPath();
  for (let c = 0; c < cols; c++) {
    const k = rev ? cols - 1 - c : c;
    const top = mid - max[k] * half;
    const bot = mid - min[k] * half;
    g.rect(x + c * cw, top, Math.max(cw, px), Math.max(px, bot - top));
  }
  g.fill();
}

/** A clip's waveform as a bitmap of w×h CSS px, cached by content (so every hit of one drum sound shares it). */
export function waveImage(p: Peaks, start: number, end: number, reverse: boolean, w: number, h: number, dpr: number, color: string): HTMLCanvasElement | null {
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  if (W < 1 || H < 1 || W > MAX_CACHED_W) return null;
  let id = peakIds.get(p);
  if (!id) peakIds.set(p, (id = nextPeakId++));
  const key = `${id}|${start.toFixed(4)}|${end.toFixed(4)}|${reverse ? 1 : 0}|${W}|${H}|${color}`;
  const hit = cache.get(key);
  if (hit) {
    // Keep recently used bitmaps at the back of the eviction order.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  drawWave(g, p, reverse ? end : start, reverse ? start : end, 0, 0, W, H, color, 1);
  cache.set(key, c);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  return c;
}
