/**
 * Slicer DSP checks on synthesised audio, no browser needed:
 *   1. transients — a 90 BPM kick/snare/hat pattern (dry, and over a
 *      sustained pad): recall within 15 ms, false positives, sensitivity
 *      ordering, 48 and 96 kHz, silence, a region;
 *   2. auto-slice — grid at 120 BPM with an offset, equal slices, tidy rules;
 *   3. peaks and drawing columns on a known signal;
 *   4. slice extraction — mono duplication, reverse, fades, de-click;
 *   5. WAV export — header fields and sample round trip at 16/24/32 bit;
 *   6. speed on a 6-minute 44.1 kHz stereo track.
 * Run: node tests/slicer-dsp.mjs
 */
import { loadTs } from '../scripts/load-ts.mjs';

const { mod, close } = await loadTs('/src/slicer/dsp.ts');
const {
  buildPeaks,
  peaksColumns,
  detectOnsets,
  autoSlicePoints,
  nearestZeroCrossing,
  extractChannels,
  encodeWav,
  peakLevel,
  guessLoopBpm,
} = mod;

let failures = 0;
const check = (ok, msg) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
  return ok;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** A PcmLike over plain arrays. */
const pcmOf = (sampleRate, channels) => ({
  sampleRate,
  length: channels[0].length,
  numberOfChannels: channels.length,
  getChannelData: (c) => channels[c],
});

/* ── Synthesis ─────────────────────────────────────────────────────────── */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeHits(sr, rand) {
  const kick = new Float32Array(Math.round(0.4 * sr));
  let ph = 0;
  for (let i = 0; i < kick.length; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * (45 + 75 * Math.exp(-t / 0.03))) / sr;
    kick[i] = Math.sin(ph) * Math.exp(-t / 0.22) + (t < 0.002 ? 0.3 * (rand() * 2 - 1) : 0);
  }
  const snare = new Float32Array(Math.round(0.3 * sr));
  for (let i = 0; i < snare.length; i++) {
    const t = i / sr;
    snare[i] = 0.6 * (rand() * 2 - 1) * Math.exp(-t / 0.1) + 0.4 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.07);
  }
  // Hat: noise band-passed to ~7–14 kHz by one-pole filters, so it sounds
  // (and measures) the same at any sample rate.
  const hat = new Float32Array(Math.round(0.08 * sr));
  const aH = Math.exp((-2 * Math.PI * 7000) / sr);
  const aL = Math.exp((-2 * Math.PI * 14000) / sr);
  let lpH = 0;
  let lpL = 0;
  for (let i = 0; i < hat.length; i++) {
    const t = i / sr;
    const n = rand() * 2 - 1;
    lpH = n + aH * (lpH - n);
    lpL = n - lpH + aL * (lpL - (n - lpH));
    hat[i] = 1.5 * lpL * Math.exp(-t / 0.025);
  }
  // 5 ms fade at the end of each sample: a cut-off tail is a click, and a
  // click is (rightly) an onset.
  for (const x of [kick, snare, hat]) {
    const f = Math.round(0.005 * sr);
    for (let i = 0; i < f; i++) x[x.length - 1 - i] *= i / f;
  }
  return { kick, snare, hat };
}

/** One bar at 90 BPM: [beat, instrument, gain]. Syncopated kick, backbeat
 *  snare, 8th hats (quieter offbeats) and a 16th pickup hat. */
const PATTERN = [
  [0, 'kick', 0.9],
  [2.5, 'kick', 0.75],
  [1, 'snare', 0.6],
  [3, 'snare', 0.6],
  ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b) => [b, 'hat', b % 1 ? 0.2 : 0.3]),
  [3.75, 'hat', 0.15],
];
/** Kicks alone, four to the bar plus a syncopated one: only the low band
 *  (and each kick's 2 ms click) marks them. */
const KICKS = [0, 1, 2, 2.5, 3].map((b) => [b, 'kick', 0.8]);
/** Very quiet ghost hats on the remaining 16ths, for the sensitivity check. */
const GHOSTS = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25].map((b) => [b, 'hat', 0.03]);

/**
 * A stereo drum loop at `bpm`, first beat at `start`; returns the PcmLike
 * and the distinct onset times (s). `pad`: a sustained chord with a slow
 * tremolo under everything, about as loud as the kick.
 */
