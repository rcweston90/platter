import { useEffect } from 'react';
import type { DjSession } from '../engine/session';
import { createStore, type Store } from '../engine/store';

/**
 * Keeps the screen on while a deck plays (the Screen Wake Lock API), so a
 * phone or laptop doesn't dim and lock in the middle of a mix. The lock is
 * taken when a deck starts, let go when nothing plays, and taken again when
 * the tab comes back into view: browsers drop it themselves whenever the page
 * is hidden. Where the API is missing, or the browser refuses (a battery
 * saver, a page without focus), nothing happens and nothing is shown.
 *
 * The controller takes the browser pieces it needs as arguments, so the
 * tests can drive it with a fake lock and a fake document.
 */

export type AwakeState = 'unsupported' | 'off' | 'asking' | 'held' | 'refused';

interface Sentinel {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', fn: () => void): void;
}
export interface WakeLockLike {
  request(type: 'screen'): Promise<Sentinel>;
}
export interface DocLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export class ScreenAwake {
  readonly store: Store<{ state: AwakeState }>;
  private wanted = false;
  private sentinel: Sentinel | null = null;
  private asking = false;
  private disposed = false;

  constructor(
    private lock: WakeLockLike | null | undefined,
    private doc: DocLike,
  ) {
    this.store = createStore<{ state: AwakeState }>({ state: lock ? 'off' : 'unsupported' });
    if (lock) doc.addEventListener('visibilitychange', this.sync);
  }

  /** True while a deck plays. */
  setWanted(on: boolean) {
    if (on === this.wanted) return;
    this.wanted = on;
    this.sync();
  }

  dispose() {
    this.disposed = true;
    this.wanted = false;
    this.doc.removeEventListener('visibilitychange', this.sync);
    this.sync();
  }

  private readonly sync = () => {
    if (!this.lock) return;
    const visible = this.doc.visibilityState === 'visible';
    if (this.wanted && visible && !this.sentinel && !this.asking) {
      this.asking = true;
      this.store.set({ state: 'asking' });
      this.lock.request('screen').then(
        (sentinel) => {
          this.asking = false;
          if (sentinel.released) return this.store.set({ state: 'off' });
          this.sentinel = sentinel;
          sentinel.addEventListener('release', () => {
            // The browser let go (the tab was hidden) or we did.
            if (this.sentinel !== sentinel) return;
            this.sentinel = null;
            this.store.set({ state: 'off' });
            if (!this.disposed) this.sync();
          });
          this.store.set({ state: 'held' });
          // Nothing plays any more, or the tab went away, while we waited.
          if (!this.wanted || this.doc.visibilityState !== 'visible') this.sync();
        },
        () => {
          this.asking = false;
          // Refused: try again on the next play or the next return to the tab.
          this.store.set({ state: 'refused' });
        },
      );
    } else if ((!this.wanted || !visible) && this.sentinel) {
      const s = this.sentinel;
      this.sentinel = null;
      this.store.set({ state: 'off' });
      void s.release().catch(() => undefined);
    } else if (!this.wanted && !this.sentinel && !this.asking && this.store.get().state === 'refused') {
      this.store.set({ state: 'off' });
    }
  };
}

let shared: ScreenAwake | null = null;
/** The page's one controller (created on first use). */
export function screenAwake(): ScreenAwake {
  if (!shared) {
    const lock = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock : undefined;
    shared = new ScreenAwake(lock, document);
  }
  return shared;
}

/** Holds the screen awake while either deck plays. */
export function useScreenAwake(session: DjSession) {
  useEffect(() => {
    const awake = screenAwake();
    const playing = () => session.decks.some((d) => d.store.get().playing);
    const update = () => awake.setWanted(playing());
    // Mirrored on the page root for the tests (and anyone debugging).
    const show = () => {
      document.documentElement.dataset.screenAwake = awake.store.get().state;
    };
    show();
    update();
    const offs = [...session.decks.map((d) => d.store.subscribe(update)), awake.store.subscribe(show)];
    return () => {
      offs.forEach((off) => off());
      awake.setWanted(false);
    };
  }, [session]);
}
