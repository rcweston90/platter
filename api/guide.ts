/// <reference types="node" />
/**
 * The booth guide's server half: a Vercel Function that holds the site's
 * Claude API key and asks Claude on the page's behalf. The page sends the
 * conversation and the booth as it is now; this adds the key, the guide's
 * instructions and tools (api/_guide/prompt.json, generated from the control
 * registry by scripts/guide-prompt.mjs), trims what the page sent and keeps
 * a rate limit, then returns the answer's text and tool calls. The tools run
 * in the page, which checks every call against the registry before it runs.
 *
 * Environment (Vercel → Settings → Environment Variables):
 *   ANTHROPIC_API_KEY   the Claude API key (never sent to the page). Without
 *                       it the guide stays on its offline demo.
 *   GUIDE_MODEL         optional; defaults to claude-haiku-5-5 (for example
 *                       claude-sonnet-5-5 for a stronger, dearer guide).
 *
 *   GET  /api/guide   { configured, model }
 *   POST /api/guide   { messages, booth } → { text, toolCalls, stop }
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export const LIMITS = {
  /** Most the model may write per answer. */
  maxTokens: 600,
  /** Characters kept of each question. */
  maxUserChars: 2000,
  /** Messages of the conversation kept, newest last. */
  maxTurns: 12,
  /** Characters kept of an earlier answer or a tool result. */
  maxResultChars: 2000,
  /** Tool calls kept per earlier answer. */
  maxCallsPerAnswer: 8,
  /** Largest request body read, in bytes. */
  maxBodyBytes: 64_000,
  /** Per visitor (IP address): requests per window. */
  ipMax: 20,
  ipWindowMs: 10 * 60_000,
  /** Per server instance, everyone together: requests per window. */
  globalMax: 300,
  globalWindowMs: 60 * 60_000,
} as const;

/* ── Shapes the page sends (src/guide/model.ts) ───────────────────────────── */

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type GuideMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; result: string };

export interface BoothSnapshot {
  decks: { label: 'A' | 'B'; title: string | null; playing: boolean; bpm: number | null; sync: boolean; fader: number; low: number }[];
  crossfader: number;
  audio: 'idle' | 'starting' | 'running' | 'error';
}

export interface GuideReply {
  text: string;
  toolCalls: ToolCall[];
  stop: string | null;
}

/* ── The guide's instructions and tools ───────────────────────────────────── */

interface GuidePrompt {
  instructions: string;
  tools: Anthropic.Tool[];
}

let prompt: GuidePrompt | null = null;
function guidePrompt(): GuidePrompt {
  prompt ??= JSON.parse(readFileSync(new URL('./_guide/prompt.json', import.meta.url), 'utf8')) as GuidePrompt;
  return prompt;
}

/* ── Trimming what the page sent ──────────────────────────────────────────── */

const cut = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '');
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[a-z_]{1,40}$/;

/**
 * The conversation from the page, checked and cut down: unknown shapes are
 * dropped, each question kept to maxUserChars, only the last maxTurns
 * messages kept, and the kept part starts at a question (so no tool result
 * arrives without the call it answers).
 */
export function trimHistory(raw: unknown): GuideMessage[] {
  const list = Array.isArray(raw) ? raw.slice(-200) : [];
  const clean: GuideMessage[] = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (r.role === 'user' && typeof r.text === 'string' && r.text.trim()) {
      clean.push({ role: 'user', text: cut(r.text, LIMITS.maxUserChars) });
    } else if (r.role === 'assistant') {
      const calls = (Array.isArray(r.toolCalls) ? r.toolCalls : [])
        .filter((c): c is ToolCall => !!c && typeof c === 'object' && ID.test(String(c.id)) && NAME.test(String(c.name)))
        .slice(0, LIMITS.maxCallsPerAnswer)
        .map((c) => ({ id: c.id, name: c.name, args: c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? c.args : {} }));
      clean.push({ role: 'assistant', text: cut(r.text, LIMITS.maxResultChars), toolCalls: calls });
    } else if (r.role === 'tool' && ID.test(String(r.callId))) {
      clean.push({ role: 'tool', callId: String(r.callId), name: cut(r.name, 40), result: cut(r.result, LIMITS.maxResultChars) });
    }
  }
  const kept = clean.slice(-LIMITS.maxTurns);
  const first = kept.findIndex((m) => m.role === 'user');
  return first < 0 ? [] : kept.slice(first);
}

