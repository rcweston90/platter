/**
 * A content fingerprint for a music file, cheap enough to take for thousands
 * of files: SHA-256 over the file size and its first and last 256 KB. It
 * survives renames and moves (so a record follows the file), and changes when
 * the audio does. Re-tagging a file changes the head bytes (tags live there in
 * MP3 and FLAC), which re-analyses it — harmless, and it picks up the new tags.
 *
 * Uses WebCrypto, which both browsers and Node (18+) have as globalThis.crypto.
 */

export const FINGERPRINT_CHUNK = 256 * 1024;

export async function fingerprintBytes(size: number, head: Uint8Array, tail: Uint8Array): Promise<string> {
  const sizeBytes = new Uint8Array(8);
  new DataView(sizeBytes.buffer).setBigUint64(0, BigInt(size), true);
  const all = new Uint8Array(8 + head.length + tail.length);
  all.set(sizeBytes, 0);
  all.set(head, 8);
  all.set(tail, 8 + head.length);
  const digest = await crypto.subtle.digest('SHA-256', all);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fingerprint of a browser File/Blob. */
export async function fingerprintBlob(blob: Blob): Promise<string> {
  const size = blob.size;
  const head = new Uint8Array(await blob.slice(0, Math.min(size, FINGERPRINT_CHUNK)).arrayBuffer());
  const tail = size > FINGERPRINT_CHUNK ? new Uint8Array(await blob.slice(Math.max(FINGERPRINT_CHUNK, size - FINGERPRINT_CHUNK)).arrayBuffer()) : new Uint8Array(0);
  return fingerprintBytes(size, head, tail);
}
