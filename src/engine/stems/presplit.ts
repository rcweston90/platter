/**
 * Auto-split: every track you add from your own files is split into stems in
 * the background, one at a time, and the stems are kept, so a deck's Split
 * (and the slicer) loads them at once instead of splitting there and then.
 * A track is only ever split once: a later session, or the same file added
 * again, finds its stems by the file's fingerprint.
 *
 * Where the stems are kept (stemfile.ts, about 30 MB a five-minute track):
 *   · next to the music, in "<linked folder>/Platter Stems/", for a linked
 *     folder's tracks once Platter may save there (a click; the browser asks);
 *   · otherwise in the browser's own private storage for this site (the
 *     Origin Private File System), which needs no permission. Files you drop
 *     or pick go there.
 * Neither leaves your computer.
 *
 * Manners:
 *  - only your own files (never Audius or SoundCloud; engine/stems'
 *    stemsPolicy has the last word);
 *  - the track on a deck first, then the newest added;
 *  - waits while tracks are being analysed (both decode audio); waits while
 *    a deck plays unless the GPU does the splitting (then playback, which
 *    runs on its own thread, isn't touched);
 *  - a deck that wants stems for the track being split now joins that split
 *    rather than starting again; for any other track the deck goes first and
 *    the background steps aside;
 *  - a file that changed since (its fingerprint moved) is split again;
 *  - on by default; Pause holds it and Turn off stops it, across restarts.
 */
import { decodeAudio } from '../analysis';
import { getValue, setValue } from '../library';
import type { DjSession } from '../session';
import { createStore, type Store } from '../store';
import type { TrackRecord } from '../types';
import { fingerprintBlob } from '../../library/fingerprint';
import { splitInWorker, stemsPolicy, STEM_RATE, type SavedStemsHook, type SplitJob } from './index';
import { access, hasSaved, loadSaved, writeSaved } from './saved';
import { modelFailed, type StemPcm } from './separate';
import type { Backend } from './worker';

const KV = 'stems.presplit';
/** The order separate.ts keeps them in. */
const NAMES = ['drums', 'bass', 'vocals'];

export type PreSplitPhase =
  /** Switched off. */
  | 'off'
  /** Looking for what's already split. */
  | 'checking'
  | 'running'
  /** On, but holding off: a deck is playing or tracks are being analysed. */
  | 'waiting'
  | 'paused'
  | 'done';

export type Stage = 'download' | 'prepare' | 'separate' | 'save';

export interface PreSplitState {
  phase: PreSplitPhase;
  /** deck: a deck plays (CPU only); analysis: tempo and key first; model: the model couldn't be downloaded (tried again shortly). */
  waitingFor: 'deck' | 'analysis' | 'model' | null;
  /** Tracks with saved stems, of those that can have them. */
  done: number;
  total: number;
  /** The track being split now. */
  current: { id: string; title: string; progress: number; stage: Stage } | null;
  /** Size of the saved stems found or written. */
  bytes: number;
  failed: number;
  /** Linked-folder tracks Platter can't read now (the browser wants the folder allowed again). */
  locked: number;
  /** One line: why it stopped, or what went wrong last. */
  message: string | null;
  /** A linked folder is there. */
  hasFolder: boolean;
  /** Platter may save in the linked folder: its tracks' stems go there. */
  inFolder: boolean;
  /** Where the last split ran. */
  backend: Backend | null;
  /** How long the last split took, in seconds, and the track's length. */
  last: { seconds: number; duration: number } | null;
}

/** One track, as the track list shows it. */
export type RowStems = { state: 'ready' } | { state: 'splitting'; progress: number; stage: Stage } | { state: 'queued' } | { state: 'failed' };

/** Bump when demo.ts changes how the demos sound, so old demo stems aren't reused. */
const DEMO_STEMS_VERSION = 1;

interface Source {
  path: string;
  fingerprint: string;
  size: number;
  modified: number | null;
}

interface Saved extends Source {
  bytes: number;
  where: 'folder' | 'browser';
}

function initial(): PreSplitState {
  return { phase: 'checking', waitingFor: null, done: 0, total: 0, current: null, bytes: 0, failed: 0, locked: 0, message: null, hasFolder: false, inFolder: false, backend: null, last: null };
}

