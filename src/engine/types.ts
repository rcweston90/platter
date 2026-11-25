import type { TrackLibraryInfo } from '../library/types';
import type { PhraseCache } from './phrases';

/** Waveform summary: per-band peak envelopes, `rate` bins per second, 0–255. */
export interface WavePeaks {
  rate: number;
  low: Uint8Array;
  mid: Uint8Array;
  high: Uint8Array;
}

/** A hot cue: a point to jump to, or for a hot loop, the loop it brings back. */
export interface HotCue {
  /** Seconds into the track; for a hot loop, where the loop starts. */
  t: number;
  /** Index into CUE_COLORS (engine/cues.ts). */
  color: number;
  /** Set for a hot loop: the loop's end (seconds) and its length in beats. */
  loop?: { end: number; beats: number };
}

/** Cue points saved with a track, in seconds. Tracks and backups from before
 *  cue banks hold four plain numbers in `hot` and no `memory`; read them
 *  through normaliseCues (engine/cues.ts). */
export interface TrackCues {
  main: number;
  /** HOT_CUES slots, bank by bank (A–H, then I–P); null where a pad is empty. */
  hot: (HotCue | null)[];
  /** Memory cues: up to MEMORY_CUES saved points, in seconds, in order. */
  memory: number[];
}

/** A track in the crate, as stored in IndexedDB. */
export interface TrackRecord {
  id: string;
  title: string;
  artist: string;
  fileName: string;
  duration: number;
  /** Tempo of the file at 0% pitch; null until analysed or if detection failed. */
  bpm: number | null;
  /** Time of a beat, in seconds — the beat grid is gridOffset + n · 60/bpm. */
  gridOffset: number;
  /** The DJ set the tempo or grid by hand (grid edit, tap, ÷2/×2): analysis
   *  run again keeps them. Absent on tracks saved before grid editing. */
  gridEdited?: boolean;
  /** Phrases (intro, build, drop …) read from the waveform on the grid they
   *  name; read again when the grid changes. Absent until first shown. */
  phrases?: PhraseCache;
  /** Camelot key code (8A = A minor); null until analysed or if unclear. */
  key: string | null;
  peaks: WavePeaks | null;
  art: Blob | null;
  /** The audio file, when it was added by drop or picker. */
  blob: Blob | null;
  /** Id of a built-in demo track (see demo.ts), synthesised on load. */
  demo?: string;
  /** A file in a linked music folder, read when the track loads. */
  handle?: FileSystemFileHandle;
  /** An Audius track id, streamed when the track loads. */
  audius?: string;
  /** A SoundCloud track URN, streamed when the track loads (its audio is never stored). */
  soundcloud?: string;
  /** The license an online track is published under, as its platform words it
   *  (Audius: "All rights reserved", "Attribution CC BY", …). Decides stems. */
  license?: string;
  /** Where the track lives online (an Audius or SoundCloud page), for attribution. */
  link?: string;
  /** Tags beyond title/artist and the library analysis (energy, loudness,
   *  tempo confidence …) — see src/library. Absent until analysed. */
  library?: TrackLibraryInfo;
  cues: TrackCues;
  addedAt: number;
  status: 'analysing' | 'ready' | 'error';
  error?: string;
}

/** Pads in a hot cue bank, and banks per deck. */
export const HOT_BANK_SIZE = 8;
export const HOT_BANKS = 2;
export const HOT_CUES = HOT_BANK_SIZE * HOT_BANKS;
export const MEMORY_CUES = 10;

export function emptyCues(): TrackCues {
  return { main: 0, hot: Array.from({ length: HOT_CUES }, () => null), memory: [] };
}
