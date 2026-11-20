import { LIBRARY_SCHEMA_VERSION, type LibraryFile, type LibraryTrack } from './types';

/** Where the record lives in the repo, and its schema next to it. */
export const LIBRARY_FILE_NAME = 'tracks.json';
export const LIBRARY_SCHEMA_REF = './track.schema.json';

export function makeLibraryFile(tracks: LibraryTrack[], root: string | null, generator: string): LibraryFile {
  return {
    $schema: LIBRARY_SCHEMA_REF,
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    generator,
    updatedAt: new Date().toISOString(),
    root,
    // Sorted by path, so a rescan of an unchanged folder is an unchanged file
    // (and a diff shows exactly which tracks came and went).
    tracks: [...tracks].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** JSON with one track per block and stable key order: readable in a diff. */
export function stringifyLibrary(file: LibraryFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Reads a library file, rejecting anything that isn't one. Unknown fields
 *  are kept; a newer schema version is refused rather than half-read. */
export function parseLibraryFile(text: string): LibraryFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file isn’t JSON.');
  }
  const f = data as Partial<LibraryFile>;
  if (!f || typeof f !== 'object' || !Array.isArray(f.tracks) || typeof f.schemaVersion !== 'number') {
    throw new Error('That isn’t a Platter library file (no schemaVersion or tracks).');
  }
  if (f.schemaVersion > LIBRARY_SCHEMA_VERSION) {
    throw new Error(`That library file is from a newer Platter (schema ${f.schemaVersion}); update this copy first.`);
  }
  const tracks = f.tracks.filter(
    (t): t is LibraryTrack => !!t && typeof t === 'object' && typeof t.path === 'string' && typeof t.fingerprint === 'string' && !!t.tags,
  );
  return { ...(f as LibraryFile), tracks };
}

/** Lookup by fingerprint, then path, then file name + size. */
export class LibraryIndex {
  private byPrint = new Map<string, LibraryTrack>();
  private byPath = new Map<string, LibraryTrack>();
  private byName = new Map<string, LibraryTrack>();

  constructor(tracks: LibraryTrack[] = []) {
    for (const t of tracks) this.add(t);
  }

  add(t: LibraryTrack) {
    this.byPrint.set(t.fingerprint, t);
    this.byPath.set(t.path, t);
    this.byName.set(`${t.fileName}\u0000${t.fileSize}`, t);
  }

  get size() {
    return this.byPrint.size;
  }

  find(q: { fingerprint?: string; path?: string; fileName?: string; fileSize?: number }): LibraryTrack | null {
    if (q.fingerprint) {
      const t = this.byPrint.get(q.fingerprint);
      if (t) return t;
    }
    if (q.path) {
      const t = this.byPath.get(q.path);
      // A path match only counts if the file is still the same size.
      if (t && (q.fileSize == null || t.fileSize === q.fileSize)) return t;
    }
    if (q.fileName && q.fileSize != null) return this.byName.get(`${q.fileName}\u0000${q.fileSize}`) ?? null;
    return null;
  }
}
