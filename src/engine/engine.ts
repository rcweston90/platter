import { FxSlot, FxUnit } from './fx';
import { Channel, crossfadeFor, levelGain, type ChannelState, type ChannelSwitches, type CrossfaderCurve, type XfAssign } from './mixer';

/** Worklets ship as files beside the page (public/worklets/), resolved
 *  against the document so the app works from any sub-path. The query is a
 *  hash of their contents (vite.config.ts), so a new build's worklets get new
 *  URLs and the service worker never hands back an old copy. */
declare const __WORKLETS_VERSION__: string | undefined;
const WORKLETS_VERSION = typeof __WORKLETS_VERSION__ === 'string' ? __WORKLETS_VERSION__ : '';
export const workletUrl = (name: string) =>
  new URL(`worklets/${name}${WORKLETS_VERSION ? `?v=${WORKLETS_VERSION}` : ''}`, document.baseURI).href;

/**
 * Where the headphone (cue) mix goes:
 *   · off    — nowhere; the master is the only output;
 *   · split  — one stereo output, master (mono) left and cue (mono) right,
 *              for a laptop with a splitter cable;
 *   · device — a second audio interface, by deviceId.
 */
export type CueRouting = { kind: 'off' } | { kind: 'split' } | { kind: 'device'; deviceId: string };

/**
 * What the main output plays while the headphones have no output of their
 * own (cue routing off): the master, deck A or B alone (pre-fader, as its
 * headphone cue hears it), or the headphone mix — the cued channels blended
 * with the master by the Cue mix knob. See listen.ts.
 */
export type ListenSource = 'master' | 'cueA' | 'cueB' | 'blend';

export interface OutputDevice {
  deviceId: string;
  label: string;
}

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
type SinkAudioElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * The audio context and the fixed half of the graph: the mixer, master and
 * headphone buses, and the recorder. Decks plug into `channels[i].input`.
 * Created on the first gesture (play, load) — browsers won't start audio
 * before one, and the playground mounts this piece as a still preview.
 */
export class DjEngine {
  readonly channels: [Channel, Channel];
  /** The mix bus before the master level: where the sampler joins. */
  readonly bus: GainNode;
  readonly masterMeters: [AnalyserNode, AnalyserNode];
  /** The one Beat FX unit, and the places it can sit: deck A, deck B, master. */
  readonly fx: FxUnit;
  private fxSlots: [FxSlot, FxSlot, FxSlot];
  private masterGain: GainNode;
  private masterOut: GainNode;
  private cueBus: GainNode;
  private cueFromMaster: GainNode;
  private hp: GainNode;
  private merger: ChannelMergerNode;
  private monoMaster: GainNode;
  private monoHp: GainNode;
  private hpStream: MediaStreamAudioDestinationNode | null = null;
  private hpElement: SinkAudioElement | null = null;
  private routing: CueRouting = { kind: 'off' };
  /** The main output's own volume: after the master meters and the
   *  recorder's tap, so it changes what you hear and nothing else. */
  private out: GainNode;
  private listen: ListenSource = 'master';
  private listenFrom: Record<ListenSource, GainNode>;
  private listenCue: GainNode;
  private recorder: MediaRecorder | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private recordChunks: Blob[] = [];

