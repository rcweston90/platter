import { TAU, crusher, drive, env, make, midiHz, onePole, rng, saw, square, svf, tri, widen, type Render } from './dsp';

/**
 * Parametric drum-machine and synth voices. Each takes a handful of numbers
 * and returns a renderer; the library (catalog.ts) spans hundreds of sounds
 * by walking these parameters. The recipes are the classic analogue ones:
 * pitch-swept sines for kicks and toms, tone plus filtered noise for snares,
 * six detuned square waves through a high-pass for metallic hats, and so on.
 */

export interface Lofi {
  /** 0 = clean. */
  drive?: number;
  /** Bit depth, e.g. 8; 0 = off. */
  bits?: number;
  /** Sample-and-hold factor, e.g. 3 = a third of the rate. */
  hold?: number;
}

function finish(lofi: Lofi | undefined) {
  const crush = lofi?.bits ? crusher(lofi.bits, lofi.hold ?? 1) : null;
  const d = lofi?.drive ?? 0;
  return (x: number) => {
    const y = drive(x, d);
    return crush ? crush(y) : y;
  };
}

/* ── Drums ──────────────────────────────────────────────────────────────── */

export interface KickParams extends Lofi {
  /** Resting pitch in Hz. */
  pitch: number;
  /** How far above `pitch` the sweep starts, in Hz. */
  sweep: number;
  /** Pitch-sweep time constant, seconds. */
  bend: number;
  /** Amplitude decay, seconds. */
  decay: number;
  /** Click level 0–1. */
  click: number;
  seed: number;
}

export const kick = (p: KickParams): Render => (sr) => {
  const n = rng(p.seed);
  const fx = finish(p);
  const lp = onePole();
  let ph = 0;
  const len = Math.min(3, p.decay * 5 + 0.05);
  return make(sr, len, (t) => {
    ph += (p.pitch + p.sweep * Math.exp(-t / p.bend)) / sr;
    const body = Math.sin(TAU * ph) * env(t, 0.0015, p.decay);
    const click = p.click * lp(n(), 6000, sr) * Math.exp(-t / 0.006) * 2;
    return fx(body * 1.2 + click);
  });
};

export interface SnareParams extends Lofi {
  /** Body tone in Hz. */
  tone: number;
  toneDecay: number;
  noiseDecay: number;
  /** Noise colour: band centre in Hz. */
  color: number;
  /** 0 = all tone … 1 = all noise. */
  mix: number;
  seed: number;
}

export const snare = (p: SnareParams): Render => (sr) => {
  const n = rng(p.seed);
  const fx = finish(p);
  const f = svf();
  const wide = widen(0.6, sr);
  let ph = 0;
  let ph2 = 0;
  const len = Math.min(1.6, Math.max(p.noiseDecay, p.toneDecay) * 5 + 0.03);
  return make(sr, len, (t) => {
    ph += (p.tone * (1 + 0.5 * Math.exp(-t / 0.01))) / sr;
    ph2 += (p.tone * 1.48) / sr;
    const body = (Math.sin(TAU * ph) + 0.5 * Math.sin(TAU * ph2)) * env(t, 0.001, p.toneDecay);
    const nz = f(n(), p.color, sr, 0.6);
    const hiss = (nz.band + nz.high * 0.6) * env(t, 0.001, p.noiseDecay);
    return wide(fx(body * (1 - p.mix) * 1.1 + hiss * p.mix * 1.6));
  });
};

export interface ClapParams extends Lofi {
  /** Number of hand hits before the tail. */
  bursts: number;
  /** Gap between hits, seconds. */
  spread: number;
  decay: number;
  color: number;
  seed: number;
}

