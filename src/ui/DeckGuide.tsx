import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BEND, JUMP_BEATS, KEY_SHIFT_MAX, LOOP_BEATS, MIN_MOTOR, PITCH_RANGES, QUANTIZE_BEATS, ROLL_BEATS, WIDE_RANGE, loopLabel, rangeLabel } from '../engine/deck';
import { beatsLabel, FX_GROUPS, FX_META, FX_TYPES } from '../engine/fx';
import { bankLabel, CUE_COLORS } from '../engine/cues';
import { HOT_BANK_SIZE, HOT_CUES, MEMORY_CUES } from '../engine/types';
import {
  crossfaderGains,
  EQ_BOOST_DB,
  EQ_CUT_DB,
  EQ_HIGH_HZ,
  EQ_LOW_HZ,
  EQ_PEAK_HZ,
  EQ_SHELF_HIGH_HZ,
  EQ_SHELF_LOW_HZ,
  FADER_CUT_EDGE,
  faderGain,
  FILTER_LOCK,
  ISO_CUT_DB,
} from '../engine/mixer';
import { InfoIcon } from './icons';
import { usePhone } from './Phone';
import s from '../platter.module.css';

/*
 * The deck guide: what each control on a deck does. Every line is written
 * from what the code does (engine/deck.ts, engine/fx.ts, the deck worklet),
 * not from what a DJ might expect, and the numbers come from the same
 * constants the controls use, so a changed range or bend can't leave the
 * guide behind.
 */

