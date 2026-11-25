import { createStore } from '../engine/store';

/**
 * Rings: animated outlines the booth guide draws around controls on screen,
 * to point at one ("this is the crossfader") or to show one moving with its
 * value. The overlay (Rings.tsx) follows each control's box every frame, so
 * a ring stays put through scrolling and resizing.
 */
export interface Ring {
  /** The control's registry id. */
  id: string;
  /** Point: a short pulse to say "here". Move: held while the guide moves it. */
  tone: 'point' | 'move';
  /** The text on the ring's tag, read every frame (a moving value). */
  text?: () => string;
  /** performance.now() after which the ring goes; none = until removed. */
  until?: number;
}

export const rings = createStore<{ list: Ring[] }>({ list: [] });

export function addRing(r: Ring) {
  rings.set({ list: [...rings.get().list.filter((x) => x.id !== r.id), r] });
}

export function removeRing(id: string) {
  const list = rings.get().list;
  if (list.some((x) => x.id === id)) rings.set({ list: list.filter((x) => x.id !== id) });
}

export function clearRings(tone?: Ring['tone']) {
  const list = rings.get().list;
  const keep = tone ? list.filter((x) => x.tone !== tone) : [];
  if (keep.length !== list.length) rings.set({ list: keep });
}
