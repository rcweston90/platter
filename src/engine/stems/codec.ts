/**
 * Turning split stems into a .platterstems file and back (see stemfile.ts).
 *
 * Opus at 256 kb/s a stereo stem (WebCodecs, Chromium): about 30 MB for a
 * five-minute track's three stems, and transparent for what stems are used
 * for — muting and soloing parts in a mix. Opus runs at 48 kHz, so the stems
 * are resampled up once when saved (OfflineAudioContext, the browser's own
 * high-quality resampler) and played at 48 kHz; the deck reads them at their
 * own rate. Where Opus can't be encoded, 16-bit PCM is deflated instead.
 *
 * Writing a file decodes it straight back, to measure the encoder's priming
 * (so the stems line up to the sample with the track — "other" is the track
 * minus the rest, so a stem that's a few samples late would leave an echo in
 * it) and to prove the file plays before it's kept.
 */
import {
  deflate,
  findDelay,
  fromBase64,
  inflate,
  STEM_MODEL,
  toBase64,
  type StemFile,
  type StemFileHeader,
} from './stemfile';
import type { StemPcm } from './separate';

export type { StemPcm };

const OPUS_RATE = 48000;
const OPUS_BITRATE = 256_000;
/** Frames handed to the encoder at a time. */
const CHUNK = OPUS_RATE;
/** Below this, the round trip isn't Opus doing its job: keep PCM instead. */
const MIN_CORRELATION = 0.9;

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

type WC = typeof globalThis & {
  AudioEncoder?: typeof AudioEncoder;
  AudioDecoder?: typeof AudioDecoder;
};

function opusConfig(): AudioEncoderConfig {
  return { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 2, bitrate: OPUS_BITRATE };
}

export async function canEncodeOpus(): Promise<boolean> {
  const g = globalThis as WC;
  if (!g.AudioEncoder || !g.AudioDecoder || typeof OfflineAudioContext === 'undefined') return false;
  try {
    const [e, d] = await Promise.all([
      g.AudioEncoder.isConfigSupported(opusConfig()),
      g.AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 2 }),
    ]);
    return !!e.supported && !!d.supported;
  } catch {
    return false;
  }
}

/* ── Encoding ──────────────────────────────────────────────────────────── */

export interface EncodeSource {
  path: string;
  fingerprint: string;
  size: number;
  modified: number | null;
}

/**
 * Stems (drums, bass, vocals as 16-bit PCM at `rate`) into a stems file.
 * Opus where it works and checks out, else deflated PCM.
 */
export async function encodeStems(stems: StemPcm[], rate: number, names: string[], source: EncodeSource): Promise<StemFile> {
  if (await canEncodeOpus()) {
    try {
      const opus = await encodeOpus(stems, rate, names, source);
      if (opus) return opus;
    } catch {
      // Fall through to PCM.
    }
  }
  return encodePcm(stems, rate, names, source);
}

/**
 * Stems as they are (16-bit PCM, no compression): ready to write at once.
 * Larger than Opus, so it's replaced once Opus is encoded (see saved.ts).
 */
