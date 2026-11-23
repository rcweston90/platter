import { createStore, type Store } from '../store';
import { HITS_VERSION, type BeatHit } from './analyse';

export type { BeatHit } from './analyse';
export { formatHz, midiOf, noteName } from './analyse';

export interface HitsState {
  /** The track these hits belong to (or are being read for). */
  trackId: string | null;
  status: 'idle' | 'reading' | 'ready' | 'error';
  hits: BeatHit[] | null;
}

/** The last few tracks' hits, by track id: loading a track back is instant. */
const cache = new Map<string, BeatHit[]>();
const CACHE_TRACKS = 12;

let worker: Worker | null = null;
let seq = 0;
const jobs = new Map<number, { resolve: (h: BeatHit[]) => void; reject: (e: Error) => void }>();

function run(mono: Float32Array, sampleRate: number): Promise<BeatHit[]> {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('no worker'));
  if (!worker) {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; hits?: BeatHit[]; error?: string }>) => {
      const job = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      if (e.data.hits) job?.resolve(e.data.hits);
      else job?.reject(new Error(e.data.error ?? 'failed'));
    };
    w.onerror = () => {
      for (const j of jobs.values()) j.reject(new Error('worker failed'));
      jobs.clear();
      worker?.terminate();
      worker = null;
    };
    worker = w;
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker!.postMessage({ id, mono, sampleRate }, [mono.buffer]);
  });
}

/**
 * One deck's beat pitch: every hit in the loaded track and how high or low it
 * sounds (see analyse.ts), read in a worker when the track's audio loads and
 * drawn by the pitch lane (ui/PitchLane).
 */
export class DeckHits {
  readonly store: Store<HitsState> = createStore<HitsState>({ trackId: null, status: 'idle', hits: null });
  private token = 0;

  /** Reads the hits of a track whose audio just loaded on the deck. */
  read(trackId: string, buffer: AudioBuffer) {
    const key = `${trackId}:${HITS_VERSION}:${buffer.length}`;
    const token = ++this.token;
    const kept = cache.get(key);
    if (kept) {
      cache.delete(key);
      cache.set(key, kept);
      this.store.set({ trackId, status: 'ready', hits: kept });
      return;
    }
    this.store.set({ trackId, status: 'reading', hits: null });
    // Mixed to mono here: half the data to copy, and the analysis is mono.
    const mono = new Float32Array(buffer.length);
    const g = 1 / buffer.numberOfChannels;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] * g;
    }
    run(mono, buffer.sampleRate).then(
      (hits) => {
        cache.set(key, hits);
        while (cache.size > CACHE_TRACKS) cache.delete(cache.keys().next().value!);
        if (token === this.token) this.store.set({ trackId, status: 'ready', hits });
      },
      () => {
        if (token === this.token) this.store.set({ trackId, status: 'error', hits: null });
      },
    );
  }

  clear() {
    this.token++;
    this.store.set({ trackId: null, status: 'idle', hits: null });
  }
}
