/**
 * Library tests in Node: tags (FLAC Vorbis comments, ID3, file names),
 * fingerprints, the library file, the mashup scorer, and the scanner end to
 * end on a folder of synthesised FLAC/MP3/WAV tracks. Needs ffmpeg.
 *   npm run test:library
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import { loadTs } from '../scripts/load-ts.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`);
  }
}

const { mods, close } = await loadTs('/src/library/tags.ts', '/src/library/fingerprint.ts', '/src/library/libfile.ts', '/src/library/mashup.ts');
const [tags, fp, lib, mash] = mods;

const dir = await mkdtemp(join(tmpdir(), 'platter-lib-'));
const music = join(dir, 'Music');
await mkdir(join(music, 'Deep'), { recursive: true });

/** A short synthetic track: four-on-the-floor kick + offbeat hat + an A-minor-ish chord bed. */
function synth(path, { bpm, seconds = 24, meta = {} }) {
  const beat = 60 / bpm;
  const kick = `sin(2*PI*(50+120*exp(-mod(t,${beat})*30))*mod(t,${beat}))*exp(-mod(t,${beat})*9)`;
  const hat = `0.15*(random(0)-0.5)*exp(-mod(t+${beat / 2},${beat})*60)`;
  const chord = `0.08*(sin(2*PI*220*t)+sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+0.6*sin(2*PI*110*t))`;
  const expr = `0.6*${kick}+${hat}+${chord}`;
  const md = Object.entries(meta).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}|${expr}':s=44100:d=${seconds}`, ...md, path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

console.log('tags');
synth(join(music, 'Deep', 'Some Artist - Night Swim.flac'), {
  bpm: 124,
  meta: { TITLE: 'Night Swim', ARTIST: 'Some Artist', ALBUM: 'Late', GENRE: 'Deep House', DATE: '2021-05-01', BPM: '124', INITIALKEY: 'Am', LABEL: 'Lbl' },
});
synth(join(music, 'Tagged.mp3'), { bpm: 128, meta: { title: 'Peak', artist: 'B', TBPM: '128', TKEY: '8A', genre: 'Techno', date: '2019' } });
synth(join(music, 'Other Artist - Untagged Tool.wav'), { bpm: 174, seconds: 20 });
await writeFile(join(music, 'notes.txt'), 'not audio');

await check('FLAC Vorbis comments: title, artist, album, genre, year, label, BPM and INITIALKEY', async () => {
  const meta = await parseFile(join(music, 'Deep', 'Some Artist - Night Swim.flac'));
  const t = tags.normaliseTags(meta, 'Some Artist - Night Swim.flac');
  assert.deepEqual(
    { title: t.title, artist: t.artist, album: t.album, genre: t.genre, year: t.year, label: t.label, bpm: t.bpm, key: t.key },
    { title: 'Night Swim', artist: 'Some Artist', album: 'Late', genre: 'Deep House', year: 2021, label: 'Lbl', bpm: 124, key: '8A' },
  );
});
await check('MP3 ID3: TBPM and a Camelot TKEY', async () => {
  const t = tags.normaliseTags(await parseFile(join(music, 'Tagged.mp3')), 'Tagged.mp3');
  assert.equal(t.bpm, 128);
  assert.equal(t.key, '8A');
  assert.equal(t.genre, 'Techno');
});
await check('untagged WAV falls back to "Artist - Title"', async () => {
  const t = tags.normaliseTags(await parseFile(join(music, 'Other Artist - Untagged Tool.wav')).catch(() => null), 'Other Artist - Untagged Tool.wav');
  assert.equal(t.artist, 'Other Artist');
  assert.equal(t.title, 'Untagged Tool');
});
await check('key spellings: Am, A minor, F#m, Dbmaj, 08A, Open Key 1m/1d', () => {
  assert.equal(tags.keyFromTag('Am'), '8A');
  assert.equal(tags.keyFromTag('A minor'), '8A');
  assert.equal(tags.keyFromTag('F#m'), '11A');
  assert.equal(tags.keyFromTag('Dbmaj'), '3B');
  assert.equal(tags.keyFromTag('08A'), '8A');
  assert.equal(tags.keyFromTag('1m'), '8A');
  assert.equal(tags.keyFromTag('1d'), '8B');
  assert.equal(tags.keyFromTag('nonsense'), null);
});
await check('store file names: Bandcamp "Artist - Album - 03 Title", Beatport underscores', () => {
  assert.deepEqual(tags.namesFromFileName('Ada - Blondie - 03 Each and Every One.flac'), { artist: 'Ada', title: 'Each and Every One' });
  assert.deepEqual(tags.namesFromFileName('Moodymann_-_Shades_of_Jae.wav'), { artist: 'Moodymann', title: 'Shades of Jae' });
});

console.log('fingerprint');
await check('Node bytes and browser Blob give the same fingerprint', async () => {
  const data = new Uint8Array(700_000).map((_, i) => (i * 31) & 255);
  const a = await fp.fingerprintBlob(new Blob([data]));
  const b = await fp.fingerprintBytes(data.length, data.slice(0, fp.FINGERPRINT_CHUNK), data.slice(data.length - fp.FINGERPRINT_CHUNK));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  const small = new Uint8Array(1000).fill(7);
  assert.equal(await fp.fingerprintBlob(new Blob([small])), await fp.fingerprintBytes(1000, small, new Uint8Array(0)));
});

