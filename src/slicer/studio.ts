/**
 * The studio: the slicer's controller. It holds the open project (plain data,
 * every edit undoable), the decoded audio behind each source (in memory
 * only), plays the arrangement through the master bus (so the mixer's meters,
 * limiter and recorder hear it), auditions slices, renders WAVs and hands
 * slices to the sampler or the crate.
 *
 * Where audio comes from:
 *   · a crate track — read the way a deck reads it (files, linked folder
 *     files, demos, Audius); stems through the same model and the same rules
 *     as the decks (engine/stems), preferring stems already saved on disk;
 *   · a file opened here — kept in this browser (IndexedDB), never uploaded;
 *   · a sampler sound — from the sound library.
 */
import { detectTempo } from '../engine/analysis';
import type { DjSession } from '../engine/session';
import { splitInWorker, stemsPolicy, STEM_LABELS, STEM_RATE, type StemName } from '../engine/stems';
import type { StemPcm } from '../engine/stems/separate';
import { getSound } from '../engine/sounds/catalog';
import { getValue, setValue } from '../engine/library';
import { createStore, type Store } from '../engine/store';
import { saveFile } from '../ui/save';
import { MAX_HITS, autoSlicePoints, buildPeaks, encodeWav, extractChannels, guessLoopBpm } from './dsp';
import {
  clipBeats,
  clipEnd,
  clipRate,
  cleanSlices,
  drumLaneFor,
  makeClip,
  makeLane,
  newProject,
  reviveProject,
  sliceRange,
  snapBeat,
  songBeats,
  splitClip,
  uid,
  MIN_BPM,
  MAX_BPM,
} from './model';
import { render, SlicerPlayer, type AudioLookup } from './player';
import { SLICE_COLORS, type AutoSlice, type Clip, type Lane, type LaneKind, type Peaks, type Project, type ProjectMeta, type Snap, type Source } from './types';

export type AudioStatus = 'loading' | 'splitting' | 'ready' | 'missing' | 'error';

export interface SourceAudio {
  status: AudioStatus;
  /** 0–1 while splitting stems. */
  progress: number;
  /** Why it's missing or failed, in a sentence. */
  message: string | null;
}

export interface Audition {
  sourceId: string;
  /** Seconds in the source. */
  start: number;
  end: number;
  /** Context time (as heard) the audition's first sample sounds. */
  startedAt: number;
  rate: number;
  loop: boolean;
  reverse: boolean;
}

export interface StudioState {
  /** The slicer view is showing. */
  open: boolean;
  /** Projects and the last one opened have been read back. */
  ready: boolean;
  project: Project;
  projects: ProjectMeta[];
  audio: Record<string, SourceAudio>;
  playing: boolean;
  /** Where play starts from (and the playhead when stopped), beats. */
  cursor: number;
  metronome: boolean;
  /** The source in the slice editor. */
  sourceId: string | null;
  /** The slice selected in the editor (index into the source's slices). */
  slice: number | null;
  /** Selected clips on the timeline. */
  selection: string[];
  canUndo: boolean;
  canRedo: boolean;
  audition: Audition | null;
  /** A one-line note to show in the status bar (what just happened, or what went wrong). */
  note: string | null;
  /** Something slow under way ("Rendering…"), or null. */
  busy: string | null;
  /** Pads play into the timeline while the song plays. */
  recording: boolean;
  /** The lane pads record onto (null: the first audio lane). */
  recordLane: string | null;
}

const INDEX_KEY = 'slicer-index';
const LAST_KEY = 'slicer-last';
const projectKey = (id: string) => `slicer-project:${id}`;
const fileKey = (id: string) => `slicer-file:${id}`;
const HISTORY = 120;
/** Edits with the same merge key this close together are one undo step (a drag). */
const MERGE_MS = 1200;

/** One stems split of a source's audio, shared by all its parts. */
interface StemSet {
  /** drums, bass, vocals as 16-bit (separate.ts KEPT order) at STEM_RATE. */
  stems: StemPcm[];
  mix: AudioBuffer;
}

const originKey = (s: Pick<Source, 'origin'>) =>
  s.origin.kind === 'track' ? `t:${s.origin.trackId}` : s.origin.kind === 'file' ? `f:${s.origin.fileId}` : `s:${s.origin.soundId}`;

export class Studio implements AudioLookup {
  readonly store: Store<StudioState>;
  private buffers = new Map<string, AudioBuffer>();
  private reverses = new Map<string, AudioBuffer>();
  private peakCache = new Map<string, Peaks>();
  private stemSets = new Map<string, Promise<StemSet>>();
  private loading = new Map<string, Promise<void>>();
  private player: SlicerPlayer | null = null;
  private past: Project[] = [];
  private future: Project[] = [];
  private lastEdit = { key: '', at: 0 };
  private saveTimer = 0;
  private auditionNode: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private auditionOut: GainNode | null = null;
  private inited: Promise<void> | null = null;

  constructor(private session: DjSession) {
    this.store = createStore<StudioState>({
      open: false,
      ready: false,
      project: newProject(),
      projects: [],
      audio: {},
      playing: false,
      cursor: 0,
      metronome: false,
      sourceId: null,
      slice: null,
      selection: [],
      canUndo: false,
      canRedo: false,
      audition: null,
      note: null,
      busy: null,
      recording: false,
      recordLane: null,
    });
  }

  private get s() {
    return this.store.get();
  }

  get project(): Project {
    return this.s.project;
  }

  /* ── Opening ──────────────────────────────────────────────────────────── */

  /** Reads the saved projects and reopens the last one (once). */
  init(): Promise<void> {
    if (!this.inited) {
      this.inited = (async () => {
        const projects = (await getValue<ProjectMeta[]>(INDEX_KEY)) ?? [];
        const last = await getValue<string>(LAST_KEY);
        const id = last && projects.some((p) => p.id === last) ? last : projects[0]?.id;
        const saved = id ? reviveProject(await getValue(projectKey(id))) : null;
        const project = saved ?? newProject();
        this.store.set({ projects, project, ready: true, sourceId: project.sources[0]?.id ?? null });
        if (!saved) this.save(true);
      })();
    }
    return this.inited;
  }

  async open() {
    this.store.set({ open: true });
    await this.init();
    this.loadAll();
  }

  close() {
    this.stop();
    this.stopAudition();
    this.store.set({ open: false });
  }

  /* ── Edits, undo and saving ───────────────────────────────────────────── */

  /**
   * Every change to the project goes through here. `merge` names a gesture
   * (a drag, a knob turn): edits with the same key close together are one undo step.
   */
  edit(fn: (p: Project) => Project, merge?: string) {
    const before = this.s.project;
    const after = fn(before);
    if (after === before) return;
    const now = performance.now();
    // Pointer gestures on the timeline carry a key of their own (drag:, trim:,
    // paint:) and end with endGesture, so they stay one step however long
    // the hand pauses. Other keys (nudges, knobs) merge by time.
    const held = !!merge && /^(drag|trim|paint|rec):/.test(merge);
    const merged = !!merge && merge === this.lastEdit.key && (held || now - this.lastEdit.at < MERGE_MS);
    if (!merged) {
      this.past.push(before);
      if (this.past.length > HISTORY) this.past.shift();
    }
    this.lastEdit = { key: merge ?? '', at: now };
    this.future = [];
    this.commit({ ...after, updatedAt: Date.now() });
  }

