import type { DjEngine, ListenSource } from './engine';
import { getValue, setValue } from './library';
import type { DjSession } from './session';
import { createStore, type Store } from './store';

export type { ListenSource };

/**
 * Listen to: what the main output plays when it's the only output — the
 * master, or the headphone side (deck A's cue, deck B's cue, or the cue mix
 * blended with the master) — and the main output's own volume. Neither
 * touches the master level, the master meters or a recording: the choice and
 * the volume sit after the recorder's tap (engine.ts).
 *
 * It builds on the cue routing rather than beside it: with the headphones
 * on Split or their own device, the main output plays the master as before
 * and only the volume applies.
 *
 * Saved under its own key, so a save from before it existed just starts on
 * the master at 0 dB.
 */
export interface ListenState {
  source: ListenSource;
  /** 0–1, 0.8 = 0 dB, the same taper as the master and headphone levels. */
  level: number;
}

export const LISTEN_SOURCES: { id: ListenSource; label: string; hint: string }[] = [
  { id: 'master', label: 'Master', hint: 'The mix the audience hears and the recorder takes.' },
  { id: 'cueA', label: 'Deck A cue', hint: 'Deck A alone, before its fader.' },
  { id: 'cueB', label: 'Deck B cue', hint: 'Deck B alone, before its fader.' },
  { id: 'blend', label: 'Cue / master blend', hint: 'The headphone mix: the cued channels blended with the master by the Cue mix knob.' },
];

const KEY = 'listen';
const isSource = (v: unknown): v is ListenSource => LISTEN_SOURCES.some((s) => s.id === v);

/** Reads a saved value, keeping only what's valid. */
export function readListen(saved: unknown): ListenState {
  const out: ListenState = { source: 'master', level: 0.8 };
  if (!saved || typeof saved !== 'object') return out;
  const s = saved as Partial<Record<keyof ListenState, unknown>>;
  if (isSource(s.source)) out.source = s.source;
  if (typeof s.level === 'number' && Number.isFinite(s.level)) out.level = Math.max(0, Math.min(1, s.level));
  return out;
}

export class Listening {
  readonly store: Store<ListenState> = createStore<ListenState>(readListen(null));
  private saveTimer: number | null = null;
  private unsub: (() => void) | null = null;
  private restored = false;

  constructor(private session: DjSession) {}

  async init() {
    const saved = await getValue<unknown>(KEY).catch(() => null);
    // A choice made before the save was read wins over the save.
    if (!this.restored) this.store.set(readListen(saved));
    this.restored = true;
    this.apply();
    // The engine starts on the first gesture; hand it the choice then.
    this.unsub?.();
    this.unsub = this.session.mixer.subscribe(() => {
      if (this.session.mixer.get().audio === 'running') this.apply();
    });
  }

  dispose() {
    this.unsub?.();
    this.unsub = null;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  /** Whether the pick applies: only while the headphones have no output of their own. */
  get applies() {
    return this.session.mixer.get().cueRouting.kind === 'off';
  }

  setSource(source: ListenSource) {
    this.restored = true;
    this.store.set({ source });
    this.apply();
    this.save();
  }

  setLevel(level: number) {
    this.restored = true;
    this.store.set({ level: Math.max(0, Math.min(1, level)) });
    this.apply();
    this.save();
  }

  private applied: { engine: DjEngine; key: string } | null = null;
  private apply() {
    const engine = this.session.engine;
    if (!engine) return;
    const { source, level } = this.store.get();
    const key = `${source}:${level}`;
    if (this.applied?.engine === engine && this.applied.key === key) return;
    this.applied = { engine, key };
    engine.setListen(source, level);
  }

  private save() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void setValue(KEY, this.store.get());
    }, 300);
  }
}
