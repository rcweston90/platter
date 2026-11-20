import { camelot, keyName } from '../key';
import { CC0 } from './cc0';
import { CHARACTERS, ROLE_LABEL, type Character, type Role } from './characters';
import { CLASSICS } from './classic';
import { hash, type Render } from './dsp';
import { bass, clap, cymbal, fx, hat, keys, kick, perc, snare, stab, tom, vox, CHORDS, VOWEL_NAMES, type BassKind, type ChordKind, type FxKind, type KeysTone, type PercKind, type StabTone } from './voices';

/**
 * The sound library: every sound the sampler and beat board can use, as
 * metadata. Audio comes later and only on demand: synth sounds render in the
 * browser, CC0 sounds stream from this site's /sounds/cc0/ folder (and the
 * service worker keeps them after the first play), and your own sounds come
 * out of IndexedDB.
 */

export type Category = 'kick' | 'snare' | 'clap' | 'hat' | 'cymbal' | 'tom' | 'perc' | 'bass' | 'stab' | 'keys' | 'fx' | 'vox' | 'loop' | 'texture';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'kick', label: 'Kicks' },
  { id: 'snare', label: 'Snares' },
  { id: 'clap', label: 'Claps & snaps' },
  { id: 'hat', label: 'Hi-hats' },
  { id: 'cymbal', label: 'Cymbals' },
  { id: 'tom', label: 'Toms' },
  { id: 'perc', label: 'Percussion' },
  { id: 'bass', label: 'Bass' },
  { id: 'stab', label: 'Stabs & chords' },
  { id: 'keys', label: 'Keys & strings' },
  { id: 'fx', label: 'FX' },
  { id: 'vox', label: 'Vox' },
  { id: 'loop', label: 'Loops' },
  { id: 'texture', label: 'Textures' },
];

export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label])) as Record<Category, string>;

export type SoundSource = 'synth' | 'cc0' | 'user';

export interface SoundInfo {
  /** `syn:…`, `cc0:…` or `user:…`. */
  id: string;
  name: string;
  category: Category;
  source: SoundSource;
  /** Lower-case words the search matches. */
  words: string;
  /** Camelot key, for tonal sounds. */
  key?: string;
  /** Approximate length in seconds. */
  seconds?: number;
  /** Who made it (CC0 sounds). */
  credit?: string;
  /** CC0: the file under public/sounds/cc0/. */
  file?: string;
  /** Synth: renders the audio. */
  render?: Render;
  /** Synth kits: which kit it came from. */
  kit?: string;
}

