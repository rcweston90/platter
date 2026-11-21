/**
 * Sound match: Platter listens to your own tracks with an open audio model
 * (LAION's CLAP, in the browser — see worker.ts) and keeps a small "sound
 * print" of each, so "what plays next" can weigh how tracks actually sound
 * next to each other, not only their key, tempo and energy.
 *
 * Manners:
 *  - off until you switch it on (the model is a ~34 MB download, once);
 *  - only your own files, added or linked. Never SoundCloud (its API terms
 *    forbid feeding its audio to AI), never Audius or the demos;
 *  - one track at a time, the decks' tracks first; it steps aside while the
 *    library analysis runs, and slows down while a deck is playing;
 *  - prints are kept in this browser (IndexedDB), never in the library file,
 *    the repo or on a server. A print is three short vectors, not audio.
 */
import { decodeAudio } from '../../engine/analysis';
import { getValue, setValue } from '../../engine/library';
import type { DjSession } from '../../engine/session';
import { createStore, type Store } from '../../engine/store';
import type { TrackRecord } from '../../engine/types';
import { cutWindows, pickWindows, PRINT_VERSION, type SoundPrint } from './embed';
import type { FromWorker, ToWorker } from './worker';

const KV = 'sound.settings';
const KV_PRINT = (id: string) => `sound.print.${id}`;
const RATE = 48000;
/** Pause between tracks while a deck plays, so the set always comes first. */
const PLAYING_GAP_MS = 4000;

export type SoundPhase = 'off' | 'starting' | 'download' | 'running' | 'waiting' | 'done' | 'error';

export interface SoundState {
  phase: SoundPhase;
  /** Tracks with a print, of those that can have one. */
  done: number;
  total: number;
  /** Model download, 0…1, while phase is 'download'. */
  download: number;
  /** The track being listened to now. */
  current: string | null;
  failed: number;
  message: string | null;
  /** Bumped whenever a print is added, so views re-rank. */
  revision: number;
}

function initial(): SoundState {
  return { phase: 'off', done: 0, total: 0, download: 0, current: null, failed: 0, message: null, revision: 0 };
}

/** Can this track be listened to? Your own files only. */
export function soundEligible(rec: TrackRecord): boolean {
  return !rec.demo && !rec.audius && !rec.soundcloud && rec.status !== 'error' && !!(rec.blob || rec.handle);
}

