/**
 * Linking a music folder (File System Access API, Chromium-based browsers):
 * the crate keeps a handle to each file instead of a copy, so a library of
 * any size costs no storage, and the files are read when a track loads.
 * Browsers ask again for permission after a restart; loading a track (a
 * click) is when that question appears.
 */

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
}

type PermissionHandle = FileSystemHandle & {
  queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState>;
};

const AUDIO = /\.(mp3|wav|aiff?|flac|ogg|oga|opus|m4a|aac|webm)$/i;
const MAX_FILES = 5000;
const MAX_DEPTH = 6;

export function canLinkFolder() {
  return typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const pick = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!pick) return null;
  try {
    return await pick({ mode: 'read', id: 'platter-music' });
  } catch {
    return null; // cancelled, or refused by the host frame
  }
}

/** Every audio file under `dir`, depth-first, up to a few thousand. */
export async function audioFilesIn(dir: FileSystemDirectoryHandle): Promise<FileSystemFileHandle[]> {
  const out: FileSystemFileHandle[] = [];
  const walk = async (d: FileSystemDirectoryHandle, depth: number) => {
    for await (const entry of d.values()) {
      if (out.length >= MAX_FILES) return;
      if (entry.kind === 'file' && AUDIO.test(entry.name)) out.push(entry as FileSystemFileHandle);
      else if (entry.kind === 'directory' && depth < MAX_DEPTH && !entry.name.startsWith('.')) {
        await walk(entry as FileSystemDirectoryHandle, depth + 1);
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Reads a linked file, asking for permission again if the browser wants it.
 *  `interactive` false (background analysis) never prompts. */
export async function fileFromHandle(handle: FileSystemFileHandle, interactive: boolean): Promise<File | null> {
  const h = handle as PermissionHandle;
  let state = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
  if (state === 'prompt' && interactive) state = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
  if (state !== 'granted') return null;
  return handle.getFile();
}
