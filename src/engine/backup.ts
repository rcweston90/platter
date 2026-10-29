import { camelot, parseKeyName } from './key';
import { HOT_CUES, type TrackCues, type TrackRecord } from './types';

/**
 * Getting your work in and out of Platter.
 *
 * - A Platter backup (JSON): every track's tempo, grid, key and cue points,
 *   plus settings and MIDI mappings — not the audio, which stays your files.
 *   Import it on another browser after adding the same files, and the cues
 *   come back.
 * - Rekordbox XML (File → Export Collection in xml format): tempo, first
 *   beat, key, memory cue and hot cues A–D, matched to crate tracks by file
 *   name.
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
  link?: string;
}

export interface Backup {
  app: 'platter';
  version: 1;
  exportedAt: string;
  tracks: BackupTrack[];
  settings: unknown;
  midi: unknown;
}

export function makeBackup(tracks: TrackRecord[], settings: unknown, midi: unknown): Backup {
  return {
    app: 'platter',
    version: 1,
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
      cues: t.cues,
      ...(t.demo ? { demo: t.demo } : {}),
      ...(t.audius ? { audius: t.audius, link: t.link } : {}),
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
    const hot: (number | null)[] = Array.from({ length: HOT_CUES }, () => null);
    let main: number | null = null;
    for (const mark of t.querySelectorAll('POSITION_MARK')) {
      const num = Number(mark.getAttribute('Num'));
      const start = Number(mark.getAttribute('Start'));
      if (!Number.isFinite(start)) continue;
      if (num === -1 && main === null) main = start;
      else if (num >= 0 && num < HOT_CUES) hot[num] = start;
    }
    const bpm = Number(tempo?.getAttribute('Bpm') ?? attr('AverageBpm'));
    const inizio = Number(tempo?.getAttribute('Inizio'));
    return {
      title: attr('Name') ?? file,
      artist: attr('Artist') ?? '',
      fileName: file,
      duration: Number(attr('TotalTime')) || null,
      bpm: bpm > 0 ? bpm : null,
      gridOffset: Number.isFinite(inizio) ? inizio : null,
      key: parsedKey ? camelot(parsedKey) : null,
      cues: main !== null || hot.some((h) => h !== null) ? { main: main ?? 0, hot } : null,
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
    cues: t.cues,
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