console.log('mashup scorer');
const T = (id, bpm, key, energy) => ({ id, title: id, artist: '', bpm, key, energy });
await check('Camelot relations', () => {
  assert.equal(mash.keyRelation('8A', '8A'), 'same');
  assert.equal(mash.keyRelation('8A', '8B'), 'relative');
  assert.equal(mash.keyRelation('8A', '9A'), 'fifth-up');
  assert.equal(mash.keyRelation('1A', '12A'), 'fifth-down');
  assert.equal(mash.keyRelation('8A', '9B'), 'diagonal');
  assert.equal(mash.keyRelation('8B', '7A'), 'diagonal');
  assert.equal(mash.keyRelation('8A', '10A'), 'boost-2');
  assert.equal(mash.keyRelation('8A', '3A'), 'semitone');
  assert.equal(mash.keyRelation('8A', '2B'), 'clash');
});
await check('half and double time', () => {
  assert.equal(mash.tempoFit(128, 64).relation, 'double');
  assert.equal(mash.tempoFit(87, 174).relation, 'half');
  assert.ok(Math.abs(mash.tempoFit(124, 128).stretchPct + 3.125) < 0.01);
});
await check('ranking: same key + close tempo beats a clash; out-of-reach tempo dropped', () => {
  const seed = T('seed', 124, '8A', 6);
  const out = mash.suggestMatches(seed, [seed, T('clash', 124, '2B', 6), T('good', 125, '8A', 6), T('far', 140, '8A', 6), T('fifth', 123, '9A', 7), T('half', 62, '8B', 5)], { allowKeyShift: false });
  const ids = out.map((m) => m.track.id);
  assert.deepEqual(ids.slice(0, 3), ['good', 'half', 'fifth']);
  assert.ok(!ids.includes('far'));
  assert.ok(!ids.includes('seed'));
  assert.equal(out.find((m) => m.track.id === 'half').tempoRelation, 'double');
  assert.ok(out[0].reasons[0].startsWith('Same key'));
});
await check('key shift rescues a clash, at a cost', () => {
  const m = mash.scorePair(T('a', 128, '8A', 6), T('b', 128, '3A', 6));
  assert.equal(m.keyShift, -1);
  assert.equal(m.keyRelation, 'same');
  assert.ok(m.keyScore < 1);
});

console.log('scanner (npm run library)');
const out = join(dir, 'tracks.json');
const run = () => spawnSync(process.execPath, [join(REPO, 'scripts', 'library.mjs'), music, '--out', out], { encoding: 'utf8', cwd: REPO });
let first;
await check('scans a folder, skips non-audio, writes a valid record', async () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  first = lib.parseLibraryFile(await readFile(out, 'utf8'));
  assert.equal(first.tracks.length, 3);
  assert.equal(first.root, 'Music');
  const flac = first.tracks.find((t) => t.path === 'Deep/Some Artist - Night Swim.flac');
  assert.ok(flac, 'FLAC record by path');
  assert.equal(flac.format, 'flac');
  assert.equal(flac.tags.key, '8A');
  assert.equal(flac.analysis.keySource, 'tag');
  assert.ok(Math.abs(flac.analysis.bpm - 124) < 0.5, `FLAC bpm ${flac.analysis.bpm}`);
  assert.ok(flac.analysis.lufs < 0 && flac.analysis.lufs > -40, `lufs ${flac.analysis.lufs}`);
  assert.ok(flac.analysis.energy >= 1 && flac.analysis.energy <= 10);
  const wav = first.tracks.find((t) => t.format === 'wav');
  assert.ok(Math.abs(wav.analysis.bpm - 174) < 0.5 || Math.abs(wav.analysis.bpm - 87) < 0.5, `wav bpm ${wav.analysis.bpm}`);
  console.log(`      ${first.tracks.map((t) => `${t.fileName}: ${t.analysis?.bpm} BPM ${t.analysis?.key} E${t.analysis?.energy}`).join(' · ')}`);
});
await check('second run reuses unchanged records (same analysedAt)', async () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 analysed, 3 unchanged/);
  const again = lib.parseLibraryFile(await readFile(out, 'utf8'));
  assert.deepEqual(
    again.tracks.map((t) => t.analysis?.analyzedAt),
    first.tracks.map((t) => t.analysis?.analyzedAt),
  );
});
await check('a moved file keeps its record (matched by fingerprint)', async () => {
  await mkdir(join(music, 'Moved'));
  spawnSync('mv', [join(music, 'Tagged.mp3'), join(music, 'Moved', 'Tagged.mp3')]);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 analysed, 3 unchanged/);
  const again = lib.parseLibraryFile(await readFile(out, 'utf8'));
  const moved = again.tracks.find((t) => t.path === 'Moved/Tagged.mp3');
  const before = first.tracks.find((t) => t.path === 'Tagged.mp3');
  assert.equal(moved?.analysis?.analyzedAt, before.analysis.analyzedAt);
});
await check('library index matches by fingerprint, then path + size, then name + size', () => {
  const idx = new lib.LibraryIndex(first.tracks);
  const t = first.tracks[0];
  assert.equal(idx.find({ fingerprint: t.fingerprint }), t);
  assert.equal(idx.find({ path: t.path, fileSize: t.fileSize }), t);
  assert.equal(idx.find({ path: t.path, fileSize: t.fileSize + 1 }), null);
  assert.equal(idx.find({ fileName: t.fileName, fileSize: t.fileSize }), t);
});
await check('a newer schema is refused', () => {
  assert.throws(() => lib.parseLibraryFile(JSON.stringify({ schemaVersion: 99, tracks: [] })), /newer/);
});

await close();
await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
