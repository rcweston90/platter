import { useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import type { Deck } from '../engine/deck';
import { noteName, type DeckHits, type DrumKind, type StemHits, type StemNote, type StemPart } from '../engine/hits';
import { parseCamelot } from '../engine/key';
import { STEM_LABELS, type DeckStems, type StemName } from '../engine/stems';
import { shallowEqual, useStore, useStoreSelect } from '../engine/store';
import { fitCanvas, readPalette, setText, useFrame, type FrameLoop, type Palette } from './frame';
import { lanesOf, laneView } from './laneView';
import { PitchLane } from './PitchLane';
import s from '../platter.module.css';

/**
 * Beat pitch by stem: once a track's stems are in, each part gets its own
 * lane, in its own colour and in step with the waveform beside it.
 *
 * - Drums sit in three rows, hats over snares over kicks, each hit as long
 *   as it rings and as tall as it hits.
 * - Bass and "other" (keys, pads, plucks, stabs) are a piano roll, one row
 *   per semitone, the rows in the deck's key lit.
 * - Vocals are their notes plus the line the voice actually sings, slides
 *   and vibrato included.
 *
 * The view (laneView) splits the parts into a lane each, pairs them into
 * rhythm and melody, or lays them all in one lane with the drums along its
 * foot. Each lane's chips name its parts and what each plays right now; tap
 * one to mute that part, hold it (or Shift-click) to hear it alone, the same
 * as the stems row on the deck. A part you can't hear fades in the lane.
 *
 * Until the stems are in, the lane shows the whole track's hits (PitchLane)
 * with a note saying the stems are on their way.
 */

/** Fewest semitones a piano roll spans. */
const MIN_SPAN = 12;
const PAD_SEMIS = 1.5;
/** Fraction of the way to the new range per frame while playing. */
const EASE = 0.15;
/** A note or hit stays lit at least this long (s). */
const LIT_MIN = 0.1;
/** How faint a part you can't hear is drawn. */
const GHOST = 0.2;
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
/** Black keys, for shading rows when the key isn't known. */
const BLACK = new Set([1, 3, 6, 8, 10]);
const DRUM_ROWS: DrumKind[] = ['hat', 'snare', 'kick'];
const DRUM_WORD: Record<DrumKind, string> = { kick: 'K', snare: 'S', hat: 'H' };
/** Space between the chips and the lane (px), as in the CSS. */
const GUTTER_GAP = 4;
const PITCHED: Exclude<StemName, 'drums'>[] = ['other', 'bass', 'vocals'];

interface Span {
  t: number;
  end: number;
}

function firstEndingAfter<T extends Span>(list: T[], t: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].end < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function lastStartingBy<T extends Span>(list: T[], t: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].t <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

/** The note or hit sounding at `pos`, if any. */
function litAt<T extends Span>(list: T[], pos: number): { i: number; item: T } | null {
  const i = lastStartingBy(list, pos);
  if (i < 0) return null;
  const item = list[i];
  return pos - item.t < Math.max(LIT_MIN, item.end - item.t) ? { i, item } : null;
}

function rangeOf(semis: number[]): [number, number] | null {
  if (!semis.length) return null;
  semis.sort((a, b) => a - b);
  const trim = semis.length >= 24 ? Math.floor(semis.length * 0.03) : 0;
  let lo = Math.round(semis[trim]) - PAD_SEMIS;
  let hi = Math.round(semis[semis.length - 1 - trim]) + PAD_SEMIS;
  if (hi - lo < MIN_SPAN) {
    const mid = (lo + hi) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  return [lo, hi];
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(h / 2, w / 2, 3));
}

const partOf = (H: StemHits, stem: Exclude<StemName, 'drums'>): StemPart | null => H[stem];
const isEmpty = (H: StemHits, stem: StemName) => (stem === 'drums' ? !H.drums.length : !partOf(H, stem)?.notes.length);

/** Stem chips: tap to mute, hold or Shift-click to solo, like the stems row. */
function useChipPress(stems: DeckStems) {
  const press = useRef<{ timer: number | null; long: boolean }>({ timer: null, long: false });
  const up = () => {
    const p = press.current;
    if (p.timer !== null) window.clearTimeout(p.timer);
    p.timer = null;
  };
  return (stem: StemName) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      const p = press.current;
      p.long = false;
      p.timer = window.setTimeout(() => {
        p.long = true;
        stems.soloStem(stem);
      }, 450);
    },
    onPointerUp: up,
    onPointerCancel: up,
    onPointerLeave: up,
    onClick: (e: MouseEvent) => {
      if (press.current.long) return;
      if (e.shiftKey || e.altKey) stems.soloStem(stem);
      else stems.toggle(stem);
    },
  });
}

