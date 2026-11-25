import type { DjSession } from '../engine/session';

/**
 * The one seam between the booth guide and whatever answers it. The chat
 * (chat.ts) talks only to a GuideModel: it hands over the conversation and
 * the tools, and gets back a stream of text and tool calls. The tools run
 * here in the page (tools.ts); their results go back to the model on the
 * next round, the usual tool-use loop.
 *
 * The only implementation today is DemoModel (demo.ts), local and offline.
 * A real provider is a second class with the same reply(); its instructions
 * and the booth as text come from prompt.ts, and every tool call it returns
 * goes through sanitizeToolCall (tools.ts) before it runs. See the README's
 * "Booth guide" section for where it plugs in. Nothing here calls a network.
 */

export interface ToolCall {
  /** Unique within the conversation; the result names it. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type GuideMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; result: string };

/** A JSON Schema object, as tool-use APIs take them. */
export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema | { description?: string; enum?: unknown[]; type?: string | string[]; items?: JsonSchema }>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ReplyChunk = { type: 'text'; text: string } | { type: 'tool_call'; call: ToolCall };

export interface ReplyOptions {
  /** The booth as it is now, for the model's context. */
  booth: BoothSnapshot;
  /** Aborted when the user closes the panel or asks again mid-answer. */
  signal?: AbortSignal;
}

export interface GuideModel {
  /** Shown in the panel. */
  readonly label: string;
  /** False for the demo: the panel says it isn't connected to an AI model. */
  readonly connected: boolean;
  /** One round of the conversation: text and tool calls, streamed. */
  reply(messages: GuideMessage[], tools: ToolDef[], options: ReplyOptions): AsyncIterable<ReplyChunk>;
}

/* ── What the model is told ──────────────────────────────────────────────── */

/** The booth right now, in a few lines, so a model needn't read every control.
 *  This is all of the booth a model is given. */
export interface BoothSnapshot {
  decks: { label: 'A' | 'B'; title: string | null; playing: boolean; bpm: number | null; sync: boolean; fader: number; low: number }[];
  crossfader: number;
  audio: 'idle' | 'starting' | 'running' | 'error';
}

export function boothSnapshot(s: DjSession): BoothSnapshot {
  const m = s.mixer.get();
  return {
    decks: s.decks.map((d, i) => {
      const st = d.store.get();
      const bpm = d.effectiveBpm();
      return {
        label: d.label as 'A' | 'B',
        title: st.track?.title ?? null,
        playing: st.playing,
        bpm: bpm ? Math.round(bpm * 10) / 10 : null,
        sync: st.sync,
        fader: m.channels[i].fader,
        low: m.channels[i].low,
      };
    }),
    crossfader: m.crossfader,
    audio: m.audio,
  };
}
