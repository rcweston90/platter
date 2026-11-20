import type { DjSession } from '../engine/session';
import type { TrackRecord } from '../engine/types';
import { createLibraryStore, type LibraryController } from './controller';
import type { MixTrack } from './mashup';

/** Session-side implementation of the LibraryController (being built). */
export class LibrarySync implements LibraryController {
  readonly store = createLibraryStore();
  constructor(readonly session: DjSession) {}
  async rescan() {}
  async linkFolder() {}
  async chooseSyncFolder() {}
  async forgetSyncFolder() {}
  async saveFile() {}
  async importFile(_file: File) {}
  reanalyse(_ids?: string[]) {}
  toMixTrack(rec: TrackRecord): MixTrack {
    const a = rec.library?.analysis;
    return {
      id: rec.id,
      title: rec.title,
      artist: rec.artist,
      bpm: rec.bpm,
      key: rec.key,
      energy: a?.energy ?? null,
      genre: rec.library?.tags.genre ?? null,
    };
  }
}
