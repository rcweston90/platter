/**
 * The pre-split queue in Node, with the browser parts stood in for: an
 * in-memory music folder (File System Access API), a fake stems worker and
 * decoder, the browser's private storage, and a fake session (crate, decks,
 * library). Checks that it's on by default, what it splits and skips, where
 * the files go (music folder, or the browser for dropped files), that a
 * changed file is split again, that it waits while a deck plays on the CPU
 * (not on the GPU), pause/resume/off, a deck's Split going first or joining
 * the split under way, the per-track rows, and that saved stems load back.
 * Run: npm run test:presplit
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const stubs = {
  '../analysis': `export async function decodeAudio(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const n = 2000 + bytes.length;
      const ch = new Float32Array(n);
      for (let i = 0; i < n; i++) ch[i] = ((bytes[i % bytes.length] ?? 0) - 128) / 256;
      return { numberOfChannels: 1, getChannelData: () => ch, sampleRate: 44100, length: n };
    }`,
  '../library': `const kv = globalThis.__kv ??= new Map();
    export async function getValue(k) { return kv.has(k) ? structuredClone(kv.get(k)) : null; }
    export function setValue(k, v) { kv.set(k, structuredClone(v)); return Promise.resolve(); }`,
  './index': `export const STEM_RATE = 44100;
    export function stemsPolicy(rec) { return { allowed: !rec.soundcloud && !rec.audius, reason: null }; }
    export function splitInWorker(left, right, onProgress) { return globalThis.__split(left, right, onProgress); }`,
};
const out = await build({
  entryPoints: [`${root}src/engine/stems/presplit.ts`],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^(\.\.\/analysis|\.\.\/library|\.\/index)$/ }, (a) => (a.importer.endsWith('presplit.ts') ? { path: a.path, namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
      },
    },
  ],
});
const { PreSplitter } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

/* ── An in-memory folder ──────────────────────────────────────────────── */
class FileH {
  kind = 'file';
  constructor(name, dir) {
    this.name = name;
    this.dir = dir;
  }
  async getFile() {
    // After a browser restart a linked folder can't be read until it's allowed again.
    if (globalThis.__locked && this.dir.name !== 'opfs') throw new DOMException('not allowed', 'NotAllowedError');
    const e = this.dir.files.get(this.name);
    if (!e) throw new DOMException('gone', 'NotFoundError');
    return new File([e.bytes], this.name, { lastModified: e.modified });
  }
  async createWritable() {
    const parts = [];
    return {
      write: async (b) => parts.push(new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b)),
      close: async () => this.dir.files.set(this.name, { bytes: Buffer.concat(parts), modified: Date.now() }),
      abort: async () => {},
    };
  }
}
class DirH {
  kind = 'directory';
  files = new Map();
  dirs = new Map();
  writes = 0;
  constructor(name) {
    this.name = name;
  }
  async getDirectoryHandle(name, o = {}) {
    if (!this.dirs.has(name)) {
      if (!o.create) throw new DOMException('no', 'NotFoundError');
      this.dirs.set(name, new DirH(name));
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, o = {}) {
    if (!this.files.has(name)) {
      if (!o.create) throw new DOMException('no', 'NotFoundError');
      this.files.set(name, { bytes: Buffer.alloc(0), modified: Date.now() });
    }
    return new FileH(name, this);
  }
  async queryPermission() {
    return globalThis.__perm ?? 'granted';
  }
  async requestPermission() {
    return 'granted';
  }
  put(name, text, modified = 1000) {
    this.files.set(name, { bytes: Buffer.from(text), modified });
    return new FileH(name, this);
  }
}

/* The browser's private storage (OPFS), for dropped files. */
const opfs = new DirH('opfs');
Object.defineProperty(globalThis.navigator, 'storage', { value: { getDirectory: async () => opfs, persist: async () => true }, configurable: true });

/* ── A fake session ───────────────────────────────────────────────────── */
function store(state) {
  const subs = new Set();
  return { get: () => state, set: (p) => ((state = { ...state, ...p }), subs.forEach((f) => f())), subscribe: (f) => (subs.add(f), () => subs.delete(f)) };
}
const music = new DirH('Platter');
const house = await music.getDirectoryHandle('House', { create: true });
let added = 0;
const track = (id, path, handle, extra = {}) => ({ id, title: id, fileName: path.split('/').pop(), status: 'ready', handle, addedAt: ++added, library: { path, tags: {}, analysis: null }, ...extra });
const crate = store({
  tracks: [
    track('a', 'House/A.flac', house.put('A.flac', 'aaaa'.repeat(50))),
    track('b', 'B.flac', music.put('B.flac', 'bbbb'.repeat(80))),
    track('sc', 'sc', null, { soundcloud: { id: 1 }, library: undefined, handle: null }),
    track('au', 'Au.flac', music.put('Au.flac', 'x'), { audius: { id: 'x' } }),
  ],
});
const decks = [store({ playing: false, track: null }), store({ playing: false, track: null })].map((s) => ({ store: s }));
const library = { musicFolder: music, store: store({ progress: null, folderAccess: 'granted' }), allowFolder: async () => true };
const autoDj = { store: store({ queue: [] }) };
const session = { crate, decks, library, autoDj, deckLoading: false };

// The fake worker: stems = the input scaled; runs when released (so tests can step it).
const splits = [];
globalThis.__split = (left, right, onProgress) => {
  let cancel;
  const job = { id: splits.length, cancelled: false };
  job.done = new Promise((resolve, reject) => {
    job.finish = () => {
      onProgress('separate', 1);
      const s = (k) => ({ left: Int16Array.from(left, (v) => Math.round(v * k * 32767)), right: Int16Array.from(right, (v) => Math.round(v * k * 32767)) });
      resolve({ stems: [s(0.2), s(0.3), s(0.4)], seconds: 1, backend: globalThis.__backend ?? 'wasm' });
    };
    job.failModel = () => reject(new Error('The stems model couldn’t be downloaded (no connection).'));
    cancel = () => {
      job.cancelled = true;
      reject(new Error('cancelled'));
    };
  });
  job.cancel = cancel;
  splits.push(job);
  queueMicrotask(() => globalThis.__auto && job.finish());
  return job;
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

/* 1. On by default: splits the two local files, not SoundCloud or Audius. */
globalThis.__auto = true;
let p = new PreSplitter(session);
await p.init();
await until(() => p.store.get().phase === 'done', 'first pass');
assert.equal(splits.length, 2, 'two tracks split');
assert.deepEqual([p.store.get().done, p.store.get().total], [2, 2]);
const stemsDir = music.dirs.get('Platter Stems');
assert.ok(stemsDir.dirs.get('House').files.has('A.flac.platterstems'), 'mirrors the path');
assert.ok(stemsDir.files.has('B.flac.platterstems'));
assert.ok(!stemsDir.files.has('Au.flac.platterstems'), 'Audius stays whole');
assert.ok(p.store.get().bytes > 0);
assert.deepEqual(p.rows.get(), { a: { state: 'ready' }, b: { state: 'ready' } }, 'each row shows its stems');
console.log('✓ presplit: on by default; splits linked local files into “Platter Stems”, skips SoundCloud and Audius');

/* 2. Saved stems load back for the deck. */
const loaded = await p.load('a');
assert.ok(loaded && loaded.stems.length === 3 && loaded.rate === 44100);
assert.ok(await p.has('b'));
assert.equal(await p.has('sc'), false);
console.log('✓ presplit: saved stems load back for a deck');
p.dispose();

/* 3. Next session: already split, nothing to do. Then a changed file is split again. */
p = new PreSplitter(session);
await p.init();
await until(() => p.store.get().phase === 'done', 'second session');
assert.equal(splits.length, 2, 'nothing split again');
house.put('A.flac', 'changed!'.repeat(40), 2000);
crate.set({ tracks: [...crate.get().tracks] }); // a rescan
await until(() => splits.length === 3, 'changed file split again');
await until(() => p.store.get().phase === 'done', 'third pass');
assert.equal(p.store.get().done, 2);
console.log('✓ presplit: remembers what is split across sessions; a changed file is split again');

/* 4. Waits while a deck plays; a new track then waits too. */
crate.set({ tracks: [...crate.get().tracks, track('c', 'C.flac', music.put('C.flac', 'cccc'.repeat(30)))] });
decks[0].store.set({ playing: true });
crate.set({ tracks: [...crate.get().tracks] });
await until(() => p.store.get().phase === 'waiting', 'waiting for the deck');
assert.equal(p.store.get().waitingFor, 'deck');
assert.equal(splits.length, 3, 'nothing starts while a deck plays');
decks[0].store.set({ playing: false });
await until(() => splits.length === 4 && p.store.get().phase === 'done', 'split once the deck stops');
console.log('✓ presplit: never starts a track while a deck plays');

/* 5. A deck's Split goes first; pause and resume. */
globalThis.__auto = false;
crate.set({ tracks: [...crate.get().tracks, track('d', 'D.flac', music.put('D.flac', 'dddd'.repeat(30)))] });
await until(() => splits.length === 5, 'D started');
p.beforeSplit();
await tick(50);
assert.ok(splits[4].cancelled, 'background job stepped aside');
await until(() => splits.length === 6, 'D started again');
p.pause();
await tick(50);
assert.ok(splits[5].cancelled, 'pause cancels');
assert.equal(p.store.get().phase, 'paused');
assert.ok(!(await music.dirs.get('Platter Stems').files.has('D.flac.platterstems')));
globalThis.__auto = true;
await p.start();
await until(() => p.store.get().phase === 'done' && p.store.get().done === 4, 'resumed and finished');
console.log('✓ presplit: a deck’s Split goes first; pause and resume');

/* 6. A live split on a deck is kept when pre-splitting is on. */
crate.set({ tracks: [...crate.get().tracks, track('e', 'E.flac', music.put('E.flac', 'eeee'.repeat(30)))] });
p.pause();
assert.ok(p.wants('e'));
assert.ok(!p.wants('sc'));
p.keep('e', [0, 1, 2].map(() => ({ left: new Int16Array(500).fill(7), right: new Int16Array(500).fill(9) })));
await until(() => music.dirs.get('Platter Stems').files.has('E.flac.platterstems'), 'kept live split');
const e = await p.load('e');
assert.equal(e.stems[0].left[10], 7);
console.log('✓ presplit: a live split is saved too, and loads back');

/* 7. A dropped file (no folder) is split into the browser's storage, by fingerprint; the same file again isn't split twice. */
await p.start();
await until(() => p.store.get().phase === 'done', 'E done');
const n0 = splits.length;
const dropped = new File([Buffer.from('ffff'.repeat(60))], 'F.mp3', { lastModified: 5 });
crate.set({ tracks: [...crate.get().tracks, { id: 'f', title: 'F', fileName: 'F.mp3', status: 'ready', blob: dropped, addedAt: ++added }] });
await until(() => p.rows.get().f?.state === 'ready', 'dropped file split');
assert.equal(splits.length, n0 + 1);
const inBrowser = opfs.dirs.get('Platter Stems').files;
assert.equal(inBrowser.size, 1, 'one stems file in the browser');
assert.ok([...inBrowser.keys()][0].endsWith('.platterstems'));
assert.equal((await p.load('f')).stems.length, 3);
const again = new File([Buffer.from('ffff'.repeat(60))], 'F copy.mp3', { lastModified: 5 });
crate.set({ tracks: [...crate.get().tracks, { id: 'f2', title: 'F copy', fileName: 'F copy.mp3', status: 'ready', blob: again, addedAt: ++added }] });
await until(() => p.rows.get().f2?.state === 'ready', 'same file found');
assert.equal(splits.length, n0 + 1, 'the same file isn’t split again');
console.log('✓ presplit: dropped files are split into the browser’s storage; the same file is split once');

/* 8. Newest first, a deck's track before that; a deck pressing Split joins the split under way. */
globalThis.__auto = false;
crate.set({
  tracks: [...crate.get().tracks, { id: 'g', title: 'G', fileName: 'G.mp3', status: 'ready', blob: new File([Buffer.from('g'.repeat(90))], 'G.mp3'), addedAt: ++added }, { id: 'h', title: 'H', fileName: 'H.mp3', status: 'ready', blob: new File([Buffer.from('h'.repeat(70))], 'H.mp3'), addedAt: ++added }],
});
await until(() => p.store.get().current?.id === 'h' && splits.length === n0 + 2, 'newest first');
assert.equal(p.rows.get().g.state, 'queued');
assert.equal(p.rows.get().h.state, 'splitting');
const seen = [];
const joined = p.join('h', (stage, v) => seen.push(v));
assert.ok(joined, 'a deck can join');
assert.equal(p.join('g', () => {}), null, 'nothing to join for a queued track');
splits.at(-1).finish();
const got = await joined;
assert.equal(got.length, 3);
assert.deepEqual(seen, [1]);
await until(() => p.rows.get().h.state === 'ready', 'joined split saved too');
splits.at(-1).finish(); // G
await until(() => p.rows.get().g.state === 'ready', 'G');
console.log('✓ presplit: newest tracks first; a deck joins the split under way instead of starting again');

/* 9. On the GPU it carries on while a deck plays. */
globalThis.__auto = true;
globalThis.__backend = 'webgpu';
p.store.set({ backend: 'webgpu' });
decks[1].store.set({ playing: true });
crate.set({ tracks: [...crate.get().tracks, { id: 'i', title: 'I', fileName: 'I.mp3', status: 'ready', blob: new File([Buffer.from('i'.repeat(80))], 'I.mp3'), addedAt: ++added }] });
await until(() => p.rows.get().i?.state === 'ready', 'split while playing, on the GPU');
decks[1].store.set({ playing: false });
console.log('✓ presplit: on the GPU, splitting carries on while a deck plays');

/* 9b. The model can't be downloaded (offline): the track isn't blamed, the queue waits and tries again. */
globalThis.__auto = false;
crate.set({ tracks: [...crate.get().tracks, { id: 'k', title: 'K', fileName: 'K.mp3', status: 'ready', blob: new File([Buffer.from('k'.repeat(80))], 'K.mp3'), addedAt: ++added }] });
await until(() => p.store.get().current?.id === 'k' && splits.at(-1) && !splits.at(-1).cancelled, 'K started');
splits.at(-1).failModel();
await until(() => p.store.get().waitingFor === 'model', 'waiting for the model');
assert.equal(p.rows.get().k.state, 'queued', 'not marked failed');
assert.match(p.store.get().message, /no connection\)\. Trying again/);
console.log('✓ presplit: a failed model download waits and retries, without skipping the track');

/* 10. Turned off: nothing queued, and it stays off next session; saved stems still load. */
p.turnOff();
crate.set({ tracks: [...crate.get().tracks, { id: 'j', title: 'J', fileName: 'J.mp3', status: 'ready', blob: new File([Buffer.from('j'.repeat(80))], 'J.mp3'), addedAt: ++added }] });
await tick(700);
assert.equal(p.store.get().phase, 'off');
assert.equal(p.rows.get().j, undefined, 'not queued');
assert.equal(p.wants('j'), false);
p.dispose();
const n1 = splits.length;
p = new PreSplitter(session);
await p.init();
await tick(700);
assert.equal(p.store.get().phase, 'off');
assert.equal(splits.length, n1);
assert.ok(await p.load('a'), 'saved stems still load');
p.dispose();
console.log('✓ presplit: turning it off sticks; saved stems still load');

/* 11. Linked tracks the browser won't read yet (after a restart) wait; once the
   folder is allowed they go at once, Up next before the newest. */
globalThis.__auto = true;
globalThis.__locked = true;
crate.set({
  tracks: [
    ...crate.get().tracks,
    track('l1', 'L1.flac', music.put('L1.flac', 'l'.repeat(90))),
    track('l2', 'L2.flac', music.put('L2.flac', 'm'.repeat(90))),
    track('l3', 'L3.flac', music.put('L3.flac', 'n'.repeat(90))),
  ],
});
library.store.set({ folderAccess: 'prompt' });
p = new PreSplitter(session);
await p.init();
await p.start();
await until(() => p.store.get().phase === 'done' && p.store.get().locked >= 3, 'locked tracks wait', 5000);
assert.equal(p.rows.get().l1, undefined, 'not shown as queued while locked');
globalThis.__auto = false;
autoDj.store.set({ queue: ['l2'] });
globalThis.__locked = false;
library.store.set({ folderAccess: 'granted' });
await until(() => p.store.get().current?.id === 'l2' && splits.at(-1) && !splits.at(-1).cancelled, 'Up next first, once allowed', 5000);
globalThis.__auto = true;
splits.at(-1).finish();
await until(() => ['l1', 'l2', 'l3'].every((id) => p.rows.get()[id]?.state === 'ready'), 'the rest follow', 5000);
assert.equal(p.store.get().locked, 0);
p.dispose();
console.log('✓ presplit: linked tracks waiting for folder access go as soon as it’s allowed; Up next goes first');
process.exit(0);