type SplitPhase = 'download' | 'prepare' | 'separate';
type Joiner = { done: (stems: StemPcm[] | null) => void; progress: (phase: SplitPhase, p: number) => void };

/** The browser's private storage for this site, or null where there's none. */
async function privateDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const storage = (globalThis.navigator as Navigator | undefined)?.storage;
    if (!storage?.getDirectory) return null;
    const dir = await storage.getDirectory();
    // Ask the browser not to clear it under storage pressure (Chrome decides quietly).
    void storage.persist?.().catch(() => undefined);
    return dir;
  } catch {
    return null;
  }
}

/** Does this browser offer WebGPU (the worker's first choice)? */
async function hasGpu(): Promise<boolean> {
  try {
    const gpu = (globalThis.navigator as (Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }) | undefined)?.gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

export class PreSplitter implements SavedStemsHook {
  readonly store: Store<PreSplitState> = createStore(initial());
  /** Per track id, its stems' state, for the track list. */
  readonly rows: Store<Record<string, RowStems>> = createStore({});
  private enabled = true;
  private paused = false;
  private writable = false;
  private running = false;
  private disposed = false;
  private job: SplitJob | null = null;
  /** The track being split now, and decks waiting on it. */
  private live: { id: string; joiners: Joiner[] } | null = null;
  /** Track id → what's saved for it, and where. */
  private saved = new Map<string, Saved>();
  /** Track id + fingerprint that failed this session: not tried again until reload. */
  private failed = new Set<string>();
  /** Linked tracks that couldn't be read on the last look (folder permission, or gone). */
  private unreadable = new Set<string>();
  /** Fingerprints of dropped files (a Blob never changes). */
  private prints = new Map<string, string>();
  private wake: (() => void) | null = null;
  private unsubs: (() => void)[] = [];
  private writes: Promise<void> = Promise.resolve();
  private folderName: string | null = null;
  private browser: Promise<FileSystemDirectoryHandle | null> | null = null;
  private watchers = new Map<string, Set<() => void>>();
  /** The model download failed: the queue waits a minute and tries again (no track is to blame). */
  private modelDown = false;
  /** Split, and being written to storage now. */
  private saving = new Set<string>();
  /** The linked folder's read permission, as last seen. */
  private access: PermissionState | null = null;
  /** Before the first split says which backend runs: whether this browser offers a GPU (WebGPU). */
  private gpu = false;

  constructor(private readonly session: DjSession) {}

  /** Auto-split is switched on (paused or not): decks get their stems by themselves. */
  get on() {
    return this.enabled;
  }

  private get folder(): FileSystemDirectoryHandle | null {
    return this.session.library.musicFolder;
  }

  private browserDir() {
    return (this.browser ??= privateDir());
  }

  async init() {
    this.disposed = false;
    void hasGpu().then((yes) => {
      this.gpu = yes;
      this.wake?.();
    });
    const kv = await getValue<{ enabled: boolean; paused: boolean }>(KV);
    // On unless switched off.
    this.enabled = kv ? !!kv.enabled : true;
    this.paused = !!kv?.paused;
    this.folderName = this.folder?.name ?? null;
    this.writable = !!this.folder && (await access(this.folder, 'readwrite', false)) === 'granted';
    this.store.set({ hasFolder: !!this.folder, inFolder: this.writable });
    const poke = () => this.wake?.();
    this.unsubs.push(
      this.session.crate.subscribe(poke),
      this.session.library.store.subscribe(() => {
        const access = this.session.library.store.get().folderAccess;
        if (access === 'granted' && this.access !== 'granted' && this.unreadable.size) {
          // Allowed again: the tracks that waited can be read now.
          this.unreadable.clear();
          this.tally();
        }
        this.access = access;
        const name = this.folder?.name ?? null;
        if (name !== this.folderName) {
          // Another folder: what's saved there is looked up again.
          this.folderName = name;
          for (const [id, s] of this.saved) if (s.where === 'folder') this.saved.delete(id);
          this.writable = false;
          this.store.set({ hasFolder: !!this.folder, inFolder: false });
        }
        poke();
      }),
      ...this.session.decks.map((d) => d.store.subscribe(poke)),
      this.session.autoDj.store.subscribe(poke),
    );
    if (!this.enabled) {
      this.store.set({ phase: 'off' });
      return;
    }
    if (this.paused) {
      this.store.set({ phase: 'paused' });
      void this.count();
      return;
    }
    void this.run();
  }

  dispose() {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.job?.cancel();
    this.wake?.();
  }

  /* ── Controls ─────────────────────────────────────────────────────── */

  /** Switch auto-splitting on, or resume it. */
  async start() {
    this.enabled = true;
    this.paused = false;
    this.persist();
    this.store.set({ message: null });
    this.wake?.();
    void this.run();
  }

  /** Keep the linked folder's stems next to the music (a click: the browser may ask). */
  async saveInFolder() {
    const dir = this.folder;
    if (!dir) return;
    if ((await access(dir, 'readwrite', true)) !== 'granted') {
      this.store.set({ message: `Platter needs permission to save files in “${dir.name}” to keep stems there. They stay in the browser meanwhile.` });
      return;
    }
    this.writable = true;
    this.store.set({ inFolder: true, message: null });
    this.wake?.();
  }

  /** Inside a click: allow the linked folder again, so its tracks can be split. */
  async allowFolder() {
    if (!(await this.session.library.allowFolder())) return;
    this.unreadable.clear();
    this.tally();
    this.wake?.();
  }

  /** The library's state (for whether the linked folder can be read). */
  get libraryStore() {
    return this.session.library.store;
  }

  pause() {
    this.paused = true;
    this.persist();
    this.job?.cancel();
    this.store.set({ phase: 'paused', waitingFor: null });
    this.tally();
    this.wake?.();
  }

  /** Switch it off (saved stems stay where they are, and still load). */
  turnOff() {
    this.enabled = false;
    this.paused = false;
    this.persist();
    this.job?.cancel();
    this.store.set({ phase: 'off', waitingFor: null, current: null });
    this.tally();
    this.wake?.();
  }

  private persist() {
    void setValue(KV, { enabled: this.enabled, paused: this.paused });
  }

  /* ── What can be split ─────────────────────────────────────────────── */

  private fromFolder(rec: TrackRecord) {
    return !!rec.handle && !!rec.library?.path;
  }

  private eligible(rec: TrackRecord): boolean {
    if (rec.demo || rec.audius || rec.soundcloud || rec.status === 'error' || !stemsPolicy(rec).allowed) return false;
    return this.fromFolder(rec) ? !!this.folder : !!rec.blob;
  }

  private tracks(): TrackRecord[] {
    return this.session.crate.get().tracks.filter((t) => this.eligible(t));
  }

  /** The file behind a track now, with its fingerprint (reused while size and date hold). Null: can't read it now. */
  /** Whose stems a deck may keep and load: anything the background splits,
   *  plus the built-in demos (split on a deck, never queued). */
  private keepable(rec: TrackRecord): boolean {
    return this.eligible(rec) || (!!rec.demo && stemsPolicy(rec).allowed);
  }

  private async source(rec: TrackRecord): Promise<{ file: Blob; src: Source } | null> {
    if (rec.demo) {
      // Synthesised the same way every time: the demo's id names its stems.
      const key = `demo-${rec.demo}-v${DEMO_STEMS_VERSION}`;
      return { file: new Blob(), src: { path: key, fingerprint: key, size: 0, modified: null } };
    }
    if (this.fromFolder(rec)) {
      let file: File;
      try {
        file = await rec.handle!.getFile();
      } catch {
        return null; // moved, deleted, or no permission
      }
      const lib = rec.library!;
      const modified = file.lastModified || null;
      const known = this.saved.get(rec.id);
      let fingerprint: string;
      if (known && known.size === file.size && known.modified === modified) fingerprint = known.fingerprint;
      else if (lib.fingerprint && lib.fileSize === file.size && lib.modified === modified) fingerprint = lib.fingerprint;
      else fingerprint = await fingerprintBlob(file);
      return { file, src: { path: lib.path!, fingerprint, size: file.size, modified } };
    }
    const blob = rec.blob;
    if (!blob) return null;
    let fingerprint = this.prints.get(rec.id);
    if (!fingerprint) {
      fingerprint = await fingerprintBlob(blob);
      this.prints.set(rec.id, fingerprint);
    }
    const modified = (blob as File).lastModified || null;
    return { file: blob, src: { path: rec.fileName || rec.title, fingerprint, size: blob.size, modified } };
  }

  /** Where a track's stems would be kept: under which root, at which path. */
  private async target(rec: TrackRecord, src: Source): Promise<{ dir: FileSystemDirectoryHandle; path: string; where: Saved['where'] } | null> {
    if (this.fromFolder(rec) && this.writable && this.folder) return { dir: this.folder, path: src.path, where: 'folder' };
    const dir = await this.browserDir();
    // In the browser, by fingerprint: the same file added twice is split once.
    return dir ? { dir, path: src.fingerprint, where: 'browser' } : null;
  }

  /** Is there a saved split of this track's current file? Fills `saved`. */
  private async check(rec: TrackRecord): Promise<boolean> {
    const got = await this.source(rec);
    if (!got) return false;
    const { src } = got;
    const known = this.saved.get(rec.id);
    if (known?.fingerprint === src.fingerprint) return true;
    let found: { bytes: number } | null = null;
    let where: Saved['where'] = 'folder';
    if (this.fromFolder(rec) && this.folder) found = await hasSaved(this.folder, src.path, src.fingerprint);
    if (!found) {
      const dir = await this.browserDir();
      where = 'browser';
      if (dir) found = await hasSaved(dir, src.fingerprint, src.fingerprint);
    }
    if (found) this.saved.set(rec.id, { ...src, bytes: found.bytes, where });
    else this.saved.delete(rec.id);
    return !!found;
  }

  private failKey(rec: TrackRecord) {
    return `${rec.id}:${rec.library?.fingerprint ?? this.prints.get(rec.id) ?? ''}`;
  }

  /** Counts, and each track's row. */
  private tally() {
    const tracks = this.tracks();
    const ids = new Set(tracks.map((t) => t.id));
    let done = 0;
    let bytes = 0;
    for (const [id, s] of this.saved) {
      if (!ids.has(id)) continue;
      done++;
      bytes += s.bytes;
    }
    this.store.set({ done, total: ids.size, bytes, failed: this.failed.size, locked: this.unreadable.size });

    const on = this.enabled && !this.paused;
    const cur = this.store.get().current;
    const rows: Record<string, RowStems> = {};
    for (const t of tracks) {
      if (this.saved.has(t.id)) rows[t.id] = { state: 'ready' };
      else if (this.saving.has(t.id)) rows[t.id] = { state: 'splitting', progress: 1, stage: 'save' };
      else if (cur?.id === t.id) rows[t.id] = { state: 'splitting', progress: cur.progress, stage: cur.stage };
      else if (this.failed.has(this.failKey(t))) rows[t.id] = { state: 'failed' };
      else if (on && !this.unreadable.has(t.id)) rows[t.id] = { state: 'queued' };
    }
    const prev = this.rows.get();
    const keys = Object.keys(rows);
    const same =
      keys.length === Object.keys(prev).length &&
      keys.every((k) => {
        const a = rows[k];
        const b = prev[k];
        return !!b && a.state === b.state && (a.state !== 'splitting' || (b.state === 'splitting' && a.progress === b.progress && a.stage === b.stage));
      });
    if (!same) this.rows.set(rows);
    for (const [id, fns] of this.watchers) if (this.saved.has(id)) fns.forEach((f) => f());
  }

  private setCurrent(cur: PreSplitState['current']) {
    this.store.set({ current: cur });
    this.tally();
  }

  /** Counts what's already saved (for the paused display). */
  private async count() {
    for (const t of this.tracks()) await this.check(t).catch(() => false);
    this.tally();
  }

  /* ── The loop ──────────────────────────────────────────────────────── */

  private holdReason(): 'deck' | 'analysis' | null {
    // A deck loading a track goes first (both decode).
    if (this.session.deckLoading) return 'deck';
    if (this.session.library.store.get().progress) return 'analysis';
    if (this.session.crate.get().tracks.some((t) => t.status === 'analysing')) return 'analysis';
    // On the GPU, splitting leaves the audio thread alone: carry on while a deck plays.
    // Until a split has run, go by whether the browser offers a GPU (the worker may still fall back to the CPU).
    const backend = this.store.get().backend;
    const onGpu = backend ? backend === 'webgpu' : this.gpu;
    if (!onGpu && this.session.decks.some((d) => d.store.get().playing)) return 'deck';
    return null;
  }

  /** Until something changes (a deck stops, analysis ends, the crate moves), or a minute. */
  private sleep(ms = 60_000, wakeOnChange = true) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = () => {
        // Pause, off and dispose always wake it; crate and deck changes only when asked.
        if (!wakeOnChange && this.go()) return;
        this.wake = null;
        // Let a burst of changes settle.
        setTimeout(done, 500);
      };
    });
  }

  private go() {
    return this.enabled && !this.paused && !this.disposed;
  }

  /** What to split next: a deck's track first, then Up next in its order,
   *  then the newest added. */
  private next(): TrackRecord | null {
    const onDeck = new Set(this.session.decks.map((d) => d.store.get().track?.id).filter(Boolean));
    const queue = this.session.autoDj.store.get().queue;
    const rank = (t: TrackRecord) => (onDeck.has(t.id) ? 0 : queue.includes(t.id) ? 1 + queue.indexOf(t.id) : Infinity);
    let best: TrackRecord | null = null;
    let bestRank = Infinity;
    for (const t of this.tracks()) {
      if (this.saved.has(t.id) || this.saving.has(t.id) || this.failed.has(this.failKey(t)) || this.unreadable.has(t.id)) continue;
      const r = rank(t);
      if (!best || r < bestRank || (r === bestRank && t.addedAt > best.addedAt)) {
        best = t;
        bestRank = r;
      }
    }
    return best;
  }

  /** Looks for what's split already (cheap while files keep their size and date). */
  private async scan() {
    this.unreadable.clear();
    for (const t of this.tracks()) {
      if (!this.go()) break;
      const ok = await this.check(t).catch(() => false);
      if (!ok && this.fromFolder(t) && !(await this.source(t))) this.unreadable.add(t.id);
    }
    this.tally();
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      this.store.set({ phase: 'checking', waitingFor: null });
      await this.scan();
      while (this.go()) {
        let todo = this.next();
        if (!todo && this.saving.size) {
          await this.writes; // the last save, before calling it done
          todo = this.next();
        }
        if (!todo) {
          this.tally();
          this.store.set({ phase: 'done', current: null, waitingFor: null });
          await this.sleep(); // new tracks may arrive
          if (this.go()) await this.scan(); // a rescan may have added or changed files
          continue;
        }
        if (this.modelDown) {
          this.modelDown = false;
          this.store.set({ phase: 'waiting', waitingFor: 'model' });
          this.setCurrent(null);
          await this.sleep(60_000, false);
          continue;
        }
        const hold = this.holdReason();
        if (hold) {
          this.store.set({ phase: 'waiting', waitingFor: hold });
          this.setCurrent(null);
          await this.sleep();
          continue;
        }
        this.store.set({ phase: 'running', waitingFor: null });
        await this.splitOne(todo);
        this.setCurrent(null);
      }
    } finally {
      this.running = false;
      this.setCurrent(null);
      if (this.enabled && this.paused) this.store.set({ phase: 'paused' });
    }
  }

  private async splitOne(rec: TrackRecord) {
    this.setCurrent({ id: rec.id, title: rec.title, progress: 0, stage: 'prepare' });
    const got = await this.source(rec);
    if (!got) {
      if (this.fromFolder(rec)) this.unreadable.add(rec.id);
      else {
        this.failed.add(this.failKey(rec));
        this.store.set({ message: `Couldn’t read “${rec.title}”: skipped it.` });
      }
      return;
    }
    // Already split (the same file added again, or saved since): nothing to do.
    if (await this.check(rec).catch(() => false)) return;
    const live: { id: string; joiners: Joiner[] } = { id: rec.id, joiners: [] };
    this.live = live;
    const settle = (stems: StemPcm[] | null) => {
      for (const j of live.joiners) j.done(stems ? stems.map((p) => ({ left: p.left.slice(), right: p.right.slice() })) : null);
      live.joiners = [];
      if (this.live === live) this.live = null;
    };
    let stems: StemPcm[];
    try {
      const buf = await decodeAudio(got.file, STEM_RATE);
      if (!this.go()) return settle(null);
      const left = new Float32Array(buf.getChannelData(0));
      const right = new Float32Array(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
      const job = splitInWorker(left, right, (stage, progress) => {
        const cur = this.store.get().current;
        if (cur?.id === rec.id) this.setCurrent({ ...cur, stage, progress });
        for (const j of live.joiners) j.progress(stage, progress);
      });
      this.job = job;
      const res = await job.done;
      stems = res.stems;
      if (modelFailed(this.store.get().message ?? '')) this.store.set({ message: null });
      this.store.set({ backend: res.backend, last: { seconds: res.seconds, duration: buf.length / STEM_RATE } });
    } catch (err) {
      settle(null);
      if (err instanceof Error && err.message === 'cancelled') return; // paused, or a deck went first: tried again later
      if (err instanceof Error && modelFailed(err.message)) {
        // Offline, or the model's host is down: not this track's fault. Try again in a minute.
        this.modelDown = true;
        this.store.set({ message: `${err.message} Trying again in a minute.` });
        return;
      }
      this.failed.add(this.failKey(rec));
      this.store.set({ message: `“${rec.title}” couldn’t be split: ${err instanceof Error ? err.message : 'unknown error'}` });
      return;
    } finally {
      this.job = null;
    }
    settle(stems);
    // A deck split it meanwhile (and kept it): nothing more to do.
    if (this.saved.get(rec.id)?.fingerprint === got.src.fingerprint) return;
    // Saved while the next track splits (encoding takes a few seconds). One save at a
    // time, so at most one finished track's stems wait in memory besides the one splitting.
    await this.writes;
    this.saving.add(rec.id);
    this.tally();
    void this.save(rec, got.src, stems)
      .catch((err) => {
        this.failed.add(this.failKey(rec));
        this.store.set({ message: `Couldn’t save the stems of “${rec.title}”: ${err instanceof Error ? err.message : 'write failed'}` });
      })
      .finally(() => {
        this.saving.delete(rec.id);
        this.tally();
      });
  }

  /** Writes a track's stems where they belong. One write at a time (each holds a track's stems in memory). */
  private save(rec: TrackRecord, src: Source, stems: StemPcm[]): Promise<void> {
    const next = this.writes.then(async () => {
      const to = await this.target(rec, src);
      if (!to) throw new Error('this browser has nowhere to keep them');
      const bytes = await writeSaved(to.dir, { ...src, path: to.path }, stems, STEM_RATE, NAMES);
      this.saved.set(rec.id, { ...src, bytes, where: to.where });
      this.tally();
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  /* ── For the decks (SavedStemsHook) ────────────────────────────────── */

  private rec(trackId: string) {
    const rec = this.session.crate.get().tracks.find((t) => t.id === trackId);
    return rec && this.keepable(rec) ? rec : null;
  }

  async has(trackId: string): Promise<boolean> {
    const rec = this.rec(trackId);
    if (!rec) return false;
    return this.check(rec).catch(() => false);
  }

  async load(trackId: string) {
    const rec = this.rec(trackId);
    if (!rec) return null;
    const got = await this.source(rec);
    if (!got) return null;
    const { src } = got;
    if (this.fromFolder(rec) && this.folder) {
      const found = await loadSaved(this.folder, src.path, src.fingerprint);
      if (found) return found;
    }
    const dir = await this.browserDir();
    return dir ? loadSaved(dir, src.fingerprint, src.fingerprint) : null;
  }

  join(trackId: string, progress: Joiner['progress']): Promise<StemPcm[] | null> | null {
    const live = this.live;
    if (!live || live.id !== trackId || !this.job) return null;
    return new Promise((done) => live.joiners.push({ done, progress }));
  }

  beforeSplit() {
    // The worker does one split at a time: let the deck's go first.
    this.job?.cancel();
  }

  wants(trackId: string): boolean {
    return this.enabled && !!this.rec(trackId);
  }

  keep(trackId: string, stems: StemPcm[]) {
    const rec = this.rec(trackId);
    if (!rec) return;
    void (async () => {
      const got = await this.source(rec);
      if (!got) return;
      try {
        await this.save(rec, got.src, stems);
      } catch {
        // Not saved: it'll be split again in the background.
      }
    })();
  }

  watch(trackId: string, fn: () => void): () => void {
    let set = this.watchers.get(trackId);
    if (!set) this.watchers.set(trackId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.watchers.delete(trackId);
    };
  }
}
