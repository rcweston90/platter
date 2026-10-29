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
  peaks: WavePeaks | null;
  art: Blob | null;
  /** The audio file. Absent for demo tracks, which are synthesised on load. */
  blob: Blob | null;
  /** Id of a built-in demo track (see demo.ts). */
  demo?: string;
  cues: TrackCues;
  addedAt: number;
  status: 'analysing' | 'ready' | 'error';
  error?: string;
}

export const HOT_CUES = 4;

export function emptyCues(): TrackCues {
  return { main: 0, hot: Array.from({ length: HOT_CUES }, () => null) };
}
