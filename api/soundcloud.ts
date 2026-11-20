/**
 * SoundCloud's half of Platter that can't live in the browser: a Vercel
 * Function holding the app's client secret for the OAuth token exchange, and
 * a thin, allow-listed relay to SoundCloud's API and media hosts.
 *
 * Environment (Vercel → Settings → Environment Variables):
 *   SOUNDCLOUD_CLIENT_ID      the app's Client ID (public)
 *   SOUNDCLOUD_CLIENT_SECRET  the app's Client Secret (never sent to the page)
 *
 * The refresh token lives in an HttpOnly cookie scoped to this function, so
 * page script never sees it; the page holds only the short-lived access token.
 *
 *   GET  /api/soundcloud?op=status         { configured, clientId }
 *   POST /api/soundcloud?op=token          { code, verifier, redirectUri } → access token
 *   POST /api/soundcloud?op=refresh        (cookie) → access token
 *   POST /api/soundcloud?op=logout         clears the cookie
 *   GET  /api/soundcloud?op=api&path=…     an API GET, Authorization passed through
 *   GET  /api/soundcloud?op=stream&urn=…   where a track's audio is: { kind, url }
 *   GET  /api/soundcloud?op=relay&url=…    media bytes, for hosts the page can't fetch
 */

declare const process: { env: Record<string, string | undefined> };

const AUTH = 'https://secure.soundcloud.com';
const API = 'https://api.soundcloud.com';
const COOKIE = 'platter_sc_rt';
const COOKIE_PATH = '/api/soundcloud';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const fail = (status: number, error: string, headers: Record<string, string> = {}) => json({ error }, status, headers);

