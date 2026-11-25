/**
 * Stems: each deck can mute or solo a track's vocals, drums, bass and the
 * rest, split in the browser by HTDemucs (see separate.ts, worker.ts).
 *
 * What may be split is decided by where the track came from, not by taste:
 *   · your own files (and the built-in demos): yes;
 *   · SoundCloud: never — its API terms forbid using any track it serves "as
 *     input to any artificial intelligence technology", naming AI audio
 *     source separation, whatever the uploader's permissions;
 *   · Audius: only tracks whose Creative Commons license allows
 *     adaptations (CC BY, BY-SA, BY-NC, BY-NC-SA). The default "All rights
 *     reserved" and the No-Derivatives licenses stay whole.
 *
 * Stems live in memory with the deck, for as long as that track is on it.
 * Your own tracks are also split in the background as they're added and the
 * stems kept, in the browser or next to the music (presplit.ts, saved.ts),
 * so Split loads them at once. Nothing is uploaded, and nothing from Audius
 * or SoundCloud is saved.
 */
import type { Deck } from '../deck';
import { createStore, type Store } from '../store';
import type { TrackRecord } from '../types';
import type { StemPcm } from './separate';
import type { Backend, FromWorker, ToWorker } from './worker';

export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const;
export type StemName = (typeof STEMS)[number];
export const STEM_LABELS: Record<StemName, string> = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other' };
export const STEM_RATE = 44100;

/** Can this track be split? `reason` says why not, in a sentence. */
export function stemsPolicy(rec: Pick<TrackRecord, 'soundcloud' | 'audius' | 'license'>): { allowed: boolean; reason: string | null } {
  if (rec.soundcloud) {
    return { allowed: false, reason: 'SoundCloud’s terms don’t allow AI stem separation on its tracks.' };
  }
  if (rec.audius) {
    const lic = rec.license ?? '';
    if (!lic) return { allowed: false, reason: 'Add this track from Audius again so Platter can check its license.' };
    if (!/\bCC BY\b/i.test(lic) || /\bND\b|no ?deriv/i.test(lic)) {
      return { allowed: false, reason: `This track is “${lic}” on Audius, which doesn’t allow remixing.` };
    }
  }
  return { allowed: true, reason: null };
}

export type StemsStatus = 'none' | 'blocked' | 'idle' | 'download' | 'prepare' | 'separate' | 'ready' | 'error';

export interface StemsState {
  status: StemsStatus;
  /** Why stems are blocked, or what went wrong. */
  message: string | null;
  /** 0–1 within the current phase. */
  progress: number;
  backend: Backend | null;
  /** How long the split took, once ready. */
  seconds: number | null;
  muted: Record<StemName, boolean>;
  solo: StemName | null;
  /** Stems for this track are saved on disk: Split loads them instead of splitting. */
  saved: boolean;
  /** Stems are on their way but can't start yet: why, in a few words (no Split to press). */
  waiting: string | null;
  /** Stopped by hand: only then does the deck offer Split. */
  stopped: boolean;
}

/** Saved stems on disk (presplit.ts), as a deck sees them. */
export interface SavedStemsHook {
  has(trackId: string): Promise<boolean>;
  /** The saved stems, decoded, or null. */
  load(trackId: string): Promise<{ stems: StemPcm[]; rate: number } | null>;
  /** The background is splitting this track right now: wait for it (a copy
   *  of its stems; null if it stopped). Null when it isn't. */
  join?(trackId: string, progress: (phase: 'download' | 'prepare' | 'separate', p: number) => void): Promise<StemPcm[] | null> | null;
  /** Calls back once this track's stems are saved. Returns an unsubscribe. */
  watch?(trackId: string, fn: () => void): () => void;
  /** A deck is about to split live: background splitting steps aside. */
  beforeSplit(): void;
  /** Would a live split of this track be worth saving? */
  wants(trackId: string): boolean;
  /** Keep a live split (the stems are a copy the hook may keep). */
  keep(trackId: string, stems: StemPcm[]): void;
}

const unmuted = (): Record<StemName, boolean> => ({ vocals: false, drums: false, bass: false, other: false });

