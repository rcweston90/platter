#!/usr/bin/env node
/**
 * Accuracy check for the library analyser against a manifest of real tracks:
 *   node scripts/eval-accuracy.mjs path/to/manifest.json
 * Each manifest entry: { file, title, truth: { bpm?, key? } | null,
 *   essentia?: { bpm, key }, librosa?: { bpm } }  (keys as Camelot).
 * Reports, per track and overall:
 *   Acc1  tempo within 4% of the reference
 *   Acc2  the same, also counting half/double/triple (octave errors)
 *   key   exact; "close" also counts relative and fifth (still mixable)
 * No audio is bundled with Platter for this — bring your own manifest.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseFile } from 'music-metadata';
import { loadTs } from './load-ts.mjs';

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('Usage: node scripts/eval-accuracy.mjs <manifest.json>');
  process.exit(1);
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const { mods, close } = await loadTs('/src/library/analyze.ts', '/src/library/tags.ts', '/src/library/mashup.ts');
const [{ analyzePcm }, { normaliseTags }, { keyRelation }] = mods;

function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '44100', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const f32 = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 2);
  const n = f32.length >> 1;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = f32[2 * i];
    R[i] = f32[2 * i + 1];
  }
  return { sampleRate: 44100, channels: [L, R] };
}

const within = (a, b, tol = 0.04) => a && b && Math.abs(a / b - 1) <= tol;
const acc2 = (a, b) => [1, 2, 0.5, 3, 1 / 3].some((m) => within(a, b * m));
const keyClose = (a, b) => ['same', 'relative', 'fifth-up', 'fifth-down'].includes(keyRelation(a, b));

const tally = { truthBpm: [0, 0, 0], essBpm: [0, 0, 0], truthKey: [0, 0, 0], essKey: [0, 0, 0], ms: 0, sec: 0 };
const rows = [];
for (const t of manifest) {
  const pcm = decode(t.file);
  const meta = await parseFile(t.file).catch(() => null);
  // Ignore tag BPM/key: this measures the audio analysis.
  const tags = { ...normaliseTags(meta, basename(t.file)), bpm: null, key: null };
  const t0 = performance.now();
  const a = analyzePcm(pcm, tags);
  tally.ms += performance.now() - t0;
  tally.sec += a.duration;
  const add = (slot, ref, ok1, ok2) => {
    if (!ref) return;
    slot[0]++;
    if (ok1) slot[1]++;
    if (ok2) slot[2]++;
  };
  add(tally.truthBpm, t.truth?.bpm, within(a.bpm, t.truth?.bpm), acc2(a.bpm, t.truth?.bpm));
  add(tally.essBpm, t.essentia?.bpm, within(a.bpm, t.essentia?.bpm), acc2(a.bpm, t.essentia?.bpm));
  add(tally.truthKey, t.truth?.key, a.key === t.truth?.key, keyClose(a.key, t.truth?.key));
  add(tally.essKey, t.essentia?.key, a.key === t.essentia?.key, keyClose(a.key, t.essentia?.key));
  rows.push({
    track: (t.title ?? basename(t.file)).slice(0, 34),
    sec: Math.round(a.duration),
    bpm: a.bpm,
    conf: a.bpmConfidence,
    'truth bpm': t.truth?.bpm ?? '',
    'ess bpm': t.essentia?.bpm ? Math.round(t.essentia.bpm * 10) / 10 : '',
    key: a.key,
    kconf: a.keyConfidence,
    'truth key': t.truth?.key ?? '',
    'ess key': t.essentia?.key ?? '',
    lufs: a.lufs,
    E: a.energy,
  });
}
await close();
console.table(rows);
const pct = ([n, x, y]) => (n ? `${x}/${n} (${Math.round((100 * x) / n)}%) · ${y}/${n} (${Math.round((100 * y) / n)}%)` : 'n/a');
console.log(`Tempo vs ground truth      Acc1 · Acc2: ${pct(tally.truthBpm)}`);
console.log(`Tempo vs Essentia          Acc1 · Acc2: ${pct(tally.essBpm)}`);
console.log(`Key vs ground truth   exact · close:    ${pct(tally.truthKey)}`);
console.log(`Key vs Essentia (edma) exact · close:   ${pct(tally.essKey)}`);
console.log(`Speed: ${(tally.sec / (tally.ms / 1000)).toFixed(0)}× real time (${(tally.ms / 1000).toFixed(1)} s for ${(tally.sec / 60).toFixed(1)} min of audio)`);