  private constructor(readonly ctx: AudioContext) {
    const master = ctx.createGain();
    this.bus = master;
    this.cueBus = ctx.createGain();
    this.channels = [new Channel(ctx, master, this.cueBus), new Channel(ctx, master, this.cueBus)];

    this.masterGain = ctx.createGain();
    // Safety limiter, not a loudness tool: it only bites when two loud tracks
    // and boosted EQ stack up past full scale.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.masterOut = ctx.createGain();
    // The master's FX slot sits after the bus, so a master effect takes in
    // both decks, the sampler and the beat board, before the master level.
    const masterSlot = new FxSlot(ctx);
    master.connect(masterSlot.input);
    masterSlot.output.connect(this.masterGain).connect(limiter).connect(this.masterOut);
    this.fx = new FxUnit(ctx);
    this.fxSlots = [this.channels[0].fxSlot, this.channels[1].fxSlot, masterSlot];
    this.fxSlots.forEach((slot) => slot.attach(this.fx));
    this.routeFx(0);

    const split = ctx.createChannelSplitter(2);
    this.masterOut.connect(split);
    this.masterMeters = [ctx.createAnalyser(), ctx.createAnalyser()];
    this.masterMeters.forEach((m, i) => {
      m.fftSize = 1024;
      split.connect(m, i);
    });

    // Headphones: cue bus blended with the master (the "cue mix" knob).
    this.cueFromMaster = ctx.createGain();
    this.hp = ctx.createGain();
    this.cueBus.connect(this.hp);
    this.masterOut.connect(this.cueFromMaster).connect(this.hp);

    // Split-cue plumbing, wired only while that routing is selected.
    this.merger = ctx.createChannelMerger(2);
    this.monoMaster = this.mono();
    this.monoHp = this.mono();
    this.monoMaster.connect(this.merger, 0, 0);
    this.monoHp.connect(this.merger, 0, 1);

    // The main output: one of four sources, picked by gain so a switch is a
    // quick fade, not a click. Decks A and B are tapped where the channel
    // meter is (an analyser passes its input through), the same pre-fader
    // point the headphone cue hears, and follow the headphone level.
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.listenCue = ctx.createGain();
    this.listenCue.connect(this.out);
    this.listenFrom = { master: ctx.createGain(), cueA: ctx.createGain(), cueB: ctx.createGain(), blend: ctx.createGain() };
    this.masterOut.connect(this.listenFrom.master).connect(this.out);
    this.hp.connect(this.listenFrom.blend).connect(this.out);
    this.channels[0].meter.connect(this.listenFrom.cueA).connect(this.listenCue);
    this.channels[1].meter.connect(this.listenFrom.cueB).connect(this.listenCue);
    this.applyListen(true);
  }

  /** The source the main output plays now: the pick applies while the
   *  headphones have no output of their own; otherwise it's the master
   *  (split carries the master and cue on its own, left and right). */
  get listening(): ListenSource {
    return this.routing.kind === 'off' ? this.listen : 'master';
  }

  setListen(source: ListenSource, level: number) {
    this.listen = source;
    this.out.gain.setTargetAtTime(levelGain(level), this.ctx.currentTime, 0.015);
    this.applyListen();
  }

  private applyListen(instant = false) {
    const on = this.routing.kind === 'split' ? null : this.listening;
    const t = this.ctx.currentTime;
    for (const k of Object.keys(this.listenFrom) as ListenSource[]) {
      const g = this.listenFrom[k].gain;
      const v = k === on ? 1 : 0;
      if (instant) g.value = v;
      else g.setTargetAtTime(v, t, 0.01);
    }
  }

  private mono() {
    const g = this.ctx.createGain();
    g.channelCount = 1;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'speakers';
    return g;
  }

