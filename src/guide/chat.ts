import type { DjSession } from '../engine/session';
import { createStore, type Store } from '../engine/store';
import { boothSnapshot, type GuideMessage, type GuideModel, type ToolCall } from './model';
import { guideTools, runTool, sanitizeToolCall, type ToolHost } from './tools';

/**
 * The booth guide's conversation: sends what the user asks to the model,
 * streams the answer into the chat, runs the tools the model calls and hands
 * their results back for another round (a few rounds at most), the usual
 * tool-use loop. It knows the model only through the GuideModel interface.
 */

export interface ChatEntry {
  id: number;
  role: 'user' | 'guide';
  text: string;
  /** One line per tool the guide used in this answer. */
  actions: { line: string; ok: boolean }[];
  /** Still streaming. */
  pending?: boolean;
}

export interface ChatState {
  entries: ChatEntry[];
  busy: boolean;
  /** Who answers: shown in the panel. */
  model: { label: string; connected: boolean };
}

/** Rounds of tool use per question, so a confused model can't loop forever. */
const MAX_ROUNDS = 4;

export class GuideChat {
  readonly store: Store<ChatState>;
  private history: GuideMessage[] = [];
  private abort: AbortController | null = null;
  private seq = 0;

  constructor(
    private _model: GuideModel,
    private session: DjSession,
    private host: ToolHost,
  ) {
    this.store = createStore<ChatState>({ entries: [], busy: false, model: { label: _model.label, connected: _model.connected } });
  }

  get model(): GuideModel {
    return this._model;
  }

  /** Swaps who answers (the demo for Claude once the server says it's connected, and back); the conversation stays. */
  setModel(model: GuideModel) {
    this._model = model;
    this.store.set({ model: { label: model.label, connected: model.connected } });
  }

  /** Asks the guide; resolves when its answer (and any tool rounds) are done. */
  async ask(text: string) {
    const q = text.trim();
    if (!q) return;
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    this.history.push({ role: 'user', text: q });
    this.push({ id: ++this.seq, role: 'user', text: q, actions: [] });
    const entry: ChatEntry = { id: ++this.seq, role: 'guide', text: '', actions: [], pending: true };
    this.push(entry);
    this.store.set({ busy: true });

    const tools = guideTools();
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let said = '';
        const calls: ToolCall[] = [];
        const results: GuideMessage[] = [];
        const booth = boothSnapshot(this.session);
        for await (const chunk of this._model.reply(this.history, tools, { booth, signal: abort.signal })) {
          if (abort.signal.aborted) return;
          if (chunk.type === 'text') {
            said += chunk.text;
            // A later round's words follow the first round's.
            this.update(entry, { text: joinText(entry.text, chunk.text, said === chunk.text) });
          } else {
            // Only calls that name real tools, controls and values run; the rest are dropped.
            const call = sanitizeToolCall(chunk.call);
            if (!call) {
              this.update(entry, { actions: [...entry.actions, { line: `Ignored a ${chunk.call.name} the guide can’t do`, ok: false }] });
              continue;
            }
            // Tools run as they arrive, so a ring shows while the text is still read.
            calls.push(call);
            const out = runTool(call, this.host);
            results.push({ role: 'tool', callId: call.id, name: call.name, result: out.result });
            this.update(entry, { actions: [...entry.actions, { line: out.line, ok: out.ok }] });
          }
        }
        this.history.push({ role: 'assistant', text: said, toolCalls: calls }, ...results);
        if (!calls.length) break;
      }
    } catch (e) {
      this.update(entry, { text: `${entry.text}${entry.text ? '\n\n' : ''}The guide couldn’t answer: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (this.abort === abort) {
        this.abort = null;
        this.update(entry, { pending: false });
        this.store.set({ busy: false });
      }
    }
  }

  /** Stops an answer mid-stream (a run already started keeps going until Stop). */
  cancel() {
    this.abort?.abort();
    this.abort = null;
    const entries = this.store.get().entries.map((e) => (e.pending ? { ...e, pending: false } : e));
    this.store.set({ entries, busy: false });
  }

  clear() {
    this.cancel();
    this.history = [];
    this.store.set({ entries: [] });
  }

  private push(e: ChatEntry) {
    this.store.set({ entries: [...this.store.get().entries, e] });
  }

  private update(e: ChatEntry, patch: Partial<ChatEntry>) {
    Object.assign(e, patch);
    this.store.set({ entries: this.store.get().entries.map((x) => (x.id === e.id ? { ...e } : x)) });
  }
}

/** Appends streamed text; a new round's first words start a new paragraph. */
function joinText(prev: string, piece: string, firstOfRound: boolean) {
  if (firstOfRound && prev) return `${prev}\n\n${piece}`;
  return prev + piece;
}
