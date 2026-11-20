import { decodeAudio } from './analysis';
import { getValue, loadSamples, removeSample, saveSample, setValue } from './library';
import { createStore, type Store } from './store';
import { getSound, guessCategory, registerUserSound, unregisterUserSound, LIBRARY, type Category, type SoundInfo } from './sounds/catalog';
import type { Role } from './sounds/characters';
import { DEFAULT_BANK_KITS, getKit } from './sounds/kits';

/**
 * The sampler: four banks of sixteen pads into the master bus, drawing on the
 * sound library (sounds/catalog.ts). A pad holds a sound plus its own level,
 * tuning and choke group. Sounds are rendered or fetched the first time
 * they're needed and kept in a small cache, so the library can be huge while
 * the page stays light. The beat board plays the same pads, scheduled ahead
 * on the audio clock.
 */

export const BANKS = 4;
export const PADS_PER_BANK = 16;
export const PAD_COUNT = BANKS * PADS_PER_BANK;
export const BANK_NAMES = ['A', 'B', 'C', 'D'];
/** Choke groups 1–4; 0 = none. A pad stops the others in its group. */
export const CHOKE_GROUPS = 4;

/** Pads a MIDI controller can learn: 1–16 of the bank on screen. */
export const PADS = 16;

export interface PadState {
  sound: string | null;
  /** 0–1.5, 1 = as recorded. */
  gain: number;
  /** Semitones, −24 … +24. */
  tune: number;
  choke: number;
  /** What it plays in a kit, so grooves find the kick on any kit. */
  role: Role | null;
}

export interface SamplerState {
  pads: PadState[];
  /** The bank on screen. */
  bank: number;
  /** The pad the inspector shows (0 … 63). */
  selected: number;
  /** The kit each bank was loaded from, if any. */
  bankKits: (string | null)[];
  /** 0–1, 0.8 = 0 dB. */
  level: number;
  favorites: string[];
  /** Bumps when your own sounds change, so lists re-read the library. */
  userVersion: number;
  /** The sound being auditioned in the browser. */
  preview: string | null;
  /** Sounds that are loading, by id. */
  loading: string[];
}

export interface Hit {
  pad: number;
  /** Context time it sounds. */
  when: number;
  velocity: number;
  /** Who fired it: a hand on a pad, or the beat board. */
  from: 'live' | 'board';
}

interface Saved {
  v: 2;
  pads: PadState[];
  bank: number;
  bankKits: (string | null)[];
  level: number;
  favorites: string[];
}

/** Up to ~3 minutes of decoded audio stays cached; pads' own sounds always do. */
const CACHE_FRAMES = 48000 * 180;

const emptyPad = (): PadState => ({ sound: null, gain: 1, tune: 0, choke: 0, role: null });

function kitPads(kitId: string): PadState[] {
  const kit = getKit(kitId);
  return Array.from({ length: PADS_PER_BANK }, (_, i) => {
    const p = kit?.pads[i];
    if (!p) return emptyPad();
    return { sound: p.sound, gain: 1, tune: 0, choke: p.role === 'chh' || p.role === 'ohh' ? 1 : 0, role: p.role === 'fx' ? null : p.role };
  });
}

function defaultState(): Pick<SamplerState, 'pads' | 'bankKits'> {
  return {
    pads: DEFAULT_BANK_KITS.flatMap((k) => kitPads(k)),
    bankKits: [...DEFAULT_BANK_KITS],
  };
}

/** Skips the near-silence MP3 encoders and recorders leave at the start, so a
 *  sample hits on the beat. Synth sounds start on their first sample already. */
function trimStart(buf: AudioBuffer, ctx: BaseAudioContext): AudioBuffer {
  const data = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const max = Math.min(buf.length, Math.round(buf.sampleRate * 0.08));
  let first = 0;
  while (first < max && data.every((d) => Math.abs(d[first]) < 0.004)) first++;
  first = Math.max(0, first - Math.round(buf.sampleRate * 0.001));
  if (first < 8 || first >= buf.length) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length - first, buf.sampleRate);
  data.forEach((d, c) => out.copyToChannel(d.subarray(first) as Float32Array<ArrayBuffer>, c));
  return out;
}

