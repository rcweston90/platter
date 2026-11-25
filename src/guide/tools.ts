import type { DjSession } from '../engine/session';
import type { ToolCall, ToolDef } from './model';
import { CONTROLS, controlById, readControl, resolveValue, valueHelp, type GuideControl } from './registry';
import type { MoveRunner, MoveSpec } from './runner';

/**
 * The guide's tools, generated from the control registry, and the code that
 * runs them in the page. A model only ever sees these four; everything it
 * can touch is a control in the registry, through the runner.
 */

const ids = CONTROLS.map((c) => c.id);

const valueList = CONTROLS.map((c) => `${c.id}: ${valueHelp(c)}`).join('\n');

export function guideTools(): ToolDef[] {
  return [
    {
      name: 'ring_control',
      description: 'Point at a control on screen: scrolls to it and draws an animated ring round it for a few seconds.',
      parameters: {
        type: 'object',
        properties: {
          control: { type: 'string', enum: ids, description: 'The control’s id.' },
        },
        required: ['control'],
        additionalProperties: false,
      },
    },
    {
      name: 'read_control',
      description: 'Read a control’s current value, as a number, true/false or choice, and as text.',
      parameters: {
        type: 'object',
        properties: {
          control: { type: 'string', enum: ids },
        },
        required: ['control'],
        additionalProperties: false,
      },
    },
    {
      name: 'run_moves',
      description: [
        'Run timed moves on controls, in beats of the playing deck’s tempo (4 beats to a bar). All moves in one call run together; each starts at its start point plus after_beats, and a number control ramps there over over_beats (0 jumps). Toggles, choices and buttons happen at their start. Starting a new run stops the old one; the user touching anything stops it too.',
        'Values each control takes:',
        valueList,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          moves: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                control: { type: 'string', enum: ids },
                to: { type: ['number', 'string', 'boolean'], description: 'Target value (see the list above).' },
                start: { type: 'string', enum: ['now', 'next_beat', 'next_bar'], description: 'Default now.' },
                after_beats: { type: 'number', description: 'Beats after the start point. Default 0.' },
                over_beats: { type: 'number', description: 'Beats to ramp over. Default 0.' },
              },
              required: ['control', 'to'],
              additionalProperties: false,
            },
          },
          tempo_from: { type: 'string', enum: ['A', 'B', 'auto'], description: 'Whose beats to count. Default auto: the playing deck.' },
        },
        required: ['moves'],
        additionalProperties: false,
      },
    },
    {
      name: 'stop',
      description: 'Stop the running moves; every control stays where it got to.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
}

/** What the tools need from the page. */
export interface ToolHost {
  session: DjSession;
  runner: MoveRunner;
  /** Scroll to a control and ring it. */
  point(c: GuideControl): void;
}

/** A tool call's outcome: the JSON result for the model, and a line for the chat. */
export interface ToolOutcome {
  result: string;
  line: string;
  ok: boolean;
}

const fail = (line: string): ToolOutcome => ({ result: JSON.stringify({ error: line }), line, ok: false });

export function runTool(call: ToolCall, host: ToolHost): ToolOutcome {
  const a = call.args ?? {};
  switch (call.name) {
    case 'ring_control': {
      const c = controlById(String(a.control));
      if (!c) return fail(`No control called ${String(a.control)}`);
      host.point(c);
      return { result: JSON.stringify({ ok: true, ringed: c.id, where: c.where }), line: `Pointed at ${c.name}`, ok: true };
    }
    case 'read_control': {
      const c = controlById(String(a.control));
      if (!c) return fail(`No control called ${String(a.control)}`);
      const v = readControl(host.session, c);
      return { result: JSON.stringify({ control: c.id, ...v }), line: `Read ${c.name}: ${v.text}`, ok: true };
    }
    case 'run_moves': {
      const moves = (Array.isArray(a.moves) ? a.moves : []) as MoveSpec[];
      const from = a.tempo_from === 'A' || a.tempo_from === 'B' ? a.tempo_from : 'auto';
      const r = host.runner.run(moves, { tempoFrom: from });
      if (!r.ok) return fail(`Couldn’t run those moves: ${r.error}`);
      return { result: JSON.stringify({ ok: true, running: r.summary }), line: `Running ${r.summary}`, ok: true };
    }
    case 'stop': {
      const stopped = host.runner.stop('Stopped by the guide.');
      return { result: JSON.stringify({ ok: true, stopped }), line: stopped ? 'Stopped the run' : 'Nothing was running', ok: true };
    }
    default:
      return fail(`No tool called ${call.name}`);
  }
}

const TOOL_NAMES = new Set(['ring_control', 'read_control', 'run_moves', 'stop']);
const STARTS = new Set(['now', 'next_beat', 'next_bar']);
/** Moves in one run, at most: more is a confused model, not a mix. */
const MAX_MOVES = 24;
/** A move can't wait or ramp longer than this many beats (16 bars). */
const MAX_BEATS = 64;

/**
 * A model's tool call, checked against the registry before anything runs:
 * unknown tools and controls are dropped, and so are values a control can't
 * take; a run keeps its good moves. Null when nothing in it is usable.
 */
export function sanitizeToolCall(raw: unknown): ToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : '';
  if (!TOOL_NAMES.has(name)) return null;
  const id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : `call-${Math.random().toString(36).slice(2, 10)}`;
  const args = (r.args && typeof r.args === 'object' ? r.args : {}) as Record<string, unknown>;
  switch (name) {
    case 'stop':
      return { id, name, args: {} };
    case 'ring_control':
    case 'read_control': {
      const c = typeof args.control === 'string' ? controlById(args.control) : undefined;
      return c ? { id, name, args: { control: c.id } } : null;
    }
    case 'run_moves': {
      const list = Array.isArray(args.moves) ? args.moves.slice(0, MAX_MOVES) : [];
      const moves: MoveSpec[] = [];
      for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        const mv = m as Record<string, unknown>;
        const c = typeof mv.control === 'string' ? controlById(mv.control) : undefined;
        if (!c) continue;
        const to = resolveValue(c, mv.to);
        if (to === null) continue;
        const beats = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_BEATS, Math.max(0, v)) : 0);
        moves.push({
          control: c.id,
          to,
          start: typeof mv.start === 'string' && STARTS.has(mv.start) ? (mv.start as MoveSpec['start']) : 'now',
          after_beats: beats(mv.after_beats),
          over_beats: beats(mv.over_beats),
        });
      }
      if (!moves.length) return null;
      const from = args.tempo_from === 'A' || args.tempo_from === 'B' ? args.tempo_from : 'auto';
      return { id, name, args: { moves, tempo_from: from } };
    }
  }
  return null;
}