export function rawStems(stems: StemPcm[], rate: number, names: string[], source: EncodeSource): StemFile {
  const bytes = (a: Int16Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  return { header: header('raw16', rate, stems[0].left.length, 0, names, source), packets: stems.map((s) => [bytes(s.left), bytes(s.right)]) };
}

async function encodePcm(stems: StemPcm[], rate: number, names: string[], source: EncodeSource): Promise<StemFile> {
  const packets: Uint8Array[][] = [];
  for (const s of stems) {
    packets.push([await deflate(new Uint8Array(s.left.buffer, s.left.byteOffset, s.left.byteLength)), await deflate(new Uint8Array(s.right.buffer, s.right.byteOffset, s.right.byteLength))]);
  }
  return { header: header('pcm16', rate, stems[0].left.length, 0, names, source), packets };
}

function header(codec: StemFileHeader['codec'], sampleRate: number, frames: number, delay: number, stems: string[], source: EncodeSource, extra: Partial<StemFileHeader> = {}): StemFileHeader {
  return { model: STEM_MODEL, codec, sampleRate, frames, delay, source, stems, createdAt: new Date().toISOString(), ...extra };
}

/** One stem, 16-bit at `rate`, resampled to 48 kHz float (planar L, R). */
async function to48k(s: StemPcm, rate: number): Promise<[Float32Array, Float32Array]> {
  const n = s.left.length;
  const frames = Math.round((n * OPUS_RATE) / rate);
  const ctx = new OfflineAudioContext(2, frames, OPUS_RATE);
  const buf = ctx.createBuffer(2, n, rate);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = s.left[i] / 32767;
    r[i] = s.right[i] / 32767;
  }
  buf.copyToChannel(l, 0);
  buf.copyToChannel(r, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

async function encodeOpus(stems: StemPcm[], rate: number, names: string[], source: EncodeSource): Promise<StemFile | null> {
  const g = globalThis as WC;
  const packets: Uint8Array[][] = [];
  let description: Uint8Array | undefined;
  let packetFrames = 960;
  let frames = 0;
  const found: { delay: number; correlation: number }[] = [];
  // One stem at a time (a five-minute stem at 48 kHz is ~115 MB as float).
  for (const s of stems) {
    const pcm = await to48k(s, rate);
    frames = pcm[0].length;
    const out: Uint8Array[] = [];
    let failure: unknown = null;
    const encoder = new g.AudioEncoder!({
      output: (chunk, meta) => {
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        out.push(b);
        if (chunk.duration) packetFrames = Math.round((chunk.duration * OPUS_RATE) / 1e6);
        const d = meta?.decoderConfig?.description;
        if (d && !description) description = toBytes(d);
      },
      error: (e) => (failure = e),
    });
    encoder.configure(opusConfig());
    for (let at = 0; at < frames; at += CHUNK) {
      const n = Math.min(CHUNK, frames - at);
      const data = new Float32Array(2 * n);
      data.set(pcm[0].subarray(at, at + n), 0);
      data.set(pcm[1].subarray(at, at + n), n);
      const audio = new AudioData({ format: 'f32-planar', sampleRate: OPUS_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((at * 1e6) / OPUS_RATE), data });
      encoder.encode(audio);
      audio.close();
      // Don't pile up more than a few seconds ahead of the encoder.
      while (encoder.encodeQueueSize > 4 && !failure) await new Promise((r) => setTimeout(r, 5));
      if (failure) break;
    }
    if (!failure) await encoder.flush();
    encoder.close();
    if (failure || !out.length) return null;
    packets.push(out);
    await yieldToUi();

    // Decode it straight back: its priming, and proof that it plays.
    const decoded = await decodeOpusStream(out, description, packetFrames);
    if (!decoded) return null;
    const f = findDelay(monoOf(pcm), monoOf(decoded), { window: 8192 });
    await yieldToUi();
    if (f) found.push(f); // none for a silent stem (no vocals): nothing to measure on
  }
  // The delay is the encoder's, the same for every stem: read it off the
  // clearest one. A faint stem (a little vocal bleed) may match less well;
  // the clear ones must agree with each other.
  const clear = found.filter((f) => f.correlation >= MIN_CORRELATION);
  if (found.length && !clear.length) return null;
  const delay = clear.length ? clear.reduce((a, b) => (b.correlation > a.correlation ? b : a)).delay : null;
  if (clear.some((f) => Math.abs(f.delay - delay!) > 1)) return null;
  return {
    header: header('opus', OPUS_RATE, frames, delay ?? 0, names, source, {
      ...(description ? { description: toBase64(description) } : {}),
      packetFrames,
    }),
    packets,
  };
}

function monoOf([a, b]: [Float32Array, Float32Array]): Float32Array {
  const m = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) m[i] = a[i] + b[i];
  return m;
}

function toBytes(d: AllowSharedBufferSource): Uint8Array {
  if (d instanceof ArrayBuffer) return new Uint8Array(d.slice(0));
  const v = d as ArrayBufferView;
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
}

/** An Opus stream's packets to float planar stereo at 48 kHz (untrimmed). */
async function decodeOpusStream(packets: Uint8Array[], description: Uint8Array | undefined, packetFrames: number): Promise<[Float32Array, Float32Array] | null> {
  const g = globalThis as WC;
  const parts: [Float32Array, Float32Array][] = [];
  let total = 0;
  let failure: unknown = null;
  const decoder = new g.AudioDecoder!({
    output: (a) => {
      const n = a.numberOfFrames;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      a.copyTo(l, { planeIndex: 0, format: 'f32-planar' });
      a.copyTo(r, { planeIndex: a.numberOfChannels > 1 ? 1 : 0, format: 'f32-planar' });
      a.close();
      parts.push([l, r]);
      total += n;
    },
    error: (e) => (failure = e),
  });
  decoder.configure({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 2, ...(description ? { description } : {}) });
  const us = (packetFrames * 1e6) / OPUS_RATE;
  for (let i = 0; i < packets.length && !failure; i++) {
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * us), duration: Math.round(us), data: packets[i] }));
    if (decoder.decodeQueueSize > 64) await new Promise((r) => setTimeout(r, 0));
  }
  if (!failure) await decoder.flush();
  decoder.close();
  if (failure) return null;
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  let at = 0;
  for (const [pl, pr] of parts) {
    l.set(pl, at);
    r.set(pr, at);
    at += pl.length;
  }
  return [l, r];
}

