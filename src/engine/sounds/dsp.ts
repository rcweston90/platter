/**
 * The building blocks the sound library is synthesised from. Every built-in
 * synth sound is rendered here on demand, in a few milliseconds, the first
 * time a pad or a preview needs it: nothing to download and nothing to
 * license.
 */

export type Stereo = [Float32Array, Float32Array];
export type Render = (sr: number) => Stereo;

export const TAU = Math.PI * 2;

/** A seeded noise source, so a sound is the same every time it renders. */
export function rng(seed: number) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}

/** A stable number from a string: seeds each sound from its id. */
export function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const saw = (phase: number) => 2 * (phase - Math.floor(phase + 0.5));
export const square = (phase: number) => (phase - Math.floor(phase) < 0.5 ? 1 : -1);
export const tri = (phase: number) => 1 - 4 * Math.abs(phase - Math.floor(phase + 0.5));
export const midiHz = (note: number) => 440 * 2 ** ((note - 69) / 12);

/**
 * Renders `seconds` of audio from `fn` (mono or stereo per sample), then
 * soft-clips, normalises to a common peak and fades the last few ms so
 * nothing clicks.
 */
export function make(sr: number, seconds: number, fn: (t: number, i: number) => [number, number] | number, peak = 0.89): Stereo {
  const n = Math.max(1, Math.ceil(seconds * sr));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const v = fn(i / sr, i);
    let l: number;
    let r: number;
    if (typeof v === 'number') l = r = v;
    else [l, r] = v;
    l = Math.tanh(l);
    r = Math.tanh(r);
    if (!Number.isFinite(l)) l = 0;
    if (!Number.isFinite(r)) r = 0;
    L[i] = l;
    R[i] = r;
    max = Math.max(max, Math.abs(l), Math.abs(r));
  }
  const gain = max > 0 ? peak / max : 1;
  const fade = Math.min(n, Math.round(sr * 0.005));
  for (let i = 0; i < n; i++) {
    const g = (i > n - fade ? (n - i) / fade : 1) * gain;
    L[i] *= g;
    R[i] *= g;
  }
  return [L, R];
}

/** Chamberlin state-variable filter: low, band and high from one section. */
export function svf() {
  let low = 0;
  let band = 0;
  return (x: number, hz: number, sr: number, q = 0.7) => {
    const f = Math.min(1.8, 2 * Math.sin((Math.PI * Math.min(hz, sr * 0.45)) / sr));
    const damp = 1 / Math.max(0.5, q);
    low += f * band;
    const high = x - low - damp * band;
    band += f * high;
    if (!Number.isFinite(low) || !Number.isFinite(band)) low = band = 0;
    return { low, band, high };
  };
}

/** One-pole low-pass; `hp` is the input minus it. */
export function onePole() {
  let y = 0;
  return (x: number, hz: number, sr: number) => {
    const a = 1 - Math.exp((-TAU * hz) / sr);
    y += a * (x - y);
    return y;
  };
}

/** Attack, then an exponential fall with time constant `decay`. */
export const env = (t: number, attack: number, decay: number) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** Mild drive, used by the gritty kits. */
export const drive = (x: number, amount: number) => (amount > 0 ? Math.tanh(x * (1 + amount * 6)) / Math.tanh(1 + amount * 6) : x);

/** Bit and sample-rate reduction, for the lo-fi kits. */
export function crusher(bits: number, hold: number) {
  let n = 0;
  let held = 0;
  const steps = 2 ** bits;
  return (x: number) => {
    if (n++ % Math.max(1, hold) === 0) held = Math.round(x * steps) / steps;
    return held;
  };
}

/** A short stereo widener: the right channel hears a few ms later. */
export function widen(ms: number, sr: number) {
  const len = Math.max(1, Math.round((ms / 1000) * sr));
  const buf = new Float32Array(len);
  let w = 0;
  return (x: number): [number, number] => {
    const delayed = buf[w];
    buf[w] = x;
    w = (w + 1) % len;
    return [x * 0.8 + delayed * 0.2, x * 0.55 + delayed * 0.45];
  };
}
