/**
 * Beat FX — one shared unit, the way a club mixer has one Beat FX section
 * that you point at a channel or at the master. The unit plugs into an
 * insert slot (FxSlot) on deck A's channel, deck B's channel or the master
 * bus; the engine owns the slots and the unit (engine.ts), and BeatFx
 * (beatfx.ts) drives it: tempo, tap, quantize, the X-pad.
 *
 * Inside the unit the signal is split at the mixer's EQ crossovers. The bands
 * you pick go through the effect; the others pass dry. With all three picked
 * there's no split at all, so the unit is transparent at rest.
 *
 *   input ─┬─ whole ────────────────┐
 *          ├─ low ──┬─ sel ─────────┼─ core ─┬─ gate ─ dry ────────────────┬─ output
 *          ├─ mid ──┤               │        └─ send ─ [effect] ─ wet ─────┤
 *          └─ high ─┴─ pass (dry) ──┴──────────────────────────────────────┘
 *
 * Times are in beats of the tempo the controller gives (setBpm), so a 3/4
 * echo stays 3/4 of a beat when the pitch fader moves. The delays, reverb,
 * flanger and phaser are sends whose tails ring out after "off"; Trans,
 * Filter, Mobius, Roll and Crush take the dry sound's place by the level.
 * On/off and beat changes can be scheduled for a future context time — the
 * next beat, with quantize on.
 */

import { EQ_HIGH_HZ, EQ_LOW_HZ } from './eq';

export type FxType =
  | 'delay'
  | 'echo'
  | 'pingpong'
  | 'spiral'
  | 'reverb'
  | 'helix'
  | 'roll'
  | 'triroll'
  | 'flanger'
  | 'phaser'
  | 'filter'
  | 'trifilter'
  | 'mobius'
  | 'trans'
  | 'crush';

export interface FxBands {
  low: boolean;
  mid: boolean;
  high: boolean;
}

export const ALL_BANDS: FxBands = { low: true, mid: true, high: true };

/** What the X-pad's drag slides, per effect. */
export type FxXParam = 'Feedback' | 'Tone' | 'Resonance' | 'Width' | 'Level';

export type FxGroup = 'Delays' | 'Loops' | 'Sweeps' | 'Chops';

export interface FxMeta {
  id: FxType;
  label: string;
  group: FxGroup;
  /** Beat values the < > buttons step through. */
  beats: readonly number[];
  /** Beat values on the X-pad, eight at most. */
  pad: readonly number[];
  defaultBeats: number;
  x: FxXParam;
  /** False for Crush, which has no timing. */
  timed: boolean;
  /** What it does, for the guide. */
  hint: string;
}

const STRAIGHT = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16] as const;
const STRAIGHT_PAD = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8] as const;
const TRIPLET = [1 / 12, 1 / 6, 1 / 3, 2 / 3, 4 / 3, 8 / 3, 16 / 3] as const;
const TRIPLET_PAD = [1 / 12, 1 / 6, 1 / 3, 2 / 3, 4 / 3, 8 / 3] as const;
const SWEEP = [1 / 4, 1 / 2, 1, 2, 4, 8, 16] as const;

const meta = (
  id: FxType,
  label: string,
  group: FxGroup,
  beats: readonly number[],
  pad: readonly number[],
  defaultBeats: number,
  x: FxXParam,
  hint: string,
  timed = true,
): FxMeta => ({ id, label, group, beats, pad, defaultBeats, x, timed, hint });

