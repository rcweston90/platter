import { createStore } from '../../engine/store';

/** The Sounds flyout: open or not, and which tab. Shared so any pad can open it. */
export type SoundsTab = 'sounds' | 'kits';

export const soundsUi = createStore<{ open: boolean; tab: SoundsTab }>({ open: false, tab: 'sounds' });

export function openSounds(tab: SoundsTab = 'sounds') {
  soundsUi.set({ open: true, tab });
}

export function closeSounds() {
  soundsUi.set({ open: false });
}