function drumTrack({ sr = 44100, bpm = 90, seconds = 20, start = 0.25, pad = false, ghosts = false, kicksOnly = false, seed = 1 }) {
  const rand = rng(seed);
  const hits = makeHits(sr, rand);
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const chord = pad ? [110, 164.81, 220, 261.63, 329.63] : [];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let c = 0;
    for (const f of chord) c += Math.sin(2 * Math.PI * f * t + f);
    // Half-second swell in, 0.25 Hz ±15 % tremolo.
    c *= 0.1 * Math.min(1, t / 0.5) * (1 + 0.15 * Math.sin(2 * Math.PI * 0.25 * t));
    L[i] = c + 0.0005 * (rand() * 2 - 1);
    R[i] = c + 0.0005 * (rand() * 2 - 1);
  }
  const beat = 60 / bpm;
  const pat = kicksOnly ? KICKS : ghosts ? [...PATTERN, ...GHOSTS] : PATTERN;
  const times = new Set();
  for (let bar = 0; start + bar * 4 * beat < seconds - 0.5; bar++) {
    for (const [pos, inst, gain] of pat) {
      const t = start + (bar * 4 + pos) * beat + (rand() - 0.5) * 0.001;
      if (t > seconds - 0.5) continue;
      const i0 = Math.round(t * sr);
      times.add(Math.round((start + (bar * 4 + pos) * beat) * 1e4) / 1e4);
      const g = gain * (0.9 + 0.2 * rand());
      const s = hits[inst];
      const pan = inst === 'hat' ? 0.3 : 0;
      for (let i = 0; i < s.length && i0 + i < n; i++) {
        L[i0 + i] += s[i] * g * (1 - pan);
        R[i0 + i] += s[i] * g * (1 + pan) * 0.85;
      }
    }
  }
  return { pcm: pcmOf(sr, [L, R]), truth: [...times].sort((a, b) => a - b) };
}

/** Recall (truth matched within tol), false positives (detections matching nothing). */
function score(found, truth, tol = 0.015) {
  let hit = 0;
  const errs = [];
  for (const t of truth) {
    let best = Infinity;
    for (const f of found) if (Math.abs(f - t) < Math.abs(best)) best = f - t;
    if (Math.abs(best) <= tol) {
      hit++;
      errs.push(best * 1000);
    }
  }
  const fp = found.filter((f) => !truth.some((t) => Math.abs(f - t) <= tol)).length;
  const meanErr = errs.length ? errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length : NaN;
  return { recall: hit / truth.length, fp, meanErrMs: Math.round(meanErr * 100) / 100, found: found.length, truth: truth.length };
}

