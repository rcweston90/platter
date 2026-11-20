/**
 * Library DSP checks on synthesised audio, no browser needed:
 *   1. tempo — drum patterns at 70…174 BPM (four-to-the-floor, boom-bap,
 *      DnB two-step, half-time, swing, a fractional tempo, offbeat noise hats
 *      over a chord bed): BPM error, octave, first beat, downbeat; silence,
 *      noise and a < 6 s file → null;
 *   2. loudness — BS.1770 reference tone (997 Hz at −20 dBFS, stereo →
 *      −23.0 LUFS), silence → −70, sample peak, K-weighting at 48 kHz;
 *   3. energy — a quiet pad scores below a dense kick/hat/bass track;
 *   4. FLAC round trip through the system ffmpeg gives the same readings;
 *   5. a 6-minute track analyses in well under 1.5 s (tempo).
 * Run: npm run test:library-dsp
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTs } from '../scripts/load-ts.mjs';

const { mods, close } = await loadTs('/src/library/dsp/pcm.ts', '/src/library/dsp/tempo.ts', '/src/library/dsp/loudness.ts');
const [{ toMono, resample, asAudioBufferLike }, { estimateTempo }, { measureLoudness, measureEnergy, kWeighting }] = mods;

const SR = 44100;
let failures = 0;
const check = (ok, msg) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
  return ok;
};

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

function makeHits(rand) {
  const kick = new Float32Array(Math.round(0.4 * SR));
  let ph = 0;
  for (let i = 0; i < kick.length; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (45 + 75 * Math.exp(-t / 0.03))) / SR;
    kick[i] = Math.sin(ph) * Math.exp(-t / 0.22) + (t < 0.002 ? 0.3 * (rand() * 2 - 1) : 0);
  }
  const snare = new Float32Array(Math.round(0.3 * SR));
  for (let i = 0; i < snare.length; i++) {
    const t = i / SR;
    snare[i] = 0.6 * (rand() * 2 - 1) * Math.exp(-t / 0.1) + 0.4 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.07);
  }
  const hat = new Float32Array(Math.round(0.08 * SR));
  let prev = 0;
  for (let i = 0; i < hat.length; i++) {
    const t = i / SR;
    const n = rand() * 2 - 1;
    hat[i] = (n - prev) * 0.5 * Math.exp(-t / 0.025);
    prev = n;
  }
  // Open hat: plain broadband noise, ~120 ms, as loud as the kick in the mix.
  const ohat = new Float32Array(Math.round(0.12 * SR));
  for (let i = 0; i < ohat.length; i++) ohat[i] = (rand() * 2 - 1) * Math.exp(-i / SR / 0.04);
  const bass = new Float32Array(Math.round(0.35 * SR));
  for (let i = 0; i < bass.length; i++) {
    const t = i / SR;
    bass[i] = Math.sin(2 * Math.PI * 55 * t) * Math.min(1, t / 0.005) * Math.min(1, (bass.length - i) / (0.02 * SR));
  }
  return { kick, snare, hat, ohat, bass };
}

/**
 * Patterns: [position in beats within a 4-beat bar, instrument, gain].
 * Offbeat 8ths are at x.5; `swing` moves them to x.667.
 */
const PATTERNS = {
  four: [
    ...[0, 1, 2, 3].map((b) => [b, 'kick', 0.8]),
    ...[0.5, 1.5, 2.5, 3.5].map((b) => [b, 'hat', 0.35]),
    [1, 'snare', 0.45],
    [3, 'snare', 0.45],
  ],
  // Downbeat test: kick on the one is heavier and carries a bass note.
  fourAccent: [
    [0, 'kick', 1.0],
    [0, 'bass', 0.35],
    ...[1, 2, 3].map((b) => [b, 'kick', 0.65]),
    ...[0.5, 1.5, 2.5, 3.5].map((b) => [b, 'hat', 0.35]),
    [1, 'snare', 0.45],
    [3, 'snare', 0.45],
  ],
  boombap: [
    [0, 'kick', 0.85],
    [2.5, 'kick', 0.7],
    [1, 'snare', 0.6],
    [3, 'snare', 0.6],
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b) => [b, 'hat', b % 1 ? 0.18 : 0.25]),
  ],
  dnb: [
    [0, 'kick', 0.85],
    [2.5, 'kick', 0.75],
    [1, 'snare', 0.6],
    [3, 'snare', 0.6],
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b) => [b, 'hat', 0.2]),
  ],
  // Kick on every beat, an open noise hat on every offbeat at similar
  // strength, nothing else (use with `bed`): the full band is an even 8th-note
  // pulse, so only the kick says which 8ths are beats.
  offbeat: [
    ...[0, 1, 2, 3].map((b) => [b, 'kick', 0.8]),
    ...[0.5, 1.5, 2.5, 3.5].map((b) => [b, 'ohat', 0.6]),
  ],
  halftime: [
    [0, 'kick', 0.9],
    [2, 'snare', 0.65],
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b) => [b, 'hat', b % 1 ? 0.2 : 0.28]),
  ],
};

