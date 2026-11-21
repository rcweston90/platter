import { trackFromFile } from '../engine/analysis';
import { getValue, setValue } from '../engine/library';
import type { DjSession } from '../engine/session';
import type { TrackRecord } from '../engine/types';
import { saveFile as downloadFile } from '../ui/save';
import { createLibraryStore, type LibraryController } from './controller';
import { audioFilesWithPaths, permission, pickDirectory } from './folder-scan';
import { LIBRARY_FILE_NAME, LibraryIndex, makeLibraryFile, parseLibraryFile, stringifyLibrary } from './libfile';
import type { MixTrack } from './mashup';
import { formatOf } from './tags';
import { ANALYZER_VERSION, type LibraryTrack, type TrackTags } from './types';

const KV_FOLDER = 'library.folder';
const KV_SYNC = 'library.syncFolder';
const KV_IMPORTED = 'library.imported';
const KV_SAVED = 'library.lastSaved';
const SYNC_DELAY_MS = 4000;

/**
 * The library side of the session:
 *  - remembers the linked music folder, so Rescan finds what was added since;
 *  - turns the crate into the library record (library/tracks.json) and keeps
 *    that file in sync with a folder you pick — your clone's library/ folder —
 *    a few seconds after anything changes;
 *  - reads a record written by the scanner (npm run library) or another
 *    browser, so tracks already analysed aren't analysed again.
 * Only your own files go in the record (added or linked); Audius, SoundCloud
 * and the demos stay out.
 */
export class LibrarySync implements LibraryController {
  readonly store = createLibraryStore();
  private folder: FileSystemDirectoryHandle | null = null;
  private syncDir: FileSystemDirectoryHandle | null = null;
  private imported = new LibraryIndex();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWritten = '';
  private batch = 0;
  private unsub: (() => void) | null = null;

  constructor(readonly session: DjSession) {}

  /** The linked music folder, if one is remembered (stems are pre-split into it). */
  get musicFolder(): FileSystemDirectoryHandle | null {
    return this.folder;
  }

  async init() {
    const [folder, sync, imported, saved] = await Promise.all([
      getValue<FileSystemDirectoryHandle>(KV_FOLDER),
      getValue<FileSystemDirectoryHandle>(KV_SYNC),
      getValue<LibraryTrack[]>(KV_IMPORTED),
      getValue<string>(KV_SAVED),
    ]);
    this.folder = isDir(folder) ? folder : null;
    this.syncDir = isDir(sync) ? sync : null;
    if (imported?.length) this.imported = new LibraryIndex(imported);
    this.store.set({ folderName: this.folder?.name ?? null, canRescan: !!this.folder, syncFolder: this.syncDir?.name ?? null, lastSaved: saved ?? null });
    this.unsub?.();
    this.unsub = this.session.crate.subscribe(() => this.onCrateChange());
    this.queueOldTracks();
    this.onCrateChange();
  }

  dispose() {
    this.unsub?.();
    this.unsub = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
  }

  /* ── Linked folder ─────────────────────────────────────────────────────── */

  async linkFolder() {
    const dir = await pickDirectory('read', 'platter-music');
    if (!dir) return;
    this.folder = dir;
    void setValue(KV_FOLDER, dir);
    this.store.set({ folderName: dir.name, canRescan: true });
    await this.scan(dir);
  }

  async rescan() {
    if (!this.folder) return this.linkFolder();
    // A click is when the browser may ask again after a restart.
    if ((await permission(this.folder, 'read', true)) !== 'granted') {
      this.note(`Platter needs permission to read “${this.folder.name}”: allow it when the browser asks, or link the folder again.`);
      return;
    }
    await this.scan(this.folder);
  }