export const clap = (p: ClapParams): Render => (sr) => {
  const n = rng(p.seed);
  const fx = finish(p);
  const f = svf();
  const wide = widen(1.1, sr);
  const tail = p.bursts * p.spread;
  return make(sr, tail + p.decay * 5, (t) => {
    let e: number;
    if (t < tail) e = Math.exp(-(t % p.spread) / (p.spread * 0.35));
    else e = Math.exp(-(t - tail) / p.decay);
    const nz = f(n(), p.color, sr, 1.4);
    return wide(fx(nz.band * e * 2.2));
  });
};

const HAT_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

export interface HatParams extends Lofi {
  decay: number;
  /** Base frequency of the metal oscillators, Hz. */
  metal: number;
  /** 0 = metallic squares … 1 = white noise. */
  noise: number;
  /** High-pass cutoff, Hz. */
  cut: number;
  seed: number;
}

export const hat = (p: HatParams): Render => (sr) => {
  const n = rng(p.seed);
  const fx = finish(p);
  const f = svf();
  const g = svf();
  const ph = HAT_RATIOS.map(() => 0);
  const wide = widen(0.4, sr);
  return make(sr, Math.min(2.5, p.decay * 5 + 0.02), (t) => {
    let m = 0;
    for (let k = 0; k < 6; k++) {
      ph[k] += (p.metal * HAT_RATIOS[k]) / sr;
      m += square(ph[k]);
    }
    const x = m * (1 - p.noise) * 0.18 + n() * p.noise;
    const band = f(x, p.cut * 1.4, sr, 1.2).band;
    const high = g(band, p.cut, sr, 0.7).high;
    return wide(fx(high * env(t, 0.0008, p.decay) * 2));
  });
};

export interface CymbalParams extends Lofi {
  decay: number;
  metal: number;
  /** Ride ping level, 0–1. */
  ping: number;
  seed: number;
}

export const cymbal = (p: CymbalParams): Render => (sr) => {
  const n = rng(p.seed);
  const fx = finish(p);
  const f = svf();
  const ph = HAT_RATIOS.map(() => 0);
  let bell = 0;
  return make(sr, Math.min(4, p.decay * 4), (t) => {
    let m = 0;
    for (let k = 0; k < 6; k++) {
      ph[k] += (p.metal * HAT_RATIOS[k] * (1 + 0.002 * k)) / sr;
      m += square(ph[k]);
    }
    bell += (p.metal * 7.1) / sr;
    const x = f(m * 0.12 + n() * 0.6, 5500, sr, 0.8).high;
    const ping = Math.sin(TAU * bell) * p.ping * env(t, 0.001, 0.35);
    const l = x * env(t, 0.002, p.decay) * 1.6 + ping;
    return [fx(l), fx(l * 0.92 + n() * 0.05 * env(t, 0.002, p.decay))];
  });
};

export interface TomParams extends Lofi {
  pitch: number;
  decay: number;
  /** Pitch drop as a fraction, e.g. 0.4. */
  drop: number;
  /** Stick noise, 0–1. */
  stick: number;
  seed: number;
}

export const tom = (p: TomParams): Render => (sr) => {
  const n = rng(p.seed);
  const fx = finish(p);
  const lp = onePole();
  let ph = 0;
  return make(sr, Math.min(2, p.decay * 5), (t) => {
    ph += (p.pitch * (1 + p.drop * Math.exp(-t / (p.decay * 0.6)))) / sr;
    const body = Math.sin(TAU * ph) * env(t, 0.001, p.decay);
    const stick = lp(n(), 3000, sr) * p.stick * Math.exp(-t / 0.01) * 2;
    return fx(body + stick);
  });
};

/** Hand and small percussion. */
export type PercKind = 'rim' | 'clave' | 'cowbell' | 'wood' | 'shaker' | 'conga' | 'bongo' | 'tamb' | 'triangle' | 'snap' | 'zap' | 'blip' | 'metal' | 'kalimba' | 'guiro';

export interface PercParams extends Lofi {
  kind: PercKind;
  /** Pitch multiplier around the kind's natural pitch. */
  tune: number;
  /** Decay multiplier. */
  length: number;
  seed: number;
}

