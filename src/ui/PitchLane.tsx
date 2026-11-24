import { useEffect, useRef } from 'react';
import type { Deck } from '../engine/deck';
import { formatHz, noteName, type BeatHit, type DeckHits } from '../engine/hits';
import { fitCanvas, readPalette, useFrame, type FrameLoop, type Palette } from './frame';
import s from '../platter.module.css';

/**
 * Beat pitch: each hit on the deck as a short bar, as high in the lane as it
 * sounds next to the hits around it, so a loop reads like a piano roll.
 * Notes (an 808, a pluck, a stab) are solid and named; drum hits are hollow
 * and placed by how bright they are (a kick low, a snare in the middle, a
 * hat high). With notes about, the lane is scaled to the notes, and a drum
 * that sounds above or below all of them is a thin mark on that edge. The hit you are hearing lights up, and the readout says how far
 * it sits above or below the one before.
 *
 * Without a loop the lane scrolls with the waveform beside it, in the same
 * heard time and zoom. With a loop on, it holds still and shows the loop's
 * hits across its width, with the playhead sweeping through, so the pattern
 * stays put while it repeats.
 */

/** Fewest semitones the lane spans: an octave, so one wide step doesn't
 *  look like a leap. */
const MIN_SPAN = 12;
/** Room above the top hit and under the bottom one (semitones). */
const PAD_SEMIS = 1.5;
/** Fraction of the way to the new range per frame while playing. */
const EASE = 0.18;
/** A hit stays lit at least this long (s) after it starts. */
const LIT_MIN = 0.12;

