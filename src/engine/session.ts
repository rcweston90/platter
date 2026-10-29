import { analyseTrack, computePeaks, decodeAudio, detectTempo, newTrackId, trackFromFile } from './analysis';
import { fetchArtwork, fetchAudiusAudio, type AudiusTrack } from './audius';
import { AutoDj } from './autodj';
import { backupToImported, makeBackup, matchTrack, parseBackup, parseRekordboxXml, type ImportedTrack } from './backup';
import { Deck, PITCH_RANGES } from './deck';
import { DEMOS, demoRecords, renderDemo } from './demo';
import { DjEngine, listOutputDevices, unlockDeviceNames, type CueRouting, type OutputDevice } from './engine';
import { audioFilesIn, fileFromHandle, pickFolder } from './folder';
import type { FxState } from './fx';
import { detectKey } from './key';
import {
  getValue,
  loadCrate,
  loadRecordings,
  removeRecording,
  removeTrack,
  saveRecording,
  saveTrack,
  setValue,
  type RecordingRecord,
} from './library';
import { MidiController, type MidiHandlers } from './midi';
import { defaultChannel, type ChannelState, type CrossfaderCurve } from './mixer';
import { Sampler } from './sampler';
import { createStore, type Store } from './store';
import { emptyCues, type TrackRecord } from './types';

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
  /** A one-line result of the last import, link or add, shown under the crate. */
  note: string | null;
}

/** What Platter remembers between visits besides the crate. */
interface Settings {
  v: 1;
  curve: CrossfaderCurve;
  master: number;
  cueMix: number;
  cueLevel: number;
  fx: [Omit<FxState, 'on'>, Omit<FxState, 'on'>];
  decks: { range: number; quantize: boolean; slip: boolean; keyLock: boolean }[];
  samplerLevel: number;
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

const JOG_TICKS_PER_TURN = 256; // controller jog resolution assumed for scratching

/**
 * The whole rig: two decks, the mixer, the crate, the sampler, MIDI and
 * Auto-DJ. Cheap to construct — no audio until the first play or load
 * (`ensureEngine`).
 */
export class DjSession {
  readonly decks: [Deck, Deck] = [new Deck(0), new Deck(1)];
  readonly mixer: Store<MixerState> = createStore(initialMixer());
  readonly crate: Store<CrateState> = createStore<CrateState>({ tracks: [], loaded: false, note: null });
  readonly recordings: Store<{ list: RecordingRecord[] }> = createStore({ list: [] as RecordingRecord[] });
  readonly sampler = new Sampler();
  readonly midi: MidiController;
  readonly autoDj: AutoDj;
  engine: DjEngine | null = null;
  private starting: Promise<DjEngine> | null = null;
  private analysing = false;
  private loadTokens = [0, 0];
  /** A load already on its way to each deck, and whether to play after it. */
  private inflight: [{ id: string; play: boolean } | null, { id: string; play: boolean } | null] = [null, null];
  private disposed = false;
  private unsubs: (() => void)[] = [];
  private saveTimer: number | null = null;
  private jog = [
    { touched: false, total: 0, nudge: 0 },
    { touched: false, total: 0, nudge: 0 },
  ];

  constructor() {
    const [a, b] = this.decks;
    a.other = b;
    b.other = a;
    for (const d of this.decks) {
      d.onPersist = (id, patch) => this.updateTrack(id, patch);
      d.onNeedAudio = (id, play) => void this.loadToDeck(id, d.index, play);
    }
    this.midi = new MidiController(this.midiHandlers());
    this.autoDj = new AutoDj(this);
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
    // Crates saved before key detection: fill demo keys, re-analyse files.
    tracks = tracks.map((t) => {
      if (t.key !== undefined) return t;
      const demo = DEMOS.find((d) => d.id === t.demo);
      if (demo) return { ...t, key: demo.key };
      return { ...t, key: null, status: t.status === 'ready' ? 'analysing' : t.status };
    });
    this.crate.set({ tracks, loaded: true });
    await this.restoreSettings();
    await this.armDecks();
    this.watchForSaves();
    void this.sampler.init();
    void this.midi.init();
    void loadRecordings().then((list) => this.recordings.set({ list }));
    void this.runAnalysis();
  }

