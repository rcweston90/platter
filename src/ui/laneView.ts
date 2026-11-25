import { createStore } from '../engine/store';
import { STEMS, type StemName } from '../engine/stems';

/**
 * How the beat pitch lanes show, the same on both decks and kept between
 * visits.
 *
 * - off: no lanes.
 * - mix: one lane per deck, the whole track's hits (as before stems).
 * - split: a lane per part (drums, bass, vocals, other).
 * - pair: rhythm (drums and bass) and melody (vocals and other).
 * - one: every part in one lane, drums along its foot.
 *
 * Until a track's stems are in, every view but off shows the mix lane.
 */
export type LaneMode = 'off' | 'mix' | 'split' | 'pair' | 'one';
export const LANE_MODES: LaneMode[] = ['off', 'mix', 'split', 'pair', 'one'];
export const LANE_MODE_LABELS: Record<LaneMode, string> = { off: 'Off', mix: 'Mix', split: 'Split', pair: 'Pair', one: 'One' };
export const LANE_MODE_HINTS: Record<LaneMode, string> = {
  off: 'No pitch lanes',
  mix: 'One lane: the whole track’s hits',
  split: 'A lane for each part',
  pair: 'Rhythm (drums, bass) and melody (vocals, other)',
  one: 'Every part in one lane, drums along the foot',
};

export interface LaneView {
  mode: LaneMode;
  /** Which parts the stem views draw. */
  show: Record<StemName, boolean>;
  /** Fade a part you've muted (or soloed away) the way the mix drops it. */
  follow: boolean;
}

const KEY = 'platter.stemLanes';
/** The lane switch before stems: 'off' carries over. */
const OLD_KEY = 'platter.pitchLanes';

const all = (): Record<StemName, boolean> => ({ vocals: true, drums: true, bass: true, other: true });

function load(): LaneView {
  const fallback: LaneView = { mode: 'split', show: all(), follow: true };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return localStorage.getItem(OLD_KEY) === 'off' ? { ...fallback, mode: 'off' } : fallback;
    const v = JSON.parse(raw) as Partial<LaneView>;
    const show = all();
    for (const stem of STEMS) if (v.show && typeof v.show[stem] === 'boolean') show[stem] = v.show[stem];
    return {
      mode: LANE_MODES.includes(v.mode as LaneMode) ? (v.mode as LaneMode) : fallback.mode,
      show,
      follow: typeof v.follow === 'boolean' ? v.follow : true,
    };
  } catch {
    return fallback;
  }
}

export const laneView = createStore<LaneView>(load());

laneView.subscribe(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(laneView.get()));
  } catch {
    /* private mode: just this visit */
  }
});

export function setLaneMode(mode: LaneMode) {
  laneView.set({ mode });
}

/** Show or hide a part; the last one shown stays. */
export function toggleShown(stem: StemName) {
  const { show } = laneView.get();
  if (show[stem] && STEMS.filter((s) => show[s]).length === 1) return;
  laneView.set({ show: { ...show, [stem]: !show[stem] } });
}

/** The lanes a view draws, each a list of parts, top to bottom: highest
 *  parts first, drums at the foot. */
export function lanesOf(view: LaneView): StemName[][] {
  const groups: StemName[][] =
    view.mode === 'split'
      ? [['vocals'], ['other'], ['bass'], ['drums']]
      : view.mode === 'pair'
        ? [['vocals', 'other'], ['bass', 'drums']]
        : view.mode === 'one'
          ? [['vocals', 'other', 'bass', 'drums']]
          : [];
  return groups.map((g) => g.filter((p) => view.show[p])).filter((g) => g.length);
}
