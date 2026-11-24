/**
 * Beat pitch checks on synthesised audio, no browser needed:
 *   1. a drum loop (kick, snare, hats): every hit found, kicks read lowest,
 *      hats highest, snares between;
 *   2. a melodic loop (plucked notes over the drums): each pluck tonal and at
 *      its note, within half a semitone, so higher notes read higher;
 *   3. a hat over a held bass note reads as the hat, not the bass;
 *   4. silence finds nothing; levels run 0…1;
 *   5. speed on a 6-minute track.
 * Run: node tests/beat-pitch.mjs
 */
import { loadTs } from '../scripts/load-ts.mjs';

const { mod, close } = await loadTs('/src/engine/hits/analyse.ts');
const { analyseHits, noteName, midiOf } = mod;

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

const SR = 44100;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
let seed = 7;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296 - 0.5;
};

function kick(x, at, gain = 0.9) {
  let ph = 0;
  for (let i = 0; i < 0.35 * SR && at + i < x.length; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (55 + 90 * Math.exp(-t / 0.025))) / SR;
    x[at + i] += Math.sin(ph) * Math.exp(-t / 0.12) * gain;
  }
}
function snare(x, at, gain = 0.5) {
  for (let i = 0; i < 0.2 * SR && at + i < x.length; i++) {
    const t = i / SR;
    x[at + i] += (rand() * 1.6 * Math.exp(-t / 0.05) + Math.sin(2 * Math.PI * 190 * t) * 0.5 * Math.exp(-t / 0.03)) * gain;
  }
}
// Hats: noise through a crude high-pass (first difference twice).
function hat(x, at, gain = 0.25) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 0.05 * SR && at + i < x.length; i++) {
    const t = i / SR;
    const n = rand();
    const d1 = n - a;
    a = n;
    const d2 = d1 - b;
    b = d1;
    x[at + i] += d2 * Math.exp(-t / 0.012) * gain;
  }
}
// A plucked note: a few harmonics, quick decay.
function pluck(x, at, midi, dur = 0.22, gain = 0.35) {
  const f = hz(midi);
  for (let i = 0; i < dur * SR && at + i < x.length; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    x[at + i] += v * Math.min(1, t / 0.002) * Math.exp(-t / (dur / 3)) * gain;
  }
}

const BPM = 120;
const beat = (60 / BPM) * SR;
const bars = 4;
const n = Math.round(bars * 4 * beat + SR);

function nearest(hits, t) {
  let best = null;
  for (const h of hits) if (!best || Math.abs(h.t - t) < Math.abs(best.t - t)) best = h;
  return best && Math.abs(best.t - t) < 0.02 ? best : null;
}
const median = (a) => {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : NaN;
};

/* 1. Drum loop */
{
  const x = new Float32Array(n);
  const kicks = [];
  const snares = [];
  const hats = [];
  for (let b = 0; b < bars * 4; b++) {
    const at = Math.round(b * beat);
    if (b % 2 === 0) kick(x, at), kicks.push(at / SR);
    else snare(x, at), snares.push(at / SR);
    const off = Math.round(at + beat / 2);
    hat(x, off), hats.push(off / SR);
  }
  const hits = analyseHits(x, SR);
  const found = (ts) => ts.map((t) => nearest(hits, t)).filter(Boolean);
  const k = found(kicks);
  const s = found(snares);
  const h = found(hats);
  check(k.length === kicks.length && s.length === snares.length && h.length === hats.length, `drums: every hit found (${k.length}/${kicks.length} kicks, ${s.length}/${snares.length} snares, ${h.length}/${hats.length} hats; ${hits.length} hits in all)`);
  const mk = median(k.map((o) => o.hz));
  const ms = median(s.map((o) => o.hz));
  const mh = median(h.map((o) => o.hz));
  check(mk < ms && ms < mh, `drums: kick ${Math.round(mk)} Hz < snare ${Math.round(ms)} Hz < hat ${Math.round(mh)} Hz`);
  check(Math.max(...k.map((o) => o.hz)) < Math.min(...s.map((o) => o.hz)), 'drums: every kick lower than every snare');
  check(Math.max(...s.map((o) => o.hz)) < Math.min(...h.map((o) => o.hz)), 'drums: every snare lower than every hat');
  check(k.every((o) => o.hz < 80), `drums: the kick (a 145 → 55 Hz sweep) reads under 80 Hz (${k.slice(0, 4).map((o) => (o.tonal ? noteName(o.semi) : `${Math.round(o.hz)} Hz`)).join(', ')})`);
  check(s.every((o) => !o.tonal || o.hz > 150) && h.every((o) => !o.tonal), 'drums: hats are never read as notes');
  check(hits.every((o) => o.level >= 0 && o.level <= 1) && hits.some((o) => o.level === 1), 'levels run 0…1');
}