export const FX_META: Record<FxType, FxMeta> = {
  delay: meta('delay', 'Delay', 'Delays', STRAIGHT, STRAIGHT_PAD, 1, 'Tone', 'one repeat, the beat value later'),
  echo: meta('echo', 'Echo', 'Delays', STRAIGHT, STRAIGHT_PAD, 3 / 4, 'Feedback', 'repeats that fade and darken'),
  pingpong: meta('pingpong', 'Ping Pong', 'Delays', STRAIGHT, STRAIGHT_PAD, 1 / 2, 'Feedback', 'repeats that bounce left, right, left'),
  spiral: meta('spiral', 'Spiral', 'Delays', STRAIGHT, STRAIGHT_PAD, 3 / 4, 'Feedback', 'an echo whose every repeat climbs a semitone; a beat change swoops like tape'),
  reverb: meta('reverb', 'Reverb', 'Delays', STRAIGHT, STRAIGHT_PAD, 1, 'Tone', 'a room, sized by the beat value'),
  helix: meta('helix', 'Helix', 'Loops', STRAIGHT, STRAIGHT_PAD, 1 / 2, 'Tone', 'freezes the last beat value of sound and holds it over the music while on; it fades out when you turn it off'),
  roll: meta('roll', 'Roll', 'Loops', STRAIGHT, STRAIGHT_PAD, 1 / 4, 'Level', 'repeats the last beat value of sound in place of the music while on'),
  triroll: meta('triroll', 'Triplet Roll', 'Loops', TRIPLET, TRIPLET_PAD, 1 / 3, 'Level', 'Roll in triplet lengths'),
  flanger: meta('flanger', 'Flanger', 'Sweeps', SWEEP, SWEEP, 2, 'Resonance', 'a jet-plane sweep, one per beat value'),
  phaser: meta('phaser', 'Phaser', 'Sweeps', SWEEP, SWEEP, 2, 'Width', 'moving notches, one sweep per beat value'),
  filter: meta('filter', 'Filter', 'Sweeps', SWEEP, SWEEP, 2, 'Resonance', 'a band filter swept up and back down once per beat value'),
  trifilter: meta('trifilter', 'Triplet Filter', 'Sweeps', TRIPLET, TRIPLET_PAD, 2 / 3, 'Resonance', 'a band filter that falls once per triplet beat value'),
  mobius: meta('mobius', 'Mobius', 'Sweeps', SWEEP, SWEEP, 2, 'Resonance', 'an endless sweep that keeps rising (+) or falling (−), an octave per beat value'),
  trans: meta('trans', 'Trans', 'Chops', STRAIGHT, STRAIGHT_PAD, 1 / 4, 'Level', 'chops the sound on and off on the beat'),
  crush: meta('crush', 'Crush', 'Chops', STRAIGHT, STRAIGHT_PAD, 1, 'Level', 'lo-fi, fewer bits; it has no timing', false),
};

export const FX_TYPES: FxMeta[] = Object.values(FX_META);
export const FX_GROUPS: readonly FxGroup[] = ['Delays', 'Loops', 'Sweeps', 'Chops'];

export function isFxType(v: unknown): v is FxType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FX_META, v);
}

/** Every effect's beat value, as first set. */
export function defaultFxBeats(): Record<FxType, number> {
  const out = {} as Record<FxType, number>;
  for (const m of FX_TYPES) out[m.id] = m.defaultBeats;
  return out;
}

/** What the unit is told to do. */
export interface FxParams {
  type: FxType;
  beats: number;
  /** 0–1: the effect's level (sends) or how much it takes the dry sound's place. */
  depth: number;
  on: boolean;
  /** The X-pad's slide, 0–1, while dragging; null otherwise. */
  x: number | null;
  bands: FxBands;
  /** Mobius: +1 rising, −1 falling. */
  dir: 1 | -1;
}

export function defaultFxParams(): FxParams {
  return { type: 'echo', beats: 3 / 4, depth: 0, on: false, x: null, bands: { ...ALL_BANDS }, dir: 1 };
}

/** "1/16", "3/4", "2/3", "4/3", "8". */
export function beatsLabel(b: number) {
  if (Number.isInteger(b)) return String(b);
  for (const d of [2, 3, 4, 6, 8, 12, 16]) {
    const n = b * d;
    if (Math.abs(n - Math.round(n)) < 1e-6) return `${Math.round(n)}/${d}`;
  }
  return String(Math.round(b * 1000) / 1000);
}

/** The value in `list` nearest `b` (for a remembered value no longer offered). */
export function nearestBeats(list: readonly number[], b: number) {
  let best = list[0];
  for (const v of list) if (Math.abs(Math.log(v / b)) < Math.abs(Math.log(best / b))) best = v;
  return best;
}

/** BPM × beats → milliseconds. */
export function beatsMs(bpm: number, beats: number) {
  return (60000 / bpm) * beats;
}

const GLIDE = 0.02;
/** The tempo range the FX time themselves to; taps outside it are clamped. */
export const FX_MIN_BPM = 50;
export const FX_MAX_BPM = 250;
const SECONDS = (beats: number) => (60 / FX_MIN_BPM) * beats + 0.25;
const MAX_STRAIGHT = SECONDS(16);
/** A delay inside a feedback loop can't be shorter than a render quantum. */
const MIN_CYCLE_DELAY = 0.004;
/** Butterworth for the band split. Web Audio reads a low- or high-pass Q in
 *  dB, so 1/√2 is written as its level, −3.01 dB; two in a row make a
 *  Linkwitz–Riley crossover whose bands sum back flat. */
