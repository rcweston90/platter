
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { Deck } from '../engine/deck';
import type { WavePeaks } from '../engine/types';
import { fitCanvas, readPalette, useFrame, type FrameLoop, type Palette } from './frame';
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

/* ── The scrolling, zoomed waveform ──────────────────────────────────────── */

export function ScrollingWave({ deck, loop, zoom, label }: { deck: Deck; loop: FrameLoop; zoom: number; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pal = usePalette(canvas);

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
    if (st.track) {
      const pos = deck.position();
      const pps = w / zoom;
      const t0 = pos - cx / pps;
      const xOf = (t: number) => (t - t0) * pps;

      if (st.loop.active) {
        g.fillStyle = P.loop;
        g.fillRect(xOf(st.loop.start), 0, (st.loop.end - st.loop.start) * pps, h);
      }
      if (st.track.peaks) drawPeaks(g, st.track.peaks, P, t0, pps, w, h);

      if (st.bpm) {
        const beat = 60 / st.bpm;
        const first = Math.ceil((t0 - st.gridOffset) / beat);
        const last = Math.floor((t0 + w / pps - st.gridOffset) / beat);
        for (let k = first; k <= last; k++) {
          const x = Math.round(xOf(st.gridOffset + k * beat)) + 0.5;
          const bar = ((k % 4) + 4) % 4 === 0;
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
      marker(st.cue, P.cue);
      st.hotCues.forEach((t, i) => t !== null && marker(t, P.hot[i], String(i + 1)));
    }

    // Slip's shadow: where the track will be when the scratch, roll or
    // reverse ends.
    const slip = st.track ? deck.slipPosition() : null;
    if (slip !== null) {
      const x = Math.round(cx + (slip - deck.position()) * (w / zoom));
      g.fillStyle = P.ghost;
      for (let y = 0; y < h; y += 6) g.fillRect(x - 1, y, 2, 3);
    }

    g.fillStyle = P.playhead;
    g.fillRect(cx - 1, 0, 2, h);
  });

  return <canvas ref={canvas} className={s.wave} aria-label={label} role="img" />;
}

/* ── The whole-track overview, which is also the needle-drop control ────── */

export function Overview({ deck, loop }: { deck: Deck; loop: FrameLoop }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pal = usePalette(canvas);
  const cache = useRef<{ key: WavePeaks | null; w: number; h: number; img: HTMLCanvasElement | null }>({
    key: null,
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
    if (track.peaks && (ch.key !== track.peaks || ch.w !== c.width || ch.h !== c.height)) {
      const img = ch.img ?? document.createElement('canvas');
      img.width = c.width;
      img.height = c.height;
      const ig = img.getContext('2d')!;
      ig.setTransform(dpr, 0, 0, dpr, 0, 0);
      ig.clearRect(0, 0, w, h);
      drawPeaks(ig, track.peaks, P, 0, pps, w, h);
      cache.current = { key: track.peaks, w: c.width, h: c.height, img };
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
    }
    g.fillStyle = P.cue;
    g.fillRect(st.cue * pps, 0, 2, h);
    st.hotCues.forEach((t, i) => {
      if (t === null) return;
      g.fillStyle = P.hot[i];
      g.fillRect(t * pps, h - 6, 3, 6);
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