/* 2. Melodic loop over drums */
{
  const x = new Float32Array(n);
  const melody = [45, 52, 48, 57, 55, 50, 60, 43]; // A2 E3 C3 A3 G3 D3 C4 G2
  const notes = [];
  for (let b = 0; b < bars * 4; b++) {
    const at = Math.round(b * beat);
    if (b % 4 === 0) kick(x, at, 0.6);
    hat(x, Math.round(at + beat / 2), 0.12);
    const m = melody[b % melody.length];
    const p = Math.round(at + beat / 4);
    pluck(x, p, m);
    notes.push({ t: p / SR, m });
  }
  const hits = analyseHits(x, SR);
  const got = notes.map((q) => ({ q, h: nearest(hits, q.t) }));
  const tonal = got.filter((g) => g.h?.tonal);
  check(tonal.length >= notes.length * 0.9, `melody: plucks read as notes (${tonal.length}/${notes.length})`);
  const right = tonal.filter((g) => Math.abs(midiOf(g.h.hz) - g.q.m) < 0.5);
  check(right.length >= tonal.length * 0.95, `melody: at the right note (${right.length}/${tonal.length}; e.g. ${got.slice(0, 8).map((g) => (g.h ? noteName(g.h.semi) : '—')).join(' ')})`);
  let order = 0;
  let pairs = 0;
  for (let i = 1; i < tonal.length; i++) {
    const a = tonal[i - 1];
    const b = tonal[i];
    if (a.q.m === b.q.m) continue;
    pairs++;
    if (Math.sign(b.h.semi - a.h.semi) === Math.sign(b.q.m - a.q.m)) order++;
  }
  check(pairs > 0 && order === pairs, `melody: each step up or down reads the right way (${order}/${pairs})`);
}

/* 3. A hat over a held bass note */
{
  const x = new Float32Array(2 * SR);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 55 * i) / SR) * 0.4 * Math.min(1, i / (0.01 * SR));
  hat(x, Math.round(1 * SR), 0.3);
  const hits = analyseHits(x, SR);
  const h = nearest(hits, 1);
  check(!!h && !h.tonal && h.hz > 2000, `hat over held bass reads as the hat (${h ? `${Math.round(h.hz)} Hz, tonal ${h.tonal}` : 'not found'})`);
}

/* 4. Silence */
check(analyseHits(new Float32Array(SR * 2), SR).length === 0, 'silence: no hits');

/* 5. Speed */
{
  const secs = 360;
  const x = new Float32Array(secs * SR);
  const b128 = (60 / 128) * SR;
  for (let b = 0; b * b128 < x.length - SR; b++) {
    const at = Math.round(b * b128);
    if (b % 2 === 0) kick(x, at, 0.7);
    else snare(x, at, 0.4);
    hat(x, Math.round(at + b128 / 2), 0.15);
    if (b % 2 === 1) pluck(x, Math.round(at + b128 / 4), 45 + ((b * 5) % 12));
  }
  const t0 = performance.now();
  const hits = analyseHits(x, SR);
  const ms = performance.now() - t0;
  check(ms < 4000, `6-minute track: ${hits.length} hits in ${Math.round(ms)} ms`);
}

await close();
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');
