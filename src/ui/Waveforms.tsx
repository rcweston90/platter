
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { hotLetter } from '../engine/cues';
import { loopLabel, type Deck, type DeckState } from '../engine/deck';
import { PHRASE_LABEL, type Phrase } from '../engine/phrases';
import type { WavePeaks } from '../engine/types';
import { fitCanvas, readPalette, useFrame, type FrameLoop, type Palette } from './frame';
import { gridEdit } from './gridEdit';
import s from '../platter.module.css';

/* Bands nest: lows (usually the biggest) at the back, highs at the front, so
   each band shows as a layer inside the one behind it. Mids and highs are
   drawn a touch smaller so a loud hi-hat can't paper over the kick. */
const BAND_GAIN = { low: 1, mid: 0.8, high: 0.6 };

function bandHeight(v: number, gain: number, half: number) {
  return Math.min(1, (v / 255) ** 0.8 * gain) * half;
}

function usePalette(ref: React.RefObject<HTMLElement | null>) {
  const pal = useRef<Palette | null>(null);
  useEffect(() => {
    const el = ref.current?.closest('[data-dj-root]');
    if (!el) return;
    const read = () => {
      pal.current = readPalette(el);
    };
    read();
    // The rig keeps its own colours, but re-read if the site theme flips in
    // case a token ever starts following it.
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [ref]);
  return pal;
}

/** Fills one band's columns for the time span [t0, t0 + w/pps). */
function drawBand(
  g: CanvasRenderingContext2D,
  data: Uint8Array,
  rate: number,
  t0: number,
  pps: number,
  w: number,
  mid: number,
  half: number,
  gain: number,
) {
  const len = data.length;
  g.beginPath();
  for (let x = 0; x < w; x++) {
    const a = Math.floor((t0 + x / pps) * rate);
    const b = Math.max(a + 1, Math.floor((t0 + (x + 1) / pps) * rate));
    let m = 0;
    for (let i = Math.max(0, a); i < Math.min(b, len); i++) if (data[i] > m) m = data[i];
    if (!m) continue;
    const y = bandHeight(m, gain, half);
    g.rect(x, mid - y, 1, y * 2);
  }
  g.fill();
}

function drawPeaks(g: CanvasRenderingContext2D, p: WavePeaks, pal: Palette, t0: number, pps: number, w: number, h: number) {
  const mid = h / 2;
  const half = h / 2 - 1;
  g.fillStyle = pal.low;
  drawBand(g, p.low, p.rate, t0, pps, w, mid, half, BAND_GAIN.low);
  g.fillStyle = pal.mid;
  drawBand(g, p.mid, p.rate, t0, pps, w, mid, half, BAND_GAIN.mid);
  g.fillStyle = pal.high;
  drawBand(g, p.high, p.rate, t0, pps, w, mid, half, BAND_GAIN.high);
}

/* ── Phrases ─────────────────────────────────────────────────────────────── */

/** How strongly a phrase tints the waveform behind it. */
const PHRASE_TINT = 0.11;
/** Height of the phrase band along the foot. */
const PHRASE_BAND = 3;

/**
 * The phrases over [t0, t0 + w/pps): a faint tint of each phrase's colour
 * behind the waveform and a solid band along the foot. With `labels`, each
 * phrase's name and length sit on the band, held on screen while any of the
 * phrase is, so the one playing is always named.
 */
function drawPhrases(g: CanvasRenderingContext2D, list: readonly Phrase[], P: Palette, xOf: (t: number) => number, w: number, h: number, labels: boolean) {
  for (const p of list) {
    const x0 = Math.round(xOf(p.start));
    const x1 = Math.round(xOf(p.end));
    if (x1 < 0 || x0 > w) continue;
    const color = P.phrase[p.kind];
    g.fillStyle = color;
    g.globalAlpha = PHRASE_TINT;
    g.fillRect(x0, 0, x1 - x0, h);
    g.globalAlpha = 1;
    // A pixel's gap between neighbours, so two of a kind read as two.
    g.fillRect(x0, h - PHRASE_BAND, Math.max(1, x1 - x0 - 1), PHRASE_BAND);
  }
  if (!labels) return;
  for (const p of list) {
    const x0 = Math.round(xOf(p.start));
    const x1 = Math.round(xOf(p.end));
    if (x1 < 0 || x0 > w) continue;
    const name = PHRASE_LABEL[p.kind].toUpperCase();
    const bars = String(p.bars);
    g.font = `700 10px ${P.label}`;
    const nw = g.measureText(name).width;
    g.font = `500 9px ${P.mono}`;
    const bw = g.measureText(bars).width;
    const tw = nw + 4 + bw + 8;
    // Just after the phrase's start (clear of a hot cue's letter there, as
    // cues often sit on a drop), or at the left edge while it runs on past it.
    const x = Math.min(x0 >= 0 ? x0 + 16 : 2, x1 - tw - 2);
    if (x < x0 || x1 - x0 < tw + 18) continue;
    const y = h - PHRASE_BAND - 14;
    g.fillStyle = P.bg;
    g.globalAlpha = 0.78;
    g.fillRect(x, y, tw, 13);
    g.globalAlpha = 1;
    g.fillStyle = P.phrase[p.kind];
    g.fillRect(x, y, 2, 13);
    g.font = `700 10px ${P.label}`;
    g.fillText(name, x + 5, y + 10);
    g.fillStyle = P.text;
    g.font = `500 9px ${P.mono}`;
    g.fillText(bars, x + 5 + nw + 4, y + 10);
  }
}

/* ── The scrolling, zoomed waveform ──────────────────────────────────────── */

/** How near (px) a pointer has to be to a loop edge to grab it. */
const EDGE_GRAB = 10;

/** The loop's region on the scrolling waveform: shaded, with in and out
 *  markers and its length in beats; the edge being adjusted is drawn bright
 *  with a handle. A loop Reloop can bring back is outlined faintly, and a
 *  manual in point waiting for Loop Out gets its own marker. */
function drawLoop(g: CanvasRenderingContext2D, st: DeckState, P: Palette, xOf: (t: number) => number, w: number, h: number) {
  const lp = st.loop;
  if (lp.active) {
    const x0 = xOf(lp.start);
    const x1 = xOf(lp.end);
    g.fillStyle = P.loop;
    g.fillRect(x0, 0, x1 - x0, h);
    const edge = (x: number, picked: boolean, dir: 1 | -1) => {
      if (x < -12 || x > w + 12) return;
      g.fillStyle = picked ? P.bright : P.ok;
      g.fillRect(Math.round(x) - (picked ? 1 : 0), 0, picked ? 3 : 2, h);
      // A small flag pointing into the loop, top and bottom.
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + dir * (picked ? 9 : 6), 0);
      g.lineTo(x, picked ? 9 : 6);
      g.moveTo(x, h);
      g.lineTo(x + dir * (picked ? 9 : 6), h);
      g.lineTo(x, h - (picked ? 9 : 6));
      g.fill();
    };
    const picked = st.loopEdge;
    edge(x0, picked === 'in', 1);
    edge(x1, picked === 'out', -1);
    // The length, top right inside the loop (clear of the deck tags at the
    // top left), kept on screen while it scrolls.
    const text = `${loopLabel(lp.beats)} ${lp.beats === 1 ? 'beat' : 'beats'}`;
    g.font = `600 12px ${P.mono}`;
    const tw = g.measureText(text).width;
    if (x1 - x0 > tw + 16) {
      const tx = Math.max(x0 + 8, Math.min(x1 - tw - 8, w - tw - 6));
      g.fillStyle = P.ok;
      g.fillText(text, tx, 22);
    }
  } else if (lp.end > lp.start) {
    // Reloop's loop: a faint outline of where it would go back to.
    g.fillStyle = P.line;
    for (const t of [lp.start, lp.end]) {
      const x = Math.round(xOf(t));
      if (x < -2 || x > w + 2) continue;
      for (let y = 0; y < h; y += 8) g.fillRect(x, y, 1, 4);
    }
  }
  if (st.loopInPoint !== null && !lp.active) {
    const x = Math.round(xOf(st.loopInPoint));
    if (x >= -12 && x <= w + 12) {
      g.fillStyle = P.ok;
      g.fillRect(x, 0, 2, h);
      g.font = `600 11px ${P.mono}`;
      g.fillText('IN', x + 5, 22);
    }
  }
}