/* ── 1. Transients ─────────────────────────────────────────────────────── */
console.log('Transients (90 BPM kick/snare/hat, minGap 50 ms)');
{
  const rows = [];
  const cases = [
    { name: 'dry 44.1k', sr: 44100, pad: false },
    { name: 'pad 44.1k', sr: 44100, pad: true },
    { name: 'dry 48k', sr: 48000, pad: false },
    { name: 'pad 48k', sr: 48000, pad: true },
    { name: 'dry 88.2k', sr: 88200, pad: false },
    { name: 'dry 96k', sr: 96000, pad: false },
    { name: 'pad 96k', sr: 96000, pad: true },
    { name: 'kicks+pad 44.1k', sr: 44100, pad: true, kicksOnly: true },
    { name: 'kicks+pad 96k', sr: 96000, pad: true, kicksOnly: true },
  ];
  for (const c of cases) {
    const { pcm, truth } = drumTrack({ sr: c.sr, pad: c.pad, kicksOnly: c.kicksOnly, seed: c.sr + (c.pad ? 7 : 0) });
    const t0 = performance.now();
    const found = detectOnsets(pcm, { sensitivity: 0.5, minGap: 0.05 });
    const ms = performance.now() - t0;
    // The pad's own entrance (a 0.5 s swell from 0) is a real, soft onset:
    // only score from just before the first drum hit.
    const s = score(found.filter((t) => t >= truth[0] - 0.015), truth);
    rows.push({ case: c.name, ...s, ms: Math.round(ms) });
    check(s.recall >= 0.95, `${c.name}: recall ${s.recall.toFixed(3)} < 0.95`);
    check(s.fp <= Math.ceil(0.05 * truth.length), `${c.name}: ${s.fp} false positives (of ${truth.length})`);
    check(found.every((t, i) => i === 0 || t > found[i - 1]), `${c.name}: onsets not sorted`);
  }
  console.table(rows);

  // Sensitivity: more onsets as it rises, on a pattern with ghost notes.
  const { pcm, truth } = drumTrack({ ghosts: true, seed: 3 });
  const counts = [0, 0.25, 0.5, 0.75, 1].map((s) => detectOnsets(pcm, { sensitivity: s, minGap: 0.05 }).length);
  console.log(`  sensitivity 0 … 1 → ${counts.join(', ')} onsets (${truth.length} hits incl. ghosts)`);
  check(counts.every((n, i) => i === 0 || n >= counts[i - 1]), `onset count not monotonic in sensitivity: ${counts}`);
  check(counts[4] > counts[0], `sensitivity 1 (${counts[4]}) should find more than 0 (${counts[0]})`);
  check(counts[4] > counts[2], `sensitivity 1 (${counts[4]}) should find more than 0.5 (${counts[2]})`);

  // minGap: at 0.2 s no two onsets are closer.
  const wide = detectOnsets(pcm, { sensitivity: 1, minGap: 0.2 });
  check(wide.every((t, i) => i === 0 || t - wide[i - 1] >= 0.2 - 1e-6), 'minGap 0.2 not respected');

  // maxCount: a pushed slider keeps only the strongest hits, in time order,
  // and the loudest ones (kicks and snares, not ghost notes) survive.
  {
    const all = detectOnsets(pcm, { sensitivity: 1, minGap: 0.02 });
    const cap = Math.max(4, Math.floor(all.length / 3));
    const few = detectOnsets(pcm, { sensitivity: 1, minGap: 0.02, maxCount: cap });
    check(few.length <= cap && few.length >= cap - 2, `maxCount ${cap}: got ${few.length} of ${all.length}`);
    check(few.every((t, i) => i === 0 || t > few[i - 1]), 'capped onsets not sorted');
    check(few.every((t) => all.some((u) => Math.abs(u - t) < 1e-9)), 'capped onsets are not a subset of the full set');
    const loud = detectOnsets(pcm, { sensitivity: 0.2, minGap: 0.02 });
    const kept = loud.filter((t) => few.some((u) => Math.abs(u - t) < 0.012)).length;
    check(kept >= Math.min(loud.length, cap) * 0.8, `capped set kept ${kept} of the ${loud.length} loudest hits`);
    check(detectOnsets(pcm, { sensitivity: 1, minGap: 0.02, maxCount: 10000 }).length === all.length, 'a cap above the count changes nothing');
  }

  // Silence, and a near-silent noise floor.
  const sil = pcmOf(44100, [new Float32Array(44100 * 5), new Float32Array(44100 * 5)]);
  check(detectOnsets(sil, { sensitivity: 1, minGap: 0.05 }).length === 0, 'silence gave onsets');
  const r = rng(9);
  const hiss = new Float32Array(44100 * 5).map(() => 1e-4 * (r() * 2 - 1));
  check(detectOnsets(pcmOf(44100, [hiss]), { sensitivity: 0.5, minGap: 0.05 }).length === 0, '−80 dB hiss gave onsets');

  // A region: only onsets in [start, end), and a hit sounding at `start`
  // (started before it) is not an onset.
  {
    const { pcm: p, truth: tr } = drumTrack({ seed: 4 });
    const a = 2.0;
    const b = 6.0;
    const got = detectOnsets(p, { sensitivity: 0.5, minGap: 0.05, start: a, end: b });
    const want = tr.filter((t) => t >= a && t < b);
    const s = score(got, want);
    check(got.every((t) => t >= a && t < b), 'region onsets outside [start, end)');
    check(s.recall >= 0.95 && s.fp <= 1, `region: recall ${s.recall}, fp ${s.fp}`);
  }
}