  static async create(): Promise<DjEngine> {
    // iPhone: Web Audio counts as "ambient" sound by default, so the ring /
    // silent switch mutes the whole rig. A DJ app is playback, like a music
    // player (Safari 16.4+, the Audio Session API; ignored elsewhere).
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = 'playback';
      } catch {
        // Older implementations may refuse the assignment: keep the default.
      }
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl('deck.js'));
    return new DjEngine(ctx);
  }

  /** Context time of the sample reaching the speakers right now — what the
   *  playheads, meters and waveforms should show, output latency included. */
  now(): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
  }

  /** The headphone (cue) bus: the sampler auditions sounds here. */
  get cueInput(): AudioNode {
    return this.cueBus;
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  applyChannel(i: 0 | 1, s: ChannelState, sw?: ChannelSwitches) {
    this.channels[i].apply(s, sw);
  }

  /** Puts the Beat FX unit on channel A (0), B (1) or the master (2). */
  routeFx(slot: 0 | 1 | 2) {
    this.fxSlots.forEach((s, i) => s.select(i === slot));
  }

  applyCrossfader(x: number, curve: CrossfaderCurve, assign: readonly [XfAssign, XfAssign] = ['A', 'B']) {
    const [a, b] = crossfadeFor(x, curve, assign);
    this.channels[0].setCrossfade(a);
    this.channels[1].setCrossfade(b);
  }

  applyLevels(master: number, cueMix: number, cueLevel: number) {
    const t = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(levelGain(master), t, 0.015);
    // cueMix: 0 = cue only, 1 = master only — equal-power so the middle isn't a dip.
    this.cueBus.gain.setTargetAtTime(Math.cos((cueMix * Math.PI) / 2), t, 0.015);
    this.cueFromMaster.gain.setTargetAtTime(Math.sin((cueMix * Math.PI) / 2), t, 0.015);
    this.hp.gain.setTargetAtTime(levelGain(cueLevel), t, 0.015);
    this.listenCue.gain.setTargetAtTime(levelGain(cueLevel), t, 0.015);
  }

  /* ── Outputs ─────────────────────────────────────────────────────────── */

  static canPickMasterDevice() {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  static canPickCueDevice() {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  }

  async setMasterDevice(deviceId: string) {
    const ctx = this.ctx as SinkAudioContext;
    if (ctx.setSinkId) await ctx.setSinkId(deviceId);
  }

  async setCueRouting(next: CueRouting) {
    // Tear down whatever the previous routing wired.
    if (this.routing.kind === 'split') {
      this.masterOut.disconnect(this.monoMaster);
      this.hp.disconnect(this.monoHp);
      this.merger.disconnect();
    } else if (this.routing.kind === 'device' && this.hpStream) {
      this.hp.disconnect(this.hpStream);
      this.hpElement?.pause();
    }
    this.routing = next;
    this.applyListen(true);

    if (next.kind === 'split') {
      this.masterOut.connect(this.monoMaster);
      this.hp.connect(this.monoHp);
      this.merger.connect(this.out);
    } else if (next.kind === 'device') {
      if (!this.hpStream) this.hpStream = this.ctx.createMediaStreamDestination();
      if (!this.hpElement) {
        this.hpElement = new Audio() as SinkAudioElement;
        this.hpElement.srcObject = this.hpStream.stream;
      }
      this.hp.connect(this.hpStream);
      await this.hpElement.setSinkId?.(next.deviceId);
      await this.hpElement.play();
    }
  }

  /* ── Health ──────────────────────────────────────────────────────────── */

  /** What the browser tells about the output: its rate and latency, and —
   *  only where it implements AudioContext.playoutStats — how often the
   *  output had to fill in silence because audio came too late (a dropout).
   *  `dropouts` is null where the browser doesn't report them. */
  health(): AudioHealth {
    const ctx = this.ctx as AudioContext & { playoutStats?: PlayoutStats };
    const ps = ctx.playoutStats;
    const events = ps ? (ps.fallbackFramesEvents ?? ps.underrunEvents) : undefined;
    const ms = ps ? (ps.fallbackFramesDuration ?? ps.underrunDuration) : undefined;
    return {
      sampleRate: ctx.sampleRate,
      baseLatency: ctx.baseLatency || 0,
      outputLatency: ctx.outputLatency || 0,
      dropouts: typeof events === 'number' ? events : null,
      dropoutMs: typeof ms === 'number' ? ms : null,
    };
  }

  /* ── Recording ───────────────────────────────────────────────────────── */

  startRecording(): boolean {
    if (typeof MediaRecorder === 'undefined') return false;
    if (this.recorder) return true;
    if (!this.recordDest) {
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.masterOut.connect(this.recordDest);
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rec = new MediaRecorder(this.recordDest.stream, {
      ...(type ? { mimeType: type } : {}),
      audioBitsPerSecond: 256_000,
    });
    // Listen from the very first chunk: the timeslice hands one over every
    // second, and the first one carries the file's header. A listener added
    // only at stop misses all of them and leaves an empty, unplayable file.
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    this.recordChunks = chunks;
    this.recorder = rec;
    rec.start(1000);
    return true;
  }

  /** Resolves with the recorded mix once the recorder has flushed, or null
   *  when nothing was captured. */
  stopRecording(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec) return Promise.resolve(null);
    this.recorder = null;
    const chunks = this.recordChunks;
    this.recordChunks = [];
    const done = () => (chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
    if (rec.state === 'inactive') return Promise.resolve(done());
    return new Promise((resolve) => {
      // The last chunk arrives (dataavailable) just before stop fires.
      rec.onstop = () => resolve(done());
      rec.onerror = () => resolve(done());
      rec.stop();
    });
  }

  close() {
    void this.stopRecording();
    this.hpElement?.pause();
    void this.ctx.close();
  }
}

/** AudioContext.playoutStats (the Audio Playout Statistics draft). Early
 *  builds named the counters underrun…, later ones fallbackFrames…. */
interface PlayoutStats {
  fallbackFramesEvents?: number;
  fallbackFramesDuration?: number;
  underrunEvents?: number;
  underrunDuration?: number;
}

export interface AudioHealth {
  sampleRate: number;
  /** Seconds. */
  baseLatency: number;
  outputLatency: number;
  dropouts: number | null;
  dropoutMs: number | null;
}

/** Audio outputs the browser will name. Labels need a media permission in
 *  Chromium; without one the list comes back nameless (or empty). */
export async function listOutputDevices(): Promise<OutputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'audiooutput' && d.deviceId)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
}

/** Asks for the permission that makes output devices listable. Chromium only
 *  names outputs once a microphone grant exists; the stream is stopped at
 *  once and nothing is recorded. */
export async function unlockDeviceNames(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}
