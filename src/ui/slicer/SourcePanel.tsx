import { useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import type { StudioState, Studio } from '../../slicer/studio';
import { SLICE_COLORS, type Source } from '../../slicer/types';
import { useDropTarget } from '../frame';
import { Glyph, ICON } from './chopKit';
import { fmtTime } from './SliceWave';
import w from './workspace.module.css';

export type SourceTab = 'crate' | 'files' | 'project';

const TABS: { id: SourceTab; label: string }[] = [
  { id: 'crate', label: 'Crate' },
  { id: 'files', label: 'Files' },
  { id: 'project', label: 'In project' },
];

/** Long crates: the list shows this many matches; the search narrows the rest. */
const MAX_ROWS = 150;

export const AUDIO_ACCEPT = 'audio/*,.flac,.wav,.aif,.aiff,.mp3,.m4a,.aac,.ogg,.oga,.opus,.caf';

const hasFiles = (types: readonly string[]) => types.includes('Files');

interface Props {
  studio: Studio;
  session: DjSession;
  state: StudioState;
  tab: SourceTab;
  onTab: (t: SourceTab) => void;
  onOpenFiles: () => void;
  onFiles: (files: File[]) => void;
  /** 'side': the desk's column (collapsible); 'sheet': the phone's sheet. */
  variant?: 'side' | 'sheet';
  collapsed?: boolean;
  /** Fold the column to a strip (or open it); absent when it can't fold. */
  onCollapse?: (collapsed: boolean) => void;
  /** A sample was picked (the sheet closes). */
  onPicked?: () => void;
}

/** Where samples come from: the crate, files you open, and what the project already holds. */
export function SourcePanel({ studio, session, state, tab, onTab, onOpenFiles, onFiles, variant = 'side', collapsed, onCollapse, onPicked }: Props) {
  const tabsId = useId();
  const panel = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  useDropTarget(panel, hasFiles, setOver, (dt) => onFiles(Array.from(dt.files)));
  const inProject = state.project.sources.length;

  if (collapsed && onCollapse)
    return <Strip studio={studio} state={state} onExpand={() => onCollapse(false)} onOpenFiles={onOpenFiles} panel={panel} over={over} />;

  return (
    <aside ref={panel} className={w.sources} data-over={over} data-variant={variant} aria-label="Samples">
      <div className={w.tabsRow}>
        <div className={w.tabs} role="tablist" aria-label="Sample sources">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${tabsId}-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${tabsId}-${t.id}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              className={w.tab}
              onClick={() => onTab(t.id)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                // The tab list keeps arrows to itself (the editor's slice keys stay out).
                e.preventDefault();
                const i = TABS.findIndex((x) => x.id === tab);
                const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
                onTab(next.id);
                document.getElementById(`${tabsId}-${next.id}`)?.focus();
              }}
            >
              {t.label}
              {t.id === 'project' && inProject > 0 && <span className={w.count}>{state.project.sources.filter((s) => s.origin.kind !== 'sound').length}</span>}
            </button>
          ))}
        </div>
        {onCollapse && (
          <button type="button" className={w.iconBtn} onClick={() => onCollapse(true)} aria-label="Fold the samples list" title="Fold the samples list">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M12 5l-5 5 5 5" />
            </svg>
          </button>
        )}
      </div>
      <div className={w.tabPanel} role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
        {tab === 'crate' && <CrateList studio={studio} session={session} state={state} onPicked={onPicked} />}
        {tab === 'files' && <FilesTab onOpenFiles={onOpenFiles} over={over} touch={variant === 'sheet'} />}
        {tab === 'project' && <ProjectList studio={studio} state={state} onTab={onTab} onPicked={onPicked} />}
      </div>
    </aside>
  );
}

/* ── Folded: a strip of the project's samples ───────────────────────────── */

function Strip({
  studio,
  state,
  onExpand,
  onOpenFiles,
  panel,
  over,
}: {
  studio: Studio;
  state: StudioState;
  onExpand: () => void;
  onOpenFiles: () => void;
  panel: React.RefObject<HTMLElement | null>;
  over: boolean;
}) {
  const samples = state.project.sources.filter((s) => s.origin.kind !== 'sound' || s.id === state.sourceId);
  return (
    <aside ref={panel} className={w.strip} data-over={over} aria-label="Samples">
      <button type="button" className={w.iconBtn} onClick={onExpand} aria-label="Show the samples list" title="Crate, files and samples">
        <Glyph d={ICON.side} />
      </button>
      <ul className={w.stripList} aria-label="Samples in this project">
        {samples.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={w.stripItem}
              aria-pressed={s.id === state.sourceId}
              style={
                {
                  '--sw': s.origin.kind === 'sound' ? 'var(--cat-none)' : SLICE_COLORS[s.color % SLICE_COLORS.length],
                } as React.CSSProperties
              }
              onClick={() => studio.selectSource(s.id)}
              aria-label={s.name}
              title={`${s.name} · ${s.slices.length} slice${s.slices.length === 1 ? '' : 's'}`}
            >
              {initials(s.name)}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className={w.iconBtn} onClick={onOpenFiles} aria-label="Open audio files" title="Open audio files…">
        <Glyph d={ICON.add} />
      </button>
    </aside>
  );
}

function initials(name: string) {
  const words = name
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[\s_\-·]+/)
    .filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase() || '·';
}

