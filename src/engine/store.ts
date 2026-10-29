import { useSyncExternalStore } from 'react';

/**
 * The smallest store that works with useSyncExternalStore. The audio engine is
 * imperative and long-lived; React only needs to re-render when a deck or the
 * mixer changes state — never per audio frame (those paths draw straight to
 * canvas and refs).
 */
export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      listeners.forEach((fn) => fn());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