/**
 * A stereo track: `pattern` at `bpm`, the first beat at `start` seconds (the
 * bar may begin `pickup` beats earlier, i.e. before the audio's first hit), a
 * −50 dBFS noise floor, ±10 % velocity and ±0.5 ms timing jitter.
 */
function drumTrack({ bpm, pattern, seconds = 60, start = 0.137, pickup = 0, swing = false, seed = 1, endBpm = bpm, bed = false }) {
  const rand = rng(seed);
  const hits = makeHits(rand);
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  // `bed`: a constant A-minor chord (A2 E3 A3 C4 E4) under the drums, at
  // about the level of the kick, so the low band is never quiet between hits.
  const chord = bed ? [110, 164.81, 220, 261.63, 329.63] : [];
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (const f of chord) c += Math.sin((2 * Math.PI * f * i) / SR + f);
    c *= 0.08;
    L[i] = c + 0.003 * (rand() * 2 - 1);
    R[i] = c + 0.003 * (rand() * 2 - 1);
  }
  // Beat times, counted from the bar's start (−pickup beats before `start`);
  // the tempo ramps linearly from bpm to endBpm over the track.
  const beats = [start - pickup * (60 / bpm)];
  while (beats[beats.length - 1] < seconds + 2) {
    const t = beats[beats.length - 1];
    beats.push(t + 60 / (bpm + ((endBpm - bpm) * Math.max(0, t)) / seconds));
  }
  const timeAt = (x) => {
    const i = Math.floor(x);
    return beats[i] + (x - i) * (beats[i + 1] - beats[i]);
  };
  const pat = PATTERNS[pattern];
  for (let bar = 0; bar * 4 + 4 < beats.length - 1; bar++) {
    for (const [pos, inst, gain] of pat) {
      let p = pos;
      if (swing && p % 1 === 0.5) p = Math.floor(p) + 2 / 3;
      const t0 = timeAt(bar * 4 + p);
      if (t0 < start - 1e-6 || t0 > seconds) continue;
      const t = t0 + (rand() - 0.5) * 0.001;
      const g = gain * (0.9 + 0.2 * rand());
      const pan = inst === 'hat' ? 0.3 : 0;
      const s = hits[inst];
      const i0 = Math.round(t * SR);
      for (let i = 0; i < s.length && i0 + i < n; i++) {
        if (i0 + i < 0) continue;
        L[i0 + i] += s[i] * g * (1 - pan);
        R[i0 + i] += s[i] * g * (1 + pan) * 0.85;
      }
    }
  }
  return { sampleRate: SR, channels: [L, R] };
}

function sineTrack({ hz, dbfs, seconds, sr = SR, channels = 2 }) {
  const a = 10 ** (dbfs / 20);
  const n = Math.round(seconds * sr);
  const out = [];
  for (let c = 0; c < channels; c++) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = a * Math.sin((2 * Math.PI * hz * i) / sr);
    out.push(x);
  }
  return { sampleRate: sr, channels: out };
}

function padTrack(seconds = 60) {
  // A quiet, slowly swelling chord: sparse, dark, no transients.
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const notes = [220, 261.63, 329.63, 392];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 16);
    let s = 0;
    for (const f of notes) s += Math.sin(2 * Math.PI * f * t + f);
    x[i] = 0.03 * env * s;
  }
  return { sampleRate: SR, channels: [x, x.slice()] };
}

