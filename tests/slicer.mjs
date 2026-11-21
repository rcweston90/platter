/**
 * The slicer, end to end in Chromium: open it from the top bar, open a
 * 24-bit FLAC (made here with the system ffmpeg; a WAV without it), slice it
 * on transients and on the beat, place slices and drum hits on the timeline,
 * play, undo/redo, split and duplicate clips, render the song and the loop to
 * WAV (checked sample by sample against the slices), send slices to sampler
 * pads and the song to the crate, split a part with the stems model (a tiny
 * stand-in, as in e2e.mjs), and find the project again after a reload.
 *
 *   npm run dev            # or: npm run build && npm run preview
 *   npm run test:slicer    # URL defaults to http://localhost:5173/
 *
 * PLATTER_CHROME=/path/to/chrome picks the browser, as in e2e.mjs.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const URL_ = process.env.PLATTER_URL ?? 'http://localhost:5173/';
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

/* ── A test sample: a 90 BPM boom-bap bar loop with a chord, 4 bars ────── */
const SR = 48000;
const BPM = 90;
function sample(seconds = (4 * 4 * 60) / BPM) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const beat = (60 / BPM) * SR;
  const hits = [];
  const add = (at, fn, len) => {
    for (let i = 0; i < len && at + i < n; i++) {
      const v = fn(i / SR);
      L[at + i] += v;
      R[at + i] += v;
    }
  };
  for (let b = 0; b < 16; b++) {
    const at = Math.round(b * beat);
    if (b % 4 === 0 || b % 4 === 2) {
      hits.push(at / SR);
      let ph = 0;
      add(at, (t) => ((ph += (2 * Math.PI * (50 + 90 * Math.exp(-t / 0.03))) / SR), Math.sin(ph) * Math.exp(-t / 0.12) * 0.7), 0.4 * SR);
    } else {
      hits.push(at / SR);
      add(at, (t) => (Math.random() * 2 - 1) * Math.exp(-t / 0.06) * 0.45, 0.25 * SR);
    }
  }
  // A soft chord bed so it's not just drums.
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = 0.05 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.18 * t) + Math.sin(2 * Math.PI * 329.63 * t));
    L[i] += v;
    R[i] += v * 0.9;
  }
  return { L, R, hits };
}

function wav24(L, R) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 6);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 6, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 6, 28);
  buf.writeUInt16LE(6, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 6, 40);
  for (let i = 0; i < n; i++) {
    buf.writeIntLE(Math.round(Math.max(-1, Math.min(1, L[i])) * 8388607), 44 + i * 6, 3);
    buf.writeIntLE(Math.round(Math.max(-1, Math.min(1, R[i])) * 8388607), 47 + i * 6, 3);
  }
  return buf;
}

const dir = mkdtempSync(join(tmpdir(), 'platter-slicer-'));
const { L, R, hits } = sample();
const wavPath = join(dir, 'Dusty Break 90.wav');
writeFileSync(wavPath, wav24(L, R));
let samplePath = wavPath;
const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', wavPath, '-c:a', 'flac', '-sample_fmt', 's32', join(dir, 'Dusty Break 90.flac')]);
if (ff.status === 0) samplePath = join(dir, 'Dusty Break 90.flac');
console.log(`(test sample: ${samplePath.endsWith('.flac') ? '24-bit FLAC' : 'WAV, no ffmpeg'}, ${hits.length} hits)`);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(process.env.PLATTER_CHROME ? { executablePath: process.env.PLATTER_CHROME } : {}),
});
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));
// The stems model: a tiny stand-in with the real one's shapes (see e2e.mjs).
await page.route('https://huggingface.co/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(new URL('./fixtures/fake-demucs.onnx', import.meta.url)) }),
);

await page.goto(URL_);
await page.waitForFunction(() => window.platter && window.platterSlicer && window.platter.crate.get().loaded);
const S = (fn, arg) => page.evaluate(fn, arg);

/* ── Opening ───────────────────────────────────────────────────────────── */
await page.getByRole('button', { name: 'Slicer' }).click();
await page.waitForSelector('[data-slicer]');
check(await page.locator('[data-dj-root]').evaluate((el) => el.inert === true), 'the rig is inert under the slicer');
await page.keyboard.press('KeyW'); // deck A's play key must not reach the deck
check(!(await S(() => window.platter.decks[0].store.get().playing)), 'deck keys are off while slicing');