  /** Puts the last session's tracks (or the crate's first two) on the decks
   *  — picture only, no audio yet — so the rig opens ready to play. */
  private async armDecks() {
    const tracks = this.crate.get().tracks;
    const last = (await getValue<{ decks: (string | null)[] }>('session'))?.decks ?? [];
    for (const i of [0, 1] as const) {
      const deck = this.decks[i];
      const rec = tracks.find((t) => t.id === last[i]) ?? tracks[i];
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

  private async restoreSettings() {
    const s = await getValue<Settings>('settings');
    if (!s || s.v !== 1) return;
    const channels = this.mixer.get().channels.map((c, i) => ({
      ...c,
      fx: { ...c.fx, ...s.fx[i], on: false },
    })) as [ChannelState, ChannelState];
    this.mixer.set({ curve: s.curve, master: s.master, cueMix: s.cueMix, cueLevel: s.cueLevel, channels });
    s.decks.forEach((p, i) => {
      const d = this.decks[i];
      if (!d) return;
      if ((PITCH_RANGES as readonly number[]).includes(p.range)) d.setRange(p.range);
      d.setQuantize(p.quantize);
      d.setSlip(p.slip);
      d.store.set({ keyLock: p.keyLock });
    });
    this.sampler.setLevel(s.samplerLevel);
  }

  private settings(): Settings {
    const m = this.mixer.get();
    const fx = m.channels.map(({ fx: { type, beats, depth } }) => ({ type, beats, depth })) as Settings['fx'];
    return {
      v: 1,
      curve: m.curve,
      master: m.master,
      cueMix: m.cueMix,
      cueLevel: m.cueLevel,
      fx,
      decks: this.decks.map((d) => {
        const st = d.store.get();
        return { range: st.range, quantize: st.quantize, slip: st.slip, keyLock: st.keyLock };
      }),
      samplerLevel: this.sampler.store.get().level,
    };
  }

  /** Saves settings and the decks' tracks a moment after anything changes. */
  private watchForSaves() {
    const schedule = () => {
      if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = null;
        void setValue('settings', this.settings());
        void setValue('session', { decks: this.decks.map((d) => d.store.get().track?.id ?? null) });
      }, 400);
    };
    this.unsubs.push(
      this.mixer.subscribe(schedule),
      this.sampler.store.subscribe(schedule),
      ...this.decks.map((d) => d.store.subscribe(schedule)),
      // Controller lights follow the rig.
      ...[this.mixer, ...this.decks.map((d) => d.store)].map((s) =>
        s.subscribe(() => this.midi.updateLeds((id) => this.ledState(id))),
      ),
    );
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
          this.sampler.attach(engine.ctx, engine.bus);
          this.sampler.warm();
          this.applyMixer();
          // Beat FX follow each deck's live tempo.
          for (const d of this.decks) {
            const sync = () => engine.channels[d.index].fx.setBpm(d.effectiveBpm());
            sync();
            this.unsubs.push(d.store.subscribe(sync));
          }
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
    void this.autoDj.setOn(false);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.decks.forEach((d) => d.destroy());
    const rec = this.mixer.get().lastRecording;
    if (rec) URL.revokeObjectURL(rec.url);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
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

  async triggerPad(i: number) {
    await this.ensureEngine();
    void this.sampler.trigger(i);
  }

  async refreshDevices(unlock = false) {
    if (unlock) await unlockDeviceNames();
    const devices = await listOutputDevices().catch(() => []);
    this.mixer.set({
      devices,
      audioError: devices.length ? null : 'This page can’t see your audio outputs. Split cue works with any single output.',
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

  /* ── Recording ────────────────────────────────────────────────────────── */

  async toggleRecording() {
    const m = this.mixer.get();
    const engine = await this.ensureEngine();
    if (!m.recording) {
      if (engine.startRecording()) this.mixer.set({ recording: true, recordStarted: performance.now() });
      else this.mixer.set({ audioError: 'Recording is not supported in this browser.' });
      return;
    }
    const seconds = (performance.now() - m.recordStarted) / 1000;
    this.mixer.set({ recording: false });
    const blob = await engine.stopRecording();
    if (!blob) return;
    if (m.lastRecording) URL.revokeObjectURL(m.lastRecording.url);
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const name = `platter-mix-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
    this.mixer.set({ lastRecording: { blob, url: URL.createObjectURL(blob), name } });
    // Every mix is kept until you delete it, so forgetting to save loses nothing.
    const rec: RecordingRecord = { id: newTrackId(), name, blob, seconds, createdAt: Date.now() };
    void saveRecording(rec);
    this.recordings.set({ list: [rec, ...this.recordings.get().list] });
  }

  deleteRecording(id: string) {
    void removeRecording(id);
    this.recordings.set({ list: this.recordings.get().list.filter((r) => r.id !== id) });
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

  private addRecords(recs: TrackRecord[]) {
    if (!recs.length) return;
    this.crate.set({ tracks: [...this.crate.get().tracks, ...recs] });
    recs.forEach((r) => void saveTrack(r));
    void this.runAnalysis();
  }

  async addFiles(files: File[]) {
    const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|aiff?|flac|ogg|oga|opus|m4a|aac|webm)$/i.test(f.name));
    const recs: TrackRecord[] = [];
    for (const file of audio) {
      recs.push(await trackFromFile(file));
      if (this.disposed) return 0;
    }
    this.addRecords(recs);
    return audio.length;
  }

  /** Links a music folder: the crate keeps handles, not copies. */
  async linkFolder() {
    const dir = await pickFolder();
    if (!dir) return;
    this.crate.set({ note: `Reading “${dir.name}”…` });
    const handles = await audioFilesIn(dir);
    const known = new Set(this.crate.get().tracks.map((t) => t.fileName));
    const fresh = handles.filter((h) => !known.has(h.name));
    const recs: TrackRecord[] = [];
    for (const h of fresh) {
      const file = await h.getFile();
      const rec = await trackFromFile(file);
      recs.push({ ...rec, blob: null, handle: h });
    }
    this.addRecords(recs);
    this.crate.set({
      note: `Linked “${dir.name}”: ${recs.length} new track${recs.length === 1 ? '' : 's'}${handles.length > fresh.length ? `, ${handles.length - fresh.length} already in the crate` : ''}.`,
    });
  }

  async addAudius(t: AudiusTrack) {
    if (this.crate.get().tracks.some((c) => c.audius === t.id)) return this.crate.get().tracks.find((c) => c.audius === t.id)!.id;
    const rec: TrackRecord = {
      id: newTrackId(),
      title: t.title,
      artist: t.artist,
      fileName: '',
      duration: t.duration,
      bpm: null,
      gridOffset: 0,
      key: null,
      peaks: null,
      art: await fetchArtwork(t.artwork),
      blob: null,
      audius: t.id,
      link: t.link,
      cues: emptyCues(),
      addedAt: Date.now(),
      status: 'analysing',
    };
    this.addRecords([rec]);
    return rec.id;
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
    this.autoDj.dequeue(id);
    void removeTrack(id);
    return true;
  }

  /** The audio behind a crate record. `interactive` may ask for permission
   *  (a linked file after a browser restart); background work never does. */
  private async audioBlob(rec: TrackRecord, interactive: boolean): Promise<Blob | null> {
    if (rec.blob) return rec.blob;
    if (rec.handle) return fileFromHandle(rec.handle, interactive);
    if (rec.audius) return fetchAudiusAudio(rec.audius);
    return null;
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
          const blob = await this.audioBlob(next, false);
          // No access yet (a linked file): analysed when it's first loaded.
          if (!blob) this.updateTrack(next.id, { status: 'ready' });
          else this.updateTrack(next.id, await analyseTrack(next, blob));
        } catch {
          this.updateTrack(next.id, {
            status: 'error',
            error: next.audius ? 'Audius couldn’t be reached from here.' : 'This file could not be decoded.',
          });
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
      let buffer: AudioBuffer;
      if (rec.demo) {
        buffer = await renderDemo(rec.demo, engine.ctx.sampleRate);
      } else {
        const blob = await this.audioBlob(rec, true);
        if (!blob) throw new Error('No access to that file — allow it when the browser asks.');
        buffer = await decodeAudio(blob, engine.ctx.sampleRate);
      }
      if (token !== this.loadTokens[i] || this.disposed) return;
      let ready = rec;
      if (!rec.peaks) {
        const peaks = computePeaks(buffer);
        ready = { ...rec, peaks, duration: buffer.duration };
        this.updateTrack(rec.id, { peaks, duration: buffer.duration });
      }
      deck.load(ready, buffer, rec.art ? URL.createObjectURL(rec.art) : null);
      if (this.inflight[i]?.play) deck.play();
      // Never analysed (no access in the background): do it now.
      if (!rec.demo && rec.bpm === null && rec.status !== 'error') void this.analyseLoaded(rec, buffer);
    } catch (err) {
      if (token === this.loadTokens[i]) {
        const why = err instanceof Error && err.message.startsWith('No access') ? err.message : `“${rec.title}” could not be loaded.`;
        deck.setLoading(false, why);
      }
    } finally {
      if (token === this.loadTokens[i]) this.inflight[i] = null;
    }
  }

  private async analyseLoaded(rec: TrackRecord, buffer: AudioBuffer) {
    const tempo = await detectTempo(buffer);
    const patch: Partial<TrackRecord> = { key: rec.key ?? detectKey(buffer), status: 'ready' };
    if (tempo) {
      patch.bpm = Math.round(tempo.bpm * 100) / 100;
      patch.gridOffset = tempo.offset;
    }
    this.updateTrack(rec.id, patch);
  }

  /* ── Backup and import ────────────────────────────────────────────────── */

  exportBackup(): { name: string; blob: Blob } {
    const data = makeBackup(this.crate.get().tracks, this.settings(), this.midi.bindings());
    const d = new Date().toISOString().slice(0, 10);
    return { name: `platter-backup-${d}.json`, blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }) };
  }

  /** Imports a Platter backup (.json) or a Rekordbox collection (.xml). */
  async importFile(file: File) {
    const text = await file.text();
    let entries: (ImportedTrack & { id?: string })[];
    let source: string;
    try {
      if (/^\s*</.test(text)) {
        entries = parseRekordboxXml(text);
        source = 'Rekordbox';
      } else {
        const backup = parseBackup(text);
        entries = backupToImported(backup);
        source = 'Backup';
        this.midi.importBindings(backup.midi);
      }
    } catch (err) {
      this.crate.set({ note: err instanceof Error ? err.message : 'That file couldn’t be read.' });
      return;
    }
    let updated = 0;
    for (const e of entries) {
      const t = matchTrack(this.crate.get().tracks, e);
      if (!t) continue;
      const patch: Partial<TrackRecord> = {};
      if (e.bpm) patch.bpm = e.bpm;
      if (e.gridOffset !== null) patch.gridOffset = e.gridOffset;
      if (e.key) patch.key = e.key;
      if (e.cues) patch.cues = e.cues;
      this.updateTrack(t.id, patch);
      // A loaded deck takes the imported grid and cues at once.
      for (const d of this.decks) {
        if (d.store.get().track?.id !== t.id) continue;
        d.store.set({
          ...(patch.bpm ? { bpm: patch.bpm } : {}),
          ...(patch.gridOffset !== undefined ? { gridOffset: patch.gridOffset } : {}),
          ...(patch.key ? { key: patch.key } : {}),
          ...(patch.cues ? { cue: patch.cues.main, hotCues: [...patch.cues.hot] } : {}),
        });
      }
      updated++;
    }
    const missing = entries.length - updated;
    this.crate.set({
      note: `${source}: updated ${updated} track${updated === 1 ? '' : 's'}${missing ? `; ${missing} aren’t in this crate — add their files, then import again` : ''}.`,
    });
  }

  /* ── MIDI ─────────────────────────────────────────────────────────────── */

  private midiHandlers(): MidiHandlers {
    const h: MidiHandlers = {};
    const knob = (id: string, fn: (v: number) => void) => (h[id] = fn);
    const press = (id: string, fn: () => void) => (h[id] = (v) => v && fn());
    for (const d of this.decks) {
      const L = d.label;
      const i = d.index;
      const st = () => d.store.get();
      press(`${L}.play`, () => d.togglePlay());
      h[`${L}.cue`] = (v) => (v ? d.cueDown() : d.cueUp());
      press(`${L}.sync`, () => d.setSync(!st().sync));
      press(`${L}.keylock`, () => void d.setKeyLock(!st().keyLock));
      press(`${L}.slip`, () => d.setSlip(!st().slip));
      press(`${L}.loop`, () => d.toggleLoop());
      press(`${L}.loopHalf`, () => d.stepLoop(-1));
      press(`${L}.loopDouble`, () => d.stepLoop(1));
      press(`${L}.jumpBack`, () => d.beatJump(-1));
      press(`${L}.jumpFwd`, () => d.beatJump(1));
      [0, 1, 2, 3].forEach((k) => press(`${L}.hot${k + 1}`, () => d.hotCue(k)));
      h[`${L}.roll`] = (v) => d.roll(v ? 0.25 : null);
      h[`${L}.censor`] = (v) => d.censor(!!v);
      press(`${L}.fx`, () => {
        const fx = this.mixer.get().channels[i].fx;
        this.setChannel(i, { fx: { ...fx, on: !fx.on } });
      });
      h[`${L}.bendDown`] = (v) => d.setBend(v ? -1 : 0);
      h[`${L}.bendUp`] = (v) => d.setBend(v ? 1 : 0);
      knob(`${L}.pitch`, (v) => d.setPitch((v * 2 - 1) * st().range));
      h[`${L}.jogTouch`] = (v) => {
        this.jog[i].touched = !!v;
        this.jog[i].total = 0;
        d.touch(!!v);
      };
      h[`${L}.jog`] = (delta) => {
        const j = this.jog[i];
        if (j.touched) {
          j.total += delta;
          d.scratch((j.total / JOG_TICKS_PER_TURN) * 1.8);
          return;
        }
        // Untouched jog: nudge, the way a hand on the platter's edge does.
        d.setBend(Math.sign(delta));
        window.clearTimeout(j.nudge);
        j.nudge = window.setTimeout(() => d.setBend(0), 80);
      };
      knob(`${L}.trim`, (v) => this.setChannel(i, { trim: v }));
      knob(`${L}.high`, (v) => this.setChannel(i, { high: v }));
      knob(`${L}.mid`, (v) => this.setChannel(i, { mid: v }));
      knob(`${L}.low`, (v) => this.setChannel(i, { low: v }));
      knob(`${L}.filter`, (v) => this.setChannel(i, { filter: Math.abs(v - 0.5) < 0.02 ? 0 : v * 2 - 1 }));
      knob(`${L}.fader`, (v) => this.setChannel(i, { fader: v }));
      press(`${L}.pfl`, () => this.setChannel(i, { cue: !this.mixer.get().channels[i].cue }));
    }
    knob('xfader', (v) => this.setCrossfader(v * 2 - 1));
    knob('master', (v) => this.setLevels({ master: v }));
    knob('cueMix', (v) => this.setLevels({ cueMix: v }));
    for (let p = 0; p < 8; p++) press(`pad${p + 1}`, () => void this.triggerPad(p));
    return h;
  }

  private ledState(id: string): boolean | null {
    const m = /^([AB])\.(\w+)$/.exec(id);
    if (!m) return null;
    const i = m[1] === 'A' ? 0 : 1;
    const st = this.decks[i].store.get();
    const ch = this.mixer.get().channels[i];
    switch (m[2]) {
      case 'play':
        return st.playing;
      case 'sync':
        return st.sync;
      case 'keylock':
        return st.keyLock;
      case 'slip':
        return st.slip;
      case 'loop':
        return st.loop.active;
      case 'fx':
        return ch.fx.on;
      case 'pfl':
        return ch.cue;
      case 'hot1':
      case 'hot2':
      case 'hot3':
      case 'hot4':
        return st.hotCues[Number(m[2].slice(3)) - 1] !== null;
      default:
        return null;
    }
  }
}
