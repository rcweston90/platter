/**
 * Plays a slicer project on the audio clock: the same lookahead scheme as the
 * beat board (a timer every 25 ms schedules whatever starts in the next
 * ~120 ms with sample-accurate start times), so timing never depends on the
 * main thread keeping up. The offline render (render()) runs the very same
 * scheduling into an OfflineAudioContext, so the exported WAV is exactly what
 * you heard.
 */
import { clipBeats, clipRate, laneHeard, swung } from './model';
import type { Clip, Lane, Project, Source } from './types';

const TICK_MS = 25;
const AHEAD = 0.12;
/** De-click ramp on every voice, seconds. A voice fades in over this and,
 *  unless it has a fade of its own, rings this much past its end while
 *  fading out: back-to-back clips crossfade instead of each dipping to
 *  silence at the seam (hundreds of 3 ms holes read as a stutter). */
const EDGE = 0.003;
/** Two clips meet when one starts within this many beats of the other's end. */
const JOIN_BEATS = 1e-4;
/** …and pick the source up within this many seconds of where it stopped. */
const JOIN_SECS = 1e-4;

export interface AudioLookup {
  /** The decoded audio of a source (any sample rate), or undefined if not ready. */
  buffer(sourceId: string): AudioBuffer | undefined;
  /** The same, reversed (cached by the caller). */
  reversed(sourceId: string): AudioBuffer | undefined;
}

/**
 * Clips that play as one voice. On an audio lane, a clip that starts where
 * the previous one ends and picks the source up where it stopped (same
 * source, direction, speed and level, no fade between them) just continues
 * it: "Lay out all" plays the original back seamlessly, sample for sample,
 * however finely it was chopped. `clip` spans the whole run.
 */
interface Run {
  clip: Clip;
  members: Clip[];
  lane: Lane;
}

const runCache = new WeakMap<Project, Run[]>();

function continues(prev: Clip, c: Clip, endBeat: number): boolean {
  if (c.sourceId !== prev.sourceId || c.reverse !== prev.reverse || c.semitones !== prev.semitones || c.sync !== prev.sync || c.gain !== prev.gain) return false;
  if (prev.fadeOut > 0 || c.fadeIn > 0) return false;
  if (Math.abs(c.at - endBeat) > JOIN_BEATS) return false;
  return c.reverse ? Math.abs(c.end - prev.start) < JOIN_SECS : Math.abs(c.start - prev.end) < JOIN_SECS;
}

/** The project's clips as runs (cached per project value). */
export function runsOf(p: Project): Run[] {
  const hit = runCache.get(p);
  if (hit) return hit;
  const sources = new Map(p.sources.map((s) => [s.id, s]));
  const byLane = new Map<string, Clip[]>();
  for (const c of p.clips) {
    const list = byLane.get(c.laneId);
    if (list) list.push(c);
    else byLane.set(c.laneId, [c]);
  }
  const out: Run[] = [];
  for (const lane of p.lanes) {
    const clips = byLane.get(lane.id);
    if (!clips) continue;
    if (lane.kind === 'drum') {
      for (const c of clips) out.push({ clip: c, members: [c], lane });
      continue;
    }
    const sorted = [...clips].sort((a, b) => a.at - b.at);
    let run: Run | null = null;
    let endBeat = 0;
    for (const c of sorted) {
      const src = sources.get(c.sourceId);
      const last: Clip | undefined = run?.members[run.members.length - 1];
      if (run && last && continues(last, c, endBeat)) {
        run.members.push(c);
        run.clip = c.reverse ? { ...run.clip, start: c.start, fadeOut: c.fadeOut } : { ...run.clip, end: c.end, fadeOut: c.fadeOut };
      } else {
        run = { clip: c, members: [c], lane };
        out.push(run);
      }
      endBeat = c.at + clipBeats(c, src, p.bpm);
    }
  }
  runCache.set(p, out);
  return out;
}