/* ── 1. Tempo ──────────────────────────────────────────────────────────── */
console.log('\nTempo (60 s synthetic tracks, first beat at 0.137 s)');
const cases = [
  { name: '70 four-floor', bpm: 70, pattern: 'four', expect: 140 },
  { name: '85 boom-bap', bpm: 85, pattern: 'boombap', expect: 85 },
  { name: '90 boom-bap', bpm: 90, pattern: 'boombap', expect: 90 },
  { name: '100 boom-bap', bpm: 100, pattern: 'boombap', expect: 100 },
  { name: '120 four-floor', bpm: 120, pattern: 'four', expect: 120 },
  { name: '124 four-floor', bpm: 124, pattern: 'four', expect: 124 },
  { name: '128 four-floor', bpm: 128, pattern: 'four', expect: 128 },
  { name: '140 four-floor', bpm: 140, pattern: 'four', expect: 140 },
  { name: '140 half-time', bpm: 140, pattern: 'halftime', expect: 140, wantCand: 70 },
  { name: '150 four-floor', bpm: 150, pattern: 'four', expect: 150 },
  { name: '170 four-floor', bpm: 170, pattern: 'four', expect: 170 },
  { name: '174 DnB two-step', bpm: 174, pattern: 'dnb', expect: 174, wantCand: 87 },
  { name: '92 boom-bap swing', bpm: 92, pattern: 'boombap', swing: true, expect: 92 },
  { name: '123.5 four-floor', bpm: 123.5, pattern: 'four', expect: 123.5 },
  { name: '131.37 four-floor', bpm: 131.37, pattern: 'four', expect: 131.37 },
  { name: '97.83 boom-bap', bpm: 97.83, pattern: 'boombap', expect: 97.83 },
  // Four-on-the-floor with offbeat noise hats as loud as the kick, over a
  // chord bed: the full-band pulse fits ⅔ of the tempo (174 → 116) as well as
  // the beat; the kick must decide.
  { name: '174 offbeat hats + chords', bpm: 174, pattern: 'offbeat', bed: true, expect: 174 },
  { name: '170 offbeat hats + chords', bpm: 170, pattern: 'offbeat', bed: true, expect: 170 },
  { name: '160 offbeat hats + chords', bpm: 160, pattern: 'offbeat', bed: true, expect: 160 },
  { name: '128 offbeat hats + chords', bpm: 128, pattern: 'offbeat', bed: true, expect: 128 },
  { name: '126 downbeat (pickup 2)', bpm: 126, pattern: 'fourAccent', expect: 126, start: 2.0, pickup: 2, downbeat: true },
];
const rows = [];
for (const [i, c] of cases.entries()) {
  const start = c.start ?? 0.137;
  const pcm = drumTrack({ ...c, start, seed: 100 + i });
  const est = estimateTempo(toMono(pcm), pcm.sampleRate);
  if (!check(est, `${c.name}: no tempo`)) continue;
  const err = est.bpm - c.expect;
  const beat = 60 / c.expect;
  const octaveOk = Math.abs(est.bpm / c.expect - 1) < 0.02;
  const fbErr = est.firstBeat - start;
  // True downbeat: the bar's one; with a pickup of 2 beats, it's 2 beats after the first hit.
  const trueDown = start + ((4 - (c.pickup ?? 0)) % 4) * beat;
  const dbErr = est.firstDownbeat - trueDown;
  rows.push({
    case: c.name,
    bpm: est.bpm,
    'err BPM': +err.toFixed(3),
    octave: octaveOk ? 'ok' : 'WRONG',
    conf: est.confidence,
    stab: est.stability,
    'firstBeat ms': +(fbErr * 1000).toFixed(1),
    'downbeat ms': c.downbeat ? +(dbErr * 1000).toFixed(1) : '',
    candidates: est.candidates.slice(0, 4).map((k) => `${k.bpm}:${k.salience}`).join(' '),
  });
  check(octaveOk, `${c.name}: octave ${est.bpm} vs ${c.expect}`);
  check(Math.abs(err) < 0.1, `${c.name}: BPM error ${err.toFixed(3)}`);
  check(Math.abs(fbErr) < 0.015, `${c.name}: firstBeat off by ${(fbErr * 1000).toFixed(1)} ms`);
  check(est.candidates.some((k) => Math.abs(k.bpm - est.bpm / 2) < 0.02), `${c.name}: half-time candidate missing`);
  check(est.candidates.some((k) => Math.abs(k.bpm - est.bpm * 2) < 0.02), `${c.name}: double-time candidate missing`);
  if (c.wantCand) check(est.candidates.some((k) => Math.abs(k.bpm - c.wantCand) < 0.1), `${c.name}: ${c.wantCand} not a candidate`);
  if (c.downbeat) check(Math.abs(dbErr) < 0.015, `${c.name}: downbeat off by ${(dbErr * 1000).toFixed(1)} ms`);
  // Four-to-the-floor is unambiguous; syncopated kicks (boom-bap, DnB) and swing compete with a 1½-beat period.
  const minConf = c.pattern.startsWith('four') ? 0.6 : c.pattern === 'offbeat' ? 0.5 : 0.2;
  check(est.confidence > minConf, `${c.name}: confidence ${est.confidence} ≤ ${minConf}`);
  check(est.stability > 0.8, `${c.name}: low stability ${est.stability}`);
}
console.table(rows);

