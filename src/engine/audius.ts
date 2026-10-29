/**
 * Audius — an open, artist-run music platform whose API is free and needs no
 * key (https://docs.audius.org). Search and trending lists come from its REST
 * API; audio is its MP3 stream, decoded like any other file. Tracks keep a
 * link back to Audius, as the platform asks.
 *
 * Needs ordinary network access: sandboxed hosts (such as a claude.ai
 * artifact) block it, and the calls reject.
 */

const API = 'https://api.audius.co/v1';
const APP_NAME = 'platter';

export interface AudiusTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  artwork: string | null;
  genre: string;
  link: string;
}

interface ApiTrack {
  id: string;
  title: string;
  duration: number;
  genre?: string;
  permalink?: string;
  is_streamable?: boolean;
  artwork?: Record<string, string> | null;
  user?: { name?: string; handle?: string };
}

async function get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<AudiusTrack[]> {
  const q = new URLSearchParams({ ...params, app_name: APP_NAME });
  const res = await fetch(`${API}${path}?${q}`, { signal });
  if (!res.ok) throw new Error(`Audius answered ${res.status}`);
  const body = (await res.json()) as { data?: ApiTrack[] };
  return (body.data ?? [])
    .filter((t) => t.is_streamable !== false)
    .map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.user?.name || t.user?.handle || '',
      duration: t.duration,
      artwork: t.artwork?.['480x480'] ?? t.artwork?.['150x150'] ?? null,
      genre: t.genre ?? '',
      link: t.permalink ? `https://audius.co${t.permalink}` : 'https://audius.co',
    }));
}

export function searchAudius(query: string, signal?: AbortSignal) {
  return get('/tracks/search', { query }, signal);
}

/** This week's trending tracks in a genre (Audius's genre names, e.g. "Electronic"). */
export function trendingAudius(genre: string, signal?: AbortSignal) {
  return get('/tracks/trending', { genre, time: 'week' }, signal);
}

export async function fetchAudiusAudio(id: string): Promise<Blob> {
  const res = await fetch(`${API}/tracks/${encodeURIComponent(id)}/stream?app_name=${APP_NAME}`);
  if (!res.ok) throw new Error(`Audius stream answered ${res.status}`);
  return res.blob();
}

export async function fetchArtwork(url: string | null): Promise<Blob | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}
