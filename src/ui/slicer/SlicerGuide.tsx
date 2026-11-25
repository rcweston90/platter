import { MAX_HITS } from '../../slicer/dsp';
import { InfoTip, type GuideSection } from '../DeckGuide';
import { BANK, CUT_KEY } from './chopKit';
import w from './workspace.module.css';

/*
 * The slicer guide: the page as four steps (pick a sound, slice it, play the
 * pads, build the song), each with what its controls do. Written from what
 * the code does (slicer/studio.ts, slicer/model.ts, slicer/dsp.ts), with the
 * numbers taken from the same constants the controls use.
 */

export type SlicerStep = 'sound' | 'slices' | 'pads' | 'song';

export const STEPS: { id: SlicerStep; n: number; label: string; does: string }[] = [
  { id: 'sound', n: 1, label: 'Sound', does: 'Pick a track or a file to sample' },
  { id: 'slices', n: 2, label: 'Slices', does: 'Cut it into short pieces' },
  { id: 'pads', n: 3, label: 'Pads', does: 'Play the pieces like drums' },
  { id: 'song', n: 4, label: 'Song', does: 'Put them in order and export' },
];

export const SLICER_GUIDE: Record<SlicerStep, GuideSection> = {
  sound: {
    id: 'sound',
    title: '1 · Pick a sound',
    items: [
      {
        name: 'Crate · Files · In project',
        text: 'Crate is the music on your decks; Files opens audio from this device (FLAC, WAV, AIFF or MP3, and it stays on the device); In project lists every sound this project already uses. Pick one and it opens in step 2.',
      },
      {
        name: 'How it arrives',
        text: `Already cut on its hits, so the pads work straight away. A whole track gives its ${MAX_HITS} strongest hits. A sound with few hits (a held chord) is cut on the beat instead. Change how it’s cut in step 2.`,
      },
      {
        name: 'Fold the list',
        text: 'The arrow folds the list into a strip of initials so the pads get more room. The button at the top of the strip opens it again.',
      },
    ],
  },
  slices: {
    id: 'slices',
    title: '2 · Cut it into slices',
    items: [
      {
        name: 'Sample tempo',
        text: 'The tempo found in this sound. It sets where Beats cuts. It can be wrong, often by double or half: fix it with ½× or 2× in its menu. It isn’t the song’s tempo (that’s Song, at the top).',
      },
      {
        name: 'Cut on: Hits',
        text: `Cuts where a drum hit, note or syllable starts. Sensitivity sets how many it finds (more finds quieter ones). Never more than ${MAX_HITS}: on a long track you get the strongest ${MAX_HITS}.`,
      },
      {
        name: 'Cut on: Beats',
        text: 'Cuts on the sample’s beat grid, one slice every ¼ beat, ½ beat, 1 beat, 2 beats or bar. Needs the sample tempo.',
      },
      {
        name: 'Cut on: Equal',
        text: 'Cuts into 4, 8, 16 or 32 equal pieces, whatever the tempo.',
      },
      {
        name: 'Every change re-cuts',
        text: 'There’s no Apply: the pads change as you go. It replaces cuts you made by hand (Undo brings them back).',
      },
      {
        name: 'Play sample · Add cut',
        text: `Play sample plays the whole sound (it becomes Stop). Tap Add cut, or press ${CUT_KEY}, on a hit to cut there; with nothing playing it cuts at the cursor. Alt-click a cut line on the waveform to remove it.`,
      },
      {
        name: '… menu',
        text: 'Shortest slice for Hits, split out one part (vocals, drums, bass or the rest) as a new sound, or clear every cut and cut by hand.',
      },
    ],
  },
  pads: {
    id: 'pads',
    title: '3 · Play the pads',
    items: [
      {
        name: 'Pads',
        text: 'One pad per slice, in order: slice 1 on pad 1. Press a pad to hear it and pick it. The key in its corner plays it too: 1–4, Q–R, A–F and Z–V make the same 4×4 shape as the grid.',
      },
      {
        name: 'Banks',
        text: `${BANK} pads at a time. Slices past ${BANK} carry on in bank B, then C and on. The keys always play the bank on screen.`,
      },
      {
        name: 'Picked slice',
        text: 'Below the waveform: its number and length, then Play, Loop and Reverse to hear just that slice. ← and → pick the slice before or after.',
      },
      {
        name: 'Rec pads',
        text: 'At the top. Starts the song and records the pads you play onto the sample lane with the red dot, snapped to the grid. Press it again, or Space, to stop.',
      },
    ],
  },
  song: {
    id: 'song',
    title: '4 · Build the song',
    items: [
      {
        name: 'Add to song',
        text: 'Puts the picked slice after the last clip on the first sample lane (Enter does the same). On a computer you can also drag a pad onto any lane.',
      },
      {
        name: 'All in order',
        text: 'Puts every slice on a sample lane in its original rhythm: the sound rebuilt from its slices, ready to rearrange. It’s on the empty song, and in the + Lane menu.',
      },
      {
        name: 'Lanes',
        text: 'Sample lanes hold slices; Kick, Snare and Hats are drum lanes you click (or Draw on, with a finger) to add hits. The red dot picks the sample lane Rec pads records onto. M mutes a lane, S plays it alone.',
      },
      {
        name: 'Song tempo · grid',
        text: 'At the top. The song’s tempo, and the grid clips snap to (1/16 is a sixteenth note). The first sound into an empty project sets the song tempo; later ones keep theirs.',
      },
      {
        name: 'Sync tempo',
        text: 'On a clip, on by default: plays it at the song’s tempo by speeding it up or slowing it down, like a record, so its pitch moves too. A 180 BPM sample in a 128 BPM song plays slower and lower. Use as song tempo, in the sample tempo menu, makes them match.',
      },
      {
        name: 'Loop · Click',
        text: 'Loop repeats the bars bracketed on the ruler (bars 1–4 to start). Click is a metronome while the song plays.',
      },
      {
        name: 'Export',
        text: 'Saves the song, or just the loop, as a WAV, or sends it to your crate to play on a deck.',
      },
    ],
  },
};

/** A step's number and name, with its part of the guide. */
export function StepTag({ step, compact = false }: { step: SlicerStep; compact?: boolean }) {
  const s = STEPS.find((x) => x.id === step)!;
  return (
    <span className={w.step} data-compact={compact || undefined}>
      <span className={w.stepN} aria-hidden="true">
        {s.n}
      </span>
      <span className={w.stepLabel}>
        <span className={w.srOnly}>Step {s.n}: </span>
        {s.label}
      </span>
      <InfoTip label={`How step ${s.n}, ${s.label}, works`} title={SLICER_GUIDE[step].title} sections={[SLICER_GUIDE[step]]} deck="B" className={w.stepInfo} />
    </span>
  );
}
