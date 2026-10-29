import { emptyCues, type TrackRecord } from './types';

/**
 * Two demo tracks, synthesised in the browser so there is something to mix
 * before anyone drops in a file — and nothing to license or download. Each is
 * a 64-bar arrangement (intro, build, drop, breakdown, drop, outro) at a
 * different tempo, so SYNC has real work to do.
 *
 * The voices write samples straight into Float32Arrays. An OfflineAudioContext
 * graph was the obvious first try, but every scheduled node costs every render
 * quantum until it ends, and a track's few thousand notes took minutes to
 * render. Plain loops take well under a second. A seeded PRNG keeps every
 * render identical.
 */

interface DemoSpec {
  id: string;
  title: string;
  bpm: number;
  bars: number;
}

export const DEMOS: DemoSpec[] = [
  { id: 'demo-night-bus', title: 'Night Bus', bpm: 124, bars: 64 },
  { id: 'demo-paper-lanterns', title: 'Paper Lanterns', bpm: 128, bars: 64 },
];

const DEMO_ARTIST = 'Demo · synthesised in your browser';

export function demoRecords(): TrackRecord[] {
  return DEMOS.map((d, i) => ({
    id: d.id,
    title: d.title,
    artist: DEMO_ARTIST,
    fileName: '',
    duration: (d.bars * 4 * 60) / d.bpm,
    bpm: d.bpm,
    gridOffset: 0,
    peaks: null,
    art: null,
    blob: null,
    demo: d.id,
    cues: emptyCues(),
    // Before any real track, so demos sit at the top of the crate.
    addedAt: i,
    // Tempo and grid are known by construction; the waveform is drawn the
    // first time the track is rendered onto a deck.
    status: 'ready',
  }));
}

/* ── Voices ──────────────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Attack-then-exponential-decay envelope at τ seconds into a note. */
function env(tau: number, attack: number, decay: number) {
  return tau < attack ? tau / attack : Math.exp(-(tau - attack) / decay);
}

class Synth {
  readonly L: Float32Array<ArrayBuffer>;
  readonly R: Float32Array<ArrayBuffer>;
  private rand: () => number;

  constructor(
    private sr: number,
    length: number,
    seed: number,
  ) {
    this.L = new Float32Array(length);
    this.R = new Float32Array(length);
    this.rand = mulberry32(seed);
  }

