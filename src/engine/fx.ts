/**
 * Beat FX — one unit per channel, between the filter and the fader (so the
 * headphone cue hears it too). Times are in beats of that deck's live tempo,
 * the way club mixers' Beat FX work: a 3/4-beat echo stays 3/4 of a beat
 * when the pitch fader moves.
 *
 *   input ─┬─ gate ─ dry ────────────────────────┬─ output
 *          └─ send ─ [effect] ─ wet (depth) ──────┘
 *
 * Echo, reverb, flanger and phaser are sends: switching them off closes the
 * send, so the tail rings out instead of cutting. Trans chops the dry signal
 * on the beat (gate); crush replaces it.
 */

export type FxType = 'echo' | 'reverb' | 'flanger' | 'phaser' | 'trans' | 'crush';

export const FX_TYPES: { id: FxType; label: string }[] = [
  { id: 'echo', label: 'Echo' },
  { id: 'reverb', label: 'Reverb' },
  { id: 'flanger', label: 'Flanger' },
  { id: 'phaser', label: 'Phaser' },
  { id: 'trans', label: 'Trans' },
  { id: 'crush', label: 'Crush' },
];

export const FX_BEATS = [0.125, 0.25, 0.5, 0.75, 1, 2, 4, 8] as const;

export interface FxState {
  type: FxType;
  beats: number;
  /** 0–1: wet level for sends, chop depth for trans, amount for crush. */
  depth: number;
  on: boolean;
}

export function defaultFx(): FxState {
  return { type: 'echo', beats: 0.75, depth: 0.5, on: false };
}

export function beatsLabel(b: number) {
  if (b === 0.125) return '1/8';
  if (b === 0.25) return '1/4';
  if (b === 0.5) return '1/2';
  if (b === 0.75) return '3/4';
  return String(b);
}

const GLIDE = 0.02;

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