/* ── 2. Auto-slice ─────────────────────────────────────────────────────── */
console.log('\nAuto-slice');
{
  // 120 BPM, offset 0.3 s, quarter notes over 4 s: the grid extends back to
  // 0.3 − 0.5 < 0 (dropped), so 0, 0.3, 0.8, … 3.8.
  const g = autoSlicePoints({ mode: 'grid', beats: 1 }, { duration: 4, bpm: 120, gridOffset: 0.3 });
  const want = [0, 0.3, 0.8, 1.3, 1.8, 2.3, 2.8, 3.3, 3.8];
  check(g.length === want.length && g.every((t, i) => near(t, want[i], 1e-9)), `grid 120/0.3: ${g}`);
  // Offset past the first beat: the earlier beats are slices too.
  const g2 = autoSlicePoints({ mode: 'grid', beats: 1 }, { duration: 3, bpm: 120, gridOffset: 1.2 });
  const want2 = [0, 0.2, 0.7, 1.2, 1.7, 2.2, 2.7];
  check(g2.length === want2.length && g2.every((t, i) => near(t, want2[i], 1e-9)), `grid offset 1.2: ${g2}`);
  // Sixteenths.
  const g3 = autoSlicePoints({ mode: 'grid', beats: 0.25 }, { duration: 2, bpm: 120, gridOffset: 0 });
  check(g3.length === 16 && near(g3[15], 1.875, 1e-9), `grid 16ths: ${g3.length}`);
  // Offset within 10 ms of 0 merges into 0.
  const g4 = autoSlicePoints({ mode: 'grid', beats: 1 }, { duration: 2, bpm: 120, gridOffset: 0.004 });
  check(g4[0] === 0 && near(g4[1], 0.504, 1e-9), `grid offset 4 ms: ${g4}`);
  check(autoSlicePoints({ mode: 'grid', beats: 1 }, { duration: 4, bpm: null, gridOffset: 0 }).join() === '0', 'grid without bpm');

  const e = autoSlicePoints({ mode: 'equal', count: 8 }, { duration: 4, bpm: null, gridOffset: 0 });
  check(e.length === 8 && e.every((t, i) => near(t, i * 0.5, 1e-12)), `equal 8: ${e}`);
  check(autoSlicePoints({ mode: 'equal', count: 1 }, { duration: 4, bpm: null, gridOffset: 0 }).join() === '0', 'equal 1');
  check(autoSlicePoints({ mode: 'equal', count: 4 }, { duration: 0, bpm: null, gridOffset: 0 }).join() === '0', 'zero duration');

  const { pcm, truth } = drumTrack({ seconds: 6, seed: 5 });
  const tr = autoSlicePoints({ mode: 'transients', sensitivity: 0.5, minGap: 0.05 }, { duration: 6, bpm: 90, gridOffset: 0.25 }, pcm);
  check(tr[0] === 0 && tr.every((t, i) => i === 0 || t - tr[i - 1] >= 0.01) && tr.every((t) => t < 6), 'transient slices tidy');
  check(score(tr.slice(1), truth.filter((t) => t < 5.99)).recall >= 0.95, 'transient slices recall');
  check(autoSlicePoints({ mode: 'transients', sensitivity: 0.5, minGap: 0.05 }, { duration: 6, bpm: null, gridOffset: 0 }).join() === '0', 'transients without pcm');

  check(guessLoopBpm(2) === 120, `loop 2 s → ${guessLoopBpm(2)}`);
  check(guessLoopBpm(8) === 120, `loop 8 s → ${guessLoopBpm(8)}`);
  check(guessLoopBpm((60 / 174) * 16) === 87, `loop 4 bars at 174 → ${guessLoopBpm((60 / 174) * 16)}`);
  check(guessLoopBpm(3.2) === 150, `loop 3.2 s → ${guessLoopBpm(3.2)} (75 or 150; nearer 120 wins)`);
  check(guessLoopBpm(0.4) === null, 'loop < 0.5 s → null');
}