type UserBlock = Anthropic.TextBlockParam | Anthropic.ToolResultBlockParam;
type AssistantBlock = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam;

/**
 * The trimmed conversation in the Messages API's shape: each answer's tool
 * calls as tool_use blocks, and their results first in the next user turn
 * as tool_result blocks. A result whose call isn't there is dropped; a call
 * with no result gets one saying it didn't run, so every call has its result.
 */
export function toApiMessages(history: GuideMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pending: string[] = [];
  let results = new Map<string, Anthropic.ToolResultBlockParam>();

  /** The user turn after an answer: its results in call order, then any question. */
  const closeAnswer = (text?: string) => {
    const blocks: UserBlock[] = pending.map(
      (id) => results.get(id) ?? { type: 'tool_result', tool_use_id: id, content: 'Not run: the app ignored this call.', is_error: true },
    );
    if (text !== undefined) blocks.push({ type: 'text', text });
    pending = [];
    results = new Map();
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === 'user' && Array.isArray(last.content)) (last.content as UserBlock[]).push(...blocks);
    else out.push({ role: 'user', content: blocks });
  };

  for (const m of history) {
    if (m.role === 'user') closeAnswer(m.text);
    else if (m.role === 'tool') {
      if (pending.includes(m.callId) && !results.has(m.callId)) {
        results.set(m.callId, { type: 'tool_result', tool_use_id: m.callId, content: m.result || '(empty)' });
      }
    } else {
      closeAnswer();
      const blocks: AssistantBlock[] = [];
      if (m.text.trim()) blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) {
        if (pending.includes(c.id)) continue;
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
        pending.push(c.id);
      }
      // The API takes no empty turns.
      if (!blocks.length) blocks.push({ type: 'text', text: '(no answer)' });
      out.push({ role: 'assistant', content: blocks });
    }
  }
  closeAnswer();
  // The conversation must end on the user's side: a trailing answer would read as a prefill.
  while (out.length && out[out.length - 1].role === 'assistant') out.pop();
  return out;
}

/* ── The booth, as data for the model ─────────────────────────────────────── */

const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
/** A track title as data: one line, no brackets that could pose as a control id, short. */
const title = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f[\]{}<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : null;

/** The booth state from the page, kept to what it should hold. */
export function sanitizeBooth(raw: unknown): BoothSnapshot {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const decks = Array.isArray(r.decks) ? r.decks : [];
  const audio = ['idle', 'starting', 'running', 'error'].includes(r.audio as string) ? (r.audio as BoothSnapshot['audio']) : 'idle';
  return {
    decks: (['A', 'B'] as const).map((label, i) => {
      const d = (decks[i] && typeof decks[i] === 'object' ? decks[i] : {}) as Record<string, unknown>;
      const bpm = num(d.bpm, 0, 400, 0);
      return {
        label,
        title: title(d.title),
        playing: d.playing === true,
        bpm: bpm > 0 ? Math.round(bpm * 10) / 10 : null,
        sync: d.sync === true,
        fader: num(d.fader, 0, 1, 0.8),
        low: num(d.low, 0, 1, 0.5),
      };
    }),
    crossfader: num(r.crossfader, -1, 1, 0),
    audio,
  };
}

export function boothText(b: BoothSnapshot): string {
  const decks = b.decks.map(
    (d) =>
      `Deck ${d.label}: ${d.title ? `track titled ${JSON.stringify(d.title)}` : 'no track'}, ${d.playing ? 'playing' : 'stopped'}, ${d.bpm ? `${d.bpm} BPM` : 'no tempo'}${d.sync ? ', synced' : ''}; channel fader ${d.fader.toFixed(2)}, low EQ ${d.low.toFixed(2)}.`,
  );
  return [`The booth now (audio ${b.audio}):`, ...decks, `Crossfader ${b.crossfader.toFixed(2)} (−1 deck A, 0 centre, +1 deck B).`].join('\n');
}