export interface GuideItem {
  name: string;
  text: string;
}
export interface GuideSection {
  id: string;
  title: string;
  items: GuideItem[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const ranges = PITCH_RANGES.map(rangeLabel).join(' ');
/** "a, b, c or d" */
const either = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

export const PITCH_GUIDE: GuideSection = {
  id: 'pitch',
  title: 'Tempo and pitch',
  items: [
    {
      name: 'Pitch fader',
      text: 'Sets the deck’s tempo. Down, toward +, is faster; up, toward −, is slower. The numbers at its ends show how far it goes. Double-click or double-tap it to go back to 0. Without Keylock, the key moves with the tempo.',
    },
    {
      name: ranges,
      text: `How far the fader reaches: ${either(PITCH_RANGES.map(pct))} either way; WIDE is ±${pct(WIDE_RANGE)}, from a crawl (its −100% end turns at ${pct(MIN_MOTOR)}) to double speed. Narrow for fine control, wide for big changes. Switching keeps your tempo and moves the fader to match, unless the tempo is past the new range; then it’s pulled in to the edge. With Sync on, the deck widens its own range when it has to.`,
    },
    {
      name: 'Reset',
      text: 'Tempo reset: puts the pitch fader back to 0, the track’s own tempo, as double-clicking the fader does. It’s dimmed while the fader is already at 0.',
    },
    {
      name: '<  >  under the range',
      text: `Nudge. Hold < to play ${pct(BEND)} slower or > to play ${pct(BEND)} faster, to pull the beats back into line. Let go and it’s back at the fader’s tempo. With Sync on, the new beat offset is kept until you press Sync again.`,
    },
    {
      name: '+0.00%',
      text: 'How far the pitch fader has moved the tempo. It doesn’t count 45 rpm or a nudge.',
    },
    {
      name: 'BPM',
      text: 'The tempo you hear: the track’s own, moved by the pitch fader and 33/45. A nudge doesn’t change it.',
    },
    {
      name: '33  45',
      text: 'Platter speed. 33 plays the track as it is; 45 plays it 1.35× faster, on top of the pitch fader.',
    },
  ],
};

export const DECK_GUIDE: GuideSection[] = [
  PITCH_GUIDE,
  {
    id: 'record',
    title: 'The record',
    items: [
      {
        name: 'Record',
        text: 'Drag it to scratch (in Vinyl mode). With it selected, hold an arrow key to nudge, like the < > buttons by the fader.',
      },
      {
        name: 'Rim',
        text: `The platter’s edge, outside the record, where the strobe dots are. Turn it while the track plays to bend the tempo: the faster you turn, the more it bends, up to ${pct(BEND * 2)}. Stop turning and it’s back at the fader’s tempo. On a stopped deck it moves the record, to find a spot.`,
      },
      {
        name: 'Vinyl  CDJ',
        text: 'Jog mode, for the top of the record. Vinyl: touching it holds the record, so you can scratch it. CDJ: touching it only bends the tempo, like the rim, and never stops the track. Either way, a stopped deck moves under your hand, and each deck remembers its own mode. A controller’s touch-sensitive jog follows the same switch.',
      },
      {
        name: 'Scroll over the record',
        text: `While the deck plays, a mouse wheel or two-finger scroll over the record nudges it, like a hand on the platter’s edge: down to push it ahead, up to hold it back, up to ${pct(BEND)} for a full wheel notch, less for a gentle trackpad stroke. It lets go a moment after you stop. With the deck paused, hold Shift and scroll to inch the playhead (about 0.2 s a notch). Anywhere else the page scrolls as usual.`,
      },
      {
        name: 'Waveform strip',
        text: 'The whole track. Click or tap it to drop the needle there.',
      },
      {
        name: 'Phrase colours',
        text: 'Both waveforms are tinted by phrase, with a band along the foot: intro blue, verse teal, build amber, drop red, breakdown violet, outro grey. The scrolling one names each phrase and its length in bars. They’re read from the waveform on 8-bar lines of the beat grid, so fix the grid first if they look off; a guess, not a rule.',
      },
      {
        name: 'Countdown',
        text: 'Beside the time: bars.beats to the next hot cue (with its letter) or memory cue (MEM) ahead — 8.2 is 8 bars and 2 beats — or, in a loop, to the loop’s end (LOOP).',
      },
      {
        name: 'Phase meter',
        text: 'On deck B’s waveform while both decks play: how far B’s beat is from A’s, in beats. The marker sits in the middle, green, when they land together; right of it B is early, left of it late.',
      },
    ],
  },
  {
    id: 'transport',
    title: 'Play, cue and the four switches',
    items: [
      {
        name: 'Cue',
        text: 'While playing: back to the cue point, and stop. While stopped: sets the cue point where the track is, and holding it plays from there until you let go. Press Play while holding Cue to keep it playing.',
      },
      { name: 'Play', text: 'Plays and pauses the deck.' },
      {
        name: 'Sync',
        text: 'Locks this deck to the other deck’s tempo and keeps the beats together, at double or half time if that’s closer. Moving either deck’s fader then moves both. Press again to unlock.',
      },
      {
        name: 'Keylock',
        text: 'Changes the tempo without changing the key. It lets go while you hold the record, so scratches sound like a record.',
      },
      {
        name: 'Quant',
        text: `Cue points, hot cues and loops land on the nearest step of the grid — a beat, or ${either(QUANTIZE_BEATS.filter((b) => b < 1).map(loopLabel))} of one, set with the Q key by the loops — and rolls start on the beat just played.`,
      },
      {
        name: 'Slip',
        text: 'Scratches, loops and Reverse play over the track; when they end, the track carries on where it would have been if it had kept playing.',
      },
    ],
  },
  {
    id: 'pads',
    title: 'Pads',
    items: [
      {
        name: 'Hot cue',
        text: `${HOT_CUES} markers, ${HOT_BANK_SIZE} to a bank. Press an empty pad to mark the spot (on the beat with Quant on); press a marked pad to jump there. To clear one, Shift-click it, right-click it or long-press it.`,
      },
      {
        name: `${bankLabel(0)}  ${bankLabel(1)}`,
        text: `Which bank of ${HOT_BANK_SIZE} the pads show. A dot on the other bank means it holds cues. Keys 1–4 (deck A) and 7–0 (deck B) play the shown bank’s first four pads; 5 and 6 switch bank.`,
      },
      {
        name: 'Hot loop',
        text: 'Press an empty pad while a loop is running and the pad keeps that loop; its pad is striped and shows the loop’s length. Pressing it later goes to the loop’s start and loops it again, and Loop leaves it as usual.',
      },
      {
        name: 'Gate',
        text: 'With Gate on, a hot cue plays only while you hold its pad. Let go and the deck stops and goes back to the cue point, as letting go of Cue does. Clear pads from Edit while Gate is on.',
      },
      {
        name: 'Edit',
        text: `With Edit on, pressing a marked pad opens it: pick one of ${CUE_COLORS.length} colours, or clear it. Its marker on the waveforms takes the same colour and letter.`,
      },
      {
        name: 'Mem  <  +  >  ×',
        text: `Memory cues: up to ${MEMORY_CUES} saved points, shown as small notches along the foot of the waveforms. + saves one at the playhead (on the beat with Quant on). < and > call up the previous or next one: it becomes the cue point and the track goes there. × deletes the memory cue at the cue point.`,
      },
      {
        name: 'Roll',
        text: `Hold a pad to repeat a ${either(ROLL_BEATS.map(beatsLabel))}-beat slice over and over. Let go and the track carries on where it would have been.`,
      },
      {
        name: 'Censor',
        text: 'Hold to play backwards; let go and the track carries on where it would have been.',
      },
      { name: 'Reverse', text: 'Plays backwards until you press it again.' },
      { name: 'Brake', text: 'Stops the deck slowly, like a turntable winding down.' },
      { name: 'Spinback', text: 'Flicks the record backwards and lets it stop.' },
    ],
  },
  {
    id: 'loops',
    title: 'Loops and jumps',
    items: [
      { name: 'Loop', text: 'Loops that many beats from here. Press again to leave the loop.' },
      {
        name: 'In  Out',
        text: 'A loop of your own length. In marks where it starts, Out ends it there and starts looping; both snap to the grid with Quant on. Hold In for a 4-beat loop from the in point.',
      },
      {
        name: 'Reloop',
        text: 'While looping it reads Exit: leave the loop and play on. Press it again to jump back to the loop’s start and loop it again.',
      },
      {
        name: '½  2×',
        text: `Halve or double the loop, yours or a beat loop, from ${loopLabel(LOOP_BEATS[0])} of a beat to ${loopLabel(LOOP_BEATS[LOOP_BEATS.length - 1])} beats, even while it’s looping. It keeps its start.`,
      },
      {
        name: 'Edge  <  >',
        text: 'While looping, press In or Out (or Edge) to pick that end of the loop, then move it with < and > or the arrow keys: a grid step with Quant on, 10 ms with it off, 1 ms with Shift. You can also drag an end on the scrolling waveform. The pick lets go after a few seconds untouched, or with Esc.',
      },
      {
        name: '◂◂  − Jump +  ▸▸',
        text: `Jump back or forward by the jump size, ${loopLabel(JUMP_BEATS[0])} to ${loopLabel(JUMP_BEATS[JUMP_BEATS.length - 1])} beats, set with − and +. A running loop moves with the jump.`,
      },
      {
        name: 'Q',
        text: `The quantise step: ${either(QUANTIZE_BEATS.map(loopLabel))} beat. Press for the next. It only snaps while Quant is on.`,
      },
    ],
  },
  {
    id: 'fx',
    title: 'Beat FX',
    items: [
      {
        name: 'FX',
        text: 'Puts the mixer’s Beat FX on this deck and turns it on; press again to turn it off. Beside it: the effect, its beat value, and where the Beat FX is now. Pick the effect, its level and the rest in the Beat FX section of the mixer.',
      },
    ],
  },
  {
    id: 'stems',
    title: 'Stems',
    items: [
      {
        name: 'Stems',
        text: 'Every track on a deck is split into vocals, drums, bass and other by itself, in your browser; there’s nothing to press. The first split downloads a model of about 170 MB. Split only shows if you stopped one.',
      },
      {
        name: 'Parts',
        text: 'Once split, tap a part to mute it; hold it or Shift-click it to hear it alone. All brings every part back.',
      },
    ],
  },
  {
    id: 'key',
    title: 'Key',
    items: [
      {
        name: 'Key (8A)',
        text: 'The key you hear, in Camelot notation. Green: it mixes with the other deck. Red: it clashes.',
      },
      { name: '♭  ♯', text: `Moves the key down or up a semitone, up to ${KEY_SHIFT_MAX} each way (an octave), without changing the tempo.` },
      { name: 'Match', text: 'Moves to the nearest key that mixes with the other deck.' },
      { name: '0', text: 'Takes the key shift off.' },
    ],
  },
  {
    id: 'grid',
    title: 'Tempo set-up',
    items: [
      {
        name: 'Tap',
        text: 'Tap on the beat four or more times to set the tempo yourself. The beat grid lines up with your last tap; a pause of a couple of seconds starts over.',
      },
      {
        name: 'Grid',
        text: 'Opens grid edit. The scrolling waveform then numbers every beat 1–4 in its bar, the 1s in yellow. Every change is saved with the track, kept if it’s analysed again, and the phrases are read again on the new grid.',
      },
      {
        name: '−10  −1  +1  +10',
        text: 'Move the beat grid that many milliseconds earlier or later, so its lines sit on the beats. This moves the grid, not the music.',
      },
      {
        name: '1 here',
        text: 'Pause on a bar’s first beat and press it: the grid puts a downbeat at the playhead, same tempo. Bars, phrases and the countdown count from it.',
      },
      { name: '÷2  ×2', text: 'Halve or double the detected tempo, when the analysis picked the wrong one.' },
      { name: '⏏', text: 'Unloads the track. Pause first.' },
    ],
  },
  {
    id: 'load',
    title: 'Loading',
    items: [
      {
        name: 'Doubles',
        text: 'Instant doubles. While it’s lit, loading the track the other deck already has makes this deck join it: the same place in the track, the same tempo, key lock, key shift and loop, and playing if the other deck is playing, so the two run together. Off, a load starts at the track’s cue point as usual. On to begin with; each deck remembers its own.',
      },
    ],
  },
];

/** Rec moves and the move mixes in Recordings (engine/moves). */
export const MIX_MOVES_GUIDE: GuideSection = {
  id: 'moves',
  title: 'Recording your moves',
  items: [
    {
      name: 'Rec moves',
      text: 'In the top bar. Records what you do rather than the sound: the tracks you load, play, pause and cue, seeks and beat jumps, the pitch fader, Sync, the channel faders, crossfader, trim, EQ and filter, loops, hot cue pads and the Beat FX, each on the audio clock. Fader and knob drags are kept 25 times a second. Press it again to stop; the mix goes in Recordings, marked Moves, beside your audio recordings.',
    },
    {
      name: 'Replay',
      text: 'Plays a move mix back on the decks: the tracks load, and every control moves when it moved. Touch any control (a click, a key, MIDI) and the replay stops right there; the decks are yours from that point, playing as they were.',
    },
    {
      name: 'Missing tracks',
      text: 'A move mix carries the moves, not the music, so it only replays tracks you have: the demos, or tracks in your own crate (matched by title and artist when they were added separately). For any other, Replay names it and lets you pick one of your tracks instead, or skip it; a skipped deck sits out while it would have played.',
    },
    {
      name: 'Copy link  Download',
      text: 'Copy link puts the whole mix in a link, compressed, for a chat or an email; opening it adds the mix to the Recordings of whoever opens it and offers to replay it. A long mix is too big for a link: Download saves it as a .plattermix file instead, and Import mix in Recordings opens one.',
    },
  ],
};

DECK_GUIDE.push(MIX_MOVES_GUIDE);

const fxList = (g: (typeof FX_GROUPS)[number]) =>
  FX_TYPES.filter((t) => t.group === g)
    .map((t) => `${t.label}: ${t.hint}.`)
    .join(' ');
const straight = FX_META.echo.beats;
const triplet = FX_META.triroll.beats;

/** The mixer's Beat FX section (BeatFxPanel), written from engine/fx.ts and engine/beatfx.ts. */
export const BEAT_FX_GUIDE: GuideSection = {
  id: 'beatfx',
  title: 'Beat FX',
  items: [
    {
      name: 'A  B  Mst',
      text: 'Where the effect goes: deck A’s channel, deck B’s, or the master, which takes in both decks, the sampler and the beat board. On a deck it sits before the fader, so the headphone cue hears it too. There’s one effect unit; moving it moves the effect.',
    },
    ...FX_GROUPS.map((g) => ({ name: g, text: fxList(g) })),
    {
      name: '<  3/4  >',
      text: `The effect’s beat value, from ${beatsLabel(straight[0])} to ${beatsLabel(straight[straight.length - 1])} beats; the triplet effects step through triplet values (${triplet.map(beatsLabel).join(', ')}). Each effect remembers its own.`,
    },
    {
      name: 'Time',
      text: 'The beat value in milliseconds at the tempo the effect follows.',
    },
    {
      name: 'Auto  Tap',
      text: 'Auto follows the deck the effect is on, pitch fader included; on the master it follows the louder playing deck. For a track without a BPM, tap Tap on the beat two or more times; each tap also lines the beat up with your tap. Auto goes back to the deck. With no tempo at all the effect runs at 120 BPM.',
    },
    {
      name: 'X-pad',
      text: 'Hold a beat value on the strip and the effect plays it for as long as you hold; if the effect was off it comes on for the hold. Drag along the strip while holding to slide the effect’s X (shown under the strip: feedback, tone, resonance, width or level). Let go and everything goes back. From the keyboard: hold Space or Enter on a beat, with ↑ ↓ to slide.',
    },
    {
      name: 'Low  Mid  Hi',
      text: 'Which bands the effect is on, split where the EQ splits them. The others pass through untouched: an echo on the highs only, a roll that leaves the kick alone. At least one stays on.',
    },
    {
      name: 'Level',
      text: 'How much effect: its level, or how much of the dry sound it takes over. It starts at 0, dry, so nothing happens until you turn it up.',
    },
    {
      name: 'Q',
      text: 'FX quantize. While it’s lit, switching on and off, a new beat value and the X-pad land on the next beat of the deck (or your taps) instead of at once. With nothing playing they happen at once.',
    },
    {
      name: '+  −',
      text: 'Mobius only: rising or falling.',
    },
    {
      name: 'On',
      text: 'Turns the effect on and off. The delays, reverb, flanger and phaser ring out when you turn them off; Helix fades. Keys: F for deck A, H for deck B, B for the master.',
    },
  ],
};

/** The booth guide (src/guide): the chat panel behind Guide in the top bar. */
export const BOOTH_GUIDE_HELP: GuideSection = {
  id: 'booth',
  title: 'Booth guide',
  items: [
    {
      name: 'Guide',
      text: 'Opens the booth guide beside the rig (from the bottom on a phone). Ask how to do something and it answers in the panel. × or Esc closes it, and closing stops anything it was doing.',
    },
    {
      name: 'Not connected',
      text: 'The guide isn’t connected to an AI model yet. A built-in demo answers a few questions: how to beatmatch, what Slip does, a quick transition between the two decks, timed moves like “bring the crossfader to centre over 8 bars” or “kill deck A’s low at the next bar”, and what a control does. Nothing you type leaves the page.',
    },
    {
      name: 'Control chips',
      text: 'Controls named in an answer are buttons. Press one and the page scrolls to that control and rings it; on a phone the sheet tucks down while it shows you (press Booth guide to bring it back).',
    },
    {
      name: 'Moves',
      text: 'The guide can move controls in time with the playing deck, counted in its beats and bars: fades over a few bars, kills on the next bar, several at once. Each moving control is ringed with its value, and the status line shows the bar and what’s moving.',
    },
    {
      name: 'Stop',
      text: 'Stops a run; every control stays where it got to. Touching anything on the rig (a click, a key, the scroll wheel, or a MIDI control moving a fader the guide is moving) stops it too, so you can always take over.',
    },
  ],
};

/** Outputs → Listen to and audio health (ListenPanel), written from engine/listen.ts, engine/engine.ts and ui/wakeLock.ts. */
export const LISTEN_GUIDE: GuideSection = {
  id: 'listen',
  title: 'Listening',
  items: [
    {
      name: 'Listen to',
      text: 'What this output plays when it’s your only one. Master is the mix the room hears. Deck A cue and Deck B cue play that deck alone, before its fader, at the Phones level. Cue / master blend is the headphone mix: the channels with Cue lit, blended with the master by the Cue mix knob. Pick a deck’s cue to line up the next track on a laptop with one output, then go back to Master.',
    },
    {
      name: 'With headphones on their own output',
      text: 'With Headphones set to Split or to a second device, the cue already has somewhere to go, so this output plays the master and the choice waits until Headphones is Off again.',
    },
    {
      name: 'Listening volume',
      text: 'How loud this output is, from off to about +4 dB (0 dB at four-fifths of the way). It comes after the master meters and the recorder, so a recording, the master level and the meters don’t change with it. Double-click to go back to 0 dB. Both are remembered.',
    },
    {
      name: 'Audio health',
      text: 'The sample rate the audio runs at and its latency: the browser’s own buffer (base) and, where it says, the time to the speakers. Dropouts counts the gaps where the audio came too late and the output filled in silence — only in browsers that report them (AudioContext.playoutStats); elsewhere it says so rather than guess.',
    },
    {
      name: 'Screen',
      text: 'While a deck plays, the screen is kept from dimming and locking, and let go when nothing plays. Hidden in browsers that can’t.',
    },
  ],
};

const hz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(1)} kHz` : `${f} Hz`);
const dbAt = (g: number) => `${Math.round(20 * Math.log10(g))} dB`;

/** The mixer's channel switches and set-and-forget row (Mixer.tsx), from engine/mixer.ts. */
export const MIXER_GUIDE: GuideSection = {
  id: 'mixer',
  title: 'Mixer',
  items: [
    {
      name: 'Hi  Mid  Low',
      text: `Each channel’s EQ. Centre is flat, right boosts up to +${EQ_BOOST_DB} dB. Left cuts: with Iso down to −${ISO_CUT_DB} dB, and fully left is a kill, the band gone; with EQ down to −${EQ_CUT_DB} dB, never a kill. Double-click to centre.`,
    },
    {
      name: 'Filter',
      text: `Left is a low-pass sweeping down to 90 Hz, right a high-pass sweeping up to 9 kHz. It locks off at centre: the first ${Math.round(FILTER_LOCK * 100)}% of travel either side does nothing, and a drag through the middle holds there, so it parks off by feel.`,
    },
    {
      name: 'A  Thru  B',
      text: 'Crossfader assign, under each channel fader. A follows the crossfader’s left side, B its right side, and Thru ignores the crossfader: the channel is set by its fader alone. Deck A starts on A and deck B on B; put both on one side to fade them together.',
    },
    {
      name: 'EQ: Iso  EQ',
      text: `The EQ type, for both channels. Iso is an isolator: the bands split at ${hz(EQ_LOW_HZ)} and ${hz(EQ_HIGH_HZ)}, a band turned fully down is gone, and at centre they add back up flat. EQ is a classic channel EQ: a low shelf at ${hz(EQ_SHELF_LOW_HZ)}, a broad mid at ${hz(EQ_PEAK_HZ)} and a high shelf at ${hz(EQ_SHELF_HIGH_HZ)}, from +${EQ_BOOST_DB} to −${EQ_CUT_DB} dB: gentler cuts that leave some of the band. The knobs stay where they are when you switch.`,
    },
    {
      name: 'Ch curve: Slow  Lin  Fast',
      text: `How each channel fader’s travel turns into level. Lin: loudness rises evenly, ${dbAt(faderGain(0.5, 'linear'))} at halfway. Slow: the level comes in late, ${dbAt(faderGain(0.5, 'slow'))} at halfway, for long blends. Fast: full level within the first ${Math.round(FADER_CUT_EDGE * 100)}% of travel, for cuts and scratching.`,
    },
    {
      name: 'X curve: Smooth  Full  Cut',
      text: `How the crossfader blends. Smooth: constant power, each deck at ${dbAt(crossfaderGains(0, 'power')[0])} in the middle, so a blend keeps its loudness. Full: both decks at full level in the middle, each fading out over the far half. Cut: each side opens fully within the last few percent of travel, for scratching. Double-click the crossfader to centre it.`,
    },
  ],
};

/**
 * An ⓘ button that opens a guide panel. Click or tap pins it open; with
 * `hover`, a mouse resting on the button opens it too. Escape, a press
 * outside, or the close button shuts it. On a phone it rises from the bottom
 * of the screen. The panel is portalled to the body so a deck's container
 * query can't clip or re-anchor it.
 */
export function InfoTip({
  label,
  title,
  sections,
  deck,
  hover = false,
  className,
}: {
  label: string;
  title: string;
  sections: GuideSection[];
  deck: 'A' | 'B';
  hover?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState<null | 'hover' | 'pinned'>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const id = useId();
  const phone = usePhone();

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const enter = (pointerType: string) => {
    if (!hover || pointerType !== 'mouse' || open === 'pinned') return;
    clear();
    timer.current = window.setTimeout(() => setOpen((o) => o ?? 'hover'), 250);
  };
  const leave = () => {
    if (open === 'pinned') return;
    clear();
    timer.current = window.setTimeout(() => setOpen((o) => (o === 'hover' ? null : o)), 200);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`${s.infoBtn} ${className ?? ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        aria-controls={open ? id : undefined}
        onPointerEnter={(e) => enter(e.pointerType)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && leave()}
        onClick={() => {
          clear();
          setOpen((o) => (o === 'pinned' ? null : 'pinned'));
        }}
      >
        <InfoIcon />
      </button>
      {open && btn.current && (
        <GuidePanel
          id={id}
          anchor={btn.current}
          title={title}
          sections={sections}
          deck={deck}
          sheet={phone}
          takeFocus={open === 'pinned'}
          onEnter={() => clear()}
          onLeave={leave}
          onClose={() => {
            clear();
            setOpen(null);
          }}
        />
      )}
    </>
  );
}