{
  const silent = { sampleRate: SR, channels: [new Float32Array(SR * 30), new Float32Array(SR * 30)] };
  check(estimateTempo(toMono(silent), SR) === null, 'silence should give null tempo');
  const rand = rng(7);
  const noise = new Float32Array(SR * 30);
  for (let i = 0; i < noise.length; i++) noise[i] = 0.3 * (rand() * 2 - 1);
  const nz = estimateTempo(noise, SR);
  check(nz === null || nz.confidence < 0.2, `white noise should give null or low confidence, got ${JSON.stringify(nz && { bpm: nz.bpm, confidence: nz.confidence })}`);
  // Drums under loud hiss are not noise: the spectrum whitens towards flat, but the kicks still stand out.
  const hissy = drumTrack({ bpm: 128, pattern: 'four', seconds: 30 });
  for (const c of hissy.channels) for (let i = 0; i < c.length; i++) c[i] += 0.1 * (rand() * 2 - 1);
  const he = estimateTempo(toMono(hissy), SR);
  check(he && Math.abs(he.bpm - 128) < 0.1, `128 four-floor under −20 dB white noise read ${he?.bpm}`);
  const tooShort = drumTrack({ bpm: 128, pattern: 'four', seconds: 5 });
  check(estimateTempo(toMono(tooShort), SR) === null, 'a 5 s clip should give null');
  const short = drumTrack({ bpm: 128, pattern: 'four', seconds: 6.5 });
  const s6 = estimateTempo(toMono(short), SR);
  check(s6 && Math.abs(s6.bpm - 128) < 0.5, `a 6.5 s clip at 128 read ${s6?.bpm}`);
  const shortish = drumTrack({ bpm: 128, pattern: 'four', seconds: 12 });
  const se = estimateTempo(toMono(shortish), SR);
  check(se && Math.abs(se.bpm - 128) < 0.1, `a 12 s clip at 128 read ${se?.bpm}`);
  // A 48 kHz source goes through the resampler.
  const at48 = drumTrack({ bpm: 128, pattern: 'four', seconds: 30 });
  const mono48 = resample(toMono(at48), SR, 48000);
  const e48 = estimateTempo(mono48, 48000);
  check(e48 && Math.abs(e48.bpm - 128) < 0.1 && Math.abs(e48.firstBeat - 0.137) < 0.015, `48 kHz input read ${e48?.bpm} / ${e48?.firstBeat}`);
  // A drummer drifting 124 → 128 over a minute is not machine-steady.
  const drift = drumTrack({ bpm: 124, endBpm: 128, pattern: 'four', seconds: 60 });
  const de = estimateTempo(toMono(drift), SR);
  check(de && de.stability < 0.5, `124→128 ramp should read unsteady, stability ${de?.stability}`);
  console.log(`124→128 BPM ramp: ${de?.bpm} BPM, stability ${de?.stability}`);
  console.log(`silence → null; noise → ${nz ? `${nz.bpm} (conf ${nz.confidence})` : 'null'}; drums + hiss → ${he?.bpm}; 5 s → null; 6.5 s → ${s6?.bpm}; 12 s → ${se?.bpm}; 48 kHz → ${e48?.bpm} @ ${e48?.firstBeat}s`);
}

