import { useCallback, useRef, useSyncExternalStore } from 'react';

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
      // A patch of unchanged plain values (a status line re-set every tick)
      // changes nothing: don't wake every subscriber for it. Objects always
      // notify, since some callers update one in place and set it again.
      let changed = false;
      for (const k in patch) {
        const v = patch[k];
        if (!Object.is(v, state[k]) || (typeof v === 'object' && v !== null)) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
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

/**
 * Subscribes to one slice of a store: the component re-renders only when
 * `select`'s result changes (by `equal`, Object.is by default). Use it where
 * a component needs one field of a busy store — the mixer changes on every
 * fader and knob movement, and re-rendering the whole rig for each one is
 * what made the platters stutter while mixing.
 */
export function useStoreSelect<T extends object, S>(store: Store<T>, select: (s: T) => S, equal: (a: S, b: S) => boolean = Object.is): S {
  const latest = useRef({ select, equal });
  latest.current = { select, equal };
  const cache = useRef<{ state: T; value: S } | null>(null);
  const get = useCallback(() => {
    const state = store.get();
    const c = cache.current;
    const value = latest.current.select(state);
    if (c && latest.current.equal(c.value, value)) {
      cache.current = { state, value: c.value };
      return c.value;
    }
    cache.current = { state, value };
    return value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, get, get);
}

/** Shallow equality for small selected objects and tuples. */
export function shallowEqual<S>(a: S, b: S): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
