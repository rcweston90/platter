import type { IAudioMetadata } from 'music-metadata';
import { camelot, parseKeyName } from '../engine/key';
import type { AudioFormat, TrackTags } from './types';

/**
 * Tags in one shape, whatever the container. music-metadata (MIT) reads ID3
 * (MP3, AIFF, WAV), Vorbis comments (FLAC, Ogg, Opus) and MP4 atoms (M4A)
 * into `common`; a few DJ-software fields aren't mapped there for every
 * container — notably the key in FLAC, which Rekordbox, Traktor and Mixed In
 * Key write as an INITIALKEY (or KEY) Vorbis comment — so those are read from
 * the native tags too.
 */

const NATIVE_KEY_IDS = ['INITIALKEY', 'KEY', 'TKEY', 'initialkey', '----:com.apple.iTunes:initialkey', 'IKEY'];
const NATIVE_BPM_IDS = ['BPM', 'TBPM', 'TEMPO', 'tmpo', 'bpm'];

function nativeValue(meta: IAudioMetadata, ids: string[]): string | null {
  for (const list of Object.values(meta.native ?? {})) {
    for (const tag of list) {
      if (!ids.includes(tag.id)) continue;
      const v = tag.value as unknown;
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (v && typeof v === 'object' && 'text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text;
    }
  }
  return null;
}

/** "Am", "A minor", "8A", "08A", "1m" (Open Key) … as a Camelot code, or null. */
export function keyFromTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // Camelot with a leading zero ("08A"), as some tools write it.
  const c = /^0?(\d{1,2})\s*([AB])$/i.exec(s);
  if (c) return `${Number(c[1])}${c[2].toUpperCase()}`;
  // Open Key notation (Traktor): 1m = 6A … 1d = 1B, i.e. Camelot = OpenKey + 7.
  const o = /^(\d{1,2})\s*([md])$/i.exec(s);
  if (o) {
    const n = Number(o[1]);
    if (n >= 1 && n <= 12) return `${((n + 6) % 12) + 1}${o[2].toLowerCase() === 'm' ? 'A' : 'B'}`;
  }
  const k = parseKeyName(s);
  return k ? camelot(k) : null;
}

function tagBpm(raw: number | string | null | undefined): number | null {
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : raw;
  return n && Number.isFinite(n) && n >= 40 && n <= 300 ? Math.round(n * 100) / 100 : null;
}

function stripExtension(name: string) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, '');
}

/** "Artist - Title" from a file name, the way most stores name downloads. */
export function namesFromFileName(fileName: string): { artist: string; title: string } {
  const base = stripExtension(fileName.split('/').pop() ?? fileName)
    // Bandcamp: "Artist - Album - 03 Title"; Beatport: "123456_Title_(Original_Mix)"
    .replace(/_/g, ' ')
    .trim();
  const dash = base.split(/\s+[-–]\s+/);
  if (dash.length >= 3 && /^\d{1,2}\s/.test(dash[dash.length - 1])) {
    return { artist: dash[0], title: dash[dash.length - 1].replace(/^\d{1,2}\s+/, '') };
  }
  if (dash.length >= 2) return { artist: dash[0], title: dash.slice(1).join(' - ').replace(/^\d{1,2}\s+/, '') };
  return { artist: '', title: base.replace(/^\d{1,3}\s+/, '') };
}

export function formatOf(fileName: string): AudioFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1].toLowerCase();
  switch (ext) {
    case 'flac':
    case 'mp3':
    case 'wav':
    case 'm4a':
    case 'aac':
    case 'ogg':
    case 'opus':
    case 'webm':
      return ext;
    case 'oga':
      return 'ogg';
    case 'aif':
    case 'aiff':
      return 'aiff';
    default:
      return 'other';
  }
}

/** Normalised tags from music-metadata's result; `fileName` fills the gaps. */
export function normaliseTags(meta: IAudioMetadata | null, fileName: string): TrackTags {
  const fallback = namesFromFileName(fileName);
  const c = meta?.common;
  const year = c?.year ?? (c?.date ? parseInt(c.date, 10) : NaN);
  return {
    title: c?.title?.trim() || fallback.title,
    artist: c?.artist?.trim() || c?.albumartist?.trim() || fallback.artist,
    album: c?.album?.trim() || null,
    albumArtist: c?.albumartist?.trim() || null,
    genre: c?.genre?.map((g) => g.trim()).filter(Boolean).join(', ') || null,
    year: Number.isFinite(year) && year > 1800 && year < 2200 ? year : null,
    label: c?.label?.map((l) => l.trim()).filter(Boolean).join(', ') || null,
    bpm: tagBpm(c?.bpm) ?? (meta ? tagBpm(nativeValue(meta, NATIVE_BPM_IDS)) : null),
    key: keyFromTag(c?.key) ?? (meta ? keyFromTag(nativeValue(meta, NATIVE_KEY_IDS)) : null),
    hasArt: !!c?.picture?.length,
  };
}
