import { CHARACTERS, KIT_ROLES, type Role } from './characters';
import { charSoundId } from './catalog';

/**
 * Kits: sixteen sounds laid out so a groove lands on the same pads in every
 * kit (kick on 1, snare on 2, hats on 4 and 5…). Loading a kit fills one
 * bank; the closed hat chokes the open one, like a real hi-hat.
 */

export interface KitPad {
  sound: string;
  role: Role;
}

export interface Kit {
  id: string;
  name: string;
  blurb: string;
  hue: number;
  source: 'synth' | 'cc0' | 'mixed';
  pads: KitPad[];
}

const fromCharacters: Kit[] = CHARACTERS.map((c) => ({
  id: c.id,
  name: c.name,
  blurb: c.blurb,
  hue: c.hue,
  source: 'synth',
  pads: KIT_ROLES.map((role) => ({ role, sound: charSoundId(c, role) })),
}));

const cc0 = (files: string[]): KitPad[] => files.map((f, i) => ({ role: KIT_ROLES[i], sound: f.includes(':') ? f : `cc0:${f}` }));

export const KITS: Kit[] = [
  {
    id: 'djtools',
    name: 'DJ Tools',
    blurb: 'The original eight (horn, siren, laser…) plus vinyl tricks, risers and impacts.',
    hue: 48,
    source: 'mixed',
    pads: [
      'syn:classic:horn',
      'syn:classic:siren',
      'syn:classic:laser',
      'syn:classic:rewind',
      'syn:classic:clap',
      'syn:classic:riser',
      'syn:classic:boom',
      'syn:classic:stab',
      'cc0:vinyl_backspin',
      'cc0:vinyl_rewind',
      'cc0:vinyl_scratch',
      'syn:fx:horn-1.2',
      'syn:fx:riser-4',
      'syn:fx:downlifter-2',
      'syn:fx:impact-3',
      'cc0:misc_cineboom',
    ].map((sound) => ({ sound, role: 'fx' as Role })),
  },
  ...fromCharacters,
  {
    id: 'acoustic',
    name: 'Acoustic Room',
    blurb: 'A real drum kit recorded in a room. Public-domain samples.',
    hue: 25,
    source: 'cc0',
    pads: cc0([
      'drum_heavy_kick',
      'drum_snare_hard',
      'perc_snap',
      'drum_cymbal_closed',
      'drum_cymbal_open',
      'drum_tom_lo_hard',
      'drum_tom_mid_hard',
      'drum_tom_hi_hard',
      'drum_snare_soft',
      'drum_cymbal_pedal',
      'drum_cowbell',
      'perc_snap2',
      'drum_splash_hard',
      'ride_tri',
      'bass_woodsy_c',
      'guit_em9',
    ]),
  },
  {
    id: 'street',
    name: 'Street Samples',
    blurb: 'Hand-picked recorded kicks, snares and hats for hip-hop and house.',
    hue: 10,
    source: 'cc0',
    pads: cc0([
      'bd_haus',
      'sn_dolf',
      'perc_snap2',
      'hat_snap',
      'hat_cats',
      'drum_tom_lo_soft',
      'drum_tom_mid_soft',
      'drum_tom_hi_soft',
      'sn_dub',
      'hat_tap',
      'elec_wood',
      'perc_till',
      'drum_splash_soft',
      'ride_via',
      'bass_hard_c',
      'syn:stab:min9-50',
    ]),
  },
  {
    id: 'eleclab',
    name: 'Electric Lab',
    blurb: 'Bleeps, blips and electronic drums. Public-domain samples.',
    hue: 160,
    source: 'cc0',
    pads: cc0([
      'elec_soft_kick',
      'elec_snare',
      'elec_filt_snare',
      'elec_tick',
      'hat_metal',
      'elec_fuzz_tom',
      'elec_bong',
      'elec_pop',
      'elec_wood',
      'elec_twip',
      'elec_blip',
      'elec_ping',
      'elec_cymbal',
      'elec_chime',
      'glitch_bass_g',
      'elec_bell',
    ]),
  },
  {
    id: 'tabla',
    name: 'Tabla Bols',
    blurb: 'Sixteen strokes of the tabla, for hand-drum grooves.',
    hue: 35,
    source: 'cc0',
    pads: cc0([
      'tabla_ghe1',
      'tabla_na',
      'tabla_tas1',
      'tabla_te1',
      'tabla_tun1',
      'tabla_ghe4',
      'tabla_ghe6',
      'tabla_ke1',
      'tabla_na_o',
      'tabla_te2',
      'tabla_tas2',
      'tabla_re',
      'tabla_tun3',
      'tabla_dhec',
      'tabla_ghe8',
      'tabla_te_ne',
    ]),
  },
  {
    id: 'glitch',
    name: 'Glitch Box',
    blurb: 'Broken percussion, robots and phones. Public-domain samples.',
    hue: 190,
    source: 'cc0',
    pads: cc0([
      'bd_chip',
      'glitch_perc1',
      'glitch_perc2',
      'hat_zap',
      'hat_noiz',
      'glitch_perc3',
      'glitch_perc4',
      'glitch_perc5',
      'mehackit_phone1',
      'mehackit_phone2',
      'glitch_robot1',
      'glitch_robot2',
      'mehackit_robot1',
      'mehackit_robot2',
      'glitch_bass_g',
      'mehackit_robot3',
    ]),
  },
];

export const getKit = (id: string) => KITS.find((k) => k.id === id);

/** Banks A–D start with these. A keeps the original eight on pads 1–8. */
export const DEFAULT_BANK_KITS = ['djtools', 'warehouse', 'boombap', 'trapnight'];
