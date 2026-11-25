/**
 * Beat pitch per stem, on synthesised stems (no browser, no model):
 *   1. drums: kicks, snares and hats each land in their own row, a kick
 *      under a hat in both;
 *   2. bass: each note found, at its pitch, starting on its hit;
 *   3. vocals: a sung line with vibrato and a slide reads as its notes, and
 *      the pitch track follows the slide;
 *   4. other (mix less the stems): a three-note chord reads as three notes,
 *      and a pluck line as its notes;
 *   5. other is taken from the mix exactly as the deck does, also when the
 *      mix runs at 48 kHz and the stems at 44.1;
 *   6. speed on a six-minute track.
 * Run: node tests/stem-pitch.mjs
 */
import { loadTs } from '../scripts/load-ts.mjs';

const { mod, close } = await loadTs('/src/engine/hits/stems.ts');
const { analyseStems, partsOf } = mod;

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

const SR = 44100;
const BPM = 124;
const BEAT = 60 / BPM;
const BARS = 4;
const LEN = Math.ceil(BARS * 4 * BEAT * SR) + SR;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
let seed = 11;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296 - 0.5;
};

function kick(x, at, sr = SR) {
  let ph = 0;
  for (let i = 0; i < 0.35 * sr && at + i < x.length; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03))) / sr;
    x[at + i] += Math.sin(ph) * Math.exp(-t / 0.13) * 0.9;
  }
}
function snare(x, at, sr = SR) {
  let a = 0;
  for (let i = 0; i < 0.2 * sr && at + i < x.length; i++) {
    const t = i / sr;
    const n = rand();
    const hp = n - a;
    a = n;
    x[at + i] += (hp * 1.4 * Math.exp(-t / 0.06) + Math.sin(2 * Math.PI * 190 * t) * 0.45 * Math.exp(-t / 0.03)) * 0.55;
  }
}
function hat(x, at, sr = SR, gain = 0.3) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 0.05 * sr && at + i < x.length; i++) {
    const t = i / sr;
    const n = rand();
    const d1 = n - a;
    a = n;
    const d2 = d1 - b;
    b = d1;
    x[at + i] += d2 * Math.exp(-t / 0.012) * gain;
  }
}
/** A note with a few harmonics, an attack, optional vibrato and a slide to `to`. */
function tone(x, at, midi, dur, o = {}, sr = SR) {
  const { gain = 0.3, harm = [1, 0.5, 0.3, 0.2, 0.1], vib = 0, to = midi, slide = 0, attack = 0.005, decay = 0 } = o;
  let ph = 0;
  const n = Math.round(dur * sr);
  for (let i = 0; i < n && at + i < x.length; i++) {
    const t = i / sr;
    const glide = slide && t > dur - slide ? (t - (dur - slide)) / slide : 0;
    const m = midi + (to - midi) * glide + (vib ? 0.3 * Math.sin(2 * Math.PI * 5.5 * t) : 0);
    ph += (2 * Math.PI * hz(m)) / sr;
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin((h + 1) * ph);
    const env = Math.min(1, t / attack) * (decay ? Math.exp(-t / decay) : 1) * Math.min(1, (dur - t) / 0.01);
    x[at + i] += v * env * gain;
  }
}

