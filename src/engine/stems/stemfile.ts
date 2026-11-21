/**
 * The saved-stems file (.platterstems): one per split track, kept next to the
 * music in "<linked folder>/Platter Stems/", mirroring the track's own path.
 *
 *   "PLTSTEM1"                        8 bytes, magic + layout version
 *   u32 header length, header JSON    (StemFileHeader, UTF-8)
 *   then per stem (header.stems order):
 *     u32 packet count, u32 × count packet sizes, the packets back to back
 *
 * The audio is drums, bass and vocals (engine/stems keeps "other" as the
 * track minus those three). Codecs:
 *   · "opus":   one Opus stream per stem at 48 kHz (WebCodecs), raw packets.
 *               `delay` is how many decoded frames lead the audio (encoder
 *               priming), measured when the file was written.
 *   · "pcm16":  16-bit PCM at the stems model's rate, deflated — the fallback
 *               where the browser can't encode Opus. One packet per channel.
 *
 * Pure (no DOM), so it's tested in Node. All little-endian.
 */

export const STEM_FILE_EXT = '.platterstems';
export const STEMS_DIR = 'Platter Stems';
const MAGIC = 'PLTSTEM1';
/** Changes when the separation would give different stems (model, layout). */
export const STEM_MODEL = 'htdemucs-v4-onnx/drums,bass,vocals';

export type StemCodec = 'opus' | 'pcm16';

export interface StemFileHeader {
  model: string;
  codec: StemCodec;
  /** Rate of the decoded stems. */
  sampleRate: number;
  /** Frames per stem once decoded and trimmed. */
  frames: number;
  /** Decoded frames to drop from the front (Opus priming). */
  delay: number;
  /** Opus decoder description (OpusHead), base64, if the encoder gave one. */
  description?: string;
  /** Frames per Opus packet. */
  packetFrames?: number;
  /** The source file, so a changed file is split again. */
  source: { path: string; fingerprint: string; size: number; modified: number | null };
  stems: string[];
  createdAt: string;
}