function Chip({ stem, stems, deck, readout }: { stem: StemName; stems: DeckStems; deck: string; readout?: (el: HTMLSpanElement | null) => void }) {
  const st = useStore(stems.store);
  const press = useChipPress(stems);
  const heard = stems.heard(stem);
  return (
    <button
      type="button"
      className={`${s.laneChip} ${st.solo === stem ? s.laneChipSolo : ''}`}
      data-stem={stem}
      aria-pressed={heard}
      aria-label={`Deck ${deck} ${STEM_LABELS[stem].toLowerCase()}: tap to mute, hold to hear alone`}
      title={`${STEM_LABELS[stem]}: tap to mute, hold or Shift-click to hear alone`}
      {...press(stem)}
    >
      <span className={s.chipName}>{STEM_LABELS[stem]}</span>
      <span className={s.chipShort} aria-hidden="true">
        {STEM_LABELS[stem][0]}
      </span>
      {readout && <span className={s.chipRead} ref={readout} aria-hidden="true" />}
    </button>
  );
}

function StemLane({
  deck,
  hits,
  stems,
  loop,
  zoom,
  parts,
  first,
  follow,
}: {
  deck: Deck;
  hits: DeckHits;
  stems: DeckStems;
  loop: FrameLoop;
  zoom: number;
  parts: StemName[];
  first: boolean;
  follow: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pal = useRef<Palette | null>(null);
  const range = useRef<{ lo: number; hi: number; key: string } | null>(null);
  const reads = useRef<Partial<Record<StemName, HTMLSpanElement | null>>>({});
  const gutter = useRef<HTMLDivElement>(null);
  /** The waveform runs under the chips too: how far right of its left edge the lane starts (px). */
  const lead = useRef(0);

  useEffect(() => {
    const el = canvas.current?.closest('[data-dj-root]');
    if (el) pal.current = readPalette(el);
  }, []);
  useEffect(() => stems.store.subscribe(() => loop.kick()), [stems, loop]);
  useEffect(() => {
    const el = gutter.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      lead.current = e.contentRect.width + GUTTER_GAP;
      loop.kick();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loop]);

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
    const H = hits.store.get().stems;
    if (!st.track || !H) return;
    const small = h < 30;
    const font = (px: number, weight = 500) => `${weight} ${px}px ${P.mono}`;

    const pos = deck.position();
    const lp = st.loop;
    const looping = lp.active && lp.end - lp.start >= 0.2;
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
      // In step with the waveform, which also runs under the chips: same
      // scale, same playhead, so a hit sits right over its transient.
      const full = w + lead.current;
      const pps = full / (zoom * deck.motor());
      t0 = pos - (full / 2 - lead.current) / pps;
      t1 = t0 + w / pps;
      xOf = (t) => (t - t0) * pps;
    }
    const playX = looping ? xOf(Math.min(t1, Math.max(t0, pos))) : Math.round(xOf(pos));
    const xEnd = (t: number, end: number, minW: number) => Math.max(xOf(t) + minW, xOf(Math.min(end, looping ? t1 : end)) - 1.5);
    const inView = (item: Span) => !looping || item.t >= t0 - 0.005;
    const faded = (stem: StemName) => follow && !stems.heard(stem);
    const colour = (stem: StemName) => P.stem[stem] || P.bright;

    // Beat grid, faint; bars a touch stronger.
    if (st.bpm) {
      const beat = 60 / st.bpm;
      const firstBeat = Math.ceil((t0 - st.gridOffset) / beat - 1e-6);
      const lastBeat = Math.floor((t1 - st.gridOffset) / beat + 1e-6);
      for (let k = firstBeat; k <= lastBeat; k++) {
        const x = Math.round(xOf(st.gridOffset + k * beat)) + 0.5;
        const bar = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = bar ? P.bar : P.grid;
        g.globalAlpha = bar ? 0.4 : 0.22;
        g.fillRect(x - 0.5, 0, 1, h);
      }
      g.globalAlpha = 1;
    }

    const hasDrums = parts.includes('drums');
    const pitched = PITCHED.filter((p) => parts.includes(p));
    const drumH = hasDrums ? (pitched.length ? Math.max(12, Math.min(30, Math.round(h * 0.32))) : h) : 0;
    const rollBottom = h - drumH;

    /* ── Piano roll: bass, other, vocals ─────────────────────────────── */
    const shift = (st.keyLock ? 0 : 12 * Math.log2(deck.motor())) + st.keyShift;
    if (pitched.length && rollBottom > 8) {
      const ctx0 = looping ? t0 : t0 - (t1 - t0);
      const ctx1 = looping ? t1 : t1 + (t1 - t0);
      const semis: number[] = [];
      for (const stem of pitched) {
        const part = partOf(H, stem);
        if (!part) continue;
        const list = part.notes;
        for (let i = firstEndingAfter(list, ctx0); i < list.length && list[i].t < ctx1; i++) if (!looping || list[i].t >= t0) semis.push(list[i].semi);
      }
      const target = rangeOf(semis);
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
      if (R) {
        const padT = small ? 2 : 4;
        const padB = small ? 2 : 3;
        const span = R.hi - R.lo;
        const rowPx = (rollBottom - padT - padB) / span;
        const yOf = (semi: number) => padT + (1 - (semi - R.lo) / span) * (rollBottom - padT - padB);

        // Rows: in the key you hear, lit; the tonic a little more. With no key,
        // the black keys shaded, as on a piano roll.
        const heardKey = deck.effectiveKey();
        const k = heardKey ? parseCamelot(heardKey) : null;
        const scale = k ? (k.minor ? MINOR : MAJOR).map((d) => (d + k.pc) % 12) : null;
        if (rowPx >= 2.2) {
          for (let m = Math.floor(R.lo + shift); m <= Math.ceil(R.hi + shift); m++) {
            const pc = ((m % 12) + 12) % 12;
            const y = yOf(m - shift + 0.5);
            if (scale) {
              if (!scale.includes(pc)) continue;
              g.fillStyle = P.bright;
              g.globalAlpha = pc === k!.pc ? 0.085 : 0.04;
            } else {
              if (!BLACK.has(pc)) continue;
              g.fillStyle = '#000';
              g.globalAlpha = 0.35;
            }
            g.fillRect(0, y, w, rowPx);
          }
          g.globalAlpha = 1;
        }
        // A line at each C, named on the right where there's room.
        g.font = font(small ? 8 : 9);
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        for (let m = Math.ceil((R.lo + shift) / 12) * 12; m <= R.hi + shift; m += 12) {
          const y = Math.round(yOf(m - shift - 0.5)) + 0.5;
          g.fillStyle = P.line;
          g.globalAlpha = 0.55;
          g.fillRect(0, y - 0.5, w, 1);
          g.globalAlpha = 1;
          if (!small && rowPx * 12 >= 16 && y > 7 && y < rollBottom - 5) {
            g.fillStyle = P.text;
            g.globalAlpha = 0.6;
            g.fillText(noteName(m), w - 3, y - 5);
            g.globalAlpha = 1;
          }
        }
        g.textAlign = 'left';

        const noteH = (n: StemNote) => Math.max(small ? 2 : 2.5, Math.min(rowPx * 0.85, small ? 4 : 8) * (0.7 + 0.3 * n.level));
        const drawNotes = (stem: Exclude<StemName, 'drums'>, part: StemPart) => {
          const list = part.notes;
          const ghost = faded(stem);
          const col = colour(stem);
          const lit = ghost ? null : litAt(list, pos);
          for (let i = firstEndingAfter(list, t0); i < list.length && list[i].t < t1; i++) {
            const n = list[i];
            if (!inView(n)) continue;
            const x0 = xOf(n.t);
            const x1 = xEnd(n.t, n.end, 3);
            const on = lit?.item === n;
            if (n.semi > R.hi || n.semi < R.lo) {
              g.fillStyle = col;
              g.globalAlpha = ghost ? GHOST * 0.6 : 0.5;
              g.fillRect(x0, n.semi > R.hi ? 0 : rollBottom - 2, x1 - x0, 2);
              continue;
            }
            const th = noteH(n);
            const y = yOf(n.semi) - th / 2;
            if (on) {
              g.shadowColor = col;
              g.shadowBlur = 10;
            }
            g.fillStyle = on ? P.bright : col;
            g.globalAlpha = ghost ? GHOST : on ? 1 : 0.45 + 0.55 * n.level;
            roundRect(g, x0, y, x1 - x0, th);
            g.fill();
            if (on) {
              // Keep the part's colour on the lit note, as its edge.
              g.shadowBlur = 0;
              g.strokeStyle = col;
              g.globalAlpha = 1;
              g.lineWidth = 1.25;
              g.stroke();
            }
            g.shadowBlur = 0;
          }
          g.globalAlpha = 1;
        };
        // The sung line under the vocal notes: slides and vibrato as sung.
        const drawContour = (stem: StemName, part: StemPart) => {
          const tr = part.track;
          if (!tr) return;
          const ghost = faded(stem);
          const i0 = Math.max(0, Math.floor((t0 - tr.t0) / tr.hop));
          const i1 = Math.min(tr.semis.length - 1, Math.ceil((t1 - tr.t0) / tr.hop));
          if (i1 <= i0) return;
          const step = Math.max(1, Math.floor((i1 - i0) / (w * 1.5)));
          g.strokeStyle = colour(stem);
          g.globalAlpha = ghost ? GHOST * 0.7 : 0.9;
          g.lineWidth = small ? 1 : 1.5;
          g.lineJoin = 'round';
          g.beginPath();
          let pen = false;
          for (let i = i0; i <= i1; i += step) {
            const v = tr.semis[i];
            const t = tr.t0 + i * tr.hop;
            if (!Number.isFinite(v) || v > R.hi || v < R.lo || (looping && t < t0)) {
              pen = false;
              continue;
            }
            const x = xOf(t);
            const y = yOf(v);
            if (pen) g.lineTo(x, y);
            else g.moveTo(x, y);
            pen = true;
          }
          g.stroke();
          g.globalAlpha = 1;
        };

        for (const stem of pitched) {
          const part = partOf(H, stem);
          if (!part) continue;
          drawNotes(stem, part);
          if (stem === 'vocals') drawContour(stem, part);
        }

        // Note names on the notes: every one that fits in a lane of its own;
        // in a shared lane only the ones you're hearing.
        if (!small && rollBottom >= 26) {
          g.font = font(9, 600);
          g.textBaseline = 'bottom';
          for (const stem of pitched) {
            const part = partOf(H, stem);
            if (!part || faded(stem)) continue;
            const lit = litAt(part.notes, pos)?.item ?? null;
            let lastX = -Infinity;
            const label = (n: StemNote) => {
              if (n.semi > R.hi || n.semi < R.lo) return;
              const text = noteName(n.semi + shift);
              const x = xOf(n.t);
              const tw = g.measureText(text).width;
              if (n !== lit && x - lastX < tw + 6) return;
              const above = yOf(n.semi) - noteH(n) / 2 - 1.5;
              const y = above >= 10 ? above : yOf(n.semi) + noteH(n) / 2 + 10;
              g.fillStyle = n === lit ? P.bright : colour(stem);
              g.globalAlpha = n === lit ? 1 : 0.75;
              g.fillText(text, x, y);
              g.globalAlpha = 1;
              lastX = x;
            };
            if (pitched.length === 1) {
              for (let i = firstEndingAfter(part.notes, t0); i < part.notes.length && part.notes[i].t < t1; i++) if (inView(part.notes[i])) label(part.notes[i]);
            } else if (lit) label(lit);
          }
        }
      } else {
        g.font = font(small ? 9 : 10);
        g.fillStyle = P.text;
        g.textBaseline = 'middle';
        g.fillText('No notes here yet', 8, rollBottom / 2);
      }
    }

    /* ── Drums: hats, snares, kicks ──────────────────────────────────── */
    if (hasDrums && drumH > 0) {
      const top = rollBottom;
      if (pitched.length) {
        g.fillStyle = P.line;
        g.globalAlpha = 0.6;
        g.fillRect(0, top, w, 1);
        g.globalAlpha = 1;
      }
      const rowH = (drumH - 2) / 3;
      const rowY = (kind: DrumKind) => top + (pitched.length ? 2 : 1) + DRUM_ROWS.indexOf(kind) * rowH;
      // Row names, faint, at the left.
      if (rowH >= 7 && !small) {
        g.font = font(Math.min(9, Math.floor(rowH)), 600);
        g.textBaseline = 'middle';
        g.fillStyle = P.text;
        g.globalAlpha = 0.45;
        for (const kind of DRUM_ROWS) g.fillText(kind[0].toUpperCase(), 3, rowY(kind) + rowH / 2 + 0.5);
        g.globalAlpha = 1;
      }
      const list = H.drums;
      const ghost = faded('drums');
      const col = colour('drums');
      for (let i = firstEndingAfter(list, t0); i < list.length && list[i].t < t1; i++) {
        const d = list[i];
        if (!inView(d)) continue;
        const on = !ghost && pos >= d.t && pos - d.t < Math.max(LIT_MIN, Math.min(0.25, d.end - d.t));
        const x0 = xOf(d.t);
        const x1 = xEnd(d.t, Math.min(d.end, d.t + 0.4), 3);
        const bh = Math.max(2, rowH * (0.35 + 0.55 * d.level));
        const y = rowY(d.kind) + (rowH - bh) / 2;
        if (on) {
          g.shadowColor = col;
          g.shadowBlur = 8;
        }
        g.fillStyle = on ? P.bright : col;
        g.globalAlpha = ghost ? GHOST : on ? 1 : (d.kind === 'kick' ? 0.55 : 0.4) + 0.5 * d.level;
        roundRect(g, x0, y, x1 - x0, bh);
        g.fill();
        g.shadowBlur = 0;
      }
      g.globalAlpha = 1;
    }

    // Playhead.
    const px = playX;
    g.fillStyle = P.playhead;
    g.fillRect(Math.round(px) - 1, 0, 2, h);
    if (first && looping && !small) {
      g.font = font(9, 600);
      g.textBaseline = 'top';
      g.textAlign = 'right';
      g.fillStyle = P.text;
      g.fillText('LOOP', px < w / 2 ? w - 4 : px - 6, 3);
      g.textAlign = 'left';
    }

    // Each chip's readout: what its part is playing now.
    for (const stem of parts) {
      const el = reads.current[stem];
      if (!el) continue;
      if (stem === 'drums') {
        const kinds = new Set<DrumKind>();
        for (let i = lastStartingBy(H.drums, pos); i >= 0 && pos - H.drums[i].t < 0.12; i--) kinds.add(H.drums[i].kind);
        setText(el, DRUM_ROWS.filter((k) => kinds.has(k)).reverse().map((k) => DRUM_WORD[k]).join('·'));
        continue;
      }
      const part = partOf(H, stem);
      if (!part) {
        setText(el, '');
        continue;
      }
      if (stem === 'other') {
        // Chords: every note sounding now, low to high.
        const now: number[] = [];
        for (let i = lastStartingBy(part.notes, pos); i >= 0 && pos - part.notes[i].t < 8; i--) {
          const n = part.notes[i];
          if (pos - n.t < Math.max(LIT_MIN, n.end - n.t)) now.push(Math.round(n.semi + shift));
        }
        const names = [...new Set(now)].sort((a, b) => a - b).map((m) => noteName(m));
        setText(el, names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(' '));
        continue;
      }
      const lit = litAt(part.notes, pos);
      if (!lit) {
        setText(el, '');
        continue;
      }
      let text = noteName(lit.item.semi + shift);
      const prev = lit.i > 0 ? part.notes[lit.i - 1] : null;
      if (prev && lit.item.t - prev.end < 1) {
        const d = Math.round(lit.item.semi - prev.semi);
        if (d) text += ` ${d > 0 ? '▲' : '▼'}${Math.abs(d)}`;
      }
      setText(el, text);
    }
  });

  return (
    <div className={s.stemLane} data-parts={parts.length}>
      <div className={s.laneGutter} ref={gutter}>
        {parts.map((stem) => (
          <Chip key={stem} stem={stem} stems={stems} deck={deck.label} readout={(el) => void (reads.current[stem] = el)} />
        ))}
      </div>
      <canvas
        ref={canvas}
        className={s.stemCanvas}
        role="img"
        aria-label={`Deck ${deck.label} beat pitch by stem: ${parts.map((p) => STEM_LABELS[p].toLowerCase()).join(', ')}`}
      />
    </div>
  );
}

