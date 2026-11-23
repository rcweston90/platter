/**
 * Decoding ahead: the slow part of loading a deck is decoding the file (half
 * a second to a second for a five-minute FLAC or MP3). A track you're about
 * to load is usually the one under the pointer, the one the keyboard is on,
 * or the next in Up next, so that one is decoded in the background, at the
 * engine's rate, and a load takes it ready-made.
 *
 * A decoded track is big (a five-minute track at 48 kHz is about 115 MB), so
 * only one or two are kept, the newest wins, and phones and small machines
 * keep none. Only tracks that can be read without asking: your own files
 * (and linked ones the browser already allows), never a stream.
 */

type Decode = (trackId: string, rate: number) => Promise<AudioBuffer | null>;

interface Entry {
  rate: number;
  buf: Promise<AudioBuffer | null>;
  done: boolean;
}

/** How many decoded tracks to keep: two on a roomy desktop, one on a
 *  smaller one, none on a phone or under 4 GB. */
export function preloadSlots(): number {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  if (!nav) return 0;
  const mem = nav.deviceMemory ?? 8;
  const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
  if (phone || mem < 4) return 0;
  return mem >= 8 ? 2 : 1;
}

export class Preloader {
  private cache = new Map<string, Entry>();
  private running = 0;
  private queued: string | null = null;
  private held = false;

  constructor(
    private readonly decode: Decode,
    /** The engine's sample rate, or null when it isn't known yet. */
    private readonly rate: () => number | null,
    private readonly slots = preloadSlots(),
  ) {}

  /** Decode this track ahead (if there's room and nothing else is decoding). */
  warm(trackId: string) {
    if (!this.slots) return;
    const rate = this.rate();
    if (!rate) return;
    const have = this.cache.get(trackId);
    if (have && have.rate === rate) {
      // Most recently wanted: keep it last in line for eviction.
      this.cache.delete(trackId);
      this.cache.set(trackId, have);
      return;
    }
    if (this.running || this.held) {
      this.queued = trackId;
      return;
    }
    this.start(trackId, rate);
  }

  private start(trackId: string, rate: number) {
    this.running++;
    const entry: Entry = { rate, done: false, buf: Promise.resolve(null) };
    entry.buf = this.decode(trackId, rate)
      .catch(() => null)
      .then((b) => {
        entry.done = true;
        if (!b) this.cache.delete(trackId);
        return b;
      })
      .finally(() => {
        this.running--;
        this.next();
      });
    this.cache.delete(trackId);
    this.cache.set(trackId, entry);
    this.evict();
  }

  private next() {
    if (this.running || this.held || !this.queued) return;
    const id = this.queued;
    this.queued = null;
    this.warm(id);
  }

  /** Over the limit: drop the oldest finished ones. */
  private evict() {
    for (const [id, e] of this.cache) {
      if (this.cache.size <= this.slots) break;
      if (e.done) this.cache.delete(id);
    }
  }

  /** A deck wants this track now: its decoded audio if it's here or on its
   *  way (and leaves the cache: the deck holds it from here), else null. */
  take(trackId: string, rate: number): Promise<AudioBuffer | null> | null {
    const e = this.cache.get(trackId);
    if (!e || e.rate !== rate) return null;
    this.cache.delete(trackId);
    return e.buf;
  }

  /** Hold off starting new decodes (a deck is loading), or carry on. */
  hold(on: boolean) {
    this.held = on;
    if (!on) this.next();
  }

  forget(trackId: string) {
    this.cache.delete(trackId);
    if (this.queued === trackId) this.queued = null;
  }

  clear() {
    this.cache.clear();
    this.queued = null;
  }
}