export const perc = (p: PercParams): Render => (sr) => {
  const n = rng(p.seed);
  const fx = finish(p);
  const f = svf();
  const g = svf();
  const k = p.tune;
  const L = p.length;
  let a = 0;
  let b = 0;
  switch (p.kind) {
    case 'rim':
      return make(sr, 0.12 * L, (t) => {
        a += (1700 * k) / sr;
        const x = tri(a) * env(t, 0.0003, 0.012 * L) + f(n(), 3500 * k, sr, 3).band * env(t, 0.0003, 0.006 * L) * 2;
        return fx(x);
      });
    case 'clave':
      return make(sr, 0.3 * L, (t) => {
        a += (2500 * k) / sr;
        return fx(Math.sin(TAU * a) * env(t, 0.0003, 0.04 * L));
      });
    case 'cowbell':
      return make(sr, 0.6 * L, (t) => {
        a += (540 * k) / sr;
        b += (800 * k) / sr;
        const x = f(square(a) + square(b), 900 * k, sr, 2.5).band;
        return fx(x * (0.6 * Math.exp(-t / 0.02) + 0.4 * env(t, 0.001, 0.12 * L)) * 1.5);
      });
    case 'wood':
      return make(sr, 0.25 * L, (t) => {
        a += (900 * k * (1 + 0.1 * Math.exp(-t / 0.005))) / sr;
        return fx(Math.sin(TAU * a) * env(t, 0.0004, 0.03 * L) + f(n(), 2000 * k, sr, 4).band * Math.exp(-t / 0.004));
      });
    case 'shaker':
      return make(sr, 0.22 * L, (t) => {
        const e = t < 0.05 * L ? t / (0.05 * L) : Math.exp(-(t - 0.05 * L) / (0.03 * L));
        return fx(g(n(), 6500 * k, sr, 0.8).high * e * 1.2);
      });
    case 'conga':
    case 'bongo': {
      const base = p.kind === 'conga' ? 220 : 400;
      return make(sr, 0.5 * L, (t) => {
        a += (base * k * (1 + 0.25 * Math.exp(-t / 0.02))) / sr;
        const slap = f(n(), 1800 * k, sr, 1.5).band * Math.exp(-t / 0.006);
        return fx(Math.sin(TAU * a) * env(t, 0.001, 0.09 * L) + slap * 0.8);
      });
    }
    case 'tamb':
      return make(sr, 0.5 * L, (t) => {
        a += (4100 * k) / sr;
        const jingle = (f(n(), 7000 * k, sr, 4).band + square(a) * 0.15) * env(t, 0.002, 0.12 * L);
        return fx(jingle * 1.6);
      });
    case 'triangle':
      return make(sr, 1.6 * L, (t) => {
        a += (2800 * k) / sr;
        b += (2800 * k * 2.76) / sr;
        return fx((Math.sin(TAU * a) + 0.4 * Math.sin(TAU * b)) * env(t, 0.001, 0.45 * L) * 0.8);
      });
    case 'snap':
      return make(sr, 0.15 * L, (t) => fx(f(n(), 2800 * k, sr, 2.5).band * env(t, 0.0005, 0.015 * L) * 3));
    case 'zap':
      return make(sr, 0.25 * L, (t) => {
        a += (200 * k + 4000 * k * Math.exp(-t / (0.02 * L))) / sr;
        return fx(Math.sin(TAU * a) * env(t, 0.0005, 0.06 * L));
      });
    case 'blip':
      return make(sr, 0.18 * L, (t) => {
        a += (1200 * k) / sr;
        return fx(square(a) * 0.5 * env(t, 0.001, 0.04 * L));
      });
    case 'metal':
      return make(sr, 0.8 * L, (t) => {
        a += (330 * k) / sr;
        b += (330 * k * 3.7) / sr;
        return fx(Math.sin(TAU * a + 2.5 * Math.sin(TAU * b) * Math.exp(-t / 0.1)) * env(t, 0.001, 0.2 * L));
      });
    case 'kalimba':
      return make(sr, 1.2 * L, (t) => {
        a += (880 * k) / sr;
        b += (880 * k * 5.4) / sr;
        return fx((Math.sin(TAU * a) + 0.3 * Math.sin(TAU * b) * Math.exp(-t / 0.02)) * env(t, 0.001, 0.3 * L));
      });
    case 'guiro':
      return make(sr, 0.4 * L, (t) => {
        const scrape = 0.5 + 0.5 * Math.sin(TAU * 38 * t);
        const e = Math.min(1, t / 0.01) * Math.max(0, 1 - t / (0.3 * L));
        return fx(f(n(), 3800 * k, sr, 3).band * scrape * e * 2);
      });
  }
};