  private async scan(dir: FileSystemDirectoryHandle) {
    this.note(`Reading “${dir.name}”…`);
    const found = await audioFilesWithPaths(dir);
    const tracks = this.session.crate.get().tracks;
    const byPath = new Map<string, TrackRecord>();
    const legacyByName = new Map<string, TrackRecord>();
    for (const t of tracks) {
      if (!t.handle) continue;
      if (t.library?.path) byPath.set(t.library.path, t);
      else legacyByName.set(t.fileName, t);
    }
    const fresh: TrackRecord[] = [];
    const seen = new Set<string>();
    let retry = 0;
    for (const { handle, path } of found) {
      seen.add(path);
      const have = byPath.get(path);
      if (have) {
        // Known. Never analysed for lack of access? Now it can be.
        if (have.library?.analysis?.analyzer !== ANALYZER_VERSION && have.status !== 'analysing') {
          this.session.updateTrack(have.id, { status: 'analysing', handle });
          retry++;
        }
        continue;
      }
      const legacy = legacyByName.get(handle.name);
      if (legacy) {
        // Linked before paths were kept: adopt the path and the fresh handle.
        legacyByName.delete(handle.name);
        const analysed = legacy.library?.analysis?.analyzer === ANALYZER_VERSION;
        this.session.updateTrack(legacy.id, {
          handle,
          library: { ...(legacy.library ?? { tags: basicTags(legacy), analysis: null }), path },
          ...(analysed ? {} : { status: 'analysing' as const }),
        });
        if (!analysed) retry++;
        continue;
      }
      try {
        const file = await handle.getFile();
        const rec = await trackFromFile(file);
        const prior = this.imported.find({ path, fileName: file.name, fileSize: file.size });
        const linked: TrackRecord = { ...rec, blob: null, handle, library: { ...rec.library!, path } };
        fresh.push(prior?.analysis?.analyzer === ANALYZER_VERSION ? applyPrior(linked, prior) : linked);
      } catch {
        // Unreadable (moved mid-scan, or a cloud placeholder): skip it.
      }
    }
    const missing = [...byPath.keys()].filter((p) => !seen.has(p)).length;
    this.batch += fresh.filter((r) => r.status === 'analysing').length + retry;
    this.session.addRecords(fresh);
    if (retry) void this.session.runAnalysis();
    const parts = [`${fresh.length} new track${fresh.length === 1 ? '' : 's'}`];
    if (found.length > fresh.length) parts.push(`${found.length - fresh.length} already in the crate`);
    if (missing) parts.push(`${missing} no longer in the folder`);
    this.note(`“${dir.name}”: ${parts.join(', ')}.`);
  }

  /* ── The library file ──────────────────────────────────────────────────── */

  /** The crate as library records: your own files only. */
  libraryTracks(): LibraryTrack[] {
    return this.session.crate
      .get()
      .tracks.filter((t) => !t.demo && !t.audius && !t.soundcloud && (t.handle || t.blob))
      .map(toLibraryTrack);
  }

  private fileText() {
    const file = makeLibraryFile(this.libraryTracks(), this.folder?.name ?? null, `Platter ${ANALYZER_VERSION} (browser)`);
    // updatedAt changes every time; compare without it.
    return { text: stringifyLibrary(file), body: stringifyLibrary({ ...file, updatedAt: '' }), count: file.tracks.length };
  }

  async chooseSyncFolder() {
    const dir = await pickDirectory('readwrite', 'platter-library');
    if (!dir) return;
    this.syncDir = dir;
    void setValue(KV_SYNC, dir);
    this.store.set({ syncFolder: dir.name });
    // A library file already there (from the scanner)? Read it first.
    try {
      const existing = await (await dir.getFileHandle(LIBRARY_FILE_NAME)).getFile();
      await this.importText(await existing.text(), false);
    } catch {
      // None yet.
    }
    await this.writeSync(true);
  }

  async forgetSyncFolder() {
    this.syncDir = null;
    void setValue(KV_SYNC, null);
    this.store.set({ syncFolder: null });
    this.note('Stopped syncing the library file.');
  }

