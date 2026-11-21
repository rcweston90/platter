import { useRef, useSyncExternalStore } from 'react';
import type { Store } from '../../engine/store';

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return false;
}

/**
 * A narrow subscription: re-renders only when `pick` returns something new
 * (by identity, or for arrays element by element). The arranger's parts read
 * just the slice of the studio they draw, so a store change elsewhere (a pad
 * hit, an audition, the chop editor) doesn't re-render every lane.
 */
export function useSel<T extends object, R>(store: Store<T>, pick: (s: T) => R): R {
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const memo = useRef<{ s: T; r: R } | null>(null);
  const get = () => {
    const s = store.get();
    const m = memo.current;
    if (m && m.s === s) return m.r;
    const r = pickRef.current(s);
    if (m && same(m.r, r)) {
      m.s = s;
      return m.r;
    }
    memo.current = { s, r };
    return r;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

/** The lane pads record onto: the armed audio lane, else the first audio lane. */
export function recordLaneId(lanes: { id: string; kind: string }[], armed: string | null): string | null {
  if (armed && lanes.some((l) => l.id === armed && l.kind === 'audio')) return armed;
  return lanes.find((l) => l.kind === 'audio')?.id ?? null;
}