export function ScrollingWave({ deck, loop, zoom, label }: { deck: Deck; loop: FrameLoop; zoom: number; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pal = usePalette(canvas);
  // Where the last frame put the track, so a drag on a loop edge knows what
  // time is under the pointer.
  const view = useRef({ t0: 0, pps: 1 });
  // A drag moves the edge by how far the pointer has moved, not to the time
  // under it: under a running loop the waveform jumps back at every pass.
  const dragging = useRef<{ edge: 'in' | 'out'; x: number; t: number } | null>(null);

  useFrame(loop, () => {
    const c = canvas.current;
    const P = pal.current;
    if (!c || !P) return;
    const { w, h, dpr } = fitCanvas(c);
    const g = c.getContext('2d');
    if (!g || !w) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = P.bg;
    g.fillRect(0, 0, w, h);

    const st = deck.store.get();
    const cx = Math.round(w / 2);
    // `zoom` seconds as heard, not as cut: a deck pitched up shows more of
    // its track, so two decks at the same tempo show beats the same width
    // apart and line up across the two waveforms.
    const pps = w / (zoom * deck.motor()); // px per track second
    if (st.track) {
      const pos = deck.position();
      const t0 = pos - cx / pps;
      const xOf = (t: number) => (t - t0) * pps;
      view.current = { t0, pps };

      if (st.phrases) drawPhrases(g, st.phrases, P, xOf, w, h, true);
      drawLoop(g, st, P, xOf, w, h);
      // Hot loops: a faint band of the cue's colour over the loop.
      g.globalAlpha = 0.16;
      st.hotCues.forEach((c) => {
        if (!c?.loop) return;
        g.fillStyle = P.hot[c.color] ?? P.hot[0];
        g.fillRect(xOf(c.t), 0, (c.loop.end - c.t) * pps, h);
      });
      g.globalAlpha = 1;
      if (st.track.peaks) drawPeaks(g, st.track.peaks, P, t0, pps, w, h);

      if (st.bpm) {
        const beat = 60 / st.bpm;
        const first = Math.ceil((t0 - st.gridOffset) / beat);
        const last = Math.floor((t0 + w / pps - st.gridOffset) / beat);
        // Grid edit: every beat full height and numbered in its bar, the
        // ones in the cue colour, so a misplaced grid shows at a glance.
        const editing = gridEdit.get().on[deck.index];
        if (editing) g.font = `600 10px ${P.mono}`;
        for (let k = first; k <= last; k++) {
          const x = Math.round(xOf(st.gridOffset + k * beat)) + 0.5;
          const n = ((k % 4) + 4) % 4;
          const bar = n === 0;
          if (editing) {
            g.fillStyle = bar ? P.cue : P.bar;
            g.fillRect(x - (bar ? 0.5 : 0), 0, bar ? 2 : 1, h);
            g.fillText(String(n + 1), x + 3, 20);
            continue;
          }
          g.fillStyle = bar ? P.bar : P.grid;
          g.fillRect(x, 0, 1, bar ? h : 6);
          if (!bar) g.fillRect(x, h - 6, 1, 6);
        }
      }

      const marker = (t: number, color: string, text?: string) => {
        const x = Math.round(xOf(t));
        if (x < -10 || x > w + 10) return;
        g.fillStyle = color;
        g.fillRect(x, 0, 2, h);
        g.beginPath();
        g.moveTo(x - 5, 0);
        g.lineTo(x + 7, 0);
        g.lineTo(x + 1, 8);
        g.fill();
        if (text) {
          g.font = `600 13px ${P.mono}`;
          g.fillText(text, x + 5, h - 4);
        }
      };
      // Memory cues: a small notch at the foot, under everything else.
      g.fillStyle = P.memory;
      for (const m of st.memoryCues) {
        const x = Math.round(xOf(m));
        if (x < -6 || x > w + 6) continue;
        g.beginPath();
        g.moveTo(x - 4, h);
        g.lineTo(x + 4, h);
        g.lineTo(x, h - 6);
        g.fill();
      }
      marker(st.cue, P.cue);
      st.hotCues.forEach((c, i) => {
        if (!c) return;
        const color = P.hot[c.color] ?? P.hot[0];
        marker(c.t, color, hotLetter(i));
        // A hot loop's end: a short bracket at the top.
        if (c.loop) {
          const x = Math.round(xOf(c.loop.end));
          if (x < -6 || x > w + 6) return;
          g.fillStyle = color;
          g.fillRect(x - 1, 0, 2, 12);
          g.fillRect(x - 6, 0, 6, 2);
        }
      });
    }

    // Slip's shadow: where the track will be when the scratch, roll or
    // reverse ends.
    const slip = st.track ? deck.slipPosition() : null;
    if (slip !== null) {
      const x = Math.round(cx + (slip - deck.position()) * pps);
      g.fillStyle = P.ghost;
      for (let y = 0; y < h; y += 6) g.fillRect(x - 1, y, 2, 3);
    }

    g.fillStyle = P.playhead;
    g.fillRect(cx - 1, 0, 2, h);
  });

  /** The loop edge under the pointer, if a loop is running. */
  const edgeAt = (e: PointerEvent<HTMLCanvasElement>): 'in' | 'out' | null => {
    const st = deck.store.get();
    if (!st.loop.active) return null;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const { t0, pps } = view.current;
    const dIn = Math.abs((st.loop.start - t0) * pps - x);
    const dOut = Math.abs((st.loop.end - t0) * pps - x);
    if (Math.min(dIn, dOut) > EDGE_GRAB) return null;
    return dIn <= dOut ? 'in' : 'out';
  };

  return (
    <canvas
      ref={canvas}
      className={s.wave}
      aria-label={label}
      role="img"
      // Dragging a loop edge sideways; a vertical swipe still scrolls the page.
      style={{ touchAction: 'pan-y' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const edge = edgeAt(e);
        if (!edge) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const lp = deck.store.get().loop;
        dragging.current = { edge, x: e.clientX, t: edge === 'in' ? lp.start : lp.end };
        deck.selectLoopEdge(edge);
      }}
      onPointerMove={(e) => {
        const d = dragging.current;
        if (d) {
          // On the quantise grid, unless Shift is held.
          deck.setLoopEdge(d.edge, d.t + (e.clientX - d.x) / view.current.pps, !e.shiftKey);
          return;
        }
        if (e.pointerType === 'mouse') e.currentTarget.style.cursor = edgeAt(e) ? 'ew-resize' : '';
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
    />
  );
}

/* ── The whole-track overview, which is also the needle-drop control ────── */

export function Overview({ deck, loop }: { deck: Deck; loop: FrameLoop }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pal = usePalette(canvas);
  const cache = useRef<{ key: WavePeaks | null; phrases: Phrase[] | null; w: number; h: number; img: HTMLCanvasElement | null }>({
    key: null,
    phrases: null,
    w: 0,
    h: 0,
    img: null,
  });
  const lastSecond = useRef(-1);
  const dragging = useRef(false);

  useFrame(loop, () => {
    const c = canvas.current;
    const P = pal.current;
    if (!c || !P) return;
    const { w, h, dpr } = fitCanvas(c);
    const g = c.getContext('2d');
    if (!g || !w) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = P.bg;
    g.fillRect(0, 0, w, h);
    const st = deck.store.get();
    const track = st.track;
    if (!track) {
      c.setAttribute('aria-valuetext', 'No track loaded');
      return;
    }
    const pps = w / track.duration;

    // The overview only changes with the track or the canvas size: draw it
    // once offscreen and blit it each frame.
    const ch = cache.current;
    if (track.peaks && (ch.key !== track.peaks || ch.phrases !== st.phrases || ch.w !== c.width || ch.h !== c.height)) {
      const img = ch.img ?? document.createElement('canvas');
      img.width = c.width;
      img.height = c.height;
      const ig = img.getContext('2d')!;
      ig.setTransform(dpr, 0, 0, dpr, 0, 0);
      ig.clearRect(0, 0, w, h);
      if (st.phrases) drawPhrases(ig, st.phrases, P, (t) => t * pps, w, h, false);
      drawPeaks(ig, track.peaks, P, 0, pps, w, h);
      cache.current = { key: track.peaks, phrases: st.phrases, w: c.width, h: c.height, img };
    }
    if (track.peaks && cache.current.img) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(cache.current.img, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const pos = deck.position();
    const x = pos * pps;
    g.fillStyle = P.played;
    g.fillRect(0, 0, x, h);
    if (st.loop.active) {
      g.fillStyle = P.loop;
      g.fillRect(st.loop.start * pps, 0, Math.max(2, (st.loop.end - st.loop.start) * pps), h);
    } else if (st.loop.end > st.loop.start) {
      g.fillStyle = P.line;
      g.fillRect(st.loop.start * pps, 0, Math.max(2, (st.loop.end - st.loop.start) * pps), 3);
    }
    if (st.loopInPoint !== null && !st.loop.active) {
      g.fillStyle = P.ok;
      g.fillRect(st.loopInPoint * pps, 0, 2, h);
    }
    g.fillStyle = P.memory;
    for (const m of st.memoryCues) g.fillRect(Math.round(m * pps), 0, 2, 5);
    g.fillStyle = P.cue;
    g.fillRect(st.cue * pps, 0, 2, h);
    // Hot cues: a flag in the cue's colour with its letter; a hot loop also
    // shows its span along the foot.
    g.font = `700 9px ${P.mono}`;
    g.textBaseline = 'alphabetic';
    st.hotCues.forEach((c, i) => {
      if (!c) return;
      const hx = Math.round(c.t * pps);
      g.fillStyle = P.hot[c.color] ?? P.hot[0];
      if (c.loop) g.fillRect(hx, h - 3, Math.max(3, (c.loop.end - c.t) * pps), 3);
      g.fillRect(hx, h - 12, 9, 12);
      g.fillStyle = P.bg;
      g.fillText(hotLetter(i), hx + 2, h - 3);
    });
    g.fillStyle = P.playhead;
    g.fillRect(Math.round(x) - 1, 0, 2, h);

    const sec = Math.floor(pos);
    if (sec !== lastSecond.current) {
      lastSecond.current = sec;
      c.setAttribute('aria-valuenow', String(sec));
      c.setAttribute('aria-valuemax', String(Math.floor(track.duration)));
      c.setAttribute('aria-valuetext', `${formatTime(pos)} of ${formatTime(track.duration)}`);
    }
  });

  const seekTo = (e: PointerEvent<HTMLCanvasElement>) => {
    const track = deck.store.get().track;
    if (!track) return;
    const r = e.currentTarget.getBoundingClientRect();
    deck.seek(((e.clientX - r.left) / r.width) * track.duration);
  };

  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const bar = deck.beatLength() * 4;
    const by = e.shiftKey ? 8 * bar : bar;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') deck.shift(by);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') deck.shift(-by);
    else if (e.key === 'Home') deck.seek(deck.store.get().cue);
    else return;
    e.preventDefault();
  };

  return (
    <canvas
      ref={canvas}
      className={s.overview}
      role="slider"
      tabIndex={0}
      aria-label={`Deck ${deck.label} position — click to drop the needle; arrows move a bar, Shift for eight`}
      aria-valuemin={0}
      // Kept current from the draw loop (setAttribute), not React state —
      // a re-render per second per deck would be all cost.
      aria-valuenow={0}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekTo(e);
      }}
      onPointerMove={(e) => dragging.current && seekTo(e)}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={onKey}
    />
  );
}

export function formatTime(t: number) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