  async saveFile() {
    if (this.syncDir) return this.writeSync(true);
    const { text, count } = this.fileText();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const msg = await downloadFile(LIBRARY_FILE_NAME, blob, url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    this.note(msg ?? `Saved ${LIBRARY_FILE_NAME} with ${count} track${count === 1 ? '' : 's'}.`);
  }

  private async writeSync(interactive: boolean) {
    const dir = this.syncDir;
    if (!dir) return;
    if ((await permission(dir, 'readwrite', interactive)) !== 'granted') {
      if (interactive) this.note(`Platter needs permission to write to “${dir.name}”.`);
      return;
    }
    const { text, body, count } = this.fileText();
    if (!interactive && body === this.lastWritten) return;
    try {
      const fh = await dir.getFileHandle(LIBRARY_FILE_NAME, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      this.lastWritten = body;
      const now = new Date().toISOString();
      void setValue(KV_SAVED, now);
      this.store.set({ lastSaved: now });
      if (interactive) this.note(`Wrote ${LIBRARY_FILE_NAME} to “${dir.name}” with ${count} track${count === 1 ? '' : 's'}.`);
    } catch {
      this.note(`Couldn’t write ${LIBRARY_FILE_NAME} to “${dir.name}”.`);
    }
  }

  async importFile(file: File) {
    try {
      await this.importText(await file.text(), true);
    } catch (err) {
      this.note(err instanceof Error ? err.message : 'That file couldn’t be read.');
    }
  }

  private async importText(text: string, say: boolean) {
    const lib = parseLibraryFile(text);
    this.imported = new LibraryIndex(lib.tracks);
    void setValue(KV_IMPORTED, lib.tracks);
    let applied = 0;
    for (const t of this.session.crate.get().tracks) {
      if (t.demo || t.audius || t.soundcloud) continue;
      const prior = this.imported.find({ fingerprint: t.library?.fingerprint, path: t.library?.path, fileName: t.fileName, fileSize: t.library?.fileSize });
      if (prior?.analysis?.analyzer !== ANALYZER_VERSION || t.library?.analysis?.analyzedAt === prior.analysis.analyzedAt) continue;
      const next = applyPrior(t, prior);
      this.session.updateTrack(t.id, { bpm: next.bpm, gridOffset: next.gridOffset, key: next.key, cues: next.cues, library: next.library, status: 'ready' });
      applied++;
    }
    if (say) this.note(`Read ${lib.tracks.length} track${lib.tracks.length === 1 ? '' : 's'} from the library file; ${applied} matched the crate. Files you link later that match it skip analysis.`);
  }

  /* ── Analysis ──────────────────────────────────────────────────────────── */

  reanalyse(ids?: string[]) {
    const want = ids ? new Set(ids) : null;
    let n = 0;
    for (const t of this.session.crate.get().tracks) {
      if (t.demo || t.soundcloud || (want && !want.has(t.id)) || t.status === 'analysing') continue;
      if (!t.blob && !t.handle && !t.audius) continue;
      this.session.updateTrack(t.id, { status: 'analysing' });
      n++;
    }
    this.batch += n;
    if (n) void this.session.runAnalysis();
  }

  /** Your own files from before the library analysis: analysed once, in the
   *  background (a linked file needs the folder's permission, so those wait
   *  for a Rescan or for loading the track). */
  private queueOldTracks() {
    const todo = this.session.crate
      .get()
      .tracks.filter((t) => !t.demo && t.status === 'ready' && (t.blob || t.handle) && t.library?.analysis?.analyzer !== ANALYZER_VERSION)
      .map((t) => t.id);
    if (todo.length) this.reanalyse(todo);
  }

  private onCrateChange() {
    const left = this.session.crate.get().tracks.filter((t) => t.status === 'analysing').length;
    this.batch = left === 0 ? 0 : Math.max(this.batch, left);
    const progress = left ? { done: this.batch - left, total: this.batch } : null;
    const cur = this.store.get().progress;
    if (cur?.done !== progress?.done || cur?.total !== progress?.total) this.store.set({ progress });
    if (this.syncDir) {
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => void this.writeSync(false), SYNC_DELAY_MS);
    }
  }

  private note(note: string) {
    this.store.set({ note });
  }

  toMixTrack(rec: TrackRecord): MixTrack {
    return {
      id: rec.id,
      title: rec.title,
      artist: rec.artist,
      bpm: rec.bpm,
      key: rec.key,
      energy: rec.library?.analysis?.energy ?? null,
      genre: rec.library?.tags.genre ?? null,
    };
  }
}

function isDir(v: unknown): v is FileSystemDirectoryHandle {
  return !!v && typeof v === 'object' && (v as { kind?: string }).kind === 'directory';
}

function basicTags(t: TrackRecord): TrackTags {
  return { title: t.title, artist: t.artist, album: null, albumArtist: null, genre: null, year: null, label: null, bpm: null, key: null, hasArt: !!t.art };
}

/** A crate record as a library record. */
export function toLibraryTrack(t: TrackRecord): LibraryTrack {
  const lib = t.library;
  // What the decks use (it may have been corrected with ×2, ÷2 or a tag) is what's recorded.
  const analysis = lib?.analysis ? { ...lib.analysis, bpm: t.bpm ?? lib.analysis.bpm, key: t.key ?? lib.analysis.key } : null;
  return {
    id: lib?.fingerprint || `crate:${t.id}`,
    path: lib?.path ?? t.fileName,
    fileName: t.fileName,
    format: lib?.format ?? formatOf(t.fileName),
    fileSize: lib?.fileSize ?? t.blob?.size ?? 0,
    modified: lib?.modified ?? null,
    fingerprint: lib?.fingerprint ?? '',
    tags: { ...(lib?.tags ?? basicTags(t)), title: t.title, artist: t.artist },
    analysis,
    addedAt: new Date(t.addedAt).toISOString(),
    ...(t.status === 'error' && t.error ? { error: t.error } : {}),
  };
}

/** Takes a scanner's (or another browser's) analysis for a crate record. */
function applyPrior(rec: TrackRecord, prior: LibraryTrack): TrackRecord {
  const a = prior.analysis!;
  return {
    ...rec,
    bpm: a.bpm ?? rec.bpm,
    gridOffset: a.bpm ? a.firstBeat : rec.gridOffset,
    key: a.key ?? rec.key,
    duration: a.duration || rec.duration,
    cues: rec.cues.main === 0 && a.bpm ? { ...rec.cues, main: a.firstBeat } : rec.cues,
    library: { ...rec.library, tags: rec.library?.tags ?? prior.tags, analysis: a, fingerprint: prior.fingerprint, fileSize: prior.fileSize },
    status: 'ready',
  };
}
