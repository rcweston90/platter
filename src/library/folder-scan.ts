/**
 * Walking a linked folder (File System Access API: Chrome, Edge, Arc, Brave).
 * Unlike src/engine/folder.ts this keeps each file's path inside the folder,
 * so the library record can name it and a rescan can tell new from known.
 */

interface PickerWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
}

type PermissionHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

export const AUDIO_FILE = /\.(mp3|wav|aiff?|flac|ogg|oga|opus|m4a|aac|webm)$/i;
const MAX_FILES = 20000;
const MAX_DEPTH = 8;
/** Where Platter keeps pre-split stems inside the linked folder (engine/stems/stemfile.ts). */
const STEMS_DIR = 'Platter Stems';

export function canPickDirectory() {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

export async function pickDirectory(mode: 'read' | 'readwrite', id: string): Promise<FileSystemDirectoryHandle | null> {
  const pick = (window as PickerWindow).showDirectoryPicker;
  if (!pick) return null;
  try {
    return await pick({ mode, id });
  } catch {
    return null; // cancelled, or refused (system folders, a sandboxed frame)
  }
}

/** Current permission; `interactive` (inside a click) may ask for it. */
export async function permission(h: FileSystemHandle, mode: 'read' | 'readwrite', interactive: boolean): Promise<PermissionState> {
  const p = h as PermissionHandle;
  let state = (await p.queryPermission?.({ mode })) ?? 'granted';
  if (state === 'prompt' && interactive) state = (await p.requestPermission?.({ mode })) ?? 'denied';
  return state;
}

/** Every audio file under `dir` with its path inside it ("Artist/Album/01 Song.flac"). */
export async function audioFilesWithPaths(dir: FileSystemDirectoryHandle): Promise<{ handle: FileSystemFileHandle; path: string }[]> {
  const out: { handle: FileSystemFileHandle; path: string }[] = [];
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    const entries: FileSystemHandle[] = [];
    for await (const entry of d.values()) entries.push(entry);
    // Sorted, so the crate fills in a predictable order.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith('.') || (depth === 0 && entry.name === STEMS_DIR)) continue;
      if (entry.kind === 'file' && AUDIO_FILE.test(entry.name)) out.push({ handle: entry as FileSystemFileHandle, path: prefix + entry.name });
      else if (entry.kind === 'directory' && depth < MAX_DEPTH) await walk(entry as FileSystemDirectoryHandle, `${prefix}${entry.name}/`, depth + 1);
    }
  };
  await walk(dir, '', 0);
  return out;
}
