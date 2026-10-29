/**
 * Saving a file the page made (the recorded mix).
 *
 * Inside the claude.ai artifact viewer, pages can't start downloads
 * themselves; they ask the host through its `downloads` capability, and the
 * viewer confirms. Anywhere else a plain <a download> does the job.
 */

interface HostDownloads {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}

interface HostWindow {
  claude?: { use?: (name: string) => Promise<unknown> };
}

async function hostDownloads(): Promise<HostDownloads | null> {
  const use = (window as unknown as HostWindow).claude?.use;
  if (typeof use !== 'function') return null;
  try {
    return (await use('downloads')) as HostDownloads | null;
  } catch {
    return null;
  }
}

/** Resolves with a short status to show, or null when nothing needs saying. */
export async function saveFile(name: string, blob: Blob, url: string): Promise<string | null> {
  const host = await hostDownloads();
  if (host) {
    try {
      await host.save({ filename: name, data: blob });
      return null;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'declined') return null;
      if (code === 'rejected_extension') return 'This page can’t save that file type.';
      return 'The mix couldn’t be saved here. Try again in a moment.';
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  return null;
}