/* ── 3. Peaks ──────────────────────────────────────────────────────────── */
console.log('Peaks');
{
  // 1000 samples: a ramp on L, its negative ×0.5 on R → mix = 0.25·ramp.
  const n = 1000;
  const L = new Float32Array(n).map((_, i) => i / n);
  const R = new Float32Array(n).map((_, i) => -0.5 * (i / n));
  const p = buildPeaks(pcmOf(1000, [L, R]), 100);
  check(p.min.length === 10 && p.binSize === 100 && p.sampleRate === 1000, 'peaks shape');
  check(near(p.min[3], 0.25 * 0.3, 1e-6) && near(p.max[3], 0.25 * 0.399, 1e-6), `peaks bin 3: ${p.min[3]} ${p.max[3]}`);
  const odd = buildPeaks(pcmOf(1000, [L.subarray(0, 950)]), 100);
  check(odd.min.length === 10 && near(odd.max[9], 0.949, 1e-6), 'partial last bin');

  // A burst between 0.5 and 0.6 s, silence elsewhere.
  const x = new Float32Array(1000);
  for (let i = 500; i < 600; i++) x[i] = i % 2 ? 0.8 : -0.6;
  const q = buildPeaks(pcmOf(1000, [x]), 10);
  const col = peaksColumns(q, 0, 1, 10); // 10 bins per column
  check(col.max[5] === 0.800000011920929 && near(col.min[5], -0.6, 1e-6) && col.max[4] === 0 && col.min[6] === 0, `columns: ${[...col.max]}`);
  // Narrower than a bin: 100 columns over 0.5…0.6 s (10 bins) repeat each bin.
  const fine = peaksColumns(q, 0.5, 0.6, 100);
  check(fine.max.every((v) => near(v, 0.8, 1e-6)) && fine.min.every((v) => near(v, -0.6, 1e-6)), 'zoomed-in columns');
  // Out of range reads 0; a column straddling the end includes 0.
  const out = peaksColumns(q, -1, 0, 4);
  check(out.max.every((v) => v === 0) && out.min.every((v) => v === 0), 'before start reads 0');
  const all = peaksColumns(buildPeaks(pcmOf(1000, [new Float32Array(1000).fill(0.5)]), 10), 0.5, 1.5, 2);
  check(near(all.max[0], 0.5, 1e-6) && all.min[0] === 0.5 && all.max[1] === 0 && all.min[1] === 0, `straddling end: ${[...all.min]} ${[...all.max]}`);

  const zc = new Float32Array([0.5, 0.4, 0.3, -0.1, -0.4, -0.2, 0.3]);
  check(nearestZeroCrossing(zc, 1, 5) === 3, `zero crossing → ${nearestZeroCrossing(zc, 1, 5)}`);
  check(nearestZeroCrossing(zc, 5, 1) === 5, `zero crossing near 5 → ${nearestZeroCrossing(zc, 5, 1)}`);
  check(nearestZeroCrossing(new Float32Array([1, 1, 1, 1]), 2, 2) === 2, 'no crossing → i');
}

/* ── 4. Extraction ─────────────────────────────────────────────────────── */
console.log('Extraction');
{
  const sr = 1000;
  const x = new Float32Array(1000).map((_, i) => i / 1000 + 0.001); // 0.001 … 1.0
  const pcm = pcmOf(sr, [x]);
  const [l, r] = extractChannels(pcm, 0.2, 0.6);
  check(l.length === 400 && r.length === 400, 'length');
  check(l !== r && l.every((v, i) => v === r[i]), 'mono duplicated into two arrays');
  // 2 ms de-click at 1 kHz = 2 samples.
  check(l[0] === 0 && near(l[1], 0.5 * x[201], 1e-6) && near(l[2], x[202], 1e-6), `de-click in: ${l[0]} ${l[1]} ${l[2]}`);
  check(l[399] === 0 && near(l[397], x[597], 1e-6), 'de-click out');
  const [rv] = extractChannels(pcm, 0.2, 0.6, { reverse: true, fadeIn: 0.1 });
  check(rv[0] === 0 && near(rv[50], 0.5 * x[549], 1e-6) && near(rv[100], x[499], 1e-6), `reverse + fade-in: ${rv[50]}`);
  const [fo] = extractChannels(pcm, 0.2, 0.6, { fadeOut: 0.1 });
  check(near(fo[399 - 50], 0.5 * x[549], 1e-6) && near(fo[299], x[499], 1e-6), 'fade-out');
  const [L2, R2] = extractChannels(pcmOf(sr, [x, x.map((v) => -v)]), 0.1, 0.2);
  check(near(L2[50], x[150], 1e-6) && near(R2[50], -x[150], 1e-6), 'stereo kept');
  check(extractChannels(pcm, 2, 3)[0].length === 0, 'out of range → empty');
  check(near(peakLevel([new Float32Array([0.1, -0.7]), new Float32Array([0.5])]), 0.7, 1e-6), 'peakLevel');
}