function build(sr = SR) {
  const len = Math.ceil(BARS * 4 * BEAT * sr) + sr;
  const drums = new Float32Array(len);
  const bass = new Float32Array(len);
  const vocals = new Float32Array(len);
  const other = new Float32Array(len);
  const at = (t) => Math.round(t * sr);
  const truth = { kick: [], snare: [], hat: [], bass: [], vocals: [], chords: [], plucks: [] };
  seed = 11;
  for (let b = 0; b < BARS * 4; b++) {
    const t = b * BEAT;
    kick(drums, at(t), sr);
    truth.kick.push(t);
    if (b % 2) {
      snare(drums, at(t), sr);
      truth.snare.push(t);
    }
    for (const half of [0, 0.5]) {
      hat(drums, at(t + half * BEAT), sr);
      truth.hat.push(t + half * BEAT);
    }
  }
  // Bass: off-beat eighths, A1 F1 D2 E1 per bar.
  const roots = [33, 29, 38, 28];
  for (let b = 0; b < BARS * 4; b++) {
    const m = roots[Math.floor(b / 4) % 4];
    const t = b * BEAT + BEAT / 2;
    tone(bass, at(t), m, BEAT * 0.45, { gain: 0.5, harm: [1, 0.6, 0.35, 0.2, 0.12, 0.08], decay: 0.25 }, sr);
    truth.bass.push({ t, m });
  }
  // Vocals: a phrase per bar, two beats a note, the last note sliding up.
  const line = [64, 67, 69, 67, 72, 71, 69, 64];
  for (let k = 0; k < line.length; k++) {
    const t = k * 2 * BEAT;
    const slide = k === 3 ? 0.25 : 0;
    tone(vocals, at(t), line[k], 2 * BEAT - 0.06, { gain: 0.25, harm: [1, 0.7, 0.4, 0.25, 0.15, 0.1, 0.06], vib: 1, attack: 0.04, to: k === 3 ? 72 : line[k], slide }, sr);
    truth.vocals.push({ t, m: line[k] });
  }
  // Other: a chord stab on bar 1 and 3 (A minor, F major), plucks on 2 and 4.
  const chords = [
    [57, 60, 64],
    [53, 57, 60],
  ];
  for (let c = 0; c < 2; c++) {
    const t = c * 2 * 4 * BEAT;
    for (const m of chords[c]) tone(other, at(t), m, 3 * BEAT, { gain: 0.12, harm: [1, 0.45, 0.25, 0.15, 0.08], attack: 0.01 }, sr);
    truth.chords.push({ t, notes: chords[c] });
  }
  const plucks = [76, 79, 81, 79, 76, 74, 72, 74];
  for (const bar of [1, 3]) {
    for (let k = 0; k < 8; k++) {
      const t = (bar * 4 + k / 2) * BEAT;
      tone(other, at(t), plucks[k], BEAT * 0.4, { gain: 0.2, harm: [1, 0.4, 0.2], decay: 0.12 }, sr);
      truth.plucks.push({ t, m: plucks[k] });
    }
  }
  // Half level, so no stem clips at 16 bits.
  for (const x of [drums, bass, vocals, other]) for (let i = 0; i < len; i++) x[i] *= 0.5;
  const mix = new Float32Array(len);
  for (let i = 0; i < len; i++) mix[i] = drums[i] + bass[i] + vocals[i] + other[i];
  return { drums, bass, vocals, other, mix, truth, len };
}

const i16 = (x) => {
  const o = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  return o;
};

const S = build();
const t0 = performance.now();
const res = analyseStems({ mix: S.mix, mixRate: SR, stems: [i16(S.drums), i16(S.bass), i16(S.vocals)], stemRate: SR });
console.log(`     analysed in ${Math.round(performance.now() - t0)} ms`);

// 1. Drums.
const near = (list, t, tol = 0.025) => list.some((h) => Math.abs(h.t - t) <= tol);
// A hat right under a snare can't be told from the snare's own sizzle: those
// aren't asked for (the snare row is lit there anyway).
const underSnare = (t) => S.truth.snare.some((s) => Math.abs(s - t) < 0.01);
for (const kind of ['kick', 'snare', 'hat']) {
  const got = res.drums.filter((h) => h.kind === kind);
  const want = S.truth[kind].filter((t) => kind !== 'hat' || !underSnare(t));
  const found = want.filter((t) => near(got, t)).length;
  const extra = got.filter((h) => !S.truth[kind].some((t) => Math.abs(t - h.t) <= 0.025)).length;
  check(found >= want.length * 0.9, `drums: ${found}/${want.length} ${kind}s in the ${kind} row`);
  check(extra <= Math.max(1, S.truth[kind].length * 0.1), `drums: ${extra} stray hits in the ${kind} row`);
}

// 2. Bass.
const bassOk = S.truth.bass.filter(({ t, m }) => res.bass.notes.some((n) => Math.abs(n.t - t) <= 0.03 && Math.abs(n.semi - m) <= 0.5)).length;
check(bassOk >= S.truth.bass.length * 0.9, `bass: ${bassOk}/${S.truth.bass.length} notes at their pitch, on their hit`);
check(res.bass.notes.length <= S.truth.bass.length * 1.15, `bass: ${res.bass.notes.length} notes for ${S.truth.bass.length} played`);

