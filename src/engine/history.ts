import type { Deck } from './deck';
import { getValue, setValue } from './library';
import { createStore, type Store } from './store';

/**
 * Play history: what you played, deck by deck, the way a DJ's tracklist reads.
 *
 * A track counts as played once it has been heard for PLAY_THRESHOLD_MS on a
 * deck — time the deck was actually playing, so cueing, scratching from a
 * stop or a quick preview doesn't fill the list. Pauses don't reset the
 * count; loading another track on that deck does. Each play is logged once,
 * when it crosses the line.
 *
 * Entries are grouped into sessions: one starts when the page loads, and a
 * new one starts when something plays after SESSION_GAP_MS with nothing
 * playing at all. "Played this session" (the tick in the crate and in
 * playlists) is the current session's entries.
 *
 * Kept in IndexedDB (the kv store, key "history"). The clock, the threshold
 * and the gap are injectable, so the rule can be tested without waiting a
 * minute.
 */

export const PLAY_THRESHOLD_MS = 60_000;
export const SESSION_GAP_MS = 2 * 60 * 60 * 1000;
const KEY = 'history';
/** The most entries kept; the oldest go first. */
const LIMIT = 5000;

export interface HistoryEntry {
  id: string;
  trackId: string;
  title: string;
  artist: string;
  bpm: number | null;
  key: string | null;
  deck: 'A' | 'B';
  /** When the track started playing on the deck (ms since the epoch). */
  startedAt: number;
  /** When it crossed the threshold and was logged. */
  loggedAt: number;
  /** The session it belongs to, named by the time the session started. */
  session: number;
}

export interface HistoryState {
  /** Oldest first. */
  entries: HistoryEntry[];
  /** The current session. */
  session: number;
  /** Track ids played in the current session. */
  played: ReadonlySet<string>;
  loaded: boolean;
}

export interface PlayedTrack {
  id: string;
  title: string;
  artist: string;
  bpm: number | null;
  key: string | null;
}

export interface HistoryOptions {
  threshold?: number;
  gap?: number;
  now?: () => number;
  /** Save to IndexedDB (off for a test instance). */
  persist?: boolean;
  /** Check on a timer while a deck plays (off when a test drives the clock and calls tick). */
  timers?: boolean;
}

interface DeckRun {
  track: PlayedTrack | null;
  playing: boolean;
  /** When the current stretch of playing began. */
  since: number | null;
  /** Milliseconds heard so far. */
  heard: number;
  /** When it first started playing. */
  firstPlay: number | null;
  logged: boolean;
}

const freshRun = (track: PlayedTrack | null): DeckRun => ({ track, playing: false, since: null, heard: 0, firstPlay: null, logged: false });

function isEntry(e: unknown): e is HistoryEntry {
  const x = e as HistoryEntry | null;
  return !!x && typeof x.id === 'string' && typeof x.trackId === 'string' && typeof x.title === 'string' && typeof x.startedAt === 'number' && typeof x.session === 'number';
}

export class PlayHistory {
  /** Milliseconds of playing before a track counts as played. */
  threshold: number;
  /** Milliseconds of nothing playing that end a session. */
  gap: number;
  readonly store: Store<HistoryState>;
  private readonly now: () => number;
  private readonly persist: boolean;
  private readonly timers: boolean;
  private runs: [DeckRun, DeckRun] = [freshRun(null), freshRun(null)];
  /** Since when no deck has been playing; null while one is. */
  private idleSince: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor(opts: HistoryOptions = {}) {
    this.threshold = opts.threshold ?? PLAY_THRESHOLD_MS;
    this.gap = opts.gap ?? SESSION_GAP_MS;
    this.now = opts.now ?? Date.now;
    this.persist = opts.persist ?? true;
    this.timers = opts.timers ?? true;
    const t = this.now();
    this.idleSince = t;
    this.store = createStore<HistoryState>({ entries: [], session: t, played: new Set(), loaded: !this.persist });
  }

  /** Reads the saved history. Anything logged before it arrives is kept. */
  async init() {
    if (!this.persist || this.store.get().loaded) return;
    const saved = await getValue<unknown>(KEY);
    const old = Array.isArray(saved) ? saved.filter(isEntry) : [];
    const ids = new Set(old.map((e) => e.id));
    const early = this.store.get().entries.filter((e) => !ids.has(e.id));
    this.store.set({ loaded: true });
    this.commit([...old, ...early], early.length > 0);
  }