/* ── 2. Loudness ───────────────────────────────────────────────────────── */
console.log('\nLoudness');
const loudRows = [];
{
  // K-weighting at 48 kHz must reproduce the published BS.1770 coefficients.
  const [s1, s2] = kWeighting(48000);
  const close6 = (a, b) => Math.abs(a - b) < 1e-6;
  check(
    close6(s1.b0, 1.53512485958697) && close6(s1.b1, -2.69169618940638) && close6(s1.b2, 1.19839281085285) && close6(s1.a1, -1.69065929318241) && close6(s1.a2, 0.73248077421585),
    `stage 1 coefficients at 48 kHz: ${JSON.stringify(s1)}`,
  );
  check(close6(s2.a1, -1.99004745483398) && close6(s2.a2, 0.99007225036621), `stage 2 coefficients at 48 kHz: ${JSON.stringify(s2)}`);

  // References: EBU Tech 3341 case 1 (1 kHz, −23 dBFS in both channels → −23.0 LUFS)
  // and BS.1770-4 (997 Hz at 0 dBFS in one channel → −3.01 LKFS). A sine's
  // dBFS is its peak, so −20 dBFS in both channels reads −20.0 LUFS.
  for (const [label, opts, want, tol] of [
    ['1 kHz −23 dBFS stereo, 48 kHz (Tech 3341 #1)', { hz: 1000, dbfs: -23, seconds: 20, sr: 48000 }, -23.0, 0.1],
    ['1 kHz −23 dBFS stereo, 44.1 kHz', { hz: 1000, dbfs: -23, seconds: 20 }, -23.0, 0.1],
    ['997 Hz −20 dBFS stereo, 44.1 kHz', { hz: 997, dbfs: -20, seconds: 20 }, -20.0, 0.1],
    ['1 kHz −20 dBFS stereo, 44.1 kHz', { hz: 1000, dbfs: -20, seconds: 20 }, -20.0, 0.2],
    ['997 Hz 0 dBFS one channel, 48 kHz (BS.1770)', { hz: 997, dbfs: 0, seconds: 10, sr: 48000, channels: 1 }, -3.01, 0.05],
    ['997 Hz −30 dBFS stereo, 96 kHz', { hz: 997, dbfs: -30, seconds: 10, sr: 96000 }, -30.0, 0.1],
    ['997 Hz −20 dBFS stereo, 22.05 kHz', { hz: 997, dbfs: -20, seconds: 10, sr: 22050 }, -20.0, 0.1],
  ]) {
    const r = measureLoudness(sineTrack(opts));
    loudRows.push({ signal: label, LUFS: +r.lufs.toFixed(3), 'expect': want, peakDb: +r.peakDb.toFixed(2), LRA: +r.lra.toFixed(2) });
    check(Math.abs(r.lufs - want) <= tol, `${label}: ${r.lufs.toFixed(3)} LUFS, want ${want} ±${tol}`);
    check(Math.abs(r.peakDb - opts.dbfs) < 0.05, `${label}: peak ${r.peakDb}`);
    check(r.lra < 0.1, `${label}: LRA of a steady tone ${r.lra}`);
  }
  // Tone stepping −20 → −30 dBFS (10 s each): the relative gate keeps both halves, so
  // integrated = power mean ≈ −22.6 LUFS; LRA ≈ 10 LU.
  const a = sineTrack({ hz: 997, dbfs: -20, seconds: 10 });
  const b = sineTrack({ hz: 997, dbfs: -30, seconds: 10 });
  const step = { sampleRate: SR, channels: a.channels.map((c, i) => { const x = new Float32Array(c.length * 2); x.set(c); x.set(b.channels[i], c.length); return x; }) };
  const rs = measureLoudness(step);
  loudRows.push({ signal: '−20 then −30 dBFS, 10 s each', LUFS: +rs.lufs.toFixed(3), expect: '≈ −22.6', peakDb: +rs.peakDb.toFixed(2), LRA: +rs.lra.toFixed(2) });
  check(Math.abs(rs.lra - 10) < 0.5, `step LRA ${rs.lra}, want ≈ 10 LU`);
  check(Math.abs(rs.lufs - -22.6) < 0.1, `step integrated ${rs.lufs}, want ≈ −22.6`);
  const silent = measureLoudness({ sampleRate: SR, channels: [new Float32Array(SR * 5), new Float32Array(SR * 5)] });
  loudRows.push({ signal: 'silence', LUFS: silent.lufs, expect: -70, peakDb: silent.peakDb, LRA: silent.lra });
  check(silent.lufs === -70 && Number.isFinite(silent.peakDb) && silent.lra === 0, `silence: ${JSON.stringify(silent)}`);
  check(JSON.stringify(silent) === JSON.stringify(JSON.parse(JSON.stringify(silent))), 'silence result must survive JSON');
}
console.table(loudRows);

