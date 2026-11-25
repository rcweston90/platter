/**
 * The booth guide's control registry: Platter's controls as a typed list,
 * each with an id the guide (or a model) can name, where it is on screen,
 * what it does, how to read it and how to set it. Reads and writes go
 * through the same stores and methods the controls themselves use
 * (deck.ts, mixer.ts via the session, beatfx.ts), so a value the guide sets
 * is exactly what the knob or button would have set.
 *
 * Finding a control on screen goes by the aria-labels the controls already
 * carry (and, for the few switches without one, by their caption inside the
 * deck's section), so nothing in the rig had to change for the guide.
 */

import { JUMP_BEATS, LOOP_BEATS, loopLabel, type Deck } from '../engine/deck';
import { FX_CHANNELS, type FxChannel } from '../engine/beatfx';
import { beatsLabel, FX_TYPES, type FxType } from '../engine/fx';
import { eqLabel, filterLabel, trimDb, type ChannelState, type CrossfaderCurve } from '../engine/mixer';
import type { DjSession } from '../engine/session';
import { bankLabel } from '../engine/cues';

/** Where a control lives: a deck, the mixer, or the top bar. On a phone the
 *  guide shows that part of the rig before it rings the control. */
export type ControlArea = 'A' | 'B' | 'mix' | 'top';

export type ControlValue = number | boolean | string;

interface Base {
  /** Stable id a model names it by: `A.play`, `mixer.crossfader`. */
  id: string;
  /** What a DJ calls it: "Deck A play". */
  name: string;
  /** Where it is, in words. */
  where: string;
  /** What it does, in a sentence. */
  does: string;
  area: ControlArea;
  /** Other words for it, for the demo model's matching. */
  aliases?: string[];
  /** The control's element on screen (the visible one when there are two). */
  find(): HTMLElement | null;
}

export interface RangeControl extends Base {
  kind: 'range';
  min: number;
  max: number;
  /** Named values: centre, kill, off, full … */
  presets?: Record<string, number>;
  /** Whole numbers only (a key shift in semitones). */
  integer?: boolean;
  read(s: DjSession): number;
  write(s: DjSession, v: number): void;
  format(v: number): string;
}

export interface ToggleControl extends Base {
  kind: 'toggle';
  read(s: DjSession): boolean;
  write(s: DjSession, v: boolean): void;
  format?(v: boolean): string;
}

export interface ChoiceControl extends Base {
  kind: 'choice';
  choices: readonly { value: string; label: string }[];
  read(s: DjSession): string;
  write(s: DjSession, v: string): void;
}

/** A button that does something once (a beat jump, reloop). */
export interface PressControl extends Base {
  kind: 'press';
  press(s: DjSession): void;
}

export type GuideControl = RangeControl | ToggleControl | ChoiceControl | PressControl;

/* ── Finding controls on screen ──────────────────────────────────────────── */

const shown = (el: Element) => el.getClientRects().length > 0;

/** The first visible match (a phone has a second crossfader in its dock), else the first. */
function pick(list: Iterable<Element>): HTMLElement | null {
  let first: HTMLElement | null = null;
  for (const el of list) {
    if (!(el instanceof HTMLElement)) continue;
    if (shown(el)) return el;
    first ??= el;
  }
  return first;
}