/* ── A FLAC in ─────────────────────────────────────────────────────────── */
const input = page.locator('[data-slicer] input[type=file]').first();
await input.setInputFiles(samplePath);
await page.waitForFunction(() => {
  const s = window.platterSlicer.store.get();
  const src = s.project.sources.find((x) => x.origin.kind === 'file');
  return src && s.audio[src.id]?.status === 'ready';
}, null, { timeout: 30000 });
const src = await S(() => window.platterSlicer.store.get().project.sources.find((x) => x.origin.kind === 'file'));
check(Math.abs(src.duration - L.length / SR) < 0.02, `file decoded: ${src.duration.toFixed(2)} s`);
check(src.bpm && Math.abs(src.bpm - BPM) < 1.5, `tempo found: ${src.bpm}`);
await page.waitForTimeout(400);
await page.screenshot({ path: join(dir, '1-loaded.png') });

/* ── Slicing ───────────────────────────────────────────────────────────── */
await S((id) => window.platterSlicer.autoSlice(id, { mode: 'transients', sensitivity: 0.5, minGap: 0.08 }), src.id);
let slices = await S((id) => window.platterSlicer.source(id).slices, src.id);
const near = hits.filter((h) => slices.some((t) => Math.abs(t - h) < 0.02)).length;
check(near >= hits.length - 1 && slices.length <= hits.length + 3, `transients: ${slices.length} slices, ${near}/${hits.length} on the hits`);
await S((id) => window.platterSlicer.autoSlice(id, { mode: 'grid', beats: 1 }), src.id);
slices = await S((id) => window.platterSlicer.source(id).slices, src.id);
check(slices.length === 16, `beat grid: ${slices.length} slices`);
await S((id) => window.platterSlicer.autoSlice(id, { mode: 'equal', count: 8 }), src.id);
check((await S((id) => window.platterSlicer.source(id).slices.length, src.id)) === 8, 'equal: 8 slices');
await S((id) => window.platterSlicer.autoSlice(id, { mode: 'transients', sensitivity: 0.5, minGap: 0.08 }), src.id);

// Slice keys: "1" auditions slice 1.
await page.locator('[data-slicer]').focus();
await page.keyboard.press('Digit2');
await page.waitForTimeout(80);
const aud = await S(() => window.platterSlicer.store.get().audition);
check(aud && aud.sourceId === src.id, 'key 2 auditions a slice');
await page.screenshot({ path: join(dir, '2-sliced.png') });

/* ── Arranging ─────────────────────────────────────────────────────────── */
const ids = await S((id) => {
  const st = window.platterSlicer;
  const p = st.store.get().project;
  st.setBpm(90);
  const lane = p.lanes.find((l) => l.kind === 'audio').id;
  // Chop: slices 1, 3, 2, 4 across bar 1, then again in bar 2.
  const out = [];
  [0, 2, 1, 3].forEach((s, k) => out.push(st.addSliceClip(id, s, lane, k)));
  const kick = p.lanes.find((l) => l.name === 'Kick').id;
  for (const b of [0, 2.5, 4, 6.5]) out.push(st.addHit(kick, b));
  return out;
}, src.id);
check(ids.every(Boolean), `placed ${ids.length} clips`);
await page.waitForTimeout(300);
const before = await S(() => window.platterSlicer.store.get().project.clips.length);
await S(() => window.platterSlicer.undo());
check((await S(() => window.platterSlicer.store.get().project.clips.length)) === before - 1, 'undo removes the last hit');
await S(() => window.platterSlicer.redo());
check((await S(() => window.platterSlicer.store.get().project.clips.length)) === before, 'redo puts it back');
await S((first) => window.platterSlicer.select([first]), ids[0]);
await page.keyboard.press('ControlOrMeta+d');
check((await S(() => window.platterSlicer.store.get().project.clips.length)) === before + 1, 'Cmd/Ctrl+D duplicates the selection');
await S(() => window.platterSlicer.splitAt(0.5, [window.platterSlicer.store.get().project.clips[0].id]));
check((await S(() => window.platterSlicer.store.get().project.clips.length)) === before + 2, 'split at a beat cuts a clip in two');
await S(() => window.platterSlicer.setLoop({ on: true, start: 0, end: 8 }));
await page.screenshot({ path: join(dir, '3-arranged.png') });

/* ── Playing ───────────────────────────────────────────────────────────── */
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
const playing = await S(() => ({ on: window.platterSlicer.store.get().playing, pos: window.platterSlicer.position() }));
check(playing.on && playing.pos > 1 && playing.pos < 4, `plays: playhead at beat ${playing.pos.toFixed(2)}`);
const peak = await S(() => {
  const [a] = window.platter.engine.masterMeters;
  const d = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(d);
  return Math.max(...d.map(Math.abs));
});
check(peak > 0.01, `heard on the master (peak ${peak.toFixed(3)})`);
await page.screenshot({ path: join(dir, '4-playing.png') });
await page.keyboard.press('Space');
check(!(await S(() => window.platterSlicer.store.get().playing)), 'Space stops');

