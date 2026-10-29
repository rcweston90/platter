import type { StretchNode } from 'signalsmith-stretch';
import { workletUrl, type DjEngine } from './engine';
import { createStore, type Store } from './store';
import { HOT_CUES, type TrackCues, type TrackRecord, type WavePeaks } from './types';

export const PITCH_RANGES = [0.08, 0.16, 0.5] as const;
export const LOOP_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;
const BEND = 0.04; // pitch-bend buttons: ±4%, like holding a finger to the platter edge
const FALLBACK_BPM = 120; // beat-sized loops and jumps still work on an unanalysed track

export interface DeckTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  peaks: WavePeaks | null;
  artUrl: string | null;
}

export interface DeckState {
  track: DeckTrack | null;
  loading: boolean;
  error: string | null;
  playing: boolean;
  /** Fraction: 0.02 = +2%. */
  pitch: number;
  range: number;
  keyLock: boolean;
  sync: boolean;
  quantize: boolean;
  bpm: number | null;
  gridOffset: number;
  cue: number;
  hotCues: (number | null)[];
  loop: { active: boolean; beats: number; start: number; end: number };
}

function initialState(): DeckState {
  return {
    track: null,
    loading: false,
    error: null,
    playing: false,
    pitch: 0,
    range: PITCH_RANGES[0],
    keyLock: false,
    sync: false,
    quantize: true,
    bpm: null,
    gridOffset: 0,
    cue: 0,
    hotCues: Array.from({ length: HOT_CUES }, () => null),
    loop: { active: false, beats: 4, start: 0, end: 0 },
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const frac = (v: number) => v - Math.floor(v);

type WorkletMessage =
  | { type: 'pos'; t: number; pos: number; rate: number; playing: boolean }
  | { type: 'ended' };

/**
 * One turntable: the worklet playhead plus everything a DJ does to it —
 * transport, CDJ-style cue, hot cues, loops, beat jumps, pitch and bend,
 * key lock, beat sync, scratching. State the UI renders lives in `store`;
 * the playhead itself is read on demand with `position()`.
 */
export class Deck {
  readonly store: Store<DeckState> = createStore(initialState());
  /** The other deck — the tempo and phase master when this one syncs. */
  other: Deck | null = null;
  /** Called when cues, tempo or grid change, so the crate can remember them. */
  onPersist?: (trackId: string, patch: Partial<Pick<TrackRecord, 'cues' | 'bpm' | 'gridOffset'>>) => void;
  /** An armed deck was asked to do something: load its audio (and play). */
  onNeedAudio?: (trackId: string, thenPlay: boolean) => void;

  private engine: DjEngine | null = null;
  private node: AudioWorkletNode | null = null;
  /** The worklet holds this track's audio (false while merely armed). */
  private loaded = false;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private stretch: StretchNode | null = null;
  private stretchLoading: Promise<void> | null = null;
  private stretchLatency = 0;
  private wetOn = false;
  private sr = 44100;
  private rep = { t: 0, pos: 0, rate: 0 };
  private touched = false;
  private bend = 0;
  private previewing = false;
  private previewLatched = false;
  private taps: number[] = [];

  constructor(readonly index: 0 | 1) {}

  get label() {
    return this.index === 0 ? 'A' : 'B';
  }

  attach(engine: DjEngine) {
    this.engine = engine;
    this.stretch = null;
    this.stretchLoading = null;
    this.wetOn = false;
    this.rep = { t: 0, pos: 0, rate: 0 };
    const { ctx } = engine;
    this.sr = ctx.sampleRate;
    this.node = new AudioWorkletNode(ctx, 'dj-deck', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    const input = engine.channels[this.index].input;
    this.node.connect(this.dry).connect(input);
    this.wet.connect(input);
    this.node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      const m = e.data;
      if (m.type === 'pos') this.rep = { t: m.t, pos: m.pos, rate: m.rate };
      else if (m.type === 'ended') this.store.set({ playing: false });
    };
  }

  private post(msg: Record<string, unknown>, transfer: Transferable[] = []) {
    this.node?.port.postMessage(msg, transfer);
  }

  /* ── Reading the playhead ─────────────────────────────────────────────── */

  /** Playhead in track seconds as it is being heard — output latency and the
   *  key-lock stretcher's delay accounted for. */
  position(): number {
    const { track, cue } = this.store.get();
    if (!track) return 0;
    if (!this.engine || !this.loaded) return cue;
    let frames = this.rep.pos + this.rep.rate * (this.engine.now() - this.rep.t) * this.sr;
    if (this.wetOn) frames -= this.stretchLatency * this.rep.rate * this.sr;
    return clamp(frames / this.sr, 0, track.duration);
  }

  /** Current playback rate (1 = original speed; negative while scratching back). */
  rate(): number {
    return this.rep.rate;
  }

  beatLength(): number {
    return 60 / (this.store.get().bpm ?? FALLBACK_BPM);
  }

  effectiveBpm(): number | null {
    const { bpm, pitch } = this.store.get();
    return bpm ? bpm * (1 + pitch) : null;
  }

  private snap(t: number): number {
    const { quantize, bpm, gridOffset } = this.store.get();
    if (!quantize || !bpm) return t;
    const beat = 60 / bpm;
    return gridOffset + Math.round((t - gridOffset) / beat) * beat;
  }

  /* ── Loading ──────────────────────────────────────────────────────────── */

  /** Shows a track on the deck before any audio exists, so the rig opens
   *  cued up; the audio loads on the first press of play (or cue, a hot
   *  cue, a loop, the platter). */
  arm(rec: TrackRecord, peaks: WavePeaks | null, artUrl: string | null) {
    this.loaded = false;
    const prevArt = this.store.get().track?.artUrl;
    if (prevArt && prevArt !== artUrl) URL.revokeObjectURL(prevArt);
    this.store.set({
      track: { id: rec.id, title: rec.title, artist: rec.artist, duration: rec.duration, peaks, artUrl },
      loading: false,
      error: null,
      playing: false,
      bpm: rec.bpm,
      gridOffset: rec.gridOffset,
      cue: rec.cues.main,
      hotCues: [...rec.cues.hot],
    });
  }

  /** False (and asks for the audio) when the deck is only armed. */
  private ready(thenPlay = false): boolean {
    const { track } = this.store.get();
    if (!track) return false;
    if (this.loaded) return true;
    this.onNeedAudio?.(track.id, thenPlay);
    return false;
  }

  setLoading(loading: boolean, error: string | null = null) {
    this.store.set({ loading, error });
  }

  /** Hands decoded audio (at the context's sample rate) to the worklet. */
  load(rec: TrackRecord, buffer: AudioBuffer, artUrl: string | null) {
    const left = new Float32Array(buffer.getChannelData(0));
    const right = buffer.numberOfChannels > 1 ? new Float32Array(buffer.getChannelData(1)) : null;
    this.post({ type: 'load', left, right }, right ? [left.buffer, right.buffer] : [left.buffer]);
    this.loaded = true;
    this.rep = { t: 0, pos: 0, rate: 0 };
    this.previewing = false;
    const prevArt = this.store.get().track?.artUrl;
    if (prevArt && prevArt !== artUrl) URL.revokeObjectURL(prevArt);
    this.store.set({
      track: {
        id: rec.id,
        title: rec.title,
        artist: rec.artist,
        duration: buffer.duration,
        peaks: rec.peaks,
        artUrl,
      },
      loading: false,
      error: null,
      playing: false,
      bpm: rec.bpm,
      gridOffset: rec.gridOffset,
      cue: rec.cues.main,
      hotCues: [...rec.cues.hot],
      loop: { ...this.store.get().loop, active: false },
    });
    this.post({ type: 'loop', in: -1, out: -1 });
    this.post({ type: 'seek', frame: rec.cues.main * this.sr });
    this.followTempo();
  }

  /** Analysis finished after the track was loaded: fill in what was missing. */
  applyAnalysis(trackId: string, patch: Partial<TrackRecord>) {
    const s = this.store.get();
    if (!s.track || s.track.id !== trackId) return;
    const next: Partial<DeckState> = {};
    if (patch.peaks && !s.track.peaks) next.track = { ...s.track, peaks: patch.peaks };
    if (patch.bpm != null && s.bpm == null) {
      next.bpm = patch.bpm;
      next.gridOffset = patch.gridOffset ?? 0;
    }
    this.store.set(next);
    this.followTempo();
    this.other?.followTempo();
  }

  eject() {
    if (this.store.get().playing) return;
    this.post({ type: 'unload' });
    this.loaded = false;
    const art = this.store.get().track?.artUrl;
    if (art) URL.revokeObjectURL(art);
    this.store.set({ track: null, bpm: null, loop: { ...this.store.get().loop, active: false } });
  }

  /* ── Transport ────────────────────────────────────────────────────────── */

  play() {
    const s = this.store.get();
    if (!this.ready(true)) return;
    this.engine?.resume();
    if (this.previewing) {
      // Play while holding CUE: let go of CUE and the deck keeps going.
      this.previewLatched = true;
      return;
    }
    const synced = s.sync && this.other?.store.get().playing;
    if (synced) this.alignPhase();
    this.post({ type: 'play', instant: !!synced });
    this.store.set({ playing: true, error: null });
  }

  pause() {
    this.post({ type: 'pause' });
    this.store.set({ playing: false, error: null });
  }

  togglePlay() {
    if (this.store.get().playing && !this.previewing) this.pause();
    else this.play();
  }

  /** CDJ cue. Playing: back to the cue point and stop. Stopped: the cue point
   *  moves here (snapped to the grid), and holding it previews from there. */
  cueDown() {
    const s = this.store.get();
    if (!this.ready()) return;
    this.engine?.resume();
    if (s.playing && !this.previewing) {
      this.post({ type: 'pause', instant: true });
      this.post({ type: 'seek', frame: s.cue * this.sr });
      this.store.set({ playing: false });
      return;
    }
    const here = this.position();
    if (Math.abs(here - s.cue) > 0.02) {
      const cue = this.snap(here);
      this.store.set({ cue });
      this.post({ type: 'seek', frame: cue * this.sr });
      this.persistCues();
    }
    this.previewing = true;
    this.previewLatched = false;
    this.post({ type: 'play', instant: true });
    this.store.set({ playing: true });
  }

  cueUp() {
    if (!this.previewing) return;
    this.previewing = false;
    if (this.previewLatched) return;
    this.post({ type: 'pause', instant: true });
    this.post({ type: 'seek', frame: this.store.get().cue * this.sr });
    this.store.set({ playing: false });
  }

  /** Needle drop: jump to a time in the track. */
  seek(seconds: number) {
    const { track } = this.store.get();
    if (!track || !this.ready()) return;
    this.post({ type: 'seek', frame: clamp(seconds, 0, track.duration) * this.sr });
  }

  /** Relative jump from wherever the playhead is when the worklet gets it. */
  shift(seconds: number) {
    this.post({ type: 'shift', frames: seconds * this.sr });
  }

  /* ── Hot cues ─────────────────────────────────────────────────────────── */

  hotCue(i: number) {
    const s = this.store.get();
    if (!this.ready()) return;
    const at = s.hotCues[i];
    if (at === null) {
      const hotCues = [...s.hotCues];
      hotCues[i] = this.snap(this.position());
      this.store.set({ hotCues });
      this.persistCues();
    } else {
      this.seek(at);
    }
  }

  clearHotCue(i: number) {
    const hotCues = [...this.store.get().hotCues];
    hotCues[i] = null;
    this.store.set({ hotCues });
    this.persistCues();
  }

  private persistCues() {
    const s = this.store.get();
    if (!s.track) return;
    const cues: TrackCues = { main: s.cue, hot: [...s.hotCues] };
    this.onPersist?.(s.track.id, { cues });
  }

  /* ── Loops and beat jumps ─────────────────────────────────────────────── */

  toggleLoop() {
    const s = this.store.get();
    if (!this.ready()) return;
    if (s.loop.active) {
      this.post({ type: 'loop', in: -1, out: -1 });
      this.store.set({ loop: { ...s.loop, active: false } });
      return;
    }
    const start = this.snap(this.position());
    const end = start + s.loop.beats * this.beatLength();
    this.post({ type: 'loop', in: start * this.sr, out: end * this.sr });
    this.store.set({ loop: { ...s.loop, active: true, start, end } });
  }

  setLoopBeats(beats: number) {
    const s = this.store.get();
    if (!s.loop.active) {
      this.store.set({ loop: { ...s.loop, beats } });
      return;
    }
    const end = s.loop.start + beats * this.beatLength();
    const here = this.position();
    this.post({ type: 'loop', in: s.loop.start * this.sr, out: end * this.sr });
    // Shrinking past the playhead: fold it back inside so the loop holds.
    if (here >= end) {
      const len = end - s.loop.start;
      this.seek(s.loop.start + ((here - s.loop.start) % len));
    }
    this.store.set({ loop: { ...s.loop, beats, end } });
  }

  stepLoop(dir: -1 | 1) {
    const { beats } = this.store.get().loop;
    const i = LOOP_BEATS.indexOf(beats as (typeof LOOP_BEATS)[number]);
    const next = LOOP_BEATS[clamp(i + dir, 0, LOOP_BEATS.length - 1)];
    if (next !== beats) this.setLoopBeats(next);
  }

  /** Jump by the loop size; an active loop travels with the playhead. */
  beatJump(dir: -1 | 1) {
    const s = this.store.get();
    if (!this.ready()) return;
    const by = dir * s.loop.beats * this.beatLength();
    if (s.loop.active) {
      const start = s.loop.start + by;
      const end = s.loop.end + by;
      this.post({ type: 'loop', in: start * this.sr, out: end * this.sr });
      this.store.set({ loop: { ...s.loop, start, end } });
    }
    this.shift(by);
  }

  /* ── Pitch, bend, key lock ────────────────────────────────────────────── */

  /** The pitch fader. Moving it by hand takes the deck out of sync. */
  setPitch(pitch: number) {
    if (this.store.get().sync) this.store.set({ sync: false });
    this.applyPitch(pitch, this.store.get().range);
  }

  private applyPitch(pitch: number, range: number) {
    const p = clamp(pitch, -range, range);
    this.store.set({ pitch: p, range });
    this.post({ type: 'pitch', value: 1 + p });
    this.applyKeyLock();
    this.other?.followTempo();
  }

  setRange(range: number) {
    this.applyPitch(this.store.get().pitch, range);
  }

  resetPitch() {
    this.setPitch(0);
  }

  /** −1, 0 or 1: the nudge buttons (or a hand on the platter's edge). */
  setBend(dir: number) {
    this.bend = dir * BEND;
    this.post({ type: 'bend', value: this.bend });
    this.applyKeyLock();
  }

  async setKeyLock(on: boolean) {
    this.store.set({ keyLock: on });
    if (on && this.engine && !this.stretch) {
      try {
        await this.loadStretch(this.engine);
      } catch {
        this.store.set({ keyLock: false, error: 'Key lock is unavailable in this browser.' });
        return;
      }
    }
    this.applyKeyLock();
  }

  /** Signalsmith Stretch (MIT) as a live pitch-shifter after the playhead:
   *  play at rate r, shift by −12·log2(r) semitones, and the key stays put. */
  private loadStretch(engine: DjEngine) {
    if (!this.stretchLoading) {
      this.stretchLoading = (async () => {
        const { default: SignalsmithStretch } = await import('signalsmith-stretch');
        // Its worklet as a file (scripts/extract-stretch-worklet.mjs), not
        // the blob: URL it would build — some hosts refuse blob worklets.
        SignalsmithStretch.moduleUrl = workletUrl('stretch.js');
        const node = await SignalsmithStretch(engine.ctx);
        this.node!.connect(node);
        node.connect(this.wet!);
        this.stretchLatency = await node.latency();
        this.stretch = node;
      })();
    }
    return this.stretchLoading;
  }

  private applyKeyLock() {
    if (!this.engine || !this.dry || !this.wet) return;
    const s = this.store.get();
    // A hand on the record always hears the record: scratching through a
    // pitch-shifter smears it, and DJ hardware drops key lock while touched.
    const wantWet = s.keyLock && !!this.stretch && !this.touched;
    if (this.stretch && s.keyLock) {
      void this.stretch.schedule({ active: true, semitones: -12 * Math.log2(1 + s.pitch + this.bend) });
    }
    if (wantWet === this.wetOn) return;
    this.wetOn = wantWet;
    const t = this.engine.ctx.currentTime;
    this.dry.gain.setTargetAtTime(wantWet ? 0 : 1, t, 0.01);
    this.wet.gain.setTargetAtTime(wantWet ? 1 : 0, t, 0.01);
    if (!wantWet && !s.keyLock && this.stretch) void this.stretch.schedule({ active: false, output: t + 0.15 });
  }

  /* ── Sync ─────────────────────────────────────────────────────────────── */

  private master(): Deck | null {
    const o = this.other;
    return o && o.store.get().track && o.store.get().bpm ? o : null;
  }

  setSync(on: boolean) {
    if (on && this.other?.store.get().sync) this.other.store.set({ sync: false });
    this.store.set({ sync: on });
    if (!on) return;
    this.followTempo();
    if (this.store.get().playing && this.other?.store.get().playing) this.alignPhase();
  }

  /** Match the master's tempo, widening the pitch range if it has to. */
  followTempo() {
    const s = this.store.get();
    const m = this.master();
    if (!s.sync || !m || !s.bpm) return;
    const target = m.effectiveBpm()! / s.bpm - 1;
    let range = s.range;
    for (const r of PITCH_RANGES) {
      if (Math.abs(target) <= range) break;
      range = r;
    }
    this.applyPitch(target, range);
  }

  /** Move this deck's playhead so its beats land on the master's. */
  private alignPhase() {
    const s = this.store.get();
    const m = this.master();
    if (!m || !s.bpm) return;
    const ms = m.store.get();
    const beat = 60 / s.bpm;
    const mine = frac((this.position() - s.gridOffset) / beat);
    const theirs = frac((m.position() - ms.gridOffset) / (60 / ms.bpm!));
    let d = theirs - mine;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    if (Math.abs(d) > 0.004) this.shift(d * beat);
  }

  /* ── Tempo and grid edits ─────────────────────────────────────────────── */

  setQuantize(on: boolean) {
    this.store.set({ quantize: on });
  }

  scaleBpm(factor: number) {
    const { bpm, track } = this.store.get();
    if (!bpm || !track) return;
    this.setBpm(bpm * factor, this.store.get().gridOffset);
  }

  /** Tap along to the beat: tempo from the taps, grid anchored to the last. */
  tap() {
    const { track } = this.store.get();
    if (!track) return;
    const now = performance.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length < 4) return;
    const span = this.taps[this.taps.length - 1] - this.taps[0];
    const bpmHeard = (60000 * (this.taps.length - 1)) / span;
    // Taps are in heard time; the grid is in track time.
    const bpm = bpmHeard / (1 + this.store.get().pitch);
    this.setBpm(Math.round(bpm * 10) / 10, this.position());
  }

  /** Slide the beat grid by a few milliseconds. */
  nudgeGrid(seconds: number) {
    const { bpm, gridOffset } = this.store.get();
    if (bpm) this.setBpm(bpm, gridOffset + seconds);
  }

  private setBpm(bpm: number, gridOffset: number) {
    const { track } = this.store.get();
    this.store.set({ bpm, gridOffset });
    if (track) this.onPersist?.(track.id, { bpm, gridOffset });
    this.followTempo();
    this.other?.followTempo();
  }

  /* ── The platter ──────────────────────────────────────────────────────── */

  touch(on: boolean) {
    if (on ? !this.ready() : !this.loaded) return;
    this.engine?.resume();
    this.touched = on;
    this.post({ type: 'touch', on });
    this.applyKeyLock();
  }

  /** Hand position, in track seconds since the touch began. */
  scratch(deltaSeconds: number) {
    this.post({ type: 'scratch', delta: deltaSeconds * this.sr });
  }

  /** The audio context is going away: forget the track and the nodes. */
  destroy() {
    const art = this.store.get().track?.artUrl;
    if (art) URL.revokeObjectURL(art);
    this.engine = null;
    this.node = null;
    this.loaded = false;
    this.store.set({ track: null, playing: false, loading: false });
  }
}
