import { createStore } from './store';

/**
 * SoundCloud: sign in, browse your likes, playlists and uploads, and stream
 * tracks onto the decks.
 *
 * What may go on a deck follows SoundCloud's API Terms of Use
 * (https://developers.soundcloud.com/docs/api/terms-of-use):
 *
 * - A DJ deck changes the audio (pitch, tempo, scratching, mixing), and the
 *   terms allow that only where the uploader has expressly agreed — your own
 *   uploads, or a Creative Commons license that permits derivative works.
 *   Everything else is listed with a link to play it on SoundCloud.
 * - Apps may not save SoundCloud audio, even for tracks set as downloadable.
 *   The crate keeps the track's id, its analysis and your cues; the audio is
 *   streamed again each time it loads and lives only in memory.
 * - Each track credits its uploader and links back to its SoundCloud page.
 *
 * The OAuth exchange and the refresh token live in a Vercel Function
 * (api/soundcloud.ts), which holds the client secret. So this works on
 * Platter's Vercel site, not on a static host such as GitHub Pages.
 */

const ENDPOINT = '/api/soundcloud';
const AUTHORIZE = 'https://secure.soundcloud.com/authorize';
const CALLBACK_PATH = '/soundcloud-callback';
const K_TOKEN = 'platter.sc.token';
const K_PKCE = 'platter.sc.pkce';
const K_USER = 'platter.sc.user';

/** Licenses that let anyone adapt the work — what a deck does to it. */
const REMIXABLE = new Set(['cc-by', 'cc-by-sa', 'cc-by-nc', 'cc-by-nc-sa', 'no-rights-reserved']);

const LICENSE_NAMES: Record<string, string> = {
  'all-rights-reserved': 'All rights reserved',
  'no-rights-reserved': 'No rights reserved',
  'cc-by': 'CC BY',
  'cc-by-sa': 'CC BY-SA',
  'cc-by-nc': 'CC BY-NC',
  'cc-by-nc-sa': 'CC BY-NC-SA',
  'cc-by-nd': 'CC BY-ND',
  'cc-by-nc-nd': 'CC BY-NC-ND',
};

export interface ScUser {
  id: number;
  name: string;
  link: string;
}

export interface ScTrack {
  /** SoundCloud's track URN ("soundcloud:tracks:123"). */
  urn: string;
  title: string;
  artist: string;
  /** Seconds. */
  duration: number;
  artwork: string | null;
  genre: string;
  license: string;
  licenseName: string;
  link: string;
  /** You uploaded it. */
  mine: boolean;
  /** May go on a deck: yours, or licensed for derivative works, and fully streamable. */
  mixable: boolean;
  /** Why not, when it can't. */
  reason: string | null;
}

export interface ScPlaylist {
  urn: string;
  title: string;
  count: number;
  artwork: string | null;
  link: string;
}

export interface ScPage<T> {
  items: T[];
  next: string | null;
}

export type ScState = 'checking' | 'unavailable' | 'signed-out' | 'signing-in' | 'signed-in';

export interface ScAuth {
  state: ScState;
  user: ScUser | null;
  error: string | null;
}

/** A failure worth showing as it is (sign-in needed, track not streamable…). */
export class SoundCloudError extends Error {
  override name = 'SoundCloudError';
}

const storage = (s: 'local' | 'session') => {
  try {
    return s === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
};
const readJson = <T>(s: 'local' | 'session', k: string): T | null => {
  try {
    const raw = storage(s)?.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const writeJson = (s: 'local' | 'session', k: string, v: unknown) => {
  try {
    if (v === null) storage(s)?.removeItem(k);
    else storage(s)?.setItem(k, JSON.stringify(v));
  } catch {
    // Private mode: fine, it's only a convenience.
  }
};

export const soundcloud = createStore<ScAuth>({ state: 'checking', user: readJson<ScUser>('local', K_USER), error: null });

// ── Tokens ──────────────────────────────────────────────────────────────────

let token = readJson<{ value: string; expires: number }>('session', K_TOKEN);
let refreshing: Promise<string> | null = null;

function keepToken(value: string, expiresIn: number) {
  token = { value, expires: Date.now() + Math.max(60, expiresIn - 60) * 1000 };
  writeJson('session', K_TOKEN, token);
}

function signedOut(error: string | null = null) {
  token = null;
  writeJson('session', K_TOKEN, null);
  writeJson('local', K_USER, null);
  soundcloud.set({ state: 'signed-out', user: null, error });
}

async function refresh(): Promise<string> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${ENDPOINT}?op=refresh`, { method: 'POST', credentials: 'same-origin' });
      if (res.status === 401) {
        signedOut();
        throw new SoundCloudError('Sign in to SoundCloud (in the SoundCloud tab) to play this track.');
      }
      if (!res.ok) throw new SoundCloudError('Couldn’t reach SoundCloud. Check your connection and try again.');
      const body = (await res.json()) as { accessToken: string; expiresIn: number };
      keepToken(body.accessToken, body.expiresIn);
      return body.accessToken;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function accessToken() {
  if (token && token.expires > Date.now()) return token.value;
  return refresh();
}

/** A call to Platter's SoundCloud function, signed in, retried once with a fresh token. */
async function call(params: Record<string, string>, init: RequestInit = {}): Promise<Response> {
  const url = `${ENDPOINT}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const t = await accessToken();
    const res = await fetch(url, { ...init, headers: { ...init.headers, authorization: `OAuth ${t}` } });
    if (res.status !== 401 || attempt > 0) return res;
    token = null;
  }
}

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await call({ op: 'api', path }, { signal });
  if (!res.ok) throw new SoundCloudError(`SoundCloud answered ${res.status}.`);
  return (await res.json()) as T;
}

