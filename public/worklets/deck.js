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
 *                  click.
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
    this.sinceReport = 0;
    this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
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
        break;
      case 'unload':
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
        break;
      case 'scratch':
        this.touchTarget = this.touchBase + m.delta;
        break;
      case 'loop':
        this.loopIn = m.in;
        this.loopOut = m.out;
        break;
    }
    this.report();
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
    });
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
      const target = this.playing ? this.pitch + this.bend : 0;
      const dt = n / sampleRate;
      // Stopping uses the brake; coming up from (near) rest uses the motor's
      // spin-up; anything else is the pitch fader moving under a spinning
      // record, which should land almost at once.
      let slope;
      if (target === 0) slope = this.brakeTime > 0 ? 1 / this.brakeTime : Infinity;
      else if (Math.abs(r0) < Math.abs(target) * 0.9) slope = this.startTime > 0 ? 1 / this.startTime : Infinity;
      else slope = PITCH_SLEW;
      const step = slope * dt;
      const d = target - r0;
      r1 = Math.abs(d) <= step ? target : r0 + Math.sign(d) * step;
    }

    const a = this.left;
    const b = this.right;
    const hasLoop = this.loopIn >= 0 && this.loopOut > this.loopIn;
    const loopLen = this.loopOut - this.loopIn;
    const dr = (r1 - r0) / n;
    let r = r0;
    let pos = this.pos;
    let ended = false;

    for (let i = 0; i < n; i++) {
      r += dr;
      let l = 0;
      let rr = 0;
      if (pos >= 0 && pos < len) {
        const ip = pos | 0;
        const f = pos - ip;
        l = hermite(a, ip, f, len);
        rr = b === a ? l : hermite(b, ip, f, len);
      }
      if (this.xLeft > 0) {
        const g = this.xLeft / XFADE;
        const xp = this.xPos;
        if (xp >= 0 && xp < len) {
          const ip = xp | 0;
          const f = xp - ip;
          const ol = hermite(a, ip, f, len);
          const or = b === a ? ol : hermite(b, ip, f, len);
          l = l * (1 - g) + ol * g;
          rr = rr * (1 - g) + or * g;
        } else {
          l *= 1 - g;
          rr *= 1 - g;
        }
        this.xPos = xp + r;
        this.xLeft--;
      }
      L[i] = l;
      R[i] = rr;

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