export interface StemFile {
  header: StemFileHeader;
  /** Per stem, its packets. */
  packets: Uint8Array[][];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function packStemFile(file: StemFile): Uint8Array {
  const head = enc.encode(JSON.stringify(file.header));
  let size = 8 + 4 + head.length;
  for (const stem of file.packets) {
    size += 4 + 4 * stem.length;
    for (const p of stem) size += p.length;
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(enc.encode(MAGIC), 0);
  view.setUint32(8, head.length, true);
  out.set(head, 12);
  let at = 12 + head.length;
  for (const stem of file.packets) {
    view.setUint32(at, stem.length, true);
    at += 4;
    for (const p of stem) {
      view.setUint32(at, p.length, true);
      at += 4;
    }
    for (const p of stem) {
      out.set(p, at);
      at += p.length;
    }
  }
  return out;
}

/** Just the header, from the first bytes of a file (or null if it isn't one). */
export function readStemHeader(bytes: Uint8Array): StemFileHeader | null {
  if (bytes.length < 12 || dec.decode(bytes.subarray(0, 8)) !== MAGIC) return null;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  if (bytes.length < 12 + len) return null;
  try {
    const h = JSON.parse(dec.decode(bytes.subarray(12, 12 + len))) as StemFileHeader;
    return validHeader(h) ? h : null;
  } catch {
    return null;
  }
}

/** Bytes needed to read the header (12 bytes give its length). */
export function headerSize(first12: Uint8Array): number | null {
  if (first12.length < 12 || dec.decode(first12.subarray(0, 8)) !== MAGIC) return null;
  return 12 + new DataView(first12.buffer, first12.byteOffset, first12.byteLength).getUint32(8, true);
}

export function unpackStemFile(bytes: Uint8Array): StemFile {
  const header = readStemHeader(bytes);
  if (!header) throw new Error('Not a Platter stems file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12 + view.getUint32(8, true);
  const packets: Uint8Array[][] = [];
  for (let s = 0; s < header.stems.length; s++) {
    if (at + 4 > bytes.length) throw new Error('The stems file is cut short.');
    const count = view.getUint32(at, true);
    at += 4;
    if (at + 4 * count > bytes.length) throw new Error('The stems file is cut short.');
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) sizes.push(view.getUint32(at + 4 * i, true));
    at += 4 * count;
    const stem: Uint8Array[] = [];
    for (const n of sizes) {
      if (at + n > bytes.length) throw new Error('The stems file is cut short.');
      stem.push(bytes.subarray(at, at + n));
      at += n;
    }
    packets.push(stem);
  }
  return { header, packets };
}

function validHeader(h: StemFileHeader): boolean {
  return (
    !!h &&
    typeof h.model === 'string' &&
    (h.codec === 'opus' || h.codec === 'pcm16') &&
    Number.isFinite(h.sampleRate) &&
    h.sampleRate > 0 &&
    Number.isInteger(h.frames) &&
    h.frames > 0 &&
    Number.isInteger(h.delay) &&
    Array.isArray(h.stems) &&
    !!h.source &&
    typeof h.source.fingerprint === 'string'
  );
}

/** Is this saved file still the stems of that source file? */
export function headerMatches(h: StemFileHeader, src: { fingerprint: string }): boolean {
  return h.model === STEM_MODEL && !!src.fingerprint && h.source.fingerprint === src.fingerprint;
}

/** "House/Song.flac" → ["House"], "Song.flac.platterstems". Never escapes the stems folder. */
export function stemFileLocation(trackPath: string): { dirs: string[]; name: string } {
  const parts = trackPath.split('/').filter((p) => p && p !== '.' && p !== '..');
  const file = parts.pop() ?? 'track';
  return { dirs: parts, name: file + STEM_FILE_EXT };
}

/* ── Alignment ─────────────────────────────────────────────────────────── */

/**
 * How far `decoded` runs ahead of `reference`: the lag d (|d| ≤ maxLag) for
 * which decoded[i + d] best matches reference[i], and how well (normalised
 * correlation, 1 = identical shape). Looks at the loudest stretch of the
 * reference, `window` samples long. Null when the reference is near silent.
 */
export function findDelay(
  reference: Float32Array,
  decoded: Float32Array,
  opts: { maxLag?: number; window?: number } = {},
): { delay: number; correlation: number } | null {
  const maxLag = opts.maxLag ?? 4096;
  const win = Math.min(opts.window ?? 16384, reference.length - 2 * maxLag);
  if (win < 1024) return null;
  // The loudest window (coarse steps), away from the ends so every lag fits.
  const step = Math.max(1, Math.floor(win / 2));
  let best = -1;
  let start = maxLag;
  for (let s = maxLag; s + win + maxLag <= reference.length; s += step) {
    let e = 0;
    for (let i = s; i < s + win; i += 4) e += reference[i] * reference[i];
    if (e > best) {
      best = e;
      start = s;
    }
  }
  let refEnergy = 0;
  for (let i = start; i < start + win; i++) refEnergy += reference[i] * reference[i];
  if (refEnergy / win < 1e-8) return null; // ~−80 dBFS: nothing to line up

  let bestLag = 0;
  let bestScore = -Infinity;
  let bestNorm = 0;
  for (let d = -maxLag; d <= maxLag; d++) {
    const from = start + d;
    if (from < 0 || from + win > decoded.length) continue;
    let dot = 0;
    let e = 0;
    for (let i = 0; i < win; i++) {
      const x = decoded[from + i];
      dot += reference[start + i] * x;
      e += x * x;
    }
    const score = e > 0 ? dot / Math.sqrt(e) : -Infinity;
    if (score > bestScore) {
      bestScore = score;
      bestLag = d;
      bestNorm = e > 0 ? dot / Math.sqrt(e * refEnergy) : 0;
    }
  }
  return bestScore === -Infinity ? null : { delay: bestLag, correlation: bestNorm };
}

/* ── Small helpers shared by the codec ────────────────────────────────── */

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Deflate / inflate with the platform's CompressionStream (browsers, Node 18+). */
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('deflate-raw'));
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('deflate-raw'));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