function GuidePanel({
  id,
  anchor,
  title,
  sections,
  deck,
  sheet,
  takeFocus,
  onEnter,
  onLeave,
  onClose,
}: {
  id: string;
  anchor: HTMLElement;
  title: string;
  sections: GuideSection[];
  deck: 'A' | 'B';
  sheet: boolean;
  takeFocus: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // Beside the button where there's room (left of it for a button near the
  // right edge), else below or above it, always inside the window.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || sheet) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left: number;
      let top: number;
      if (a.right + 8 + w <= vw - 8) {
        left = a.right + 8;
        top = a.top;
      } else if (a.left - 8 - w >= 8) {
        left = a.left - 8 - w;
        top = a.top;
      } else {
        left = a.left;
        top = a.bottom + 6 + h <= vh - 8 ? a.bottom + 6 : a.top - 6 - h;
      }
      setPos({
        left: Math.max(8, Math.min(left, vw - w - 8)),
        top: Math.max(8, Math.min(top, vh - h - 8)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, sheet]);

  useEffect(() => {
    const el = panel.current;
    if (takeFocus) el?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      // The sheet's backdrop closes it on click instead, so the tap that
      // dismisses it doesn't also land on whatever is underneath.
      if (t === backdrop.current) return;
      if (!el?.contains(t) && !anchor.contains(t)) close.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc);
      // By now the panel has left the page, so focus that was inside it has
      // fallen back to the body: hand it to the button that opened it.
      const lost = !document.activeElement || document.activeElement === document.body || el?.contains(document.activeElement);
      if (takeFocus && anchor.isConnected && lost) anchor.focus({ preventScroll: true });
    };
  }, [anchor, takeFocus]);

  const style = {
    '--deck': `var(--dj-${deck.toLowerCase()})`,
    ...(sheet ? null : pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }),
  } as CSSProperties;

  const body: ReactNode = (
    <div
      ref={panel}
      id={id}
      className={`${s.guide} ${sheet ? s.guideSheet : ''}`}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      style={style}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onEnter()}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onLeave()}
    >
      <div className={s.guideHead}>
        <h2 className={s.guideTitle}>{title}</h2>
        <button type="button" className={s.guideClose} onClick={onClose} aria-label="Close the guide">
          ×
        </button>
      </div>
      {sections.map((sec) => (
        <section key={sec.id} className={s.guideSection} aria-label={sections.length > 1 ? sec.title : undefined}>
          {sections.length > 1 && <h3 className={s.guideSub}>{sec.title}</h3>}
          <dl className={s.guideList}>
            {sec.items.map((it) => (
              <div key={it.name} className={s.guideItem}>
                <dt>{it.name}</dt>
                <dd>{it.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );

  return createPortal(
    sheet ? (
      <>
        <div ref={backdrop} className={s.guideBackdrop} aria-hidden="true" onClick={onClose} />
        {body}
      </>
    ) : (
      body
    ),
    document.body,
  );
}
