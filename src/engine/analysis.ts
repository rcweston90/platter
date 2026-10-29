import { camelot, detectKey, parseKeyName } from './key';
import { EQ_HIGH_HZ, EQ_LOW_HZ } from './mixer';
import { emptyCues, type TrackRecord, type WavePeaks } from './types';

/** Waveform bins per second: enough for the zoomed view to stay crisp at
 *  ~150 px/s without storing a full-resolution copy of the track. */
export const PEAK_RATE = 150;

/** Decode at a given sample rate — the engine's, so the worklet never resamples. */
export async function decodeAudio(data: Blob, sampleRate: number): Promise<AudioBuffer> {
  const bytes = await data.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, sampleRate);
  return ctx.decodeAudioData(bytes);
}

/**
 * Three-band peak envelopes — the coloured waveform. The bands split at the
 * mixer's EQ crossovers, so a killed low on the mixer is the blue that
 * disappears on screen. Two cascaded one-pole filters per split are coarse
 * next to the mixer's Linkwitz–Riley sections, but this is a picture, and it
 * keeps a five-minute track's pass well under 100 ms.
 */
export function computePeaks(buf: AudioBuffer): WavePeaks {
  const sr = buf.sampleRate;
  const n = buf.length;
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const binSize = sr / PEAK_RATE;
  const bins = Math.ceil(n / binSize);
  const low = new Float32Array(bins);
  const mid = new Float32Array(bins);
  const high = new Float32Array(bins);
  const aL = Math.exp((-2 * Math.PI * EQ_LOW_HZ) / sr);
  const aH = Math.exp((-2 * Math.PI * EQ_HIGH_HZ) / sr);
  let l1 = 0;
  let l2 = 0;
  let h1 = 0;
  let h2 = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const x = (L[i] + R[i]) * 0.5;
    l1 = x + aL * (l1 - x);
    l2 = l1 + aL * (l2 - l1);
    h1 = x + aH * (h1 - x);
    h2 = h1 + aH * (h2 - h1);
    const b = (i / binSize) | 0;
    const lo = Math.abs(l2);
    const md = Math.abs(h2 - l2);
    const hi = Math.abs(x - h2);
    if (lo > low[b]) low[b] = lo;
    if (md > mid[b]) mid[b] = md;
    if (hi > high[b]) high[b] = hi;
    if (lo > max) max = lo;
    if (md > max) max = md;
  }
  const scale = max > 0 ? 255 / max : 0;
  const q = (src: Float32Array) => {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = Math.min(255, src[i] * scale);
    return out;
  };
  return { rate: PEAK_RATE, low: q(low), mid: q(mid), high: q(high) };
}

/**
 * Tempo and the first beat, via web-audio-beat-detector (MIT). The range
 * covers house to drum & bass; anything outside lands at half or double,
 * which the deck's ×2 / ÷2 buttons put right.
 */
export async function detectTempo(buf: AudioBuffer): Promise<{ bpm: number; offset: number } | null> {
  try {
    const { guess } = await import('web-audio-beat-detector');
    const { bpm, offset } = await guess(buf, { minTempo: 85, maxTempo: 175 });
    return Number.isFinite(bpm) && bpm > 0 ? { bpm, offset } : null;
  } catch {
    return null;
  }
}

function stripExtension(name: string) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, '');
}

/** Title, artist and cover art via music-metadata (MIT); falls back to an
 *  "Artist - Title" file name, then the bare file name. */
export async function readTags(file: File): Promise<{ title: string; artist: string; art: Blob | null; key: string | null }> {
  const base = stripExtension(file.name);
  const dash = base.split(/\s+[-–]\s+/);
  const fallback = dash.length >= 2 ? { artist: dash[0], title: dash.slice(1).join(' - ') } : { artist: '', title: base };
  try {
    const { parseBlob, selectCover } = await import('music-metadata');
    const { common } = await parseBlob(file, { duration: false, skipCovers: false });
    const pic = selectCover(common.picture);
    // A key already in the tags (Rekordbox, Mixed In Key …) beats detection.
    const tagged = common.key ? parseKeyName(common.key) : null;
    return {
      title: common.title?.trim() || fallback.title,
      artist: common.artist?.trim() || fallback.artist,
      art: pic ? new Blob([new Uint8Array(pic.data)], { type: pic.format }) : null,
      key: tagged ? camelot(tagged) : null,
    };
  } catch {
    return { ...fallback, art: null, key: null };
  }
}

export function newTrackId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `t-${performance.now().toString(36)}-${Math.floor(performance.timeOrigin).toString(36)}`;
}

/** Everything the crate knows about a file before it's analysed. */
export async function trackFromFile(file: File): Promise<TrackRecord> {
  const tags = await readTags(file);
  return {
    id: newTrackId(),
    title: tags.title,
    artist: tags.artist,
    fileName: file.name,
    duration: 0,
    bpm: null,
    gridOffset: 0,
    key: tags.key,
    peaks: null,
    art: tags.art,
    blob: file,
    cues: emptyCues(),
    addedAt: Date.now(),
    status: 'analysing',
  };
}

/** Decode, draw, beat-detect and key-detect a crate track. Analysis runs at
 *  44.1 kHz whatever the output rate — only the picture, tempo and key come
 *  from it. */
export async function analyseTrack(rec: TrackRecord, audio: Blob): Promise<Partial<TrackRecord>> {
  const buf = await decodeAudio(audio, 44100);
  const peaks = computePeaks(buf);
  const tempo = await detectTempo(buf);
  const patch: Partial<TrackRecord> = {
    duration: buf.duration,
    peaks,
    key: rec.key ?? detectKey(buf),
    bpm: tempo ? Math.round(tempo.bpm * 100) / 100 : null,
    gridOffset: tempo ? tempo.offset : 0,
    status: 'ready',
  };
  // Auto-cue to the first beat unless the DJ has already set one.
  if (tempo && rec.cues.main === 0) patch.cues = { ...rec.cues, main: tempo.offset };
  return patch;
}
