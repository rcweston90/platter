import { getValue, setValue } from './library';
import { createStore, type Store } from './store';
import type { TrackRecord } from './types';

/**
 * Playlists: named, ordered lists of crate tracks. A track sits in a
 * playlist once; the same track can be in as many playlists as you like.
 * Playlists hold track ids only, so a track removed from the crate drops out
 * of every playlist too.
 *
 * Kept in IndexedDB (the kv store, key "playlists") and in backups, where
 * they point at the backup's own track ids and are matched back to the
 * crate on import.
 */

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: number;
}

export interface PlaylistsState {
  lists: Playlist[];
  loaded: boolean;
}

const KEY = 'playlists';

/* ── The rules, as plain functions ──────────────────────────────────────── */

/** Moves one item from `from` to `to` (both indices into the list as it is). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

/** Adds ids not already in the list, at `at` (the end by default), in order. */
export function addIds(list: readonly string[], ids: readonly string[], at = list.length): string[] {
  const have = new Set(list);
  const fresh = ids.filter((id, i) => !have.has(id) && ids.indexOf(id) === i);
  const out = [...list];
  out.splice(Math.max(0, Math.min(out.length, at)), 0, ...fresh);
  return out;
}

/** "Playlist 3": the first free number. */
export function nextName(lists: readonly Playlist[], base = 'Playlist') {
  const names = new Set(lists.map((l) => l.name.toLowerCase()));
  for (let n = lists.length + 1; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

const newId = () => `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function isPlaylist(x: unknown): x is Playlist {
  const p = x as Playlist | null;
  return !!p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.trackIds);
}

const tidy = (p: Playlist): Playlist => ({
  id: p.id,
  name: p.name.trim() || 'Playlist',
  trackIds: addIds([], p.trackIds.filter((id): id is string => typeof id === 'string')),
  createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
});

/** A playlist in a backup: its tracks by the backup's own track ids. */
export interface BackupPlaylist {
  id: string;
  name: string;
  tracks: string[];
}

export class Playlists {
  readonly store: Store<PlaylistsState> = createStore<PlaylistsState>({ lists: [], loaded: false });

  constructor(private readonly persist = true) {
    if (!persist) this.store.set({ loaded: true });
  }

  async init() {
    if (!this.persist || this.store.get().loaded) return;
    const saved = await getValue<unknown>(KEY);
    const old = Array.isArray(saved) ? saved.filter(isPlaylist).map(tidy) : [];
    // Anything made before the saved ones arrived stays, after them.
    const ids = new Set(old.map((p) => p.id));
    const early = this.store.get().lists.filter((p) => !ids.has(p.id));
    this.store.set({ lists: [...old, ...early], loaded: true });
    if (early.length) this.save(this.store.get().lists);
  }

  /** Drops tracks from every playlist when they leave the crate. */
  follow(crate: Store<{ tracks: TrackRecord[]; loaded: boolean }>): () => void {
    let had: Set<string> | null = null;
    const read = () => {
      const { tracks, loaded } = crate.get();
      if (!loaded) return;
      const now = new Set(tracks.map((t) => t.id));
      if (had) {
        const gone = [...had].filter((id) => !now.has(id));
        if (gone.length) this.forget(gone);
      }
      had = now;
    };
    read();
    return crate.subscribe(read);
  }

  get(id: string) {
    return this.store.get().lists.find((p) => p.id === id) ?? null;
  }

  create(name?: string, trackIds: string[] = []): Playlist {
    const lists = this.store.get().lists;
    const p: Playlist = { id: newId(), name: name?.trim() || nextName(lists), trackIds: addIds([], trackIds), createdAt: Date.now() };
    this.save([...lists, p]);
    return p;
  }

  rename(id: string, name: string) {
    const n = name.trim();
    if (!n) return;
    this.patch(id, () => ({ name: n }));
  }

  remove(id: string) {
    this.save(this.store.get().lists.filter((p) => p.id !== id));
  }

  /** Moves a playlist to another place in the list of playlists. */
  moveList(id: string, to: number) {
    const lists = this.store.get().lists;
    this.save(moveItem(lists, lists.findIndex((p) => p.id === id), to));
  }

  /** Adds tracks (not already in it) at `at`, the end by default. Returns how many went in. */
  add(id: string, trackIds: string[], at?: number): number {
    const p = this.get(id);
    if (!p) return 0;
    const next = addIds(p.trackIds, trackIds, at);
    if (next.length !== p.trackIds.length) this.patch(id, () => ({ trackIds: next }));
    return next.length - p.trackIds.length;
  }

  removeTrack(id: string, trackId: string) {
    this.patch(id, (p) => ({ trackIds: p.trackIds.filter((t) => t !== trackId) }));
  }

  /** Moves the track at `from` to `to` within a playlist. */
  moveTrack(id: string, from: number, to: number) {
    this.patch(id, (p) => ({ trackIds: moveItem(p.trackIds, from, to) }));
  }

  /** Takes tracks out of every playlist. */
  forget(trackIds: string[]) {
    const gone = new Set(trackIds);
    const lists = this.store.get().lists;
    if (!lists.some((p) => p.trackIds.some((t) => gone.has(t)))) return;
    this.save(lists.map((p) => (p.trackIds.some((t) => gone.has(t)) ? { ...p, trackIds: p.trackIds.filter((t) => !gone.has(t)) } : p)));
  }

  /** Playlists as a backup keeps them. */
  toBackup(): BackupPlaylist[] {
    return this.store.get().lists.map((p) => ({ id: p.id, name: p.name, tracks: [...p.trackIds] }));
  }

  /**
   * Playlists from a backup. `idMap` maps the backup's track ids to crate
   * tracks; tracks that aren't in this crate are left out. A playlist that's
   * already here (same id, or else same name) takes the backup's order, with
   * any tracks only this browser has kept after them. Returns how many
   * playlists came in or changed.
   */
  importBackup(incoming: unknown, idMap: Map<string, string>): number {
    if (!Array.isArray(incoming)) return 0;
    let lists = [...this.store.get().lists];
    let n = 0;
    for (const raw of incoming) {
      const b = raw as Partial<BackupPlaylist> | null;
      if (!b || typeof b.name !== 'string' || !Array.isArray(b.tracks)) continue;
      const ids = addIds(
        [],
        b.tracks.map((t) => (typeof t === 'string' ? idMap.get(t) : undefined)).filter((t): t is string => !!t),
      );
      const i = lists.findIndex((p) => (typeof b.id === 'string' && p.id === b.id) || p.name.toLowerCase() === b.name!.trim().toLowerCase());
      if (i >= 0) {
        lists[i] = { ...lists[i], trackIds: addIds(ids, lists[i].trackIds) };
      } else {
        lists = [...lists, tidy({ id: typeof b.id === 'string' ? b.id : newId(), name: b.name, trackIds: ids, createdAt: Date.now() })];
      }
      n++;
    }
    if (n) this.save(lists);
    return n;
  }

  private patch(id: string, fn: (p: Playlist) => Partial<Playlist>) {
    this.save(this.store.get().lists.map((p) => (p.id === id ? { ...p, ...fn(p) } : p)));
  }

  private save(lists: Playlist[]) {
    this.store.set({ lists });
    // Until the saved ones are read, a save would write over them.
    if (this.persist && this.store.get().loaded) void setValue(KEY, lists);
  }
}
