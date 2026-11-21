/**
 * Pre-splitting: while Platter is open, the tracks of the linked music
 * folder are split one at a time in the background and saved next to the
 * music ("Platter Stems", see saved.ts), so a deck's Split loads them at
 * once instead of splitting for 15–40 s.
 *
 * Manners:
 *  - only your own files from the linked folder (never Audius or SoundCloud;
 *    engine/stems' stemsPolicy has the last word);
 *  - never starts a track while a deck is playing or the library analysis is
 *    running; a deck's own Split always goes first (the background job steps
 *    aside and starts again later);
 *  - a file that's already split is skipped, and one that changed since (its
 *    fingerprint moved) is split again;
 *  - Pause holds it, across restarts too; writing needs the folder's
 *    readwrite permission, which the browser asks for on a click.
 */
import { decodeAudio } from '../analysis';
import { getValue, setValue } from '../library';
import type { DjSession } from '../session';
import { createStore, type Store } from '../store';
import type { TrackRecord } from '../types';
import { fingerprintBlob } from '../../library/fingerprint';
import { splitInWorker, stemsPolicy, STEM_RATE, type SavedStemsHook, type SplitJob } from './index';
import { access, hasSaved, loadSaved, writeSaved } from './saved';
import type { StemPcm } from './separate';
import { STEMS_DIR } from './stemfile';

const KV = 'stems.presplit';
/** The order separate.ts keeps them in. */
const NAMES = ['drums', 'bass', 'vocals'];

export type PreSplitPhase =
  /** Not switched on. */
  | 'off'
  /** Looking for what's already split. */
  | 'checking'
  | 'running'
  /** On, but holding off: a deck is playing or the analysis is running. */
  | 'waiting'
  | 'paused'
  /** On, but the browser needs to be asked again for the folder (a click). */
  | 'needs-permission'
  | 'done';

export interface PreSplitState {
  phase: PreSplitPhase;
  waitingFor: 'deck' | 'analysis' | null;
  /** Tracks with saved stems, of those that can have them. */
  done: number;
  total: number;
  /** The track being split now. */
  current: { title: string; progress: number; stage: 'download' | 'prepare' | 'separate' | 'save' } | null;
  /** Size of the saved stems found or written. */
  bytes: number;
  failed: number;
  /** One line: why it stopped, or what went wrong last. */
  message: string | null;
  /** A linked folder is there to split from. */
  hasFolder: boolean;
}

interface Source {
  path: string;
  fingerprint: string;
  size: number;
  modified: number | null;
}

function initial(): PreSplitState {
  return { phase: 'off', waitingFor: null, done: 0, total: 0, current: null, bytes: 0, failed: 0, message: null, hasFolder: false };
}

export class PreSplitter implements SavedStemsHook {
  readonly store: Store<PreSplitState> = createStore(initial());
  private enabled = false;
  private paused = false;
  private writable = false;
  private running = false;
  private disposed = false;
  private job: SplitJob | null = null;
  /** Track id → what's saved for it (by fingerprint). */
  private saved = new Map<string, { fingerprint: string; size: number; modified: number | null; bytes: number }>();
  /** Track id + fingerprint that failed this session: not tried again until reload. */
  private failed = new Set<string>();
  private wake: (() => void) | null = null;
  private unsubs: (() => void)[] = [];
  private writes: Promise<void> = Promise.resolve();
  private folderName: string | null = null;

  constructor(private readonly session: DjSession) {}

  private get folder(): FileSystemDirectoryHandle | null {
    return this.session.library.musicFolder;
  }

  async init() {
    this.disposed = false;
    const kv = await getValue<{ enabled: boolean; paused: boolean }>(KV);
    this.enabled = !!kv?.enabled;
    this.paused = !!kv?.paused;
    this.folderName = this.folder?.name ?? null;
    this.store.set({ hasFolder: !!this.folder });
    const poke = () => this.wake?.();
    this.unsubs.push(
      this.session.crate.subscribe(poke),
      this.session.library.store.subscribe(() => {
        const name = this.folder?.name ?? null;
        if (name !== this.folderName) {
          // Another folder: what's saved is looked up again.
          this.folderName = name;
          this.saved.clear();
          this.writable = false;
          this.store.set({ hasFolder: !!this.folder, done: 0, bytes: 0 });
        }
        poke();
      }),
      ...this.session.decks.map((d) => d.store.subscribe(poke)),
    );
    if (!this.enabled) return;
    if (this.paused) {
      this.store.set({ phase: 'paused' });
      void this.count();
      return;
    }
    const dir = this.folder;
    if (!dir) return this.store.set({ phase: 'off' });
    if ((await access(dir, 'readwrite', false)) !== 'granted') return this.store.set({ phase: 'needs-permission' });
    this.writable = true;
    void this.run();
  }