// 3. Vocals.
const vocOk = S.truth.vocals.filter(({ t, m }) => res.vocals.notes.some((n) => Math.abs(n.t - t) <= 0.08 && Math.abs(n.semi - m) <= 0.5)).length;
check(vocOk >= S.truth.vocals.length - 1, `vocals: ${vocOk}/${S.truth.vocals.length} sung notes at their pitch (vibrato and all)`);
check(res.vocals.notes.length <= S.truth.vocals.length + 3, `vocals: ${res.vocals.notes.length} notes for ${S.truth.vocals.length} sung`);
{
  const tr = res.vocals.track;
  const at = (t) => tr.semis[Math.round((t - tr.t0) / tr.hop)];
  const slideEnd = 4 * 2 * BEAT - 0.08;
  check(tr && at(slideEnd) > 69.5, `vocals: the pitch track follows the slide up (${tr && at(slideEnd)?.toFixed(1)} at its end)`);
}

// 4. Other.
for (const c of S.truth.chords) {
  const got = c.notes.filter((m) => res.other.notes.some((n) => Math.abs(n.t - c.t) <= 0.08 && Math.abs(n.semi - m) <= 0.5));
  check(got.length === c.notes.length, `other: chord at ${c.t.toFixed(2)} s reads ${got.length}/3 of its notes`);
}
const plOk = S.truth.plucks.filter(({ t, m }) => res.other.notes.some((n) => Math.abs(n.t - t) <= 0.04 && Math.abs(n.semi - m) <= 0.5)).length;
check(plOk >= S.truth.plucks.length * 0.85, `other: ${plOk}/${S.truth.plucks.length} plucks at their pitch`);
const strays = res.other.notes.filter(
  (n) => !S.truth.plucks.some((p) => Math.abs(p.m - n.semi) <= 0.5) && !S.truth.chords.some((c) => c.notes.some((m) => Math.abs(m - n.semi) <= 0.5)),
);
check(strays.length <= 3, `other: ${strays.length} notes that were never played`);

// 5. Other = mix − stems, as the deck plays it.
{
  const p = partsOf({ mix: S.mix, mixRate: SR, stems: [i16(S.drums), i16(S.bass), i16(S.vocals)], stemRate: SR });
  let err = 0;
  let ref = 0;
  for (let j = 10; j < p.other.length - 10; j++) {
    const i = j * 2;
    const want = 0.25 * S.other[i - 1] + 0.5 * S.other[i] + 0.25 * S.other[i + 1];
    err += (p.other[j] - want) ** 2;
    ref += want * want;
  }
  check(10 * Math.log10(err / ref) < -40, `other matches the mix less the stems (${(10 * Math.log10(err / ref)).toFixed(0)} dB residue)`);
  // Mix at 48 kHz, stems at 44.1 kHz: tonal parts only, so both renders agree.
  const A = build(48000);
  const B = build(SR);
  const tonalMix = new Float32Array(A.len);
  for (let i = 0; i < A.len; i++) tonalMix[i] = A.bass[i] + A.vocals[i] + A.other[i];
  const r = analyseStems({ mix: tonalMix, mixRate: 48000, stems: [new Int16Array(B.len), i16(B.bass), i16(B.vocals)], stemRate: SR });
  const okC = S.truth.chords[0].notes.filter((m) => r.other.notes.some((n) => Math.abs(n.t) <= 0.08 && Math.abs(n.semi - m) <= 0.5)).length;
  const leak = r.other.notes.filter((n) => n.semi < 45).length;
  check(okC === 3 && leak <= 2, `48 kHz mix over 44.1 kHz stems: chord found (${okC}/3), ${leak} bass notes leaked into other`);
}

// 6. Speed: six minutes.
{
  const reps = Math.ceil((360 * SR) / S.len);
  const big = (x) => {
    const o = new Float32Array(S.len * reps);
    for (let r = 0; r < reps; r++) o.set(x, r * S.len);
    return o;
  };
  const mix = big(S.mix);
  const stems = [big(S.drums), big(S.bass), big(S.vocals)].map(i16);
  const a = performance.now();
  const r = analyseStems({ mix, mixRate: SR, stems, stemRate: SR });
  const ms = performance.now() - a;
  check(ms < 15000, `six minutes in ${(ms / 1000).toFixed(1)} s (${r.drums.length} drum hits, ${r.bass.notes.length + r.vocals.notes.length + r.other.notes.length} notes)`);
}

await close();
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');