const css = (sel: string) => () => pick(document.querySelectorAll(sel));
const q = (s: string) => s.replace(/"/g, '\\"');
const label = (l: string, within = '') => css(`${within} [aria-label="${q(l)}"]`.trim());
/** A button by its caption inside `within`, for the switches with no aria-label. */
const caption = (within: string, text: string) => () =>
  pick([...document.querySelectorAll(`${within} button`)].filter((b) => b.textContent?.trim() === text));

/* ── Value text ──────────────────────────────────────────────────────────── */

const signedPct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
const dbText = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} dB`;
const levelText = (v: number) => (v <= 0 ? 'off' : dbText(40 * Math.log10(v / 0.8)));
const onOff = (v: boolean) => (v ? 'on' : 'off');
const xfText = (v: number) =>
  Math.abs(v) < 0.005 ? 'centre' : v < 0 ? `${Math.round(-v * 100)}% to deck A` : `${Math.round(v * 100)}% to deck B`;

/* ── Deck controls ───────────────────────────────────────────────────────── */

function deckControls(i: 0 | 1): GuideControl[] {
  const L = i === 0 ? 'A' : 'B';
  const deck = (s: DjSession): Deck => s.decks[i];
  const st = (s: DjSession) => deck(s).store.get();
  const sec = `section[aria-label="Deck ${L}"]`;
  const loops = `[aria-label="Deck ${L} loop and beat jump"]`;
  const area = L;
  const where = (part: string) => `Deck ${L}, ${part}`;

  return [
    {
      id: `${L}.play`,
      kind: 'toggle',
      name: `Deck ${L} play`,
      where: where('the round green button under the record'),
      does: 'Plays and pauses the deck.',
      area,
      aliases: ['play', 'pause', 'start', 'stop the deck'],
      find: css(`${sec} button[aria-label="Deck ${L} play"], ${sec} button[aria-label="Deck ${L} pause"]`),
      read: (s) => st(s).playing,
      write: (s, v) => (v ? deck(s).play() : deck(s).pause()),
      format: (v) => (v ? 'playing' : 'paused'),
    },
    {
      id: `${L}.sync`,
      kind: 'toggle',
      name: `Deck ${L} sync`,
      where: where('the first of the four switches beside Play'),
      does: 'Locks this deck to the other deck’s tempo and keeps the beats together. Moving either pitch fader then moves both.',
      area,
      aliases: ['sync', 'beat sync', 'sync lock'],
      find: caption(sec, 'Sync'),
      read: (s) => st(s).sync,
      write: (s, v) => deck(s).setSync(v),
      format: onOff,
    },
    {
      id: `${L}.keylock`,
      kind: 'toggle',
      name: `Deck ${L} key lock`,
      where: where('beside Sync'),
      does: 'Changes the tempo without changing the key.',
      area,
      aliases: ['key lock', 'keylock', 'master tempo'],
      find: label(`Deck ${L} key lock`, sec),
      read: (s) => st(s).keyLock,
      write: (s, v) => void deck(s).setKeyLock(v),
      format: onOff,
    },
    {
      id: `${L}.quant`,
      kind: 'toggle',
      name: `Deck ${L} quantise`,
      where: where('beside Keylock, captioned Quant'),
      does: 'Cue points, hot cues and loops snap to the beat grid.',
      area,
      aliases: ['quant', 'quantise', 'quantize'],
      find: caption(sec, 'Quant'),
      read: (s) => st(s).quantize,
      write: (s, v) => deck(s).setQuantize(v),
      format: onOff,
    },
    {
      id: `${L}.slip`,
      kind: 'toggle',
      name: `Deck ${L} slip`,
      where: where('the last of the four switches beside Play'),
      does: 'Scratches, loops and Reverse play over the track; when they end the track carries on where it would have been if it had kept playing.',
      area,
      aliases: ['slip', 'slip mode'],
      find: caption(sec, 'Slip'),
      read: (s) => st(s).slip,
      write: (s, v) => deck(s).setSlip(v),
      format: onOff,
    },
    {
      id: `${L}.pitch`,
      kind: 'range',
      name: `Deck ${L} pitch fader`,
      where: where('the tall fader beside the record'),
      does: 'Sets the deck’s tempo, in percent. Down (+) is faster, up (−) is slower; the range buttons under it set how far it reaches.',
      area,
      aliases: ['pitch', 'tempo fader', 'pitch fader', 'tempo'],
      min: -50,
      max: 50,
      presets: { zero: 0, centre: 0, center: 0 },
      find: label(`Deck ${L} pitch`, sec),
      read: (s) => st(s).pitch * 100,
      write: (s, v) => deck(s).setPitch(Math.max(-st(s).range, Math.min(st(s).range, v / 100))),
      format: signedPct,
    },
    {
      id: `${L}.reverse`,
      kind: 'toggle',
      name: `Deck ${L} reverse`,
      where: where('the Tricks pads (pick Tricks above the pads)'),
      does: 'Plays the track backwards until you turn it off.',
      area,
      aliases: ['reverse'],
      find: caption(`${sec} [aria-label="Deck ${L} tricks"]`, 'Reverse'),
      read: (s) => st(s).reverse,
      write: (s, v) => deck(s).setReverse(v),
      format: onOff,
    },
    {
      id: `${L}.loop`,
      kind: 'toggle',
      name: `Deck ${L} loop`,
      where: where('the Loop button in the middle of the loop section'),
      does: 'Loops the loop size’s worth of beats from here; off leaves the loop and plays on.',
      area,
      aliases: ['loop', 'auto loop', 'beat loop'],
      find: css(`${sec} ${loops} button[aria-label$="-beat loop"]`),
      read: (s) => st(s).loop.active,
      write: (s, v) => {
        if (st(s).loop.active !== v) deck(s).toggleLoop();
      },
      format: (v) => (v ? 'looping' : 'off'),
    },
    {
      id: `${L}.loopSize`,
      kind: 'choice',
      name: `Deck ${L} loop size`,
      where: where('the ½ and 2× buttons either side of Loop'),
      does: 'How many beats Loop loops; changes a running loop too.',
      area,
      aliases: ['loop size', 'loop length'],
      choices: LOOP_BEATS.map((b) => ({ value: String(b), label: `${loopLabel(b)} beats` })),
      find: css(`${sec} ${loops} button[aria-label$="-beat loop"]`),
      read: (s) => String(st(s).loop.active ? st(s).loop.beats : st(s).autoLoop),
      write: (s, v) => deck(s).setLoopBeats(Number(v)),
    },
    {
      id: `${L}.reloop`,
      kind: 'press',
      name: `Deck ${L} reloop / exit`,
      where: where('the loop section, beside Out'),
      does: 'While looping: leave the loop. Otherwise: jump back to the last loop’s start and loop it again.',
      area,
      aliases: ['reloop', 'exit loop'],
      find: css(`${sec} ${loops} button[aria-label^="Deck ${L}: exit the loop"], ${sec} ${loops} button[aria-label^="Deck ${L} reloop"]`),
      press: (s) => deck(s).reloop(),
    },
    {
      id: `${L}.jumpBack`,
      kind: 'press',
      name: `Deck ${L} beat jump back`,
      where: where('◂◂ in the loop section'),
      does: 'Jumps back by the jump size (a running loop moves with it).',
      area,
      aliases: ['jump back', 'beat jump back'],
      find: css(`${sec} ${loops} button[aria-label^="Jump back"]`),
      press: (s) => deck(s).beatJump(-1),
    },
    {
      id: `${L}.jumpForward`,
      kind: 'press',
      name: `Deck ${L} beat jump forward`,
      where: where('▸▸ in the loop section'),
      does: 'Jumps forward by the jump size.',
      area,
      aliases: ['jump forward', 'beat jump forward', 'beat jump'],
      find: css(`${sec} ${loops} button[aria-label^="Jump forward"]`),
      press: (s) => deck(s).beatJump(1),
    },
    {
      id: `${L}.jumpSize`,
      kind: 'choice',
      name: `Deck ${L} beat jump size`,
      where: where('− Jump + in the loop section'),
      does: 'How far a beat jump moves, in beats.',
      area,
      aliases: ['jump size'],
      choices: JUMP_BEATS.map((b) => ({ value: String(b), label: `${loopLabel(b)} beats` })),
      find: css(`${sec} ${loops} button[aria-label="Bigger beat jump"]`),
      read: (s) => String(st(s).jumpBeats),
      write: (s, v) => deck(s).setJumpBeats(Number(v)),
    },
    {
      id: `${L}.hotBank`,
      kind: 'choice',
      name: `Deck ${L} hot cue bank`,
      where: where('the bank buttons above the hot cue pads'),
      does: 'Which bank of eight hot cues the pads show.',
      area,
      aliases: ['hot cue bank', 'bank'],
      choices: [0, 1].map((b) => ({ value: String(b), label: bankLabel(b) })),
      find: css(`${sec} [aria-label="Deck ${L} hot cue bank"]`),
      read: (s) => String(st(s).hotBank),
      write: (s, v) => deck(s).setHotBank(Number(v)),
    },
    {
      id: `${L}.gate`,
      kind: 'toggle',
      name: `Deck ${L} hot cue gate`,
      where: where('Gate, beside the hot cue banks'),
      does: 'A hot cue plays only while you hold its pad.',
      area,
      aliases: ['gate'],
      find: css(`${sec} [aria-label="Deck ${L} gate: hot cues play only while held"]`),
      read: (s) => st(s).hotGate,
      write: (s, v) => deck(s).setHotGate(v),
      format: onOff,
    },
    {
      id: `${L}.keyShift`,
      kind: 'range',
      name: `Deck ${L} key shift`,
      where: where('♭ and ♯ in the Key row at the foot of the deck'),
      does: 'Moves the key up or down in semitones without changing the tempo.',
      area,
      aliases: ['key shift', 'key', 'transpose'],
      min: -6,
      max: 6,
      integer: true,
      presets: { zero: 0, off: 0 },
      find: css(`${sec} [aria-label="Deck ${L} key"]`),
      read: (s) => st(s).keyShift,
      write: (s, v) => void deck(s).setKeyShift(Math.round(v)),
      format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} st`,
    },
  ];
}

