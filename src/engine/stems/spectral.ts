/**
 * HTDemucs' spectrogram in and out, fast.
 *
 * The model takes a 7.8 s segment as a waveform and as its STFT (n 4096,
 * hop 1024, periodic Hann, "centred" with reflection), and gives each part
 * back the same two ways. Turning the STFT out of the model into sound
 * (the iSTFT) and making the one going in were done by demucs-web's
 * radix-2 FFT, one channel and one bin layout at a time: about 0.7 s of
 * JavaScript per segment, longer than a GPU takes for the model itself.
 *
 * The same transforms here, to the same numbers (tests/spectral.mjs checks
 * them against demucs-web's):
 *   · both channels in one complex FFT (left as the real part, right as the
 *     imaginary), split apart by symmetry: half the FFTs;
 *   · bit-reversal, twiddles, the window and the overlap-add's normalising
 *     sums computed once, not per frame or per call;
 *   · the model's tensors read and written in place, with no transposed
 *     copies; only the frames the model sees (336 of 340) are transformed,
 *     and only the parts Platter keeps (drums, bass, vocals) are turned
 *     back into sound.
 *
 * Pure: no DOM, no ONNX Runtime, so it runs (and is tested) anywhere.
 */
import { CONSTANTS } from 'demucs-web';

const N = CONSTANTS.FFT_SIZE; // 4096
const HOP = CONSTANTS.HOP_SIZE; // 1024
const SEG = CONSTANTS.TRAINING_SAMPLES; // 343 980
const BINS = CONSTANTS.MODEL_SPEC_BINS; // 2048 (the Nyquist bin dropped)
const FRAMES = CONSTANTS.MODEL_SPEC_FRAMES; // 336
/** Frames the model skips at the front (demucs' padding). */
const FRAME0 = 2;
/** Reflection padding before centring, as demucs pads (3 · hop / 2). */
const PAD = Math.floor(HOP / 2) * 3;
const PAD_RIGHT = PAD + Math.ceil(SEG / HOP) * HOP - SEG;
const CENTRED = SEG + PAD + PAD_RIGHT + N; // the STFT's input length
/** Frames of the full STFT (the model sees FRAMES of them, from FRAME0). */
const ALL_FRAMES = Math.floor((CENTRED - N) / HOP) + 1;
/** Where the segment's first sample sits in the iSTFT's output. */
const OUT_OFFSET = N / 2 + PAD;
const PLANE = BINS * FRAMES;

/* ── One complex FFT of size N, tables made once ─────────────────────── */

const LOG2N = Math.log2(N) | 0;
const REV = new Uint32Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0, x = i; b < LOG2N; b++, x >>= 1) r = (r << 1) | (x & 1);
  REV[i] = r;
}
const COS = new Float64Array(N / 2);
const SIN = new Float64Array(N / 2);
for (let k = 0; k < N / 2; k++) {
  COS[k] = Math.cos((2 * Math.PI * k) / N);
  SIN[k] = Math.sin((2 * Math.PI * k) / N);
}
/** Periodic Hann, as demucs-web (and torch.hann_window) makes it. */
const WINDOW = new Float64Array(N);
for (let i = 0; i < N; i++) WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));

/**
 * In place, unscaled. `sign` −1 is the forward transform (e^−iωt), +1 the
 * inverse. Input in natural order.
 */
function fft(re: Float64Array, im: Float64Array, sign: 1 | -1) {
  for (let i = 0; i < N; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  // Size 2: no twiddles.
  for (let i = 0; i < N; i += 2) {
    const ar = re[i];
    const ai = im[i];
    const br = re[i + 1];
    const bi = im[i + 1];
    re[i] = ar + br;
    im[i] = ai + bi;
    re[i + 1] = ar - br;
    im[i + 1] = ai - bi;
  }
  // Size 4: twiddles 1 and ∓i.
  for (let i = 0; i < N; i += 4) {
    const ar = re[i];
    const ai = im[i];
    const cr = re[i + 2];
    const ci = im[i + 2];
    re[i] = ar + cr;
    im[i] = ai + ci;
    re[i + 2] = ar - cr;
    im[i + 2] = ai - ci;
    const br = re[i + 1];
    const bi = im[i + 1];
    // (dr + i·di) · (∓i) = ±di ∓ i·dr, sign −1 for forward: (di, −dr)
    const dr = sign < 0 ? im[i + 3] : -im[i + 3];
    const di = sign < 0 ? -re[i + 3] : re[i + 3];
    re[i + 1] = br + dr;
    im[i + 1] = bi + di;
    re[i + 3] = br - dr;
    im[i + 3] = bi - di;
  }
  for (let size = 8; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let j = 0, k = 0; j < half; j++, k += step) {
      const wr = COS[k];
      const wi = sign * SIN[k];
      for (let i = j; i < N; i += size) {
        const o = i + half;
        const xr = re[o];
        const xi = im[o];
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        const er = re[i];
        const ei = im[i];
        re[i] = er + tr;
        im[i] = ei + ti;
        re[o] = er - tr;
        im[o] = ei - ti;
      }
    }
  }
}

