import { analyseTrack, computePeaks, decodeAudio, trackFromFile } from './analysis';
import { Deck } from './deck';
import { DEMOS, demoRecords, renderDemo } from './demo';
import { DjEngine, listOutputDevices, unlockDeviceNames, type CueRouting, type OutputDevice } from './engine';
import { loadCrate, removeTrack, saveTrack } from './library';
import { defaultChannel, type ChannelState, type CrossfaderCurve } from './mixer';
import { createStore, type Store } from './store';
import type { TrackRecord } from './types';

export interface MixerState {
  channels: [ChannelState, ChannelState];
  /** −1 (deck A) … 1 (deck B). */
  crossfader: number;
  curve: CrossfaderCurve;
  master: number;
  /** Headphones: 0 = cue only … 1 = master only. */
  cueMix: number;
  cueLevel: number;
  cueRouting: CueRouting;
  masterDevice: string;
  devices: OutputDevice[];
  audio: 'idle' | 'starting' | 'running' | 'error';
  audioError: string | null;
  recording: boolean;
  /** performance.now() when recording started. */
  recordStarted: number;
  lastRecording: { blob: Blob; url: string; name: string } | null;
}

export interface CrateState {
  tracks: TrackRecord[];
  loaded: boolean;
}

function initialMixer(): MixerState {
  return {
    channels: [defaultChannel(), defaultChannel()],
    crossfader: 0,
    curve: 'power',
    master: 0.8,
    cueMix: 0.25,
    cueLevel: 0.8,
    cueRouting: { kind: 'off' },
    masterDevice: '',
    devices: [],
    audio: 'idle',
    audioError: null,
    recording: false,
    recordStarted: 0,
    lastRecording: null,
  };
}

/**
 * The whole rig: two decks, the mixer and the crate. Cheap to construct —
 * no audio until the first play or load (`ensureEngine`), so it can sit in
 * the playground's still preview without opening an AudioContext.
 */
export class DjSession {
  readonly decks: [Deck, Deck] = [new Deck(0), new Deck(1)];
  readonly mixer: Store<MixerState> = createStore(initialMixer());
  readonly crate: Store<CrateState> = createStore<CrateState>({ tracks: [], loaded: false });
  engine: DjEngine | null = null;
  private starting: Promise<DjEngine> | null = null;
  private analysing = false;
  private loadTokens = [0, 0];
  /** A load already on its way to each deck, and whether to play after it. */
  private inflight: [{ id: string; play: boolean } | null, { id: string; play: boolean } | null] = [null, null];
  private disposed = false;