/* ── Mixer controls ──────────────────────────────────────────────────────── */

function channelControls(i: 0 | 1): GuideControl[] {
  const L = i === 0 ? 'A' : 'B';
  const ch = (s: DjSession) => s.mixer.get().channels[i];
  const set = (s: DjSession, patch: Partial<ChannelState>) => s.setChannel(i, patch);
  const mix = 'section[aria-label="Mixer"]';
  const knob = (
    key: 'trim' | 'high' | 'mid' | 'low' | 'filter',
    name: string,
    does: string,
    aliases: string[],
    format: (v: number) => string,
    presets: Record<string, number>,
    [min, max] = [0, 1],
  ): RangeControl => ({
    id: key === 'trim' || key === 'filter' ? `${L}.${key}` : `${L}.eq.${key}`,
    kind: 'range',
    name: `Channel ${L} ${name}`,
    where: `Mixer, channel ${L}’s strip`,
    does,
    area: 'mix',
    aliases,
    min,
    max,
    presets,
    find: label(`Channel ${L} ${name}`, mix),
    read: (s) => ch(s)[key],
    write: (s, v) => set(s, { [key]: Math.max(min, Math.min(max, v)) }),
    format,
  });
  const eqPresets = { kill: 0, off: 0, flat: 0.5, centre: 0.5, center: 0.5, unity: 0.5, full: 1, boost: 1 };
  return [
    knob('trim', 'trim', 'Gain before the EQ: ±12 dB, 0.5 is 0 dB. Match the two decks’ levels with it.', ['trim', 'gain'], (v) => dbText(trimDb(v)), { flat: 0.5, centre: 0.5, center: 0.5 }),
    knob('high', 'high EQ', 'The top end: hats and air. 0 kills it, 0.5 is flat, 1 is +6 dB.', ['high', 'highs', 'treble', 'hi'], eqLabel, eqPresets),
    knob('mid', 'mid EQ', 'The middle: vocals, synths and snare. 0 kills it, 0.5 is flat.', ['mid', 'mids'], eqLabel, eqPresets),
    knob('low', 'low EQ', 'The bottom: kick and bass. 0 kills it, 0.5 is flat. Swap two decks’ lows to swap the bass line.', ['low', 'lows', 'bass'], eqLabel, eqPresets),
    knob(
      'filter',
      'filter',
      'One knob, two filters: left of centre is a low-pass (muffles), right is a high-pass (thins). 0 is off.',
      ['filter', 'sweep'],
      filterLabel,
      { off: 0, centre: 0, center: 0, 'low-pass': -0.7, 'high-pass': 0.7 },
      [-1, 1],
    ),
    {
      id: `${L}.fader`,
      kind: 'range',
      name: `Channel ${L} volume`,
      where: `Mixer, the upright fader at the foot of channel ${L}`,
      does: 'The channel’s level into the crossfader. 0 is silent; 0.8 is where it starts.',
      area: 'mix',
      aliases: ['volume', 'channel fader', 'line fader', 'level'],
      min: 0,
      max: 1,
      presets: { off: 0, full: 1, up: 0.8 },
      find: label(`Channel ${L} volume`, mix),
      read: (s) => ch(s).fader,
      write: (s, v) => set(s, { fader: Math.max(0, Math.min(1, v)) }),
      format: (v) => (v <= 0 ? 'off' : dbText(40 * Math.log10(v))),
    },
    {
      id: `${L}.cue`,
      kind: 'toggle',
      name: `Channel ${L} headphone cue`,
      where: `Mixer, the Cue button above channel ${L}’s fader`,
      does: 'Sends the channel to the headphones, before its fader, so you can hear it before the crowd does.',
      area: 'mix',
      aliases: ['headphone cue', 'pfl', 'cue button', 'headphones'],
      find: label(`Channel ${L} headphone cue`, mix),
      read: (s) => ch(s).cue,
      write: (s, v) => set(s, { cue: v }),
      format: onOff,
    },
  ];
}

