import { createStore, type Store } from '../store';
import { HITS_VERSION, type BeatHit } from './analyse';
import { STEM_HITS_VERSION, type StemHits } from './stems';
import type { ToHitsWorker } from './worker';

export type { BeatHit } from './analyse';
export type { DrumHit, DrumKind, PitchTrack, StemHits, StemNote, StemPart } from './stems';
export { DRUM_KINDS } from './stems';
export { formatHz, midiOf, noteName } from './analyse';

export interface HitsState {
  /** The track these hits belong to (or are being read for). */
  trackId: string | null;
  status: 'idle' | 'reading' | 'ready' | 'error';
  /** Every hit in the whole mix. */
  hits: BeatHit[] | null;
  /** Each stem's hits and notes, once the track's stems are in and read.
   *  'none': this track won't have stems; 'waiting': they're coming. */
  stemStatus: 'none' | 'waiting' | 'reading' | 'ready' | 'error';
  stems: StemHits | null;
}

/** The last few tracks' hits, by track id: loading a track back is instant. */
const cache = new Map<string, BeatHit[]>();
const stemCache = new Map<string, StemHits>();
const CACHE_TRACKS = 12;

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_TRACKS) map.delete(map.keys().next().value!);
}

let worker: Worker | null = null;
let seq = 0;
const jobs = new Map<number, { resolve: (r: { hits?: BeatHit[]; stems?: StemHits }) => void; reject: (e: Error) => void }>();

function post(m: ToHitsWorker, transfer: Transferable[] = []): Promise<{ hits?: BeatHit[]; stems?: StemHits }> | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; hits?: BeatHit[]; stems?: StemHits; error?: string }>) => {
      const job = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      if (e.data.error) job?.reject(new Error(e.data.error));
      else job?.resolve(e.data);
    };
    w.onerror = () => {
      for (const j of jobs.values()) j.reject(new Error('worker failed'));
      jobs.clear();
      worker?.terminate();
      worker = null;
    };
    worker = w;
  }
  const w = worker;
  return new Promise((resolve, reject) => {
    jobs.set(m.id, { resolve, reject });
    w.postMessage(m, transfer);
  });
}

/** Stereo 16-bit stems to mono 16-bit copies (the deck is about to take the originals). */
function monoOf(stems: { left: Int16Array; right: Int16Array }[]) {
  return stems.map(({ left, right }) => {
    const m = new Int16Array(left.length);
    for (let i = 0; i < left.length; i++) m[i] = (left[i] + right[i]) >> 1;
    return m;
  });
}

/**
 * One deck's beat pitch: every hit in the loaded track and how high or low it
 * sounds (see analyse.ts), read in a worker when the track's audio loads; and
 * once its stems are in, what each stem plays (stems.ts). Drawn by the stem
 * lanes (ui/StemLanes) and, until the stems are in, the mix lane (ui/PitchLane).
 */
export class DeckHits {
  readonly store: Store<HitsState> = createStore<HitsState>({ trackId: null, status: 'idle', hits: null, stemStatus: 'none', stems: null });
  private token = 0;
  /** Stems that came before the track's audio did. */
  private pending: { trackId: string; mono: Int16Array[]; rate: number; key: string } | null = null;

  /**
   * `mixOf`: the track's whole audio, mono, decoded afresh when its stems
   * come in (for "other": the track less the stems), or null when it can't
   * be read again quietly. Nothing is held between the load and the stems.
   */
  constructor(
    readonly deck = 0,
    private readonly mixOf: (trackId: string) => Promise<{ mono: Float32Array; rate: number } | null> = async () => null,
  ) {}

  /**
   * Reads the hits of a track whose audio just loaded on the deck.
   * `expectStems`: its stems will follow (the stem lanes say they're coming).
   */
  read(trackId: string, buffer: AudioBuffer, expectStems = false) {
    const key = `${trackId}:${HITS_VERSION}:${buffer.length}`;
    const token = ++this.token;
    const kept = cache.get(key);
    const stemHits = this.cachedStems(trackId);
    const pending = this.pending?.trackId === trackId ? this.pending : null;
    if (!pending) this.pending = null;
    const stemStatus: HitsState['stemStatus'] = stemHits ? 'ready' : expectStems || pending ? 'waiting' : 'none';
    this.store.set({ trackId, status: kept ? 'ready' : 'reading', hits: kept ?? null, stemStatus, stems: stemHits });
    if (kept) remember(cache, key, kept);
    else {
      // Mixed to mono here: half the data to copy, and the analysis is mono.
      const mono = new Float32Array(buffer.length);
      const g = 1 / buffer.numberOfChannels;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const ch = buffer.getChannelData(c);
        for (let i = 0; i < ch.length; i++) mono[i] += ch[i] * g;
      }
      const job = post({ type: 'mix', id: ++seq, mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
      if (!job) this.store.set({ status: 'error' });
      job?.then(
        (r) => {
          if (!r.hits) return;
          remember(cache, key, r.hits);
          if (token === this.token) this.store.set({ trackId, status: 'ready', hits: r.hits });
        },
        () => {
          if (token === this.token) this.store.set({ trackId, status: 'error', hits: null });
        },
      );
    }
    if (pending) {
      this.pending = null;
      void this.readStems(pending.trackId, pending.mono, pending.rate, pending.key);
    }
  }

  /**
   * The track's stems are in (drums, bass, vocals, 16-bit, at `rate`). Call
   * before the deck takes them: they are copied, to mono, here.
   */
  stemsIn(trackId: string, stems: { left: Int16Array; right: Int16Array }[], rate: number) {
    if (!stems.length) return;
    const key = `${trackId}:${STEM_HITS_VERSION}:${stems[0].left.length}`;
    const kept = stemCache.get(key);
    if (kept) {
      remember(stemCache, key, kept);
      if (this.store.get().trackId === trackId) this.store.set({ stemStatus: 'ready', stems: kept });
      else this.pending = null;
      return;
    }
    const mono = monoOf(stems);
    if (this.store.get().trackId !== trackId) {
      // The deck shows the track but hasn't its audio yet: read once it has.
      this.pending = { trackId, mono, rate, key };
      return;
    }
    void this.readStems(trackId, mono, rate, key);
  }

  private async readStems(trackId: string, mono: Int16Array[], rate: number, key: string) {
    const token = this.token;
    const live = () => token === this.token && this.store.get().trackId === trackId;
    this.store.set({ stemStatus: 'reading', stems: null });
    const mix = await this.mixOf(trackId).catch(() => null);
    if (!live()) return;
    const transfer: Transferable[] = mono.map((m) => m.buffer);
    if (mix) transfer.push(mix.mono.buffer);
    const job = post({ type: 'stems', id: ++seq, stems: mono, stemRate: rate, mix: mix?.mono ?? null, mixRate: mix?.rate ?? rate }, transfer);
    if (!job) {
      this.store.set({ stemStatus: 'error' });
      return;
    }
    job.then(
      (r) => {
        if (!r.stems) return;
        remember(stemCache, key, r.stems);
        if (live()) this.store.set({ stemStatus: 'ready', stems: r.stems });
      },
      () => {
        if (live()) this.store.set({ stemStatus: 'error' });
      },
    );
  }

  private cachedStems(trackId: string) {
    for (const [k, v] of stemCache) if (k.startsWith(`${trackId}:${STEM_HITS_VERSION}:`)) return v;
    return null;
  }

  clear() {
    this.token++;
    this.pending = null;
    this.store.set({ trackId: null, status: 'idle', hits: null, stemStatus: 'none', stems: null });
  }
}
