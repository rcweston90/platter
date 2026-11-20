/**
 * The library record: one entry per track, metadata only — never audio.
 *
 * The same shape is written by the browser (Mashups tab → "Save library
 * file") and by the command-line scanner (`npm run library -- <folder>`), and
 * is documented as JSON Schema in library/track.schema.json. Bump
 * LIBRARY_SCHEMA_VERSION when a field changes meaning; adding an optional
 * field doesn't need a bump.
 */

export const LIBRARY_SCHEMA_VERSION = 1;
/** Bumped when the analysis would give different numbers for the same audio,
 *  so stale records are re-analysed. */
export const ANALYZER_VERSION = 'platter-analyzer-1';

/** Decoded audio, independent of Web Audio so the analysis also runs in Node. */
export interface Pcm {
  sampleRate: number;
  /** One Float32Array per channel, all the same length, in −1…1. */
  channels: Float32Array[];
}

/** What the file's own tags say (ID3 for MP3/AIFF/WAV, Vorbis comments for
 *  FLAC/Ogg/Opus, iTunes atoms for M4A — music-metadata reads them all). */
export interface TrackTags {
  title: string;
  artist: string;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  label: string | null;
  /** A tempo written into the tags (TBPM / BPM), as found. */
  bpm: number | null;
  /** A key written into the tags (TKEY / INITIALKEY), as a Camelot code. */
  key: string | null;
  /** True when the file has embedded cover art (the art itself isn't kept here). */
  hasArt: boolean;
}

/** One tempo reading the estimator considered: the octave family of the winner
 *  is always included (half and double), each with how well it fits. */
export interface TempoCandidate {
  bpm: number;
  /** 0…1, relative to the best candidate. */
  salience: number;
}

export interface TempoEstimate {
  /** The chosen tempo, two decimals. */
  bpm: number;
  /** 0…1: how clearly this tempo beat the next-best that isn't its octave. */
  confidence: number;
  /** Strongest periodicities, best first, including half and double of `bpm`. */
  candidates: TempoCandidate[];
  /** Seconds to the first beat (beat grid = firstBeat + n·60/bpm). */
  firstBeat: number;
  /** Seconds to the first beat that looks like a bar's "one" (4/4 assumed). */
  firstDownbeat: number;
  /** 0…1: how steady the tempo is across the track (1 = machine-steady). */
  stability: number;
}

export interface KeyEstimate {
  /** Camelot code, e.g. "8A". */
  camelot: string;
  /** Musical name, e.g. "Am". */
  name: string;
  /** 0…1: margin of the winning key profile over the runner-up. */
  confidence: number;
}

export interface LoudnessEstimate {
  /** Integrated loudness, ITU-R BS.1770-4 / EBU R128, in LUFS. */
  lufs: number;
  /** Sample peak in dBFS. */
  peakDb: number;
  /** Loudness range (EBU Tech 3342), in LU. */
  lra: number;
}

export interface EnergyEstimate {
  /** 1…10, Mixed-In-Key style: a heuristic from loudness, onset density,
   *  brightness and low end. Compare tracks with it; it isn't a measurement. */
  energy: number;
  /** Detected note/drum onsets per second. */
  onsetRate: number;
  /** Spectral centroid, Hz: how bright the track sounds. */
  brightness: number;
  /** Share of energy below ~150 Hz, 0…1. */
  lowEnd: number;
}

export interface TrackAnalysis {
  analyzer: string;
  /** ISO time. */
  analyzedAt: string;
  duration: number;
  /** The tempo to mix at. */
  bpm: number | null;
  bpmConfidence: number;
  /** Where the tempo came from: the tags (only when they agree with the audio
   *  or the audio was unclear) or the analysis. */
  bpmSource: 'analysis' | 'tag';
  /** Other readings worth trying: typically half and double time. */
  bpmCandidates: TempoCandidate[];
  tempoStability: number;
  firstBeat: number;
  firstDownbeat: number;
  key: string | null;
  keyName: string | null;
  keyConfidence: number;
  keySource: 'analysis' | 'tag';
  lufs: number | null;
  peakDb: number | null;
  lra: number | null;
  energy: number | null;
  onsetRate: number | null;
  brightness: number | null;
  lowEnd: number | null;
}

export type AudioFormat = 'flac' | 'mp3' | 'wav' | 'aiff' | 'm4a' | 'aac' | 'ogg' | 'opus' | 'webm' | 'other';

export interface LibraryTrack {
  /** Stable id: the content fingerprint, so a moved or renamed file keeps its record. */
  id: string;
  /** Path relative to the linked/scanned folder, with "/" separators. */
  path: string;
  fileName: string;
  format: AudioFormat;
  fileSize: number;
  /** File modification time (ms), when known — a cheap "has it changed?" check. */
  modified: number | null;
  /** SHA-256 of the size and the first and last 256 KB, hex. */
  fingerprint: string;
  tags: TrackTags;
  analysis: TrackAnalysis | null;
  /** ISO time the track first entered the library. */
  addedAt: string;
  /** Why analysis failed, if it did. */
  error?: string;
}

export interface LibraryFile {
  $schema?: string;
  schemaVersion: number;
  generator: string;
  /** ISO time. */
  updatedAt: string;
  /** The linked folder's name (just its name — not the full path on disk). */
  root: string | null;
  tracks: LibraryTrack[];
}

/** What a crate track carries from the library analysis (TrackRecord.library). */
export interface TrackLibraryInfo {
  tags: TrackTags;
  analysis: TrackAnalysis | null;
  /** Path inside the linked folder, when the track came from one. */
  path?: string;
  fingerprint?: string;
  fileSize?: number;
  modified?: number | null;
  format?: AudioFormat;
}