// ── Signing in ──────────────────────────────────────────────────────────────

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const randomString = (n = 48) => base64url(crypto.getRandomValues(new Uint8Array(n)));

const redirectUri = () => `${location.origin}${CALLBACK_PATH}`;

/** Is the SoundCloud function deployed and configured here? Settles 'checking'. */
export async function checkSoundCloud() {
  if (soundcloud.get().state !== 'checking') return;
  try {
    const res = await fetch(`${ENDPOINT}?op=status`);
    const body = res.ok && (res.headers.get('content-type') ?? '').includes('json') ? ((await res.json()) as { configured?: boolean }) : null;
    if (!body?.configured) {
      soundcloud.set({ state: 'unavailable' });
      return;
    }
  } catch {
    soundcloud.set({ state: 'unavailable' });
    return;
  }
  const user = soundcloud.get().user;
  if (!user) {
    soundcloud.set({ state: 'signed-out' });
    return;
  }
  // Remembered from an earlier visit: confirm the cookie still works.
  try {
    await accessToken();
    soundcloud.set({ state: 'signed-in' });
  } catch {
    if (soundcloud.get().state === 'checking') soundcloud.set({ state: 'signed-out' });
  }
}

/** Off to SoundCloud's sign-in page; it comes back to /soundcloud-callback. */
export async function signInToSoundCloud() {
  soundcloud.set({ state: 'signing-in', error: null });
  try {
    const res = await fetch(`${ENDPOINT}?op=status`);
    const { clientId } = (await res.json()) as { clientId: string | null };
    if (!clientId) throw new Error('not configured');
    const verifier = randomString();
    const state = randomString(24);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    writeJson('session', K_PKCE, { verifier, state });
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      code_challenge: base64url(digest),
      code_challenge_method: 'S256',
      state,
    });
    location.assign(`${AUTHORIZE}?${q}`);
  } catch {
    soundcloud.set({ state: 'signed-out', error: 'Couldn’t start the SoundCloud sign-in. Try again in a moment.' });
  }
}

/** On the callback page: trade the code for a token, then tidy the address bar. */
export async function finishSoundCloudSignIn() {
  if (location.pathname !== CALLBACK_PATH) return;
  const q = new URLSearchParams(location.search);
  history.replaceState(null, '', '/');
  cameBack = true;
  const pkce = readJson<{ verifier: string; state: string }>('session', K_PKCE);
  writeJson('session', K_PKCE, null);
  const code = q.get('code');
  if (q.get('error') || !code) {
    signedOut(q.get('error') === 'access_denied' ? null : 'SoundCloud didn’t complete the sign-in.');
    return;
  }
  if (!pkce || pkce.state !== q.get('state')) {
    signedOut('That sign-in didn’t start here. Try again.');
    return;
  }
  soundcloud.set({ state: 'signing-in', error: null });
  try {
    const res = await fetch(`${ENDPOINT}?op=token`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier: pkce.verifier, redirectUri: redirectUri() }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { accessToken: string; expiresIn: number };
    keepToken(body.accessToken, body.expiresIn);
    const me = await api<{ id: number; username: string; permalink_url: string }>('/me');
    const user = { id: me.id, name: me.username, link: me.permalink_url };
    writeJson('local', K_USER, user);
    soundcloud.set({ state: 'signed-in', user, error: null });
  } catch {
    signedOut('SoundCloud didn’t complete the sign-in. Try again.');
  }
}

let cameBack = false;

/** Just back from SoundCloud's sign-in page: the library opens on SoundCloud. */
export const cameBackFromSoundCloud = () => cameBack;

export async function signOutOfSoundCloud() {
  const t = token?.value;
  signedOut();
  await fetch(`${ENDPOINT}?op=logout`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: t ? { authorization: `OAuth ${t}` } : {},
  }).catch(() => {});
}

// ── Browsing ────────────────────────────────────────────────────────────────

interface ApiTrack {
  id: number;
  urn?: string;
  title: string;
  duration: number;
  artwork_url?: string | null;
  genre?: string | null;
  license?: string | null;
  permalink_url: string;
  streamable?: boolean;
  access?: 'playable' | 'preview' | 'blocked' | null;
  user?: { id: number; username?: string; avatar_url?: string | null };
}

interface ApiPlaylist {
  id: number;
  urn?: string;
  title: string;
  track_count?: number;
  artwork_url?: string | null;
  permalink_url: string;
}

interface ApiCollection<T> {
  collection?: T[];
  next_href?: string | null;
}