export class SoundMatch {
  readonly store: Store<SoundState> = createStore(initial());
  /** Tracks played this session (a deck ran them), so "up next" can skip them. */
  readonly played: Store<{ ids: ReadonlySet<string> }> = createStore({ ids: new Set<string>() as ReadonlySet<string> });
  private prints = new Map<string, SoundPrint>();
  private failed = new Set<string>();
  private loaded = new Set<string>();
  private enabled = false;
  private running = false;
  /** Failures in a row: three means the model, not the tracks. */
  private misses = 0;
  private disposed = false;
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (p: SoundPrint) => void; reject: (e: Error) => void }>();
  private wake: (() => void) | null = null;
  private unsubs: (() => void)[] = [];

  constructor(private readonly session: DjSession) {}

  async init() {
    this.disposed = false;
    const poke = () => this.wake?.();
    this.unsubs.push(
      this.session.crate.subscribe(poke),
      this.session.library.store.subscribe(poke),
      ...this.session.decks.map((d) =>
        d.store.subscribe(() => {
          const st = d.store.get();
          if (st.playing && st.track && !this.played.get().ids.has(st.track.id)) {
            this.played.set({ ids: new Set([...this.played.get().ids, st.track.id]) });
          }
          poke();
        }),
      ),
    );
    const kv = await getValue<{ enabled: boolean }>(KV);
    this.enabled = !!kv?.enabled;
    await this.loadPrints();
    if (this.enabled) void this.run();
    else this.tally();
  }

  dispose() {
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('stopped'));
    this.waiting.clear();
    this.wake?.();
  }

  /** The print for a track, if it has been listened to. */
  printOf(id: string): SoundPrint | null {
    return this.prints.get(id) ?? null;
  }

  get on() {
    return this.enabled;
  }

  /** Switch it on: downloads the model (once) and works through your tracks. */
  start() {
    this.enabled = true;
    this.misses = 0;
    this.failed.clear();
    void setValue(KV, { enabled: true });
    this.store.set({ message: null });
    this.wake?.();
    void this.run();
  }

  /** Switch it off. Prints already made stay, and keep counting. */
  stop() {
    this.enabled = false;
    void setValue(KV, { enabled: false });
    this.store.set({ phase: 'off', current: null });
    this.wake?.();
  }

  /** Forget a track's print (e.g. the file changed). */
  forget(id: string) {
    this.prints.delete(id);
    this.loaded.delete(id);
    void setValue(KV_PRINT(id), null);
    this.bump();
  }

  /* ── Prints in IndexedDB ────────────────────────────────────────────── */

  private async loadPrints() {
    const ids = this.session.crate
      .get()
      .tracks.filter(soundEligible)
      .map((t) => t.id)
      .filter((id) => !this.loaded.has(id));
    for (let i = 0; i < ids.length; i += 64) {
      const batch = ids.slice(i, i + 64);
      const got = await Promise.all(batch.map((id) => getValue<SoundPrint>(KV_PRINT(id)).catch(() => null)));
      batch.forEach((id, k) => {
        this.loaded.add(id);
        const p = got[k];
        if (p && p.version === PRINT_VERSION && p.intro && p.body && p.outro) this.prints.set(id, p);
      });
    }
    this.bump();
  }

  private bump() {
    this.tally();
    this.store.set({ revision: this.store.get().revision + 1 });
  }

  private tally() {
    const tracks = this.session.crate.get().tracks.filter(soundEligible);
    this.store.set({ total: tracks.length, done: tracks.filter((t) => this.prints.has(t.id)).length, failed: this.failed.size });
  }

  /* ── The loop ───────────────────────────────────────────────────────── */

  /** Next track to listen to: what's on the decks first, then the crate in order. */
  private next(): TrackRecord | null {
    const tracks = this.session.crate.get().tracks;
    const todo = (t: TrackRecord) => soundEligible(t) && t.status === 'ready' && !this.prints.has(t.id) && !this.failed.has(t.id);
    for (const d of this.session.decks) {
      const id = d.store.get().track?.id;
      const rec = id ? tracks.find((t) => t.id === id) : null;
      if (rec && todo(rec)) return rec;
    }
    return tracks.find(todo) ?? null;
  }

  private sleep(ms = 60_000) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    }).finally(() => (this.wake = null));
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.enabled && !this.disposed) {
        await this.loadPrints();
        this.tally();
        if (this.session.library.store.get().progress) {
          this.store.set({ phase: 'waiting', current: null });
          await this.sleep();
          continue;
        }
        const rec = this.next();
        if (!rec) {
          this.store.set({ phase: 'done', current: null });
          await this.sleep();
          continue;
        }
        if (this.store.get().phase !== 'download') this.store.set({ phase: 'running' });
        this.store.set({ current: rec.title });
        try {
          const print = await this.listen(rec);
          if (!this.enabled || this.disposed) break;
          this.prints.set(rec.id, print);
          void setValue(KV_PRINT(rec.id), print);
          this.misses = 0;
          this.store.set({ phase: 'running', message: null });
          this.bump();
        } catch (err) {
          if (this.disposed) break;
          const message = err instanceof Error ? err.message : String(err);
          this.failed.add(rec.id);
          this.tally();
          if (/model/i.test(message) || ++this.misses >= 3) {
            // The model itself isn't working: stop, rather than fail every track.
            this.store.set({ phase: 'error', current: null, message: `Sound match stopped: ${message}` });
            this.enabled = false;
            void setValue(KV, { enabled: false });
            break;
          }
          continue;
        }
        if (this.session.decks.some((d) => d.store.get().playing)) await this.sleep(PLAYING_GAP_MS);
      }
    } finally {
      this.running = false;
      if (!this.enabled && this.store.get().phase !== 'error') this.store.set({ phase: 'off', current: null });
    }
  }

  /** Reads and decodes a track, cuts its three windows, and has the worker listen. */
  private async listen(rec: TrackRecord): Promise<SoundPrint> {
    let blob: Blob | null = rec.blob;
    if (!blob && rec.handle) blob = await rec.handle.getFile(); // throws without permission: skipped
    if (!blob) throw new Error('No access to the file');
    const buf = await decodeAudio(blob, RATE);
    const n = buf.length;
    const mono = new Float32Array(n);
    const chans = Math.min(2, buf.numberOfChannels);
    for (let c = 0; c < chans; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += d[i] / chans;
    }
    const windows = cutWindows(mono, RATE, pickWindows(buf.duration, rec.library?.analysis?.firstDownbeat ?? rec.gridOffset ?? 0));
    return this.embed(windows);
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'progress') {
        this.store.set(m.phase === 'download' ? { phase: 'download', download: m.progress } : { phase: 'running' });
        return;
      }
      const job = this.waiting.get(m.id);
      if (!job) return;
      this.waiting.delete(m.id);
      if (m.type === 'done') job.resolve(m.print);
      else job.reject(new Error(m.message));
    };
    w.onerror = () => {
      for (const job of this.waiting.values()) job.reject(new Error('The sound model stopped.'));
      this.waiting.clear();
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  private embed(windows: Float32Array[]): Promise<SoundPrint> {
    const w = this.getWorker();
    const id = this.nextId++;
    return new Promise<SoundPrint>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const msg: ToWorker = { type: 'embed', id, windows };
      w.postMessage(msg, windows.map((x) => x.buffer as ArrayBuffer));
    });
  }
}
