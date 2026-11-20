#!/usr/bin/env node
/**
 * Platter library scanner: analyses every audio file in a folder on your
 * computer and writes the library record (library/tracks.json by default) —
 * tempo with half/double candidates, key (Camelot), loudness, energy, beat
 * grid and tags for each track. No audio is copied or written anywhere.
 *
 *   npm run library -- ~/Music/DJ                 # scan, reuse what's unchanged
 *   npm run library -- ~/Music/DJ --force         # analyse everything again
 *   npm run library -- ~/Music/DJ --out /tmp/x.json
 *   npm run library -- ~/Music/DJ --keep-missing  # keep records of deleted files
 *
 * It runs the same analysis code as the browser (src/library), loaded
 * through Vite. Decoding uses ffmpeg if it's installed (brew install ffmpeg),
 * otherwise macOS's built-in afconvert.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';
import { loadTs } from './load-ts.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const AUDIO = /\.(mp3|wav|aiff?|flac|ogg|oga|opus|m4a|aac|webm)$/i;
const RATE = 44100;
const CHUNK = 256 * 1024;

function usage(msg) {
  if (msg) console.error(`\n  ${msg}\n`);
  console.error('  Usage: npm run library -- <music folder> [--out <file>] [--force] [--keep-missing]\n');
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) usage();
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const folderArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!folderArg) usage('Give the folder to scan.');
const folder = resolve(folderArg.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
const outPath = resolve(opt('--out') ?? join(REPO, 'library', 'tracks.json'));
const force = flag('--force');
const keepMissing = flag('--keep-missing');

/* ── Decoding ───────────────────────────────────────────────────────────── */

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasAfconvert = !hasFfmpeg && spawnSync('which', ['afconvert'], { stdio: 'ignore' }).status === 0;
if (!hasFfmpeg && !hasAfconvert) {
  usage('No decoder found. Install ffmpeg (on a Mac: brew install ffmpeg) and run this again.');
}

function deinterleave(f32, channels) {
  const n = Math.floor(f32.length / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c][i] = f32[i * channels + c];
  return out;
}