export class FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  private gate: GainNode;
  private dry: GainNode;
  private send: GainNode;
  private wet: GainNode;
  private lfoDepth: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  private nodes: AudioNode[] = [];
  private delay: DelayNode | null = null;
  private convolver: ConvolverNode | null = null;
  private reverbSeconds = 0;
  private shaper: WaveShaperNode | null = null;
  private state: FxState = defaultFx();
  private bpm = 120;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.gate = ctx.createGain();
    this.dry = ctx.createGain();
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    this.wet = ctx.createGain();
    this.input.connect(this.gate).connect(this.dry).connect(this.output);
    this.input.connect(this.send);
    this.wet.connect(this.output);
    this.build('echo');
  }

  private seconds(beats = this.state.beats) {
    return (60 / this.bpm) * beats;
  }

  private glide(p: AudioParam, v: number) {
    p.setTargetAtTime(v, this.ctx.currentTime, GLIDE);
  }

  /** Tears down the current effect and wires `type` between send and wet. */
  private build(type: FxType) {
    const { ctx } = this;
    this.send.disconnect();
    this.nodes.forEach((n) => n.disconnect());
    this.lfo?.stop();
    this.nodes = [];
    this.lfo = null;
    this.lfoDepth = null;
    this.delay = null;
    this.convolver = null;
    this.shaper = null;
    this.gate.gain.cancelScheduledValues(ctx.currentTime);
    this.gate.gain.value = 1;

    const lfo = (hz: number, amount: number, target: AudioParam, shape: OscillatorType = 'sine') => {
      const o = ctx.createOscillator();
      o.type = shape;
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = amount;
      o.connect(g).connect(target);
      o.start();
      this.lfo = o;
      this.lfoDepth = g;
      this.nodes.push(o, g);
    };

    if (type === 'echo') {
      // Delay with filtered feedback, so repeats darken as they decay.
      const d = ctx.createDelay(10);
      d.delayTime.value = this.seconds();
      const fb = ctx.createGain();
      fb.gain.value = 0.55;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 160;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6000;
      this.send.connect(d);
      d.connect(hp).connect(lp).connect(fb).connect(d);
      d.connect(this.wet);
      this.delay = d;
      this.nodes.push(d, fb, hp, lp);
    } else if (type === 'reverb') {
      const c = ctx.createConvolver();
      this.reverbSeconds = this.reverbLength();
      c.buffer = impulse(ctx, this.reverbSeconds);
      this.send.connect(c).connect(this.wet);
      this.convolver = c;
      this.nodes.push(c);
    } else if (type === 'flanger') {
      // A short delay swept by an LFO, fed back: the jet-plane sweep.
      const d = ctx.createDelay(0.05);
      d.delayTime.value = 0.004;
      const fb = ctx.createGain();
      fb.gain.value = 0.6;
      this.send.connect(d);
      d.connect(fb).connect(d);
      d.connect(this.wet);
      lfo(1 / this.seconds(), 0.0035, d.delayTime);
      this.nodes.push(d, fb);
    } else if (type === 'phaser') {
      // Six all-pass stages swept together; summed with the dry signal they
      // notch out moving bands.
      let last: AudioNode = this.send;
      const stages: BiquadFilterNode[] = [];
      for (let i = 0; i < 6; i++) {
        const ap = ctx.createBiquadFilter();
        ap.type = 'allpass';
        ap.frequency.value = 900;
        ap.Q.value = 0.7;
        last.connect(ap);
        last = ap;
        stages.push(ap);
        this.nodes.push(ap);
      }
      last.connect(this.wet);
      const o = ctx.createOscillator();
      o.frequency.value = 1 / this.seconds();
      const g = ctx.createGain();
      g.gain.value = 700;
      o.connect(g);
      stages.forEach((s) => g.connect(s.frequency));
      o.start();
      this.lfo = o;
      this.lfoDepth = g;
      this.nodes.push(o, g);
    } else if (type === 'trans') {
      // A square LFO on the dry gain: the beat-chopping "transformer".
      lfo(1 / this.seconds(), 0, this.gate.gain, 'square');
    } else if (type === 'crush') {
      const ws = ctx.createWaveShaper();
      ws.curve = crushCurve(this.crushBits());
      this.send.connect(ws).connect(this.wet);
      this.shaper = ws;
      this.nodes.push(ws);
    }
  }

  private reverbLength() {
    // Room size in beats, within what still sounds like a room.
    return Math.min(6, Math.max(0.6, this.seconds() * 2));
  }

  private crushBits() {
    return Math.round(12 - this.state.depth * 9); // 12 bits down to 3
  }

  /** Applies a new state; only what changed is touched. */
  apply(next: FxState) {
    const prev = this.state;
    this.state = next;
    if (next.type !== prev.type) this.build(next.type);
    if (next.beats !== prev.beats || next.type !== prev.type) this.retime();
    if (next.type === 'crush' && this.shaper && next.depth !== prev.depth) {
      this.shaper.curve = crushCurve(this.crushBits());
    }
    this.levels();
  }

  /** The deck's effective tempo changed. */
  setBpm(bpm: number | null) {
    const b = bpm && bpm > 0 ? bpm : 120;
    if (Math.abs(b - this.bpm) < 0.01) return;
    this.bpm = b;
    this.retime();
  }

  private retime() {
    const secs = this.seconds();
    if (this.delay) this.glide(this.delay.delayTime, Math.min(10, secs));
    if (this.lfo) this.glide(this.lfo.frequency, 1 / secs);
    if (this.convolver) {
      const len = this.reverbLength();
      if (Math.abs(len - this.reverbSeconds) > 0.25) {
        this.reverbSeconds = len;
        this.convolver.buffer = impulse(this.ctx, len);
      }
    }
  }

  private levels() {
    const { type, depth, on } = this.state;
    const t = this.ctx.currentTime;
    if (type === 'trans') {
      // Gate swings between 1 and 1 − depth: base 1 − depth/2, LFO ± depth/2.
      this.glide(this.send.gain, 0);
      this.glide(this.dry.gain, 1);
      this.gate.gain.setTargetAtTime(on ? 1 - depth / 2 : 1, t, GLIDE);
      if (this.lfoDepth) this.glide(this.lfoDepth.gain, on ? depth / 2 : 0);
      return;
    }
    if (type === 'crush') {
      this.glide(this.send.gain, on ? 1 : 0);
      this.glide(this.dry.gain, on ? 1 - depth * 0.85 : 1);
      this.glide(this.wet.gain, on ? 0.4 + depth * 0.6 : 0);
      return;
    }
    // Sends: the wet return stays open so tails finish after "off".
    this.glide(this.dry.gain, 1);
    this.glide(this.send.gain, on ? 1 : 0);
    this.glide(this.wet.gain, depth * (type === 'reverb' ? 1.2 : 1));
  }
}
