/**
 * Saved stems (.platterstems), no browser needed: the container round-trips,
 * a changed file or another model isn't taken for the same split, paths stay
 * inside the stems folder, the PCM fallback encodes and decodes exactly, and
 * the alignment finder recovers a codec's delay.
 * (The Opus path needs WebCodecs, so it only runs in the browser, where each
 * write decodes itself back and checks the alignment before it's kept.)
 * Run: npm run test:stems
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));

async function load(entry) {
  const out = await build({ entryPoints: [`${root}${entry}`], bundle: true, format: 'esm', platform: 'node', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const sf = await load('src/engine/stems/stemfile.ts');
const codec = await load('src/engine/stems/codec.ts');

const source = { path: 'House/Song One.flac', fingerprint: 'ab'.repeat(32), size: 12345678, modified: 1700000000000 };

/* ── 1. Container ─────────────────────────────────────────────────────── */
{
  const header = {
    model: sf.STEM_MODEL,
    codec: 'opus',
    sampleRate: 48000,
    frames: 1000,
    delay: 312,
    packetFrames: 960,
    source,
    stems: ['drums', 'bass', 'vocals'],
    createdAt: new Date().toISOString(),
  };
  const packets = [0, 1, 2].map((s) => Array.from({ length: 5 + s }, (_, i) => Uint8Array.from({ length: 10 + i * 7 }, (_, j) => (i * 31 + j + s) & 255)));
  const bytes = sf.packStemFile({ header, packets });
  const back = sf.unpackStemFile(bytes);
  assert.deepEqual(back.header, header);
  assert.equal(back.packets.length, 3);
  back.packets.forEach((stem, s) => stem.forEach((p, i) => assert.deepEqual([...p], [...packets[s][i]])));
  assert.equal(sf.headerSize(bytes.subarray(0, 12)), 12 + new DataView(bytes.buffer).getUint32(8, true));
  assert.deepEqual(sf.readStemHeader(bytes.subarray(0, sf.headerSize(bytes))), header);
  assert.equal(sf.readStemHeader(new TextEncoder().encode('ID3 not a stems file at all')), null);
  assert.throws(() => sf.unpackStemFile(bytes.subarray(0, bytes.length - 3)), /cut short/);

  assert.ok(sf.headerMatches(header, { fingerprint: source.fingerprint }), 'same file');
  assert.ok(!sf.headerMatches(header, { fingerprint: 'cd'.repeat(32) }), 'changed file is split again');
  assert.ok(!sf.headerMatches({ ...header, model: 'older-model' }, { fingerprint: source.fingerprint }), 'another model is split again');
  assert.ok(!sf.headerMatches(header, { fingerprint: '' }), 'no fingerprint, no match');
  console.log('✓ stems file: packs, unpacks, reads the header alone, rejects changed files and other models');
}

/* ── 2. Where files go ────────────────────────────────────────────────── */
{
  assert.deepEqual(sf.stemFileLocation('House/Deep/Song.flac'), { dirs: ['House', 'Deep'], name: 'Song.flac.platterstems' });
  assert.deepEqual(sf.stemFileLocation('Song.flac'), { dirs: [], name: 'Song.flac.platterstems' });
  assert.deepEqual(sf.stemFileLocation('../../etc/x.mp3'), { dirs: ['etc'], name: 'x.mp3.platterstems' });
  console.log('✓ stems file location mirrors the track path and stays inside “Platter Stems”');
}

/* ── 3. PCM fallback round trip (what Node can encode) ────────────────── */
{
  const n = 44100 * 3 + 17;
  const mk = (f) => {
    const left = new Int16Array(n);
    const right = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = Math.round(12000 * Math.sin(i * f));
      right[i] = Math.round(9000 * Math.cos(i * f * 1.3));
    }
    return { left, right };
  };
  const stems = [mk(0.01), mk(0.002), mk(0.05)];
  assert.equal(await codec.canEncodeOpus(), false, 'no WebCodecs in Node');
  const file = await codec.encodeStems(stems, 44100, ['drums', 'bass', 'vocals'], source);
  assert.equal(file.header.codec, 'pcm16');
  const packed = sf.packStemFile(file);
  const raw = 3 * 2 * n * 2;
  const { stems: back, rate } = await codec.decodeStems(sf.unpackStemFile(packed));
  assert.equal(rate, 44100);
  back.forEach((s, i) => {
    assert.deepEqual([...s.left], [...stems[i].left]);
    assert.deepEqual([...s.right], [...stems[i].right]);
  });
  console.log(`✓ PCM fallback: exact round trip (${(packed.length / raw * 100).toFixed(0)}% of raw size for test tones)`);
}

/* ── 4. Alignment ─────────────────────────────────────────────────────── */
{
  const n = 48000 * 4;
  const ref = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) ref[i] = 0.5 * Math.sin(i * 0.003) * (i % 9000 < 3000 ? rnd() : 0.2 * rnd());
  for (const delay of [312, 0, 1, -40, 2000]) {
    // A codec that leads with `delay` frames of priming and adds a little noise.
    const dec = new Float32Array(n + 4096);
    for (let i = 0; i < n; i++) {
      const j = i + delay;
      if (j >= 0 && j < dec.length) dec[j] = ref[i] + 0.01 * rnd();
    }
    const got = sf.findDelay(ref, dec, { window: 8192 });
    assert.ok(got, 'found');
    assert.equal(got.delay, delay, `delay ${delay}`);
    assert.ok(got.correlation > 0.95, `correlation ${got.correlation}`);
  }
  assert.equal(sf.findDelay(new Float32Array(n), new Float32Array(n)), null, 'silence: nothing to line up');
  // Unrelated audio scores low (the browser then keeps PCM instead).
  const other = new Float32Array(n).map(() => 0.3 * rnd());
  assert.ok(sf.findDelay(ref, other, { window: 8192 }).correlation < 0.5);
  console.log('✓ alignment: codec delays found to the sample; silence and unrelated audio are told apart');
}
