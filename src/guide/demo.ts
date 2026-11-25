import type { BoothSnapshot, GuideMessage, GuideModel, ReplyChunk, ReplyOptions, ToolCall, ToolDef } from './model';
import { CONTROLS, type GuideControl } from './registry';
import type { MoveSpec, MoveStart } from './runner';

/**
 * The demo model: a stand-in for a real AI model that runs in the page with
 * no network. It knows a handful of questions (beatmatching, slip, a quick
 * transition between the two decks, a few timed commands, "what does X do")
 * and answers them the way a real model would: streamed text with control
 * ids in [[double brackets]], and tool calls. That keeps the whole guide —
 * chips, rings, the runner, Stop — working end to end before a provider is
 * chosen, and gives the tests something fixed to drive.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BAND_WORDS: Record<string, 'low' | 'mid' | 'high'> = {
  low: 'low',
  lows: 'low',
  bass: 'low',
  mid: 'mid',
  mids: 'mid',
  high: 'high',
  highs: 'high',
  hi: 'high',
  treble: 'high',
};

export class DemoModel implements GuideModel {
  readonly label = 'Demo guide (offline)';
  readonly connected = false;
  private n = 0;

  /** `peek` reads the booth as it is (the same snapshot a real model is sent). */
  constructor(private peek: () => BoothSnapshot) {}

  async *reply(messages: GuideMessage[], _tools: ToolDef[], options: ReplyOptions): AsyncIterable<ReplyChunk> {
    const last = messages[messages.length - 1];
    const { text, calls } = last?.role === 'tool' ? this.followUp(messages) : this.answer(last?.role === 'user' ? last.text : '');
    // Stream the text a few words at a time, as a real model would.
    const words = text.split(/(?<=\s)/);
    for (let i = 0; i < words.length; i += 4) {
      if (options.signal?.aborted) return;
      yield { type: 'text', text: words.slice(i, i + 4).join('') };
      await sleep(8);
    }
    for (const call of calls) {
      if (options.signal?.aborted) return;
      yield { type: 'tool_call', call };
    }
  }

  private call(name: string, args: Record<string, unknown>): ToolCall {
    return { id: `demo-${++this.n}`, name, args };
  }

  /** After its tools ran: one line on how the run went, or nothing. */
  private followUp(messages: GuideMessage[]): { text: string; calls: ToolCall[] } {
    const results: { name: string; result: string }[] = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) {
      const m = messages[i] as Extract<GuideMessage, { role: 'tool' }>;
      results.unshift({ name: m.name, result: m.result });
    }
    const run = results.find((r) => r.name === 'run_moves');
    if (!run) return { text: '', calls: [] };
    const out = safeParse(run.result);
    if (out?.error) return { text: `That didn’t run: ${String(out.error)}`, calls: [] };
    return { text: 'It’s running. The status line below shows where it is; press Stop, or touch any control, to take over.', calls: [] };
  }

  private answer(raw: string): { text: string; calls: ToolCall[] } {
    const q = raw.toLowerCase().replace(/[’‘]/g, "'").trim();
    const snap = this.peek();

    if (/^(stop|halt|cancel|enough)\b/.test(q)) return { text: 'Stopped. Everything stays where it got to.', calls: [this.call('stop', {})] };

    if (/beat ?match|match(ing)? the (beats|tempo)|line up the beats|beats? (line|lined) up/.test(q)) return this.beatmatch();

    if (/\bslip\b/.test(q)) return this.slip();

    if (/transition|blend|mix (in|into|over|across)|play a (quick )?mix|crossfade (in|into|over)|mix from/.test(q)) return this.transition(snap);

    const command = this.command(q);
    if (command) return command;

    const c = matchControl(q);
    if (c) {
      return {
        text: `[[${c.id}]] is ${lowerFirst(c.where)}. ${c.does}`,
        calls: [this.call('ring_control', { control: c.id })],
      };
    }

    return {
      text: [
        'I’m the demo guide: Platter isn’t connected to an AI model yet, so I only know a few things. Try one of these:',
        '• How do I beatmatch?',
        '• What does slip do?',
        '• Play a quick transition between the demo tracks',
        '• Bring the crossfader to centre over 8 bars',
        '• Kill deck A’s low at the next bar',
        'Or ask what any control does, like “what does the filter do?”.',
      ].join('\n'),
      calls: [],
    };
  }

  private beatmatch() {
    return {
      text: [
        'Beatmatching is getting one deck’s beats to land on the other’s.',
        'The quick way: press [[B.sync]]. Deck B takes deck A’s tempo and keeps its beats locked to A’s, even when you move either pitch fader.',
        'By ear: play deck A, cue deck B in your headphones with [[B.cue]], start it on a downbeat with [[B.play]], then move [[B.pitch]] until the kicks stop drifting apart. Hold the < and > nudge buttons beside the fader to pull a beat back into line. The strip between the two waveforms shows how far apart the beats are.',
        'Once they hold together, bring deck B in with [[mixer.crossfader]].',
      ].join('\n\n'),
      calls: [this.call('ring_control', { control: 'B.pitch' }), this.call('ring_control', { control: 'B.sync' })],
    };
  }

  private slip() {
    return {
      text: [
        'Slip lets you play over the track without losing your place.',
        'With [[A.slip]] on, a scratch, a loop, Reverse, a beat roll or Censor plays as usual, but the track keeps counting underneath. Let go and it carries on where it would have been if it had kept playing, so you land back on the beat and in the right part of the phrase.',
        'Try it: turn Slip on, start a short [[A.loop]] for a bar, then turn the loop off.',
      ].join('\n\n'),
      calls: [this.call('ring_control', { control: 'A.slip' })],
    };
  }

  /** A four-bar blend from the playing deck into the other. */
  private transition(snap: BoothSnapshot) {
    const [a, b] = snap.decks;
    // Out: the deck that's playing (the one the crossfader favours if both are).
    const outDeck = a.playing && b.playing ? (snap.crossfader > 0 ? b : a) : b.playing ? b : a;
    const inDeck = outDeck === a ? b : a;
    const O = outDeck.label;
    const I = inDeck.label;
    if (!inDeck.title) {
      return { text: `Load a track on deck ${I} first (Tracks, or Browse music), then ask again and I’ll blend it in.`, calls: [] };
    }
    const toIn = I === 'B' ? 1 : -1;
    const moves: MoveSpec[] = [];
    const now = (control: string, to: unknown) => moves.push({ control, to, start: 'now' });
    const at = (control: string, to: unknown, after = 0, over = 0, start: MoveStart = 'next_bar') =>
      moves.push({ control, to, start, after_beats: after, over_beats: over });

    if (!outDeck.playing) now(`${O}.play`, true);
    if (!inDeck.playing) now('mixer.crossfader', -toIn);
    if (inDeck.fader < 0.5) now(`${I}.fader`, 0.8);
    if (outDeck.bpm && inDeck.bpm) now(`${I}.sync`, true);
    now(`${I}.eq.low`, 'kill');
    if (!inDeck.playing) at(`${I}.play`, true);
    at('mixer.crossfader', 'centre', 0, 8);
    at(`${O}.eq.low`, 'kill', 8);
    at(`${I}.eq.low`, 'flat', 8);
    at('mixer.crossfader', toIn, 8, 8);
    at(`${O}.play`, false, 16);
    at(`${O}.eq.low`, 'flat', 16);

    const intro = outDeck.playing
      ? `Here’s a quick four-bar blend from deck ${O} into deck ${I}, on deck ${O}’s beat:`
      : `Nothing’s playing, so I’ll start deck ${O} first, then blend deck ${I} in over four bars:`;
    const text = [
      intro,
      `1. Now: [[${I}.sync]] on, and [[${I}.eq.low]] killed so deck ${I} comes in without its bass.`,
      `2. On the next bar: [[${I}.play]], and [[mixer.crossfader]] glides to the centre over 2 bars.`,
      `3. Two bars in: swap the bass — [[${O}.eq.low]] out, deck ${I}’s low back to flat — and the crossfader goes the rest of the way over 2 bars.`,
      `4. At the end, [[${O}.play]] stops and its low goes back to flat.`,
    ].join('\n');
    return { text, calls: [this.call('run_moves', { moves })] };
  }

  /** "Bring the crossfader to centre over 8 bars", "kill deck A's low at the next bar". */
  private command(q: string): { text: string; calls: ToolCall[] } | null {
    if (!/\b(bring|move|put|set|turn|fade|kill|sweep|drop|cut|push|pull|take)\b/.test(q)) return null;
    const timing = parseTiming(q);
    const kill = /\b(kill|cut|drop)\b.*?\b(low|lows|bass|mid|mids|high|highs|hi|treble)\b/.exec(q);
    let c: GuideControl | undefined;
    let to: unknown;
    if (kill) {
      const L = deckLetter(q) ?? 'A';
      c = CONTROLS.find((x) => x.id === `${L}.eq.${BAND_WORDS[kill[2]]}`);
      to = 'kill';
    } else {
      c = matchControl(q);
      const target = /\bto (?:the )?(-?\d+(?:\.\d+)?|[a-z-]+(?: [ab]\b)?)/.exec(q.replace(/\bover\b.*$/, ''));
      if (c && target) to = /^-?\d/.test(target[1]) ? Number(target[1]) : target[1].replace(/^deck /, '');
      if (c && to === undefined && /\b(up|full)\b/.test(q)) to = c.kind === 'range' ? c.max : true;
      if (c && to === undefined && /\b(down|off)\b/.test(q)) to = c.kind === 'range' ? c.min : false;
    }
    if (!c || to === undefined) return null;
    const move: MoveSpec = { control: c.id, to, start: timing.start, after_beats: timing.after, over_beats: timing.over };
    const when = timing.start === 'next_bar' ? ' on the next bar' : timing.start === 'next_beat' ? ' on the next beat' : '';
    const over = timing.over ? ` over ${timing.over % 4 === 0 ? `${timing.over / 4} bar${timing.over === 4 ? '' : 's'}` : `${timing.over} beats`}` : '';
    const after = timing.after ? `, starting ${timing.after} beats in` : '';
    return {
      text: `Moving [[${c.id}]] to ${String(to)}${when}${after}${over}, in time with the playing deck.`,
      calls: [this.call('run_moves', { moves: [move] })],
    };
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function deckLetter(q: string): 'A' | 'B' | null {
  const m = /\b(?:deck|channel) ([ab])\b|\b([ab])'s\b/.exec(q);
  const l = m?.[1] ?? m?.[2];
  return l ? (l.toUpperCase() as 'A' | 'B') : null;
}

function parseTiming(q: string): { start: MoveStart; after: number; over: number } {
  const n = (s: string, unit: string) => Number(s) * (unit.startsWith('bar') ? 4 : 1);
  const over = /\bover (\d+(?:\.\d+)?) (bars?|beats?)\b/.exec(q);
  const after = /\b(?:in|after) (\d+(?:\.\d+)?) (bars?|beats?)\b/.exec(q);
  const start: MoveStart = /\b(?:at|on) the next bar\b|\bon the (?:next )?(?:one|downbeat)\b/.test(q)
    ? 'next_bar'
    : /\b(?:at|on) the next beat\b/.test(q)
      ? 'next_beat'
      : 'now';
  return { start, after: after ? n(after[1], after[2]) : 0, over: over ? n(over[1], over[2]) : 0 };
}

/** The control a question names: its longest matching name or alias, on the deck it mentions. */
export function matchControl(q: string): GuideControl | undefined {
  const L = deckLetter(q);
  let best: { c: GuideControl; score: number } | undefined;
  for (const c of CONTROLS) {
    const deckOf = /^([AB])\./.exec(c.id)?.[1];
    if (deckOf && deckOf !== (L ?? 'A')) continue;
    const names = [c.name.toLowerCase().replace(/^(deck|channel) [ab] /, ''), ...(c.aliases ?? [])];
    for (const name of names) {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (!re.test(q)) continue;
      // Longer names are more specific; a mixer control wins a tie when no deck is named.
      const score = name.length + (deckOf ? (L ? 0.5 : 0) : L ? 0 : 0.25);
      if (!best || score > best.score) best = { c, score };
    }
  }
  return best?.c;
}
