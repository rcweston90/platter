import { sliceRange } from '../../slicer/model';
import { SLICE_COLORS, type Source } from '../../slicer/types';
import w from './workspace.module.css';

/** Pads per bank: a 4×4 grid, like the hardware it borrows from. */
export const BANK = 16;

/**
 * The pads' keys, by physical position (KeyboardEvent.code), so the grid on
 * screen and the grid under your fingers have the same shape on any layout:
 *   1 2 3 4
 *   Q W E R
 *   A S D F
 *   Z X C V
 */
export const PAD_CODES = [
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'KeyQ',
  'KeyW',
  'KeyE',
  'KeyR',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyZ',
  'KeyX',
  'KeyC',
  'KeyV',
];
/** What the pads show for their key (QWERTY names). */
export const PAD_KEYS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
/** Cuts a slice where the sample is sounding (or at the cursor). */
export const CUT_KEY = '/';

/** Pad / slice colour: four hues from the source's own, so neighbours always
 *  differ and each column of pads keeps one colour. The waveform's slice
 *  tints use the same colour as the pad that plays them. */
export function sliceColor(src: Pick<Source, 'color'>, i: number): string {
  return SLICE_COLORS[(src.color + (i % 4)) % SLICE_COLORS.length];
}

export const bankOf = (i: number) => Math.floor(i / BANK);
export const bankName = (b: number) => String.fromCharCode(65 + b);

/** Index of the slice whose range is exactly [start, end), or -1. */
export function exactSlice(src: Source, start: number, end: number): number {
  const n = src.slices.length;
  for (let i = 0; i < n; i++) {
    if (Math.abs(src.slices[i] - start) > 0.005) continue;
    const [, b] = sliceRange(src, i);
    return Math.abs(b - end) < 0.005 ? i : -1;
  }
  return -1;
}

export const fmtLen = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);

export function Glyph({ d, fill, size }: { d: string; fill?: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={fill ? w.glyphFill : w.glyph} style={size ? { width: size, height: size } : undefined}>
      <path d={d} />
    </svg>
  );
}

export const ICON = {
  play: 'M6.5 4.5l9 5.5-9 5.5z',
  stop: 'M5.5 5.5h9v9h-9z',
  loop: 'M4 9a4 4 0 0 1 4-4h7m-2-2 2 2-2 2M16 11a4 4 0 0 1-4 4H5m2 2-2-2 2-2',
  reverse: 'M13.5 4.5l-9 5.5 9 5.5z',
  add: 'M10 4v12M4 10h12',
  more: 'M4.5 10h.01M10 10h.01M15.5 10h.01',
  caret: 'M6 8l4 4 4-4',
  cut: 'M10 2.5v15M6.5 5.5 10 2.5l3.5 3',
  layout: 'M3 6h4v8H3zM8.5 6h3v8h-3zM13 6h4v8h-4z',
  close: 'M5 5l10 10M15 5 5 15',
  side: 'M3.5 4.5h13v11h-13zM8 4.5v11',
  upload: 'M10 13V3.5m0 0L6.5 7M10 3.5 13.5 7M4 12.5v3a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-3',
  wave: 'M2 10h2l1.5-4 2 9 2-7 1.5 4 1.5-2.5 2 5 1.5-6 1 2H18',
};
