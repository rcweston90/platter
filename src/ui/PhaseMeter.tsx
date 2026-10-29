import { useRef } from 'react';
import type { Deck } from '../engine/deck';
import { fitCanvas, readPalette, useFrame, type FrameLoop, type Palette } from './frame';
import s from '../platter.module.css';

/** Beats into the current bar (0–4) and the fraction of the beat. */
function barPhase(deck: Deck) {
  const st = deck.store.get();
  if (!st.track || !st.bpm) return null;
  const beats = (deck.position() - st.gridOffset) / (60 / st.bpm);
  return ((beats % 4) + 4) % 4;
}

/**
 * The beat-matching aid between the two waveforms: each deck's position in
 * its four-beat bar, and how far apart their beats are. When the right-hand
 * marker sits on the centre line (and turns green), the kicks land together.
 */
export function PhaseMeter({ decks, loop }: { decks: [Deck, Deck]; loop: FrameLoop }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pal = useRef<Palette | null>(null);

  useFrame(loop, () => {
    const c = canvas.current;
    if (!c) return;
    if (!pal.current) {
      const root = c.closest('[data-dj-root]');
      if (!root) return;
      pal.current = readPalette(root);
    }
    const P = pal.current;
    const { w, h, dpr } = fitCanvas(c);
    const g = c.getContext('2d');
    if (!g || !w) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = P.bg;
    g.fillRect(0, 0, w, h);

    const bars = w * 0.72;
    const cell = bars / 4;
    const row = (h - 2) / 2;
    const phases = decks.map(barPhase);
    phases.forEach((p, i) => {
      const y = i * (row + 2);
      for (let k = 0; k < 4; k++) {
        const lit = p !== null && Math.floor(p) === k;
        g.fillStyle = lit ? (i === 0 ? P.a : P.b) : P.line;
        g.fillRect(k * cell + 1, y, cell - 2, row);
      }
    });

    // Offset gauge: beat-phase difference, −½…+½ beat.
    const gx = bars + 12;
    const gw = w - gx;
    const mid = gx + gw / 2;
    g.fillStyle = P.line;
    g.fillRect(gx, h / 2 - 1, gw, 2);
    g.fillStyle = P.text;
    g.fillRect(mid - 1, 0, 2, h);
    const [a, b] = phases;
    if (a !== null && b !== null && decks[0].store.get().playing && decks[1].store.get().playing) {
      let d = (b % 1) - (a % 1);
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      g.fillStyle = Math.abs(d) < 0.03 ? P.ok : P.cue;
      g.fillRect(mid + d * gw - 3, 2, 6, h - 4);
    }
  });

  return (
    <canvas
      ref={canvas}
      className={s.phase}
      role="img"
      aria-label="Phase meter: each deck's beat in the bar, and how far apart the two decks' beats are"
    />
  );
}
