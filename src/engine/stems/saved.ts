/**
 * Saved stems on disk: "<linked music folder>/Platter Stems/<track path>.platterstems".
 * They stay on the user's computer, next to the music: never in the browser's
 * storage, the repo or any server. Writing needs the folder's readwrite
 * permission, which the browser asks for on a click (see presplit.ts).
 */
import { encodeStems, decodeStems, type EncodeSource, type StemPcm } from './codec';
import { headerMatches, headerSize, packStemFile, readStemHeader, stemFileLocation, STEMS_DIR, unpackStemFile, type StemFileHeader } from './stemfile';

export type Access = 'granted' | 'prompt' | 'denied';

type PermissionHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

export async function access(dir: FileSystemDirectoryHandle, mode: 'read' | 'readwrite', interactive: boolean): Promise<Access> {
  const h = dir as PermissionHandle;
  try {
    let state = (await h.queryPermission?.({ mode })) ?? 'granted';
    if (state === 'prompt' && interactive) state = (await h.requestPermission?.({ mode })) ?? 'denied';
    return state;
  } catch {
    return 'denied';
  }
}

async function stemsDir(root: FileSystemDirectoryHandle, dirs: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    let d = await root.getDirectoryHandle(STEMS_DIR, { create });
    for (const part of dirs) d = await d.getDirectoryHandle(part, { create });
    return d;
  } catch {
    return null;
  }
}

async function fileHandle(root: FileSystemDirectoryHandle, trackPath: string, create: boolean): Promise<FileSystemFileHandle | null> {
  const { dirs, name } = stemFileLocation(trackPath);
  const dir = await stemsDir(root, dirs, create);
  if (!dir) return null;
  try {
    return await dir.getFileHandle(name, { create });
  } catch {
    return null;
  }
}

/** The saved file's header, if there is one (reads only its first bytes). */
export async function savedHeader(root: FileSystemDirectoryHandle, trackPath: string): Promise<{ header: StemFileHeader; bytes: number } | null> {
  const fh = await fileHandle(root, trackPath, false);
  if (!fh) return null;
  try {
    const file = await fh.getFile();
    const first = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const size = headerSize(first);
    if (!size || size > 1_000_000) return null;
    const header = readStemHeader(new Uint8Array(await file.slice(0, size).arrayBuffer()));
    return header ? { header, bytes: file.size } : null;
  } catch {
    return null;
  }
}

/** Is there a saved split of this exact file? */
export async function hasSaved(root: FileSystemDirectoryHandle, trackPath: string, fingerprint: string): Promise<{ bytes: number } | null> {
  const got = await savedHeader(root, trackPath);
  return got && headerMatches(got.header, { fingerprint }) ? { bytes: got.bytes } : null;
}

/** The saved stems of this exact file, decoded; null if there are none (or they're for an older version of it). */
export async function loadSaved(root: FileSystemDirectoryHandle, trackPath: string, fingerprint: string): Promise<{ stems: StemPcm[]; rate: number } | null> {
  const fh = await fileHandle(root, trackPath, false);
  if (!fh) return null;
  try {
    const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
    const file = unpackStemFile(bytes);
    if (!headerMatches(file.header, { fingerprint })) return null;
    return await decodeStems(file);
  } catch {
    return null;
  }
}

/** Encodes and writes the stems; returns the file's size. The write only lands once complete. */
export async function writeSaved(root: FileSystemDirectoryHandle, source: EncodeSource, stems: StemPcm[], rate: number, names: string[]): Promise<number> {
  const file = await encodeStems(stems, rate, names, source);
  const bytes = packStemFile(file);
  const fh = await fileHandle(root, source.path, true);
  if (!fh) throw new Error(`Couldn’t make a folder for the stems in “${root.name}”.`);
  const w = await fh.createWritable();
  try {
    await w.write(bytes as BlobPart);
    await w.close();
  } catch (err) {
    await w.abort().catch(() => undefined);
    throw err;
  }
  return bytes.length;
}
