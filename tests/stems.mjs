/**
 * Stems unit checks, no browser needed:
 *   1. separate.ts — overlap-add of a fake model reproduces known stems;
 *   2. the deck worklet — all parts up plays the track itself; muting a part
 *      removes exactly that part; "other" is the track minus the rest.
 * Run: npm run test:stems
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));

/* ── 1. separate() with a fake model ───────────────────────────────────── */
const out = await build({
  entryPoints: [`${root}src/engine/stems/separate.ts`],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { separate, segmentCount, KEPT } = mod;

// Fake HTDemucs: time branch only; drums = 0.2·x, bass = 0.3·x, other = 0.1·x, vocals = 0.4·x.
const SCALE = [0.2, 0.3, 0.1, 0.4];
const runner = {
  inputNames: ['mix'],
  outputNames: ['time'],
  async run(feeds) {
    const wave = feeds.mix.data; // [1, 2, T]
    const T = wave.length / 2;
    const data = new Float32Array(4 * 2 * T);
    for (let t = 0; t < 4; t++) for (let i = 0; i < 2 * T; i++) data[t * 2 * T + i] = SCALE[t] * wave[i];
    return { time: { dims: [1, 4, 2, T], data } };
  },
};
const tensor = (data, dims) => ({ data, dims });

const N = 44100 * 20 + 1234; // 20 s and a bit: several overlapping windows
const left = new Float32Array(N);
const right = new Float32Array(N);
for (let i = 0; i < N; i++) {
  left[i] = 0.8 * Math.sin(i * 0.0123) * Math.sin(i * 0.00007);
  right[i] = 0.6 * Math.cos(i * 0.0371);
}
let calls = 0;
const stems = await separate(runner, tensor, left, right, { onProgress: () => calls++ });
assert.equal(calls, segmentCount(N), 'one progress call per segment');
assert.equal(stems.length, 3);
KEPT.forEach((t, s) => {
  let worst = 0;
  for (let i = 0; i < N; i++) {
    worst = Math.max(worst, Math.abs(stems[s].left[i] / 32767 - SCALE[t] * left[i]));
    worst = Math.max(worst, Math.abs(stems[s].right[i] / 32767 - SCALE[t] * right[i]));
  }
  assert.ok(worst < 3 / 32767, `stem ${t}: overlap-add error ${worst}`);
});
console.log(`✓ separate: ${segmentCount(N)} segments, stems match the fake model within 16-bit rounding`);

// Cancelling between segments.
await assert.rejects(separate(runner, tensor, left, right, { cancelled: () => true }), /cancelled/);
console.log('✓ separate: cancels');

/* ── 2. The worklet's stem mix ─────────────────────────────────────────── */
let Processor;
const scope = {
  sampleRate: 48000,
  currentTime: 0,
  registerProcessor: (_name, cls) => (Processor = cls),
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { postMessage() {}, onmessage: null };
    }
  },
};
new Function(...Object.keys(scope), `'use strict';${readFileSync(`${root}public/worklets/deck.js`, 'utf8')}`)(...Object.values(scope));

function render(gains, withStems = true) {
  const p = new Processor();
  const len = 48000;
  // A track at 48 kHz, and its "stems" at 44.1 kHz: three tones the track contains.
  const tone = (f, rate, n) => Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin((2 * Math.PI * f * i) / rate));
  const parts = [110, 440, 1000].map((f) => tone(f, 48000, len));
  const other = tone(3000, 48000, len);
  const mix = new Float32Array(len).map((_, i) => parts[0][i] + parts[1][i] + parts[2][i] + other[i]);
  p.message({ type: 'load', left: mix, right: mix.slice() });
  if (withStems) {
    const sl = Math.floor((len * 44100) / 48000);
    const st = [110, 440, 1000].map((f) => {
      const a = Int16Array.from(tone(f, 44100, sl), (v) => Math.round(v * 32767));
      return { left: a, right: a.slice() };
    });
    p.message({ type: 'stems', stems: st, ratio: 44100 / 48000 });
    p.message({ type: 'stemGains', gains });
  }
  p.message({ type: 'seek', frame: 0 }); // a jump: exercises the cross-fade path
  p.message({ type: 'play', instant: true });
  const L = [];
  for (let b = 0; b < 200; b++) {
    const o = [[new Float32Array(128), new Float32Array(128)]];
    p.process([], o);
    L.push(...o[0][0]);
  }
  return { L, parts, other, mix };
}

const plain = render(null, false);
assert.ok(plain.L.some((v) => v !== 0), 'the track plays through a jump');
const all = render([1, 1, 1, 1]);
let d = 0;
for (let i = 0; i < all.L.length; i++) d = Math.max(d, Math.abs(all.L[i] - plain.L[i]));
assert.equal(d, 0, 'all parts up plays the track bit for bit');
console.log('✓ worklet: every part up is the original track');

// Vocals (index 2 = the 1 kHz part) muted: after the 15 ms glide, track − part.
const noVox = render([1, 1, 0, 1]);
let err = 0;
for (let i = 4800; i < noVox.L.length - 10; i++) {
  const want = noVox.mix[i] - noVox.parts[2][i];
  err = Math.max(err, Math.abs(noVox.L[i] - want));
}
assert.ok(err < 0.01, `mute vocals error ${err}`);
console.log(`✓ worklet: muting one part removes it (max error ${err.toFixed(4)})`);

// Solo drums (index 0): only the 110 Hz part remains.
const soloDrums = render([1, 0, 0, 0]);
err = 0;
for (let i = 4800; i < soloDrums.L.length - 10; i++) err = Math.max(err, Math.abs(soloDrums.L[i] - soloDrums.parts[0][i]));
assert.ok(err < 0.01, `solo drums error ${err}`);
console.log(`✓ worklet: solo leaves only that part (max error ${err.toFixed(4)})`);

// Only "other" (index 3): track minus the three stems.
const onlyOther = render([0, 0, 0, 1]);
err = 0;
for (let i = 4800; i < onlyOther.L.length - 10; i++) err = Math.max(err, Math.abs(onlyOther.L[i] - onlyOther.other[i]));
assert.ok(err < 0.01, `other error ${err}`);
console.log(`✓ worklet: "other" is the track minus vocals, drums and bass (max error ${err.toFixed(4)})`);
