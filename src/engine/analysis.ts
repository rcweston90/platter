import { detectKey } from './key';
import { peakScanner } from './peaks';
import { emptyCues, type TrackRecord, type WavePeaks } from './types';
export { PEAK_RATE } from './peaks';
import { analyzeWithPeaks } from '../library/client';
import { fingerprintBlob } from '../library/fingerprint';
import { formatOf, normaliseTags } from '../library/tags';
import type { TrackTags } from '../library/types';

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
  const p = scannerFor(buf);
  p.run(buf.length);
  return p.finish();
}

/** Samples scanned between breaks: about 2 ms of work on a laptop. */
const PEAK_SLICE = 1 << 17;

/**
 * computePeaks in slices, giving the page a frame between each. A five-minute
 * track is 13 million samples, a few hundred milliseconds in one go; run on
 * the main thread while the other deck plays, that froze the platters and
 * waveforms. Same result as computePeaks, byte for byte.
 */
export async function computePeaksAsync(buf: AudioBuffer, background = false): Promise<WavePeaks> {
  const p = scannerFor(buf);
  for (let done = 0; done < buf.length; done += PEAK_SLICE) {
    p.run(Math.min(buf.length, done + PEAK_SLICE));
    if (done + PEAK_SLICE < buf.length) await nextTask(background);
  }
  return p.finish();
}

function scannerFor(buf: AudioBuffer) {
  const L = buf.getChannelData(0);
  return peakScanner(L, buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, buf.sampleRate);
}

interface PostTaskScheduler {
  postTask(cb: () => void, opts: { priority: 'background' }): Promise<void>;
}

/** Yields to the browser: a fresh task, so rendering can run in between.
 *  `background` work (crate analysis) waits behind everything else. */
function nextTask(background: boolean): Promise<void> {
  const scheduler = (globalThis as { scheduler?: PostTaskScheduler }).scheduler;
  if (background && scheduler?.postTask) return scheduler.postTask(() => {}, { priority: 'background' });
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
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

/** Title, artist, cover art and the rest of the tags via music-metadata
 *  (MIT) — ID3, FLAC/Ogg Vorbis comments and MP4 atoms alike — falling back
 *  to an "Artist - Title" file name, then the bare file name. */
export async function readTags(file: File): Promise<{ title: string; artist: string; art: Blob | null; key: string | null; tags: TrackTags }> {
  try {
    const { parseBlob, selectCover } = await import('music-metadata');
    const meta = await parseBlob(file, { duration: false, skipCovers: false });
    const pic = selectCover(meta.common.picture);
    // A key already in the tags (Rekordbox, Mixed In Key …) beats detection.
    const tags = normaliseTags(meta, file.name);
    return { title: tags.title, artist: tags.artist, art: pic ? new Blob([new Uint8Array(pic.data)], { type: pic.format }) : null, key: tags.key, tags };
  } catch {
    const tags = normaliseTags(null, file.name);
    return { title: tags.title, artist: tags.artist, art: null, key: null, tags };
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
    library: { tags: tags.tags, analysis: null, fileSize: file.size, modified: file.lastModified || null, format: formatOf(file.name) },
    cues: emptyCues(),
    addedAt: Date.now(),
    status: 'analysing',
  };
}

/** Decode, draw, beat-detect and key-detect a crate track, plus the library
 *  analysis (energy, loudness, tempo confidence — src/library), all from one
 *  decode. Analysis runs at 44.1 kHz whatever the output rate — only the
 *  picture, tempo and key come from it. */
export async function analyseTrack(rec: TrackRecord, audio: Blob, decksFirst: () => Promise<void> = async () => {}): Promise<Partial<TrackRecord>> {
  const buf = await decodeAudio(audio, 44100);
  // A deck started loading meanwhile: let it have the CPU before the heavy part.
  await decksFirst();
  // Records from before the library carry no tags beyond title/artist: read them now.
  const tags = rec.library?.tags ?? (await readTags(audio instanceof File ? audio : new File([audio], rec.fileName))).tags;
  // The waveform and the library reading come from one copy of the audio, in
  // a worker; tempo detection and the fingerprint run alongside.
  const [tempo, both, fingerprint] = await Promise.all([
    detectTempo(buf),
    analyzeWithPeaks(buf, tags).catch(() => null),
    fingerprintBlob(audio).catch(() => undefined),
  ]);
  const deep = both?.analysis ?? null;
  const peaks = both?.peaks ?? (await computePeaksAsync(buf, true));
  const grid = pickGrid(tempo, deep);
  const patch: Partial<TrackRecord> = {
    duration: buf.duration,
    peaks,
    key: rec.key ?? deep?.key ?? detectKey(buf),
    bpm: grid?.bpm ?? null,
    gridOffset: grid?.offset ?? 0,
    status: 'ready',
  };
  patch.library = { ...rec.library, tags, analysis: deep, fingerprint, fileSize: audio.size, format: rec.library?.format ?? formatOf(rec.fileName) };
  // Auto-cue to the first beat unless the DJ has already set one.
  if (grid && rec.cues.main === 0) patch.cues = { ...rec.cues, main: grid.offset };
  return patch;
}

/** The decks' tempo and grid: the library analysis when it's confident or
 *  its tempo came from the tags, else web-audio-beat-detector's reading. */
export function pickGrid(
  beatDetector: { bpm: number; offset: number } | null,
  deep: { bpm: number | null; bpmConfidence: number; bpmSource: string; firstBeat: number } | null,
): { bpm: number; offset: number } | null {
  const round = (n: number) => Math.round(n * 100) / 100;
  if (deep?.bpm && (deep.bpmSource === 'tag' || deep.bpmConfidence >= 0.5 || !beatDetector)) return { bpm: round(deep.bpm), offset: deep.firstBeat };
  return beatDetector ? { bpm: round(beatDetector.bpm), offset: beatDetector.offset } : null;
}