  dispose() {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.job?.cancel();
    this.wake?.();
  }

  /* ── Controls (each is a click, so the browser may ask for permission) ── */

  /** Switch pre-splitting on (or resume it). */
  async start() {
    const dir = this.folder;
    if (!dir) {
      this.store.set({ message: 'Link your music folder first: pre-splitting saves stems next to it.' });
      return;
    }
    if ((await access(dir, 'readwrite', true)) !== 'granted') {
      this.store.set({ phase: this.enabled ? 'needs-permission' : 'off', message: `Platter needs permission to save files in “${dir.name}” to keep stems there.` });
      return;
    }
    this.writable = true;
    this.enabled = true;
    this.paused = false;
    this.persist();
    this.store.set({ message: null });
    this.wake?.();
    void this.run();
  }

  pause() {
    this.paused = true;
    this.persist();
    this.job?.cancel();
    this.store.set({ phase: 'paused', waitingFor: null });
    this.wake?.();
  }

  /** Switch it off (saved stems stay where they are, and still load). */
  turnOff() {
    this.enabled = false;
    this.paused = false;
    this.persist();
    this.job?.cancel();
    this.store.set({ phase: 'off', waitingFor: null, current: null });
    this.wake?.();
  }

  private persist() {
    void setValue(KV, { enabled: this.enabled, paused: this.paused });
  }

  /* ── What can be split ─────────────────────────────────────────────── */

  private eligible(rec: TrackRecord): boolean {
    return !!rec.handle && !!rec.library?.path && !rec.demo && !rec.audius && !rec.soundcloud && rec.status !== 'error' && stemsPolicy(rec).allowed;
  }

  private tracks(): TrackRecord[] {
    if (!this.folder) return [];
    return this.session.crate.get().tracks.filter((t) => this.eligible(t));
  }

  /** The file behind a track now, with its fingerprint (reused while size and date hold). */
  private async source(rec: TrackRecord): Promise<{ file: File; src: Source } | null> {
    if (!rec.handle || !rec.library?.path) return null;
    let file: File;
    try {
      file = await rec.handle.getFile();
    } catch {
      return null; // moved, deleted, or no permission
    }
    const lib = rec.library;
    const modified = file.lastModified || null;
    const known = this.saved.get(rec.id);
    let fingerprint: string;
    if (known && known.size === file.size && known.modified === modified) fingerprint = known.fingerprint;
    else if (lib.fingerprint && lib.fileSize === file.size && lib.modified === modified) fingerprint = lib.fingerprint;
    else fingerprint = await fingerprintBlob(file);
    return { file, src: { path: lib.path!, fingerprint, size: file.size, modified } };
  }

  /** Is there a saved split of this track's current file? Fills `saved`. */
  private async check(rec: TrackRecord): Promise<boolean> {
    const dir = this.folder;
    if (!dir) return false;
    const got = await this.source(rec);
    if (!got) return false;
    const known = this.saved.get(rec.id);
    if (known?.fingerprint === got.src.fingerprint) return true;
    const found = await hasSaved(dir, got.src.path, got.src.fingerprint);
    if (found) this.saved.set(rec.id, { fingerprint: got.src.fingerprint, size: got.src.size, modified: got.src.modified, bytes: found.bytes });
    else this.saved.delete(rec.id);
    return !!found;
  }

  private tally() {
    const ids = new Set(this.tracks().map((t) => t.id));
    let done = 0;
    let bytes = 0;
    for (const [id, s] of this.saved) {
      if (!ids.has(id)) continue;
      done++;
      bytes += s.bytes;
    }
    this.store.set({ done, total: ids.size, bytes, failed: this.failed.size });
  }

  /** Counts what's already saved (for the paused display). */
  private async count() {
    const dir = this.folder;
    if (!dir || (await access(dir, 'read', false)) !== 'granted') return;
    for (const t of this.tracks()) await this.check(t);
    this.tally();
  }

  /* ── The loop ──────────────────────────────────────────────────────── */

  private holdReason(): 'deck' | 'analysis' | null {
    if (this.session.decks.some((d) => d.store.get().playing)) return 'deck';
    if (this.session.library.store.get().progress) return 'analysis';
    return null;
  }