const CURVES: { value: CrossfaderCurve; label: string }[] = [
  { value: 'power', label: 'Smooth' },
  { value: 'full', label: 'Full' },
  { value: 'cut', label: 'Cut' },
];

function mixerControls(): GuideControl[] {
  const mix = 'section[aria-label="Mixer"]';
  const fx = 'section[aria-label="Beat FX"]';
  return [
    {
      id: 'mixer.crossfader',
      kind: 'range',
      name: 'Crossfader',
      where: 'Mixer, the sideways fader along the bottom',
      does: 'Blends deck A (left, −1) into deck B (right, +1). 0 is the centre, both decks heard.',
      area: 'mix',
      aliases: ['crossfader', 'xfader', 'cross fader', 'fader'],
      min: -1,
      max: 1,
      presets: { centre: 0, center: 0, middle: 0, a: -1, 'deck a': -1, left: -1, b: 1, 'deck b': 1, right: 1 },
      find: label('Crossfader'),
      read: (s) => s.mixer.get().crossfader,
      write: (s, v) => s.setCrossfader(v),
      format: xfText,
    },
    {
      id: 'mixer.curve',
      kind: 'choice',
      name: 'Crossfader curve',
      where: 'Mixer, under the crossfader',
      does: 'How the crossfader blends: Smooth dips a little in the middle, Full keeps both decks full there, Cut opens each side in the last few percent for scratching.',
      area: 'mix',
      aliases: ['curve', 'crossfader curve'],
      choices: CURVES,
      find: label('Crossfader curve', mix),
      read: (s) => s.mixer.get().curve,
      write: (s, v) => s.setCurve(v as CrossfaderCurve),
    },
    {
      id: 'mixer.master',
      kind: 'range',
      name: 'Master level',
      where: 'Mixer, top left',
      does: 'The level of the whole mix. 0.8 is 0 dB; a limiter keeps it from clipping.',
      area: 'mix',
      aliases: ['master', 'master level', 'main level'],
      min: 0,
      max: 1,
      presets: { unity: 0.8, off: 0 },
      find: label('Master level', mix),
      read: (s) => s.mixer.get().master,
      write: (s, v) => s.setLevels({ master: Math.max(0, Math.min(1, v)) }),
      format: levelText,
    },
    {
      id: 'mixer.cueMix',
      kind: 'range',
      name: 'Headphone cue mix',
      where: 'Mixer, top, between Master and Phones',
      does: 'What the headphones hear: 0 is only the cued channels, 1 is only the master.',
      area: 'mix',
      aliases: ['cue mix', 'headphone mix'],
      min: 0,
      max: 1,
      find: label('Headphones: cue ↔ master blend', mix),
      read: (s) => s.mixer.get().cueMix,
      write: (s, v) => s.setLevels({ cueMix: Math.max(0, Math.min(1, v)) }),
      format: (v) => `${Math.round((1 - v) * 100)}% cue · ${Math.round(v * 100)}% master`,
    },
    {
      id: 'mixer.phones',
      kind: 'range',
      name: 'Headphone level',
      where: 'Mixer, top right',
      does: 'How loud the headphones are.',
      area: 'mix',
      aliases: ['phones', 'headphone level', 'headphone volume'],
      min: 0,
      max: 1,
      find: label('Headphone level', mix),
      read: (s) => s.mixer.get().cueLevel,
      write: (s, v) => s.setLevels({ cueLevel: Math.max(0, Math.min(1, v)) }),
      format: levelText,
    },
    {
      id: 'fx.on',
      kind: 'toggle',
      name: 'Beat FX on',
      where: 'Mixer, the Beat FX section, the On button',
      does: 'Turns the Beat FX unit on and off. Its Level starts at 0, so turn that up too.',
      area: 'mix',
      aliases: ['beat fx', 'fx', 'effect', 'effects'],
      find: css(`${fx} button[aria-label="Beat FX"]`),
      read: (s) => s.fx.store.get().on,
      write: (s, v) => s.fx.setOn(v),
      format: onOff,
    },
    {
      id: 'fx.channel',
      kind: 'choice',
      name: 'Beat FX channel',
      where: 'Mixer, the A B Mst buttons at the top of Beat FX',
      does: 'Where the effect goes: deck A’s channel, deck B’s, or the master.',
      area: 'mix',
      aliases: ['fx channel', 'effect channel'],
      choices: FX_CHANNELS.map((c) => ({ value: c.id, label: c.name })),
      find: label('Beat FX channel', fx),
      read: (s) => s.fx.store.get().channel,
      write: (s, v) => s.fx.setChannel(v as FxChannel),
    },
    {
      id: 'fx.type',
      kind: 'choice',
      name: 'Beat FX effect',
      where: 'Mixer, the effect menu in Beat FX',
      does: 'Which effect the unit plays.',
      area: 'mix',
      aliases: ['effect type', 'which effect'],
      choices: FX_TYPES.map((t) => ({ value: t.id, label: t.label })),
      find: css('#beat-fx-type'),
      read: (s) => s.fx.store.get().type,
      write: (s, v) => s.fx.setType(v as FxType),
    },
    {
      id: 'fx.level',
      kind: 'range',
      name: 'Beat FX level',
      where: 'Mixer, the Level knob in Beat FX',
      does: 'How much effect: 0 is dry, 1 is all effect.',
      area: 'mix',
      aliases: ['fx level', 'effect level', 'wet', 'depth'],
      min: 0,
      max: 1,
      presets: { dry: 0, off: 0, half: 0.5, full: 1 },
      find: label('Beat FX level', fx),
      read: (s) => s.fx.store.get().depth,
      write: (s, v) => s.fx.setDepth(v),
      format: (v) => (v <= 0 ? 'dry' : `${Math.round(v * 100)}%`),
    },
    {
      id: 'fx.beats',
      kind: 'range',
      name: 'Beat FX beat value',
      where: 'Mixer, the < 1 > beat value in Beat FX',
      does: 'The effect’s length in beats; the nearest value the effect has is used.',
      area: 'mix',
      aliases: ['beat value', 'fx beats'],
      min: 1 / 16,
      max: 16,
      find: label('Beat value', fx),
      read: (s) => {
        const st = s.fx.store.get();
        return st.beats[st.type];
      },
      write: (s, v) => {
        const list = FX_TYPES.find((t) => t.id === s.fx.store.get().type)?.beats ?? [v];
        s.fx.setBeats(list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)));
      },
      format: (v) => `${beatsLabel(v)} beat`,
    },
  ];
}

