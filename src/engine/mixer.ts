/**
 * The mixer: two channel strips, a crossfader, a master bus with a safety
 * limiter, and a headphone (cue) bus.
 *
 * Signal per channel:
 *   trim → 3-band EQ → filter (LP→HP) → FX slot → post ─┬→ fader → crossfader → master
 *                                                   ├→ cue send (PFL) → cue bus
 *                                                   └→ meter
 *
 * The FX slot is where the mixer's one Beat FX unit sits when its channel
 * select points at this deck (fx.ts, engine.ts); otherwise it's a wire.
 *
 * The EQ has two modes, a mixer-wide switch:
 *   · ISO (the default) — an isolator, so a band turned fully down is gone,
 *     not −12 dB. Each band is a 4th-order Linkwitz–Riley section (two
 *     cascaded Butterworth biquads), the crossover the hardware isolators in
 *     club mixers use: the bands summed back together are flat.
 *   · EQ — a classic channel EQ: low shelf, peaking mid, high shelf, from
 *     +6 dB down to −26 dB, no kill. Thinner cuts that leave some of the band.
 *
 * Three more mixer-wide switches shape the levels: the channel-fader curve,
 * the crossfader curve, and each channel's crossfader assign (A, THRU, B).
 */

import { FxSlot } from './fx';

import { EQ_HIGH_HZ, EQ_LOW_HZ } from './eq';
export { EQ_HIGH_HZ, EQ_LOW_HZ };
/** Web Audio reads Q on a lowpass or highpass biquad in dB: the level of the
 *  resonance at the corner. A Butterworth (Q = 1/√2) is 20·log10(1/√2) dB.
 *  (Allpass, peaking and the rest read Q as the plain number.) */
export const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2); // −3.01 dB
const SMOOTH = 0.015; // s — parameter glide, fast enough to feel direct, slow enough not to zipper

export type CrossfaderCurve = 'power' | 'full' | 'cut';
/** ISO: full-kill isolator. EQ: shelf / peak / shelf, no kill. */
export type EqMode = 'iso' | 'eq';
/** How a channel fader's travel maps to level. */
export type FaderCurve = 'slow' | 'linear' | 'fast';
/** Which side of the crossfader a channel follows; THRU ignores it. */
export type XfAssign = 'A' | 'thru' | 'B';

export const EQ_MODES: readonly EqMode[] = ['iso', 'eq'];
export const FADER_CURVES: readonly FaderCurve[] = ['slow', 'linear', 'fast'];
export const CROSSFADER_CURVES: readonly CrossfaderCurve[] = ['power', 'full', 'cut'];
export const XF_ASSIGNS: readonly XfAssign[] = ['A', 'thru', 'B'];

/** Isolator range: full left is a kill, the rest of the cut runs to −30 dB. */
export const ISO_CUT_DB = 30;
/** Classic EQ range: −26 dB at full left (no kill) to +6 dB. */
export const EQ_CUT_DB = 26;
export const EQ_BOOST_DB = 6;
/** The classic EQ's bands: shelves and a broad peak, the usual mixer spots. */
export const EQ_SHELF_LOW_HZ = 100;
export const EQ_PEAK_HZ = 1000;
export const EQ_PEAK_Q = 0.7;
export const EQ_SHELF_HIGH_HZ = 8000;