const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const noteName = (n: number) => `${NOTE[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
const keyOf = (root: number, minor: boolean) => camelot({ pc: ((root % 12) + 12) % 12, minor });

const sounds: SoundInfo[] = [];
const byId = new Map<string, SoundInfo>();

function add(s: Omit<SoundInfo, 'words'> & { extra?: string }) {
  const { extra, ...rest } = s;
  const words = [rest.name, CATEGORY_LABEL[rest.category], rest.source === 'synth' ? 'synth' : rest.source === 'cc0' ? 'cc0 recorded sample' : 'my sounds', rest.key ?? '', rest.key ? keyName(rest.key) : '', rest.credit ?? '', extra ?? '']
    .join(' ')
    .toLowerCase();
  const info: SoundInfo = { ...rest, words };
  sounds.push(info);
  byId.set(info.id, info);
  return info;
}

/* ── The original eight ─────────────────────────────────────────────────── */

const CLASSIC_CAT: Category[] = ['fx', 'fx', 'fx', 'fx', 'clap', 'fx', 'fx', 'stab'];
CLASSICS.forEach((c, i) =>
  add({ id: `syn:classic:${c.name.toLowerCase()}`, name: c.name, category: CLASSIC_CAT[i], source: 'synth', render: c.voice, extra: 'classic dj tools' }),
);

/* ── Kit characters: 16 voices each ─────────────────────────────────────── */

const ROLE_CAT: Record<Role, Category> = {
  kick: 'kick',
  snare: 'snare',
  clap: 'clap',
  chh: 'hat',
  ohh: 'hat',
  tomL: 'tom',
  tomM: 'tom',
  tomH: 'tom',
  rim: 'perc',
  shaker: 'perc',
  percA: 'perc',
  percB: 'perc',
  crash: 'cymbal',
  ride: 'cymbal',
  bass: 'bass',
  stab: 'stab',
  fx: 'fx',
};

const PERC_NAME: Record<PercKind, string> = {
  rim: 'Rim',
  clave: 'Clave',
  cowbell: 'Cowbell',
  wood: 'Woodblock',
  shaker: 'Shaker',
  conga: 'Conga',
  bongo: 'Bongo',
  tamb: 'Tambourine',
  triangle: 'Triangle',
  snap: 'Snap',
  zap: 'Zap',
  blip: 'Blip',
  metal: 'Metal hit',
  kalimba: 'Kalimba',
  guiro: 'Guiro',
};

const FX_NAME: Record<FxKind, string> = {
  riser: 'Riser',
  downlifter: 'Downlifter',
  impact: 'Impact',
  laser: 'Laser',
  siren: 'Siren',
  horn: 'Air horn',
  rewind: 'Rewind',
  sweep: 'Filter sweep',
  noise: 'Noise crash',
  drop: 'Bass drop',
  stutter: 'Stutter',
  alarm: 'Alarm',
};

const BASS_NAME: Record<BassKind, string> = { sub: 'Sub bass', reese: 'Reese bass', acid: 'Acid bass', pluck: 'Pluck bass', growl: 'Growl bass' };
const STAB_NAME: Record<StabTone, string> = { house: 'House', organ: 'Organ', rave: 'Rave', dub: 'Dub' };
const KEYS_NAME: Record<KeysTone, string> = { epiano: 'E-piano', pluck: 'String pluck', bell: 'FM bell', pad: 'Pad' };

/** The library id of a character's sound for a role. */
export const charSoundId = (c: Character, role: Role) => `syn:${c.id}:${role}`;

function addCharacter(c: Character) {
  const seed = (r: string) => hash(`${c.id}:${r}`);
  const mk = (role: Role, render: Render, name: string, extra: Partial<SoundInfo> = {}) =>
    add({ id: charSoundId(c, role), name: `${c.name} ${name}`, category: ROLE_CAT[role], source: 'synth', render, kit: c.id, extra: `${c.name} kit ${ROLE_LABEL[role]}`, ...extra });
  mk('kick', kick({ ...c.kick, seed: seed('kick') }), 'kick');
  mk('snare', snare({ ...c.snare, seed: seed('snare') }), 'snare');
  mk('clap', clap({ ...c.clap, seed: seed('clap') }), 'clap');
  mk('chh', hat({ ...c.chh, seed: seed('chh') }), 'closed hat');
  mk('ohh', hat({ ...c.ohh, seed: seed('ohh') }), 'open hat');
  mk('tomL', tom({ ...c.tom, seed: seed('tomL') }), 'low tom');
  mk('tomM', tom({ ...c.tom, pitch: c.tom.pitch * 1.33, decay: c.tom.decay * 0.85, seed: seed('tomM') }), 'mid tom');
  mk('tomH', tom({ ...c.tom, pitch: c.tom.pitch * 1.78, decay: c.tom.decay * 0.7, seed: seed('tomH') }), 'high tom');
  mk('rim', perc({ ...c.rim, seed: seed('rim') }), PERC_NAME[c.rim.kind].toLowerCase());
  mk('shaker', perc({ ...c.shaker, seed: seed('shaker') }), PERC_NAME[c.shaker.kind].toLowerCase());
  mk('percA', perc({ ...c.percA, seed: seed('percA') }), PERC_NAME[c.percA.kind].toLowerCase());
  mk('percB', perc({ ...c.percB, seed: seed('percB') }), PERC_NAME[c.percB.kind].toLowerCase());
  mk('crash', cymbal({ ...c.crash, seed: seed('crash') }), 'crash');
  mk('ride', cymbal({ ...c.ride, seed: seed('ride') }), 'ride');
  mk('bass', bass(c.bass.kind, c.bass.note, seed('bass')), `${BASS_NAME[c.bass.kind].toLowerCase()} ${noteName(c.bass.note)}`, { key: keyOf(c.bass.note, true) });
  if ('fx' in c.stab) mk('stab', fx({ kind: c.stab.fx, length: c.stab.length, tune: 1, seed: seed('stab') }), FX_NAME[c.stab.fx].toLowerCase(), { category: 'fx' });
  else {
    const ch = CHORDS[c.stab.chord];
    mk('stab', stab(c.stab.tone, c.stab.chord, c.stab.root, seed('stab')), `${ch.label.toLowerCase()} stab ${NOTE[c.stab.root % 12]}`, { key: keyOf(c.stab.root, ch.minor) });
  }
}
CHARACTERS.forEach(addCharacter);

/* ── Single sounds, walked across their parameters ──────────────────────── */

for (const [pitch, pName] of [
  [40, 'Sub'],
  [47, 'Deep'],
  [55, 'Mid'],
  [64, 'High'],
] as const) {
  for (const [decay, dName] of [
    [0.16, 'tight'],
    [0.32, 'round'],
    [0.7, 'long'],
  ] as const) {
    for (const [style, sName] of [
      ['clean', ''],
      ['click', ' click'],
      ['drive', ' driven'],
    ] as const) {
      const id = `syn:kick:${pitch}-${decay}-${style}`;
      add({
        id,
        name: `${pName} ${dName}${sName} kick`,
        category: 'kick',
        source: 'synth',
        render: kick({ pitch, sweep: style === 'click' ? 260 : 140, bend: decay > 0.5 ? 0.05 : 0.03, decay, click: style === 'click' ? 0.8 : 0.25, drive: style === 'drive' ? 0.6 : 0, seed: hash(id) }),
      });
    }
  }
}

for (const [tone, tName] of [
  [165, 'Fat'],
  [210, 'Crack'],
  [270, 'Piccolo'],
] as const) {
  for (const [color, cName] of [
    [2600, 'dark'],
    [4500, 'bright'],
    [7200, 'air'],
  ] as const) {
    for (const [len, lName] of [
      [0.09, 'short'],
      [0.2, 'long'],
    ] as const) {
      const id = `syn:snare:${tone}-${color}-${len}`;
      add({ id, name: `${tName} ${cName} snare, ${lName}`, category: 'snare', source: 'synth', render: snare({ tone, toneDecay: len * 0.5, noiseDecay: len, color, mix: 0.65, seed: hash(id) }) });
    }
  }
}

for (const bursts of [2, 3, 4]) {
  for (const [decay, dName] of [
    [0.08, 'dry'],
    [0.15, 'room'],
    [0.3, 'hall'],
  ] as const) {
    for (const [color, cName] of [
      [1100, 'warm'],
      [1800, 'bright'],
    ] as const) {
      const id = `syn:clap:${bursts}-${decay}-${color}`;
      add({ id, name: `${cName[0].toUpperCase()}${cName.slice(1)} ${dName} clap ×${bursts}`, category: 'clap', source: 'synth', render: clap({ bursts, spread: 0.011, decay, color, seed: hash(id) }) });
    }
  }
}

for (const [open, oName] of [
  [false, 'closed'],
  [true, 'open'],
] as const) {
  for (const [metal, mName] of [
    [300, 'Dark'],
    [420, 'Classic'],
    [580, 'Bright'],
  ] as const) {
    for (const [noise, nName] of [
      [0.15, 'metal'],
      [0.65, 'noise'],
    ] as const) {
      for (const [cut, cName] of [
        [6500, ''],
        [9500, ' thin'],
      ] as const) {
        const id = `syn:hat:${open ? 'o' : 'c'}-${metal}-${noise}-${cut}`;
        add({ id, name: `${mName} ${nName}${cName} ${oName} hat`, category: 'hat', source: 'synth', render: hat({ decay: open ? 0.3 : 0.045, metal, noise, cut, seed: hash(id) }) });
      }
    }
  }
}

for (const [kind, decay, metal, ping] of [
  ['crash', 1.4, 420, 0],
  ['crash', 0.9, 560, 0],
  ['crash', 2, 360, 0],
  ['ride', 1.1, 480, 0.6],
  ['ride', 0.8, 560, 0.4],
  ['ride', 1.6, 400, 0.8],
  ['china', 1, 700, 0],
  ['splash', 0.5, 620, 0],
  ['bell ride', 1.2, 500, 1],
] as const) {
  const id = `syn:cym:${kind}-${decay}-${metal}`;
  add({ id, name: `${kind[0].toUpperCase()}${kind.slice(1)} ${decay >= 1.5 ? 'long' : decay <= 0.6 ? 'short' : ''} cymbal`.replace(/\s+/g, ' '), category: 'cymbal', source: 'synth', render: cymbal({ decay, metal, ping, seed: hash(id) }) });
}

for (const pitch of [70, 90, 110, 130, 160, 190, 230, 280]) {
  for (const [decay, dName] of [
    [0.22, 'tight'],
    [0.45, 'deep'],
  ] as const) {
    const id = `syn:tom:${pitch}-${decay}`;
    add({ id, name: `Tom ${pitch} Hz, ${dName}`, category: 'tom', source: 'synth', render: tom({ pitch, decay, drop: 0.4, stick: 0.3, seed: hash(id) }) });
  }
}

for (const kind of Object.keys(PERC_NAME) as PercKind[]) {
  for (const [tune, tName] of [
    [0.8, 'low'],
    [1, ''],
    [1.25, 'high'],
  ] as const) {
    const id = `syn:perc:${kind}-${tune}`;
    add({ id, name: `${PERC_NAME[kind]}${tName ? `, ${tName}` : ''}`, category: kind === 'snap' ? 'clap' : 'perc', source: 'synth', render: perc({ kind, tune, length: 1, seed: hash(id) }) });
  }
}

/* ── Tonal sounds, in every key ─────────────────────────────────────────── */

const BASS_OCTAVE: Record<BassKind, number> = { sub: 24, reese: 36, acid: 36, pluck: 36, growl: 36 };
for (const kind of Object.keys(BASS_NAME) as BassKind[]) {
  for (let pc = 0; pc < 12; pc++) {
    const note = BASS_OCTAVE[kind] + pc;
    const id = `syn:bass:${kind}-${note}`;
    add({ id, name: `${BASS_NAME[kind]} ${noteName(note)}`, category: 'bass', source: 'synth', key: keyOf(note, true), render: bass(kind, note, hash(id)) });
  }
}

const STAB_TONE: Record<ChordKind, StabTone> = { min: 'rave', min7: 'house', min9: 'dub', maj7: 'organ', maj9: 'house', dom7: 'organ', sus: 'dub', power: 'rave' };
for (const chord of Object.keys(CHORDS) as ChordKind[]) {
  for (let pc = 0; pc < 12; pc++) {
    const root = 48 + pc;
    const tone = STAB_TONE[chord];
    const id = `syn:stab:${chord}-${root}`;
    const ch = CHORDS[chord];
    add({
      id,
      name: `${STAB_NAME[tone]} ${ch.label.toLowerCase()} · ${NOTE[pc]}${ch.minor ? 'm' : ''}`,
      category: 'stab',
      source: 'synth',
      key: keyOf(root, ch.minor),
      render: stab(tone, chord, root, hash(id)),
      extra: 'chord',
    });
  }
}

for (const tone of Object.keys(KEYS_NAME) as KeysTone[]) {
  for (let pc = 0; pc < 12; pc++) {
    const note = (tone === 'pad' ? 48 : 60) + pc;
    const id = `syn:keys:${tone}-${note}`;
    add({ id, name: `${KEYS_NAME[tone]} ${noteName(note)}`, category: 'keys', source: 'synth', key: keyOf(note, true), render: keys(tone, note, hash(id)) });
  }
}

/* ── FX and vox ─────────────────────────────────────────────────────────── */

const FX_LENGTHS: Record<FxKind, number[]> = {
  riser: [1, 2, 4, 8],
  downlifter: [1, 2, 4, 6],
  impact: [1.2, 2, 3, 4],
  laser: [0.25, 0.4, 0.7, 1.2],
  siren: [1, 2, 3, 4],
  horn: [0.4, 0.8, 1.2, 1.6],
  rewind: [0.5, 0.9, 1.4, 2],
  sweep: [1, 2, 4, 8],
  noise: [1, 2, 3, 5],
  drop: [0.8, 1.5, 2.5, 4],
  stutter: [0.5, 1, 1.5, 2],
  alarm: [1, 2, 3, 4],
};
for (const kind of Object.keys(FX_NAME) as FxKind[]) {
  FX_LENGTHS[kind].forEach((length, i) => {
    const tune = [1, 0.85, 1.2, 0.7][i];
    const id = `syn:fx:${kind}-${length}`;
    add({ id, name: `${FX_NAME[kind]}, ${length < 1 ? `${Math.round(length * 1000)} ms` : `${length} s`}`, category: 'fx', source: 'synth', seconds: length, render: fx({ kind, length, tune, seed: hash(id) }) });
  });
}

for (const vowel of VOWEL_NAMES) {
  for (const note of [48, 55, 60, 67]) {
    const id = `syn:vox:${vowel}-${note}`;
    add({ id, name: `Vox "${vowel}" ${noteName(note)}`, category: 'vox', source: 'synth', key: keyOf(note, true), render: vox(vowel, note, false, hash(id)), extra: 'vocal choir' });
  }
  const id = `syn:vox:shout-${vowel}`;
  add({ id, name: `Shout "h${vowel}!"`, category: 'vox', source: 'synth', render: vox(vowel, 57, true, hash(id)), extra: 'vocal hey' });
}

/* ── CC0 recordings ─────────────────────────────────────────────────────── */

for (const [file, name, category, seconds, author, key] of CC0) {
  add({ id: `cc0:${file}`, name, category: category as Category, source: 'cc0', file, seconds, credit: author, ...(key ? { key } : {}), extra: file.replace(/_/g, ' ') });
}

/** Every built-in sound (yours are added by the sampler). */
export const LIBRARY: readonly SoundInfo[] = sounds;
export const BUILT_IN_COUNT = sounds.length;

export function getSound(id: string): SoundInfo | undefined {
  return byId.get(id);
}

export function registerUserSound(info: Omit<SoundInfo, 'words' | 'source'>) {
  const existing = byId.get(info.id);
  if (existing) {
    const i = sounds.indexOf(existing);
    if (i >= 0) sounds.splice(i, 1);
  }
  return add({ ...info, source: 'user' });
}

export function unregisterUserSound(id: string) {
  const s = byId.get(id);
  if (!s || s.source !== 'user') return;
  byId.delete(id);
  const i = sounds.indexOf(s);
  if (i >= 0) sounds.splice(i, 1);
}

/** Guesses a category from a file name, for your own sounds. */
export function guessCategory(name: string): Category {
  const n = name.toLowerCase();
  const rules: [RegExp, Category][] = [
    [/kick|\bbd\b|bassdrum|bass drum/, 'kick'],
    [/snare|\bsd\b|\bsn\b/, 'snare'],
    [/clap|snap|\bcp\b/, 'clap'],
    [/hat|\bhh\b|\boh\b|\bch\b/, 'hat'],
    [/crash|ride|cymbal|splash|china/, 'cymbal'],
    [/tom/, 'tom'],
    [/loop|break|beat/, 'loop'],
    [/bass|sub|808/, 'bass'],
    [/stab|chord/, 'stab'],
    [/vox|vocal|voice|shout|acapella/, 'vox'],
    [/piano|key|pluck|guitar|string|bell/, 'keys'],
    [/riser|sweep|fx|impact|horn|siren|laser|noise|rewind|scratch/, 'fx'],
    [/perc|shaker|conga|bongo|cowbell|rim|clave|tamb/, 'perc'],
    [/pad|drone|ambi|texture|atmo/, 'texture'],
  ];
  return rules.find(([re]) => re.test(n))?.[1] ?? 'fx';
}