/* ── The request to Claude ────────────────────────────────────────────────── */

/** The lightest thinking each model takes: none on Haiku 5.5, none but notes between tools on Sonnet 5.5. */
function thinkingFor(model: string): Anthropic.ThinkingConfigParam | undefined {
  if (model.startsWith('claude-haiku-5')) return { type: 'disabled' };
  if (model.startsWith('claude-sonnet-5-5')) return { type: 'between_tools' };
  return undefined;
}

export function buildRequest(model: string, history: GuideMessage[], booth: BoothSnapshot): Anthropic.MessageCreateParamsNonStreaming {
  const { instructions, tools } = guidePrompt();
  const thinking = thinkingFor(model);
  return {
    model,
    max_tokens: LIMITS.maxTokens,
    output_config: { effort: 'low' },
    ...(thinking ? { thinking } : {}),
    // The long fixed part (tools and instructions) is cached; the booth changes every time.
    system: [
      { type: 'text', text: instructions, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: boothText(booth) },
    ],
    tools,
    messages: toApiMessages(history),
  };
}

const SORRY = 'I can’t help with that one. Ask me about the decks, the mixer or the effects.';
const TOO_LONG = 'That answer ran long, so I stopped. Try asking about one thing at a time.';

/** The parts of Claude's answer the page needs: its text and tool calls. */
export function readReply(msg: Anthropic.Message, toolNames: Set<string>): GuideReply {
  const stop = msg.stop_reason ?? null;
  if (stop === 'refusal') return { text: SORRY, toolCalls: [], stop };
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') text += (text ? '\n\n' : '') + b.text;
    // A tool call cut off by max_tokens may be incomplete, so only whole answers' calls run.
    else if (b.type === 'tool_use' && stop !== 'max_tokens' && toolNames.has(b.name) && ID.test(b.id)) {
      toolCalls.push({ id: b.id, name: b.name, args: b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {} });
    }
  }
  if (stop === 'max_tokens') text = text ? `${text}…\n\n${TOO_LONG}` : TOO_LONG;
  return { text, toolCalls, stop };
}

/* ── Limits on who asks and how often ─────────────────────────────────────── */

export class RateLimiter {
  private ips = new Map<string, number[]>();
  private all: number[] = [];

  /** Records a request, or says how many seconds until the next one is allowed. */
  take(ip: string, now: number): { ok: true } | { ok: false; retryAfter: number } {
    const recent = (list: number[], windowMs: number) => list.filter((t) => now - t < windowMs);
    this.all = recent(this.all, LIMITS.globalWindowMs);
    const mine = recent(this.ips.get(ip) ?? [], LIMITS.ipWindowMs);
    if (mine.length >= LIMITS.ipMax) return { ok: false, retryAfter: Math.ceil((mine[0] + LIMITS.ipWindowMs - now) / 1000) };
    if (this.all.length >= LIMITS.globalMax) return { ok: false, retryAfter: Math.ceil((this.all[0] + LIMITS.globalWindowMs - now) / 1000) };
    mine.push(now);
    this.all.push(now);
    this.ips.set(ip, mine);
    // Forget visitors whose window has passed, so the map stays small.
    if (this.ips.size > 5000) for (const [k, v] of this.ips) if (!v.length || now - v[v.length - 1] >= LIMITS.ipWindowMs) this.ips.delete(k);
    return { ok: true };
  }
}

/* ── The handler ──────────────────────────────────────────────────────────── */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const fail = (status: number, error: string, message: string, headers: Record<string, string> = {}) =>
  json({ error, message }, status, headers);

const BUSY = 'The booth guide has answered a lot of questions just now. Give it a few minutes and ask again.';