function initial(): StemsState {
  return { status: 'none', message: null, progress: 0, backend: null, seconds: null, muted: unmuted(), solo: null, saved: false, waiting: null, stopped: false };
}

/* ── The worker, shared by both decks ──────────────────────────────────── */

type Listener = (m: FromWorker) => void;
let worker: Worker | null = null;
const listeners = new Map<number, Listener>();
let nextId = 1;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => listeners.get(e.data.id)?.(e.data);
    worker.onerror = (e) => {
      for (const [id, l] of listeners) l({ type: 'error', id, message: e.message || 'The stems worker stopped.' });
      listeners.clear();
      worker = null;
    };
  }
  return worker;
}

function send(m: ToWorker, transfer: Transferable[] = []) {
  getWorker().postMessage(m, transfer);
}

/* ── One deck's stems ──────────────────────────────────────────────────── */

export class DeckStems {
  readonly store: Store<StemsState> = createStore(initial());
  private trackId: string | null = null;
  private job: number | null = null;
  private unwatch: (() => void) | null = null;
  /** Waiting on the background's split of this track (a number, so a cancel can drop it). */
  private joining: number | null = null;
  private joins = 0;
  /** Stems that came in while the deck only showed the track (no audio yet). */
  private held: { stems: StemPcm[]; rate: number } | null = null;
  /** The track is on the deck as a picture only (e.g. after a reload). */
  private armed = false;
  /** Stems are in for a track, about to move to the deck (which takes the
   *  buffers): a last look, for the stem lanes' analysis (engine/hits). */
  onStems: ((trackId: string, stems: StemPcm[], rate: number) => void) | null = null;

  /**
   * `decode` gives the track's audio at 44.1 kHz stereo, decoded afresh
   * (so nothing extra is held while stems aren't wanted).
   */
  constructor(
    private readonly deck: Deck,
    private readonly decode: (trackId: string) => Promise<AudioBuffer>,
    private readonly saved: SavedStemsHook | null = null,
    /** Stems come by themselves when a track loads (auto-split is on). */
    private readonly auto: () => boolean = () => false,
  ) {
    deck.store.subscribe(() => {
      const id = deck.store.get().track?.id ?? null;
      if (id !== this.trackId) this.reset(null);
    });
  }

  static supported() {
    return typeof Worker !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
  }

  /**
   * The deck shows this track but has no audio yet (after a reload the last
   * tracks come back like this). Its stems get ready now, so they're there
   * the moment it plays: saved ones load, else it's split if `fresh`.
   * Otherwise `waiting` says what they wait for (shown in place of Split);
   * call again once that's sorted.
   */
  trackArmed(rec: TrackRecord, fresh: boolean, waiting: string | null = null) {
    if (this.deck.hasAudio || this.deck.store.get().track?.id !== rec.id) return;
    this.reset(rec.id);
    this.armed = true;
    this.setUp(rec);
    if (!stemsPolicy(rec).allowed || !DeckStems.supported() || !this.auto()) return;
    void (async () => {
      if (!fresh && !(await this.saved?.has(rec.id).catch(() => false))) {
        if (this.trackId === rec.id && this.store.get().status === 'idle') this.store.set({ waiting: waiting ?? 'Stems come as it plays' });
        return;
      }
      if (this.trackId === rec.id) void this.split();
    })();
  }

  /** The deck now holds this track's audio (stems start off). */
  trackLoaded(rec: TrackRecord) {
    if (this.armed && this.trackId === rec.id) {
      // Got ready while armed: hand over what's in, or let a split under way finish.
      this.armed = false;
      const held = this.held;
      this.held = null;
      if (held) {
        this.deck.setStems(held.stems, held.rate);
        this.applyGains();
        return;
      }
      const s = this.store.get().status;
      if (s !== 'idle' && s !== 'error' && s !== 'blocked' && s !== 'none') return;
    }
    // Loading drops the worklet's stems, even for the same track again.
    this.reset(rec.id);
    this.setUp(rec);
    // Nobody should have to ask: saved stems load, a split under way is
    // joined, else this deck's track is split now, ahead of everything else.
    // The deck plays the whole track meanwhile; with every part up the stems
    // add back to exactly that, so they swap in without a sound.
    if (stemsPolicy(rec).allowed && DeckStems.supported() && this.auto()) void this.split();
  }

