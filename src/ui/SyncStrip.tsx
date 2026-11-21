import { useRef, useState } from 'react';
import { wrapHalf, type Deck } from '../engine/deck';
import { fitCanvas, readPalette, useFrame, type FrameLoop, type Palette } from './frame';
import s from '../platter.module.css';

type Tone = 'ok' | 'warn' | 'dim';

interface Pair {
  /** The deck being matched (the follower when synced; else B). */
  f: Deck;
  /** The deck it's matched to (the leader when synced; else A). */
  l: Deck;
  synced: boolean;
  /** Follower beats per leader beat. */
  mul: number;
}

/** Who is matched to whom. Unsynced, B is read against A, at double or
 *  half time when that's the closer match. */
function pairOf([a, b]: [Deck, Deck]): Pair | null {
  const sa = a.store.get();
  const sb = b.store.get();
  if (!sa.track || !sb.track || !sa.bpm || !sb.bpm) return null;
  if (sa.sync) return { f: a, l: b, synced: true, mul: a.syncMultiple() };
  if (sb.sync) return { f: b, l: a, synced: true, mul: b.syncMultiple() };
  const ratio = b.effectiveBpm()! / a.effectiveBpm()!;
  return { f: b, l: a, synced: false, mul: 2 ** Math.max(-1, Math.min(1, Math.round(Math.log2(ratio)))) };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

interface Readout {
  tempo: string;
  tempoTone: Tone;
  phase: string;
  phaseTone: Tone;
  /** The beats (not the bars) land together. */
  beatsTogether?: boolean;
}

/** The words in the two readouts: how the tempos compare, and where the
 *  beats and bars sit against each other. */
function readout(p: Pair | null): Readout & { bars: number | null; nudged: boolean } {
  const none = { tempo: '', tempoTone: 'dim' as Tone, phase: '', phaseTone: 'dim' as Tone, bars: null, nudged: false };
  if (!p) return none;
  const { f, l, synced, mul } = p;
  const fs = f.store.get();
  const ls = l.store.get();
  const F = f.label;
  const L = l.label;
  const time = mul === 2 ? ' · double time' : mul === 0.5 ? ' · half time' : '';

  let tempo: string;
  let tempoTone: Tone;
  let matched: boolean;
  if (synced) {
    matched = f.tempoLocked();
    tempo = matched ? `Tempo locked${time}` : `${L}'s tempo is out of ${F}'s pitch range`;
    tempoTone = matched ? 'ok' : 'warn';
  } else {
    const diff = (f.effectiveBpm()! / (l.effectiveBpm()! * mul) - 1) * 100;
    matched = Math.abs(diff) < 0.05;
    tempo = matched ? `Tempos match${time}` : `${F} ${Math.abs(diff).toFixed(1)}% ${diff > 0 ? 'faster' : 'slower'}${time}`;
    tempoTone = matched ? 'ok' : 'warn';
  }

  // Phase only means something while both play; while one waits, say what
  // Sync will do when it starts.
  if (!fs.playing || !ls.playing) {
    if (!synced || (!fs.playing && !ls.playing)) return { ...none, tempo, tempoTone };
    const starter = fs.playing ? L : F;
    const other = fs.playing ? F : L;
    return { tempo, tempoTone, phase: `${starter} will start on ${other}'s beat`, phaseTone: 'dim', bars: null, nudged: false };
  }
  if (!matched) {
    const phase = synced ? "Beats can't lock at this tempo" : 'Beats drifting apart · press Sync';
    return { tempo, tempoTone, phase, phaseTone: 'warn', bars: null, nudged: false };
  }

  const err = synced ? f.phaseError()! : wrapHalf(f.beatPosition()! - l.beatPosition()! * mul);
  const ms = Math.round(((err * 60) / fs.bpm! / f.motor()) * 1000);
  const offsetMs = Math.round(((fs.syncOffset * 60) / fs.bpm! / f.motor()) * 1000);
  const nudged = synced && offsetMs !== 0;
  const beatsTogether = Math.abs(ms) <= 5;
  let phase = beatsTogether ? 'In phase' : `${F} ${Math.abs(ms)} ms ${ms > 0 ? 'early' : 'late'}`;
  let phaseTone: Tone = Math.abs(ms) <= 5 ? 'ok' : 'warn';
  if (nudged) phase += ` · nudged ${offsetMs > 0 ? '+' : '−'}${Math.abs(offsetMs)} ms`;

  let bars: number | null = null;
  if (synced) {
    bars = f.barOffset();
  } else {
    const d = (((Math.round(f.beatPosition()! - l.beatPosition()! * mul)) % 4) + 4) % 4;
    bars = d > 2 ? d - 4 : d;
  }
  if (bars === 0) phase += ' · on the 1';
  else if (bars !== null) {
    phase += ` · ${F}'s 1 is ${plural(Math.abs(bars), 'beat')} ${bars > 0 ? 'early' : 'late'}`;
    if (phaseTone === 'ok') phaseTone = 'warn';
  }
  return { tempo, tempoTone, phase, phaseTone, bars, nudged, beatsTogether };
}

/**
 * Between the two waveforms: how the decks line up, at a glance.
 *
 * The ruler draws each deck's beat grid around the playhead on the waveforms'
 * own (heard) time scale — A's ticks hang from the top, B's rise from the
 * bottom, bars long and in the deck's colour. Matched and in phase, the ticks
 * meet in straight lines; out of phase they stagger, and a bracket at the
 * playhead spans the gap. The readouts say it in words: how the tempos
 * compare (or that they're locked), how many ms apart the beats are, and
 * whether the bars start together.
 */
export function SyncStrip({ decks, loop, zoom }: { decks: [Deck, Deck]; loop: FrameLoop; zoom: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pal = useRef<Palette | null>(null);
  const tempoEl = useRef<HTMLSpanElement>(null);
  const phaseEl = useRef<HTMLSpanElement>(null);
  const phaseWrap = useRef<HTMLSpanElement>(null);
  const last = useRef('');
  // Only which buttons show is React state; the words change every frame
  // and go straight to the DOM.
  const [actions, setActions] = useState<{ bars: boolean; nudged: boolean; follower: string }>({ bars: false, nudged: false, follower: '' });

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

    const pair = pairOf(decks);
    const r = readout(pair);
    const cx = Math.round(w / 2);
    const mid = h / 2;

    // Beat ticks, A from the top and B from the bottom, in heard time.
    const nearest: (number | null)[] = [null, null];
    decks.forEach((d, i) => {
      const st = d.store.get();
      if (!st.track || !st.bpm) return;
      const pos = d.position();
      const beat = 60 / st.bpm;
      const pps = w / (zoom * d.motor()); // px per track second
      const t0 = pos - cx / pps;
      const first = Math.ceil((t0 - st.gridOffset) / beat);
      const lastBeat = Math.floor((t0 + w / pps - st.gridOffset) / beat);
      const deckColor = i === 0 ? P.a : P.b;
      g.fillStyle = deckColor;
      for (let k = first; k <= lastBeat; k++) {
        const x = Math.round((st.gridOffset + k * beat - t0) * pps);
        const bar = ((k % 4) + 4) % 4 === 0;
        // Bars reach the centre line, so lined-up bars join into one line.
        const len = bar ? mid : mid * 0.6;
        g.globalAlpha = bar ? 1 : 0.45;
        g.fillRect(x - (bar ? 1 : 0), i === 0 ? 0 : h - len, bar ? 2 : 1, len);
        if (nearest[i] === null || Math.abs(x - cx) < Math.abs(nearest[i]! - cx)) nearest[i] = x;
      }
      g.globalAlpha = 1;
    });

    // The gap at the playhead: from A's nearest beat to B's.
    const [xa, xb] = nearest;
    const bothPlaying = decks.every((d) => d.store.get().playing);
    if (xa !== null && xb !== null && bothPlaying && r.phase) {
      const tone = r.beatsTogether ? P.ok : P.cue;
      g.fillStyle = tone;
      const x0 = Math.min(xa, xb);
      const span = Math.abs(xb - xa);
      if (span >= 2) g.fillRect(x0, mid - 2, span, 4);
      else g.fillRect(xa - 3, mid - 2, 6, 4);
    }

    g.fillStyle = P.playhead;
    g.fillRect(cx - 1, 0, 2, h);

    const put = (el: HTMLElement | null, box: HTMLElement | null, text: string, tone: Tone) => {
      if (!el || !box) return;
      if (el.textContent !== text) el.textContent = text;
      box.dataset.tone = tone;
      box.toggleAttribute('data-empty', !text);
    };
    put(tempoEl.current, tempoEl.current, r.tempo, r.tempoTone);
    put(phaseEl.current, phaseWrap.current, r.phase, r.phaseTone);

    const next = {
      bars: !!pair?.synced && r.bars !== null && r.bars !== 0,
      nudged: r.nudged,
      follower: pair?.synced ? pair.f.label : '',
    };
    const key = JSON.stringify(next);
    if (key !== last.current) {
      last.current = key;
      setActions(next);
    }
  });

  const follower = decks.find((d) => d.label === actions.follower);

  return (
    <div className={s.syncStrip} role="group" aria-label="How the two decks line up">
      <canvas
        ref={canvas}
        className={s.syncRuler}
        role="img"
        aria-label="Beat ruler: deck A's beats from the top, deck B's from the bottom; where they meet in a line, the beats land together"
      />
      <span className={s.syncRead} data-side="tempo" data-empty ref={tempoEl} />
      <span className={s.syncRead} data-side="phase" data-empty ref={phaseWrap}>
        <span ref={phaseEl} />
        {actions.bars && follower && (
          <button
            type="button"
            className={s.syncAct}
            onClick={() => follower.alignBars()}
            title={`Jump deck ${follower.label} by whole beats so its bars start with deck ${follower.other?.label}'s`}
          >
            Line up bars
          </button>
        )}
        {actions.nudged && follower && (
          <button
            type="button"
            className={s.syncAct}
            onClick={() => follower.resetSyncOffset()}
            aria-label={`Reset deck ${follower.label}'s nudge`}
            title="Forget the nudge: put the beats back together"
          >
            Reset
          </button>
        )}
      </span>
    </div>
  );
}