const sameRun = (a: Clip[], b: Clip[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/** One run sounding, or about to. */
interface Voice {
  members: Clip[];
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** Context time it stops by itself. */
  ends: number;
  /** The playback segment it was scheduled in (a loop pass, a seek). */
  seg: object | null;
}

/** A piece of a run to play: from `offset` seconds into its audio. */
interface Due {
  run: Run;
  clip: Clip;
  lane: Lane;
  /** Timeline beat it starts sounding at. */
  beat: number;
  /** Seconds into the clip's (possibly reversed) range. */
  offset: number;
}

/** Runs that start in [from, to) beats, plus (when `catchUp`) ones already sounding at `from`. */
function dueIn(p: Project, from: number, to: number, catchUp: boolean): Due[] {
  const sources = new Map(p.sources.map((s) => [s.id, s]));
  const out: Due[] = [];
  for (const run of runsOf(p)) {
    const { clip, lane } = run;
    const src = sources.get(clip.sourceId);
    if (!src) continue;
    const at = lane.kind === 'drum' ? swung(clip.at, p.swing) : clip.at;
    if (at >= from && at < to) out.push({ run, clip, lane, beat: at, offset: 0 });
    else if (catchUp && at < from) {
      const len = clipBeats(clip, src, p.bpm);
      if (at + len > from + 0.01) {
        const secs = ((from - at) * 60) / p.bpm;
        out.push({ run, clip, lane, beat: from, offset: secs * clipRate(clip, src, p.bpm) });
      }
    }
  }
  return out;
}

/**
 * Starts one run at context time `when`, into `dest`. `cut` (real seconds)
 * ends it early, as the loop's end does. Returns the voice, or null without audio.
 */
function startVoice(ctx: BaseAudioContext, dest: AudioNode, d: Due, src: Source, p: Project, audio: AudioLookup, when: number, cut = Infinity): Voice | null {
  const { clip } = d;
  const buf = clip.reverse ? audio.reversed(src.id) : audio.buffer(src.id);
  if (!buf) return null;
  const rate = clipRate(clip, src, p.bpm);
  const range = clip.end - clip.start;
  const begin = clip.reverse ? buf.duration - clip.end : clip.start;
  const offset = begin + d.offset;
  const left = range - d.offset;
  if (left <= 0.002) return null;
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.playbackRate.value = rate;
  const g = ctx.createGain();
  const level = clip.gain;
  let dur = left / rate; // real seconds
  const cutShort = cut < dur - 1e-4;
  if (cutShort) dur = Math.max(0.002, cut);
  // Fades are in source seconds; convert to real time.
  const fadeIn = Math.min(d.offset > 0 ? EDGE : Math.max(EDGE, clip.fadeIn / rate), dur / 2);
  // Its own fade ends inside the clip; otherwise ring on for EDGE, fading, so
  // whatever starts at the end crossfades with it instead of meeting silence.
  const own = !cutShort && clip.fadeOut / rate > EDGE ? Math.min(clip.fadeOut / rate, dur / 2) : 0;
  const tail = own ? 0 : EDGE;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(level, when + fadeIn);
  g.gain.setValueAtTime(level, Math.max(when + fadeIn, when + dur - own));
  g.gain.linearRampToValueAtTime(0, when + dur + tail);
  node.connect(g).connect(dest);
  node.start(when, Math.max(0, offset), (dur + tail) * rate);
  node.stop(when + dur + tail + 0.01);
  return { members: d.run.members, src: node, gain: g, ends: when + dur + tail, seg: null };
}

/** Each lane's gain and pan, into the output. */
class LaneBus {
  readonly input: GainNode;
  private pan: StereoPannerNode;
  constructor(
    private ctx: BaseAudioContext,
    out: AudioNode,
  ) {
    this.input = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.input.connect(this.pan).connect(out);
  }
  apply(lane: Lane, heard: boolean, smooth: boolean) {
    const g = heard ? lane.gain : 0;
    if (smooth) {
      this.input.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
      this.pan.pan.setTargetAtTime(lane.pan, this.ctx.currentTime, 0.01);
    } else {
      this.input.gain.value = g;
      this.pan.pan.value = lane.pan;
    }
  }
  dispose() {
    this.input.disconnect();
    this.pan.disconnect();
  }
}

function buses(ctx: BaseAudioContext, out: AudioNode, p: Project, existing: Map<string, LaneBus>, smooth: boolean) {
  for (const [id, bus] of existing) {
    if (!p.lanes.some((l) => l.id === id)) {
      bus.dispose();
      existing.delete(id);
    }
  }
  for (const lane of p.lanes) {
    let bus = existing.get(lane.id);
    if (!bus) existing.set(lane.id, (bus = new LaneBus(ctx, out)));
    bus.apply(lane, laneHeard(lane, p.lanes), smooth);
  }
}

/** A click on each beat (accented on the bar), for the metronome. */
function click(ctx: BaseAudioContext, dest: AudioNode, when: number, accent: boolean) {
  const o = ctx.createOscillator();
  o.frequency.value = accent ? 1760 : 1320;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.22, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  o.connect(g).connect(dest);
  o.start(when);
  o.stop(when + 0.06);
}

/** Live playback on the shared AudioContext. */
export class SlicerPlayer {
  readonly out: GainNode;
  private lanes = new Map<string, LaneBus>();
  private voices: Voice[] = [];
  private timer = 0;
  /** Beat `beat` sounds at context time `time`; later entries take over (loop wraps). */
  private segments: { time: number; beat: number }[] = [];
  /** Scheduled up to here (beats, in the current segment's frame). */
  private next = 0;
  private catchUp = false;
  private project: Project | null = null;
  metronome = false;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    private audio: AudioLookup,
    /** Context time the listener hears now (output latency included). */
    private now: () => number,
  ) {
    this.out = ctx.createGain();
    this.out.connect(dest);
  }

  get playing() {
    return this.timer !== 0;
  }

  setLevel(level: number) {
    this.out.gain.setTargetAtTime((level / 0.8) ** 2, this.ctx.currentTime, 0.015);
  }

  /** The project changed: lanes follow at once; voices of clips that were
   *  edited or removed fade out (they're scheduled again from the next tick). */
  update(p: Project) {
    const prev = this.project;
    this.project = p;
    buses(this.ctx, this.out, p, this.lanes, true);
    if (!prev || !this.playing) return;
    if (prev.bpm !== p.bpm) {
      // Keep the playhead where it is and carry on at the new tempo.
      const beat = this.position();
      this.stopVoices();
      this.anchor(beat, this.ctx.currentTime + 0.03);
      return;
    }
    const runs = new Map(runsOf(p).map((r) => [r.members[0], r.members]));
    const kept = (v: Voice) => {
      const m = runs.get(v.members[0]);
      return !!m && sameRun(m, v.members);
    };
    const stale = this.voices.filter((v) => !kept(v));
    if (stale.length) {
      for (const v of stale) this.fade(v);
      this.voices = this.voices.filter(kept);
      // Edited clips still under the playhead start again where they are.
      this.catchUp = true;
      this.next = this.currentFrameBeat();
    }
  }

  play(p: Project, fromBeat: number) {
    this.stop();
    this.project = p;
    buses(this.ctx, this.out, p, this.lanes, false);
    this.anchor(fromBeat, this.ctx.currentTime + 0.05);
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = 0;
    this.stopVoices();
    this.segments = [];
  }

  /** Jump while playing. */
  seek(beat: number) {
    if (!this.playing) return;
    this.stopVoices();
    this.anchor(beat, this.ctx.currentTime + 0.03);
    this.tick();
  }

  /** Where the playhead is now, in beats. */
  position(): number {
    const p = this.project;
    if (!p || !this.segments.length) return 0;
    const t = this.now();
    let seg = this.segments[0];
    for (const s of this.segments) if (s.time <= t) seg = s;
    return Math.max(0, seg.beat + ((t - seg.time) * p.bpm) / 60);
  }

  private currentFrameBeat() {
    const p = this.project!;
    const seg = this.segments[this.segments.length - 1];
    return Math.max(seg.beat, seg.beat + ((this.ctx.currentTime - seg.time) * p.bpm) / 60);
  }

  private anchor(beat: number, time: number) {
    this.segments = [{ time, beat }];
    this.next = beat;
    this.catchUp = true;
  }

  private tick() {
    const p = this.project;
    if (!p) return;
    const seg = this.segments[this.segments.length - 1];
    const spb = 60 / p.bpm;
    const horizon = seg.beat + (this.ctx.currentTime + AHEAD - seg.time) / spb;
    const loop = p.loop.on && p.loop.end > p.loop.start ? p.loop : null;
    let from = this.next;
    let to = horizon;
    let wrapped = false;
    if (loop && to >= loop.end && from < loop.end + 1e-9) {
      to = loop.end;
      wrapped = true;
    }
    if (to > from) {
      this.schedule(p, from, to, seg);
      this.next = to;
    }
    if (wrapped) {
      // The loop's start sounds the moment its end would have.
      const time = seg.time + (loop!.end - seg.beat) * spb;
      this.segments.push({ time, beat: loop!.start });
      if (this.segments.length > 8) this.segments.splice(0, this.segments.length - 8);
      this.next = loop!.start;
      this.catchUp = true;
      this.tick();
    }
    // Voices that have finished.
    const t = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => v.ends > t);
  }

  private schedule(p: Project, from: number, to: number, seg: { time: number; beat: number }) {
    const spb = 60 / p.bpm;
    const sources = new Map(p.sources.map((s) => [s.id, s]));
    const loop = p.loop.on && p.loop.end > p.loop.start ? p.loop : null;
    for (const d of dueIn(p, from, to, this.catchUp)) {
      const bus = this.lanes.get(d.lane.id);
      const src = sources.get(d.clip.sourceId);
      if (!bus || !src) continue;
      // Catching up after an edit: what's still sounding carries on.
      if (this.catchUp && this.voices.some((v) => v.seg === seg && v.ends > this.ctx.currentTime && sameRun(v.members, d.run.members))) continue;
      const when = Math.max(this.ctx.currentTime, seg.time + (d.beat - seg.beat) * spb);
      // Looping, a sample stops at the loop's end (crossfading into its
      // start); drum hits ring on, as one-shots do.
      const cut = loop && d.lane.kind === 'audio' && d.beat < loop.end ? (loop.end - d.beat) * spb : Infinity;
      const v = startVoice(this.ctx, bus.input, d, src, p, this.audio, when, cut);
      if (!v) continue;
      v.seg = seg;
      this.voices.push(v);
      v.src.onended = () => {
        v.gain.disconnect();
      };
    }
    this.catchUp = false;
    if (this.metronome) {
      for (let b = Math.ceil(from - 1e-9); b < to; b++) {
        click(this.ctx, this.out, Math.max(this.ctx.currentTime, seg.time + (b - seg.beat) * spb), b % p.meter === 0);
      }
    }
  }

  private fade(v: Voice) {
    const t = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0, t, 0.006);
    try {
      v.src.stop(t + 0.05);
    } catch {
      /* not started */
    }
  }

  private stopVoices() {
    for (const v of this.voices) this.fade(v);
    this.voices = [];
  }

  dispose() {
    this.stop();
    for (const b of this.lanes.values()) b.dispose();
    this.lanes.clear();
    this.out.disconnect();
  }
}

