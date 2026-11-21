/**
 * DJ deck — a turntable's playhead, as an AudioWorklet.
 *
 * An AudioBufferSourceNode can't play backwards or follow a hand, so each deck
 * runs this instead: decoded PCM plus one fractional read position that moves
 * at a signed, continuously varying rate. Everything a record does falls out
 * of that one number:
 *
 *   · playing    — rate eases toward 1 + pitch + bend (the motor), with a
 *                  spin-up and a brake rather than a hard step;
 *   · scratching — the main thread sends where the hand has dragged the record
 *                  (`delta`, in frames since the touch). The playhead chases it
 *                  with a short time constant, so 60 Hz pointer events become a
 *                  smooth, sample-accurate rate — backwards included;
 *   · jumps      — cues, needle drops and loop wraps cross-fade the old read
 *                  position into the new one over XFADE frames, so they don't
 *                  click;
 *   · slip       — a second, "shadow" playhead keeps running at the motor's
 *                  speed while the record is held, reversed, censored or
 *                  rolling in a slip loop; when that ends, playback jumps to
 *                  the shadow, so the track carries on as if nothing happened.
 *
 *   · stems      — with a track split (engine/stems), the read also takes
 *                  drums, bass and vocals at the same position and the
 *                  output becomes  g_other · track + Σ (g_k − g_other) · stem_k,
 *                  "other" being the track minus the three. All parts up is
 *                  the track itself; levels glide over STEM_SLEW.
 *
 * Reads use 4-point Hermite interpolation. Position is reported every
 * REPORT_EVERY frames stamped with the context time it applies to, and the
 * main thread extrapolates between reports for drawing.
 *
 * Plain JS in public/ because AudioWorklet modules load by URL.
 */

/* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */

const XFADE = 256; // ≈ 6 ms at 44.1 kHz — long enough to hide a jump, short enough not to smear a cut
const REPORT_EVERY = 512; // ≈ 12 ms — the UI extrapolates in between
const SCRATCH_TAU = 0.012; // s — how hard the record chases the hand: lower is tighter but grainier
const SCRATCH_MAX = 8; // fastest a hand can throw a record, as a rate
const PITCH_SLEW = 8; // rate units per second for pitch fader moves while spinning
const STEM_SLEW = 0.015; // s — a stem mute or solo fades over this, so it doesn't click
const I16 = 1 / 32768;

function hermite(x, i, f, len) {
  const xm1 = x[i > 0 ? i - 1 : 0];
  const x0 = x[i];
  const x1 = x[i + 1 < len ? i + 1 : i];
  const x2 = x[i + 2 < len ? i + 2 : len - 1];
  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const b = w + a;
  return ((a * f - b) * f + c) * f + x0;
}

class DjDeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = null;
    this.right = null;
    this.length = 0;
    this.pos = 0;
    this.rate = 0;
    this.playing = false;
    this.pitch = 1;
    this.bend = 0;
    this.startTime = 0.06;
    this.brakeTime = 0.22;
    this.touch = false;
    this.touchBase = 0;
    this.touchTarget = 0;
    this.loopIn = -1;
    this.loopOut = -1;
    this.xPos = 0;
    this.xLeft = 0;
    this.dir = 1; // -1 while reversed
    this.slip = false;
    this.loopSlip = false; // the current loop returns to the shadow when it ends
    this.censor = false;
    this.shadow = 0;
    this.stopSlope = 0; // brake/spinback override, rate units per second
    this.sinceReport = 0;
    this.stems = null; // [{ left: Int16Array, right: Int16Array }] × 3: drums, bass, vocals
    this.stemLen = 0;
    this.stemRatio = 1; // stem frames per track frame
    this.stemTarget = [1, 1, 1, 1]; // drums, bass, vocals, other
    this.stemGain = [1, 1, 1, 1];
    this.stemPeak = [0, 0, 0, 0]; // each part's heard peak since the last report
    this.outL = 0;
    this.outR = 0;
    this.port.onmessage = (e) => this.message(e.data);
  }

  /** Is the playhead off on an excursion the shadow is keeping time through? */
  excursion() {
    return this.touch || this.dir < 0 || this.censor || (this.loopSlip && this.loopIn >= 0);
  }

  /** Is the shadow running? Slip mode covers every excursion; a censor or a
   *  beat roll (a slip loop) brings its own, slip mode or not. */
  tracking() {
    return (this.slip && this.excursion()) || this.censor || (this.loopSlip && this.loopIn >= 0);
  }

  message(m) {
    const wasOut = this.excursion();
    let returnTo = false;
    switch (m.type) {
      case 'load':
        this.left = m.left;
        this.right = m.right || m.left;
        this.length = m.left.length;
        this.pos = 0;
        this.rate = 0;
        this.playing = false;
        this.loopIn = this.loopOut = -1;
        this.xLeft = 0;
        this.dir = 1;
        this.censor = false;
        this.shadow = 0;
        this.clearStems();
        break;
      case 'unload':
        this.clearStems();
        this.left = this.right = null;
        this.length = 0;
        this.pos = 0;
        this.rate = 0;
        this.playing = false;
        break;
      case 'play':
        this.playing = true;
        if (m.instant) this.rate = this.pitch + this.bend;
        break;
      case 'pause':
        this.playing = false;
        if (m.instant) this.rate = 0;
        // A slow brake (the turntable's stop button with the motor torque down).
        if (m.brake) this.stopSlope = Math.max(0.2, Math.abs(this.rate)) / m.brake;
        break;
      case 'spinback':
        // A hand flicks the record backwards and lets it wind down.
        this.playing = false;
        this.rate = -Math.max(2.5, 3 * Math.abs(this.rate));
        this.stopSlope = Math.abs(this.rate) / (m.time || 1);
        break;
      case 'reverse':
        this.dir = m.on ? -1 : 1;
        returnTo = this.slip;
        break;
      case 'slip':
        this.slip = m.on;
        if (!m.on) this.loopSlip = false;
        break;
      case 'censor':
        // Reverse while held, then back to where the track would have been.
        this.censor = m.on;
        this.dir = m.on ? -1 : 1;
        returnTo = !m.on;
        break;
      case 'pitch':
        this.pitch = m.value;
        break;
      case 'bend':
        this.bend = m.value;
        break;
      case 'seek':
        this.jump(m.frame);
        break;
      case 'shift':
        // Relative jump — beat sync and beat jumps move from wherever the
        // playhead is *now*, not from a position the main thread last saw.
        this.jump(this.pos + m.frames);
        break;
      case 'touch':
        this.touch = m.on;
        if (m.on) {
          this.touchBase = this.pos;
          this.touchTarget = this.pos;
        }
        returnTo = this.slip;
        break;
      case 'scratch':
        this.touchTarget = this.touchBase + m.delta;
        break;
      case 'stems':
        if (!m.stems) this.clearStems();
        else {
          this.stems = m.stems;
          this.stemLen = m.stems[0].left.length;
          this.stemRatio = m.ratio;
        }
        break;
      case 'stemGains':
        this.stemTarget = m.gains.slice(0, 4);
        break;
      case 'loop':
        if (m.in >= 0) {
          if (this.loopIn < 0) this.loopSlip = m.slip ?? this.slip;
        } else {
          returnTo = this.loopSlip;
        }
        this.loopIn = m.in;
        this.loopOut = m.out;
        if (m.in < 0) {
          this.loopSlip = false;
        } else if (this.pos >= m.out && m.out > m.in) {
          // Loops are placed at the beat being *heard*; the playhead runs ahead
          // by the output latency and may already be past a short loop's end.
          // Fold it back in, keeping its phase, so the loop still catches.
          this.jump(m.in + ((this.pos - m.in) % (m.out - m.in)));
        }
        break;
    }
    if (wasOut && !this.excursion() && returnTo) this.jump(this.shadow);
    if (!this.tracking()) this.shadow = this.pos;
    this.report();
  }

  clearStems() {
    this.stems = null;
    this.stemLen = 0;
    this.stemTarget = [1, 1, 1, 1];
    this.stemGain = [1, 1, 1, 1];
    this.stemPeak = [0, 0, 0, 0];
  }

  /** What each part adds to the output at frame `p`, at gains `g` (drums,
   *  bass, vocals, other): the peak since the last report, for the stems
   *  row's meters. Nearest samples are plenty for a meter. */
  meter(p, g) {
    if (!(p >= 0 && p < this.length)) return;
    const ip = p | 0;
    let ol = this.left[ip];
    let or = this.right[ip];
    const si = (p * this.stemRatio) | 0;
    const pk = this.stemPeak;
    if (si < this.stemLen) {
      for (let k = 0; k < 3; k++) {
        const st = this.stems[k];
        const l = st.left[si] * I16;
        const r = st.right[si] * I16;
        ol -= l;
        or -= r;
        const v = g[k] * Math.max(Math.abs(l), Math.abs(r));
        if (v > pk[k]) pk[k] = v;
      }
    }
    const v = g[3] * Math.max(Math.abs(ol), Math.abs(or));
    if (v > pk[3]) pk[3] = v;
  }

  /** The track at fractional frame `p`, into outL/outR — stems mixed in at
   *  coefficients `c` (drums, bass, vocals, then the track itself). */
  read(p, c) {
    const a = this.left;
    const b = this.right;
    const len = this.length;
    if (!(p >= 0 && p < len)) {
      this.outL = this.outR = 0;
      return;
    }
    const ip = p | 0;
    const f = p - ip;
    let l = hermite(a, ip, f, len);
    let r = b === a ? l : hermite(b, ip, f, len);
    if (c) {
      l *= c[3];
      r *= c[3];
      const sp = p * this.stemRatio;
      const sl = this.stemLen;
      if (sp < sl) {
        const si = sp | 0;
        const sf = sp - si;
        for (let k = 0; k < 3; k++) {
          const ck = c[k];
          if (ck === 0) continue;
          const st = this.stems[k];
          l += ck * I16 * hermite(st.left, si, sf, sl);
          r += ck * I16 * hermite(st.right, si, sf, sl);
        }
      }
    }
    this.outL = l;
    this.outR = r;
  }

  jump(frame) {
    if (!this.left) return;
    this.xPos = this.pos;
    this.xLeft = XFADE;
    this.pos = Math.max(0, Math.min(this.length - 1, frame));
  }

  /** `t` is the context time `pos` belongs to: the end of the last rendered block. */
  report(t = currentTime + 128 / sampleRate) {
    this.sinceReport = 0;
    this.port.postMessage({
      type: 'pos',
      t,
      pos: this.pos,
      rate: this.rate,
      playing: this.playing,
      // The shadow playhead, when it differs from the heard one.
      shadow: this.tracking() ? this.shadow : -1,
      // Each part's peak since the last report (drums, bass, vocals, other).
      stems: this.stems ? this.stemPeak : null,
    });
    if (this.stems) this.stemPeak = [0, 0, 0, 0];
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;

    if (!this.left) {
      this.sinceReport += n;
      if (this.sinceReport >= REPORT_EVERY) this.report();
      return true;
    }

    const len = this.length;
    const r0 = this.rate;
    let r1;
    if (this.touch) {
      let target = (this.touchTarget - this.pos) / (SCRATCH_TAU * sampleRate);
      if (target > SCRATCH_MAX) target = SCRATCH_MAX;
      else if (target < -SCRATCH_MAX) target = -SCRATCH_MAX;
      r1 = r0 + (target - r0) * 0.5;
    } else {
      const target = this.playing ? this.dir * (this.pitch + this.bend) : 0;
      const dt = n / sampleRate;
      // Stopping uses the brake (or a brake/spinback's own); coming up from
      // (near) rest uses the motor's spin-up, as does a change of direction;
      // anything else is the pitch fader moving under a spinning record,
      // which should land almost at once.
      let slope;
      if (target === 0) slope = this.stopSlope > 0 ? this.stopSlope : this.brakeTime > 0 ? 1 / this.brakeTime : Infinity;
      else if (r0 !== 0 && Math.sign(r0) !== Math.sign(target)) slope = this.startTime > 0 ? 2 / this.startTime : Infinity;
      else if (Math.abs(r0) < Math.abs(target) * 0.9) slope = this.startTime > 0 ? 1 / this.startTime : Infinity;
      else slope = PITCH_SLEW;
      const step = slope * dt;
      const d = target - r0;
      r1 = Math.abs(d) <= step ? target : r0 + Math.sign(d) * step;
    }

    // Stem levels: glide from this block's start to its end, as coefficients
    // on drums, bass, vocals and the track (see read). null: the plain track.
    let c = null;
    const dc = [0, 0, 0, 0];
    if (this.stems) {
      const g0 = this.stemGain;
      const g1 = g0.slice();
      const step = n / (STEM_SLEW * sampleRate);
      let flat = true;
      for (let k = 0; k < 4; k++) {
        const d = this.stemTarget[k] - g0[k];
        g1[k] = Math.abs(d) <= step ? this.stemTarget[k] : g0[k] + Math.sign(d) * step;
        if (g0[k] !== 1 || g1[k] !== 1) flat = false;
      }
      if (!flat) {
        const c0 = [g0[0] - g0[3], g0[1] - g0[3], g0[2] - g0[3], g0[3]];
        const c1 = [g1[0] - g1[3], g1[1] - g1[3], g1[2] - g1[3], g1[3]];
        for (let k = 0; k < 4; k++) dc[k] = (c1[k] - c0[k]) / n;
        c = c0;
      }
      this.stemGain = g1;
    }
    const hasLoop = this.loopIn >= 0 && this.loopOut > this.loopIn;
    const loopLen = this.loopOut - this.loopIn;
    const dr = (r1 - r0) / n;
    let r = r0;
    let pos = this.pos;
    let ended = false;

    for (let i = 0; i < n; i++) {
      r += dr;
      if (c) {
        for (let k = 0; k < 4; k++) c[k] += dc[k];
      }
      this.read(pos, c);
      let l = this.outL;
      let rr = this.outR;
      if (this.xLeft > 0) {
        const g = this.xLeft / XFADE;
        this.read(this.xPos, c);
        l = l * (1 - g) + this.outL * g;
        rr = rr * (1 - g) + this.outR * g;
        this.xPos += r;
        this.xLeft--;
      }
      L[i] = l;
      R[i] = rr;
      if (this.stems && (i & 3) === 0 && r !== 0) this.meter(pos, this.stemGain);

      const prev = pos;
      pos += r;
      if (hasLoop) {
        if (r > 0 && prev < this.loopOut && pos >= this.loopOut) {
          this.xPos = pos;
          this.xLeft = XFADE;
          pos -= loopLen;
        } else if (r < 0 && prev >= this.loopIn && pos < this.loopIn && !this.touch) {
          this.xPos = pos;
          this.xLeft = XFADE;
          pos += loopLen;
        }
      }
      if (pos >= len - 1) {
        pos = len - 1;
        if (!this.touch && this.playing) ended = true;
      } else if (pos < 0) {
        pos = 0;
      }
    }

    this.pos = pos;
    this.rate = pos <= 0 && r1 < 0 ? 0 : r1;
    if (this.rate === 0) this.stopSlope = 0;
    // The shadow runs at the motor's speed through an excursion, and is the
    // playhead itself the rest of the time.
    if (this.tracking()) {
      if (this.playing) this.shadow = Math.min(len - 1, this.shadow + (this.pitch + this.bend) * n);
    } else {
      this.shadow = pos;
    }
    if (this.touch) {
      // Hand at the record's edges: the target can't run off the end.
      this.touchTarget = Math.max(0, Math.min(len - 1, this.touchTarget));
    }
    if (ended) {
      this.playing = false;
      this.rate = 0;
      this.port.postMessage({ type: 'ended' });
      this.report(currentTime + n / sampleRate);
      return true;
    }

    this.sinceReport += n;
    if (this.sinceReport >= REPORT_EVERY) this.report(currentTime + n / sampleRate);
    return true;
  }
}

registerProcessor('dj-deck', DjDeckProcessor);