/**
 * `rows`×`cols` row-major `src` (from `si`) into `cols`×`rows` row-major
 * `dst` (from `di`), in tiles so both sides stay in cache.
 */
function transpose(src: ArrayLike<number>, si: number, dst: Float64Array | Float32Array, di: number, rows: number, cols: number) {
  const T = 32;
  for (let r0 = 0; r0 < rows; r0 += T) {
    const r1 = Math.min(rows, r0 + T);
    for (let c0 = 0; c0 < cols; c0 += T) {
      const c1 = Math.min(cols, c0 + T);
      for (let r = r0; r < r1; r++) {
        const s = si + r * cols;
        for (let c = c0; c < c1; c++) dst[di + c * rows + r] = src[s + c];
      }
    }
  }
}

/* ── Into the model ───────────────────────────────────────────────────── */

/** demucs-web's reflectPad, into `out` from `at`. */
function reflectInto(out: Float64Array, signal: ArrayLike<number>, len: number, padLeft: number, padRight: number, at: number) {
  for (let i = 0; i < padLeft; i++) out[at + i] = signal[Math.min(padLeft - i, len - 1)];
  for (let i = 0; i < len; i++) out[at + padLeft + i] = signal[i];
  for (let i = 0; i < padRight; i++) out[at + padLeft + len + i] = signal[Math.max(0, len - 2 - i)];
}

export interface ModelInput {
  /** [1, 2, SEG]: left then right. */
  waveform: Float32Array;
  /** [1, 4, BINS, FRAMES]: left re, left im, right re, right im. */
  magSpec: Float32Array;
}

/**
 * The model's two inputs for one segment (SEG samples a channel, zero-padded
 * already), as demucs-web's prepareModelInput makes them. `into` is reused
 * if given (its arrays are overwritten).
 */
export class SpectralIn {
  private readonly padL = new Float64Array(SEG + PAD + PAD_RIGHT);
  private readonly padR = new Float64Array(SEG + PAD + PAD_RIGHT);
  private readonly cenL = new Float64Array(CENTRED);
  private readonly cenR = new Float64Array(CENTRED);
  private readonly re = new Float64Array(N);
  private readonly im = new Float64Array(N);
  /** The spectrum frame by frame ([4][FRAMES][BINS]), before it's laid out as the model wants. */
  private readonly byFrame = new Float64Array(4 * PLANE);

  prepare(left: Float32Array, right: Float32Array, into?: ModelInput): ModelInput {
    const out: ModelInput = into ?? { waveform: new Float32Array(2 * SEG), magSpec: new Float32Array(4 * PLANE) };
    out.waveform.set(left, 0);
    out.waveform.set(right, SEG);

    // Pad as demucs does, then centre (both reflections, as demucs-web's).
    reflectInto(this.padL, left, SEG, PAD, PAD_RIGHT, 0);
    reflectInto(this.padR, right, SEG, PAD, PAD_RIGHT, 0);
    const plen = SEG + PAD + PAD_RIGHT;
    reflectInto(this.cenL, this.padL, plen, N / 2, N / 2, 0);
    reflectInto(this.cenR, this.padR, plen, N / 2, N / 2, 0);

    const { re, im, cenL, cenR, byFrame: spec } = this;
    const scale = 0.5 / Math.sqrt(N); // demucs-web normalises by √N; ½ from unpacking
    for (let f = 0; f < FRAMES; f++) {
      const start = (f + FRAME0) * HOP;
      for (let i = 0; i < N; i++) {
        const w = WINDOW[i];
        re[i] = cenL[start + i] * w;
        im[i] = cenR[start + i] * w;
      }
      fft(re, im, -1);
      // Z = L + iR, so L[k] = (Z[k] + conj Z[N−k]) / 2, R[k] = (Z[k] − conj Z[N−k]) / 2i.
      for (let k = 0; k < BINS; k++) {
        const m = k === 0 ? 0 : N - k;
        const zr = re[k];
        const zi = im[k];
        const wr = re[m];
        const wi = im[m];
        const at = f * BINS + k;
        spec[at] = (zr + wr) * scale;
        spec[PLANE + at] = (zi - wi) * scale;
        spec[2 * PLANE + at] = (zi + wi) * scale;
        spec[3 * PLANE + at] = (wr - zr) * scale;
      }
    }
    for (let c = 0; c < 4; c++) transpose(spec, c * PLANE, out.magSpec, c * PLANE, FRAMES, BINS);
    return out;
  }
}