  private setUp(rec: TrackRecord) {
    const { allowed, reason } = stemsPolicy(rec);
    if (!DeckStems.supported()) this.store.set({ status: 'blocked', message: 'This browser can’t split stems.' });
    else this.store.set({ status: allowed ? 'idle' : 'blocked', message: reason });
    if (allowed && this.saved) {
      const id = rec.id;
      const mark = () => {
        if (this.trackId !== id) return;
        this.store.set({ saved: true });
        this.unwatch?.();
        this.unwatch = null;
        // Waiting on the deck (e.g. after a reload): the saved ones come in now.
        const st = this.store.get();
        if (this.armed && st.status === 'idle' && !st.stopped && this.auto()) void this.split();
      };
      void this.saved.has(id).then((has) => has && mark());
      // Split in the background while it sits here: Split becomes instant.
      this.unwatch = this.saved.watch?.(id, mark) ?? null;
    }
  }

  /** Stems in: onto the deck, or held until its audio arrives. */
  private attach(stems: StemPcm[], rate: number) {
    if (this.trackId) this.onStems?.(this.trackId, stems, rate);
    if (this.deck.hasAudio) this.deck.setStems(stems, rate);
    else this.held = { stems, rate };
  }

  /** Will this track's stems arrive by themselves once it loads? */
  expects(rec: TrackRecord) {
    return stemsPolicy(rec).allowed && DeckStems.supported() && this.auto();
  }

  /** Stems arrive by themselves on this deck (no Split to press). */
  get automatic() {
    return this.auto();
  }

  private reset(trackId: string | null) {
    this.joining = null;
    this.held = null;
    this.armed = false;
    this.unwatch?.();
    this.unwatch = null;
    if (this.job !== null) {
      send({ type: 'cancel', id: this.job });
      listeners.delete(this.job);
      this.job = null;
    }
    this.trackId = trackId;
    this.store.set(initial());
  }

