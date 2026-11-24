import { defaultCueColor, nearestCueColor, normaliseCues, tidyMemory } from './cues';
import { LOOP_BEATS } from './deck';
import { camelot, parseKeyName } from './key';
import { HOT_BANK_SIZE, HOT_CUES, type HotCue, type TrackCues, type TrackRecord } from './types';

/**
 * Getting your work in and out of Platter.
 *
 * - A Platter backup (JSON): every track's tempo, grid, key and cue points,
 *   plus settings and MIDI mappings — not the audio, which stays your files.
 *   Import it on another browser after adding the same files, and the cues
 *   come back.
 * - Rekordbox XML (File → Export Collection in xml format): tempo, first
 *   beat, key, memory cues (the first is the cue point) and hot cues and
 *   hot loops A–H with their colours, matched to crate tracks by file name.
 *
 * Backups are version 2 since hot cue banks: each hot cue is an object
 * ({ t, color, loop? }) and there are memory cues. Version 1 backups (four
 * hot cues as plain numbers) still import: normaliseCues reads both.
 */

export interface BackupTrack {
  id: string;
  title: string;
  artist: string;
  fileName: string;
  duration: number;
  bpm: number | null;
  gridOffset: number;
  key: string | null;
  cues: TrackCues;
  demo?: string;
  audius?: string;
  soundcloud?: string;
  link?: string;
}

export interface Backup {
  app: 'platter';
  /** 1: hot cues as four plain numbers. 2: hot cue objects, banks, memory cues. */
  version: 1 | 2;
  exportedAt: string;
  tracks: BackupTrack[];
  settings: unknown;
  midi: unknown;
}

export function makeBackup(tracks: TrackRecord[], settings: unknown, midi: unknown): Backup {
  return {
    app: 'platter',
    version: 2,
    exportedAt: new Date().toISOString(),
    tracks: tracks.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      fileName: t.fileName,
      duration: t.duration,
      bpm: t.bpm,
      gridOffset: t.gridOffset,
      key: t.key,
      cues: normaliseCues(t.cues),
      ...(t.demo ? { demo: t.demo } : {}),
      ...(t.audius ? { audius: t.audius, link: t.link } : {}),
      ...(t.soundcloud ? { soundcloud: t.soundcloud, link: t.link } : {}),
    })),
    settings,
    midi,
  };
}

export function parseBackup(text: string): Backup {
  const data = JSON.parse(text) as Partial<Backup>;
  if (data.app !== 'platter' || !Array.isArray(data.tracks)) throw new Error('That isn’t a Platter backup.');
  return data as Backup;
}

/** What an imported entry knows about a track, ready to match and apply. */
export interface ImportedTrack {
  title: string;
  artist: string;
  /** File name without folders, for matching. */
  fileName: string;
  duration: number | null;
  bpm: number | null;
  gridOffset: number | null;
  key: string | null;
  cues: TrackCues | null;
}

const base = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The loop size nearest `seconds` at `bpm` (4 beats when the tempo is unknown). */
function loopBeats(seconds: number, bpm: number): number {
  if (!(bpm > 0)) return 4;
  const beats = (seconds * bpm) / 60;
  return LOOP_BEATS.reduce((a, b) => (Math.abs(Math.log2(b / beats)) < Math.abs(Math.log2(a / beats)) ? b : a));
}

/** Parses a Rekordbox collection export. */
export function parseRekordboxXml(text: string): ImportedTrack[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror') || !doc.querySelector('DJ_PLAYLISTS')) {
    throw new Error('That isn’t a Rekordbox XML export.');
  }
  return [...doc.querySelectorAll('COLLECTION > TRACK')].map((t) => {
    const attr = (name: string) => t.getAttribute(name);
    const location = attr('Location') ?? '';
    let file = '';
    try {
      file = base(decodeURIComponent(location.replace(/^file:\/\/localhost/, '')));
    } catch {
      file = base(location);
    }
    const tempo = t.querySelector('TEMPO');
    const tonality = attr('Tonality');
    const parsedKey = tonality ? parseKeyName(tonality) : null;
    const bpm = Number(tempo?.getAttribute('Bpm') ?? attr('AverageBpm'));
    const hot: (HotCue | null)[] = Array.from({ length: HOT_CUES }, () => null);
    const memory: number[] = [];
    let main: number | null = null;
    for (const mark of t.querySelectorAll('POSITION_MARK')) {
      const num = Number(mark.getAttribute('Num'));
      const start = Number(mark.getAttribute('Start'));
      if (!Number.isFinite(start) || start < 0) continue;
      const end = Number(mark.getAttribute('End'));
      const isLoop = mark.getAttribute('Type') === '4' && Number.isFinite(end) && end > start;
      if (num === -1) {
        if (main === null) main = start;
        if (!isLoop) memory.push(start);
      } else if (num >= 0 && num < HOT_BANK_SIZE) {
        const rgb = ['Red', 'Green', 'Blue'].map((c) => Number(mark.getAttribute(c)));
        const color = rgb.every(Number.isFinite) ? nearestCueColor(rgb[0], rgb[1], rgb[2]) : defaultCueColor(num);
        hot[num] = isLoop ? { t: start, color, loop: { end, beats: loopBeats(end - start, bpm) } } : { t: start, color };
      }
    }
    const inizio = Number(tempo?.getAttribute('Inizio'));
    return {
      title: attr('Name') ?? file,
      artist: attr('Artist') ?? '',
      fileName: file,
      duration: Number(attr('TotalTime')) || null,
      bpm: bpm > 0 ? bpm : null,
      gridOffset: Number.isFinite(inizio) ? inizio : null,
      key: parsedKey ? camelot(parsedKey) : null,
      cues: main !== null || hot.some((h) => h !== null) ? { main: main ?? 0, hot, memory: tidyMemory(memory) } : null,
    };
  });
}

export function backupToImported(b: Backup): (ImportedTrack & { id: string })[] {
  return b.tracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    fileName: base(t.fileName ?? ''),
    duration: t.duration || null,
    bpm: t.bpm,
    gridOffset: t.gridOffset,
    key: t.key,
    // Version 1 backups keep four plain numbers; read either form.
    cues: t.cues ? normaliseCues(t.cues) : null,
  }));
}

/** Finds the crate track an imported entry describes: same id, else same
 *  file name (and length, when both know it), else same title and artist. */
export function matchTrack(crate: TrackRecord[], t: ImportedTrack & { id?: string }): TrackRecord | null {
  if (t.id) {
    const byId = crate.find((c) => c.id === t.id);
    if (byId) return byId;
  }
  const name = t.fileName.toLowerCase();
  const sameLength = (c: TrackRecord) => !t.duration || !c.duration || Math.abs(c.duration - t.duration) < 2;
  return (
    (name && crate.find((c) => c.fileName.toLowerCase() === name && sameLength(c))) ||
    crate.find(
      (c) =>
        c.title.toLowerCase() === t.title.toLowerCase() &&
        c.artist.toLowerCase() === t.artist.toLowerCase() &&
        sameLength(c),
    ) ||
    null
  );
}