/* ── 3. Energy ─────────────────────────────────────────────────────────── */
console.log('\nEnergy');
{
  const pad = padTrack();
  check(estimateTempo(toMono(padTrack(30)), SR) === null, 'a pad with no transients should give null tempo');
  const dense = drumTrack({ bpm: 130, pattern: 'fourAccent', seconds: 60 });
  // Make the dense track dense: add 16th hats and a running bassline.
  {
    const rand = rng(9);
    const hits = makeHits(rand);
    const beat = 60 / 130;
    for (let t = 0.137; t < 60; t += beat / 4) {
      const i0 = Math.round(t * SR);
      for (let i = 0; i < hits.hat.length && i0 + i < dense.channels[0].length; i++) {
        dense.channels[0][i0 + i] += hits.hat[i] * 0.25;
        dense.channels[1][i0 + i] += hits.hat[i] * 0.25;
      }
    }
    for (let t = 0.137 + beat / 2; t < 60; t += beat) {
      const i0 = Math.round(t * SR);
      for (let i = 0; i < hits.bass.length && i0 + i < dense.channels[0].length; i++) {
        dense.channels[0][i0 + i] += hits.bass[i] * 0.4;
        dense.channels[1][i0 + i] += hits.bass[i] * 0.4;
      }
    }
  }
  const rows2 = [];
  const out = {};
  for (const [name, pcm] of [['quiet pad', pad], ['dense kick/hats/bass 130', dense]]) {
    const loud = measureLoudness(pcm);
    const tempo = estimateTempo(toMono(pcm), pcm.sampleRate);
    const en = measureEnergy(pcm, loud, tempo);
    out[name] = en;
    rows2.push({ track: name, energy: en.energy, LUFS: +loud.lufs.toFixed(1), 'onsets/s': +en.onsetRate.toFixed(2), 'brightness Hz': Math.round(en.brightness), lowEnd: +en.lowEnd.toFixed(3), bpm: tempo?.bpm ?? null });
  }
  console.table(rows2);
  check(out['quiet pad'].energy < out['dense kick/hats/bass 130'].energy, 'pad energy should be below the dense track');
  check(out['quiet pad'].onsetRate < 0.5, `pad onset rate ${out['quiet pad'].onsetRate} should be ~0`);
  check(out['quiet pad'].energy <= 3, `pad energy ${out['quiet pad'].energy} should be ≤ 3`);
  check(out['dense kick/hats/bass 130'].energy >= 7, `dense energy ${out['dense kick/hats/bass 130'].energy} should be ≥ 7`);
  check(Number.isInteger(out['quiet pad'].energy), 'energy is an integer');
  // asAudioBufferLike exposes what key detection reads.
  const ab = asAudioBufferLike(pad);
  check(ab.sampleRate === SR && ab.numberOfChannels === 2 && ab.length === pad.channels[0].length && ab.getChannelData(1) === pad.channels[1] && Math.abs(ab.duration - 60) < 1e-9, 'asAudioBufferLike shape');
}