  /** Mixes `fn(τ)` into the output for `length` seconds from `t`. */
  private voice(t: number, length: number, pan: number, fn: (tau: number) => number) {
    const start = Math.round(t * this.sr);
    const end = Math.min(this.L.length, start + Math.round(length * this.sr));
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = start; i < end; i++) {
      const v = fn((i - start) / this.sr);
      this.L[i] += v * gl;
      this.R[i] += v * gr;
    }
  }

  kick(t: number, gain = 1) {
    let phase = 0;
    const sr = this.sr;
    this.voice(t, 0.45, 0, (tau) => {
      phase += (TAU * (46 + 110 * Math.exp(-tau / 0.03))) / sr;
      return Math.sin(phase) * env(tau, 0.003, 0.13) * gain;
    });
  }

  /** Noise through a one-pole high-pass: hats. */
  hat(t: number, decay: number, gain: number, pan = 0) {
    const a = Math.exp((-TAU * 7000) / this.sr);
    let y = 0;
    let prev = 0;
    this.voice(t, decay * 6, pan, (tau) => {
      const x = this.rand() * 2 - 1;
      y = a * (y + x - prev);
      prev = x;
      return y * env(tau, 0.001, decay) * gain;
    });
  }

  /** Band-limited noise in three quick bursts and a tail. */
  clap(t: number, gain: number) {
    const hp = Math.exp((-TAU * 900) / this.sr);
    const lp = Math.exp((-TAU * 2600) / this.sr);
    let h = 0;
    let prev = 0;
    let l = 0;
    this.voice(t, 0.3, 0, (tau) => {
      const x = this.rand() * 2 - 1;
      h = hp * (h + x - prev);
      prev = x;
      l = h + lp * (l - h);
      const burst = tau < 0.033 ? env(tau % 0.011, 0.0005, 0.004) : env(tau - 0.022, 0, 0.06);
      return l * burst * gain * 2.2;
    });
  }

  /**
   * Detuned saws through a Chamberlin state-variable low-pass whose cutoff
   * glides from `from` to `to` Hz. Bass, stabs and pads are all this voice.
   */
  saws(
    t: number,
    notes: number[],
    length: number,
    o: { gain: number; from: number; to: number; q: number; attack: number; decay: number; pan?: number; detune?: number },
  ) {
    const freqs = notes.flatMap((n) => {
      const f = hz(n);
      const d = o.detune ?? 0;
      return d ? [f * 2 ** (-d / 1200), f * 2 ** (d / 1200)] : [f];
    });
    const phases = freqs.map((_, i) => (i * 0.37) % 1);
    const sr = this.sr;
    const norm = 1 / Math.sqrt(freqs.length);
    let low = 0;
    let band = 0;
    this.voice(t, length, o.pan ?? 0, (tau) => {
      let x = 0;
      for (let k = 0; k < freqs.length; k++) {
        phases[k] += freqs[k] / sr;
        if (phases[k] >= 1) phases[k] -= 1;
        x += 2 * phases[k] - 1;
      }
      x *= norm;
      const fc = o.from * (o.to / o.from) ** Math.min(1, tau / length);
      const f = 2 * Math.sin((Math.PI * Math.min(fc, sr / 8)) / sr);
      low += f * band;
      const high = x - low - band / o.q;
      band += f * high;
      return low * env(tau, o.attack, o.decay) * o.gain;
    });
  }

  pluck(t: number, midi: number, gain: number, pan: number) {
    const f0 = hz(midi);
    let phase = 0;
    let low = 0;
    const sr = this.sr;
    this.voice(t, 0.5, pan, (tau) => {
      phase = (phase + f0 / sr) % 1;
      const x = phase < 0.5 ? 1 : -1;
      const a = Math.exp((-TAU * (400 + 2800 * Math.exp(-tau / 0.06))) / sr);
      low = x + a * (low - x);
      return low * env(tau, 0.002, 0.09) * gain;
    });
  }

  /** Gentle saturation and a peak normalise, standing in for a mastering chain. */
  finish() {
    let peak = 0;
    for (const ch of [this.L, this.R]) {
      for (let i = 0; i < ch.length; i++) {
        ch[i] = Math.tanh(ch[i] * 1.2);
        peak = Math.max(peak, Math.abs(ch[i]));
      }
    }
    const g = peak > 0 ? 0.89 / peak : 1;
    for (const ch of [this.L, this.R]) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }
}

/* ── Arrangements ────────────────────────────────────────────────────────── */

type Section = 'intro' | 'build' | 'drop' | 'break' | 'outro';

function section(bar: number): Section {
  if (bar < 8) return 'intro';
  if (bar < 16) return 'build';
  if (bar < 32) return 'drop';
  if (bar < 40) return 'break';
  if (bar < 56) return 'drop';
  return 'outro';
}

/** Night Bus — 124 BPM, A minor: four-to-the-floor, off-beat bass, stabs. */
function nightBusBar(s: Synth, beat: number, bar: number) {
  const prog = [
    { root: 33, chord: [57, 60, 64, 67] }, // Am7
    { root: 29, chord: [53, 57, 60, 64] }, // Fmaj7
    { root: 26, chord: [50, 53, 57, 60] }, // Dm7
    { root: 28, chord: [52, 55, 59, 62] }, // Em7
  ];
  const sec = section(bar);
  const t0 = bar * 4 * beat;
  const { root, chord } = prog[Math.floor(bar / 2) % prog.length];
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * beat;
    if (sec !== 'break') s.kick(t, 0.95);
    if (sec !== 'intro' && sec !== 'break') s.hat(t + beat / 2, 0.06, 0.32, 0.2);
    for (let x = 0; x < 4; x++) {
      if (sec === 'break' && x % 2) continue;
      s.hat(t + (x * beat) / 4, 0.012, x % 2 ? 0.12 : 0.2, -0.25);
    }
    if ((sec === 'drop' || sec === 'outro') && b % 2) s.clap(t, 0.5);
    if (sec !== 'intro' && sec !== 'break') {
      s.saws(t + beat / 2, [root + 12], beat * 0.45, { gain: 0.55, from: 900, to: 220, q: 2.5, attack: 0.004, decay: 0.12 });
    }
    if (sec === 'drop') {
      s.saws(t + beat * 0.75, chord, beat * 0.4, { gain: 0.2, from: 2600, to: 900, q: 1.4, attack: 0.004, decay: 0.07, detune: 8 });
    }
  }
  if (sec === 'break' && bar % 2 === 0) {
    const into = (bar - 32) / 8;
    s.saws(t0, chord, 8 * beat, { gain: 0.16, from: 300 + into * 900, to: 900 + into * 2400, q: 2, attack: 1.2, decay: 2.5, detune: 9 });
  }
  if (bar >= 40 && bar < 56) {
    const arp = [chord[0] + 12, chord[2] + 12, chord[1] + 12, chord[3] + 12];
    for (let x = 0; x < 8; x++) s.pluck(t0 + (x * beat) / 2, arp[x % 4], 0.1, x % 2 ? 0.45 : -0.45);
  }
}