  /** Split the loaded track. Downloads the model on first use (~170 MB). */
  async split() {
    const s = this.store.get();
    const trackId = this.trackId;
    if (!trackId || (!this.deck.hasAudio && !this.armed) || (s.status !== 'idle' && s.status !== 'error')) return;
    this.store.set({ status: 'prepare', message: null, progress: 0, waiting: null, stopped: false });
    if (this.saved) {
      const found = await this.saved.load(trackId).catch(() => null);
      if (this.trackId !== trackId) return;
      if (found) {
        this.attach(found.stems, found.rate);
        this.store.set({ status: 'ready', progress: 1, backend: null, seconds: null, message: null });
        this.applyGains();
        return;
      }
      this.store.set({ saved: false });
      // Being split in the background right now: wait for that, not a second split.
      const joined = this.saved.join?.(trackId, (phase, progress) => {
        if (this.trackId === trackId) this.store.set({ status: phase, progress });
      });
      if (joined) {
        const token = (this.joining = ++this.joins);
        const stems = await joined;
        if (this.trackId !== trackId || this.joining !== token) return;
        this.joining = null;
        if (stems) {
          this.attach(stems, STEM_RATE);
          this.store.set({ status: 'ready', progress: 1, seconds: null, message: 'Split in the background, as the track came in.' });
          this.applyGains();
          return;
        }
        this.store.set({ status: 'prepare', progress: 0 });
      }
    }
    this.saved?.beforeSplit();
    let buf: AudioBuffer;
    try {
      buf = await this.decode(trackId);
    } catch {
      if (this.trackId === trackId) this.store.set({ status: 'error', message: 'The track couldn’t be read again to split it.' });
      return;
    }
    if (this.trackId !== trackId) return;
    const left = new Float32Array(buf.getChannelData(0));
    const right = new Float32Array(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
    const id = nextId++;
    this.job = id;
    listeners.set(id, (m) => this.onMessage(trackId, m));
    send({ type: 'separate', id, left, right }, [left.buffer, right.buffer]);
  }

  cancel() {
    if (this.joining !== null) {
      this.joining = null;
      this.store.set({ status: 'idle', message: null, progress: 0, stopped: true });
      return;
    }
    if (this.job === null) return;
    const id = this.trackId;
    this.reset(id);
    this.store.set({ status: 'idle', message: null, stopped: true });
  }

  private onMessage(trackId: string, m: FromWorker) {
    if (m.id !== this.job || trackId !== this.trackId) return;
    switch (m.type) {
      case 'progress':
        this.store.set({ status: m.phase, progress: m.progress, backend: m.backend ?? this.store.get().backend });
        break;
      case 'done':
        listeners.delete(m.id);
        this.job = null;
        if (this.saved?.wants(trackId)) {
          // The deck takes the buffers; the copy goes to disk.
          this.saved.keep(trackId, m.stems.map((p) => ({ left: p.left.slice(), right: p.right.slice() })));
        }
        this.attach(m.stems, STEM_RATE);
        this.store.set({ status: 'ready', progress: 1, backend: m.backend, seconds: m.seconds });
        this.applyGains();
        break;
      case 'cancelled':
        listeners.delete(m.id);
        this.job = null;
        this.store.set({ status: 'idle', progress: 0 });
        break;
      case 'error':
        listeners.delete(m.id);
        this.job = null;
        this.store.set({ status: 'error', message: m.message, progress: 0 });
        break;
    }
  }

  /** Click: mute or unmute a part. With a part soloed, a click moves the solo. */
  toggle(stem: StemName) {
    const s = this.store.get();
    if (s.solo) this.store.set({ solo: s.solo === stem ? null : stem });
    else this.store.set({ muted: { ...s.muted, [stem]: !s.muted[stem] } });
    this.applyGains();
  }

  /** Hear only this part (again to hear everything). */
  soloStem(stem: StemName) {
    const s = this.store.get();
    this.store.set({ solo: s.solo === stem ? null : stem });
    this.applyGains();
  }

  /** Everything back on. */
  resetMix() {
    this.store.set({ muted: unmuted(), solo: null });
    this.applyGains();
  }

  /** Each part's heard peak (0–1) since the last call, by name. Muted parts
   *  and a stopped deck read 0. */
  levels(): Record<StemName, number> {
    const [drums, bass, vocals, other] = this.deck.takeStemLevels();
    return { vocals, drums, bass, other };
  }

  heard(stem: StemName) {
    const { muted, solo } = this.store.get();
    return solo ? solo === stem : !muted[stem];
  }

  private applyGains() {
    if (this.store.get().status !== 'ready' || !this.deck.hasAudio) return;
    const g = (n: StemName) => (this.heard(n) ? 1 : 0);
    // The worklet's order: drums, bass, vocals, other (separate.ts KEPT, then the rest).
    this.deck.setStemGains([g('drums'), g('bass'), g('vocals'), g('other')]);
  }
}

/* ── Splits outside a deck (pre-splitting) ─────────────────────────────── */

export interface SplitJob {
  done: Promise<{ stems: StemPcm[]; seconds: number; backend: Backend }>;
  cancel(): void;
}

/** Split 44.1 kHz stereo in the shared worker (queued behind any deck's split). Rejects with 'cancelled' if cancelled. */
export function splitInWorker(left: Float32Array, right: Float32Array, onProgress: (phase: 'download' | 'prepare' | 'separate', progress: number) => void): SplitJob {
  const id = nextId++;
  const done = new Promise<{ stems: StemPcm[]; seconds: number; backend: Backend }>((resolve, reject) => {
    listeners.set(id, (m) => {
      if (m.type === 'progress') return onProgress(m.phase, m.progress);
      listeners.delete(id);
      if (m.type === 'done') resolve({ stems: m.stems, seconds: m.seconds, backend: m.backend });
      else if (m.type === 'cancelled') reject(new Error('cancelled'));
      else reject(new Error(m.message));
    });
  });
  send({ type: 'separate', id, left, right }, [left.buffer, right.buffer]);
  return { done, cancel: () => send({ type: 'cancel', id }) };
}
