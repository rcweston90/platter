import { createStore } from '../engine/store';

export type Source = 'soundcloud' | 'audius';

/** The "Browse music" flyout: open or not, and which source it shows. */
export const browse = createStore<{ open: boolean; source: Source }>({ open: false, source: 'soundcloud' });

export const openBrowse = (source?: Source) => browse.set({ open: true, ...(source ? { source } : {}) });
export const closeBrowse = () => browse.set({ open: false });