/* ── Tonal ──────────────────────────────────────────────────────────────── */

export type BassKind = 'sub' | 'reese' | 'acid' | 'pluck' | 'growl';

export const bass = (kind: BassKind, note: number, seed: number): Render => (sr) => {
  const hz = midiHz(note);
  const f = svf();
  const n = rng(seed);
  const ph = [0, 0, 0];
  const len = kind === 'sub' ? 1.4 : kind === 'reese' ? 1.6 : kind === 'acid' ? 0.6 : kind === 'growl' ? 1.2 : 0.7;
  return make(sr, len, (t) => {
    const e = env(t, 0.003, kind === 'sub' ? 0.5 : kind === 'reese' ? 0.7 : kind === 'growl' ? 0.45 : 0.2) * Math.min(1, (len - t) / 0.05);
    switch (kind) {
      case 'sub':
        ph[0] += hz / sr;
        return (Math.sin(TAU * ph[0]) + 0.15 * Math.sin(TAU * ph[0] * 2)) * e;
      case 'reese': {
        ph[0] += (hz * 0.995) / sr;
        ph[1] += (hz * 1.005) / sr;
        ph[2] += hz / 2 / sr;
        const x = saw(ph[0]) + saw(ph[1]);
        const lo = f(x, 600 + 300 * Math.sin(TAU * 0.7 * t), sr, 0.9).low;
        return [lo * 0.6 * e + Math.sin(TAU * ph[2]) * 0.5 * e, lo * 0.6 * e * 0.9 + Math.sin(TAU * ph[2]) * 0.5 * e];
      }
      case 'acid': {
        ph[0] += hz / sr;
        const cut = 300 + 3200 * Math.exp(-t / 0.08);
        return drive(f(saw(ph[0]), cut, sr, 5).low * e * 0.9, 0.3);
      }
      case 'growl': {
        ph[0] += hz / sr;
        ph[1] += (hz * 1.01) / sr;
        const wob = 0.5 + 0.5 * Math.sin(TAU * 4 * t - Math.PI / 2);
        const x = square(ph[0]) * 0.5 + saw(ph[1]) * 0.5;
        return drive(f(x, 200 + 1800 * wob, sr, 3).low * e, 0.5);
      }
      case 'pluck': {
        ph[0] += hz / sr;
        const cut = 200 + 2500 * Math.exp(-t / 0.05);
        return f(saw(ph[0]) * 0.7 + square(ph[0] * 0.5) * 0.3 + n() * 0.01, cut, sr, 1.2).low * e * 1.2;
      }
    }
  });
};

export type ChordKind = 'min7' | 'maj7' | 'min9' | 'maj9' | 'sus' | 'power' | 'dom7' | 'min';

