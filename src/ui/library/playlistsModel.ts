import { createStore } from '../../engine/store';

/**
 * What the Playlists tab shows: one playlist, or one session of play history
 * (null = the current session), plus a short note after a drop or an add.
 * The pick carries over between visits.
 */
export type PlaylistsPick = { kind: 'list'; id: string } | { kind: 'history'; session: number | null };

/** A row of a playlist being dragged to a new place: "<playlist id> <index>". */
export const PLAYLIST_ROW_MIME = 'application/x-platter-playlist-row';
/** A playlist in the sidebar being dragged to a new place: its id. */
export const PLAYLIST_MIME = 'application/x-platter-playlist';

const KEY = 'platter.playlistsPick';

function readPick(): PlaylistsPick | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PlaylistsPick | null;
    if (v?.kind === 'list' && typeof v.id === 'string') return v;
    if (v?.kind === 'history') return { kind: 'history', session: null };
  } catch {
    // Blocked storage: start on the first playlist.
  }
  return null;
}

export const playlistsView = createStore<{ pick: PlaylistsPick | null; note: string | null; renaming: string | null }>({
  pick: readPick(),
  note: null,
  renaming: null,
});

playlistsView.subscribe(() => {
  try {
    const { pick } = playlistsView.get();
    // A past session isn't worth coming back to; the history is.
    localStorage.setItem(KEY, JSON.stringify(pick?.kind === 'history' ? { kind: 'history', session: null } : pick));
  } catch {
    // As above.
  }
});

let noteTimer: ReturnType<typeof setTimeout> | null = null;
/** A short status line under the playlists ("Added … to …"), cleared after a while. */
export function flashNote(note: string) {
  playlistsView.set({ note });
  if (noteTimer !== null) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => playlistsView.set({ note: null }), 4000);
}

export const pickList = (id: string) => playlistsView.set({ pick: { kind: 'list', id } });
export const pickHistory = (session: number | null) => playlistsView.set({ pick: { kind: 'history', session } });

/** A time of day, as this browser writes it (21:04, or 9:04 PM). */
export const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** A session's name in a list: its day and the time it started. */
export const sessionLabel = (t: number) =>
  `${new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock(t)}`;
