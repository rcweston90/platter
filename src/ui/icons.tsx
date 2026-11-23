/**
 * Transport glyphs as SVG, so they sit on the pixel grid and centre the same
 * in every font (text glyphs like ▶ and ❚❚ vary in width and baseline from
 * one typeface to the next). All share a 24-unit box and fill with
 * currentColor; size them with CSS.
 */
const box = { viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false } as const;

/** Play: an equilateral-ish triangle nudged right of centre. Its visual mass
 *  sits a third of the way in from the flat edge, so a mathematically centred
 *  triangle looks left-heavy inside a circle. */
export const PlayIcon = () => (
  <svg {...box}>
    <path d="M8.5 5.2v13.6a.8.8 0 0 0 1.2.7l10.8-6.8a.8.8 0 0 0 0-1.4L9.7 4.5a.8.8 0 0 0-1.2.7Z" fill="currentColor" />
  </svg>
);

export const PauseIcon = () => (
  <svg {...box}>
    <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
    <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
  </svg>
);

/** Nudge slower / faster: a chevron, stroked to match the line weight of
 *  the deck's other controls. */
export const ChevronIcon = ({ dir }: { dir: -1 | 1 }) => (
  <svg {...box}>
    <path
      d={dir < 0 ? 'M14.5 6 8.5 12l6 6' : 'M9.5 6l6 6-6 6'}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** The track list: three lines, the last one shorter. */
export const ListIcon = () => (
  <svg {...box}>
    <path d="M4 6.5h16M4 12h16M4 17.5h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/** Beat pitch: three hits at three heights, the way the pitch lane draws them. */
export const PitchIcon = () => (
  <svg {...box}>
    <rect x="2" y="15.5" width="6" height="4" rx="2" fill="currentColor" />
    <rect x="9" y="4.5" width="6" height="4" rx="2" fill="currentColor" />
    <rect x="16" y="10" width="6" height="4" rx="2" fill="currentColor" />
  </svg>
);
