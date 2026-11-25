import type { BoothSnapshot } from './model';
import { CONTROLS } from './registry';

/**
 * What a real model behind the booth guide is told, for whichever adapter
 * is written for it (the demo model needs none of this). Two parts, so a
 * provider that caches prompts can cache the long fixed one: the guide's
 * instructions and every control (the same for every request), then the
 * booth as it is now. sanitizeBooth keeps the booth state to what it should
 * hold before it goes into a prompt, wherever that prompt is built.
 */

export function guideInstructions(): string {
  return [
    'You are the booth guide inside Platter, a browser DJ app with two decks (A and B), a two-channel mixer with a crossfader, and one Beat FX unit.',
    'Answer questions about how to do things in Platter, briefly and concretely: a few short sentences or a short numbered list. Plain text, no Markdown headings or tables.',
    'When you name a control, write its id in double square brackets, like [[mixer.crossfader]] or [[A.slip]]; the app turns it into a button that shows the user the control. Use only ids from the list below.',
    'Tools: ring_control points at a control on screen; read_control reads its value; run_moves moves controls in time with the music; stop ends a run.',
    'run_moves takes a list of moves, run together: {"control": id, "to": value, "start": "now" | "next_beat" | "next_bar", "after_beats": number, "over_beats": number}. Times are beats of the playing deck (4 to a bar). A number control ramps to its value over over_beats (0 jumps); switches, choices and buttons happen at their start. Say in a sentence what you are about to do before you run moves, and keep them musical: fades over whole bars, kills and swaps on the bar.',
    'The user can stop a run at any time, and any touch of the controls stops it.',
    'Change the master level, headphones or a deck’s key only when asked. If something can’t be done with these controls, say so instead of guessing. When you use a tool, you may say a brief sentence first. Do not include internal or system XML tags in your response.',
    '',
    'Controls (id: name. Where it is. What it does.):',
    ...CONTROLS.map((c) => `${c.id}: ${c.name}. ${c.where}. ${c.does}`),
  ].join('\n');
}

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