/** Only the site's own pages may ask: a browser always sends Origin with a POST. */
function sameOrigin(req: Request) {
  if (req.headers.get('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin') return false;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function clientIp(req: Request) {
  return (req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown').trim();
}

export interface GuideDeps {
  env: Record<string, string | undefined>;
  /** Makes the Claude client; the tests pass a fake. */
  client: (apiKey: string) => Pick<Anthropic, 'messages'>;
  limiter: RateLimiter;
  now: () => number;
}

export function modelName(env: Record<string, string | undefined>) {
  const m = env.GUIDE_MODEL?.trim();
  return m && /^[a-z0-9.-]{3,80}$/.test(m) ? m : DEFAULT_MODEL;
}

export function status(deps: GuideDeps): Response {
  return json({ configured: !!deps.env.ANTHROPIC_API_KEY, model: modelName(deps.env) });
}

export async function answer(req: Request, deps: GuideDeps): Promise<Response> {
  const key = deps.env.ANTHROPIC_API_KEY;
  if (!key) return fail(503, 'not_configured', 'The booth guide isn’t connected to Claude on this site.');
  if (!sameOrigin(req)) return fail(403, 'forbidden', 'Only Platter’s own pages can ask the guide.');
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return fail(415, 'bad_request', 'Send the question as JSON.');

  const raw = await req.text();
  if (raw.length > LIMITS.maxBodyBytes) return fail(413, 'too_large', 'That conversation is too long. Clear the chat and ask again.');
  let body: { messages?: unknown; booth?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'bad_request', 'The question didn’t arrive in one piece. Try again.');
  }
  const history = trimHistory(body?.messages);
  if (!history.length) return fail(400, 'bad_request', 'Ask the guide something first.');

  const turn = deps.limiter.take(clientIp(req), deps.now());
  if (!turn.ok) return fail(429, 'rate_limited', BUSY, { 'retry-after': String(turn.retryAfter) });

  const model = modelName(deps.env);
  const request = buildRequest(model, history, sanitizeBooth(body?.booth));
  const toolNames = new Set(guidePrompt().tools.map((t) => t.name));
  try {
    const msg = await deps.client(key).messages.create(request, { signal: req.signal });
    return json(readReply(msg, toolNames));
  } catch (e) {
    // Most specific first; the page shows `message`, the log keeps the status.
    if (e instanceof Anthropic.APIUserAbortError) return fail(499, 'aborted', 'Stopped.');
    console.error('booth guide:', e instanceof Anthropic.APIError ? `${e.status ?? 'no status'} ${e.name}` : e);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return fail(502, 'key_refused', 'Claude didn’t accept this site’s API key, so the guide can’t answer right now.');
    }
    if (e instanceof Anthropic.RateLimitError) return fail(429, 'rate_limited', BUSY, { 'retry-after': '60' });
    if (e instanceof Anthropic.NotFoundError) return fail(502, 'model_missing', `The guide’s model (${model}) isn’t available to this site’s key.`);
    if (e instanceof Anthropic.InternalServerError) return fail(503, 'busy', 'Claude is busy right now. Ask again in a moment.');
    if (e instanceof Anthropic.APIConnectionError) return fail(502, 'unreachable', 'The guide couldn’t reach Claude. Ask again in a moment.');
    if (e instanceof Anthropic.APIError) return fail(502, 'api_error', 'Claude couldn’t answer that one. Try asking another way.');
    return fail(500, 'server_error', 'Something went wrong on the server. Ask again in a moment.');
  }
}

/* ── Vercel's entry points ────────────────────────────────────────────────── */

const live: GuideDeps = {
  env: process.env,
  // The SDK retries overloads and rate limits itself; two tries keep the wait short.
  client: (apiKey) => new Anthropic({ apiKey, maxRetries: 2, timeout: 30_000 }),
  limiter: new RateLimiter(),
  now: Date.now,
};

export function GET(): Response {
  return status(live);
}

export function POST(req: Request): Promise<Response> {
  return answer(req, live);
}
