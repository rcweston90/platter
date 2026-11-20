import type { Role } from './characters';

/**
 * Starter grooves for the beat board, written per drum role so they play on
 * any kit. "X" is an accented hit, "x" a normal one, "." a rest; 16 steps
 * are one bar of sixteenth notes.
 */

export interface Groove {
  id: string;
  name: string;
  /** Swing that suits it, MPC-style: 50 = straight, 66 = triplet shuffle. */
  swing: number;
  lanes: Partial<Record<Role, string>>;
}

export const GROOVES: Groove[] = [
  {
    id: 'four',
    name: 'Four on the floor',
    swing: 54,
    lanes: {
      kick: 'X...X...X...X...',
      clap: '....x.......x...',
      chh: 'x.x.x.x.x.x.x.x.',
      ohh: '..x...x...x...x.',
      shaker: '.x.x.x.x.x.x.x.x',
    },
  },
  {
    id: 'boombap',
    name: 'Boom bap',
    swing: 62,
    lanes: {
      kick: 'X......x..X.....',
      snare: '....X.......X...',
      chh: 'x.x.x.x.x.x.x.xx',
      rim: '..........x.....',
    },
  },
  {
    id: 'trap',
    name: 'Trap',
    swing: 50,
    lanes: {
      kick: 'X......X..X.....X.....x...X.....',
      snare: '........X...............X.......',
      chh: 'x.x.x.x.xxx.x.x.x.x.x.x.x.xxxxx.',
      ohh: '..............x...............x.',
      bass: 'X..........................x....',
    },
  },
  {
    id: 'twostep',
    name: 'Two-step garage',
    swing: 64,
    lanes: {
      kick: 'X.........x..x..',
      snare: '....x.......x...',
      rim: '.x...x.x..x....x',
      chh: 'x.x.x.x.x.x.x.x.',
      ohh: '...x.......x....',
    },
  },
  {
    id: 'break',
    name: 'Breakbeat',
    swing: 56,
    lanes: {
      kick: 'X.x.......xx....',
      snare: '....X..x.x..X..x',
      chh: 'x.x.x.x.x.x.x.x.',
      ohh: '..............x.',
    },
  },
  {
    id: 'electro',
    name: 'Electro',
    swing: 50,
    lanes: {
      kick: 'X......x..X.....',
      snare: '....X.......X...',
      clap: '....x.......x...',
      chh: 'xxxxxxxxxxxxxxxx',
      percA: '..x.....x.x.....',
    },
  },
  {
    id: 'afro',
    name: 'Afro shuffle',
    swing: 60,
    lanes: {
      kick: 'X...x...X...x...',
      rim: '..x..x....x..x..',
      shaker: 'xxxxxxxxxxxxxxxx',
      percA: 'x..x..x...x..x..',
      percB: '.....x.x.....x.x',
      chh: '..x...x...x...x.',
    },
  },
  {
    id: 'dnb',
    name: 'Drum & bass',
    swing: 52,
    lanes: {
      kick: 'X.........X.....',
      snare: '....X.......X...',
      chh: 'x.x.x.x.x.x.x.x.',
      percB: '.......x.....x..',
    },
  },
];

/** "X..x" → [2, 0, 0, 1], stretched or cut to `length` steps. */
export function parseLane(text: string, length: number): number[] {
  return Array.from({ length }, (_, i) => {
    const c = text[i % text.length];
    return c === 'X' ? 2 : c === 'x' ? 1 : 0;
  });
}
