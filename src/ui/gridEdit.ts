import { createStore } from '../engine/store';

/**
 * Which decks are in grid edit mode. UI state only (never saved): the deck
 * panel shows the edit row, the scrolling waveform numbers the beats.
 */
export const gridEdit = createStore<{ on: [boolean, boolean] }>({ on: [false, false] });

export function setGridEdit(index: 0 | 1, on: boolean) {
  const next: [boolean, boolean] = [...gridEdit.get().on];
  next[index] = on;
  gridEdit.set({ on: next });
}
