/**
 * engine/stems/spectral.ts against demucs-web's own transforms (which it
 * replaces): the model's inputs and each part's iSTFT must match, and it
 * must be faster. No browser needed.
 * Run: npm run test:spectral
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CONSTANTS, prepareModelInput, standaloneIspec, standaloneMask } from 'demucs-web';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = await build({ entryPoints: [`${root}src/engine/stems/spectral.ts`], bundle: true, format: 'esm', platform: 'node', write: false });
const { SpectralIn, SpectralOut } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const SEG = CONSTANTS.TRAINING_SAMPLES;
const B = CONSTANTS.MODEL_SPEC_BINS;
const F = CONSTANTS.MODEL_SPEC_FRAMES;

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

function maxErr(a, b) {
  let e = 0;
  let peak = 0;
  for (let i = 0; i < a.length; i++) {
    e = Math.max(e, Math.abs(a[i] - b[i]));
    peak = Math.max(peak, Math.abs(b[i]));
  }
  return { e, peak };
}

/* ── 1. Into the model: a full segment, and a short last one (zero-padded) ── */
for (const len of [SEG, 100_000]) {
  const L = new Float32Array(SEG);
  const R = new Float32Array(SEG);
  for (let i = 0; i < len; i++) {
    L[i] = 0.6 * Math.sin(i * 0.013) + 0.2 * rand();
    R[i] = 0.5 * Math.cos(i * 0.0071) + 0.2 * rand();
  }
  const ref = prepareModelInput(L, R);
  const got = new SpectralIn().prepare(L, R);
  assert.deepEqual(Array.from(got.waveform.subarray(0, 50)), Array.from(ref.waveform.subarray(0, 50)));
  assert.equal(got.magSpec.length, ref.magSpec.length);
  const { e, peak } = maxErr(got.magSpec, ref.magSpec);
  assert.ok(e < 1e-4 * peak, `model input spectrum off by ${e} (peak ${peak}) for ${len} samples`);
  console.log(`ok - model input spectrum matches demucs-web (${len} samples; max error ${(e / peak).toExponential(1)} of peak)`);
}

/* ── 2. Out of the model: each kept part's iSTFT ─────────────────────────── */
const freq = new Float32Array(4 * 4 * B * F);
for (let i = 0; i < freq.length; i++) freq[i] = rand() * 0.3;
const specs = standaloneMask(freq);
const so = new SpectralOut();
const oL = new Float64Array(SEG);
const oR = new Float64Array(SEG);
for (const t of [0, 1, 3]) {
  for (const len of [SEG, 123_457]) {
    const ref = standaloneIspec(specs[t], SEG);
    so.istft(freq, t, len, oL, oR);
    const a = maxErr(oL.subarray(0, len), ref.left.subarray(0, len));
    const b = maxErr(oR.subarray(0, len), ref.right.subarray(0, len));
    assert.ok(a.e < 1e-4 * a.peak && b.e < 1e-4 * b.peak, `part ${t} iSTFT off by ${a.e}/${b.e} (peaks ${a.peak}/${b.peak})`);
  }
  console.log(`ok - part ${t}'s iSTFT matches demucs-web`);
}

/* ── 3. Faster: one segment's work (inputs, then three parts out) ────────── */
const L = new Float32Array(SEG).map(() => rand() * 0.5);
const R = new Float32Array(SEG).map(() => rand() * 0.5);
const time = (fn, n = 4) => {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
};
const before = time(() => {
  prepareModelInput(L, R);
  const s = standaloneMask(freq);
  for (const t of [0, 1, 3]) standaloneIspec(s[t], SEG);
});
const si = new SpectralIn();
const after = time(() => {
  si.prepare(L, R);
  for (const t of [0, 1, 3]) so.istft(freq, t, SEG, oL, oR);
});
console.log(`ok - one segment's transforms: ${before.toFixed(0)} ms with demucs-web, ${after.toFixed(0)} ms now (${(before / after).toFixed(1)}× faster)`);
assert.ok(after < before / 2, 'at least twice as fast');
