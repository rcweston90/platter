import type { Pcm } from '../types';

/**
 * Small PCM helpers for the library analysis. Pure TypeScript — no Web Audio,
 * DOM or Node APIs — so the same code runs in a browser worker and in Node.
 */

// toMono is called once per track by the analyzer and again by measureEnergy;
// keyed on the Pcm object, the second call is free. Treat the result as
// read-only.
const monoCache = new WeakMap<Pcm, Float32Array>();

/** The average of all channels. Cached per Pcm object; don't mutate the result. */
export function toMono(pcm: Pcm): Float32Array {
  const hit = monoCache.get(pcm);
  if (hit) return hit;
  const chans = pcm.channels;
  const n = chans.length ? chans[0].length : 0;
  let out: Float32Array;
  if (chans.length === 0) out = new Float32Array(0);
  else if (chans.length === 1) out = chans[0];
  else if (chans.length === 2) {
    const [l, r] = chans;
    out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.5 * (l[i] + r[i]);
  } else {
    out = new Float32Array(n);
    const g = 1 / chans.length;
    for (const c of chans) for (let i = 0; i < n; i++) out[i] += c[i] * g;
  }
  monoCache.set(pcm, out);
  return out;
}

/**
 * Band-limited resampling by windowed sinc (Blackman window), any ratio.
 * When downsampling, the kernel's cutoff sits at 90 % of the new Nyquist so
 * what folds back is attenuated. `zeros` is the number of sinc zero crossings
 * on each side: 8 is clean; analysis that only needs an onset envelope can use
 * 4 and run twice as fast. The kernel is tabulated at 512 phases per sample.
 */
export function resample(x: Float32Array, from: number, to: number, zeros = 8): Float32Array {
  if (!(from > 0) || !(to > 0)) throw new Error('resample: rates must be positive');
  if (from === to) return x.slice();
  const ratio = to / from;
  const outLen = Math.floor(x.length * ratio);
  const out = new Float32Array(outLen);
  if (outLen === 0 || x.length === 0) return out;

  // Cutoff as a fraction of the input Nyquist.
  const fc = Math.min(1, ratio) * 0.9;
  // Half-width of the kernel in input samples.
  const W = Math.max(1, Math.ceil(zeros / fc));
  const P = 512; // kernel phases per input sample
  const T = 2 * W; // taps per output sample
  // Phase-major table: row ph holds the T taps for a fractional offset ph/P,
  // contiguous so the inner loop walks memory in order.
  const tab = new Float64Array((P + 1) * T);
  for (let ph = 0; ph <= P; ph++) {
    const frac = ph / P;
    for (let j = 0; j < T; j++) {
      const d = frac + W - 1 - j; // distance from tap k0 + j to the output position
      const u = d / W;
      const win = Math.abs(u) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const a = Math.PI * fc * d;
      tab[ph * T + j] = (a === 0 ? 1 : Math.sin(a) / a) * fc * win;
    }
  }

  const n = x.length;
  const step = from / to;
  for (let o = 0; o < outLen; o++) {
    const t = o * step; // position in input samples
    const i0 = Math.floor(t);
    const row = Math.round((t - i0) * P) * T;
    const k0 = i0 - W + 1;
    let s = 0;
    if (k0 >= 0 && k0 + T <= n) {
      for (let j = 0; j < T; j++) s += x[k0 + j] * tab[row + j];
    } else {
      for (let j = 0; j < T; j++) {
        const k = k0 + j;
        if (k >= 0 && k < n) s += x[k] * tab[row + j];
      }
    }
    out[o] = s;
  }
  return out;
}

/** The subset of AudioBuffer that src/engine/key.ts reads. */
export interface AudioBufferLike {
  sampleRate: number;
  length: number;
  duration: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** Wraps a Pcm so code written against AudioBuffer (detectKey) can read it. */
export function asAudioBufferLike(pcm: Pcm): AudioBuffer {
  const length = pcm.channels.length ? pcm.channels[0].length : 0;
  const like: AudioBufferLike = {
    sampleRate: pcm.sampleRate,
    length,
    duration: length / pcm.sampleRate,
    numberOfChannels: pcm.channels.length,
    getChannelData(channel: number) {
      const c = pcm.channels[channel];
      if (!c) throw new RangeError(`channel ${channel} out of range`);
      return c;
    },
  };
  return like as unknown as AudioBuffer;
}