  /** Until something changes (a deck stops, analysis ends, the crate moves), or a minute. */
  private sleep() {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, 60_000);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        // Let a burst of changes settle.
        setTimeout(done, 500);
      };
    });
  }

  private go() {
    return this.enabled && !this.paused && !this.disposed && !!this.folder;
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      this.store.set({ phase: 'checking', waitingFor: null });
      for (const t of this.tracks()) {
        if (!this.go()) break;
        await this.check(t);
      }
      this.tally();
      while (this.go()) {
        const todo = this.tracks().find((t) => !this.saved.has(t.id) && !this.failed.has(`${t.id}:${t.library?.fingerprint ?? ''}`));
        if (!todo) {
          this.tally();
          this.store.set({ phase: 'done', current: null, waitingFor: null });
          await this.sleep(); // new tracks may arrive
          if (this.go()) {
            // A rescan may have added or changed files: look again (cheap while size and date hold).
            for (const t of this.tracks()) await this.check(t);
            this.tally();
          }
          continue;
        }
        const hold = this.holdReason();
        if (hold) {
          this.store.set({ phase: 'waiting', waitingFor: hold, current: null });
          await this.sleep();
          continue;
        }
        this.store.set({ phase: 'running', waitingFor: null });
        await this.splitOne(todo);
        this.tally();
      }
    } finally {
      this.running = false;
      this.store.set({ current: null });
      if (this.enabled && this.paused) this.store.set({ phase: 'paused' });
    }
  }

  private async splitOne(rec: TrackRecord) {
    const failKey = () => `${rec.id}:${rec.library?.fingerprint ?? ''}`;
    this.store.set({ current: { title: rec.title, progress: 0, stage: 'prepare' } });
    const got = await this.source(rec);
    if (!got) {
      this.failed.add(failKey());
      this.store.set({ message: `Couldn’t read “${rec.title}”: skipped it.` });
      return;
    }
    let stems: StemPcm[];
    try {
      const buf = await decodeAudio(got.file, STEM_RATE);
      if (!this.go()) return;
      const left = new Float32Array(buf.getChannelData(0));
      const right = new Float32Array(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
      const job = splitInWorker(left, right, (stage, progress) => {
        const cur = this.store.get().current;
        if (cur) this.store.set({ current: { ...cur, stage, progress } });
      });
      this.job = job;
      stems = (await job.done).stems;
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') return; // paused, or a deck went first: tried again later
      this.failed.add(failKey());
      this.store.set({ message: `“${rec.title}” couldn’t be split: ${err instanceof Error ? err.message : 'unknown error'}` });
      return;
    } finally {
      this.job = null;
    }
    // A deck split it meanwhile (and kept it): nothing more to do.
    if (this.saved.get(rec.id)?.fingerprint === got.src.fingerprint) return;
    this.store.set({ current: { title: rec.title, progress: 1, stage: 'save' } });
    try {
      const bytes = await this.write(got.src, stems);
      this.saved.set(rec.id, { fingerprint: got.src.fingerprint, size: got.src.size, modified: got.src.modified, bytes });
    } catch (err) {
      this.failed.add(failKey());
      this.store.set({ message: `Couldn’t save the stems of “${rec.title}” in “${STEMS_DIR}”: ${err instanceof Error ? err.message : 'write failed'}` });
    }
  }

  /** One write at a time (each holds a track's stems in memory). */
  private write(src: Source, stems: StemPcm[]): Promise<number> {
    const dir = this.folder!;
    const next = this.writes.then(() => writeSaved(dir, src, stems, STEM_RATE, NAMES));
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /* ── For the decks (SavedStemsHook) ────────────────────────────────── */

  private rec(trackId: string) {
    const rec = this.session.crate.get().tracks.find((t) => t.id === trackId);
    return rec && this.folder && this.eligible(rec) ? rec : null;
  }

  async has(trackId: string): Promise<boolean> {
    const rec = this.rec(trackId);
    if (!rec || !this.folder || (await access(this.folder, 'read', false)) !== 'granted') return false;
    return this.check(rec).catch(() => false);
  }

  async load(trackId: string) {
    const rec = this.rec(trackId);
    const dir = this.folder;
    if (!rec || !dir) return null;
    const got = await this.source(rec);
    if (!got) return null;
    return loadSaved(dir, got.src.path, got.src.fingerprint);
  }

  beforeSplit() {
    // The worker does one split at a time: let the deck's go first.
    this.job?.cancel();
  }

  wants(trackId: string): boolean {
    return this.enabled && this.writable && !!this.rec(trackId);
  }

  keep(trackId: string, stems: StemPcm[]) {
    const rec = this.rec(trackId);
    if (!rec) return;
    void (async () => {
      const got = await this.source(rec);
      if (!got) return;
      try {
        const bytes = await this.write(got.src, stems);
        this.saved.set(rec.id, { fingerprint: got.src.fingerprint, size: got.src.size, modified: got.src.modified, bytes });
        this.tally();
      } catch {
        // Not saved: it'll be split again in the background.
      }
    })();
  }
}