/** Every control the guide knows, decks first, then the mixer. */
export const CONTROLS: readonly GuideControl[] = [...deckControls(0), ...deckControls(1), ...channelControls(0), ...channelControls(1), ...mixerControls()];

const BY_ID = new Map(CONTROLS.map((c) => [c.id, c]));

export function controlById(id: string): GuideControl | undefined {
  return BY_ID.get(id);
}

/** The control's value now, and the same as text ("centre", "kill", "on"). */
export function readControl(s: DjSession, c: GuideControl): { value: ControlValue | null; text: string } {
  switch (c.kind) {
    case 'range': {
      const v = c.read(s);
      return { value: Math.round(v * 1000) / 1000, text: c.format(v) };
    }
    case 'toggle': {
      const v = c.read(s);
      return { value: v, text: c.format ? c.format(v) : onOff(v) };
    }
    case 'choice': {
      const v = c.read(s);
      return { value: v, text: c.choices.find((x) => x.value === v)?.label ?? v };
    }
    case 'press':
      return { value: null, text: 'a button' };
  }
}

/** A value for `c` from what a model or the demo gave: a number, a preset
 *  name, true/false or on/off, a choice's value or label. Null if it won't do. */
export function resolveValue(c: GuideControl, raw: unknown): ControlValue | null {
  const word = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
  switch (c.kind) {
    case 'range': {
      let v: number | null = null;
      if (typeof raw === 'number' && Number.isFinite(raw)) v = raw;
      else if (word !== null && c.presets && word in c.presets) v = c.presets[word];
      else if (word !== null && word !== '' && Number.isFinite(Number(word))) v = Number(word);
      if (v === null) return null;
      v = Math.max(c.min, Math.min(c.max, v));
      return c.integer ? Math.round(v) : v;
    }
    case 'toggle':
      if (typeof raw === 'boolean') return raw;
      if (word && ['on', 'true', 'yes', 'play', 'playing'].includes(word)) return true;
      if (word && ['off', 'false', 'no', 'pause', 'paused', 'stop'].includes(word)) return false;
      return null;
    case 'choice': {
      const s = word ?? (typeof raw === 'number' ? String(raw) : null);
      if (s === null) return null;
      const hit = c.choices.find((x) => x.value.toLowerCase() === s || x.label.toLowerCase() === s);
      return hit ? hit.value : null;
    }
    case 'press':
      return true;
  }
}

/** The range of values a control takes, in words, for tool descriptions. */
export function valueHelp(c: GuideControl): string {
  switch (c.kind) {
    case 'range': {
      const presets = c.presets ? `; or one of: ${Object.keys(c.presets).join(', ')}` : '';
      return `number ${c.min} to ${c.max}${c.integer ? ' (whole numbers)' : ''}${presets}`;
    }
    case 'toggle':
      return 'true or false';
    case 'choice':
      return `one of: ${c.choices.map((x) => `${x.value} (${x.label})`).join(', ')}`;
    case 'press':
      return 'a button: pass true to press it';
  }
}