/* ── 5. WAV ────────────────────────────────────────────────────────────── */
console.log('WAV export');
{
  const n = 1000;
  const rand = rng(11);
  const L = new Float32Array(n).map(() => rand() * 2 - 1);
  const R = new Float32Array(n).map(() => (rand() * 2 - 1) * 0.3);
  L[0] = 1.5; // clipped
  R[0] = -1.5;
  const tag = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  for (const bits of [16, 24, 32]) {
    const buf = encodeWav([L, R], 48000, bits);
    const v = new DataView(buf);
    check(tag(v, 0) === 'RIFF' && tag(v, 8) === 'WAVE' && v.getUint32(4, true) === buf.byteLength - 8, `${bits}: RIFF header`);
    // Walk chunks.
    let p = 12;
    let fmt = null;
    let data = null;
    let fact = null;
    while (p + 8 <= buf.byteLength) {
      const id = tag(v, p);
      const size = v.getUint32(p + 4, true);
      if (id === 'fmt ') fmt = { p: p + 8, size };
      if (id === 'data') data = { p: p + 8, size };
      if (id === 'fact') fact = v.getUint32(p + 8, true);
      p += 8 + size + (size & 1);
    }
    check(fmt && data, `${bits}: fmt and data chunks`);
    const f = fmt.p;
    const format = v.getUint16(f, true);
    check(format === (bits === 32 ? 3 : 1), `${bits}: format ${format}`);
    check(v.getUint16(f + 2, true) === 2 && v.getUint32(f + 4, true) === 48000, `${bits}: channels/rate`);
    check(v.getUint32(f + 8, true) === 48000 * 2 * (bits / 8) && v.getUint16(f + 12, true) === 2 * (bits / 8), `${bits}: byte rate / block align`);
    check(v.getUint16(f + 14, true) === bits, `${bits}: bits per sample`);
    check(data.size === n * 2 * (bits / 8), `${bits}: data size`);
    if (bits === 32) check(fact === n, '32: fact chunk frame count');
    // Round trip.
    const read = (i, c) => {
      const o = data.p + (i * 2 + c) * (bits / 8);
      if (bits === 16) return v.getInt16(o, true) / (v.getInt16(o, true) < 0 ? 0x8000 : 0x7fff);
      if (bits === 24) {
        let q = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
        if (q & 0x800000) q -= 0x1000000;
        return q / (q < 0 ? 0x800000 : 0x7fffff);
      }
      return v.getFloat32(o, true);
    };
    const tol = bits === 16 ? 2.5 / 32768 : bits === 24 ? 1 / 8388607 : 1e-7;
    let worst = 0;
    for (let i = 1; i < n; i++) worst = Math.max(worst, Math.abs(read(i, 0) - L[i]), Math.abs(read(i, 1) - R[i]));
    check(worst <= tol, `${bits}: round-trip error ${worst} > ${tol}`);
    check(near(read(0, 0), 1, 1e-4) && near(read(0, 1), -1, 1e-4), `${bits}: clipping ${read(0, 0)} ${read(0, 1)}`);
  }
  // Deterministic dither.
  const a = new Uint8Array(encodeWav([L], 44100, 16));
  const b = new Uint8Array(encodeWav([L], 44100, 16));
  check(a.every((x, i) => x === b[i]), '16-bit export is deterministic');
}

/* ── 6. Speed ──────────────────────────────────────────────────────────── */
console.log('\nSpeed (6-minute 44.1 kHz stereo track)');
{
  const { pcm, truth } = drumTrack({ seconds: 360, pad: true, seed: 6 });
  const t0 = performance.now();
  const peaks = buildPeaks(pcm);
  const t1 = performance.now();
  const on = detectOnsets(pcm, { sensitivity: 0.5, minGap: 0.05 });
  const t2 = performance.now();
  const s = score(on.filter((t) => t >= truth[0] - 0.015), truth);
  console.table([{ 'peaks ms': Math.round(t1 - t0), 'onsets ms': Math.round(t2 - t1), bins: peaks.min.length, onsets: on.length, recall: s.recall.toFixed(3), fp: s.fp }]);
  check(t1 - t0 < 300, `buildPeaks took ${Math.round(t1 - t0)} ms (budget 300)`);
  check(t2 - t1 < 3000, `detectOnsets took ${Math.round(t2 - t1)} ms (budget 3000)`);
  check(s.recall >= 0.95, `6-minute recall ${s.recall}`);
}

await close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll slicer DSP checks passed');
process.exit(failures ? 1 : 0);