/* ── Out of the model ─────────────────────────────────────────────────── */

/** 1 / Σ window² over the iSTFT's output, for the part a segment uses. */
const INV_NORM = (() => {
  const sum = new Float64Array(SEG);
  for (let f = 0; f < ALL_FRAMES; f++) {
    const start = f * HOP - OUT_OFFSET;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      if (j >= 0 && j < SEG) sum[j] += WINDOW[i] * WINDOW[i];
    }
  }
  const inv = new Float64Array(SEG);
  for (let j = 0; j < SEG; j++) inv[j] = sum[j] > 1e-8 ? 1 / sum[j] : 0;
  return inv;
})();

/**
 * One part's spectrogram branch as sound, as demucs-web's standaloneIspec
 * gives it: `freq` is the model's [1, tracks, 4, BINS, FRAMES] output,
 * `track` the part's index. Writes the first `len` samples of each channel
 * into `outL` / `outR` (Float64, so the caller adds the waveform branch in
 * full precision).
 */
export class SpectralOut {
  private readonly accL = new Float64Array(SEG);
  private readonly accR = new Float64Array(SEG);
  private readonly re = new Float64Array(N);
  private readonly im = new Float64Array(N);
  /** One part's four planes frame by frame ([4][FRAMES][BINS]). */
  private readonly byFrame = new Float32Array(4 * PLANE);

  istft(freq: Float32Array, track: number, len: number, outL: Float64Array, outR: Float64Array) {
    const { accL, accR, re, im, byFrame: spec } = this;
    accL.fill(0);
    accR.fill(0);
    for (let c = 0; c < 4; c++) transpose(freq, (track * 4 + c) * PLANE, spec, c * PLANE, BINS, FRAMES);
    // demucs-web: ifft (÷N) × √N, then ÷ Σ window².
    const scale = Math.sqrt(N) / N;
    for (let f = 0; f < FRAMES; f++) {
      // Z = L + iR over the full (Hermitian) spectrum: its inverse is left + i·right.
      // The Nyquist bin is the model's padding (zero), and DC's imaginary
      // parts don't reach a real output (demucs-web drops them too).
      const row = f * BINS;
      re[0] = spec[row];
      im[0] = spec[2 * PLANE + row];
      re[N / 2] = 0;
      im[N / 2] = 0;
      for (let k = 1; k < BINS; k++) {
        const at = row + k;
        const lr = spec[at];
        const li = spec[at + PLANE];
        const rr = spec[at + 2 * PLANE];
        const ri = spec[at + 3 * PLANE];
        re[k] = lr - ri;
        im[k] = li + rr;
        re[N - k] = lr + ri;
        im[N - k] = rr - li;
      }
      fft(re, im, 1);
      // This frame's place in the segment (frame FRAME0 + f of the full STFT).
      const start = (f + FRAME0) * HOP - OUT_OFFSET;
      const i0 = Math.max(0, -start);
      const i1 = Math.min(N, len - start);
      for (let i = i0; i < i1; i++) {
        const w = WINDOW[i] * scale;
        accL[start + i] += re[i] * w;
        accR[start + i] += im[i] * w;
      }
    }
    for (let j = 0; j < len; j++) {
      outL[j] = accL[j] * INV_NORM[j];
      outR[j] = accR[j] * INV_NORM[j];
    }
  }
}

export const SPECTRAL = { N, HOP, SEG, BINS, FRAMES } as const;