const CROSSOVER_Q = 20 * Math.log10(Math.SQRT1_2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const expLerp = (a: number, b: number, t: number) => a * (b / a) ** t;
const frac = (v: number) => v - Math.floor(v);

/** Noise in an exponential decay, stereo-decorrelated: a plausible room. */
function impulse(ctx: BaseAudioContext, seconds: number) {
  const len = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 1;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (rand() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

/** A staircase transfer curve: fewer steps, fewer bits. */
function crushCurve(bits: number) {
  const n = 4096;
  const curve = new Float32Array(n);
  const steps = 2 ** bits;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

/**
 * An oscillator shape from any function of phase (0–1), as a band-limited
 * PeriodicWave. Phase 0 is the moment the oscillator starts, so shapes built
 * here and started together keep exact phase relations. Web Audio drops the
 * DC term, so shapes need a zero mean; put any offset in the param's value.
 */
function shapeWave(ctx: BaseAudioContext, shape: (phase: number) => number, harmonics = 32) {
  const N = 512;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  const samples = new Float32Array(N);
  for (let n = 0; n < N; n++) samples[n] = shape(n / N);
  for (let k = 1; k <= harmonics; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const a = (2 * Math.PI * k * n) / N;
      re += samples[n] * Math.cos(a);
      im += samples[n] * Math.sin(a);
    }
    real[k] = (2 * re) / N;
    imag[k] = (2 * im) / N;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q = Math.SQRT1_2) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

function sameBands(a: FxBands, b: FxBands) {
  return a.low === b.low && a.mid === b.mid && a.high === b.high;
}

interface Lfo {
  osc: OscillatorNode;
  wave: PeriodicWave | OscillatorType;
  /** One cycle lasts `cycle` × the beat value; ignored with a fixed `hz`. */
  cycle: number;
  hz?: number;
  outs: AudioNode[];
}

interface DelaySpan {
  /** Beats × `mul`, minus `offset` seconds, within `max`. */
  mul: number;
  offset: number;
  max: number;
}

interface TimedDelay extends DelaySpan {
  node: DelayNode;
  /** Glide for a beat change: Spiral's is slow, like tape. */
  tau: number;
}

/** A recording loop: always taking in the last few beats; frozen, it plays them over and over. */
interface Loop {
  delay: DelayNode;
  inGain: GainNode;
  fb: GainNode;
  out: GainNode;
  max: number;
}

interface Range {
  base: number;
  lo: number;
  hi: number;
}

export class FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private whole: GainNode;
  private sel: GainNode[] = [];
  private pass: GainNode[] = [];
  private gate: GainNode;
  private dry: GainNode;
  private send: GainNode;
  private wet: GainNode;
  private nodes: AudioNode[] = [];
  private lfos: Lfo[] = [];
  private delays: TimedDelay[] = [];
  private loop: Loop | null = null;
  private convolver: ConvolverNode | null = null;
  private reverbSeconds = 0;
  private shaper: WaveShaperNode | null = null;
  /** What the X-pad slides, by effect. */
  private fb: (Range & { gain: GainNode }) | null = null;
  private tone: (Range & { filter: BiquadFilterNode }) | null = null;
  private res: (Range & { filters: BiquadFilterNode[] }) | null = null;
  private width: (Range & { gain: GainNode }) | null = null;
  private trans: GainNode | null = null;
  /** Mobius's detune ramps: their sign is the direction. */
  private ramps: GainNode[] = [];
  private rampSpan = 0;
  private state: FxParams = defaultFxParams();
  private bpm = 120;
  /** A pending on/off: until `edgeAt` the unit is still `onBefore`. */
  private edgeAt = 0;
  private onBefore = false;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const core = ctx.createGain();
    this.gate = ctx.createGain();
    this.dry = ctx.createGain();
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;

    // Band split: Linkwitz–Riley, at the isolator EQ's crossovers.
    this.whole = ctx.createGain();
    this.input.connect(this.whole).connect(core);
    const lr = (type: BiquadFilterType, hz: number) => [biquad(ctx, type, hz, CROSSOVER_Q), biquad(ctx, type, hz, CROSSOVER_Q)];
    const bands: AudioNode[][] = [
      lr('lowpass', EQ_LOW_HZ),
      [...lr('highpass', EQ_LOW_HZ), ...lr('lowpass', EQ_HIGH_HZ)],
      lr('highpass', EQ_HIGH_HZ),
    ];
    for (const band of bands) {
      let last: AudioNode = this.input;
      for (const n of band) {
        last.connect(n);
        last = n;
      }
      const sel = ctx.createGain();
      const pass = ctx.createGain();
      sel.gain.value = 0;
      pass.gain.value = 0;
      last.connect(sel).connect(core);
      last.connect(pass).connect(this.output);
      this.sel.push(sel);
      this.pass.push(pass);
    }

    core.connect(this.gate).connect(this.dry).connect(this.output);
    core.connect(this.send);
    this.wet.connect(this.output);
    this.build(this.state.type);
  }

  private seconds(beats = this.state.beats) {
    return (60 / this.bpm) * beats;
  }

  private glide(p: AudioParam, v: number, tau = GLIDE) {
    p.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  /**
   * Sets a param from the unit's on/off state, honouring a pending edge: the
   * "before" value now and the "after" value at the edge, so a knob moved
   * while a quantized switch waits for its beat doesn't jump the gun.
   */
  private sched(p: AudioParam, f: (on: boolean) => number, tau = GLIDE) {
    const now = this.ctx.currentTime;
    p.cancelScheduledValues(now);
    if (this.edgeAt > now) {
      p.setTargetAtTime(f(this.onBefore), now, tau);
      p.setTargetAtTime(f(this.state.on), this.edgeAt, tau);
    } else {
      p.setTargetAtTime(f(this.state.on), now, tau);
    }
  }

  private lfo(wave: PeriodicWave | OscillatorType, outs: AudioNode[], cycle = 1, hz?: number) {
    const o = this.ctx.createOscillator();
    if (typeof wave === 'string') o.type = wave as OscillatorType;
    else o.setPeriodicWave(wave);
    o.frequency.value = hz ?? 1 / (this.seconds() * cycle);
    outs.forEach((n) => o.connect(n));
    this.lfos.push({ osc: o, wave, cycle, hz, outs });
  }

  private delayFor(d: DelaySpan) {
    return Math.max(MIN_CYCLE_DELAY, Math.min(d.max, this.seconds() * d.mul - d.offset));
  }

  private timedDelay(offset = 0, tau = GLIDE) {
    const span: DelaySpan = { mul: 1, offset, max: MAX_STRAIGHT };
    const node = this.ctx.createDelay(span.max);
    node.delayTime.value = this.delayFor(span);
    this.delays.push({ ...span, node, tau });
    this.nodes.push(node);
    return node;
  }

  private gain(v: number) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    this.nodes.push(g);
    return g;
  }

  private filter(type: BiquadFilterType, hz: number, q?: number) {
    const f = biquad(this.ctx, type, hz, q);
    this.nodes.push(f);
    return f;
  }

  /**
   * A pitch shifter from two delay taps whose times ramp down (so they read
   * faster than they're written), half a cycle apart, each faded out around
   * its jump. `ratio` above 1 shifts up. `latency` is its average delay.
   */
  private pitchShifter(ratio: number) {
    const T = 0.06;
    const w = (ratio - 1) * T;
    const base = MIN_CYCLE_DELAY + Math.abs(w) * 0.6 + 0.002;
    const inp = this.gain(1);
    const out = this.gain(1);
    const hz = 1 / T;
    for (const shift of [0, 0.5]) {
      const d = this.ctx.createDelay(0.1);
      d.delayTime.value = base;
      this.nodes.push(d);
      const win = this.gain(0.5);
      inp.connect(d).connect(win).connect(out);
      const ramp = this.gain(w);
      ramp.connect(d.delayTime);
      this.lfo(shapeWave(this.ctx, (p) => 0.5 - frac(p + shift)), [ramp], 1, hz);
      const fade = this.gain(1);
      fade.connect(win.gain);
      this.lfo(shapeWave(this.ctx, (p) => -0.5 * Math.cos(2 * Math.PI * (p + shift)), 4), [fade], 1, hz);
    }
    return { inp, out, latency: base };
  }

  /** Tears down the current effect and wires `type` between send and wet. */
  private build(type: FxType) {
    const { ctx } = this;
    const now = ctx.currentTime;
    this.send.disconnect();
    this.lfos.forEach((l) => {
      try {
        l.osc.stop();
      } catch {
        // never started
      }
      l.osc.disconnect();
    });
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    this.lfos = [];
    this.delays = [];
    this.loop = null;
    this.convolver = null;
    this.shaper = null;
    this.fb = null;
    this.tone = null;
    this.res = null;
    this.width = null;
    this.trans = null;
    this.ramps = [];
    this.edgeAt = 0;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.value = 1;

    const wet = this.wet;
    if (type === 'delay') {
      const d = this.timedDelay();
      const lp = this.filter('lowpass', 9000);
      this.send.connect(d).connect(lp).connect(wet);
      this.tone = { filter: lp, base: 9000, lo: 600, hi: 18000 };
    } else if (type === 'echo') {
      // Delay with filtered feedback, so repeats darken as they decay.
      const d = this.timedDelay();
      const fb = this.gain(0.55);
      const hp = this.filter('highpass', 160);
      const lp = this.filter('lowpass', 6000);
      this.send.connect(d);
      d.connect(hp).connect(lp).connect(fb).connect(d);
      d.connect(wet);
      this.fb = { gain: fb, base: 0.55, lo: 0.15, hi: 0.92 };
    } else if (type === 'pingpong') {
      // Mono into the left delay, the left into the right, the right back to
      // the left: repeats alternate sides, each a beat value after the last.
      const mono = this.gain(1);
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      const left = this.timedDelay();
      const right = this.timedDelay();
      const fb = this.gain(0.5);
      const hp = this.filter('highpass', 180);
      const lp = this.filter('lowpass', 7000);
      const merge = ctx.createChannelMerger(2);
      this.nodes.push(merge);
      this.send.connect(mono).connect(left).connect(right);
      right.connect(hp).connect(lp).connect(fb).connect(left);
      left.connect(merge, 0, 0);
      right.connect(merge, 0, 1);
      merge.connect(wet);
      this.fb = { gain: fb, base: 0.5, lo: 0.15, hi: 0.9 };
    } else if (type === 'spiral') {
      // An echo with a pitch shifter in its loop: each repeat a semitone up.
      // A beat change glides the delay, so the repeats swoop.
      const ps = this.pitchShifter(2 ** (1 / 12));
      const d = this.timedDelay(ps.latency, 0.15);
      const fb = this.gain(0.7);
      const hp = this.filter('highpass', 220);
      this.send.connect(d).connect(ps.inp);
      ps.out.connect(wet);
      ps.out.connect(hp).connect(fb).connect(d);
      this.fb = { gain: fb, base: 0.7, lo: 0.3, hi: 0.95 };
    } else if (type === 'reverb') {
      const c = ctx.createConvolver();
      this.reverbSeconds = this.reverbLength();
      c.buffer = impulse(ctx, this.reverbSeconds);
      const lp = this.filter('lowpass', 12000);
      this.send.connect(c).connect(lp).connect(wet);
      this.convolver = c;
      this.nodes.push(c);
      this.tone = { filter: lp, base: 12000, lo: 700, hi: 18000 };
    } else if (type === 'helix' || type === 'roll' || type === 'triroll') {
      // The line records the music all the time (fed, no feedback, output
      // shut). Frozen, its input closes and its feedback goes to 1, so it
      // plays the last beat value over and over.
      const max = type === 'triroll' ? SECONDS(16 / 3) : MAX_STRAIGHT;
      const delay = ctx.createDelay(max);
      delay.delayTime.value = Math.min(max, this.seconds());
      this.nodes.push(delay);
      const inGain = this.gain(1);
      const fb = this.gain(0);
      const out = this.gain(0);
      this.send.connect(inGain).connect(delay);
      delay.connect(fb).connect(delay);
      if (type === 'helix') {
        const lp = this.filter('lowpass', 16000);
        delay.connect(lp).connect(out);
        this.tone = { filter: lp, base: 16000, lo: 500, hi: 18000 };
      } else {
        delay.connect(out);
      }
      out.connect(wet);
      this.loop = { delay, inGain, fb, out, max };
    } else if (type === 'flanger') {
      // A short delay swept by an LFO, fed back: the jet-plane sweep.
      const d = ctx.createDelay(0.05);
      d.delayTime.value = 0.004;
      this.nodes.push(d);
      const fb = this.gain(0.6);
      this.send.connect(d);
      d.connect(fb).connect(d);
      d.connect(wet);
      const depth = this.gain(0.0035);
      depth.connect(d.delayTime);
      this.lfo('sine', [depth]);
      this.fb = { gain: fb, base: 0.6, lo: 0, hi: 0.92 };
    } else if (type === 'phaser') {
      // Six all-pass stages swept together (in cents, so the sweep is even
      // in pitch); summed with the dry signal they notch out moving bands.
      let last: AudioNode = this.send;
      const width = this.gain(2000);
      for (let i = 0; i < 6; i++) {
        const ap = this.filter('allpass', 900, 0.7);
        last.connect(ap);
        last = ap;
        width.connect(ap.detune);
      }
      last.connect(wet);
      this.lfo('sine', [width]);
      this.width = { gain: width, base: 2000, lo: 400, hi: 3600 };
    } else if (type === 'filter' || type === 'trifilter') {
      // A resonant band filter swept in cents around 1.1 kHz: up and back
      // down for Filter, a falling sweep each cycle for Triplet Filter.
      const bp = this.filter('bandpass', 1100, 2.4);
      const makeup = this.gain(2);
      this.send.connect(bp).connect(makeup).connect(wet);
      const range = this.gain(3000);
      range.connect(bp.detune);
      const shape =
        type === 'filter'
          ? shapeWave(ctx, (p) => -Math.cos(2 * Math.PI * p), 4) // starts low, peaks mid-cycle
          : shapeWave(ctx, (p) => 1 - 2 * p); // starts high, falls
      this.lfo(shape, [range]);
      this.res = { filters: [bp], base: 2.4, lo: 0.8, hi: 12 };
    } else if (type === 'mobius') {
      // A barber-pole sweep: five band filters an octave apart, each rising
      // through five octaves and fading in and out at the ends, so together
      // they climb (or fall) for ever, an octave per beat value.
      const K = 5;
      const sum = this.gain(2.4);
      sum.connect(wet);
      this.rampSpan = K * 1200;
      const filters: BiquadFilterNode[] = [];
      for (let k = 0; k < K; k++) {
        const bp = this.filter('bandpass', 110, 5);
        bp.detune.value = this.rampSpan / 2;
        const g = this.gain(0.5);
        this.send.connect(bp).connect(g).connect(sum);
        const ramp = this.gain(this.state.dir * this.rampSpan);
        ramp.connect(bp.detune);
        this.ramps.push(ramp);
        this.lfo(shapeWave(ctx, (p) => frac(p + k / K) - 0.5), [ramp], K);
        const fade = this.gain(1);
        fade.connect(g.gain);
        this.lfo(shapeWave(ctx, (p) => -0.5 * Math.cos(2 * Math.PI * (p + k / K)), 4), [fade], K);
        filters.push(bp);
      }
      this.res = { filters, base: 5, lo: 1.5, hi: 16 };
    } else if (type === 'trans') {
      // A square LFO on the dry gain: the beat-chopping "transformer".
      const g = this.gain(0);
      g.connect(this.gate.gain);
      this.lfo('square', [g]);
      this.trans = g;
    } else if (type === 'crush') {
      const ws = ctx.createWaveShaper();
      ws.curve = crushCurve(this.crushBits());
      this.send.connect(ws).connect(wet);
      this.shaper = ws;
      this.nodes.push(ws);
    }

    // Together, so shapes built to line up (pitch shifter, Mobius) do.
    const t0 = now + 0.005;
    this.lfos.forEach((l) => l.osc.start(t0));
    this.applyX();
  }

  /** Starts the tempo LFOs over at `at`, so their cycles begin on a beat. */
  private restartLfos(at: number) {
    const t = Math.max(at, this.ctx.currentTime);
    this.lfos = this.lfos.map((l) => {
      if (l.hz !== undefined) return l;
      const o = this.ctx.createOscillator();
      if (typeof l.wave === 'string') o.type = l.wave as OscillatorType;
      else o.setPeriodicWave(l.wave);
      o.frequency.value = 1 / (this.seconds() * l.cycle);
      l.outs.forEach((n) => o.connect(n));
      const old = l.osc;
      o.start(t);
      try {
        old.stop(t);
      } catch {
        // already stopped
      }
      old.onended = () => old.disconnect();
      return { ...l, osc: o };
    });
  }

  private reverbLength() {
    // Room size in beats, within what still sounds like a room.
    return Math.min(6, Math.max(0.6, this.seconds() * 2));
  }

  private crushBits() {
    return Math.round(12 - this.level() * 9); // 12 bits down to 3
  }

  /** The level, or the X-pad's slide for effects whose X is their level. */
  private level() {
    const { x, depth, type } = this.state;
    return FX_META[type].x === 'Level' && x !== null ? x : depth;
  }

  /** The tempo changed (deck pitch, a tap, a different deck). */
  setBpm(bpm: number) {
    const b = Math.max(FX_MIN_BPM, Math.min(FX_MAX_BPM, bpm > 0 ? bpm : 120));
    if (Math.abs(b - this.bpm) < 0.01) return;
    this.bpm = b;
    this.retime(this.ctx.currentTime, true);
  }

  /**
   * Applies a new state; only what changed is touched. On/off and a beat
   * change take effect at context time `at` (the next beat, with quantize);
   * everything else at once.
   */
  apply(next: FxParams, at = this.ctx.currentTime) {
    const prev = this.state;
    const now = this.ctx.currentTime;
    const when = Math.max(now, at);
    this.state = next;
    const typeChanged = next.type !== prev.type;
    if (typeChanged) this.build(next.type);
    const edge = next.on !== prev.on || (typeChanged && next.on);
    if (edge) {
      this.edgeAt = when;
      this.onBefore = typeChanged ? false : prev.on;
    }
    if (typeChanged || next.beats !== prev.beats) this.retime(typeChanged ? now : when, false);
    if (next.dir !== prev.dir) this.ramps.forEach((r) => this.glide(r.gain, next.dir * this.rampSpan, 0.05));
    if (next.x !== prev.x && !typeChanged) this.applyX();
    if (this.shaper && (next.depth !== prev.depth || next.x !== prev.x)) this.shaper.curve = crushCurve(this.crushBits());
    if (!sameBands(next.bands, prev.bands)) this.applyBands();
    if (edge) {
      if (this.loop) this.loopEdge(next.on, this.edgeAt);
      if (next.on && this.lfos.some((l) => l.hz === undefined)) this.restartLfos(this.edgeAt);
    }
    this.levels();
  }

  private retime(at: number, fromTempo: boolean) {
    const now = this.ctx.currentTime;
    for (const d of this.delays) {
      const p = d.node.delayTime;
      p.cancelScheduledValues(now);
      p.setTargetAtTime(this.delayFor(d), at, fromTempo ? GLIDE : d.tau);
    }
    if (this.loop) {
      // A frozen loop keeps its length through tempo drift (no stutter as
      // the pitch fader moves); a beat change re-cuts it from the line.
      const frozen = this.state.on && this.edgeAt <= now;
      if (!(fromTempo && frozen)) {
        const p = this.loop.delay.delayTime;
        p.cancelScheduledValues(now);
        p.setValueAtTime(Math.min(this.loop.max, this.seconds()), at);
      }
    }
    for (const l of this.lfos) {
      if (l.hz !== undefined) continue;
      l.osc.frequency.cancelScheduledValues(now);
      l.osc.frequency.setTargetAtTime(1 / (this.seconds() * l.cycle), at, GLIDE);
    }
    if (this.convolver) {
      const len = this.reverbLength();
      if (Math.abs(len - this.reverbSeconds) > 0.25) {
        this.reverbSeconds = len;
        this.convolver.buffer = impulse(this.ctx, len);
      }
    }
  }

  /** Freezes the loop (it plays the last beat value) or lets it go. */
  private loopEdge(on: boolean, at: number) {
    const l = this.loop;
    if (!l) return;
    const now = this.ctx.currentTime;
    [l.inGain.gain, l.fb.gain, l.out.gain].forEach((p) => p.cancelScheduledValues(now));
    if (on) {
      l.inGain.gain.setValueAtTime(0, at);
      l.fb.gain.setValueAtTime(1, at);
      l.out.gain.setTargetAtTime(1, at, 0.003);
    } else if (this.state.type === 'helix') {
      // Helix fades over about a beat value, then starts listening again.
      const tau = Math.min(1.5, Math.max(0.08, this.seconds() * 0.5));
      l.out.gain.setTargetAtTime(0, at, tau);
      l.fb.gain.setValueAtTime(0, at + tau * 6);
      l.inGain.gain.setValueAtTime(1, at + tau * 6);
    } else {
      l.out.gain.setTargetAtTime(0, at, 0.003);
      l.fb.gain.setValueAtTime(0, at + 0.03);
      l.inGain.gain.setValueAtTime(1, at + 0.03);
    }
  }

  private applyX() {
    const { x } = this.state;
    const pick = (r: Range, exp = false) => (x === null ? r.base : exp ? expLerp(r.lo, r.hi, x) : lerp(r.lo, r.hi, x));
    if (this.fb) this.glide(this.fb.gain.gain, pick(this.fb));
    if (this.tone) this.glide(this.tone.filter.frequency, pick(this.tone, true));
    if (this.res) {
      const q = pick(this.res, true);
      this.res.filters.forEach((f) => this.glide(f.Q, q));
    }
    if (this.width) this.glide(this.width.gain.gain, pick(this.width));
  }

  private applyBands() {
    const b = this.state.bands;
    const flags = [b.low, b.mid, b.high];
    const all = flags.every(Boolean) || !flags.some(Boolean);
    this.glide(this.whole.gain, all ? 1 : 0);
    flags.forEach((f, i) => {
      this.glide(this.sel[i].gain, !all && f ? 1 : 0);
      this.glide(this.pass[i].gain, !all && !f ? 1 : 0);
    });
  }

  private levels() {
    const { type } = this.state;
    const d = this.level();
    if (type === 'trans') {
      // Gate swings between 1 and 1 − level: base 1 − level/2, LFO ± level/2.
      this.glide(this.send.gain, 0);
      this.glide(this.dry.gain, 1);
      this.sched(this.gate.gain, (on) => (on ? 1 - d / 2 : 1));
      if (this.trans) this.sched(this.trans.gain, (on) => (on ? d / 2 : 0));
      return;
    }
    if (type === 'crush') {
      this.sched(this.send.gain, (on) => (on ? 1 : 0));
      this.sched(this.dry.gain, (on) => (on ? 1 - d * 0.85 : 1));
      this.sched(this.wet.gain, (on) => (on ? 0.4 + d * 0.6 : 0));
      return;
    }
    if (type === 'roll' || type === 'triroll') {
      // The loop records all the time; frozen, it takes the dry's place.
      this.glide(this.send.gain, 1);
      this.glide(this.wet.gain, d);
      this.sched(this.dry.gain, (on) => (on ? 1 - d : 1), 0.003);
      return;
    }
    if (type === 'helix') {
      this.glide(this.send.gain, 1);
      this.glide(this.dry.gain, 1);
      this.glide(this.wet.gain, d * 1.1);
      return;
    }
    if (type === 'filter' || type === 'trifilter' || type === 'mobius') {
      this.sched(this.send.gain, (on) => (on ? 1 : 0));
      this.sched(this.dry.gain, (on) => (on ? 1 - d : 1));
      this.glide(this.wet.gain, d);
      return;
    }
    // Sends: the wet return stays open so tails finish after "off".
    this.glide(this.dry.gain, 1);
    this.sched(this.send.gain, (on) => (on ? 1 : 0));
    this.glide(this.wet.gain, d * (type === 'reverb' ? 1.2 : 1));
  }
}

/**
 * An insert point the shared unit can sit in: a channel (between its filter
 * and its fader, so the headphone cue hears the effect) or the master bus.
 * Unselected it's a wire; selected, the signal goes through the unit.
 * Switching crossfades in a few milliseconds.
 */
export class FxSlot {
  readonly input: GainNode;
  readonly output: GainNode;
  private thru: GainNode;
  private send: GainNode;
  private ret: GainNode;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.thru = ctx.createGain();
    this.send = ctx.createGain();
    this.ret = ctx.createGain();
    this.send.gain.value = 0;
    this.ret.gain.value = 0;
    this.input.connect(this.thru).connect(this.output);
    this.input.connect(this.send);
    this.ret.connect(this.output);
  }

  /** Wires this slot to the unit (once). */
  attach(unit: FxUnit) {
    this.send.connect(unit.input);
    unit.output.connect(this.ret);
  }

  select(on: boolean) {
    const t = this.ctx.currentTime;
    this.thru.gain.setTargetAtTime(on ? 0 : 1, t, 0.008);
    this.send.gain.setTargetAtTime(on ? 1 : 0, t, 0.008);
    this.ret.gain.setTargetAtTime(on ? 1 : 0, t, 0.008);
  }
}