/** ffmpeg → 44.1 kHz stereo float. */
function decodeFfmpeg(file) {
  return new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-']);
    const parts = [];
    let err = '';
    p.stdout.on('data', (d) => parts.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => {
      if (code !== 0) return rej(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`));
      const buf = Buffer.concat(parts);
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
      res({ sampleRate: RATE, channels: deinterleave(f32, 2) });
    });
  });
}

/** Reads a little-endian float32 / int16 / int24 WAV (afconvert's output). */
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe) format = buf.readUInt16LE(body + 24); // extensible: sub-format GUID
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data' && fmt) {
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / ((fmt.bits / 8) * fmt.channels));
      const ch = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      const step = fmt.bits / 8;
      for (let i = 0, o = body; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++, o += step) {
          ch[c][i] =
            fmt.format === 3 && fmt.bits === 32
              ? buf.readFloatLE(o)
              : fmt.bits === 16
                ? buf.readInt16LE(o) / 32768
                : fmt.bits === 24
                  ? buf.readIntLE(o, 3) / 8388608
                  : buf.readInt32LE(o) / 2147483648;
        }
      }
      return { sampleRate: fmt.rate, channels: ch.slice(0, 2) };
    }
    pos = body + size + (size & 1);
  }
  throw new Error('WAV has no audio data');
}

let scratch = null;
/** macOS: afconvert → float WAV in a temp folder → parsed here. */
async function decodeAfconvert(file) {
  scratch ??= await mkdtemp(join(tmpdir(), 'platter-'));
  const out = join(scratch, 'decode.wav');
  const r = spawnSync('afconvert', ['-f', 'WAVE', '-d', `LEF32@${RATE}`, '-c', '2', file, out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || 'afconvert failed').trim());
  const pcm = parseWav(await readFile(out));
  await rm(out, { force: true });
  return pcm;
}

const decode = hasFfmpeg ? decodeFfmpeg : decodeAfconvert;

/* ── Files ──────────────────────────────────────────────────────────────── */

async function walk(dir, prefix = '', depth = 0, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix + e.name;
    if (e.isDirectory() && depth < 8) await walk(join(dir, e.name), `${rel}/`, depth + 1, out);
    else if (e.isFile() && AUDIO.test(e.name)) out.push(rel);
  }
  return out;
}

async function headAndTail(file, size) {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, CHUNK));
    await fh.read(head, 0, head.length, 0);
    let tail = Buffer.alloc(0);
    if (size > CHUNK) {
      const from = Math.max(CHUNK, size - CHUNK);
      tail = Buffer.alloc(size - from);
      await fh.read(tail, 0, tail.length, from);
    }
    return { head: new Uint8Array(head), tail: new Uint8Array(tail) };
  } finally {
    await fh.close();
  }
}

/* ── Main ───────────────────────────────────────────────────────────────── */

const info = await stat(folder).catch(() => null);
if (!info?.isDirectory()) usage(`Not a folder: ${folder}`);

const { mods, close } = await loadTs('/src/library/analyze.ts', '/src/library/tags.ts', '/src/library/fingerprint.ts', '/src/library/libfile.ts', '/src/library/types.ts');
const [{ analyzePcm }, { normaliseTags, formatOf }, { fingerprintBytes }, lib, { ANALYZER_VERSION }] = mods;

let previous = [];
try {
  previous = lib.parseLibraryFile(await readFile(outPath, 'utf8')).tracks;
} catch {
  // First run, or unreadable: start fresh.
}
const index = new lib.LibraryIndex(previous);
const files = await walk(folder);
console.log(`Platter library: ${files.length} audio file${files.length === 1 ? '' : 's'} in ${folder}`);
console.log(`Decoder: ${hasFfmpeg ? 'ffmpeg' : 'afconvert'} · record: ${relative(process.cwd(), outPath) || outPath}\n`);

const tracks = [];
const counts = { analysed: 0, reused: 0, failed: 0 };
const started = Date.now();
const seenPrints = new Set();
let n = 0;
for (const rel of files) {
  n++;
  const full = join(folder, rel.split('/').join(sep));
  const path = rel; // already "/"-separated
  const st = await stat(full);
  const tag = `[${String(n).padStart(String(files.length).length)}/${files.length}]`;
  try {
    // Unchanged since last time (same path, size and time)? Keep it as is.
    const byPath = index.find({ path, fileSize: st.size });
    if (!force && byPath?.analysis?.analyzer === ANALYZER_VERSION && byPath.modified === Math.round(st.mtimeMs)) {
      tracks.push(byPath);
      seenPrints.add(byPath.fingerprint);
      counts.reused++;
      continue;
    }
    const { head, tail } = await headAndTail(full, st.size);
    const fingerprint = await fingerprintBytes(st.size, head, tail);
    if (seenPrints.has(fingerprint)) {
      console.log(`${tag} duplicate of an earlier file, skipped: ${rel}`);
      continue;
    }
    seenPrints.add(fingerprint);
    const moved = index.find({ fingerprint });
    if (!force && moved?.analysis?.analyzer === ANALYZER_VERSION) {
      // Same audio under a new name or folder: keep its record, update where it is.
      tracks.push({ ...moved, path, fileName: basename(rel), modified: Math.round(st.mtimeMs) });
      counts.reused++;
      continue;
    }
    const meta = await parseFile(full, { duration: false, skipCovers: false }).catch(() => null);
    const tags = normaliseTags(meta, basename(rel));
    const t0 = Date.now();
    const pcm = await decode(full);
    const analysis = analyzePcm(pcm, tags);
    tracks.push({
      id: fingerprint,
      path,
      fileName: basename(rel),
      format: formatOf(rel),
      fileSize: st.size,
      modified: Math.round(st.mtimeMs),
      fingerprint,
      tags,
      analysis,
      addedAt: moved?.addedAt ?? byPath?.addedAt ?? new Date().toISOString(),
    });
    counts.analysed++;
    const bpm = analysis.bpm ? analysis.bpm.toFixed(1).padStart(6) : '     ?';
    const key = (analysis.key ?? '?').padStart(3);
    console.log(`${tag} ${bpm} BPM ${key}  E${analysis.energy ?? '?'}  ${analysis.lufs ?? '?'} LUFS  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${rel}`);
  } catch (err) {
    counts.failed++;
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`${tag} couldn't analyse (${reason}): ${rel}`);
    const { head, tail } = await headAndTail(full, st.size).catch(() => ({ head: new Uint8Array(), tail: new Uint8Array() }));
    const fingerprint = await fingerprintBytes(st.size, head, tail);
    tracks.push({
      id: fingerprint,
      path,
      fileName: basename(rel),
      format: formatOf(rel),
      fileSize: st.size,
      modified: Math.round(st.mtimeMs),
      fingerprint,
      tags: normaliseTags(null, basename(rel)),
      analysis: null,
      addedAt: new Date().toISOString(),
      error: reason,
    });
  }
}

const present = new Set(tracks.map((t) => t.path));
const missing = previous.filter((t) => !present.has(t.path) && !seenPrints.has(t.fingerprint));
if (keepMissing) tracks.push(...missing);

const file = lib.makeLibraryFile(tracks, basename(folder), `Platter ${ANALYZER_VERSION} (scanner)`);
await mkdir(dirname(outPath), { recursive: true });
const tmp = `${outPath}.tmp`;
await writeFile(tmp, lib.stringifyLibrary(file));
await rename(tmp, outPath);
if (scratch) await rm(scratch, { recursive: true, force: true });
await close();

const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(
  `\nDone in ${secs}s: ${counts.analysed} analysed, ${counts.reused} unchanged, ${counts.failed} failed` +
    (missing.length ? `, ${missing.length} no longer in the folder (${keepMissing ? 'kept' : 'dropped'})` : '') +
    `.\nWrote ${file.tracks.length} records to ${outPath}`,
);
