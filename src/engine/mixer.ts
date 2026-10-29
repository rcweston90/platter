/**
 * The mixer: two channel strips, a crossfader, a master bus with a safety
 * limiter, and a headphone (cue) bus.
 *
 * Signal per channel:
 *   trim → 3-band isolator → filter (LP→HP) → post ─┬→ fader → crossfader → master
 *                                                   ├→ cue send (PFL) → cue bus
 *                                                   └→ meter
 *
 * The EQ is an isolator rather than shelving filters, so a band turned fully
 * down is gone, not −12 dB. Each band is a 4th-order Linkwitz–Riley section
 * (two cascaded Butterworth biquads), the crossover the hardware isolators in
 * club mixers use: low and high summed back together are flat.
 */

export const EQ_LOW_HZ = 220;
export const EQ_HIGH_HZ = 2600;
const BUTTERWORTH_Q = Math.SQRT1_2;
const SMOOTH = 0.015; // s — parameter glide, fast enough to feel direct, slow enough not to zipper

export type CrossfaderCurve = 'power' | 'full' | 'cut';

export interface ChannelState {
  /** 0–1, 0.5 = 0 dB (±12 dB). */
  trim: number;
  /** 0–1 each, 0 = band killed, 0.5 = 0 dB, 1 = +6 dB. */
  high: number;
  mid: number;
  low: number;
  /** −1 (low-pass) … 0 (off) … 1 (high-pass). */
  filter: number;
  /** 0–1 channel fader. */
  fader: number;
  /** Pre-fader listen in the headphones. */
  cue: boolean;
}

export function defaultChannel(): ChannelState {
  return { trim: 0.5, high: 0.5, mid: 0.5, low: 0.5, filter: 0, fader: 0.8, cue: false };
}

/* ── Value curves (shared by the audio graph and the knobs' readouts) ────── */

export function trimDb(v: number) {
  return (v - 0.5) * 24;
}

/** EQ knob → linear gain. Full left is a true kill; the last 2% snaps to it. */
export function eqGain(v: number) {
  if (v <= 0.02) return 0;
  const db = v < 0.5 ? (v / 0.5 - 1) * 30 : ((v - 0.5) / 0.5) * 6;
  return 10 ** (db / 20);
}

export function eqLabel(v: number) {
  if (v <= 0.02) return 'kill';
  const db = 20 * Math.log10(eqGain(v));
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

const FILTER_DEAD = 0.03;

export function filterLabel(v: number) {
  if (Math.abs(v) < FILTER_DEAD) return 'off';
  const { lp, hp } = filterFreqs(v);
  const hz = v < 0 ? lp : hp;
  const txt = hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
  return `${v < 0 ? 'low-pass' : 'high-pass'} ${txt}`;
}

function filterFreqs(v: number) {
  if (Math.abs(v) < FILTER_DEAD) return { lp: 22000, hp: 10, active: false };
  // Exponential sweeps: equal knob travel, equal musical interval.
  const t = (Math.abs(v) - FILTER_DEAD) / (1 - FILTER_DEAD);
  if (v < 0) return { lp: 20000 * (90 / 20000) ** t, hp: 10, active: true };
  return { lp: 22000, hp: 25 * (9000 / 25) ** t, active: true };
}

/** Fader → gain: squared, close to an audio taper and never below 0. */
export function faderGain(v: number) {
  return v * v;
}

/** 0–1 knob with 0 dB at 0.8, for master and headphone levels. */
export function levelGain(v: number) {
  return (v / 0.8) ** 2;
}

export function crossfaderGains(x: number, curve: CrossfaderCurve): [number, number] {
  const t = (x + 1) / 2;
  if (curve === 'cut') {
    // Scratch curve: each side stays fully open until the last few percent.
    const edge = 0.06;
    return [Math.min(1, (1 - t) / edge), Math.min(1, t / edge)];
  }
  if (curve === 'full') return [Math.min(1, 2 * (1 - t)), Math.min(1, 2 * t)];
  return [Math.cos((t * Math.PI) / 2), Math.sin((t * Math.PI) / 2)];
}

/* ── Channel strip ───────────────────────────────────────────────────────── */

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q = BUTTERWORTH_Q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

function chain(...nodes: AudioNode[]) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

export class Channel {
  readonly input: GainNode;
  readonly meter: AnalyserNode;
  private low: GainNode;
  private mid: GainNode;
  private high: GainNode;
  private lp: BiquadFilterNode;
  private hp: BiquadFilterNode;
  private fader: GainNode;
  readonly xfade: GainNode;
  private cueSend: GainNode;

  constructor(
    private ctx: AudioContext,
    master: AudioNode,
    cueBus: AudioNode,
  ) {
    this.input = ctx.createGain();
    const sum = ctx.createGain();

    this.low = ctx.createGain();
    chain(this.input, biquad(ctx, 'lowpass', EQ_LOW_HZ), biquad(ctx, 'lowpass', EQ_LOW_HZ), this.low, sum);
    this.mid = ctx.createGain();
    chain(
      this.input,
      biquad(ctx, 'highpass', EQ_LOW_HZ),
      biquad(ctx, 'highpass', EQ_LOW_HZ),
      biquad(ctx, 'lowpass', EQ_HIGH_HZ),
      biquad(ctx, 'lowpass', EQ_HIGH_HZ),
      this.mid,
      sum,
    );
    this.high = ctx.createGain();
    chain(this.input, biquad(ctx, 'highpass', EQ_HIGH_HZ), biquad(ctx, 'highpass', EQ_HIGH_HZ), this.high, sum);

    this.lp = biquad(ctx, 'lowpass', 22000);
    this.hp = biquad(ctx, 'highpass', 10);
    const post = ctx.createGain();
    chain(sum, this.lp, this.hp, post);

    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();
    chain(post, this.fader, this.xfade, master);

    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    chain(post, this.cueSend, cueBus);

    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 1024;
    post.connect(this.meter);
  }

  private glide(param: AudioParam, value: number) {
    param.setTargetAtTime(value, this.ctx.currentTime, SMOOTH);
  }

  apply(s: ChannelState) {
    this.glide(this.input.gain, 10 ** (trimDb(s.trim) / 20));
    this.glide(this.low.gain, eqGain(s.low));
    this.glide(this.mid.gain, eqGain(s.mid));
    this.glide(this.high.gain, eqGain(s.high));
    const f = filterFreqs(s.filter);
    this.glide(this.lp.frequency, f.lp);
    this.glide(this.hp.frequency, f.hp);
    // A touch of resonance only while sweeping; flat (Butterworth) at rest.
    this.glide(this.lp.Q, f.active && s.filter < 0 ? 1.6 : BUTTERWORTH_Q);
    this.glide(this.hp.Q, f.active && s.filter > 0 ? 1.6 : BUTTERWORTH_Q);
    this.glide(this.fader.gain, faderGain(s.fader));
    this.glide(this.cueSend.gain, s.cue ? 1 : 0);
  }

  setCrossfade(gain: number) {
    this.glide(this.xfade.gain, gain);
  }
}

/* ── Meters ──────────────────────────────────────────────────────────────── */

const meterScratch = new Float32Array(2048);

/** Peak level of an analyser's current window, 0–1 (linear). */
export function readPeak(a: AnalyserNode) {
  const buf = meterScratch.subarray(0, a.fftSize);
  a.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Linear peak → 0–1 meter height over a −48…+6 dBFS scale. */
export function meterLevel(peak: number) {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db + 48) / 54));
}
