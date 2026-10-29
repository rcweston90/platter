/** Waveform summary: per-band peak envelopes, `rate` bins per second, 0–255. */
export interface WavePeaks {
  rate: number;
  low: Uint8Array;
  mid: Uint8Array;
  high: Uint8Array;
}

/** Cue points saved with a track, in seconds. */
export interface TrackCues {
  main: number;
  hot: (number | null)[];
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
  /** Where the track lives online (an Audius page), for attribution. */
  link?: string;
  cues: TrackCues;
  addedAt: number;
  status: 'analysing' | 'ready' | 'error';
  error?: string;
}

export const HOT_CUES = 4;

export function emptyCues(): TrackCues {
  return { main: 0, hot: Array.from({ length: HOT_CUES }, () => null) };
}