const WAITING: Record<string, string> = {
  waiting: 'Stem lanes once the stems are in',
  reading: 'Reading each stem…',
  error: 'Couldn’t read the stems',
};

/** One deck's beat pitch lanes, in the view laneView picks. */
export function StemLanes({ deck, hits, stems, loop, zoom }: { deck: Deck; hits: DeckHits; stems: DeckStems; loop: FrameLoop; zoom: number }) {
  const view = useStore(laneView);
  const hs = useStoreSelect(hits.store, (h) => ({ trackId: h.trackId, stemStatus: h.stemStatus, stems: h.stems }), shallowEqual);
  const trackId = useStoreSelect(deck.store, (d) => d.track?.id ?? null);
  useEffect(() => hits.store.subscribe(() => loop.kick()), [hits, loop]);
  if (view.mode === 'off') return null;

  const H = hs.stems && hs.trackId === trackId && hs.stemStatus === 'ready' ? hs.stems : null;
  if (view.mode === 'mix' || !H) {
    const pill = view.mode !== 'mix' && hs.trackId === trackId ? WAITING[hs.stemStatus] : undefined;
    return (
      <div className={s.laneWrap}>
        <PitchLane deck={deck} hits={hits} loop={loop} zoom={zoom} />
        {pill && (
          <span className={s.lanePill} role="status">
            {pill}
          </span>
        )}
      </div>
    );
  }

  // Parts with nothing in them (no vocals on an instrumental) shrink to a
  // thin row that says so, chip and all, so they can still be muted.
  const empty = (['vocals', 'other', 'bass', 'drums'] as StemName[]).filter((p) => view.show[p] && (p === 'other' ? !H.other || !H.other.notes.length : isEmpty(H, p)));
  const lanes = lanesOf(view)
    .map((g) => g.filter((p) => !empty.includes(p)))
    .filter((g) => g.length);
  return (
    <div className={s.stemLanes} data-mode={view.mode} role="group" aria-label={`Deck ${deck.label} beat pitch by stem`}>
      {lanes.map((parts, i) => (
        <StemLane key={parts.join()} deck={deck} hits={hits} stems={stems} loop={loop} zoom={zoom} parts={parts} first={i === 0} follow={view.follow} />
      ))}
      {empty.length > 0 && (
        <div className={s.laneEmpty}>
          {empty.map((p) => (
            <Chip key={p} stem={p} stems={stems} deck={deck.label} />
          ))}
          <span className={s.laneEmptyText}>
            {empty.map((p) => (p === 'other' && !H.other ? 'other needs the track reloaded' : `no ${STEM_LABELS[p].toLowerCase()}`)).join(', ')}
            {empty.length === 1 && !(empty[0] === 'other' && !H.other) ? ' on this track' : ''}
          </span>
        </div>
      )}
    </div>
  );
}

