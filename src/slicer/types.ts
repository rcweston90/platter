/**
 * The slicer: chop your own audio into slices and arrange them on a beat
 * grid, with drum lanes from the sampler's library. Everything here is
 * plain data (saved to IndexedDB as is); the audio itself is held in memory
 * by the studio (studio.ts) and, for files you open in the slicer, saved in
 * this browser too. Nothing is uploaded.
 *
 * Units: positions on the timeline are in beats (quarter notes) from the
 * start of the song; positions inside a source are in seconds.
 */
import type { StemName } from '../engine/stems';

/** Audio that can be read like an AudioBuffer (AudioBuffer itself, or plain
 *  channel arrays in tests). */
export interface PcmLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Where a source's audio comes from. */
export type SourceOrigin =
  /** A track in the crate (a file, a linked folder file, a demo, an Audius track). */
  | { kind: 'track'; trackId: string }
  /** A file opened in the slicer, kept in this browser (kv "slicer-file:<fileId>"). */
  | { kind: 'file'; fileId: string }
  /** A sound from the sampler's library (built-in, CC0 or yours). */
  | { kind: 'sound'; soundId: string };

/** One piece of audio in the project, with its slice points. */
export interface Source {
  id: string;
  origin: SourceOrigin;
  /** One part of the audio (split with the stems model), or the whole mix. */
  stem: StemName | null;
  name: string;
  /** Seconds; 0 until the audio has been read once. */
  duration: number;
  /** Tempo of the source, if known (crate analysis, or detected here). */
  bpm: number | null;
  /** A beat of the source falls here (seconds): the grid is gridOffset + n·60/bpm. */
  gridOffset: number;
  /** Camelot key, if known. */
  key: string | null;
  /**
   * Slice points, in seconds, sorted, always starting with 0. Slice i runs
   * from slices[i] to slices[i + 1] (or the end of the source).
   */
  slices: number[];
  /** Index into SLICE_COLORS: the source's clips wear it on the timeline. */
  color: number;
}

export type LaneKind = 'audio' | 'drum';

export interface Lane {
  id: string;
  name: string;
  kind: LaneKind;
  /** Drum lanes: the sampler sound a click on the lane places. */
  sound: string | null;
  /** CSS colour for the lane's clips when they don't come from a source with
   *  its own colour (drum lanes: the sound's category colour). */
  color: string;
  /** 0–1.5, 1 = unity. */
  gain: number;
  /** −1 … 1. */
  pan: number;
  mute: boolean;
  solo: boolean;
}

/** A piece of a source placed on a lane. */
export interface Clip {
  id: string;
  laneId: string;
  sourceId: string;
  /** Where it starts on the timeline, in beats. */
  at: number;
  /** The part of the source it plays, in seconds (start < end). */
  start: number;
  end: number;
  /** 0–2, 1 = as recorded. */
  gain: number;
  /** Repitch in semitones (speed and pitch together, like a sampler), −24 … +24. */
  semitones: number;
  /** Follow the song tempo: when the source's BPM is known, play it at
   *  song BPM ÷ source BPM (repitched, the classic chop). */
  sync: boolean;
  reverse: boolean;
  /** Fades in seconds of source audio. */
  fadeIn: number;
  fadeOut: number;
  /** Optional label, otherwise the source's name and slice number. */
  name?: string;
}

export interface LoopRange {
  on: boolean;
  /** Beats. */
  start: number;
  end: number;
}

/** Grid resolution in beats: 1/16 note = 0.25 beat. 0 = no snapping. */
export type Snap = 0 | 0.0625 | 0.125 | 0.25 | 0.5 | 1 | 4;

export interface Project {
  v: 1;
  id: string;
  name: string;
  bpm: number;
  /** Beats per bar (4 for 4/4). */
  meter: number;
  /** Song length in bars (the timeline shows at least this much). */
  bars: number;
  /** Swing for drum lanes, 50 (straight) … 75. */
  swing: number;
  sources: Source[];
  lanes: Lane[];
  clips: Clip[];
  loop: LoopRange;
  snap: Snap;
  /** Master level for the slicer's output, 0–1 (0.8 = 0 dB). */
  level: number;
  createdAt: number;
  updatedAt: number;
}

/** What the project list shows. */
export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  clips: number;
}

/** Colours for sources, in order of use (the reference look: orange first). */
export const SLICE_COLORS = ['#ff8a2a', '#ffc23d', '#c38bff', '#5ec4ff', '#ff6b86', '#45d88c', '#f78fd2', '#9ad0ff'];

/** Waveform summary for drawing at any zoom: min/max per `binSize` samples. */
export interface Peaks {
  sampleRate: number;
  /** Samples per bin. */
  binSize: number;
  /** Bins (length = ceil(length / binSize)), in −1 … 1, channels mixed. */
  min: Float32Array;
  max: Float32Array;
}

/** How auto-slice cuts a source. */
export type AutoSlice =
  /** On transients (drum hits, plucks, syllables); sensitivity 0–1. */
  | { mode: 'transients'; sensitivity: number; minGap: number }
  /** On the beat grid, every `beats` beats (0.25 = sixteenths). */
  | { mode: 'grid'; beats: number }
  /** N equal slices. */
  | { mode: 'equal'; count: number };
