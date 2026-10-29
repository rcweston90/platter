import { decodeAudio } from './analysis';
import { loadSamples, removeSample, saveSample } from './library';
import { createStore, type Store } from './store';

/**
 * Eight one-shot pads into the master bus. The built-in sounds are
 * synthesised here (nothing to license); drop your own audio on a pad and it
 * is kept in this browser.
 */

export const PADS = 8;

interface PadState {
  name: string;
  custom: boolean;
}

export interface SamplerState {
  pads: PadState[];
  /** 0–1, 0.8 = 0 dB. */
  level: number;
}

type Voice = (sr: number) => [Float32Array, Float32Array];

const TAU = Math.PI * 2;

function make(sr: number, seconds: number, fn: (t: number, i: number) => [number, number] | number): [Float32Array, Float32Array] {
  const n = Math.ceil(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = fn(i / sr, i);
    if (typeof v === 'number') L[i] = R[i] = v;
    else [L[i], R[i]] = v;
  }
  // Gentle saturation and a 5 ms fade-out so nothing clicks at the end.
  const fade = Math.min(n, Math.round(sr * 0.005));
  for (let i = 0; i < n; i++) {
    const g = i > n - fade ? (n - i) / fade : 1;
    L[i] = Math.tanh(L[i]) * g * 0.9;
    R[i] = Math.tanh(R[i]) * g * 0.9;
  }
  return [L, R];
}

let noiseSeed = 7;
const noise = () => {
  noiseSeed = (noiseSeed * 16807) % 2147483647;
  return (noiseSeed / 2147483647) * 2 - 1;
};
const saw = (phase: number) => 2 * (phase - Math.floor(phase + 0.5));

const BUILT_IN: { name: string; voice: Voice }[] = [
  {
    name: 'Horn',
    voice: (sr) => {
      // Three blasts — bap, bap, baaap — of detuned saws with a dropping pitch.
      const hits = [
        [0, 0.13],
        [0.18, 0.13],
        [0.36, 0.7],
      ];
      const ph = [0, 0, 0];
      return make(sr, 1.1, (t) => {
        let v = 0;
        for (const [s, len] of hits) {
          if (t >= s && t < s + len) {
            const local = t - s;
            const env = Math.min(1, local / 0.01) * Math.min(1, (s + len - t) / 0.04);
            const f = 466 * (1 - 0.06 * Math.min(1, local / len));
            v += env;
            for (let k = 0; k < 3; k++) ph[k] = (ph[k] + (f * (1 + (k - 1) * 0.012)) / sr) % 1;
          }
        }
        if (!v) return 0;
        return (saw(ph[0]) + saw(ph[1]) + saw(ph[2])) * 0.45 * v;
      });
    },
  },
  {
    name: 'Siren',
    voice: (sr) => {
      let ph = 0;
      return make(sr, 2, (t) => {
        const f = 1000 + 450 * Math.sin(TAU * 2.2 * t);
        ph += f / sr;
        const env = Math.min(1, t / 0.03) * Math.min(1, (2 - t) / 0.2);
        return Math.sin(TAU * ph) * 0.7 * env + Math.sin(TAU * ph * 2) * 0.15 * env;
      });
    },
  },
  {
    name: 'Laser',
    voice: (sr) => {
      let ph = 0;
      return make(sr, 0.4, (t) => {
        ph += (100 + 3200 * Math.exp(-t / 0.05)) / sr;
        return Math.sin(TAU * ph) * Math.exp(-t / 0.15);
      });
    },
  },
  {
    name: 'Rewind',
    voice: (sr) => {
      // Tape whizzing backwards: filtered noise and a climbing, wobbling tone.
      let ph = 0;
      let lp = 0;
      return make(sr, 0.9, (t) => {
        const f = 180 * Math.pow(10, t / 0.6) * (1 + 0.08 * Math.sin(TAU * 31 * t));
        ph += f / sr;
        lp += (noise() - lp) * 0.2;
        const env = Math.min(1, t / 0.05) * Math.min(1, (0.9 - t) / 0.1);
        return (saw(ph) * 0.35 + lp * 0.8) * env;
      });
    },
  },
  {
    name: 'Clap',
    voice: (sr) => {
      let hp = 0;
      let prev = 0;
      return make(sr, 0.6, (t) => {
        const x = noise();
        hp = 0.85 * (hp + x - prev);
        prev = x;
        const burst = t < 0.03 ? Math.exp(-(t % 0.01) / 0.003) : Math.exp(-(t - 0.02) / 0.12);
        return [hp * burst * 0.9, hp * burst * 0.75];
      });
    },
  },
  {
    name: 'Riser',
    voice: (sr) => {
      let ph = 0;
      let lp = 0;
      return make(sr, 2.4, (t) => {
        const u = t / 2.4;
        ph += (200 + 1800 * u * u) / sr;
        const x = noise();
        lp += (x - lp) * (0.02 + 0.6 * u);
        const air = x - lp; // high-pass that opens as it rises
        return (air * 0.6 + Math.sin(TAU * ph) * 0.3) * u * u;
      });
    },
  },
  {
    name: 'Boom',
    voice: (sr) => {
      let ph = 0;
      return make(sr, 1.8, (t) => {
        ph += (32 + 55 * Math.exp(-t / 0.08)) / sr;
        const click = t < 0.004 ? noise() * 0.5 : 0;
        return Math.sin(TAU * ph) * Math.exp(-t / 0.6) * 1.3 + click;
      });
    },
  },
  {
    name: 'Stab',
    voice: (sr) => {
      // A minor-seventh chord stab through a closing low-pass.
      const freqs = [220, 261.63, 329.63, 392];
      const ph = freqs.map(() => 0);
      let low = 0;
      let band = 0;
      return make(sr, 0.7, (t) => {
        let x = 0;
        freqs.forEach((f, k) => {
          ph[k] = (ph[k] + (f * 1.003) / sr) % 1;
          x += saw(ph[k]);
        });
        const fc = 300 + 3500 * Math.exp(-t / 0.08);
        const f = 2 * Math.sin((Math.PI * fc) / sr);
        low += f * band;
        band += f * (x * 0.25 - low - band * 0.5);
        return low * Math.exp(-t / 0.25) * 1.4;
      });
    },
  },
];