/* ── Rendering ─────────────────────────────────────────────────────────── */
// The loop render, compared with the slices it's made of: clip 1 is slice 1
// at beat 0, so the first slice's samples come out first.
const cmp = await S(async (id) => {
  const st = window.platterSlicer;
  const p = st.store.get().project;
  const { render } = await import('/src/slicer/player.ts');
  const solo = { ...p, clips: p.clips.filter((c) => c.sourceId === id && c.at === 0 && c.start === 0), loop: { ...p.loop } };
  const buf = await render(solo, st, 0, 1, st.buffer(id).sampleRate, 0);
  const a = buf.getChannelData(0);
  const b = st.buffer(id).getChannelData(0);
  let err = 0;
  for (let i = 400; i < 8000; i++) err = Math.max(err, Math.abs(a[i] - b[i] * (p.level / 0.8) ** 2));
  return err;
}, src.id);
check(cmp < 1e-3, `render plays the slice sample-exact (max error ${cmp.toExponential(1)})`);
const [dl] = await Promise.all([page.waitForEvent('download'), S(() => window.platterSlicer.exportWav('loop', 24))]);
const wavOut = join(dir, 'out.wav');
await dl.saveAs(wavOut);
const out = readFileSync(wavOut);
const secs = out.readUInt32LE(40) / (out.readUInt32LE(28));
check(out.toString('ascii', 0, 4) === 'RIFF' && out.readUInt16LE(34) === 24, `loop WAV: 24-bit, ${secs.toFixed(3)} s`);
check(Math.abs(secs - (8 * 60) / 90) < 0.01, 'loop WAV is exactly two bars long');

/* ── Sending ───────────────────────────────────────────────────────────── */
await S(() => window.platter.sampler.select(16 * 3));
await S((id) => window.platterSlicer.sendToPads(id, [0, 1, 2]), src.id);
const pads = await S(() => window.platter.sampler.store.get().pads.slice(48, 51).map((p) => p.sound));
check(pads.every((s) => s && s.startsWith('user:')), 'three slices on pads D1–D3');
const crateBefore = await S(() => window.platter.crate.get().tracks.length);
await S(() => window.platterSlicer.sendToCrate('loop'));
check((await S(() => window.platter.crate.get().tracks.length)) === crateBefore + 1, 'the loop joins the crate');

/* ── Stems (stand-in model) ────────────────────────────────────────────── */
const vocals = await S((id) => window.platterSlicer.addStem(id, 'vocals'), src.id);
await page.waitForFunction((v) => window.platterSlicer.store.get().audio[v]?.status === 'ready', vocals, { timeout: 120000 }).catch(() => {});
const vs = await S((v) => window.platterSlicer.store.get().audio[v], vocals);
check(vs?.status === 'ready', `a vocals part splits and loads (${vs?.status}${vs?.message ? `: ${vs.message}` : ''})`);
await page.screenshot({ path: join(dir, '5-stems.png') });

/* ── Saved between visits ──────────────────────────────────────────────── */
const name = 'Slicer test chop';
await S((n) => window.platterSlicer.rename(n), name);
const clipCount = await S(() => window.platterSlicer.store.get().project.clips.length);
await page.waitForTimeout(900);
await page.reload();
await page.waitForFunction(() => window.platterSlicer && window.platter.crate.get().loaded);
await page.getByRole('button', { name: 'Slicer' }).click();
await page.waitForFunction((n) => window.platterSlicer.store.get().project.name === n, name, { timeout: 10000 }).catch(() => {});
const back = await S(() => window.platterSlicer.store.get().project);
check(back.name === name && back.clips.length === clipCount, `project back after a reload (${back.clips.length} clips)`);
await page.waitForFunction(() => {
  const s = window.platterSlicer.store.get();
  const f = s.project.sources.find((x) => x.origin.kind === 'file' && !x.stem);
  return f && s.audio[f.id]?.status === 'ready';
}, null, { timeout: 20000 }).catch(() => {});
check(await S(() => {
  const s = window.platterSlicer.store.get();
  const f = s.project.sources.find((x) => x.origin.kind === 'file' && !x.stem);
  return s.audio[f.id]?.status === 'ready';
}), 'the FLAC comes back from this browser’s storage');
await page.screenshot({ path: join(dir, '6-reloaded.png') });
await page.keyboard.press('Escape');
check(!(await page.locator('[data-slicer]').count()), 'Esc goes back to the decks');

check(!errors.length, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
await browser.close();
if (process.env.KEEP_SHOTS) console.log(`screenshots in ${dir}`);
else rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