/* ── 4. FLAC round trip ────────────────────────────────────────────────── */
console.log('\nFLAC round trip (ffmpeg)');
{
  const ffmpeg = '/usr/bin/ffmpeg';
  const probe = spawnSync(ffmpeg, ['-version']);
  if (probe.status !== 0) {
    check(false, 'ffmpeg not available at /usr/bin/ffmpeg');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'platter-dsp-'));
    try {
      const pcm = drumTrack({ bpm: 128, pattern: 'fourAccent', seconds: 45, seed: 42 });
      for (const c of pcm.channels) for (let i = 0; i < c.length; i++) c[i] *= 0.5; // headroom: no clipping in 16-bit
      // 16-bit WAV, as most sources are; analyse the quantised samples so both sides see the same audio.
      const n = pcm.channels[0].length;
      const buf = Buffer.alloc(44 + n * 4);
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
      buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
      buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
      buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
      const q = [new Float32Array(n), new Float32Array(n)];
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 2; c++) {
          const s = Math.max(-32768, Math.min(32767, Math.round(pcm.channels[c][i] * 32767)));
          buf.writeInt16LE(s, 44 + i * 4 + c * 2);
          q[c][i] = s / 32768;
        }
      }
      const wav = join(dir, 'in.wav');
      const flac = join(dir, 'out.flac');
      writeFileSync(wav, buf);
      const enc = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, flac]);
      check(enc.status === 0, `ffmpeg encode failed: ${enc.stderr}`);
      const dec = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', flac, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
      check(dec.status === 0, `ffmpeg decode failed: ${dec.stderr}`);
      const f = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, dec.stdout.byteLength / 4);
      const m = f.length / 2;
      const fl = [new Float32Array(m), new Float32Array(m)];
      for (let i = 0; i < m; i++) { fl[0][i] = f[2 * i]; fl[1][i] = f[2 * i + 1]; }
      const fromWav = { sampleRate: SR, channels: q };
      const fromFlac = { sampleRate: SR, channels: fl };
      const tw = estimateTempo(toMono(fromWav), SR);
      const tf = estimateTempo(toMono(fromFlac), SR);
      const lw = measureLoudness(fromWav);
      const lf = measureLoudness(fromFlac);
      console.table([
        { source: 'WAV (16-bit)', samples: n, bpm: tw?.bpm, firstBeat: tw?.firstBeat, downbeat: tw?.firstDownbeat, LUFS: +lw.lufs.toFixed(3), peakDb: +lw.peakDb.toFixed(3), LRA: +lw.lra.toFixed(2) },
        { source: 'FLAC → f32le', samples: m, bpm: tf?.bpm, firstBeat: tf?.firstBeat, downbeat: tf?.firstDownbeat, LUFS: +lf.lufs.toFixed(3), peakDb: +lf.peakDb.toFixed(3), LRA: +lf.lra.toFixed(2) },
      ]);
      check(m === n, `FLAC decode length ${m} vs ${n}`);
      check(tw && tf && Math.abs(tw.bpm - tf.bpm) <= 0.05, `FLAC tempo ${tf?.bpm} vs WAV ${tw?.bpm}`);
      check(tw && Math.abs(tw.bpm - 128) < 0.1, `WAV tempo ${tw?.bpm}`);
      check(tw && Math.abs(tw.firstDownbeat - 0.137) < 0.015, `WAV downbeat ${tw?.firstDownbeat}, want 0.137`);
      check(tw && tf && Math.abs(tw.firstBeat - tf.firstBeat) < 0.002, 'FLAC first beat matches WAV');
      check(Math.abs(lw.lufs - lf.lufs) <= 0.1, `FLAC loudness ${lf.lufs} vs WAV ${lw.lufs}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/* ── 5. Speed: a 6-minute track ────────────────────────────────────────── */
console.log('\nSpeed (6-minute 44.1 kHz stereo track)');
{
  const pcm = drumTrack({ bpm: 128, pattern: 'fourAccent', seconds: 360, seed: 5 });
  const t0 = performance.now();
  const mono = toMono(pcm);
  const tempo = estimateTempo(mono, SR);
  const t1 = performance.now();
  const loud = measureLoudness(pcm);
  const t2 = performance.now();
  const en = measureEnergy(pcm, loud, tempo);
  const t3 = performance.now();
  console.table([{ bpm: tempo?.bpm, 'tempo ms': Math.round(t1 - t0), 'loudness ms': Math.round(t2 - t1), 'energy ms': Math.round(t3 - t2), 'total ms': Math.round(t3 - t0), energy: en.energy }]);
  check(tempo && Math.abs(tempo.bpm - 128) < 0.05, `6-minute tempo ${tempo?.bpm}`);
  check(t1 - t0 < 1500, `tempo took ${Math.round(t1 - t0)} ms (budget 1500)`);
}

await close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll library DSP checks passed');
process.exit(failures ? 1 : 0);
