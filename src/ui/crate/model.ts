import { compatible } from '../../engine/key';
import { createStore } from '../../engine/store';
import type { TrackRecord } from '../../engine/types';

/**
 * The crate browser's shared state and the pure rules behind it.
 *
 * One track list, three places it can sit: in the page under the decks, in a
 * small floating window, or full screen. They are the same list, so search,
 * sort and filters live here rather than in any one of them — pop the list
 * out mid-search and the search comes with it.
 */

export type CrateView = 'page' | 'mini' | 'full';
export type SortKey = 'added' | 'title' | 'artist' | 'bpm' | 'key' | 'energy' | 'duration';
export type SourceKind = 'folder' | 'file' | 'soundcloud' | 'audius' | 'demo';

export interface CrateBrowserState {
  view: CrateView;
  query: string;
  sort: { key: SortKey; dir: 1 | -1 };
  /** null = every source. */
  source: SourceKind | null;
  /** A folder inside the linked folder ('' = its top level); null = all. */
  folder: string | null;
  /** Only keys that mix with the reference deck. */
  matchKey: boolean;
  /** Only tempos within reach of the reference deck (half and double time count). */
  matchBpm: boolean;
}

export const crateBrowser = createStore<CrateBrowserState>({
  view: 'page',
  query: '',
  sort: { key: 'added', dir: 1 },
  source: null,
  folder: null,
  matchKey: false,
  matchBpm: false,
});

export const setCrateView = (view: CrateView) => crateBrowser.set({ view });

/** Where the in-page crate sits, so the floating window can grow out of it
 *  and land back in it. Set by the in-page crate while it's mounted. */
export const crateSlot = createStore<{ el: HTMLElement | null; launcher: HTMLElement | null }>({ el: null, launcher: null });

export const SOURCE_LABEL: Record<SourceKind, string> = {
  folder: 'Folder',
  file: 'File',
  soundcloud: 'SoundCloud',
  audius: 'Audius',
  demo: 'Demo',
};

export function sourceOf(t: TrackRecord): SourceKind {
  if (t.demo) return 'demo';
  if (t.soundcloud) return 'soundcloud';
  if (t.audius) return 'audius';
  if (t.handle || t.library?.path) return 'folder';
  return 'file';
}

/** The folder a linked track sits in, relative to the linked folder ('' = top level). */
export function folderOf(t: TrackRecord): string | null {
  const path = t.library?.path;
  if (!path) return null;
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

const inFolder = (dir: string | null, folder: string) =>
  dir !== null && (folder === '' ? dir === '' : dir === folder || dir.startsWith(`${folder}/`));

export function energyOf(t: TrackRecord): number | null {
  return t.library?.analysis?.energy ?? null;
}

/** Camelot order round the wheel: 1A, 1B, 2A, 2B … */
const wheel = (k: string | null) => (k ? parseInt(k, 10) * 2 + (k.endsWith('B') ? 1 : 0) : Infinity);

export function compare(a: TrackRecord, b: TrackRecord, key: SortKey) {
  switch (key) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'artist':
      return a.artist.localeCompare(b.artist);
    case 'bpm':
      return (a.bpm ?? Infinity) - (b.bpm ?? Infinity);
    case 'key':
      return wheel(a.key) - wheel(b.key);
    case 'energy':
      return (energyOf(a) ?? Infinity) - (energyOf(b) ?? Infinity);
    case 'duration':
      return a.duration - b.duration;
    default:
      return a.addedAt - b.addedAt;
  }
}

/** How far a tempo is from the reference, as a signed fraction, taking the
 *  nearest of half, same and double time. */
export function tempoGap(bpm: number | null, ref: number | null): number | null {
  if (!bpm || !ref) return null;
  let best: number | null = null;
  for (const f of [0.5, 1, 2]) {
    const gap = (bpm * f - ref) / ref;
    if (best === null || Math.abs(gap) < Math.abs(best)) best = gap;
  }
  return best;
}

/** Within a pitch-fader nudge: ±6% covers the common ±8 range with room to spare. */
export const TEMPO_REACH = 0.06;

export interface Reference {
  deck: 'A' | 'B';
  bpm: number | null;
  key: string | null;
}

export function filterTracks(tracks: TrackRecord[], st: CrateBrowserState, ref: Reference | null): TrackRecord[] {
  const q = st.query.trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  const out = tracks.filter((t) => {
    if (st.source && sourceOf(t) !== st.source) return false;
    if (st.folder !== null && !inFolder(folderOf(t), st.folder)) return false;
    if (words.length) {
      const hay = `${t.title} ${t.artist} ${t.fileName} ${t.library?.path ?? ''} ${t.library?.tags.album ?? ''} ${t.library?.tags.genre ?? ''} ${t.key ?? ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    if (ref && st.matchKey && ref.key && !(t.key && compatible(t.key, ref.key))) return false;
    if (ref && st.matchBpm && ref.bpm) {
      const gap = tempoGap(t.bpm, ref.bpm);
      if (gap === null || Math.abs(gap) > TEMPO_REACH) return false;
    }
    return true;
  });
  return out.sort((x, y) => compare(x, y, st.sort.key) * st.sort.dir);
}

export interface FolderEntry {
  path: string;
  name: string;
  depth: number;
  count: number;
}

/** Every folder that holds linked tracks, parents included, with how many
 *  tracks sit at or under each. */
export function foldersOf(tracks: TrackRecord[]): FolderEntry[] {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const dir = folderOf(t);
    if (dir === null) continue;
    if (dir === '') {
      counts.set('', (counts.get('') ?? 0) + 1);
      continue;
    }
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([path, count]) => ({
      path,
      count,
      depth: path === '' ? 0 : path.split('/').length - 1,
      name: path === '' ? 'Top level' : path.slice(path.lastIndexOf('/') + 1),
    }));
}

/** Track art as an object URL, made once per blob and kept for the page's life. */
const artUrls = new WeakMap<Blob, string>();
export function artUrl(blob: Blob | null): string | null {
  if (!blob) return null;
  let url = artUrls.get(blob);
  if (!url) {
    url = URL.createObjectURL(blob);
    artUrls.set(blob, url);
  }
  return url;
}