export const CHORDS: Record<ChordKind, { label: string; notes: number[]; minor: boolean }> = {
  min: { label: 'Minor', notes: [0, 3, 7, 12], minor: true },
  min7: { label: 'Minor 7', notes: [0, 3, 7, 10], minor: true },
  min9: { label: 'Minor 9', notes: [0, 3, 7, 10, 14], minor: true },
  maj7: { label: 'Major 7', notes: [0, 4, 7, 11], minor: false },
  maj9: { label: 'Major 9', notes: [0, 4, 7, 11, 14], minor: false },
  dom7: { label: 'Dominant 7', notes: [0, 4, 7, 10], minor: false },
  sus: { label: 'Sus 2', notes: [0, 2, 7, 12], minor: false },
  power: { label: 'Power', notes: [0, 7, 12], minor: false },
};

export type StabTone = 'house' | 'organ' | 'rave' | 'dub';

export const stab = (tone: StabTone, chord: ChordKind, root: number, seed: number): Render => (sr) => {
  const notes = CHORDS[chord].notes.map((i) => midiHz(root + i));
  const ph = notes.map(() => 0);
  const ph2 = notes.map(() => 0);
  const f = svf();
  const n = rng(seed);
  const len = tone === 'dub' ? 1.6 : tone === 'organ' ? 0.9 : 0.75;
  const echo = tone === 'dub' ? new Float32Array(Math.round(sr * 0.375)) : null;
  let w = 0;
  return make(sr, len, (t) => {
    let x = 0;
    notes.forEach((hz, k) => {
      ph[k] += hz / sr;
      ph2[k] += (hz * 1.007) / sr;
      if (tone === 'organ') x += Math.sin(TAU * ph[k]) + 0.5 * Math.sin(TAU * ph[k] * 2) + 0.25 * Math.sin(TAU * ph[k] * 4);
      else if (tone === 'rave') x += square(ph[k]) * 0.6 + saw(ph2[k]) * 0.6;
      else x += saw(ph[k]) + saw(ph2[k]) * 0.6;
    });
    x /= notes.length;
    const cut = tone === 'organ' ? 4000 : tone === 'rave' ? 600 + 5000 * Math.exp(-t / 0.15) : 300 + 3500 * Math.exp(-t / (tone === 'dub' ? 0.05 : 0.09));
    let y = f(x + n() * 0.002, cut, sr, tone === 'rave' ? 2 : 1).low * env(t, 0.002, tone === 'organ' ? 0.3 : 0.18) * 2.2;
    if (echo) {
      const d = echo[w];
      echo[w] = y + d * 0.45;
      w = (w + 1) % echo.length;
      return [y + d * 0.6, y * 0.8 + d * 0.75];
    }
    if (tone === 'organ') y *= Math.min(1, (len - t) / 0.1);
    return y;
  });
};

export type KeysTone = 'epiano' | 'pluck' | 'bell' | 'pad';

export const keys = (tone: KeysTone, note: number, seed: number): Render => (sr) => {
  const hz = midiHz(note);
  const n = rng(seed);
  if (tone === 'pluck') {
    // Karplus–Strong: a burst of noise recirculating through a short delay.
    const len = Math.max(2, Math.round(sr / hz));
    const line = new Float32Array(len).map(() => n());
    let i = 0;
    let prev = 0;
    return make(sr, 1.4, () => {
      const cur = line[i];
      const next = 0.996 * 0.5 * (cur + prev);
      prev = cur;
      line[i] = next;
      i = (i + 1) % len;
      return cur;
    });
  }
  let a = 0;
  let b = 0;
  const ph = [0, 0, 0, 0];
  const f = svf();
  return make(sr, tone === 'pad' ? 2.4 : tone === 'bell' ? 2.2 : 1.5, (t) => {
    switch (tone) {
      case 'epiano': {
        a += hz / sr;
        b += (hz * 14) / sr;
        const tine = Math.sin(TAU * b) * Math.exp(-t / 0.03) * 0.8;
        return Math.sin(TAU * a + tine) * env(t, 0.002, 0.6) * (1 + 0.1 * Math.sin(TAU * 5 * t));
      }
      case 'bell': {
        a += hz / sr;
        b += (hz * 3.5) / sr;
        return Math.sin(TAU * a + 1.8 * Math.sin(TAU * b) * Math.exp(-t / 0.4)) * env(t, 0.001, 0.7);
      }
      case 'pad': {
        let x = 0;
        for (let k = 0; k < 4; k++) {
          ph[k] += (hz * (1 + (k - 1.5) * 0.004)) / sr;
          x += saw(ph[k]);
        }
        const e = Math.min(1, t / 0.4) * Math.min(1, (2.4 - t) / 0.8);
        const y = f(x * 0.25, 1200 + 600 * Math.sin(TAU * 0.3 * t), sr, 0.8).low * e;
        return [y, f(y, 900, sr).low * 0.4 + y * 0.6];
      }
    }
    return 0;
  });
};

