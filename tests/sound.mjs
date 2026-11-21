/**
 * Sound match checks, no browser needed:
 *   1. CLAP features — the log-mel front end matches Hugging Face's Python
 *      ClapFeatureExtractor (tests/fixtures/clap-features.json) for a full
 *      10 s window and a short one (repeat-padded);
 *   2. windows — intro from the first downbeat, outro before the tail, short
 *      tracks still give three windows;
 *   3. embedding — three model runs of [1, 1, 1001, 64], unit-length vectors,
 *      through ONNX Runtime Web with a stand-in model
 *      (tests/fixtures/make-fake-clap.py);
 *   4. scoring — sound ranks against the pool and lifts the closer-sounding
 *      of two equal matches; energy direction; excluded tracks stay out;
 *      without prints the scores are what they were.
 * Run: npm run test:sound
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs } from '../scripts/load-ts.mjs';

const { mods, close } = await loadTs('/src/library/sound/features.ts', '/src/library/sound/embed.ts', '/src/library/mashup.ts');
const [feat, emb, mash] = mods;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n    ${err?.stack ?? err}`);
  }
}

/* ── 1. Features against the Python reference ─────────────────────────── */
console.log('CLAP features');
const SR = 48000;
// The same signal as the fixture's generator (computed in float64, stored as float32).
function sig(n) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * (1000 * t + 400 * t * t)) + 0.4 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-(t % 0.5) / 0.05);
  }
  return x;
}
const ref = JSON.parse(readFileSync(new URL('./fixtures/clap-features.json', import.meta.url), 'utf8'));
const ex = feat.createExtractor();
for (const [name, n] of [
  ['full', 480000],
  ['short', 130000],
]) {
  await check(`${name} window matches ClapFeatureExtractor within 0.01 dB`, () => {
    const t0 = performance.now();
    const f = ex.features(sig(n));
    const ms = performance.now() - t0;
    assert.equal(ex.frames, 1001);
    assert.equal(f.length, 1001 * 64);
    let worst = 0;
    ref[name].forEach((row, k) => row.forEach((v, m) => (worst = Math.max(worst, Math.abs(v - f[k * 100 * 64 + m])))));
    assert.ok(worst < 0.01, `worst difference ${worst.toFixed(4)} dB`);
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  });
}
await check('repeatpad: whole repeats, then silence', () => {
  const x = Float32Array.from({ length: 3 }, (_, i) => i + 1);
  assert.deepEqual([...feat.fitLength(x, 8, 'repeatpad')], [1, 2, 3, 1, 2, 3, 0, 0]);
  assert.deepEqual([...feat.fitLength(x, 8, 'repeat')], [1, 2, 3, 1, 2, 3, 1, 2]);
});

/* ── 2. Windows ───────────────────────────────────────────────────────── */
console.log('windows');
await check('a 5-minute track: intro from the downbeat, body in the middle, outro before the tail', () => {
  const w = emb.pickWindows(300, 1.5);
  assert.deepEqual(
    w.map((x) => x.name),
    ['intro', 'body', 'outro'],
  );
  assert.equal(w[0].start, 1.5);
  assert.equal(w[1].start, 145);
  assert.ok(w[2].start > 250 && w[2].start + 10 <= 290, `outro at ${w[2].start}`);
});
await check('a 6-second track still gives three full-length windows', () => {
  const w = emb.pickWindows(6, 0.4);
  assert.ok(w.every((x) => x.start === 0));
  const cut = emb.cutWindows(new Float32Array(6 * SR).fill(0.1), SR, w);
  assert.equal(cut.length, 3);
  assert.ok(cut.every((c) => c.length === 6 * SR)); // padded later by the extractor
});