const newUserId = () => `user:u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The record id a sound of yours is stored under (older pads used "0" … "7"). */
const recordId = (id: string) => (/^user:\d+$/.test(id) ? id.slice(5) : id);

export class Sampler {
  readonly store: Store<SamplerState> = createStore<SamplerState>({
    ...defaultState(),
    bank: 0,
    selected: 0,
    level: 0.7,
    favorites: [],
    userVersion: 0,
    preview: null,
    loading: [],
  });
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private previewOut: GainNode | null = null;
  private cue: AudioNode | null = null;
  private bus: AudioNode | null = null;
  /** Decoded sounds by id, least recently used first. */
  private cache = new Map<string, Promise<AudioBuffer | null>>();
  private frames = new Map<string, number>();
  private blobs = new Map<string, Blob>();
  private voices: { pad: number; src: AudioBufferSourceNode; gain: GainNode; choke: number }[] = [];
  private previewing: AudioBufferSourceNode | null = null;
  private hitFns = new Set<(h: Hit) => void>();
  private saveTimer = 0;
  private ready = false;
  /** Sends auditions to the headphones when there are headphones. */
  previewToCue: () => boolean = () => false;

  /** Restores the layout and your own sounds saved in this browser. */
  async init() {
    const [saved, records] = await Promise.all([getValue<Saved>('sampler-v2'), loadSamples()]);
    const legacy: { pad: number; id: string }[] = [];
    for (const rec of records) {
      const legacyPad = /^\d+$/.test(rec.id) ? Number(rec.id) : null;
      const id = rec.id.startsWith('user:') ? rec.id : `user:${rec.id}`;
      this.blobs.set(id, rec.blob);
      registerUserSound({ id, name: rec.name, category: (rec.category as Category | undefined) ?? guessCategory(rec.name) });
      if (legacyPad !== null && legacyPad < 8) legacy.push({ pad: legacyPad, id });
    }
    const patch: Partial<SamplerState> = { userVersion: this.store.get().userVersion + 1 };
    if (saved && saved.v === 2 && saved.pads?.length === PAD_COUNT) {
      patch.pads = saved.pads.map((p) => ({ ...emptyPad(), ...p }));
      patch.bank = Math.min(BANKS - 1, Math.max(0, saved.bank | 0));
      patch.selected = patch.bank * PADS_PER_BANK;
      patch.bankKits = saved.bankKits ?? defaultState().bankKits;
      patch.favorites = saved.favorites ?? [];
    } else if (legacy.length) {
      // Sounds dropped on the old eight pads stay where they were.
      const pads = [...this.store.get().pads];
      for (const l of legacy) pads[l.pad] = { ...pads[l.pad], sound: l.id, role: null };
      patch.pads = pads;
      patch.bankKits = [null, ...this.store.get().bankKits.slice(1)];
    }
    this.store.set(patch);
    if (saved?.v === 2 && typeof saved.level === 'number') this.setLevel(saved.level);
    this.ready = true;
    this.store.subscribe(() => this.scheduleSave());
  }

  private scheduleSave() {
    if (!this.ready) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const s = this.store.get();
      const saved: Saved = { v: 2, pads: s.pads, bank: s.bank, bankKits: s.bankKits, level: s.level, favorites: s.favorites };
      void setValue('sampler-v2', saved);
    }, 500);
  }

  attach(ctx: AudioContext, bus: AudioNode, cue?: AudioNode) {
    this.ctx = ctx;
    this.bus = bus;
    this.cue = cue ?? null;
    this.out = ctx.createGain();
    this.out.connect(bus);
    this.previewOut = ctx.createGain();
    this.previewOut.gain.value = 0.8;
    this.cache.clear();
    this.frames.clear();
    this.setLevel(this.store.get().level);
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  setLevel(level: number) {
    this.store.set({ level });
    if (this.out && this.ctx) this.out.gain.setTargetAtTime((level / 0.8) ** 2, this.ctx.currentTime, 0.015);
  }

  /* ── Sounds ───────────────────────────────────────────────────────────── */

  /** The library entry on a pad, if any. */
  padSound(i: number): SoundInfo | undefined {
    const id = this.store.get().pads[i]?.sound;
    return id ? getSound(id) : undefined;
  }

  private pinned(): Set<string> {
    return new Set(this.store.get().pads.map((p) => p.sound).filter((s): s is string => !!s));
  }

  private setLoading(id: string, on: boolean) {
    const loading = this.store.get().loading.filter((x) => x !== id);
    if (on) loading.push(id);
    this.store.set({ loading });
  }

  /** Decoded audio for a sound: rendered, fetched or read from this browser. */
  buffer(id: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(null);
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    const info = getSound(id);
    if (!info) return Promise.resolve(null);
    const job = (async (): Promise<AudioBuffer | null> => {
      if (info.render) {
        const [L, R] = info.render(ctx.sampleRate);
        const buf = ctx.createBuffer(2, L.length, ctx.sampleRate);
        buf.copyToChannel(L as Float32Array<ArrayBuffer>, 0);
        buf.copyToChannel(R as Float32Array<ArrayBuffer>, 1);
        return buf;
      }
      this.setLoading(id, true);
      try {
        let blob: Blob | undefined;
        if (info.file) {
          const res = await fetch(new URL(`sounds/cc0/${info.file}.mp3`, document.baseURI).href);
          if (!res.ok) throw new Error(`${res.status}`);
          blob = await res.blob();
        } else blob = this.blobs.get(id);
        if (!blob) return null;
        return trimStart(await decodeAudio(blob, ctx.sampleRate), ctx);
      } finally {
        this.setLoading(id, false);
      }
    })().catch(() => null);
    this.cache.set(id, job);
    void job.then((buf) => {
      if (!buf) {
        this.cache.delete(id);
        return;
      }
      this.frames.set(id, buf.length * buf.numberOfChannels * 0.5);
      this.evict();
    });
    return job;
  }

  private evict() {
    let total = 0;
    this.frames.forEach((f) => (total += f));
    if (total <= CACHE_FRAMES) return;
    const keep = this.pinned();
    for (const id of [...this.cache.keys()]) {
      if (total <= CACHE_FRAMES) break;
      if (keep.has(id) || id === this.store.get().preview) continue;
      total -= this.frames.get(id) ?? 0;
      this.cache.delete(id);
      this.frames.delete(id);
    }
  }

  /** Gets a bank's sounds ready ahead of the first hit. */
  warm(bank = this.store.get().bank) {
    if (!this.ctx) return;
    const pads = this.store.get().pads.slice(bank * PADS_PER_BANK, (bank + 1) * PADS_PER_BANK);
    let delay = 0;
    for (const p of pads) {
      if (!p.sound) continue;
      const id = p.sound;
      // Spread the synth renders out so the page never stutters.
      window.setTimeout(() => void this.buffer(id), (delay += 12));
    }
  }

  /* ── Playing ──────────────────────────────────────────────────────────── */

  onHit(fn: (h: Hit) => void) {
    this.hitFns.add(fn);
    return () => {
      this.hitFns.delete(fn);
    };
  }

  /** Plays pad `i` now, or at context time `when` (the beat board schedules ahead). */
  async hit(i: number, opts: { when?: number; velocity?: number; from?: Hit['from']; gain?: number } = {}) {
    const pad = this.store.get().pads[i];
    if (!pad?.sound || !this.ctx || !this.out) return;
    const buf = await this.buffer(pad.sound);
    const ctx = this.ctx;
    if (!buf || !this.out) return;
    const when = Math.max(ctx.currentTime, opts.when ?? ctx.currentTime);
    const velocity = opts.velocity ?? 1;
    if (pad.choke) this.choke(pad.choke, i, when);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 2 ** (pad.tune / 12);
    const gain = ctx.createGain();
    gain.gain.value = pad.gain * velocity * (opts.gain ?? 1);
    src.connect(gain).connect(this.out);
    src.start(when);
    const voice = { pad: i, src, gain, choke: pad.choke };
    this.voices.push(voice);
    src.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
      gain.disconnect();
    };
    const h: Hit = { pad: i, when, velocity, from: opts.from ?? 'live' };
    this.hitFns.forEach((fn) => fn(h));
  }

  private choke(group: number, except: number, when: number) {
    for (const v of this.voices) {
      if (v.choke !== group || v.pad === except) continue;
      v.gain.gain.setTargetAtTime(0, when, 0.008);
      try {
        v.src.stop(when + 0.06);
      } catch {
        /* already stopped */
      }
    }
  }

  /** Auditions a library sound (in the headphones, when they're set up). */
  async preview(id: string) {
    this.stopPreview();
    this.store.set({ preview: id });
    const buf = await this.buffer(id);
    const ctx = this.ctx;
    if (!buf || !ctx || !this.previewOut || this.store.get().preview !== id) return;
    this.previewOut.disconnect();
    this.previewOut.connect(this.previewToCue() && this.cue ? this.cue : (this.bus ?? ctx.destination));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.previewOut);
    src.start();
    this.previewing = src;
    src.onended = () => {
      if (this.previewing !== src) return;
      this.previewing = null;
      if (this.store.get().preview === id) this.store.set({ preview: null });
    };
  }

  stopPreview() {
    const p = this.previewing;
    this.previewing = null;
    try {
      p?.stop();
    } catch {
      /* not started */
    }
    if (this.store.get().preview) this.store.set({ preview: null });
  }

  /* ── Editing pads ─────────────────────────────────────────────────────── */

  setBank(bank: number) {
    const b = Math.max(0, Math.min(BANKS - 1, bank));
    const sel = this.store.get().selected % PADS_PER_BANK;
    this.store.set({ bank: b, selected: b * PADS_PER_BANK + sel });
    this.warm(b);
  }

  select(i: number) {
    this.store.set({ selected: i });
  }

  setPad(i: number, patch: Partial<PadState>) {
    const pads = [...this.store.get().pads];
    pads[i] = { ...pads[i], ...patch };
    const bankKits = [...this.store.get().bankKits];
    if (patch.sound !== undefined) bankKits[Math.floor(i / PADS_PER_BANK)] = null;
    this.store.set({ pads, bankKits });
  }

  /** Puts a library sound on a pad. */
  assign(i: number, id: string) {
    const info = getSound(id);
    if (!info) return;
    const roleByCat: Partial<Record<Category, Role>> = { kick: 'kick', snare: 'snare', clap: 'clap', tom: 'tomM', bass: 'bass', stab: 'stab' };
    this.setPad(i, { sound: id, role: roleByCat[info.category] ?? null, tune: 0 });
    void this.buffer(id);
  }

  clearPad(i: number) {
    this.setPad(i, emptyPad());
  }

  /** Swaps two pads (drag one onto another). */
  movePad(from: number, to: number) {
    if (from === to) return;
    const pads = [...this.store.get().pads];
    [pads[from], pads[to]] = [pads[to], pads[from]];
    const bankKits = [...this.store.get().bankKits];
    bankKits[Math.floor(from / PADS_PER_BANK)] = null;
    bankKits[Math.floor(to / PADS_PER_BANK)] = null;
    this.store.set({ pads, bankKits });
  }

  loadKit(bank: number, kitId: string) {
    const pads = [...this.store.get().pads];
    pads.splice(bank * PADS_PER_BANK, PADS_PER_BANK, ...kitPads(kitId));
    const bankKits = [...this.store.get().bankKits];
    bankKits[bank] = kitId;
    this.store.set({ pads, bankKits });
    this.warm(bank);
  }

  toggleFavorite(id: string) {
    const fav = this.store.get().favorites;
    this.store.set({ favorites: fav.includes(id) ? fav.filter((f) => f !== id) : [...fav, id] });
  }

  /* ── Your own sounds ──────────────────────────────────────────────────── */

  /** Adds audio files to the library (kept in this browser); returns their ids. */
  async importFiles(files: File[]): Promise<string[]> {
    const ids: string[] = [];
    for (const file of files) {
      if (!file.type.startsWith('audio/') && !/\.(wav|mp3|aiff?|flac|ogg|opus|m4a|aac|webm)$/i.test(file.name)) continue;
      const id = newUserId();
      const name = file.name.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 40);
      const category = guessCategory(file.name);
      this.blobs.set(id, file);
      registerUserSound({ id, name, category });
      await saveSample({ id, name, blob: file, category });
      ids.push(id);
    }
    if (ids.length) this.store.set({ userVersion: this.store.get().userVersion + 1 });
    return ids;
  }

  /** Puts a file straight on a pad (drop a file on it). */
  async setCustom(i: number, file: File) {
    const [id] = await this.importFiles([file]);
    if (id) this.assign(i, id);
  }

  async deleteUserSound(id: string) {
    unregisterUserSound(id);
    this.blobs.delete(id);
    this.cache.delete(id);
    this.frames.delete(id);
    const pads = this.store.get().pads.map((p) => (p.sound === id ? emptyPad() : p));
    this.store.set({ pads, userVersion: this.store.get().userVersion + 1, favorites: this.store.get().favorites.filter((f) => f !== id) });
    await removeSample(recordId(id));
  }

  /** How many sounds there are, yours included. */
  count() {
    return LIBRARY.length;
  }

  /** Stops everything that is sounding. */
  silence() {
    for (const v of this.voices) {
      try {
        v.src.stop();
      } catch {
        /* not started */
      }
    }
    this.voices = [];
    this.stopPreview();
  }
}
