/**
 * The pre-split queue in Node, with the browser parts stood in for: an
 * in-memory music folder (File System Access API), a fake stems worker and
 * decoder, and a fake session (crate, decks, library). Checks what it splits,
 * what it skips, where the files go, that a changed file is split again, that
 * it waits while a deck plays, pause/resume, a deck's Split going first, and
 * that saved stems load back.
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

/* ── A fake session ───────────────────────────────────────────────────── */
function store(state) {
  const subs = new Set();
  return { get: () => state, set: (p) => ((state = { ...state, ...p }), subs.forEach((f) => f())), subscribe: (f) => (subs.add(f), () => subs.delete(f)) };
}
const music = new DirH('Platter');
const house = await music.getDirectoryHandle('House', { create: true });
const track = (id, path, handle, extra = {}) => ({ id, title: id, fileName: path.split('/').pop(), status: 'ready', handle, library: { path, tags: {}, analysis: null }, ...extra });
const crate = store({
  tracks: [
    track('a', 'House/A.flac', house.put('A.flac', 'aaaa'.repeat(50))),
    track('b', 'B.flac', music.put('B.flac', 'bbbb'.repeat(80))),
    track('sc', 'sc', null, { soundcloud: { id: 1 }, library: undefined, handle: null }),
    track('au', 'Au.flac', music.put('Au.flac', 'x'), { audius: { id: 'x' } }),
  ],
});
const decks = [store({ playing: false }), store({ playing: false })].map((s) => ({ store: s }));
const library = { musicFolder: music, store: store({ progress: null }) };
const session = { crate, decks, library };

// The fake worker: stems = the input scaled; runs when released (so tests can step it).
const splits = [];
globalThis.__split = (left, right, onProgress) => {
  let cancel;
  const job = { id: splits.length, cancelled: false };
  job.done = new Promise((resolve, reject) => {
    job.finish = () => {
      onProgress('separate', 1);
      const s = (k) => ({ left: Int16Array.from(left, (v) => Math.round(v * k * 32767)), right: Int16Array.from(right, (v) => Math.round(v * k * 32767)) });
      resolve({ stems: [s(0.2), s(0.3), s(0.4)], seconds: 1, backend: 'wasm' });
    };
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

/* 1. Off until switched on; then splits the two local files, not SoundCloud or Audius. */
globalThis.__auto = true;
let p = new PreSplitter(session);
await p.init();
assert.equal(p.store.get().phase, 'off');
await p.start();
await until(() => p.store.get().phase === 'done', 'first pass');
assert.equal(splits.length, 2, 'two tracks split');
assert.deepEqual([p.store.get().done, p.store.get().total], [2, 2]);
const stemsDir = music.dirs.get('Platter Stems');
assert.ok(stemsDir.dirs.get('House').files.has('A.flac.platterstems'), 'mirrors the path');
assert.ok(stemsDir.files.has('B.flac.platterstems'));
assert.ok(!stemsDir.files.has('Au.flac.platterstems'), 'Audius stays whole');
assert.ok(p.store.get().bytes > 0);
console.log('✓ presplit: splits linked local files into “Platter Stems”, skips SoundCloud and Audius');

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
p.dispose();
console.log('✓ presplit: a live split is saved too, and loads back');
process.exit(0);