/* ── 3. Embedding through ONNX Runtime with a stand-in model ──────────── */
console.log('embedding');
await check('three runs through ONNX Runtime Web, unit vectors out', async () => {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const model = readFileSync(new URL('./fixtures/fake-clap.onnx', import.meta.url));
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  const shapes = [];
  const runner = {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    run: (feeds) => {
      shapes.push(Object.values(feeds)[0].dims.join('×'));
      return session.run(feeds);
    },
  };
  const windows = [sig(480000), sig(480000).map((v) => v * 0.5), new Float32Array(480000).fill(0)];
  const p = await emb.embedWindows(runner, (data, dims) => new ort.Tensor('float32', data, dims), windows);
  assert.deepEqual(shapes, ['1×1×1001×64', '1×1×1001×64', '1×1×1001×64']);
  assert.equal(p.version, emb.PRINT_VERSION);
  for (const v of [p.intro, p.body, p.outro]) {
    assert.equal(v.length, 512);
    assert.ok(Math.abs(emb.cosine(v, v) - 1) < 1e-4);
  }
  // Same sound, quieter → closer than to silence.
  assert.ok(emb.cosine(p.intro, p.body) > emb.cosine(p.intro, p.outro));
});

/* ── 4. Scoring with sound ───────────────────────────────────────────── */
console.log('scoring');
// Prints from a direction: tracks pointing the same way sound alike.
function print(angle) {
  const v = (a) => {
    const x = new Float32Array(8);
    x[0] = Math.cos(a);
    x[1] = Math.sin(a);
    return x;
  };
  return { version: emb.PRINT_VERSION, intro: v(angle), body: v(angle), outro: v(angle) };
}
const T = (id, bpm, key, energy, angle) => ({ id, title: id, artist: '', bpm, key, energy, sound: angle == null ? null : print(angle) });

await check('of two equal matches, the closer-sounding one ranks first', () => {
  const seed = T('seed', 124, '8A', 6, 0);
  const pool = [seed, T('far-sound', 124, '8A', 6, 1.4), T('near-sound', 124, '8A', 6, 0.1)];
  for (let i = 0; i < 8; i++) pool.push(T(`filler${i}`, 124, '3B', 6, 0.2 + i * 0.15));
  const out = mash.suggestMatches(seed, pool, { allowKeyShift: false });
  assert.equal(out[0].track.id, 'near-sound');
  assert.ok(out[0].soundScore > 0.9, `sound score ${out[0].soundScore}`);
  assert.ok(out[0].reasons.some((r) => r.startsWith('Sounds close')));
  const far = out.find((m) => m.track.id === 'far-sound');
  assert.ok(far.score < out[0].score && far.soundScore < 0.2);
});
await check('sound never rescues a key clash or a tempo out of reach', () => {
  const seed = T('seed', 124, '8A', 6, 0);
  const pool = [T('twin-clash', 124, '2B', 6, 0), T('fine', 125, '8A', 6, 0.8)];
  const out = mash.suggestMatches(seed, pool, { allowKeyShift: false });
  assert.equal(out[0].track.id, 'fine');
  const far = mash.suggestMatches(seed, [T('twin-far', 150, '8A', 6, 0)], {});
  assert.equal(far.length, 0);
});
await check('energy direction: build prefers a step up, bring it down a step down', () => {
  const seed = T('seed', 124, '8A', 6);
  const pool = [T('up', 124, '8A', 7), T('down', 124, '8A', 5), T('same', 124, '8A', 6)];
  assert.equal(mash.suggestMatches(seed, pool, { direction: 'build' })[0].track.id, 'up');
  assert.equal(mash.suggestMatches(seed, pool, { direction: 'drop' })[0].track.id, 'down');
  assert.equal(mash.suggestMatches(seed, pool, { direction: 'hold' })[0].track.id, 'same');
});
await check('excluded tracks (played, on a deck) stay out', () => {
  const seed = T('seed', 124, '8A', 6);
  const out = mash.suggestMatches(seed, [T('a', 124, '8A', 6), T('b', 124, '8A', 6)], { exclude: new Set(['a']) });
  assert.deepEqual(
    out.map((m) => m.track.id),
    ['b'],
  );
});
await check('without prints, the score is the key/tempo/energy blend as before', () => {
  const m = mash.scorePair(T('a', 128, '8A', 6), T('b', 128, '8A', 6));
  assert.equal(m.soundScore, null);
  assert.equal(m.score, 1);
});
await check('prints from another model version are ignored', () => {
  const seed = T('seed', 124, '8A', 6, 0);
  const other = T('old', 124, '8A', 6, 0);
  other.sound = { ...other.sound, version: 'something-else' };
  assert.equal(mash.suggestMatches(seed, [other])[0].soundScore, null);
});

await close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
