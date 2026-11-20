import { TAU, make, rng, saw, type Render } from './dsp';

/**
 * The sampler's original eight DJ sounds (horn, siren, laser, rewind, clap,
 * riser, boom, stab), unchanged, so pads 1–8 of bank A sound as they always
 * have.
 */

const noise = rng(7);

export const CLASSICS: { name: string; voice: Render }[] = [
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
