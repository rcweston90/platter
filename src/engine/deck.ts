import type { StretchNode } from 'signalsmith-stretch';
import { workletUrl, type DjEngine } from './engine';
import { nearestCompatibleShift, shiftKey } from './key';
import { createStore, type Store } from './store';
import { HOT_CUES, type TrackCues, type TrackRecord, type WavePeaks } from './types';

export const PITCH_RANGES = [0.08, 0.16, 0.5] as const;
export const LOOP_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;
export const ROLL_BEATS = [0.125, 0.25, 0.5, 1] as const;
/** Platter speeds, in rpm. A record cut at 33⅓ played at 45 runs 45 / 33⅓ = 1.35× fast. */
export const SPEEDS = [33, 45] as const;
export type Speed = (typeof SPEEDS)[number];
const SPEED_RATIO: Record<Speed, number> = { 33: 1, 45: 45 / (100 / 3) };
const BEND = 0.04; // pitch-bend buttons: ±4%, like holding a finger to the platter edge
const FALLBACK_BPM = 120; // beat-sized loops and jumps still work on an unanalysed track

/* Sync lock: a synced deck keeps chasing the leader's beat, not just lining
   it up once. Small drift is pulled back with a slight speed trim (inaudible
   at these sizes); a big gap (the leader jumped to a cue, or was scratched)
   is closed with one jump to the nearest beat, the way a quantised seek is. */
const LOCK_DEADBAND = 0.003; // s heard — closer than this counts as together
const LOCK_JUMP = 0.015; // s heard — further than this, one jump beats seconds of flamming
const LOCK_TAU = 0.6; // s — the trim closes the gap over about this long
const LOCK_MAX_TRIM = 0.015; // ±1.5% speed at most while trimming

export interface DeckTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  peaks: WavePeaks | null;
  artUrl: string | null;
  /** Where a streamed track came from, with its page there, for the attribution link. */
  source: { name: 'SoundCloud' | 'Audius'; link: string } | null;
}

/** The streaming service a track came from, if any, for its attribution link. */
const sourceOf = (rec: { soundcloud?: string; audius?: string; link?: string }): DeckTrack['source'] =>
  rec.link && (rec.soundcloud || rec.audius) ? { name: rec.soundcloud ? 'SoundCloud' : 'Audius', link: rec.link } : null;

export interface DeckState {
  track: DeckTrack | null;
  loading: boolean;
  error: string | null;
  playing: boolean;
  /** Fraction: 0.02 = +2%. */
  pitch: number;
  range: number;
  /** Platter speed: 45 plays 1.35× faster on top of the pitch fader. */
  speed: Speed;
  keyLock: boolean;
  /** Sync lock: this deck follows the other's tempo and beat. */
  sync: boolean;
  /** Beats this deck sits ahead of the leader's beat while synced — set by
   *  nudging either deck, kept by the lock. 0 = beats land together. */
  syncOffset: number;
  quantize: boolean;
  bpm: number | null;
  gridOffset: number;
  /** The track's Camelot key, as analysed. */
  key: string | null;
  /** Semitones of key shift on top of key lock (needs the stretcher). */
  keyShift: number;
  /** Slip mode: scratches, loops, reverse and rolls return to where the track would be. */
  slip: boolean;
  reverse: boolean;
  /** Beats of the beat roll being held, or null. */
  roll: number | null;
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
    speed: 33,
    keyLock: false,
    sync: false,
    syncOffset: 0,
    quantize: true,
    bpm: null,
    gridOffset: 0,
    key: null,
    keyShift: 0,
    slip: false,
    reverse: false,
    roll: null,
    cue: 0,
    hotCues: Array.from({ length: HOT_CUES }, () => null),
    loop: { active: false, beats: 4, start: 0, end: 0 },
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Into −½…½ — a phase difference, the short way round. */
export const wrapHalf = (v: number) => v - Math.round(v);

export type SyncRole = 'leader' | 'follower' | 'free';

type WorkletMessage =
  | { type: 'pos'; t: number; pos: number; rate: number; playing: boolean; shadow: number; stems?: number[] | null }
  | { type: 'ended' };

/**
 * One turntable: the worklet playhead plus everything a DJ does to it —
 * transport, CDJ-style cue, hot cues, loops, beat jumps, pitch and bend,
 * key lock, beat sync, scratching. State the UI renders lives in `store`;
 * the playhead itself is read on demand with `position()`.
 */
export class Deck {
  readonly store: Store<DeckState> = createStore(initialState());
  /** The other deck — the leader this one follows when it syncs. */
  other: Deck | null = null;
  /** Called when cues, tempo or grid change, so the crate can remember them. */
  onPersist?: (trackId: string, patch: Partial<Pick<TrackRecord, 'cues' | 'bpm' | 'gridOffset'>>) => void;
  /** An armed deck was asked to do something: load its audio (and play). */
  onNeedAudio?: (trackId: string, thenPlay: boolean) => void;