export interface ChannelState {
  /** 0–1, 0.5 = 0 dB (±12 dB). */
  trim: number;
  /** 0–1 each, 0.5 = 0 dB, 1 = +6 dB; 0 = band killed (ISO) or −26 dB (EQ). */
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

/** EQ knob → dB. In ISO, full left is a true kill (−∞); the last 2% snaps to
 *  it. In EQ there's no kill: full left is −26 dB. Both reach +6 dB. */
export function eqDb(v: number, mode: EqMode = 'iso') {
  if (v >= 0.5) return ((v - 0.5) / 0.5) * EQ_BOOST_DB;
  if (mode === 'eq') return (v / 0.5 - 1) * EQ_CUT_DB;
  if (v <= 0.02) return -Infinity;
  return (v / 0.5 - 1) * ISO_CUT_DB;
}

/** EQ knob → linear gain (0 for a kill). */
export function eqGain(v: number, mode: EqMode = 'iso') {
  const db = eqDb(v, mode);
  return db === -Infinity ? 0 : 10 ** (db / 20);
}

export function eqLabel(v: number, mode: EqMode = 'iso') {
  const db = eqDb(v, mode);
  if (db === -Infinity) return 'kill';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** The filter's dead zone either side of centre: inside it the filter is off,
 *  and the knob locks to centre as you drag through it. Of −1…1. */
export const FILTER_LOCK = 0.08;
const FILTER_DEAD = FILTER_LOCK;

/** A filter value with the centre lock applied: near centre is exactly off. */
export function lockFilter(v: number) {
  return Math.abs(v) < FILTER_LOCK ? 0 : Math.max(-1, Math.min(1, v));
}

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

/** Where the fast-cut fader curve reaches full level, of its travel. */
export const FADER_CUT_EDGE = 0.08;

/**
 * Channel fader → gain, by curve:
 *   · linear — squared, close to an audio taper: loudness rises evenly
 *     (−12 dB at half travel). The default, and the curve before there was a choice.
 *   · slow   — cubed: the level comes in late, most of it in the top third
 *     (−18 dB at half travel), for long blends.
 *   · fast   — full level within the first 8% of travel, for cuts and scratching.
 * Every curve is 0 at the bottom and 1 (0 dB) at the top.
 */
export function faderGain(v: number, curve: FaderCurve = 'linear') {
  const x = Math.max(0, Math.min(1, v));
  if (curve === 'slow') return x * x * x;
  if (curve === 'fast') return Math.min(1, x / FADER_CUT_EDGE);
  return x * x;
}

/** The fader's level as the screen says it: "off" or dB. */
export function faderLabel(v: number, curve: FaderCurve = 'linear') {
  const g = faderGain(v, curve);
  if (g <= 0) return 'off';
  const db = 20 * Math.log10(g);
  return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`;
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

/** A channel's crossfader gain, by its assign: A or B follow that side of the
 *  crossfader, THRU ignores the crossfader (always 1). */
export function assignedGain(assign: XfAssign, gains: readonly [number, number]) {
  if (assign === 'thru') return 1;
  return gains[assign === 'A' ? 0 : 1];
}

/** Each channel's crossfader gain for a crossfader position, curve and assigns. */
export function crossfadeFor(x: number, curve: CrossfaderCurve, assign: readonly [XfAssign, XfAssign]): [number, number] {
  const g = crossfaderGains(x, curve);
  return [assignedGain(assign[0], g), assignedGain(assign[1], g)];
}

/** How loud a channel is in the master: its fader × its crossfader gain. */
export function channelLevel(
  fader: number,
  i: 0 | 1,
  m: { crossfader: number; curve: CrossfaderCurve; faderCurve: FaderCurve; xfAssign: readonly [XfAssign, XfAssign] },
) {
  return faderGain(fader, m.faderCurve) * crossfadeFor(m.crossfader, m.curve, m.xfAssign)[i];
}

/* ── Channel strip ───────────────────────────────────────────────────────── */

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q = BUTTERWORTH_Q_DB) {
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

/**
 * The 3-band isolator: low, mid and high bands split by 4th-order
 * Linkwitz–Riley crossovers, each with its own gain, summed. With every band
 * at unity the sum is flat (an allpass). Takes any context, so a test can
 * render it offline.
 */
export class Isolator {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly bands: { low: GainNode; mid: GainNode; high: GainNode };

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const low = ctx.createGain();
    chain(this.input, biquad(ctx, 'lowpass', EQ_LOW_HZ), biquad(ctx, 'lowpass', EQ_LOW_HZ), low, this.output);
    const mid = ctx.createGain();
    chain(
      this.input,
      biquad(ctx, 'highpass', EQ_LOW_HZ),
      biquad(ctx, 'highpass', EQ_LOW_HZ),
      biquad(ctx, 'lowpass', EQ_HIGH_HZ),
      biquad(ctx, 'lowpass', EQ_HIGH_HZ),
      mid,
      this.output,
    );
    const high = ctx.createGain();
    chain(this.input, biquad(ctx, 'highpass', EQ_HIGH_HZ), biquad(ctx, 'highpass', EQ_HIGH_HZ), high, this.output);
    this.bands = { low, mid, high };
  }
}

/**
 * A channel's EQ in either mode. Both paths are built and run side by side;
 * the mode picks which one is heard, with a short crossfade so a switch
 * mid-track doesn't click.
 */
export class ChannelEq {
  readonly input: GainNode;
  readonly output: GainNode;
  private iso: Isolator;
  private isoOut: GainNode;
  private shelfLow: BiquadFilterNode;
  private peak: BiquadFilterNode;
  private shelfHigh: BiquadFilterNode;
  private eqOut: GainNode;

  constructor(private ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.iso = new Isolator(ctx);
    this.isoOut = ctx.createGain();
    chain(this.input, this.iso.input);
    chain(this.iso.output, this.isoOut, this.output);

    // Shelves ignore Q (Web Audio's shelves have a fixed slope); the peak's Q is plain.
    this.shelfLow = biquad(ctx, 'lowshelf', EQ_SHELF_LOW_HZ, 0);
    this.peak = biquad(ctx, 'peaking', EQ_PEAK_HZ, EQ_PEAK_Q);
    this.shelfHigh = biquad(ctx, 'highshelf', EQ_SHELF_HIGH_HZ, 0);
    for (const f of [this.shelfLow, this.peak, this.shelfHigh]) f.gain.value = 0;
    this.eqOut = ctx.createGain();
    this.eqOut.gain.value = 0;
    chain(this.input, this.shelfLow, this.peak, this.shelfHigh, this.eqOut, this.output);
  }

  /** Sets the mode and the three bands (0–1 knob values). `glide` is the
   *  time constant in seconds; 0 sets them at once. */
  set(mode: EqMode, low: number, mid: number, high: number, glide = SMOOTH) {
    const t = this.ctx.currentTime;
    const to = (p: AudioParam, v: number) => (glide > 0 ? p.setTargetAtTime(v, t, glide) : p.setValueAtTime(v, t));
    const iso = mode === 'iso';
    to(this.isoOut.gain, iso ? 1 : 0);
    to(this.eqOut.gain, iso ? 0 : 1);
    const { low: l, mid: m, high: h } = this.iso.bands;
    to(l.gain, eqGain(low, 'iso'));
    to(m.gain, eqGain(mid, 'iso'));
    to(h.gain, eqGain(high, 'iso'));
    to(this.shelfLow.gain, eqDb(low, 'eq'));
    to(this.peak.gain, eqDb(mid, 'eq'));
    to(this.shelfHigh.gain, eqDb(high, 'eq'));
  }
}

/** The mixer-wide switches a channel strip needs. */
export interface ChannelSwitches {
  eqMode: EqMode;
  faderCurve: FaderCurve;
}

export class Channel {
  readonly input: GainNode;
  readonly meter: AnalyserNode;
  private eq: ChannelEq;
  private lp: BiquadFilterNode;
  private hp: BiquadFilterNode;
  private fader: GainNode;
  readonly xfade: GainNode;
  /** Where the Beat FX unit plugs in when it's on this channel. */
  readonly fxSlot: FxSlot;
  private cueSend: GainNode;

  constructor(
    private ctx: AudioContext,
    master: AudioNode,
    cueBus: AudioNode,
  ) {
    this.input = ctx.createGain();
    this.eq = new ChannelEq(ctx);
    this.input.connect(this.eq.input);
    const sum = this.eq.output;

    this.lp = biquad(ctx, 'lowpass', 22000);
    this.hp = biquad(ctx, 'highpass', 10);
    const post = ctx.createGain();
    this.fxSlot = new FxSlot(ctx);
    chain(sum, this.lp, this.hp, this.fxSlot.input);
    this.fxSlot.output.connect(post);

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

  apply(s: ChannelState, sw: ChannelSwitches = { eqMode: 'iso', faderCurve: 'linear' }) {
    this.glide(this.input.gain, 10 ** (trimDb(s.trim) / 20));
    this.eq.set(sw.eqMode, s.low, s.mid, s.high);
    const f = filterFreqs(s.filter);
    this.glide(this.lp.frequency, f.lp);
    this.glide(this.hp.frequency, f.hp);
    // A touch of resonance only while sweeping; flat (Butterworth) at rest.
    // (In dB, like every lowpass/highpass Q here: +1.6 dB at the corner.)
    this.glide(this.lp.Q, f.active && s.filter < 0 ? 1.6 : BUTTERWORTH_Q_DB);
    this.glide(this.hp.Q, f.active && s.filter > 0 ? 1.6 : BUTTERWORTH_Q_DB);
    this.glide(this.fader.gain, faderGain(s.fader, sw.faderCurve));
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