/** Paper Lanterns — 128 BPM, F minor: rolling bass, shuffled hats, plucks. */
function paperLanternsBar(s: Synth, beat: number, bar: number) {
  const roots = [29, 29, 32, 27]; // F, F, A♭, E♭
  const chords = [
    [53, 56, 60],
    [53, 56, 60],
    [56, 60, 63],
    [51, 55, 58],
  ];
  const swing = beat * 0.04;
  const sec = section(bar);
  const t0 = bar * 4 * beat;
  const i = Math.floor(bar / 4) % roots.length;
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * beat;
    if (sec !== 'break') s.kick(t, 1);
    for (let x = 0; x < 4; x++) {
      if (sec === 'intro' && x !== 2) continue;
      const tt = t + (x * beat) / 4 + (x % 2 ? swing : 0);
      s.hat(tt, x === 2 ? 0.045 : 0.01, x === 2 ? 0.3 : 0.12, 0.3);
    }
    if ((sec === 'drop' || sec === 'outro') && b % 2) s.clap(t + swing, 0.45);
    if (sec === 'build' || sec === 'drop') {
      // Rolling bass: the three sixteenths after each kick.
      for (let x = 1; x < 4; x++) {
        s.saws(t + (x * beat) / 4, [roots[i] + 12 + (x === 3 ? 12 : 0)], beat * 0.22, { gain: 0.45, from: 1200, to: 260, q: 3, attack: 0.003, decay: 0.06 });
      }
    }
  }
  if (sec === 'drop' || sec === 'break') {
    const notes = chords[i];
    for (let x = 0; x < 16; x++) {
      if (x % 3 === 2) continue;
      s.pluck(t0 + (x * beat) / 4, notes[x % notes.length] + 12, sec === 'break' ? 0.12 : 0.09, x % 2 ? 0.5 : -0.3);
    }
  }
  if (sec === 'break' && bar % 4 === 0) {
    s.saws(t0, chords[i], 16 * beat, { gain: 0.14, from: 400, to: 2200, q: 2.2, attack: 2, decay: 5, detune: 10 });
  }
}

/** Renders a demo track at the given sample rate, yielding to the UI every
 *  few bars so a deck that's already playing keeps drawing. */
export async function renderDemo(id: string, sampleRate: number): Promise<AudioBuffer> {
  const spec = DEMOS.find((d) => d.id === id);
  if (!spec) throw new Error(`Unknown demo: ${id}`);
  const beat = 60 / spec.bpm;
  const length = Math.ceil(spec.bars * 4 * beat * sampleRate);
  const synth = new Synth(sampleRate, length, spec.bpm);
  const bar = id === 'demo-night-bus' ? nightBusBar : paperLanternsBar;
  for (let b = 0; b < spec.bars; b++) {
    bar(synth, beat, b);
    if (b % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  synth.finish();
  const buf = new AudioBuffer({ length, numberOfChannels: 2, sampleRate });
  buf.copyToChannel(synth.L, 0);
  buf.copyToChannel(synth.R, 1);
  return buf;
}
