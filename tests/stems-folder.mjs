/**
 * Stems with a linked music folder: nobody presses Split, ever.
 *  - after a restart (the folder can't be read until a click), stems kept in
 *    the browser are back on both decks with nothing pressed;
 *  - a deck whose stems weren't kept says what it waits for (no Split), and
 *    the first click anywhere asks for the folder, after which they come;
 *  - a track swapped onto a deck gets its stems, even with auto-split off.
 *
 *   npm run dev & npm run test:stems-folder   # URL defaults to http://localhost:5173/
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const URL_ = process.env.PLATTER_URL ?? 'http://localhost:5173/';
const SHOTS = process.env.SHOTS;
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

/** A short stereo WAV: a tone with a kick on every beat. */
function wav(sec, f) {
  const rate = 44100;
  const n = rate * sec;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const kick = i % 22050 < 2000 ? Math.sin(i / 20) * 0.8 : 0;
    const v = Math.round((Math.sin((2 * Math.PI * f * i) / rate) * 0.2 + kick) * 20000);
    b.writeInt16LE(v, 44 + i * 4);
    b.writeInt16LE(v, 46 + i * 4);
  }
  return b;
}

const browser = await chromium.launch({
  executablePath: process.env.PLATTER_CHROME || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
// The linked folder ("Music" in the browser's private storage), read-only, as
// Chrome treats one after a restart: reading it again needs a click to allow.
await ctx.addInitScript(() => {
  const perm = () => localStorage.getItem('fakePerm') || 'granted';
  const music = (h) => h.name === 'Music' || /\.wav$/.test(h.name);
  const H = FileSystemHandle.prototype;
  H.queryPermission = async function (o) {
    if (!music(this)) return 'granted';
    return o?.mode === 'readwrite' ? 'prompt' : perm();
  };
  H.requestPermission = async function (o) {
    if (!music(this) || perm() === 'granted') return 'granted';
    if (o?.mode === 'readwrite') return 'denied';
    if (!navigator.userActivation.isActive) throw new DOMException('User activation is required to request permissions.', 'SecurityError');
    localStorage.setItem('fakePerm', 'granted');
    localStorage.setItem('asked', String(Number(localStorage.getItem('asked') || 0) + 1));
    return 'granted';
  };
  const getFile = FileSystemFileHandle.prototype.getFile;
  FileSystemFileHandle.prototype.getFile = async function () {
    if (music(this) && perm() !== 'granted') throw new DOMException('Not allowed', 'NotAllowedError');
    return getFile.call(this);
  };
  window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Music', { create: true });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('https://huggingface.co/timcsy/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(new URL('./fixtures/fake-demucs.onnx', import.meta.url)) }),
);
/** Both decks' stems rows, side by side. */
const shot = async (name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const rowA = page.getByRole('group', { name: 'Deck A stems' });
  const rowB = page.getByRole('group', { name: 'Deck B stems' });
  await rowA.scrollIntoViewIfNeeded();
  const [da, db, ra, rb] = await Promise.all([page.getByRole('region', { name: 'Deck A' }), page.getByRole('region', { name: 'Deck B' }), rowA, rowB].map((l) => l.boundingBox()));
  if (!da || !db || !ra || !rb) return;
  const top = Math.min(ra.y, rb.y) - 16;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: da.x, y: top, width: db.x + db.width - da.x, height: Math.max(ra.y + ra.height, rb.y + rb.height) - top + 16 } });
};
const status = (i) => page.evaluate((i) => window.platter.stems[i].store.get().status, i);
const splitButtons = () => page.locator('[role="group"][aria-label$=" stems"]').getByRole('button', { name: /^(Split|Load stems)$/ }).count();
const ready = (i, ms = 30000) => page.waitForFunction((i) => window.platter.stems[i].store.get().status === 'ready', i, { timeout: ms }).then(() => true, () => false);
const load = (title, i) => page.evaluate(([title, i]) => window.platter.loadToDeck(window.platter.crate.get().tracks.find((t) => t.title === title).id, i), [title, i]);
const idOf = (title) => page.evaluate((title) => window.platter.crate.get().tracks.find((t) => t.title === title).id, title);
const kept = (title) =>
  page.evaluate(async (title) => {
    const id = window.platter.crate.get().tracks.find((t) => t.title === title).id;
    for (let i = 0; i < 60; i++) {
      if (await window.platter.presplit.has(id)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }, title);

await page.goto(URL_, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.platter?.decks[0].store.get().track, null, { timeout: 20000 });
for (const [name, f] of [['Folder One.wav', 220], ['Folder Two.wav', 330], ['Folder Three.wav', 440]]) {
  await page.evaluate(
    async ([name, b64]) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Music', { create: true });
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      await w.close();
    },
    [name, wav(20, f).toString('base64')],
  );
}
await page.evaluate(() => window.platter.library.linkFolder());
await page.waitForFunction(() => window.platter.crate.get().tracks.filter((t) => t.title.startsWith('Folder') && t.status === 'ready').length === 3, null, { timeout: 90000 });

// Linked tracks onto both decks: stems arrive by themselves and are kept.
await load('Folder One', 0);
await load('Folder Two', 1);
check((await ready(0)) && (await ready(1)), 'linked tracks on both decks get their stems with nothing pressed');
check((await kept('Folder One')) && (await kept('Folder Two')), 'both decks’ stems are kept in the browser');
// Folder Two's kept stems go, so after the restart that deck has to split.
const twoId = await idOf('Folder Two');
await page.evaluate(async (id) => {
  const rec = window.platter.crate.get().tracks.find((t) => t.id === id);
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Platter Stems');
  await dir.removeEntry(`${rec.library.fingerprint}.platterstems`);
}, twoId);

// "Restart": the folder can't be read until a click.
await page.evaluate(() => localStorage.setItem('fakePerm', 'prompt'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.platter?.decks[0].store.get().track?.title === 'Folder One', null, { timeout: 20000 });
check(await ready(0, 20000), 'after a restart, deck A’s kept stems are back with nothing pressed, before the folder is allowed');
await page.waitForFunction(() => window.platter.stems[1].store.get().waiting, null, { timeout: 20000 }).catch(() => {});
const waiting = await page.evaluate(() => window.platter.stems[1].store.get().waiting);
check(!!waiting && (await status(1)) === 'idle', `deck B says what its stems wait for (“${waiting}”)`);
check((await splitButtons()) === 0, 'no Split button on either deck');
check(!(await page.evaluate(() => window.platter.decks.some((d) => d.hasAudio))), 'nothing loaded audio by itself');
await shot('after-restart');

// The first click anywhere asks for the folder once; deck B's stems follow.
await page.getByRole('heading', { name: 'Platter' }).click();
check(await ready(1, 60000), 'after the first click anywhere, deck B splits by itself');
check((await page.evaluate(() => localStorage.getItem('asked'))) === '1', 'the folder was asked for once');
await shot('after-first-click');

// Swaps: a new track on a deck gets its stems, auto-split on or off.
await load('Folder Three', 0);
check(await ready(0, 60000), 'a track swapped onto deck A gets its stems with nothing pressed');
await page.evaluate(() => window.platter.presplit.turnOff());
await load('Night Bus', 0);
check(await ready(0, 60000), 'with auto-split switched off, a swapped-in track still gets its stems');
check((await splitButtons()) === 0, 'still no Split button on either deck');
await page.evaluate(() => window.platter.presplit.start());

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