function firstEndingAfter(hits: BeatHit[], t: number) {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (hits[m].end < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function lastStartingBy(hits: BeatHit[], t: number) {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (hits[m].t <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

/** Low and high semitone of a set of hits, the outer 5 % dropped once
 *  there are enough to spare. */
function rangeOf(semis: number[]): [number, number] | null {
  if (!semis.length) return null;
  semis.sort((a, b) => a - b);
  const trim = semis.length >= 20 ? Math.floor(semis.length * 0.05) : 0;
  let lo = semis[trim] - PAD_SEMIS;
  let hi = semis[semis.length - 1 - trim] + PAD_SEMIS;
  if (hi - lo < MIN_SPAN) {
    const mid = (lo + hi) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  return [lo, hi];
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(h / 2, w / 2, 3);
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

export function PitchLane({ deck, hits, loop, zoom }: { deck: Deck; hits: DeckHits; loop: FrameLoop; zoom: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pal = useRef<Palette | null>(null);
  const range = useRef<{ lo: number; hi: number; key: unknown } | null>(null);

  useEffect(() => {
    const el = canvas.current?.closest('[data-dj-root]');
    if (el) pal.current = readPalette(el);
  }, []);
  useEffect(() => hits.store.subscribe(() => loop.kick()), [hits, loop]);

  useFrame(loop, () => {
    const c = canvas.current;
    const P = pal.current;
    if (!c || !P) return;
    const { w, h, dpr } = fitCanvas(c);
    const g = c.getContext('2d');
    if (!g || !w || !h) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = P.bg;
    g.fillRect(0, 0, w, h);

    const st = deck.store.get();
    const hs = hits.store.get();
    const colour = deck.index === 0 ? P.a : P.b;
    const small = h < 40;
    const font = (px: number, weight = 500) => `${weight} ${px}px ${P.mono}`;
    const note = (text: string) => {
      g.font = font(small ? 10 : 11);
      g.fillStyle = P.text;
      g.textBaseline = 'middle';
      g.fillText(text, 8, h / 2);
    };
    if (!st.track) return;
    const list = hs.trackId === st.track.id ? hs.hits : null;
    if (!list) {
      note(hs.trackId === st.track.id && hs.status === 'reading' ? 'Reading the hits…' : hs.trackId === st.track.id && hs.status === 'error' ? 'Couldn’t read the hits on this track' : 'Beat pitch shows once the track plays');
      return;
    }
    if (!list.length) {
      note('No hits found on this track');
      return;
    }

    const pos = deck.position();
    const lp = st.loop;
    const looping = lp.active && lp.end - lp.start >= 0.2;
    // Time → x. In a loop the lane holds the loop, inset so the first and last
    // hits aren't cut by the edges.
    const inset = looping ? 6 : 0;
    let t0: number;
    let t1: number;
    let xOf: (t: number) => number;
    if (looping) {
      t0 = lp.start;
      t1 = lp.end;
      const k = (w - 2 * inset) / (t1 - t0);
      xOf = (t) => inset + (t - t0) * k;
    } else {
      const pps = w / (zoom * deck.motor());
      t0 = pos - w / 2 / pps;
      t1 = t0 + w / pps;
      xOf = (t) => (t - t0) * pps;
    }

    // What the lane spans: the loop's hits, or the hits on screen and as
    // many again either side, so it doesn't lurch as a new phrase scrolls in.
    const ctx0 = looping ? t0 : t0 - (t1 - t0);
    const ctx1 = looping ? t1 : t1 + (t1 - t0);
    // Where there are notes, the lane is scaled to them and drums that
    // sound above or below them sit on its edges: a hat's brightness would
    // otherwise squash a bass line into a few pixels. All drums: scaled to
    // the drums.
    const all: number[] = [];
    const notes: number[] = [];
    for (let i = firstEndingAfter(list, ctx0); i < list.length && list[i].t < ctx1; i++) {
      if (looping && list[i].t < t0) continue;
      all.push(list[i].semi);
      if (list[i].tonal) notes.push(list[i].semi);
    }
    const target = rangeOf(notes.length >= Math.max(3, all.length * 0.25) ? notes : all);
    const key = `${st.track.id}:${looping ? `${lp.start}-${lp.end}` : 'scroll'}`;
    if (target) {
      const r = range.current;
      if (!r || r.key !== key || !st.playing) range.current = { lo: target[0], hi: target[1], key };
      else {
        r.lo += (target[0] - r.lo) * EASE;
        r.hi += (target[1] - r.hi) * EASE;
      }
    }
    const R = range.current;
    if (!R) return;
    const padT = small ? 3 : 5;
    const padB = small ? 3 : 5;
    const yOf = (semi: number) => padT + (1 - (semi - R.lo) / (R.hi - R.lo)) * (h - padT - padB);
    /** Above the lane's range (1), below it (−1), or on it (0). */
    const off = (hit: BeatHit) => (hit.semi > R.hi ? 1 : hit.semi < R.lo ? -1 : 0);

    // Heard pitch: the pitch fader moves it unless key lock holds it, and key
    // shift moves it either way.
    const shift = (st.keyLock ? 0 : 12 * Math.log2(deck.motor())) + st.keyShift;
    const label = (hit: BeatHit) => (hit.tonal ? noteName(hit.semi + shift) : `~${formatHz(hit.hz * 2 ** (shift / 12))}`);

    // Octave lines at each C, named at the right edge where they have room.
    const octavePx = ((h - padT - padB) * 12) / (R.hi - R.lo);
    g.font = font(small ? 9 : 10);
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (let m = Math.ceil((R.lo + shift) / 12) * 12; m <= R.hi + shift; m += 12) {
      const y = Math.round(yOf(m - shift)) + 0.5;
      g.fillStyle = P.line;
      g.globalAlpha = 0.5;
      g.fillRect(0, y - 0.5, w, 1);
      g.globalAlpha = 1;
      if (!small && octavePx >= 14 && y > 8 && y < h - 6) {
        g.fillStyle = P.text;
        g.globalAlpha = 0.7;
        g.fillText(noteName(m), w - 4, y - 6);
        g.globalAlpha = 1;
      }
    }
    g.textAlign = 'left';

    // Beat grid, faint: bars a touch stronger.
    if (st.bpm) {
      const beat = 60 / st.bpm;
      const first = Math.ceil((t0 - st.gridOffset) / beat - 1e-6);
      const last = Math.floor((t1 - st.gridOffset) / beat + 1e-6);
      for (let k = first; k <= last; k++) {
        const x = Math.round(xOf(st.gridOffset + k * beat)) + 0.5;
        const bar = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = bar ? P.bar : P.grid;
        g.globalAlpha = bar ? 0.45 : 0.3;
        g.fillRect(x - 0.5, 0, 1, h);
      }
      g.globalAlpha = 1;
    }

    const a = firstEndingAfter(list, t0);
    const visible: BeatHit[] = [];
    for (let i = a; i < list.length && list[i].t < t1; i++) if (!looping || list[i].t >= t0 - 0.005) visible.push(list[i]);

    // The hit being heard, and the one before it (for the readout).
    const ci = lastStartingBy(list, pos);
    const cur = ci >= 0 && pos - list[ci].t < Math.max(LIT_MIN, list[ci].end - list[ci].t) ? list[ci] : null;
    const prev = cur && ci > 0 ? list[ci - 1] : null;

    const thick = (hit: BeatHit) => (small ? 2 : 3) + hit.level * (small ? 3 : 5);
    for (const hit of visible) {
      const x0 = xOf(hit.t);
      const x1 = Math.max(x0 + 4, xOf(Math.min(hit.end, looping ? t1 : hit.end)) - 2);
      const lit = hit === cur;
      const edge = off(hit);
      if (edge) {
        // Off the scale: a thin mark on the edge it went past.
        g.fillStyle = lit ? P.bright : colour;
        g.globalAlpha = lit ? 1 : 0.25 + 0.4 * hit.level;
        g.fillRect(x0, edge > 0 ? 1 : h - 3, x1 - x0, 2);
        g.globalAlpha = 1;
        continue;
      }
      const th = thick(hit);
      const y = yOf(hit.semi) - th / 2;
      const alpha = 0.4 + 0.6 * hit.level;
      if (lit) {
        g.shadowColor = colour;
        g.shadowBlur = 10;
      }
      roundRect(g, x0, y, x1 - x0, th);
      if (hit.tonal) {
        g.fillStyle = lit ? P.bright : colour;
        g.globalAlpha = lit ? 1 : alpha;
        g.fill();
      } else {
        g.fillStyle = lit ? P.bright : colour;
        g.globalAlpha = lit ? 0.5 : alpha * 0.22;
        g.fill();
        g.strokeStyle = lit ? P.bright : colour;
        g.globalAlpha = lit ? 1 : alpha;
        g.lineWidth = 1.25;
        g.stroke();
      }
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }

    // Note names on the notes, where they fit (on a phone, only the lit one).
    if (!small) {
      g.font = font(10, 600);
      g.textBaseline = 'bottom';
      let lastX = -Infinity;
      for (const hit of visible) {
        if (!hit.tonal || off(hit)) continue;
        const x = xOf(hit.t);
        const text = label(hit);
        const tw = g.measureText(text).width;
        if (x - lastX < tw + 6 && hit !== cur) continue;
        // Above the bar, or under it when the bar is at the top.
        const above = yOf(hit.semi) - thick(hit) / 2 - 2;
        const y = above >= 12 ? above : yOf(hit.semi) + thick(hit) / 2 + 12;
        g.fillStyle = hit === cur ? P.bright : P.text;
        g.fillText(text, x, y);
        lastX = x;
      }
    }

    // Playhead.
    const px = looping ? xOf(Math.min(t1, Math.max(t0, pos))) : Math.round(w / 2);
    g.fillStyle = P.playhead;
    g.fillRect(Math.round(px) - 1, 0, 2, h);

    // Readout, top left: the lit hit and its step from the one before.
    // On a phone the lane is short: the note and its step, no name.
    const tag = small ? '' : looping ? 'LOOP' : 'PITCH';
    let text = tag;
    if (cur) {
      text += `${tag ? '  ' : ''}${label(cur)}`;
      if (prev) {
        const d = cur.semi - prev.semi;
        const steps = Math.round(d);
        const both = cur.tonal && prev.tonal;
        if (both && steps === 0) text += '  =';
        else if (Math.abs(d) >= 0.5) text += `  ${d > 0 ? '▲' : '▼'}${both ? Math.abs(steps) : ''}`;
      }
    }
    if (!text) return;
    g.font = font(small ? 10 : 11, 600);
    g.textBaseline = 'middle';
    const tw = g.measureText(text).width;
    const bh = small ? 14 : 16;
    // In a loop, on whichever side the playhead isn't.
    const bx = looping && px < w / 2 ? w - tw - 16 : 4;
    g.fillStyle = 'rgb(10 11 13 / 0.82)';
    roundRect(g, bx, 3, tw + 12, bh);
    g.fill();
    g.fillStyle = cur ? P.bright : P.text;
    g.fillText(text, bx + 6, 3 + bh / 2 + 0.5);
  });

  return <canvas ref={canvas} className={s.pitchLane} aria-label={`Deck ${deck.label} beat pitch: each hit, higher or lower`} role="img" />;
}