  constructor() {
    const [a, b] = this.decks;
    a.other = b;
    b.other = a;
    for (const d of this.decks) {
      d.onPersist = (id, patch) => this.updateTrack(id, patch);
      d.onNeedAudio = (id, play) => void this.loadToDeck(id, d.index, play);
    }
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  /** Safe to call again after `dispose` — React's dev double-mount does. */
  async init() {
    this.disposed = false;
    let tracks = await loadCrate();
    if (this.disposed) return;
    if (!tracks.length) {
      tracks = demoRecords();
      tracks.forEach((t) => void saveTrack(t));
    }
    this.crate.set({ tracks, loaded: true });
    await this.armDecks();
    void this.runAnalysis();
  }

  /** Put the crate's first two tracks on the decks — picture only, no audio
   *  yet — so the first screen is a rig ready to play, not two empty decks. */
  private async armDecks() {
    const tracks = this.crate.get().tracks;
    for (const i of [0, 1] as const) {
      const deck = this.decks[i];
      const rec = tracks[i];
      if (!rec || deck.store.get().track || this.disposed) continue;
      let peaks = rec.peaks;
      if (!peaks && rec.demo) {
        const buf = await renderDemo(rec.demo, 44100);
        if (this.disposed) return;
        peaks = computePeaks(buf);
        this.updateTrack(rec.id, { peaks, duration: buf.duration });
      }
      if (!peaks || deck.store.get().track) continue;
      deck.arm({ ...rec, peaks }, peaks, rec.art ? URL.createObjectURL(rec.art) : null);
    }
  }

  ensureEngine(): Promise<DjEngine> {
    if (!this.starting) {
      this.mixer.set({ audio: 'starting', audioError: null });
      this.starting = DjEngine.create().then(
        (engine) => {
          if (this.disposed) {
            engine.close();
            return engine;
          }
          this.engine = engine;
          this.decks.forEach((d) => d.attach(engine));
          this.applyMixer();
          this.mixer.set({ audio: 'running' });
          return engine;
        },
        (err: unknown) => {
          this.starting = null;
          this.mixer.set({
            audio: 'error',
            audioError: err instanceof Error ? err.message : 'Audio could not start in this browser.',
          });
          throw err;
        },
      );
    }
    return this.starting;
  }

  dispose() {
    this.disposed = true;
    this.decks.forEach((d) => d.destroy());
    const rec = this.mixer.get().lastRecording;
    if (rec) URL.revokeObjectURL(rec.url);
    this.engine?.close();
    this.engine = null;
    this.starting = null;
    this.mixer.set({ audio: 'idle', recording: false, lastRecording: null });
  }

  /* ── Mixer ────────────────────────────────────────────────────────────── */

  private applyMixer() {
    const e = this.engine;
    if (!e) return;
    const m = this.mixer.get();
    e.applyChannel(0, m.channels[0]);
    e.applyChannel(1, m.channels[1]);
    e.applyCrossfader(m.crossfader, m.curve);
    e.applyLevels(m.master, m.cueMix, m.cueLevel);
  }

  setChannel(i: 0 | 1, patch: Partial<ChannelState>) {
    const channels = [...this.mixer.get().channels] as [ChannelState, ChannelState];
    channels[i] = { ...channels[i], ...patch };
    this.mixer.set({ channels });
    this.engine?.applyChannel(i, channels[i]);
  }

  setCrossfader(crossfader: number) {
    this.mixer.set({ crossfader: Math.max(-1, Math.min(1, crossfader)) });
    this.applyMixer();
  }

  setCurve(curve: CrossfaderCurve) {
    this.mixer.set({ curve });
    this.applyMixer();
  }

  setLevels(patch: Partial<Pick<MixerState, 'master' | 'cueMix' | 'cueLevel'>>) {
    this.mixer.set(patch);
    this.applyMixer();
  }

  async refreshDevices(unlock = false) {
    if (unlock) await unlockDeviceNames();
    const devices = await listOutputDevices().catch(() => []);
    this.mixer.set({
      devices,
      audioError: devices.length
        ? null
        : 'This page can’t see your audio outputs. Split cue works with any single output.',
    });
  }

  async setCueRouting(cueRouting: CueRouting) {
    const engine = await this.ensureEngine();
    try {
      await engine.setCueRouting(cueRouting);
      this.mixer.set({ cueRouting, audioError: null });
    } catch {
      this.mixer.set({ audioError: 'That output could not be opened for the headphones.' });
    }
  }

  async setMasterDevice(deviceId: string) {
    const engine = await this.ensureEngine();
    try {
      await engine.setMasterDevice(deviceId);
      this.mixer.set({ masterDevice: deviceId, audioError: null });
    } catch {
      this.mixer.set({ audioError: 'That output could not be opened for the master.' });
    }
  }

  async toggleRecording() {
    const m = this.mixer.get();
    const engine = await this.ensureEngine();
    if (!m.recording) {
      if (engine.startRecording()) this.mixer.set({ recording: true, recordStarted: performance.now() });
      else this.mixer.set({ audioError: 'Recording is not supported in this browser.' });
      return;
    }
    this.mixer.set({ recording: false });
    const blob = await engine.stopRecording();
    if (!blob) return;
    if (m.lastRecording) URL.revokeObjectURL(m.lastRecording.url);
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const name = `platter-mix-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
    this.mixer.set({ lastRecording: { blob, url: URL.createObjectURL(blob), name } });
  }

  /* ── Crate ────────────────────────────────────────────────────────────── */

  private updateTrack(id: string, patch: Partial<TrackRecord>) {
    let updated: TrackRecord | null = null;
    const tracks = this.crate.get().tracks.map((t) => {
      if (t.id !== id) return t;
      updated = { ...t, ...patch };
      return updated;
    });
    this.crate.set({ tracks });
    if (updated) void saveTrack(updated);
    this.decks.forEach((d) => d.applyAnalysis(id, patch));
  }

  async addFiles(files: File[]) {
    const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|aiff?|flac|ogg|oga|opus|m4a|aac|webm)$/i.test(f.name));
    for (const file of audio) {
      const rec = await trackFromFile(file);
      if (this.disposed) return;
      this.crate.set({ tracks: [...this.crate.get().tracks, rec] });
      void saveTrack(rec);
    }
    void this.runAnalysis();
    return audio.length;
  }

  addDemos() {
    const have = new Set(this.crate.get().tracks.map((t) => t.id));
    const missing = demoRecords().filter((d) => !have.has(d.id));
    if (!missing.length) return;
    missing.forEach((t) => void saveTrack(t));
    this.crate.set({ tracks: [...missing, ...this.crate.get().tracks] });
  }

  hasAllDemos() {
    const have = new Set(this.crate.get().tracks.map((t) => t.id));
    return DEMOS.every((d) => have.has(d.id));
  }

  removeTrack(id: string) {
    if (this.decks.some((d) => d.store.get().track?.id === id)) return false;
    this.crate.set({ tracks: this.crate.get().tracks.filter((t) => t.id !== id) });
    void removeTrack(id);
    return true;
  }

  /** One track at a time, in the background: decoding is memory-hungry, and
   *  the decks need the CPU more than the crate does. */
  private async runAnalysis() {
    if (this.analysing) return;
    this.analysing = true;
    try {
      for (;;) {
        const next = this.crate.get().tracks.find((t) => t.status === 'analysing');
        if (!next || this.disposed) break;
        try {
          this.updateTrack(next.id, await analyseTrack(next));
        } catch {
          this.updateTrack(next.id, { status: 'error', error: 'This file could not be decoded.' });
        }
      }
    } finally {
      this.analysing = false;
    }
  }

  /** Decode (or synthesise) a track onto a deck; `play` starts it once loaded. */
  async loadToDeck(trackId: string, i: 0 | 1, play = false) {
    const deck = this.decks[i];
    const rec = this.crate.get().tracks.find((t) => t.id === trackId);
    if (!rec) return;
    if (deck.store.get().playing) {
      deck.setLoading(false, `Deck ${deck.label} is playing — stop it before loading another track.`);
      return;
    }
    const pending = this.inflight[i];
    if (pending?.id === trackId) {
      // Already on its way (e.g. play pressed twice on an armed deck).
      pending.play ||= play;
      return;
    }
    this.inflight[i] = { id: trackId, play };
    const token = ++this.loadTokens[i];
    deck.setLoading(true);
    try {
      const engine = await this.ensureEngine();
      const buffer = rec.demo
        ? await renderDemo(rec.demo, engine.ctx.sampleRate)
        : await decodeAudio(rec.blob!, engine.ctx.sampleRate);
      if (token !== this.loadTokens[i] || this.disposed) return;
      let ready = rec;
      if (!rec.peaks) {
        const peaks = computePeaks(buffer);
        ready = { ...rec, peaks, duration: buffer.duration };
        this.updateTrack(rec.id, { peaks, duration: buffer.duration });
      }
      deck.load(ready, buffer, rec.art ? URL.createObjectURL(rec.art) : null);
      if (this.inflight[i]?.play) deck.play();
    } catch {
      if (token === this.loadTokens[i]) deck.setLoading(false, `“${rec.title}” could not be decoded.`);
    } finally {
      if (token === this.loadTokens[i]) this.inflight[i] = null;
    }
  }
}