  private engine: DjEngine | null = null;
  private node: AudioWorkletNode | null = null;
  /** Stem peaks the worklet reported since takeStemLevels last ran. */
  private readonly stemPeaks = [0, 0, 0, 0];
  /** The worklet holds this track's audio (false while merely armed). */
  private loaded = false;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private stretch: StretchNode | null = null;
  private stretchLoading: Promise<void> | null = null;
  private stretchLatency = 0;
  private wetOn = false;
  private sr = 44100;
  private rep = { t: 0, pos: 0, rate: 0, shadow: -1 };
  private touched = false;
  private bend = 0;
  private previewing = false;
  private previewLatched = false;
  private taps: number[] = [];
  /** Sync lock's speed trim, on top of bend. */
  private trim = 0;
  private trimKeyed = 0;
  /** Follower beats per leader beat: 1, or 2 / ½ for a double- or half-time match. */
  private mul = 1;
  private lastLockJump = -Infinity;

  constructor(readonly index: 0 | 1) {}

  get label() {
    return this.index === 0 ? 'A' : 'B';
  }

  /** The track's audio is in the worklet (not merely armed on screen). */
  get hasAudio() {
    return this.loaded;
  }

  attach(engine: DjEngine) {
    this.engine = engine;
    this.stretch = null;
    this.stretchLoading = null;
    this.wetOn = false;
    this.rep = { t: 0, pos: 0, rate: 0, shadow: -1 };
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
      if (m.type === 'pos') {
        this.rep = { t: m.t, pos: m.pos, rate: m.rate, shadow: m.shadow };
        if (m.stems) for (let k = 0; k < 4; k++) this.stemPeaks[k] = Math.max(this.stemPeaks[k], m.stems[k]);
        if (this.store.get().sync) this.lockStep();
      }
      else if (m.type === 'ended') this.store.set({ playing: false });
    };
    // A fresh worklet starts at rate 1: give it the fader and speed set
    // before the audio engine existed.
    this.post({ type: 'pitch', value: this.motor() });
    this.trim = 0;
    this.post({ type: 'bend', value: this.bend });
    // Key lock or a key shift remembered from last time needs the stretcher.
    const st = this.store.get();
    if (st.keyLock || st.keyShift) void this.ensureStretch().then(() => this.applyKeyLock());
  }

  private post(msg: Record<string, unknown>, transfer: Transferable[] = []) {
    this.node?.port.postMessage(msg, transfer);
  }

  /* ── Reading the playhead ─────────────────────────────────────────────── */

  /** Playhead in track seconds as it is being heard — output latency and the
   *  key-lock stretcher's delay accounted for. */
  position(): number {
    return this.positionAt(this.engine?.now() ?? 0);
  }

  /** The heard playhead at context time `t`. Sync measures both decks at the
   *  same instant, so the clock's jitter cancels out. */
  private positionAt(t: number): number {
    const { track, cue } = this.store.get();
    if (!track) return 0;
    if (!this.engine || !this.loaded) return cue;
    let frames = this.rep.pos + this.rep.rate * (t - this.rep.t) * this.sr;
    if (this.wetOn) frames -= this.stretchLatency * this.rep.rate * this.sr;
    return clamp(frames / this.sr, 0, track.duration);
  }

  /** Beats since the grid's first beat at the heard playhead (fractional;
   *  every fourth is a bar's 1), or null without a tempo. */
  beatPosition(at?: number): number | null {
    const { bpm, gridOffset } = this.store.get();
    if (!bpm) return null;
    const pos = at === undefined ? this.position() : this.positionAt(at);
    return (pos - gridOffset) / (60 / bpm);
  }

  /** Where slip mode will return to, in track seconds, while it differs from
   *  the heard playhead; null otherwise. */
  slipPosition(): number | null {
    const { track, playing } = this.store.get();
    if (!track || !this.engine || this.rep.shadow < 0) return null;
    const motor = playing ? this.motor() + this.bend + this.trim : 0;
    const frames = this.rep.shadow + motor * (this.engine.now() - this.rep.t) * this.sr;
    return clamp(frames / this.sr, 0, track.duration);
  }