const bigArt = (url: string | null | undefined) => (url ? url.replace('-large.', '-t300x300.') : null);

export function toTrack(t: ApiTrack, meId: number | null): ScTrack {
  const license = t.license ?? 'all-rights-reserved';
  const mine = meId !== null && t.user?.id === meId;
  const full = t.streamable !== false && (t.access ?? 'playable') === 'playable';
  const reason = !full
    ? 'Only a preview is available to apps.'
    : mine || REMIXABLE.has(license)
      ? null
      : 'The artist hasn’t licensed this for remixing, so it plays on SoundCloud only.';
  return {
    urn: t.urn ?? `soundcloud:tracks:${t.id}`,
    title: t.title,
    artist: t.user?.username ?? '',
    duration: t.duration / 1000,
    artwork: bigArt(t.artwork_url ?? t.user?.avatar_url),
    genre: t.genre ?? '',
    license,
    licenseName: LICENSE_NAMES[license] ?? license,
    link: t.permalink_url,
    mine,
    mixable: reason === null,
    reason,
  };
}

const meId = () => soundcloud.get().user?.id ?? null;

async function trackPage(path: string, signal?: AbortSignal): Promise<ScPage<ScTrack>> {
  const body = await api<ApiCollection<ApiTrack> | ApiTrack[]>(path, signal);
  const list = Array.isArray(body) ? body : (body.collection ?? []);
  return {
    items: list.filter((t) => t && (t as { kind?: string }).kind !== 'playlist' && t.title).map((t) => toTrack(t, meId())),
    next: Array.isArray(body) ? null : (body.next_href ?? null),
  };
}

const PAGE = 'limit=50&linked_partitioning=true';

export const likedTracks = (signal?: AbortSignal) => trackPage(`/me/likes/tracks?${PAGE}`, signal);
export const myUploads = (signal?: AbortSignal) => trackPage(`/me/tracks?${PAGE}`, signal);
export const searchTracks = (q: string, signal?: AbortSignal) => trackPage(`/tracks?q=${encodeURIComponent(q)}&${PAGE}`, signal);
export const playlistTracks = (urn: string, signal?: AbortSignal) => trackPage(`/playlists/${encodeURIComponent(urn)}/tracks?${PAGE}`, signal);
/** The next page of whichever list `next` came from. */
export const moreTracks = (next: string, signal?: AbortSignal) => trackPage(next, signal);

/** Your playlists (and ones you liked); pass `next` for the following page. */
export async function myPlaylists(signal?: AbortSignal, next?: string): Promise<ScPage<ScPlaylist>> {
  const body = await api<ApiCollection<ApiPlaylist> | ApiPlaylist[]>(next ?? `/me/playlists?show_tracks=false&${PAGE}`, signal);
  const list = Array.isArray(body) ? body : (body.collection ?? []);
  return {
    items: list.map((p) => ({
      urn: p.urn ?? `soundcloud:playlists:${p.id}`,
      title: p.title,
      count: p.track_count ?? 0,
      artwork: bigArt(p.artwork_url),
      link: p.permalink_url,
    })),
    next: Array.isArray(body) ? null : (body.next_href ?? null),
  };
}

// ── Audio ───────────────────────────────────────────────────────────────────

/** Once a direct media fetch has been refused (no CORS), go through the relay. */
let relayOnly = false;

async function media(url: string): Promise<Response> {
  if (!relayOnly) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      relayOnly = true;
    }
  }
  const res = await call({ op: 'relay', url });
  if (!res.ok) throw new SoundCloudError('SoundCloud wouldn’t stream this track.');
  return res;
}

/** HLS: the playlist's segments (and init section) joined into one file the decoder reads. */
async function hlsBlob(playlistUrl: string): Promise<Blob> {
  const text = await (await media(playlistUrl)).text();
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(l))) {
    throw new SoundCloudError('This track is encrypted, so it can only play on SoundCloud.');
  }
  const parts: string[] = [];
  const map = lines.find((l) => l.startsWith('#EXT-X-MAP'))?.match(/URI="([^"]+)"/)?.[1];
  if (map) parts.push(new URL(map, playlistUrl).toString());
  for (const l of lines) if (l && !l.startsWith('#')) parts.push(new URL(l, playlistUrl).toString());
  if (!parts.length) throw new SoundCloudError('SoundCloud sent an empty stream.');
  const blobs: Blob[] = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      blobs[i] = await (await media(parts[i])).blob();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return new Blob(blobs, { type: map ? 'audio/mp4' : 'audio/mpeg' });
}

/** The track's audio, streamed now, held in memory only — never stored. */
export async function fetchSoundCloudAudio(urn: string): Promise<Blob> {
  const res = await call({ op: 'stream', urn });
  if (res.status === 404) throw new SoundCloudError('SoundCloud has no full stream of this track for apps.');
  if (!res.ok) throw new SoundCloudError('Couldn’t reach SoundCloud. Check your connection and try again.');
  const where = (await res.json()) as { kind: 'mp3' | 'hls'; url: string };
  return where.kind === 'hls' ? hlsBlob(where.url) : (await media(where.url)).blob();
}