export class Sampler {
  readonly store: Store<SamplerState> = createStore<SamplerState>({
    pads: BUILT_IN.map((b) => ({ name: b.name, custom: false })),
    level: 0.7,
  });
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private buffers: (AudioBuffer | null)[] = Array.from({ length: PADS }, () => null);
  private custom: (Blob | null)[] = Array.from({ length: PADS }, () => null);

  /** Restores pads saved in this browser. */
  async init() {
    const saved = await loadSamples();
    const pads = [...this.store.get().pads];
    for (const rec of saved) {
      const i = Number(rec.id);
      if (!(i >= 0 && i < PADS)) continue;
      this.custom[i] = rec.blob;
      pads[i] = { name: rec.name, custom: true };
    }
    this.store.set({ pads });
  }

  attach(ctx: AudioContext, bus: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(bus);
    this.buffers = this.buffers.map(() => null);
    this.setLevel(this.store.get().level);
  }

  setLevel(level: number) {
    this.store.set({ level });
    if (this.out && this.ctx) this.out.gain.setTargetAtTime((level / 0.8) ** 2, this.ctx.currentTime, 0.015);
  }

  private async buffer(i: number): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (this.buffers[i]) return this.buffers[i];
    let buf: AudioBuffer;
    const blob = this.custom[i];
    if (blob) {
      buf = await decodeAudio(blob, ctx.sampleRate);
    } else {
      const [L, R] = BUILT_IN[i].voice(ctx.sampleRate);
      buf = ctx.createBuffer(2, L.length, ctx.sampleRate);
      buf.copyToChannel(L as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(R as Float32Array<ArrayBuffer>, 1);
    }
    this.buffers[i] = buf;
    return buf;
  }

  /** Builds every pad's sound ahead of the first hit. */
  warm() {
    for (let i = 0; i < PADS; i++) void this.buffer(i);
  }

  async trigger(i: number) {
    const buf = await this.buffer(i).catch(() => null);
    if (!buf || !this.ctx || !this.out) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    src.start();
  }

  async setCustom(i: number, file: File) {
    this.custom[i] = file;
    this.buffers[i] = null;
    const name = file.name.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 24);
    const pads = [...this.store.get().pads];
    pads[i] = { name, custom: true };
    this.store.set({ pads });
    await saveSample({ id: String(i), name, blob: file });
  }

  async reset(i: number) {
    this.custom[i] = null;
    this.buffers[i] = null;
    const pads = [...this.store.get().pads];
    pads[i] = { name: BUILT_IN[i].name, custom: false };
    this.store.set({ pads });
    await removeSample(String(i));
  }
}