/* ── Decoding ──────────────────────────────────────────────────────────── */

const toI16 = (v: number) => (v >= 1 ? 32767 : v <= -1 ? -32767 : Math.round(v * 32767));

/** A stems file back to 16-bit PCM stems at `header.sampleRate`, lined up with the track. */
export async function decodeStems(file: StemFile): Promise<{ stems: StemPcm[]; rate: number }> {
  const h = file.header;
  const stems: StemPcm[] = [];
  if (h.codec === 'raw16') {
    // Copied out: a packet can sit at an odd offset in the file.
    const i16 = (b: Uint8Array) => new Int16Array(b.slice().buffer);
    for (const [l, r] of file.packets) {
      const left = i16(l);
      const right = i16(r);
      if (left.length !== h.frames || right.length !== h.frames) throw new Error('The saved stems are the wrong length.');
      stems.push({ left, right });
    }
    return { stems, rate: h.sampleRate };
  }
  if (h.codec === 'pcm16') {
    for (const [l, r] of file.packets) {
      const [lb, rb] = await Promise.all([inflate(l), inflate(r)]);
      const left = new Int16Array(lb.buffer, lb.byteOffset, lb.byteLength >> 1);
      const right = new Int16Array(rb.buffer, rb.byteOffset, rb.byteLength >> 1);
      if (left.length !== h.frames || right.length !== h.frames) throw new Error('The saved stems are the wrong length.');
      stems.push({ left, right });
    }
    return { stems, rate: h.sampleRate };
  }
  const description = h.description ? fromBase64(h.description) : undefined;
  const decoded = await Promise.all(file.packets.map((p) => decodeOpusStream(p, description, h.packetFrames ?? 960)));
  for (const d of decoded) {
    if (!d) throw new Error('The saved stems couldn’t be decoded.');
    const left = new Int16Array(h.frames);
    const right = new Int16Array(h.frames);
    // decoded[i + delay] is track frame i.
    for (let i = 0; i < h.frames; i++) {
      const j = i + h.delay;
      if (j < 0 || j >= d[0].length) continue;
      left[i] = toI16(d[0][j]);
      right[i] = toI16(d[1][j]);
    }
    stems.push({ left, right });
  }
  return { stems, rate: h.sampleRate };
}