/* ── FX ─────────────────────────────────────────────────────────────────── */

export type FxKind = 'riser' | 'downlifter' | 'impact' | 'laser' | 'siren' | 'horn' | 'rewind' | 'sweep' | 'noise' | 'drop' | 'stutter' | 'alarm';

export interface FxParams {
  kind: FxKind;
  /** Length in seconds. */
  length: number;
  /** Pitch multiplier. */
  tune: number;
  seed: number;
}

export const fx = (p: FxParams): Render => (sr) => {
  const n = rng(p.seed);
  const f = svf();
  const g = svf();
  const L = p.length;
  const k = p.tune;
  let a = 0;
  let b = 0;
  const ph3 = [0, 0, 0];
  switch (p.kind) {
    case 'riser':
      return make(sr, L, (t) => {
        const u = t / L;
        a += ((200 + 1800 * u * u) * k) / sr;
        const air = f(n(), 300 + 9000 * u * u, sr, 3).band;
        return [(air * 0.8 + Math.sin(TAU * a) * 0.3) * u * u, (air * 0.7 + Math.sin(TAU * a * 1.01) * 0.3) * u * u];
      });
    case 'downlifter':
      return make(sr, L, (t) => {
        const u = t / L;
        a += ((2000 * (1 - u) ** 2 + 60) * k) / sr;
        const air = f(n(), 9000 * (1 - u) ** 2 + 200, sr, 2).band;
        return (air * 0.7 + Math.sin(TAU * a) * 0.4) * (1 - u) * Math.min(1, t / 0.01);
      });
    case 'impact':
      return make(sr, L, (t) => {
        a += ((38 + 80 * Math.exp(-t / 0.06)) * k) / sr;
        const boom = Math.sin(TAU * a) * env(t, 0.001, L * 0.25);
        const crash = g(n(), 3000, sr, 0.7).high * env(t, 0.001, L * 0.2) * 0.5;
        return [boom * 1.3 + crash, boom * 1.3 + crash * 0.8];
      });
    case 'laser':
      return make(sr, L, (t) => {
        a += ((100 + 3200 * Math.exp(-t / (L * 0.12))) * k) / sr;
        return Math.sin(TAU * a) * Math.exp(-t / (L * 0.4));
      });
    case 'siren':
      return make(sr, L, (t) => {
        const hz = (700 + 450 * Math.sin(TAU * (1.2 + p.seed % 3) * t)) * k;
        a += hz / sr;
        const e = Math.min(1, t / 0.03) * Math.min(1, (L - t) / 0.2);
        return (Math.sin(TAU * a) * 0.7 + square(a) * 0.12) * e;
      });
    case 'horn': {
      // Blasts of detuned saws, the reggae air horn.
      const blasts = Math.max(1, Math.round(L / 0.35));
      return make(sr, L, (t) => {
        const slot = L / blasts;
        const local = t % slot;
        const last = t >= slot * (blasts - 1);
        const len = last ? slot : slot * 0.55;
        if (local > len) return 0;
        const e = Math.min(1, local / 0.01) * Math.min(1, (len - local) / 0.04);
        const hz = 466 * k * (1 - 0.05 * (local / len));
        for (let j = 0; j < 3; j++) ph3[j] = (ph3[j] + (hz * (1 + (j - 1) * 0.012)) / sr) % 1;
        return (saw(ph3[0]) + saw(ph3[1]) + saw(ph3[2])) * 0.45 * e;
      });
    }
    case 'rewind':
      return make(sr, L, (t) => {
        const hz = 180 * k * 10 ** (t / (L * 0.66)) * (1 + 0.08 * Math.sin(TAU * 31 * t));
        a += hz / sr;
        const e = Math.min(1, t / 0.05) * Math.min(1, (L - t) / 0.1);
        return (saw(a) * 0.35 + f(n(), 1200, sr).low * 1.4) * e;
      });
    case 'sweep':
      return make(sr, L, (t) => {
        const u = t / L;
        const cut = 200 * 40 ** Math.sin(Math.PI * u) * k;
        return [f(n(), cut, sr, 4).band * Math.sin(Math.PI * u), g(n(), cut * 1.1, sr, 4).band * Math.sin(Math.PI * u)];
      });
    case 'noise':
      return make(sr, L, (t) => {
        const e = env(t, 0.005, L * 0.3);
        return [f(n(), 8000 * k, sr, 0.6).high * e, g(n(), 7000 * k, sr, 0.6).high * e];
      });
    case 'drop':
      return make(sr, L, (t) => {
        a += ((900 * Math.exp(-t / (L * 0.25)) + 30) * k) / sr;
        return drive(Math.sin(TAU * a) * env(t, 0.002, L * 0.5), 0.4);
      });
    case 'stutter':
      return make(sr, L, (t) => {
        const rate = 8 + 24 * (t / L);
        const gate = (t * rate) % 1 < 0.5 ? 1 : 0;
        a += (300 * k) / sr;
        return (saw(a) * 0.4 + f(n(), 2500, sr, 2).band) * gate * Math.min(1, (L - t) / 0.05);
      });
    case 'alarm':
      return make(sr, L, (t) => {
        b = Math.floor(t * 6) % 2;
        a += ((b ? 960 : 720) * k) / sr;
        return square(a) * 0.35 * Math.min(1, (L - t) / 0.05);
      });
  }
};