  /** Follows both decks: every change of track or of play state. */
  attach(decks: readonly Deck[]): () => void {
    const unsubs = decks.map((d) => {
      const read = () => {
        const st = d.store.get();
        const rec = st.track ? { id: st.track.id, title: st.track.title, artist: st.track.artist, bpm: st.bpm, key: st.key } : null;
        this.update(d.index, rec, st.playing && !st.loading);
      };
      read();
      return d.store.subscribe(read);
    });
    return () => {
      unsubs.forEach((u) => u());
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  /** A deck's track and whether it's playing, as of now. */
  update(deck: 0 | 1, track: PlayedTrack | null, playing: boolean) {
    const now = this.now();
    let run = this.runs[deck];
    this.settle(run, now);
    if ((track?.id ?? null) !== (run.track?.id ?? null)) {
      run = this.runs[deck] = freshRun(track);
    } else if (track) {
      // Tempo and key can arrive after the title: keep the freshest.
      run.track = track;
    }
    const on = playing && !!track;
    if (on && !run.playing) {
      const nothingPlaying = !this.runs.some((r) => r.playing);
      if (nothingPlaying && now - this.idleSince >= this.gap) this.startSession(now);
      run.since = now;
      if (run.firstPlay === null) run.firstPlay = now;
    } else if (!on) {
      run.since = null;
    }
    run.playing = on;
    if (this.runs.some((r) => r.playing)) this.idleSince = Infinity;
    else if (this.idleSince === Infinity) this.idleSince = now;
    this.tick();
  }

  /** Logs whatever has crossed the threshold by now, and sets the next check. */
  tick() {
    const now = this.now();
    const logged: HistoryEntry[] = [];
    this.runs.forEach((run, i) => {
      this.settle(run, now);
      if (!run.track || run.logged || run.heard < this.threshold) return;
      run.logged = true;
      logged.push({
        id: `${now.toString(36)}-${(this.seq++).toString(36)}-${i}`,
        trackId: run.track.id,
        title: run.track.title,
        artist: run.track.artist,
        bpm: run.track.bpm,
        key: run.track.key,
        deck: i === 0 ? 'A' : 'B',
        startedAt: run.firstPlay ?? now,
        loggedAt: now,
        session: this.store.get().session,
      });
    });
    if (logged.length) this.commit([...this.store.get().entries, ...logged]);
    this.schedule();
  }

  /** Milliseconds a deck's current track has been heard. */
  heard(deck: 0 | 1) {
    const run = this.runs[deck];
    return run.heard + (run.playing && run.since !== null ? this.now() - run.since : 0);
  }

  /** Forgets one session, or all of history. */
  clear(session?: number) {
    const entries = session === undefined ? [] : this.store.get().entries.filter((e) => e.session !== session);
    this.commit(entries);
  }

  /** Sessions with something in them, newest first. */
  sessions(): { session: number; entries: HistoryEntry[] }[] {
    const by = new Map<number, HistoryEntry[]>();
    for (const e of this.store.get().entries) {
      const list = by.get(e.session);
      if (list) list.push(e);
      else by.set(e.session, [e]);
    }
    return [...by.entries()].sort(([a], [b]) => b - a).map(([session, entries]) => ({ session, entries }));
  }

  private startSession(now: number) {
    this.store.set({ session: now, played: new Set() });
  }

  private settle(run: DeckRun, now: number) {
    if (!run.playing || run.since === null) return;
    run.heard += Math.max(0, now - run.since);
    run.since = now;
  }

  private schedule() {
    if (!this.timers) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    let next = Infinity;
    for (const run of this.runs) if (run.playing && run.track && !run.logged) next = Math.min(next, this.threshold - run.heard);
    if (next === Infinity) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, Math.max(0, next) + 20);
  }

  private commit(all: HistoryEntry[], save = true) {
    const entries = all.length > LIMIT ? all.slice(all.length - LIMIT) : all;
    const session = this.store.get().session;
    const played = new Set(entries.filter((e) => e.session === session).map((e) => e.trackId));
    this.store.set({ entries, played });
    // Until the saved history is read, a save would write over it.
    if (save && this.persist && this.store.get().loaded) void setValue(KEY, entries);
  }
}

/* ── Tracklist text ─────────────────────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, '0');

/** h:mm:ss or mm:ss from the start of the set. */
export function setTime(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** One session as a plain-text tracklist: a heading, then one line per track
 *  with its time into the set and "Artist - Title". */
export function tracklistText(entries: HistoryEntry[], locale?: string): string {
  if (!entries.length) return '';
  const sorted = [...entries].sort((a, b) => a.startedAt - b.startedAt);
  const t0 = sorted[0].startedAt;
  const when = new Date(t0).toLocaleString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const width = String(sorted.length).length;
  const lines = sorted.map((e, i) => {
    const name = e.artist ? `${e.artist} - ${e.title}` : e.title;
    return `${String(i + 1).padStart(width, '0')}. ${setTime(e.startedAt - t0)}  ${name}`;
  });
  return [`Platter tracklist, ${when}`, `${sorted.length} track${sorted.length === 1 ? '' : 's'}`, '', ...lines, ''].join('\n');
}

/** A file name for a session's tracklist. */
export function tracklistName(session: number) {
  const d = new Date(session);
  return `platter-tracklist-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
}