  /** The key you hear: the analysed key, moved by pitch (unless key lock
   *  holds it) and by key shift. */
  effectiveKey(): string | null {
    const { key, keyLock, keyShift } = this.store.get();
    if (!key) return null;
    const fromPitch = keyLock ? 0 : 12 * Math.log2(this.motor());
    return shiftKey(key, Math.round(fromPitch) + keyShift);
  }

  /** Current playback rate (1 = original speed; negative while scratching back). */
  rate(): number {
    return this.rep.rate;
  }

  beatLength(): number {
    return 60 / (this.store.get().bpm ?? FALLBACK_BPM);
  }

  /** The tempo you hear: the track's BPM moved by the pitch fader and the
   *  platter speed. */
  effectiveBpm(): number | null {
    const { bpm } = this.store.get();
    return bpm ? bpm * this.motor() : null;
  }

  /** The motor's speed as a playback rate: pitch fader × platter speed
   *  (1 = the record as cut). Bend rides on top of this. The waveforms scroll
   *  at this rate so both decks are drawn in heard time. */
  motor(): number {
    const { pitch, speed } = this.store.get();
    return (1 + pitch) * SPEED_RATIO[speed];
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
      track: { id: rec.id, title: rec.title, artist: rec.artist, duration: rec.duration, peaks, artUrl, source: sourceOf(rec) },
      loading: false,
      error: null,
      playing: false,
      bpm: rec.bpm,
      gridOffset: rec.gridOffset,
      key: rec.key ?? null,
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
    this.rep = { t: 0, pos: 0, rate: 0, shadow: -1 };
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
        source: sourceOf(rec),
      },
      loading: false,
      error: null,
      playing: false,
      bpm: rec.bpm,
      gridOffset: rec.gridOffset,
      key: rec.key ?? null,
      cue: rec.cues.main,
      hotCues: [...rec.cues.hot],
      loop: { ...this.store.get().loop, active: false },
      reverse: false,
      roll: null,
    });
    this.post({ type: 'loop', in: -1, out: -1 });
    this.post({ type: 'slip', on: this.store.get().slip });
    this.post({ type: 'seek', frame: rec.cues.main * this.sr });
    this.store.set({ syncOffset: 0 });
    const o = this.other;
    if (!this.store.get().sync && o?.store.get().sync && o.store.get().playing) {
      // A new track on the leader while its follower plays: whoever is
      // playing keeps its tempo, so the new track follows it instead.
      o.setSync(false);
      this.setSync(true);
    } else this.followTempo(true);
  }

  /** Stems for the loaded track (drums, bass, vocals as 16-bit PCM at
   *  `rate`), or null to drop them. The buffers move to the worklet. See
   *  engine/stems. */
  setStems(stems: { left: Int16Array; right: Int16Array }[] | null, rate: number) {
    if (!this.loaded) return;
    // Moved, not copied: a long track's stems run to hundreds of megabytes.
    const transfer = stems?.flatMap((s) => [s.left.buffer, s.right.buffer]) ?? [];
    this.post({ type: 'stems', stems, ratio: rate / this.sr }, transfer);
  }

  /** Each part's heard peak (drums, bass, vocals, other; 0 when muted or
   *  stopped) since the last call — for the stems row's meters. */
  takeStemLevels(): [number, number, number, number] {
    const p = this.stemPeaks;
    const out: [number, number, number, number] = [p[0], p[1], p[2], p[3]];
    p.fill(0);
    return out;
  }

  /** Per-part level, 0–1: drums, bass, vocals, other. */
  setStemGains(gains: [number, number, number, number]) {
    this.post({ type: 'stemGains', gains });
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
    if (patch.key !== undefined && s.key == null) next.key = patch.key;
    this.store.set(next);
    this.followTempo(true);
    this.other?.followTempo(true);
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
    // Starting under a playing partner: line up with it first and start at
    // full speed, so the beats land together from the first one. A follower
    // moves to the leader's beat; a leader to its playing follower's.
    const o = this.other;
    const partnerPlaying = !!o?.store.get().playing;
    const follows = s.sync && partnerPlaying;
    const leads = !s.sync && partnerPlaying && !!o?.store.get().sync;
    if (follows) this.alignPhase();
    else if (leads) this.alignToFollower(o!);
    this.post({ type: 'play', instant: follows || leads });
    this.store.set({ playing: true, error: null });
  }

  pause() {
    this.post({ type: 'pause' });
    this.store.set({ playing: false, error: null });
  }

  /** Stop like a turntable with the brake turned up: a slow wind-down. */
  brake(seconds = 1.4) {
    if (!this.loaded || !this.store.get().playing) return;
    this.post({ type: 'pause', brake: seconds });
    this.store.set({ playing: false });
  }

  /** Flick the record backwards and let it wind down — the end-of-track move. */
  spinback(seconds = 1) {
    if (!this.loaded || !this.store.get().playing) return;
    this.post({ type: 'spinback', time: seconds });
    this.store.set({ playing: false });
  }

  setSlip(on: boolean) {
    this.store.set({ slip: on });
    this.post({ type: 'slip', on });
  }

  setReverse(on: boolean) {
    if (!this.ready()) return;
    this.store.set({ reverse: on });
    this.post({ type: 'reverse', on });
  }

  /** Hold to play backwards; let go and the track is where it would have been. */
  censor(on: boolean) {
    if (on ? !this.ready() : !this.loaded) return;
    this.post({ type: 'censor', on });
  }

  /** Hold for a beat roll: a slip loop of `beats` from the current beat. */
  roll(beats: number | null) {
    const s = this.store.get();
    if (beats === null) {
      if (s.roll === null) return;
      this.store.set({ roll: null });
      if (!s.loop.active) this.post({ type: 'loop', in: -1, out: -1 });
      return;
    }
    if (!this.ready()) return;
    const beat = this.beatLength();
    const here = this.position();
    // Start on the beat just played, so the roll lands in time.
    const start =
      s.quantize && s.bpm ? s.gridOffset + Math.floor((here - s.gridOffset) / beat) * beat : here;
    const end = start + beats * beat;
    if (s.loop.active) this.store.set({ loop: { ...s.loop, active: false } });
    this.post({ type: 'loop', in: -1, out: -1 });
    this.post({ type: 'loop', in: start * this.sr, out: end * this.sr, slip: true });
    this.store.set({ roll: beats });
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

  /** The pitch fader. While synced the two decks share one tempo, so a
   *  synced deck's fader moves the leader too (as Mixxx's sync lock does). */
  setPitch(pitch: number) {
    const s = this.store.get();
    const m = s.sync ? this.leaderDeck() : null;
    if (m && s.bpm) {
      const p = clamp(pitch, -s.range, s.range);
      m.setHeardBpm((s.bpm * (1 + p) * SPEED_RATIO[s.speed]) / this.mul);
      return;
    }
    this.applyPitch(pitch, s.range);
  }

  /** Play at this tempo (as heard), widening the pitch range if it has to. */
  private setHeardBpm(heard: number) {
    const t = this.pitchFor(heard);
    if (t) this.applyPitch(t.pitch, t.range);
  }

  private pitchFor(heard: number): { pitch: number; range: number } | null {
    const s = this.store.get();
    if (!s.bpm) return null;
    const pitch = heard / (s.bpm * SPEED_RATIO[s.speed]) - 1;
    let range = s.range;
    for (const r of PITCH_RANGES) {
      if (Math.abs(pitch) <= range) break;
      range = r;
    }
    return { pitch, range };
  }

  private applyPitch(pitch: number, range: number) {
    const p = clamp(pitch, -range, range);
    this.store.set({ pitch: p, range });
    this.post({ type: 'pitch', value: this.motor() });
    this.applyKeyLock();
    this.other?.followTempo();
  }

  /** The pitch fader's range (0.08 = ±8%). The tempo stays where it is,
   *  unless it falls outside the new range, which clamps it. */
  setRange(range: number) {
    this.applyPitch(this.store.get().pitch, range);
    // A synced deck keeps the leader's tempo even if the new range is narrow.
    this.followTempo();
  }

  /** 33 or 45 rpm. 45 runs 1.35× fast on top of the pitch fader. A synced
   *  deck re-pitches to stay on the master's tempo. */
  setSpeed(speed: Speed) {
    if (this.store.get().speed === speed) return;
    this.store.set({ speed });
    if (this.store.get().sync && this.leaderDeck()) this.followTempo();
    else this.applyPitch(this.store.get().pitch, this.store.get().range);
  }

  resetPitch() {
    this.setPitch(0);
  }

  /** −1, 0 or 1: the nudge buttons (or a hand on the platter's edge). */
  setBend(dir: number) {
    const was = this.bend;
    this.bend = dir * BEND;
    this.post({ type: 'bend', value: this.bend + this.trim });
    this.applyKeyLock();
    // Nudging either deck of a synced pair moves where the beats sit
    // relative to each other; the lock keeps that new offset (for a grid
    // that's a hair off, say) until Sync is pressed again.
    if (was && !dir) {
      if (this.store.get().sync) this.keepOffset();
      else if (this.other?.store.get().sync) this.other.keepOffset();
    }
  }

  /** Move the key up or down in semitones, independent of tempo. */
  async setKeyShift(semitones: number) {
    this.store.set({ keyShift: clamp(Math.round(semitones), -6, 6) });
    await this.ensureStretch();
    this.applyKeyLock();
  }

  /** Shift to the nearest key that mixes harmonically with the other deck. */
  keySync() {
    const target = this.other?.effectiveKey();
    const { key, keyLock } = this.store.get();
    if (!key || !target) return;
    const fromPitch = keyLock ? 0 : Math.round(12 * Math.log2(this.motor()));
    const base = shiftKey(key, fromPitch);
    void this.setKeyShift(nearestCompatibleShift(base, target));
  }

  private async ensureStretch() {
    if (!this.engine || this.stretch) return;
    try {
      await this.loadStretch(this.engine);
    } catch {
      this.store.set({ keyLock: false, keyShift: 0, error: 'Key lock and key shift are unavailable in this browser.' });
    }
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
    const shifting = s.keyLock || s.keyShift !== 0;
    const wantWet = shifting && !!this.stretch && !this.touched;
    if (this.stretch && shifting) {
      const lock = s.keyLock ? -12 * Math.log2(this.motor() + this.bend + this.trim) : 0;
      void this.stretch.schedule({ active: true, semitones: lock + s.keyShift });
    }
    if (wantWet === this.wetOn) return;
    this.wetOn = wantWet;
    const t = this.engine.ctx.currentTime;
    this.dry.gain.setTargetAtTime(wantWet ? 0 : 1, t, 0.01);
    this.wet.gain.setTargetAtTime(wantWet ? 1 : 0, t, 0.01);
    if (!wantWet && !shifting && this.stretch) void this.stretch.schedule({ active: false, output: t + 0.15 });
  }

  /* ── Sync ─────────────────────────────────────────────────────────────── */
  /*
   * One deck at a time follows (Sync lit); the other is the leader. The
   * follower matches the leader's tempo — at double or half time when one
   * track is twice the other's — and keeps its beat on the leader's for as
   * long as Sync is on: through the leader's tempo changes, cue jumps, loops
   * and scratches. Either fader moves both. Pressing Sync on the leader swaps
   * roles; loading a new track on the leader while its follower plays hands
   * the lead to the deck that's playing.
   */

  /** The deck this one follows when synced: the other, once it has a tempo. */
  private leaderDeck(): Deck | null {
    const o = this.other;
    return o && o.store.get().track && o.store.get().bpm ? o : null;
  }

  syncRole(): SyncRole {
    if (this.store.get().sync) return 'follower';
    return this.other?.store.get().sync ? 'leader' : 'free';
  }

  /** Follower beats per leader beat: 1, 2 or ½. */
  syncMultiple(): number {
    return this.mul;
  }

  setSync(on: boolean) {
    const o = this.other;
    if (on && o?.store.get().sync) o.setSync(false);
    this.store.set({ sync: on, syncOffset: 0 });
    this.setTrim(0);
    if (!on) return;
    this.followTempo(true);
    if (this.store.get().playing && o?.store.get().playing) this.alignPhase();
  }

  /** Forget a nudged offset: the beats land together again. */
  resetSyncOffset() {
    this.store.set({ syncOffset: 0 });
  }

  /** Match the leader's tempo, widening the pitch range if it has to.
   *  `repick` (a new track or tempo) chooses again between straight, double
   *  and half time. */
  followTempo(repick = false) {
    const s = this.store.get();
    const m = this.leaderDeck();
    if (!s.sync || !m || !s.bpm) return;
    const lead = m.effectiveBpm()!;
    if (repick) {
      const own = s.bpm * SPEED_RATIO[s.speed];
      this.mul = 2 ** clamp(Math.round(Math.log2(own / lead)), -1, 1);
    }
    this.setHeardBpm(lead * this.mul);
  }

  /** The follower is on the leader's tempo (false while its pitch range
   *  can't reach it). */
  tempoLocked(): boolean {
    const m = this.leaderDeck();
    const mine = this.effectiveBpm();
    if (!this.store.get().sync || !m || !mine) return false;
    return Math.abs(mine - m.effectiveBpm()! * this.mul) < 0.05;
  }

  /** How far this deck's beat is from where sync wants it, in this deck's
   *  beats (−½…½; positive = early). Null when there's nothing to measure. */
  phaseError(at?: number): number | null {
    const m = this.leaderDeck();
    const mine = this.beatPosition(at);
    const theirs = m?.beatPosition(at);
    if (mine == null || theirs == null) return null;
    return wrapHalf(mine - theirs * this.mul - this.store.get().syncOffset);
  }

  /** Whole beats this deck's bar is ahead of the leader's (−1…2; 0 = the 1s
   *  land together), or null when there's nothing to measure. */
  barOffset(): number | null {
    const m = this.leaderDeck();
    const mine = this.beatPosition();
    const theirs = m?.beatPosition();
    if (mine == null || theirs == null) return null;
    const d = (((Math.round(mine - theirs * this.mul - this.store.get().syncOffset)) % 4) + 4) % 4;
    return d > 2 ? d - 4 : d;
  }

  /** Jump by whole beats so this deck's bars start with the leader's. */
  alignBars() {
    const off = this.barOffset();
    if (!off || !this.ready()) return;
    this.shift(-off * this.beatLength());
  }

  /** Move this deck's playhead so its beats land on the leader's. */
  private alignPhase() {
    const e = this.phaseError();
    if (e !== null && Math.abs(e) > 0.004) this.shift(-e * this.beatLength());
  }

  /** This (leader) deck is starting under its playing follower: move to meet it. */
  private alignToFollower(f: Deck) {
    const e = f.phaseError();
    if (e !== null && Math.abs(e) > 0.004) this.shift((e / f.mul) * this.beatLength());
  }

  /** After a nudge: keep wherever the beats now sit as the lock's offset. */
  private keepOffset() {
    const e = this.phaseError();
    if (e === null) return;
    this.store.set({ syncOffset: wrapHalf(this.store.get().syncOffset + e) });
  }

  /** Whole-beat loops and rolls keep the phase; shorter ones don't, so the
   *  lock waits them out. */
  private holdsPhase(st: DeckState, mul: number) {
    if (st.reverse) return false;
    if (st.roll !== null && (st.roll * mul) % 1) return false;
    if (st.loop.active && (st.loop.beats * mul) % 1) return false;
    return true;
  }

  /** Runs on each playhead report while synced: hold the beat on the leader's. */
  private lockStep() {
    const s = this.store.get();
    const m = this.leaderDeck();
    const ms = m?.store.get();
    const t = this.rep.t;
    const steady =
      !!m &&
      !!ms &&
      !!this.engine &&
      s.playing &&
      ms.playing &&
      !this.previewing &&
      !this.touched &&
      this.bend === 0 &&
      m.bend === 0 &&
      this.rep.shadow < 0 &&
      this.holdsPhase(s, 1) &&
      m.holdsPhase(ms, this.mul) &&
      // Both turning at motor speed: not scratched, braking or spinning up.
      Math.abs(m.rep.rate - m.motor() - m.trim) < 0.01 &&
      Math.abs(this.rep.rate - this.motor() - this.trim) < 0.02;
    if (!steady) return this.setTrim(0);
    const e = this.phaseError(t);
    if (e === null) return this.setTrim(0);
    const beat = this.beatLength();
    const heard = (e * beat) / this.motor();
    if (Math.abs(heard) > LOCK_JUMP) {
      if (t - this.lastLockJump > 0.4) {
        this.lastLockJump = t;
        this.shift(-e * beat);
      }
      return this.setTrim(0);
    }
    if (t - this.lastLockJump < 0.1) return; // let the jump land before trimming
    this.setTrim(Math.abs(heard) < LOCK_DEADBAND ? 0 : clamp((-e * beat) / LOCK_TAU, -LOCK_MAX_TRIM, LOCK_MAX_TRIM));
  }

  private setTrim(v: number) {
    if (v === this.trim) return;
    this.trim = v;
    this.post({ type: 'bend', value: this.bend + this.trim });
    // Key lock compensates the trim too, so the key doesn't waver.
    if (Math.abs(v - this.trimKeyed) > 0.001 || v === 0) {
      this.trimKeyed = v;
      this.applyKeyLock();
    }
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
    const bpm = bpmHeard / this.motor();
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
    this.followTempo(true);
    this.other?.followTempo(true);
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