/**
 * Renders [fromBeat, toBeat) of the project offline: returns the stereo mix
 * at `sampleRate`, with a short tail so the last hit rings out. Audio is
 * resampled by the audio graph exactly as in live playback.
 */
export async function render(p: Project, audio: AudioLookup, fromBeat: number, toBeat: number, sampleRate: number, tail = 1): Promise<AudioBuffer> {
  const spb = 60 / p.bpm;
  const seconds = Math.max(0.1, (toBeat - fromBeat) * spb + tail);
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = (p.level / 0.8) ** 2;
  master.connect(ctx.destination);
  const lanes = new Map<string, LaneBus>();
  buses(ctx, master, p, lanes, false);
  const sources = new Map(p.sources.map((s) => [s.id, s]));
  for (const d of dueIn(p, fromBeat, toBeat, true)) {
    const src = sources.get(d.clip.sourceId);
    const bus = lanes.get(d.lane.id);
    if (!src || !bus) continue;
    // Clips that run past the end are cut there, with a de-click fade.
    const v = startVoice(ctx, bus.input, d, src, p, audio, (d.beat - fromBeat) * spb);
    if (v) {
      const cut = (toBeat - fromBeat) * spb;
      if (d.beat + clipBeats(d.clip, src, p.bpm) > toBeat && tail === 0) {
        v.gain.gain.setTargetAtTime(0, Math.max(0, cut - 0.01), 0.003);
      }
    }
  }
  return ctx.startRendering();
}