/* ── Crate ──────────────────────────────────────────────────────────────── */

function CrateList({ studio, session, state, onPicked }: { studio: Studio; session: DjSession; state: StudioState; onPicked?: () => void }) {
  const crate = useStore(session.crate);
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLowerCase());
  const searchId = useId();
  const inProject = useMemo(
    () => new Set(state.project.sources.flatMap((s) => (s.origin.kind === 'track' ? [s.origin.trackId] : []))),
    [state.project.sources],
  );
  const matches = useMemo(() => {
    if (!query) return crate.tracks;
    const words = query.split(/\s+/);
    return crate.tracks.filter((t) => {
      const hay = `${t.title} ${t.artist} ${t.fileName} ${t.key ?? ''} ${t.bpm ? Math.round(t.bpm) : ''}`.toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  }, [crate.tracks, query]);
  const shown = matches.slice(0, MAX_ROWS);

  return (
    <div className={w.listWrap}>
      <label htmlFor={searchId} className={w.srOnly}>
        Search your crate
      </label>
      <input
        id={searchId}
        type="search"
        className={w.search}
        placeholder={`Search ${crate.tracks.length} track${crate.tracks.length === 1 ? '' : 's'}…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && q) {
            e.preventDefault();
            setQ('');
          }
        }}
      />
      {!crate.loaded ? (
        <p className={w.empty}>Reading your crate…</p>
      ) : !crate.tracks.length ? (
        <p className={w.empty}>Your crate is empty. Add music on the decks (or link a music folder), or open files in the Files tab.</p>
      ) : !matches.length ? (
        <p className={w.empty}>Nothing matches “{q}”.</p>
      ) : (
        <ul className={w.list} aria-label="Crate tracks">
          {shown.map((t) => {
            const added = inProject.has(t.id);
            const unusable = t.status === 'error';
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={w.trackRow}
                  disabled={unusable}
                  onClick={() => {
                    studio.addTrack(t.id);
                    onPicked?.();
                  }}
                  title={
                    unusable
                      ? (t.error ?? 'This track couldn’t be read.')
                      : added
                        ? 'Already in the project: open it in the editor'
                        : 'Add to the project and open it in the editor'
                  }
                >
                  <span className={w.trackMain}>
                    <span className={w.trackTitle}>{t.title || t.fileName}</span>
                    <span className={w.trackSub}>{t.artist || t.fileName}</span>
                  </span>
                  <span className={w.trackMeta}>
                    <span>{t.bpm ? Math.round(t.bpm) : t.status === 'analysing' ? '…' : '—'}</span>
                    <span>{t.key ?? ''}</span>
                    <span>{t.duration ? fmtTime(t.duration, false) : ''}</span>
                  </span>
                  {added && <span className={w.addedDot} aria-label="In the project" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {matches.length > MAX_ROWS && (
        <p className={w.more}>
          Showing {MAX_ROWS} of {matches.length}. Search to narrow it down.
        </p>
      )}
    </div>
  );
}

/* ── Files ──────────────────────────────────────────────────────────────── */

function FilesTab({ onOpenFiles, over, touch }: { onOpenFiles: () => void; over: boolean; touch: boolean }) {
  return (
    <div className={w.filesTab}>
      <div className={w.dropZone} data-over={over}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className={w.dropIcon}>
          <path d="M12 15V4m0 0L8 8m4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
        </svg>
        <p>{touch ? 'FLAC, WAV, AIFF or MP3 from your files' : 'Drop FLAC, WAV, AIFF or MP3 files here'}</p>
        <button type="button" className={w.primary} onClick={onOpenFiles}>
          Open audio files…
        </button>
      </div>
      <p className={w.fine}>Files stay on this device. Nothing is uploaded.</p>
    </div>
  );
}

/* ── In project ─────────────────────────────────────────────────────────── */

function ProjectList({ studio, state, onTab, onPicked }: { studio: Studio; state: StudioState; onTab: (t: SourceTab) => void; onPicked?: () => void }) {
  const samples = state.project.sources.filter((s) => s.origin.kind !== 'sound');
  const sounds = state.project.sources.filter((s) => s.origin.kind === 'sound');
  if (!state.project.sources.length) {
    return (
      <div className={w.listWrap}>
        <p className={w.empty}>No samples yet.</p>
        <div className={w.emptyActions}>
          <button type="button" className={w.btn} onClick={() => onTab('crate')}>
            Browse the crate
          </button>
          <button type="button" className={w.btn} onClick={() => onTab('files')}>
            Open files
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={w.listWrap}>
      <ul className={w.list} aria-label="Samples in this project">
        {samples.map((s) => (
          <SourceRow key={s.id} studio={studio} state={state} src={s} onPicked={onPicked} />
        ))}
      </ul>
      {sounds.length > 0 && (
        <details className={w.sounds} open={sounds.some((s) => s.id === state.sourceId) || undefined}>
          <summary>
            Drum sounds <span className={w.count}>{sounds.length}</span>
          </summary>
          <ul className={w.list} aria-label="Drum sounds in this project">
            {sounds.map((s) => (
              <SourceRow key={s.id} studio={studio} state={state} src={s} onPicked={onPicked} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SourceRow({ studio, state, src, onPicked }: { studio: Studio; state: StudioState; src: Source; onPicked?: () => void }) {
  const [editing, setEditing] = useState(false);
  const audio = state.audio[src.id];
  const selected = state.sourceId === src.id;
  const sound = src.origin.kind === 'sound';
  const color = sound ? 'var(--cat-none)' : SLICE_COLORS[src.color % SLICE_COLORS.length];
  const status = audio?.status ?? 'loading';
  const clips = state.project.clips.filter((c) => c.sourceId === src.id).length;

  return (
    <li className={w.srcRow} data-selected={selected}>
      <span className={w.swatch} style={{ background: color }} aria-hidden="true" />
      {editing ? (
        <input
          className={w.renameInput}
          defaultValue={src.name}
          aria-label="Sample name"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            studio.renameSource(src.id, e.currentTarget.value.trim() || src.name);
            studio.endGesture();
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.preventDefault();
              e.currentTarget.value = src.name;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={w.srcName}
          aria-pressed={selected}
          onClick={() => {
            studio.selectSource(src.id);
            onPicked?.();
          }}
          onDoubleClick={() => !sound && setEditing(true)}
          title={sound ? src.name : `${src.name} — double-click to rename`}
        >
          <span className={w.srcTitle}>{src.name}</span>
          <span className={w.srcSub}>
            {src.stem && <span className={w.stemTag}>{src.stem}</span>}
            {status === 'ready' && (
              <span>
                {src.slices.length} slice{src.slices.length === 1 ? '' : 's'}
                {src.bpm ? ` · ${Math.round(src.bpm)} BPM` : ''}
                {clips ? ` · ${clips} on lanes` : ''}
              </span>
            )}
            {status === 'loading' && <span>Loading…</span>}
            {status === 'splitting' && <span>Splitting · {Math.round((audio?.progress ?? 0) * 100)}%</span>}
            {(status === 'missing' || status === 'error') && <span className={w.warn}>{status === 'missing' ? 'Needs access' : 'Couldn’t read'}</span>}
          </span>
          {status === 'splitting' && (
            <span
              className={w.progress}
              role="progressbar"
              aria-label="Splitting stems"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((audio?.progress ?? 0) * 100)}
            >
              <span style={{ transform: `scaleX(${audio?.progress ?? 0})` }} />
            </span>
          )}
          {status === 'loading' && (
            <span className={w.progress} data-indeterminate aria-hidden="true">
              <span />
            </span>
          )}
        </button>
      )}
      <span className={w.rowActions}>
        {(status === 'missing' || status === 'error') && (
          <button
            type="button"
            className={w.iconBtn}
            onClick={() => studio.retry(src.id)}
            aria-label={`Retry reading ${src.name}`}
            title={audio?.message ?? 'Retry'}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M15.5 8A6 6 0 1 0 16 12M16 4v4h-4" />
            </svg>
          </button>
        )}
        {!sound && !editing && (
          <button type="button" className={w.iconBtn} onClick={() => setEditing(true)} aria-label={`Rename ${src.name}`} title="Rename">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 16h3l8.5-8.5-3-3L4 13v3ZM11 6l3 3" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={w.iconBtn}
          onClick={() => studio.removeSource(src.id)}
          aria-label={`Remove ${src.name} from the project${clips ? ` and its ${clips} clip${clips === 1 ? '' : 's'}` : ''}`}
          title={clips ? `Remove (and its ${clips} clip${clips === 1 ? '' : 's'} on the lanes) — undo brings it back` : 'Remove from the project'}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5 5 15" />
          </svg>
        </button>
      </span>
    </li>
  );
}