  /** Ends a gesture, so the next edit is its own undo step. */
  endGesture() {
    this.lastEdit = { key: '', at: 0 };
  }

  private commit(project: Project, extra: Partial<StudioState> = {}) {
    const ids = new Set(project.clips.map((c) => c.id));
    const sourceId = project.sources.some((s) => s.id === this.s.sourceId) ? this.s.sourceId : (project.sources[0]?.id ?? null);
    this.store.set({
      project,
      selection: this.s.selection.filter((id) => ids.has(id)),
      sourceId,
      slice: sourceId === this.s.sourceId ? this.s.slice : null,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      ...extra,
    });
    this.player?.update(project);
    this.player?.setLevel(project.level);
    this.save();
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.s.project);
    this.endGesture();
    this.commit(prev);
    this.loadAll();
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.s.project);
    this.endGesture();
    this.commit(next);
    this.loadAll();
  }

  private save(now = false) {
    window.clearTimeout(this.saveTimer);
    // Until the saved projects are read, the project in hand is a blank
    // placeholder: saving it would make it the one reopened next time.
    if (!this.s.ready) return;
    const write = () => {
      const p = this.s.project;
      const meta: ProjectMeta = { id: p.id, name: p.name, updatedAt: p.updatedAt, clips: p.clips.length };
      const projects = [meta, ...this.s.projects.filter((m) => m.id !== p.id)].sort((a, b) => b.updatedAt - a.updatedAt);
      this.store.set({ projects });
      void setValue(projectKey(p.id), p);
      void setValue(INDEX_KEY, projects);
      void setValue(LAST_KEY, p.id);
    };
    if (now) write();
    else this.saveTimer = window.setTimeout(write, 500);
  }

  /* ── Projects ─────────────────────────────────────────────────────────── */

  private switchTo(project: Project) {
    this.save(true);
    this.stop();
    this.stopAudition();
    this.past = [];
    this.future = [];
    this.endGesture();
    this.store.set({ cursor: 0, selection: [], slice: null, sourceId: project.sources[0]?.id ?? null });
    this.commit(project);
    this.save(true);
    this.loadAll();
  }

  newProject() {
    const n = this.s.projects.length + 1;
    this.switchTo(newProject(`Chop ${n}`));
  }

  async openProject(id: string) {
    if (id === this.s.project.id) return;
    const p = reviveProject(await getValue(projectKey(id)));
    if (!p) {
      this.store.set({ note: 'That project couldn’t be read.' });
      return;
    }
    this.switchTo(p);
  }

  duplicateProject() {
    const p = this.s.project;
    this.switchTo({ ...structuredClone(p), id: uid('p'), name: `${p.name} copy`, createdAt: Date.now(), updatedAt: Date.now() });
  }

  async deleteProject(id: string) {
    const projects = this.s.projects.filter((m) => m.id !== id);
    this.store.set({ projects });
    await setValue(INDEX_KEY, projects);
    await setValue(projectKey(id), null);
    if (id === this.s.project.id) {
      const next = projects[0] ? reviveProject(await getValue(projectKey(projects[0].id))) : null;
      this.switchTo(next ?? newProject());
    }
  }

  rename(name: string) {
    this.edit((p) => ({ ...p, name: name.slice(0, 80) || 'Untitled chop' }), 'rename');
  }

  setBpm(bpm: number) {
    const v = Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)) * 100) / 100;
    this.edit((p) => (p.bpm === v ? p : { ...p, bpm: v }), 'bpm');
  }

  setBars(bars: number) {
    this.edit((p) => ({ ...p, bars: Math.max(1, Math.min(256, Math.round(bars))) }), 'bars');
  }

  setSnap(snap: Snap) {
    this.edit((p) => ({ ...p, snap }));
  }

  setSwing(swing: number) {
    this.edit((p) => ({ ...p, swing: Math.max(50, Math.min(75, Math.round(swing))) }), 'swing');
  }

  setLevel(level: number) {
    this.edit((p) => ({ ...p, level: Math.max(0, Math.min(1, level)) }), 'level');
  }

  setLoop(patch: Partial<Project['loop']>) {
    this.edit((p) => {
      const loop = { ...p.loop, ...patch };
      if (loop.end - loop.start < 0.25) loop.end = loop.start + 0.25;
      loop.start = Math.max(0, loop.start);
      return { ...p, loop };
    }, 'loop');
  }

  /** Loops the selected clips (or, with none, the bar under the cursor). */
  loopSelection() {
    const p = this.s.project;
    const sel = p.clips.filter((c) => this.s.selection.includes(c.id));
    const src = new Map(p.sources.map((s) => [s.id, s]));
    if (sel.length) {
      const start = snapBeat(Math.min(...sel.map((c) => c.at)), p.meter, 'floor');
      const end = Math.max(...sel.map((c) => clipEnd(c, src.get(c.sourceId), p.bpm)));
      this.setLoop({ on: true, start, end: Math.max(start + p.meter, Math.ceil(end / p.meter) * p.meter) });
    } else {
      const start = snapBeat(this.s.cursor, p.meter, 'floor');
      this.setLoop({ on: true, start, end: start + p.meter });
    }
  }

  /* ── Sources ──────────────────────────────────────────────────────────── */

  source(id: string | null | undefined): Source | undefined {
    return id ? this.s.project.sources.find((s) => s.id === id) : undefined;
  }

  /** AudioLookup: decoded audio for playback. */
  buffer(id: string): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  reversed(id: string): AudioBuffer | undefined {
    const hit = this.reverses.get(id);
    if (hit) return hit;
    const buf = this.buffers.get(id);
    const ctx = this.session.engine?.ctx;
    if (!buf || !ctx) return undefined;
    const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = new Float32Array(buf.getChannelData(c));
      d.reverse();
      out.copyToChannel(d, c);
    }
    this.reverses.set(id, out);
    return out;
  }

  /** Waveform peaks for drawing, once the audio is in. */
  peaks(id: string): Peaks | undefined {
    const hit = this.peakCache.get(id);
    if (hit) return hit;
    const buf = this.buffers.get(id);
    if (!buf) return undefined;
    const p = buildPeaks(buf);
    this.peakCache.set(id, p);
    return p;
  }

  private setAudio(id: string, patch: Partial<SourceAudio>) {
    const prev = this.s.audio[id] ?? { status: 'loading', progress: 0, message: null };
    this.store.set({ audio: { ...this.s.audio, [id]: { ...prev, ...patch } } });
  }

  private nextColor() {
    const used = this.s.project.sources.filter((s) => s.origin.kind !== 'sound').length;
    return used % SLICE_COLORS.length;
  }

  private addSource(src: Source, select = true) {
    this.edit((p) => ({ ...p, sources: [...p.sources, src] }));
    if (select) this.store.set({ sourceId: src.id, slice: null });
    void this.load(src);
    return src.id;
  }

  /** A crate track (any of yours: files, linked folder, demos, Audius). */
  addTrack(trackId: string, stem: StemName | null = null): string | null {
    const rec = this.session.crate.get().tracks.find((t) => t.id === trackId);
    if (!rec) return null;
    const existing = this.s.project.sources.find((s) => s.origin.kind === 'track' && s.origin.trackId === trackId && s.stem === stem);
    if (existing) {
      this.store.set({ sourceId: existing.id, slice: null });
      return existing.id;
    }
    return this.addSource({
      id: uid('s'),
      origin: { kind: 'track', trackId },
      stem,
      name: rec.title || rec.fileName || 'Track',
      duration: rec.duration || 0,
      bpm: rec.bpm,
      gridOffset: rec.gridOffset ?? 0,
      key: rec.key ?? null,
      slices: [0],
      color: this.nextColor(),
    });
  }

  /** Files opened in the slicer (FLAC, WAV, AIFF, MP3 …): kept in this browser. */
  async addFiles(files: File[]): Promise<string[]> {
    const ids: string[] = [];
    for (const file of files) {
      if (!file.type.startsWith('audio/') && !/\.(wav|mp3|aiff?|flac|ogg|oga|opus|m4a|aac|webm|alac|caf)$/i.test(file.name)) continue;
      const fileId = uid('f');
      await setValue(fileKey(fileId), file);
      ids.push(
        this.addSource({
          id: uid('s'),
          origin: { kind: 'file', fileId },
          stem: null,
          name: file.name.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 60),
          duration: 0,
          bpm: null,
          gridOffset: 0,
          key: null,
          slices: [0],
          color: this.nextColor(),
        }),
      );
    }
    if (!ids.length && files.length) this.store.set({ note: 'Those don’t look like audio files.' });
    return ids;
  }

  /** A sampler sound, as a source (drum lanes use these). Reuses one already in the project. */
  addSound(soundId: string, select = false): string | null {
    const existing = this.s.project.sources.find((s) => s.origin.kind === 'sound' && s.origin.soundId === soundId);
    if (existing) return existing.id;
    const info = getSound(soundId);
    if (!info) return null;
    return this.addSource(
      {
        id: uid('s'),
        origin: { kind: 'sound', soundId },
        stem: null,
        name: info.name,
        duration: info.seconds ?? 0,
        bpm: null,
        gridOffset: 0,
        key: info.key ?? null,
        slices: [0],
        color: 0,
      },
      select,
    );
  }

  /** One part of a source (vocals, drums, bass, other), as a new source. */
  addStem(sourceId: string, stem: StemName): string | null {
    const src = this.source(sourceId);
    if (!src || src.origin.kind === 'sound') return null;
    if (src.origin.kind === 'track') {
      const rec = this.session.crate.get().tracks.find((t) => t.id === (src.origin as { trackId: string }).trackId);
      const policy = rec ? stemsPolicy(rec) : { allowed: false, reason: 'That track isn’t in your crate any more.' };
      if (!policy.allowed) {
        this.store.set({ note: policy.reason });
        return null;
      }
    }
    const existing = this.s.project.sources.find((s) => originKey(s) === originKey(src) && s.stem === stem);
    if (existing) {
      this.store.set({ sourceId: existing.id, slice: null });
      return existing.id;
    }
    const base = src.name.replace(/ \((Vocals|Drums|Bass|Other)\)$/, '');
    return this.addSource({
      ...src,
      id: uid('s'),
      stem,
      name: `${base} (${STEM_LABELS[stem]})`,
      slices: [...src.slices],
      color: this.nextColor(),
    });
  }

  removeSource(id: string) {
    this.edit((p) => ({ ...p, sources: p.sources.filter((s) => s.id !== id), clips: p.clips.filter((c) => c.sourceId !== id) }));
  }

  renameSource(id: string, name: string) {
    this.updateSource(id, { name: name.slice(0, 60) }, `name:${id}`);
  }

  updateSource(id: string, patch: Partial<Source>, merge?: string) {
    this.edit((p) => ({ ...p, sources: p.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) }), merge);
  }

  /** The source's tempo: re-times its synced clips. */
  setSourceBpm(id: string, bpm: number | null, gridOffset?: number) {
    const v = bpm === null ? null : Math.round(Math.min(MAX_BPM * 2, Math.max(MIN_BPM / 2, bpm)) * 100) / 100;
    this.updateSource(id, { bpm: v, ...(gridOffset !== undefined ? { gridOffset } : {}) }, `bpm:${id}`);
  }

  /** Song tempo from a source's (handy when the chop should play as recorded). */
  matchSongToSource(id: string) {
    const src = this.source(id);
    if (src?.bpm) this.setBpm(src.bpm);
  }

  selectSource(id: string | null) {
    this.store.set({ sourceId: id, slice: null });
  }

  /** Loads every source's audio that isn't loaded yet, one at a time. */
  private loadAll() {
    void (async () => {
      for (const src of this.s.project.sources) await this.load(src);
    })();
  }

  private load(src: Source): Promise<void> {
    if (this.buffers.has(src.id)) return Promise.resolve();
    const running = this.loading.get(src.id);
    if (running) return running;
    const job = this.read(src).finally(() => this.loading.delete(src.id));
    this.loading.set(src.id, job);
    return job;
  }

  /** Retry a source that couldn't be read (asks for file permission again). */
  retry(id: string) {
    const src = this.source(id);
    if (src) void this.load(src);
  }

  private async read(src: Source) {
    this.setAudio(src.id, { status: 'loading', progress: 0, message: null });
    let engine;
    try {
      engine = await this.session.ensureEngine();
    } catch {
      this.setAudio(src.id, { status: 'error', message: 'Audio couldn’t start in this browser.' });
      return;
    }
    const rate = engine.ctx.sampleRate;
    try {
      let buf: AudioBuffer | null;
      if (src.stem) buf = await this.stemBuffer(src, engine.ctx);
      else buf = await this.mixBuffer(src, rate);
      if (!buf) return;
      this.buffers.set(src.id, buf);
      this.reverses.delete(src.id);
      this.peakCache.delete(src.id);
      // First read: fill in what only the audio can tell, before calling the
      // audio ready, so nothing draws or slices it with a duration of 0.
      const cur = this.source(src.id);
      if (cur && (Math.abs(cur.duration - buf.duration) > 0.01 || (cur.bpm === null && cur.origin.kind !== 'sound'))) {
        let bpm = cur.bpm;
        let gridOffset = cur.gridOffset;
        if (bpm === null && cur.origin.kind !== 'sound') {
          const t = buf.duration >= 8 ? await detectTempo(buf).catch(() => null) : null;
          if (t) {
            bpm = t.bpm;
            gridOffset = t.offset;
          } else bpm = guessLoopBpm(buf.duration);
        }
        // Not an undo step: it's a fact about the audio, not an edit.
        const project = this.s.project;
        this.commit({ ...project, sources: project.sources.map((s) => (s.id === src.id ? { ...s, duration: buf.duration, bpm, gridOffset } : s)) });
      }
      this.setAudio(src.id, { status: 'ready', progress: 1, message: null });
      // A fresh sample arrives already chopped on its hits, so the pads play
      // straight away. Never touches slices someone placed.
      const now = this.source(src.id);
      if (now && now.chop === undefined && now.slices.length <= 1 && now.origin.kind !== 'sound' && buf.duration >= 0.25) {
        void this.autoChop(src.id, buf);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'missing') return;
      this.setAudio(src.id, {
        status: msg.startsWith('No access') ? 'missing' : 'error',
        message: msg.startsWith('No access') ? 'Platter needs permission to read this file again. Click retry.' : `“${src.name}” couldn’t be read.`,
      });
    }
  }

  private async blobOf(src: Source): Promise<Blob | null> {
    if (src.origin.kind !== 'file') return null;
    const blob = await getValue<Blob>(fileKey(src.origin.fileId));
    if (!blob) {
      this.setAudio(src.id, { status: 'missing', message: 'This file isn’t saved in this browser any more. Open it again.' });
      throw new Error('missing');
    }
    return blob;
  }

  private async mixBuffer(src: Source, rate: number): Promise<AudioBuffer | null> {
    const o = src.origin;
    if (o.kind === 'track') return this.session.decodeTrack(o.trackId, rate);
    if (o.kind === 'sound') {
      const buf = await this.session.sampler.buffer(o.soundId);
      if (!buf) throw new Error('sound');
      return buf;
    }
    const blob = await this.blobOf(src);
    const { decodeAudio } = await import('../engine/analysis');
    return decodeAudio(blob!, rate);
  }

  /** A part of the source: from stems saved on disk if there are some, else split here. */
  private async stemBuffer(src: Source, ctx: AudioContext): Promise<AudioBuffer | null> {
    const key = originKey(src);
    let job = this.stemSets.get(key);
    if (!job) {
      job = this.splitSource(src);
      this.stemSets.set(key, job);
      job.catch(() => this.stemSets.delete(key));
    }
    const set = await job;
    const n = set.mix.length;
    const out = ctx.createBuffer(2, n, STEM_RATE);
    const idx = { drums: 0, bass: 1, vocals: 2 } as Record<StemName, number>;
    for (let c = 0; c < 2; c++) {
      const d = new Float32Array(n);
      const pick = (s: StemPcm) => (c === 0 ? s.left : s.right);
      if (src.stem === 'other') {
        const mix = set.mix.getChannelData(Math.min(c, set.mix.numberOfChannels - 1));
        const [a, b, v] = set.stems.map(pick);
        for (let i = 0; i < n; i++) d[i] = mix[i] - ((a[i] ?? 0) + (b[i] ?? 0) + (v[i] ?? 0)) / 32768;
      } else {
        const s = pick(set.stems[idx[src.stem!]]);
        for (let i = 0; i < n && i < s.length; i++) d[i] = s[i] / 32768;
      }
      out.copyToChannel(d, c);
    }
    return out;
  }

  private async splitSource(src: Source): Promise<StemSet> {
    const o = src.origin;
    const mix = await this.mixBuffer({ ...src, stem: null }, STEM_RATE);
    if (!mix) throw new Error('No audio.');
    if (o.kind === 'track') {
      const saved = await this.session.presplit.load(o.trackId).catch(() => null);
      if (saved && saved.rate === STEM_RATE) return { stems: saved.stems, mix };
    }
    const forSources = () => this.s.project.sources.filter((s) => originKey(s) === originKey(src) && s.stem);
    const progress = (phase: string, p: number) => {
      const overall = phase === 'download' ? p * 0.3 : phase === 'prepare' ? 0.3 + p * 0.05 : 0.35 + p * 0.65;
      for (const s of forSources()) if (!this.buffers.has(s.id)) this.setAudio(s.id, { status: 'splitting', progress: overall });
    };
    progress('prepare', 0);
    const left = new Float32Array(mix.getChannelData(0));
    const right = new Float32Array(mix.numberOfChannels > 1 ? mix.getChannelData(1) : mix.getChannelData(0));
    const { stems } = await splitInWorker(left, right, progress).done;
    return { stems, mix };
  }

  /* ── Slices ───────────────────────────────────────────────────────────── */

  setSlices(id: string, points: number[], merge?: string) {
    const src = this.source(id);
    if (!src) return;
    this.updateSource(id, { slices: cleanSlices(points, src.duration), chop: null }, merge);
  }

  /** Adds a slice point at t seconds; returns the new slice's index. */
  addSlice(id: string, t: number): number {
    const src = this.source(id);
    if (!src) return 0;
    this.setSlices(id, [...src.slices, t]);
    const next = this.source(id)!;
    const i = next.slices.findIndex((x) => Math.abs(x - t) < 0.011);
    this.store.set({ slice: i >= 0 ? i : null });
    return i;
  }

  /** Drags slice point i (not the first) to t. */
  moveSlice(id: string, i: number, t: number) {
    const src = this.source(id);
    if (!src || i <= 0 || i >= src.slices.length) return;
    const lo = src.slices[i - 1] + 0.01;
    const hi = (src.slices[i + 1] ?? src.duration) - 0.01;
    const slices = [...src.slices];
    slices[i] = Math.max(lo, Math.min(hi, t));
    this.updateSource(id, { slices, chop: null }, `slice:${id}:${i}`);
  }

  /** Removes slice point i (merging slice i into the one before). */
  removeSlice(id: string, i: number) {
    const src = this.source(id);
    if (!src || i <= 0) return;
    this.updateSource(id, { slices: src.slices.filter((_, k) => k !== i), chop: null });
    this.store.set({ slice: Math.max(0, i - 1) });
  }

  clearSlices(id: string) {
    this.updateSource(id, { slices: [0], chop: null });
    this.store.set({ slice: null });
  }

  /** First chop of a newly loaded sample, aiming for a playable set of pads:
   *  a short sample on its hits (no closer than an eighth note), a long one
   *  in bars, and beats when the hits are too few (a pad, a held chord).
   *  Part of opening the sample, so not an undo step of its own. */
  private async autoChop(id: string, buf: AudioBuffer) {
    const src = this.source(id);
    if (!src) return;
    const bpm = src.bpm;
    this.adoptTempo(src);
    if (bpm && buf.duration > 30) {
      await this.autoSlice(id, { mode: 'grid', beats: 4 }, null);
      return;
    }
    const minGap = bpm ? Math.max(0.05, Math.min(0.3, 30 / bpm)) : 0.12;
    for (const sensitivity of [0.5, 0.3]) {
      await this.autoSlice(id, { mode: 'transients', sensitivity, minGap }, null);
      const n = this.source(id)?.slices.length ?? 0;
      if (n <= 32) break;
    }
    const now = this.source(id);
    if (now && now.chop?.mode === 'transients' && now.slices.length < 4 && bpm && buf.duration > 2) {
      await this.autoSlice(id, { mode: 'grid', beats: 1 }, null);
    }
  }

  /** The first sample into an empty song sets the song's tempo, so its
   *  slices play at the speed and pitch they were recorded (a song at 90 with
   *  a 123 BPM sample plays every slice a quarter slower and five semitones
   *  down). Part of opening the sample, not an undo step; the song tempo is
   *  one click to change afterwards. */
  private adoptTempo(src: Source) {
    const p = this.s.project;
    const bpm = src.bpm;
    if (!bpm || bpm < MIN_BPM || bpm > MAX_BPM || p.clips.length) return;
    const first = p.sources.find((s) => s.origin.kind !== 'sound');
    if (first?.id !== src.id) return;
    const v = Math.round(bpm * 100) / 100;
    if (Math.abs(p.bpm - v) < 0.005) return;
    this.commit({ ...p, bpm: v });
  }

  /** The latest auto-slice asked for, per source: a slower, older worker
   *  result never lands on top of a newer one. */
  private chopSeq = new Map<string, number>();

  /**
   * Slices a source automatically. Transients are found in a worker, so this
   * resolves once the slices are in. Called live from the editor's controls:
   * pass a merge key so a slider sweep is one undo step. merge null: not an
   * undo step (the first chop of a new sample is a fact about it, not an edit).
   */
  async autoSlice(id: string, mode: AutoSlice, merge: string | null = `chop:${id}`): Promise<void> {
    const src = this.source(id);
    const buf = this.buffers.get(id);
    if (!src) return;
    if (mode.mode === 'transients' && !buf) {
      this.store.set({ note: 'The audio is still loading.' });
      return;
    }
    if (mode.mode === 'grid' && !src.bpm) {
      this.store.set({ note: 'Set the sample’s BPM first to slice on the beat.' });
      return;
    }
    const seq = (this.chopSeq.get(id) ?? 0) + 1;
    this.chopSeq.set(id, seq);
    const duration = src.duration || buf?.duration || 0;
    let pts: number[];
    if (mode.mode === 'transients' && buf) {
      this.store.set({ busy: 'Finding the hits…', note: null });
      try {
        pts = [0, ...(await this.onsets(buf, mode.sensitivity, mode.minGap))];
      } catch {
        // No worker (or it failed): do it here, a short freeze beats nothing.
        pts = autoSlicePoints(mode, { duration, bpm: src.bpm, gridOffset: src.gridOffset }, buf);
      } finally {
        if (this.chopSeq.get(id) === seq) this.store.set({ busy: null });
      }
      // The source may have gone, or a newer chop been asked for, while the worker ran.
      if (!this.source(id) || this.chopSeq.get(id) !== seq) return;
    } else {
      pts = autoSlicePoints(mode, { duration, bpm: src.bpm, gridOffset: src.gridOffset }, buf);
    }
    const slices = cleanSlices(pts, duration);
    if (merge === null) {
      const p = this.s.project;
      this.commit({ ...p, sources: p.sources.map((s) => (s.id === id ? { ...s, slices, chop: mode } : s)) });
    } else this.updateSource(id, { slices, chop: mode }, merge);
    const keep = this.s.slice !== null && this.s.slice < slices.length ? this.s.slice : null;
    this.store.set({ slice: keep, note: null });
  }

  private onsetWorker: Worker | null = null;
  private onsetJobs = new Map<number, { resolve: (p: number[]) => void; reject: (e: Error) => void }>();
  private onsetSeq = 0;

  /** Which buffers the worker already holds (it keeps the last three). */
  private onsetKeys = new WeakMap<AudioBuffer, number>();
  private onsetKeySeq = 0;
  private onsetSent: number[] = [];

  private onsets(buf: AudioBuffer, sensitivity: number, minGap: number, resend = false): Promise<number[]> {
    if (typeof Worker === 'undefined') return Promise.reject(new Error('no worker'));
    if (!this.onsetWorker) {
      const w = new Worker(new URL('./onsets.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; points?: number[]; error?: string }>) => {
        const job = this.onsetJobs.get(e.data.id);
        this.onsetJobs.delete(e.data.id);
        if (e.data.points) job?.resolve(e.data.points);
        else job?.reject(new Error(e.data.error ?? 'failed'));
      };
      w.onerror = () => {
        for (const j of this.onsetJobs.values()) j.reject(new Error('worker failed'));
        this.onsetJobs.clear();
        this.onsetWorker?.terminate();
        this.onsetWorker = null;
        this.onsetSent = [];
      };
      this.onsetWorker = w;
      this.onsetSent = [];
    }
    let key = this.onsetKeys.get(buf);
    if (key === undefined) this.onsetKeys.set(buf, (key = ++this.onsetKeySeq));
    // Mix to mono here, once per track: half the data to copy, and the
    // detector mixes anyway. A slider sweep then sends only its settings.
    let mono: Float32Array | undefined;
    if (resend || !this.onsetSent.includes(key)) {
      mono = new Float32Array(buf.length);
      const g = 1 / buf.numberOfChannels;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < ch.length; i++) mono[i] += ch[i] * g;
      }
      this.onsetSent = [...this.onsetSent.filter((k) => k !== key), key].slice(-3);
    }
    const id = ++this.onsetSeq;
    const job = new Promise<number[]>((resolve, reject) => {
      this.onsetJobs.set(id, { resolve, reject });
      this.onsetWorker!.postMessage(
        { id, key, sampleRate: buf.sampleRate, mono, sensitivity, minGap, maxCount: MAX_HITS - 1 },
        mono ? [mono.buffer] : [],
      );
    });
    // The worker let go of it (it shouldn't): send it again, once.
    return resend ? job : job.catch((err: Error) => (err.message === 'resend' ? this.onsets(buf, sensitivity, minGap, true) : Promise.reject(err)));
  }

  selectSlice(i: number | null) {
    this.store.set({ slice: i });
  }

  /* ── Lanes ────────────────────────────────────────────────────────────── */

  addLane(kind: LaneKind, sound: string | null = null): string {
    const lane = kind === 'drum' && sound ? drumLaneFor(sound) : makeLane(kind, kind === 'audio' ? `Sample ${this.s.project.lanes.filter((l) => l.kind === 'audio').length + 1}` : 'Drums', sound);
    this.edit((p) => ({ ...p, lanes: [...p.lanes, lane] }));
    if (sound) this.addSound(sound);
    return lane.id;
  }

  updateLane(id: string, patch: Partial<Lane>, merge?: string) {
    this.edit((p) => ({ ...p, lanes: p.lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)) }), merge);
    if (patch.sound) this.addSound(patch.sound);
  }

  /** Changes a drum lane's sound, and every hit on it with it. */
  setLaneSound(id: string, soundId: string) {
    const srcId = this.addSound(soundId);
    if (!srcId) return;
    const src = this.source(srcId)!;
    this.edit((p) => ({
      ...p,
      lanes: p.lanes.map((l) => (l.id === id ? { ...l, sound: soundId, color: drumLaneFor(soundId).color } : l)),
      clips: p.clips.map((c) => (c.laneId === id && p.sources.find((s) => s.id === c.sourceId)?.origin.kind === 'sound' ? { ...c, sourceId: srcId, start: 0, end: src.duration || 1 } : c)),
    }));
  }

  removeLane(id: string) {
    this.edit((p) => (p.lanes.length <= 1 ? p : { ...p, lanes: p.lanes.filter((l) => l.id !== id), clips: p.clips.filter((c) => c.laneId !== id) }));
  }

  moveLane(id: string, dir: -1 | 1) {
    this.edit((p) => {
      const i = p.lanes.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.lanes.length) return p;
      const lanes = [...p.lanes];
      [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
      return { ...p, lanes };
    });
  }

  /* ── Clips ────────────────────────────────────────────────────────────── */

  /** Places [start, end) seconds of a source on a lane at `at` beats; returns the clip's id. */
  addClip(sourceId: string, laneId: string, at: number, start: number, end: number, patch: Partial<Clip> = {}): string | null {
    const src = this.source(sourceId);
    if (!src || end - start < 0.005) return null;
    const clip = { ...makeClip(src, laneId, Math.max(0, at), start, end), ...patch };
    this.edit((p) => ({ ...p, clips: [...p.clips, clip] }));
    this.store.set({ selection: [clip.id] });
    return clip.id;
  }

  /** Places slice i of a source. */
  addSliceClip(sourceId: string, slice: number, laneId: string, at: number): string | null {
    const src = this.source(sourceId);
    if (!src) return null;
    const [a, b] = sliceRange(src, slice);
    return this.addClip(sourceId, laneId, at, a, b);
  }

  /** A drum hit of the lane's sound at `at` beats (a click on a drum lane). */
  addHit(laneId: string, at: number): string | null {
    const lane = this.s.project.lanes.find((l) => l.id === laneId);
    if (!lane?.sound) return null;
    const srcId = this.addSound(lane.sound);
    const src = srcId ? this.source(srcId) : undefined;
    if (!src) return null;
    const end = src.duration || this.buffers.get(src.id)?.duration || getSound(lane.sound)?.seconds || 1;
    return this.addClip(src.id, laneId, at, 0, end);
  }

  /** The lane of the next free audio lane, or a new one. */
  laneForSource(): string {
    const audio = this.s.project.lanes.filter((l) => l.kind === 'audio');
    return audio[0]?.id ?? this.addLane('audio');
  }

  /** Appends a slice right after the last clip on a lane (keyboard: Enter on a slice). */
  appendSlice(sourceId: string, slice: number, laneId = this.laneForSource()) {
    const p = this.s.project;
    const src = new Map(p.sources.map((s) => [s.id, s]));
    const onLane = p.clips.filter((c) => c.laneId === laneId);
    const at = onLane.length ? Math.max(...onLane.map((c) => clipEnd(c, src.get(c.sourceId), p.bpm))) : 0;
    return this.addSliceClip(sourceId, slice, laneId, snapBeat(at, p.snap || 0.25, 'round'));
  }

  updateClip(id: string, patch: Partial<Clip>, merge?: string) {
    this.updateClips([{ id, patch }], merge);
  }

  updateClips(changes: { id: string; patch: Partial<Clip> }[], merge?: string) {
    const by = new Map(changes.map((c) => [c.id, c.patch]));
    this.edit((p) => ({ ...p, clips: p.clips.map((c) => (by.has(c.id) ? sanitize({ ...c, ...by.get(c.id)! }) : c)) }), merge);
  }

  deleteClips(ids = this.s.selection) {
    if (!ids.length) return;
    const gone = new Set(ids);
    this.edit((p) => ({ ...p, clips: p.clips.filter((c) => !gone.has(c.id)) }));
    this.store.set({ selection: [] });
  }

  /** Copies the clips right after themselves (as a block); selects the copies. */
  duplicateClips(ids = this.s.selection) {
    const p = this.s.project;
    const src = new Map(p.sources.map((s) => [s.id, s]));
    const sel = p.clips.filter((c) => ids.includes(c.id));
    if (!sel.length) return;
    const start = Math.min(...sel.map((c) => c.at));
    const end = Math.max(...sel.map((c) => clipEnd(c, src.get(c.sourceId), p.bpm)));
    const span = p.snap ? Math.max(p.snap, snapBeat(end - start, p.snap, 'round') || p.snap) : end - start;
    const copies = sel.map((c) => ({ ...c, id: uid('c'), at: c.at + span }));
    this.edit((q) => ({ ...q, clips: [...q.clips, ...copies] }));
    this.store.set({ selection: copies.map((c) => c.id) });
  }

  /** Cuts the selected clips (or every clip) under `beat` in two. */
  splitAt(beat = this.position(), ids?: string[]) {
    const p = this.s.project;
    const src = new Map(p.sources.map((s) => [s.id, s]));
    const pick = ids ?? (this.s.selection.length ? this.s.selection : p.clips.map((c) => c.id));
    const clips: Clip[] = [];
    let cut = 0;
    for (const c of p.clips) {
      const halves = pick.includes(c.id) ? splitClip(c, src.get(c.sourceId), p.bpm, beat) : null;
      if (halves) {
        clips.push(...halves);
        cut++;
      } else clips.push(c);
    }
    if (cut) this.edit((q) => ({ ...q, clips }));
  }

  /** Moves the selected clips onto the grid. */
  quantize(ids = this.s.selection) {
    const p = this.s.project;
    const snap = p.snap || 0.25;
    this.updateClips(ids.map((id) => ({ id, patch: { at: snapBeat(p.clips.find((c) => c.id === id)?.at ?? 0, snap) } })));
  }

  select(ids: string[]) {
    this.store.set({ selection: ids });
  }

  selectAll() {
    this.store.set({ selection: this.s.project.clips.map((c) => c.id) });
  }

  clipBeats(c: Clip) {
    return clipBeats(c, this.source(c.sourceId), this.s.project.bpm);
  }

  /* ── Transport ────────────────────────────────────────────────────────── */

  private async ensurePlayer(): Promise<SlicerPlayer | null> {
    if (this.player) return this.player;
    try {
      const engine = await this.session.ensureEngine();
      engine.resume();
      if (!this.player) {
        this.player = new SlicerPlayer(engine.ctx, engine.bus, this, () => engine.now());
        this.player.setLevel(this.s.project.level);
        this.player.metronome = this.s.metronome;
      }
      return this.player;
    } catch {
      this.store.set({ note: 'Audio couldn’t start in this browser.' });
      return null;
    }
  }

  async play(from = this.s.cursor) {
    const player = await this.ensurePlayer();
    if (!player) return;
    this.stopAudition();
    const p = this.s.project;
    const start = p.loop.on && (from < p.loop.start || from >= p.loop.end) ? p.loop.start : from;
    player.play(p, start);
    this.store.set({ playing: true });
  }

  /** Stops; the cursor stays where play started (a second stop goes back to the start). */
  stop() {
    if (!this.player?.playing) {
      if (this.s.playing || this.s.recording) this.store.set({ playing: false, recording: false });
      return;
    }
    this.player.stop();
    if (this.s.recording) this.endGesture();
    this.store.set({ playing: false, recording: false });
  }

  toggle() {
    if (this.s.playing) this.stop();
    else void this.play();
  }

  /** Moves the cursor (and the playhead, while playing). */
  seek(beat: number) {
    const b = Math.max(0, beat);
    this.store.set({ cursor: b });
    if (this.s.playing) this.player?.seek(b);
  }

  /** The playhead in beats (live while playing). */
  position(): number {
    return this.s.playing && this.player ? this.player.position() : this.s.cursor;
  }

  setMetronome(on: boolean) {
    this.store.set({ metronome: on });
    if (this.player) this.player.metronome = on;
  }

  /* ── Auditioning ──────────────────────────────────────────────────────── */

  /** Plays [start, end) of a source on its own (a slice, a selection). */
  async audition(sourceId: string, start: number, end: number, opts: { loop?: boolean; reverse?: boolean; semitones?: number } = {}) {
    const buf = this.buffers.get(sourceId);
    if (!buf) return;
    const engine = await this.session.ensureEngine().catch(() => null);
    if (!engine) return;
    engine.resume();
    this.stopAudition();
    if (!this.auditionOut) {
      this.auditionOut = engine.ctx.createGain();
      this.auditionOut.connect(engine.bus);
    }
    const ctx = engine.ctx;
    const reverse = !!opts.reverse;
    const play = reverse ? this.reversed(sourceId) : buf;
    if (!play) return;
    const a = reverse ? buf.duration - end : start;
    const b = reverse ? buf.duration - start : end;
    const node = ctx.createBufferSource();
    node.buffer = play;
    const rate = 2 ** ((opts.semitones ?? 0) / 12);
    node.playbackRate.value = rate;
    const gain = ctx.createGain();
    const when = ctx.currentTime + 0.01;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + 0.003);
    node.connect(gain).connect(this.auditionOut);
    if (opts.loop) {
      node.loop = true;
      node.loopStart = a;
      node.loopEnd = b;
      node.start(when, a);
    } else node.start(when, a, b - a);
    this.auditionNode = { src: node, gain };
    const latency = engine.now() - ctx.currentTime;
    this.store.set({ audition: { sourceId, start, end, startedAt: when + latency, rate, loop: !!opts.loop, reverse } });
    node.onended = () => {
      if (this.auditionNode?.src !== node) return;
      this.auditionNode = null;
      gain.disconnect();
      this.store.set({ audition: null });
    };
  }

  auditionSlice(sourceId: string, i: number, opts: { loop?: boolean } = {}) {
    const src = this.source(sourceId);
    if (!src) return;
    const [a, b] = sliceRange(src, i);
    this.store.set({ slice: i });
    if (this.s.recording && this.s.playing && !opts.loop) this.recordHit(src, a, b);
    void this.audition(sourceId, a, b, opts);
  }

  /* ── Recording pads into the timeline ─────────────────────────────────── */

  private take = 0;

  /** Arms recording: pads played while the song runs land on the record lane.
   *  Turning it on starts the song; one take is one undo step. */
  setRecording(on: boolean) {
    if (on === this.s.recording) return;
    this.endGesture();
    if (on) {
      this.take++;
      this.store.set({ recording: true, note: null });
      if (!this.s.playing) void this.play();
    } else this.store.set({ recording: false });
  }

  setRecordLane(id: string | null) {
    this.store.set({ recordLane: id });
  }

  /** Places a slice where the playhead is, like a sampler's mono choke: the
   *  take's previous hit on that lane is cut where this one starts. */
  private recordHit(src: Source, a: number, b: number) {
    const p = this.s.project;
    const lane = p.lanes.some((l) => l.id === this.s.recordLane && l.kind === 'audio') ? this.s.recordLane! : this.laneForSource();
    const raw = this.position();
    const at = Math.max(0, p.snap ? snapBeat(raw, p.snap, 'round') : raw);
    const key = `rec:${this.take}`;
    const clip = makeClip(src, lane, at, a, b);
    const byId = new Map(this.s.project.sources.map((s) => [s.id, s]));
    this.edit((q) => {
      const clips = q.clips
        // A hit on the same spot replaces what this take put there.
        .filter((c) => !(c.laneId === lane && Math.abs(c.at - at) < 1e-6 && this.takeClips.has(c.id)))
        .map((c) => {
          if (c.laneId !== lane || !this.takeClips.has(c.id) || c.at >= at) return c;
          const s = byId.get(c.sourceId);
          const end = clipEnd(c, s, q.bpm);
          if (end <= at) return c;
          // Trim c so it ends at `at`: source seconds = beats → seconds × rate.
          const keepBeats = at - c.at;
          const rate = clipRate(c, s, q.bpm);
          const newEnd = c.start + keepBeats * (60 / q.bpm) * rate;
          return newEnd - c.start < 0.005 ? c : { ...c, end: newEnd };
        });
      return { ...q, clips: [...clips, clip] };
    }, key);
    this.takeClips.add(clip.id);
    if (this.takeClips.size > 4000) this.takeClips.clear();
  }
  /** Clips recorded in this session's takes (only these get choked). */
  private takeClips = new Set<string>();

  /* ── Laying slices out ────────────────────────────────────────────────── */

  /**
   * Puts every slice of a source on a lane where it sits in the original
   * (with the source's tempo known, at its own groove; otherwise back to
   * back), starting at beat `from`. The starting point for a flip.
   */
  layoutSlices(sourceId: string, laneId = this.laneForSource(), from = this.s.cursor) {
    const src = this.source(sourceId);
    if (!src || !src.duration) return;
    const p = this.s.project;
    const at0 = p.snap ? snapBeat(from, p.snap, 'round') : from;
    const clips: Clip[] = [];
    let cursor = at0;
    for (let i = 0; i < src.slices.length; i++) {
      const [a, b] = sliceRange(src, i);
      if (b - a < 0.005) continue;
      const c = makeClip(src, laneId, 0, a, b);
      c.at = src.bpm && c.sync ? at0 + (a * src.bpm) / 60 : cursor;
      cursor = c.at + clipBeats(c, src, p.bpm);
      clips.push(c);
    }
    if (!clips.length) return;
    this.edit((q) => ({ ...q, clips: [...q.clips, ...clips] }));
    this.store.set({ selection: clips.map((c) => c.id), note: `Laid out ${clips.length} slices.` });
  }

  /** Where the audition is in its source (seconds), for the editor's playhead; null when silent. */
  auditionPosition(): { sourceId: string; time: number } | null {
    const a = this.s.audition;
    const engine = this.session.engine;
    if (!a || !engine) return null;
    const elapsed = Math.max(0, (engine.now() - a.startedAt) * a.rate);
    const len = a.end - a.start;
    const into = a.loop ? elapsed % len : Math.min(elapsed, len);
    return { sourceId: a.sourceId, time: a.reverse ? a.end - into : a.start + into };
  }

  stopAudition() {
    const n = this.auditionNode;
    this.auditionNode = null;
    if (n && this.session.engine) {
      const t = this.session.engine.ctx.currentTime;
      n.gain.gain.setTargetAtTime(0, t, 0.005);
      try {
        n.src.stop(t + 0.04);
      } catch {
        /* not started */
      }
    }
    if (this.s.audition) this.store.set({ audition: null });
  }

  /* ── Exporting ────────────────────────────────────────────────────────── */

  private wavName(base: string) {
    return `${base.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Platter'}.wav`;
  }

  private async renderRange(range: 'song' | 'loop'): Promise<AudioBuffer | null> {
    const p = this.s.project;
    for (const src of p.sources) await this.load(src);
    const missing = p.clips.filter((c) => !this.buffers.has(c.sourceId));
    if (missing.length) this.store.set({ note: `${missing.length} clip${missing.length === 1 ? '' : 's'} had no audio and were left out.` });
    const [from, to] = range === 'loop' && p.loop.end > p.loop.start ? [p.loop.start, p.loop.end] : [0, songBeats(p)];
    const rate = this.session.engine?.ctx.sampleRate ?? 48000;
    return render(p, this, from, to, rate, range === 'loop' ? 0 : 1.5);
  }

  /** Renders the song (or the loop, cut to loop seamlessly) to a WAV and saves it. */
  async exportWav(range: 'song' | 'loop' = 'song', bitDepth: 16 | 24 = 24) {
    if (this.s.busy) return;
    this.store.set({ busy: 'Rendering…', note: null });
    try {
      const buf = await this.renderRange(range);
      if (!buf) return;
      const chans = [buf.getChannelData(0), buf.getChannelData(1)];
      const blob = new Blob([encodeWav(chans, buf.sampleRate, bitDepth)], { type: 'audio/wav' });
      const name = this.wavName(`${this.s.project.name}${range === 'loop' ? ' (loop)' : ''}`);
      const url = URL.createObjectURL(blob);
      const note = await saveFile(name, blob, url);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      this.store.set({ note: note ?? `Saved ${name}.` });
    } catch {
      this.store.set({ note: 'The render didn’t finish. Try again.' });
    } finally {
      this.store.set({ busy: null });
    }
  }

  /** [start, end) of a source as a WAV file. */
  sliceFile(sourceId: string, start: number, end: number, opts: { reverse?: boolean; name?: string } = {}): File | null {
    const buf = this.buffers.get(sourceId);
    const src = this.source(sourceId);
    if (!buf || !src) return null;
    const chans = extractChannels(buf, start, end, { reverse: opts.reverse });
    const name = this.wavName(opts.name ?? `${src.name} ${start.toFixed(2)}s`);
    return new File([encodeWav(chans, buf.sampleRate, 24)], name, { type: 'audio/wav' });
  }

  /** Saves a slice as a WAV. */
  async saveSlice(sourceId: string, i: number) {
    const src = this.source(sourceId);
    if (!src) return;
    const [a, b] = sliceRange(src, i);
    const file = this.sliceFile(sourceId, a, b, { name: `${src.name} slice ${i + 1}` });
    if (!file) return;
    const url = URL.createObjectURL(file);
    const note = await saveFile(file.name, file, url);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    this.store.set({ note: note ?? `Saved ${file.name}.` });
  }

  /**
   * Puts slices on sampler pads: the selected pad first, then the pads after
   * it (in the bank on screen). They also join "Your sounds" in the library.
   */
  async sendToPads(sourceId: string, slices: number[]) {
    const src = this.source(sourceId);
    if (!src || !slices.length) return;
    const sampler = this.session.sampler;
    const files = slices.map((i) => {
      const [a, b] = sliceRange(src, i);
      return this.sliceFile(sourceId, a, b, { name: `${src.name} ${i + 1}` });
    });
    const ids = await sampler.importFiles(files.filter((f): f is File => !!f));
    const first = sampler.store.get().selected;
    const bankEnd = (Math.floor(first / 16) + 1) * 16;
    ids.forEach((id, k) => {
      if (first + k < bankEnd) sampler.assign(first + k, id);
    });
    const placed = Math.min(ids.length, bankEnd - first);
    this.store.set({
      note: `${ids.length === 1 ? 'Slice' : `${ids.length} slices`} on ${placed === 1 ? `pad ${(first % 16) + 1}` : `pads ${(first % 16) + 1}–${(first % 16) + placed}`} of bank ${'ABCD'[Math.floor(first / 16)]}${ids.length > placed ? `; the rest are in Your sounds` : ''}.`,
    });
  }

  /** Renders the song (or loop) and adds it to the crate, ready for a deck. */
  async sendToCrate(range: 'song' | 'loop' = 'song') {
    if (this.s.busy) return;
    this.store.set({ busy: 'Rendering…', note: null });
    try {
      const buf = await this.renderRange(range);
      if (!buf) return;
      const chans = [buf.getChannelData(0), buf.getChannelData(1)];
      const name = this.wavName(`${this.s.project.name}${range === 'loop' ? ' (loop)' : ''}`);
      const file = new File([encodeWav(chans, buf.sampleRate, 24)], name, { type: 'audio/wav' });
      await this.session.addFiles([file]);
      this.store.set({ note: `Added “${name.replace(/\.wav$/, '')}” to your crate. Load it on a deck from the track list.` });
    } catch {
      this.store.set({ note: 'The render didn’t finish. Try again.' });
    } finally {
      this.store.set({ busy: null });
    }
  }

  clearNote() {
    this.store.set({ note: null });
  }

  dispose() {
    this.stop();
    this.stopAudition();
    this.player?.dispose();
    this.player = null;
    this.onsetWorker?.terminate();
    this.onsetWorker = null;
    this.save(true);
  }
}

function sanitize(c: Clip): Clip {
  const start = Math.max(0, c.start);
  return {
    ...c,
    at: Math.max(0, c.at),
    start,
    end: Math.max(start + 0.005, c.end),
    gain: Math.max(0, Math.min(2, c.gain)),
    semitones: Math.max(-24, Math.min(24, c.semitones)),
    fadeIn: Math.max(0, c.fadeIn),
    fadeOut: Math.max(0, c.fadeOut),
  };
}
