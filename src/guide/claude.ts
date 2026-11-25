import type { GuideMessage, GuideModel, ReplyChunk, ReplyOptions, ToolCall, ToolDef } from './model';

/**
 * The booth guide answered by Claude, through Platter's own server function
 * (api/guide.ts), which holds the API key, the instructions and the tools.
 * The page sends the conversation and the booth as it is now and gets back
 * the answer's text and tool calls; the chat runs the tools here as usual.
 *
 * When the server says it has no key, or can't be reached at all, the
 * answer comes from the fallback (the offline demo) instead, so the panel
 * keeps working.
 */

export interface GuideStatus {
  configured: boolean;
  model: string;
}

const ENDPOINT = '/api/guide';

/** Asks the server whether the guide is connected; null where there is no server (a local build, offline). */
export async function guideStatus(signal?: AbortSignal): Promise<GuideStatus | null> {
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' }, signal });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    const body = (await res.json()) as Partial<GuideStatus>;
    return typeof body.configured === 'boolean' ? { configured: body.configured, model: String(body.model ?? '') } : null;
  } catch {
    return null;
  }
}

/** "claude-haiku-5-5" → "Claude Haiku 5.5". */
export function modelLabel(id: string) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (!m) return id || 'Claude';
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

interface ReplyBody {
  text?: string;
  toolCalls?: ToolCall[];
  error?: string;
  message?: string;
}

export class ClaudeModel implements GuideModel {
  readonly label: string;
  readonly connected = true;

  constructor(
    status: GuideStatus,
    private fallback: GuideModel,
    /** Called when the server turns out not to have a key after all. */
    private onDisconnected: () => void = () => {},
  ) {
    this.label = modelLabel(status.model);
  }

  async *reply(messages: GuideMessage[], tools: ToolDef[], options: ReplyOptions): AsyncIterable<ReplyChunk> {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ messages, booth: options.booth }),
        signal: options.signal,
      });
    } catch (e) {
      if (options.signal?.aborted) return;
      // No network: the demo still knows the basics.
      yield { type: 'text', text: 'I can’t reach Claude right now, so this is the offline demo answering.\n\n' };
      yield* this.fallback.reply(messages, tools, options);
      return;
    }
    const body = (await res.json().catch(() => ({}))) as ReplyBody;
    if (!res.ok) {
      if (body.error === 'not_configured') {
        this.onDisconnected();
        yield* this.fallback.reply(messages, tools, options);
        return;
      }
      if (body.error === 'aborted') return;
      throw new Error(body.message || `the server answered ${res.status}`);
    }
    if (body.text) yield { type: 'text', text: body.text };
    for (const call of Array.isArray(body.toolCalls) ? body.toolCalls : []) {
      if (call && typeof call.id === 'string' && typeof call.name === 'string') {
        yield { type: 'tool_call', call: { id: call.id, name: call.name, args: call.args && typeof call.args === 'object' ? call.args : {} } };
      }
    }
  }
}
