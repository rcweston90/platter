import { Channel, crossfaderGains, levelGain, type ChannelState, type CrossfaderCurve } from './mixer';

/** Worklets ship as files beside the page (public/worklets/), resolved
 *  against the document so the app works from any sub-path. */
export const workletUrl = (name: string) => new URL(`worklets/${name}`, document.baseURI).href;

/**
 * Where the headphone (cue) mix goes:
 *   · off    — nowhere; the master is the only output;
 *   · split  — one stereo output, master (mono) left and cue (mono) right,
 *              for a laptop with a splitter cable;
 *   · device — a second audio interface, by deviceId.
 */
export type CueRouting = { kind: 'off' } | { kind: 'split' } | { kind: 'device'; deviceId: string };

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
  readonly masterMeters: [AnalyserNode, AnalyserNode];
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
  private recorder: MediaRecorder | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;

  private constructor(readonly ctx: AudioContext) {
    const master = ctx.createGain();
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
    master.connect(this.masterGain).connect(limiter).connect(this.masterOut);

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

    this.masterOut.connect(ctx.destination);
  }

  private mono() {
    const g = this.ctx.createGain();
    g.channelCount = 1;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'speakers';
    return g;
  }

  static async create(): Promise<DjEngine> {
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

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  applyChannel(i: 0 | 1, s: ChannelState) {
    this.channels[i].apply(s);
  }

  applyCrossfader(x: number, curve: CrossfaderCurve) {
    const [a, b] = crossfaderGains(x, curve);
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
      this.masterOut.connect(this.ctx.destination);
    } else if (this.routing.kind === 'device' && this.hpStream) {
      this.hp.disconnect(this.hpStream);
      this.hpElement?.pause();
    }
    this.routing = next;

    if (next.kind === 'split') {
      this.masterOut.disconnect(this.ctx.destination);
      this.masterOut.connect(this.monoMaster);
      this.hp.connect(this.monoHp);
      this.merger.connect(this.ctx.destination);
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

  /* ── Recording ───────────────────────────────────────────────────────── */

  startRecording(): boolean {
    if (typeof MediaRecorder === 'undefined') return false;
    if (!this.recordDest) {
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.masterOut.connect(this.recordDest);
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    this.recorder = new MediaRecorder(this.recordDest.stream, {
      ...(type ? { mimeType: type } : {}),
      audioBitsPerSecond: 256_000,
    });
    this.recorder.start(1000);
    return true;
  }

  /** Resolves with the recorded mix once the recorder has flushed. */
  stopRecording(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec) return Promise.resolve(null);
    this.recorder = null;
    const chunks: Blob[] = [];
    return new Promise((resolve) => {
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      // Chunks already emitted by the 1 s timeslice arrive before stop's.
      rec.stop();
    });
  }

  close() {
    void this.stopRecording();
    this.hpElement?.pause();
    void this.ctx.close();
  }
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
