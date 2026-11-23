import { createStore, type Store } from '../engine/store';
import type { TrackRecord } from '../engine/types';
import type { MixTrack } from './mashup';

/** What the Mashups tab shows about the library as a whole. */
export interface LibraryState {
  /** Name of the linked music folder (not its full path), if one is linked. */
  folderName: string | null;
  /** A linked folder is remembered, so Rescan can look for new files. */
  canRescan: boolean;
  /** Deep analysis in progress: tracks done of total. */
  progress: { done: number; total: number } | null;
  /** Name of the folder the library file is kept in sync with, if chosen. */
  syncFolder: string | null;
  /** ISO time the library file was last written. */
  lastSaved: string | null;
  /** One-line result of the last action. */
  note: string | null;
  /** Can the linked folder be read now? 'prompt' after a browser restart,
   *  until a click allows it again. Null with no folder linked. */
  folderAccess: PermissionState | null;
}

/**
 * The glue between the crate (DjSession) and the library record: remembers
 * the linked folder for rescans, runs the deep analysis (energy, loudness,
 * tempo confidence, tags) on crate tracks, and keeps library/tracks.json in
 * sync with the crate. Implementation filled in by the session wiring.
 */
export interface LibraryController {
  readonly store: Store<LibraryState>;
  /** Inside a click: ask once to read the linked folder again. */
  allowFolder(): Promise<boolean>;
  /** Look in the linked folder again for files added (or removed) since. */
  rescan(): Promise<void>;
  /** Link a music folder (Chromium) — same as the crate's Link folder, but remembered for rescans. */
  linkFolder(): Promise<void>;
  /** Pick the folder to keep tracks.json in (e.g. the repo's library/ folder). */
  chooseSyncFolder(): Promise<void>;
  /** Stop writing tracks.json to the chosen folder. */
  forgetSyncFolder(): Promise<void>;
  /** Write tracks.json now: to the sync folder if chosen, else as a download. */
  saveFile(): Promise<void>;
  /** Read a tracks.json (from the CLI scanner or another browser) into the crate's analysis. */
  importFile(file: File): Promise<void>;
  /** Analyse these tracks again (default: every local track). */
  reanalyse(ids?: string[]): void;
  /** A crate track in the shape the mashup scorer takes. */
  toMixTrack(rec: TrackRecord): MixTrack;
}

export function emptyLibraryState(): LibraryState {
  return { folderName: null, canRescan: false, progress: null, syncFolder: null, lastSaved: null, note: null, folderAccess: null };
}

export function createLibraryStore(): Store<LibraryState> {
  return createStore(emptyLibraryState());
}