function creds() {
  const id = process.env.SOUNDCLOUD_CLIENT_ID;
  const secret = process.env.SOUNDCLOUD_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setRefreshCookie(token: string | null) {
  const base = `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax`;
  return token ? `${base}; Max-Age=${60 * 60 * 24 * 365}` : `${base}; Max-Age=0`;
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Posts to SoundCloud's token endpoint; the access token goes to the page, the refresh token to the cookie. */
async function exchange(params: Record<string, string>, clearOnFailure = false) {
  const res = await fetch(`${AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json; charset=utf-8' },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as TokenAnswer;
  if (!res.ok || !body.access_token) {
    const status = res.status === 400 || res.status === 401 ? 401 : 502;
    // A refresh token SoundCloud rejects is spent; drop it. A network hiccup (502) keeps it.
    const headers: Record<string, string> = clearOnFailure && status === 401 ? { 'set-cookie': setRefreshCookie(null) } : {};
    return fail(status, body.error_description || body.error || 'SoundCloud refused the sign-in.', headers);
  }
  return json(
    { accessToken: body.access_token, expiresIn: body.expires_in ?? 3600 },
    200,
    body.refresh_token ? { 'set-cookie': setRefreshCookie(body.refresh_token) } : {},
  );
}

/** An API URL on api.soundcloud.com, from a path ("/me/likes/tracks?…") or a next_href. */
function apiUrl(raw: string | null) {
  if (!raw) return null;
  try {
    const u = raw.startsWith('/') ? new URL(raw, API) : new URL(raw);
    return u.origin === API ? u : null;
  } catch {
    return null;
  }
}

/** Hosts SoundCloud serves audio from. Anything else is refused: this is not an open proxy. */
function mediaUrl(raw: string | null) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const h = u.hostname;
    const ok = u.protocol === 'https:' && (h.endsWith('.sndcdn.com') || h.endsWith('.soundcloud.cloud') || h === 'api.soundcloud.com');
    return ok ? u : null;
  } catch {
    return null;
  }
}

const authHeader = (req: Request) => {
  const a = req.headers.get('authorization') ?? '';
  const token = a.replace(/^(OAuth|Bearer)\s+/i, '').trim();
  return token ? `OAuth ${token}` : null;
};

/** Follows SoundCloud's authenticated redirect to the signed media URL, without downloading it. */
async function resolveMedia(url: string, auth: string) {
  const res = await fetch(url, { headers: { authorization: auth }, redirect: 'manual' });
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) return new URL(loc, url).toString();
  if (res.ok) return url;
  throw new Error(String(res.status));
}

interface Streams {
  http_mp3_128_url?: string;
  hls_mp3_128_url?: string;
  hls_aac_160_url?: string;
}

async function stream(req: Request, urn: string) {
  const auth = authHeader(req);
  if (!auth) return fail(401, 'Not signed in to SoundCloud.');
  if (!/^soundcloud:tracks:\d+$|^\d+$/.test(urn)) return fail(400, 'Not a track.');
  const res = await fetch(`${API}/tracks/${encodeURIComponent(urn)}/streams`, {
    headers: { authorization: auth, accept: 'application/json; charset=utf-8' },
  });
  if (!res.ok) return fail(res.status, `SoundCloud answered ${res.status}.`);
  const s = (await res.json()) as Streams;
  // Full streams only: a preview is a 30-second clip, not the track.
  const options: [string | undefined, 'mp3' | 'hls'][] = [
    [s.http_mp3_128_url, 'mp3'],
    [s.hls_mp3_128_url, 'hls'],
    [s.hls_aac_160_url, 'hls'],
  ];
  for (const [url, kind] of options) {
    if (!url || !mediaUrl(url)) continue;
    try {
      return json({ kind, url: await resolveMedia(url, auth) });
    } catch {
      // Try the next format.
    }
  }
  return fail(404, 'SoundCloud has no full stream of this track for apps.');
}

async function relay(req: Request, raw: string | null) {
  const u = mediaUrl(raw);
  if (!u) return fail(400, 'Not a SoundCloud media address.');
  const auth = authHeader(req);
  if (!auth) return fail(401, 'Not signed in to SoundCloud.');
  const res = await fetch(u, { headers: u.hostname === 'api.soundcloud.com' ? { authorization: auth } : {} });
  if (!res.ok || !res.body) return fail(res.status || 502, `SoundCloud answered ${res.status}.`);
  return new Response(res.body, {
    status: 200,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' },
  });
}

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const op = q.get('op');
  const c = creds();
  if (op === 'status') return json({ configured: !!c, clientId: c?.id ?? null });
  if (!c) return fail(503, 'SoundCloud isn’t set up on this site.');

  if (op === 'api') {
    const u = apiUrl(q.get('path'));
    const auth = authHeader(req);
    if (!u) return fail(400, 'Not a SoundCloud API address.');
    if (!auth) return fail(401, 'Not signed in to SoundCloud.');
    const res = await fetch(u, { headers: { authorization: auth, accept: 'application/json; charset=utf-8' } });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (op === 'stream') return stream(req, q.get('urn') ?? '');
  if (op === 'relay') return relay(req, q.get('url'));
  return fail(404, 'Unknown request.');
}

export async function POST(req: Request): Promise<Response> {
  const op = new URL(req.url).searchParams.get('op');
  const c = creds();
  if (!c) return fail(503, 'SoundCloud isn’t set up on this site.');

  if (op === 'token') {
    const body = (await req.json().catch(() => ({}))) as { code?: string; verifier?: string; redirectUri?: string };
    if (!body.code || !body.verifier || !body.redirectUri) return fail(400, 'Missing sign-in details.');
    // The redirect must be this site's own callback page.
    const here = new URL(req.url);
    const back = new URL(body.redirectUri);
    if (back.host !== here.host || back.pathname !== '/soundcloud-callback') return fail(400, 'Unexpected redirect address.');
    return exchange({
      grant_type: 'authorization_code',
      client_id: c.id,
      client_secret: c.secret,
      redirect_uri: back.toString(),
      code_verifier: body.verifier,
      code: body.code,
    });
  }

  if (op === 'refresh') {
    const rt = readCookie(req, COOKIE);
    if (!rt) return fail(401, 'Not signed in to SoundCloud.');
    return exchange({ grant_type: 'refresh_token', client_id: c.id, client_secret: c.secret, refresh_token: rt }, true);
  }

  if (op === 'logout') {
    const auth = authHeader(req);
    if (auth) {
      // Best effort: end the session on SoundCloud's side too.
      await fetch(`${AUTH}/sign-out`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: auth.slice('OAuth '.length) }),
      }).catch(() => {});
    }
    return json({ ok: true }, 200, { 'set-cookie': setRefreshCookie(null) });
  }

  return fail(404, 'Unknown request.');
}
