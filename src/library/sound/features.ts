import { fft } from '../../engine/fft';

/**
 * CLAP's audio front end: a 10-second, 48 kHz mono window turned into the
 * log-mel spectrogram the CLAP audio encoder reads (1001 frames × 64 mel
 * bands). It follows Hugging Face's ClapFeatureExtractor for the "unfused"
 * checkpoints (truncation "rand_trunc", Slaney mel filters, power
 * spectrogram, 10·log10), as ported to JavaScript by transformers.js
 * (Apache-2.0). tests/sound.mjs checks it against the Python original.
 *
 * Pure TypeScript, no Web Audio or ONNX Runtime, so it runs in a worker and in
 * Node alike.
 */

export interface ClapFeatureConfig {
  sampling_rate: number;
  feature_size: number;
  fft_window_size: number;
  hop_length: number;
  frequency_min: number;
  frequency_max: number;
  nb_max_samples: number;
  padding: 'repeatpad' | 'repeat' | 'pad';
}

/** laion/clap-htsat-unfused's preprocessor_config.json, the values that matter. */
export const CLAP_CONFIG: ClapFeatureConfig = {
  sampling_rate: 48000,
  feature_size: 64,
  fft_window_size: 1024,
  hop_length: 480,
  frequency_min: 50,
  frequency_max: 14000,
  nb_max_samples: 480000,
  padding: 'repeatpad',
};

/** Reads the fields this needs from a preprocessor_config.json, keeping the defaults for anything missing. */
export function configFrom(json: Partial<Record<keyof ClapFeatureConfig, unknown>> | null | undefined): ClapFeatureConfig {
  const out = { ...CLAP_CONFIG } as Record<string, unknown>;
  if (json) for (const k of Object.keys(CLAP_CONFIG)) if (json[k as keyof ClapFeatureConfig] != null) out[k] = json[k as keyof ClapFeatureConfig];
  return out as unknown as ClapFeatureConfig;
}

const slaneyHzToMel = (f: number) => (f >= 1000 ? 15 + Math.log(f / 1000) * (27 / Math.log(6.4)) : (3 * f) / 200);
const slaneyMelToHz = (m: number) => (m >= 15 ? 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)) : (200 * m) / 3);

export interface MelBank {
  /** Per mel band: first FFT bin with a non-zero weight. */
  start: Int32Array;
  /** Per mel band: the weights from `start` on. */
  weights: Float64Array[];
}

/** Slaney-scale, Slaney-normalised triangular filters (librosa's defaults). */
export function slaneyMelBank(cfg: ClapFeatureConfig = CLAP_CONFIG): MelBank {
  const nBins = cfg.fft_window_size / 2 + 1;
  const nMel = cfg.feature_size;
  const melMin = slaneyHzToMel(cfg.frequency_min);
  const melMax = slaneyHzToMel(cfg.frequency_max);
  const filterHz = Float64Array.from({ length: nMel + 2 }, (_, i) => slaneyMelToHz(melMin + ((melMax - melMin) * i) / (nMel + 1)));
  const nyq = Math.floor(cfg.sampling_rate / 2);
  const fftHz = Float64Array.from({ length: nBins }, (_, j) => (nyq * j) / (nBins - 1));
  const start = new Int32Array(nMel);
  const weights: Float64Array[] = [];
  for (let i = 0; i < nMel; i++) {
    const row = new Float64Array(nBins);
    const lower = filterHz[i + 1] - filterHz[i];
    const upper = filterHz[i + 2] - filterHz[i + 1];
    const enorm = 2 / (filterHz[i + 2] - filterHz[i]);
    let first = -1;
    let last = -1;
    for (let j = 0; j < nBins; j++) {
      const down = (fftHz[j] - filterHz[i]) / lower;
      const up = (filterHz[i + 2] - fftHz[j]) / upper;
      const w = Math.max(0, Math.min(down, up)) * enorm;
      row[j] = w;
      if (w > 0) {
        if (first < 0) first = j;
        last = j;
      }
    }
    if (first < 0) first = last = 0;
    start[i] = first;
    weights.push(row.slice(first, last + 1));
  }
  return { start, weights };
}

/** numpy.hanning(n + 1)[:n] — the periodic Hann window. */
function hann(n: number) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Pads or repeats a window to exactly `len` samples, the way the extractor does for short audio. */
export function fitLength(x: Float32Array, len: number, padding: ClapFeatureConfig['padding']): Float32Array {
  if (x.length === len) return x;
  if (x.length > len) return x.subarray(0, len);
  const out = new Float32Array(len);
  out.set(x);
  if (x.length === 0) return out;
  if (padding === 'repeat') {
    for (let i = x.length; i < len; i += x.length) out.set(x.subarray(0, Math.min(x.length, len - i)), i);
  } else if (padding === 'repeatpad') {
    // Whole repeats only, then zeros (the Python original's floor division).
    const reps = Math.floor(len / x.length);
    for (let r = 1; r < reps; r++) out.set(x, r * x.length);
  }
  return out;
}

export interface Extractor {
  readonly config: ClapFeatureConfig;
  /** Frames in one window (1001 for 10 s at hop 480). */
  readonly frames: number;
  /** Log-mel features for one window, frames × mel bands, row-major. */
  features(window: Float32Array): Float32Array;
}

export function createExtractor(cfg: ClapFeatureConfig = CLAP_CONFIG): Extractor {
  const n = cfg.fft_window_size;
  const hop = cfg.hop_length;
  const nBins = n / 2 + 1;
  const nMel = cfg.feature_size;
  const win = hann(n);
  const bank = slaneyMelBank(cfg);
  const len = cfg.nb_max_samples;
  const pad = n >> 1;
  const frames = 1 + Math.floor(len / hop);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const power = new Float64Array(nBins);
  return {
    config: cfg,
    frames,
    features(window: Float32Array) {
      const x = fitLength(window, len, cfg.padding);
      // Centre-padded by reflection (numpy's "reflect": the edge isn't repeated).
      const at = (k: number) => {
        let i = k - pad;
        if (i < 0) i = -i;
        if (i >= len) i = 2 * (len - 1) - i;
        return x[i];
      };
      const out = new Float32Array(frames * nMel);
      for (let f = 0; f < frames; f++) {
        const o = f * hop;
        for (let j = 0; j < n; j++) {
          re[j] = at(o + j) * win[j];
          im[j] = 0;
        }
        fft(re, im);
        for (let j = 0; j < nBins; j++) power[j] = re[j] * re[j] + im[j] * im[j];
        for (let m = 0; m < nMel; m++) {
          const w = bank.weights[m];
          const s0 = bank.start[m];
          let acc = 0;
          for (let j = 0; j < w.length; j++) acc += w[j] * power[s0 + j];
          out[f * nMel + m] = 10 * Math.log10(Math.max(1e-10, acc));
        }
      }
      return out;
    },
  };
}