/* ── Vox ────────────────────────────────────────────────────────────────── */

const VOWELS: Record<string, [number, number, number]> = {
  ah: [800, 1150, 2900],
  eh: [530, 1840, 2480],
  ee: [270, 2290, 3010],
  oh: [500, 900, 2800],
  oo: [325, 700, 2530],
};

export type Vowel = keyof typeof VOWELS;
export const VOWEL_NAMES = Object.keys(VOWELS) as Vowel[];

/** A sung vowel: a glottal pulse train through three formant filters.
 *  `shout` adds breath and a falling pitch, for a "hey!". */
export const vox = (vowel: Vowel, note: number, shout: boolean, seed: number): Render => (sr) => {
  const [f1, f2, f3] = VOWELS[vowel];
  const fs = [svf(), svf(), svf()];
  const n = rng(seed);
  const hz = midiHz(note);
  let ph = 0;
  const len = shout ? 0.45 : 1.1;
  return make(sr, len, (t) => {
    const vib = shout ? 1 - 0.18 * (t / len) : 1 + 0.012 * Math.sin(TAU * 5.5 * t) * Math.min(1, t / 0.3);
    ph += (hz * vib) / sr;
    const pulse = saw(ph) * 0.6 + n() * (shout ? 0.35 : 0.04);
    const y = fs[0](pulse, f1, sr, 6).band + fs[1](pulse, f2, sr, 8).band * 0.6 + fs[2](pulse, f3, sr, 10).band * 0.3;
    const e = Math.min(1, t / (shout ? 0.01 : 0.06)) * Math.min(1, (len - t) / (shout ? 0.15 : 0.25));
    return y * e * 3;
  });
};
