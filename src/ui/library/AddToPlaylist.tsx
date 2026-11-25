import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DjSession } from '../../engine/session';
import { useStoreSelect } from '../../engine/store';
import { flashNote } from './playlistsModel';
import p from './playlists.module.css';

/**
 * The playlist button on a crate row: a small popover that lists your
 * playlists, each one pressed if the track is in it (press to add or take it
 * out), and a field to start a new playlist with the track in it.
 */
export function AddToPlaylist({
  session,
  trackId,
  title,
  className,
  tabIndex,
  disabled,
}: {
  session: DjSession;
  trackId: string;
  title: string;
  className?: string;
  tabIndex?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const inLists = useStoreSelect(session.playlists.store, (s) => s.lists.filter((l) => l.trackIds.includes(trackId)).length);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className}
        tabIndex={tabIndex}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-in={inLists > 0 || undefined}
        aria-label={`Add ${title} to a playlist`}
        title={inLists ? `In ${inLists} playlist${inLists === 1 ? '' : 's'}: add to another, or take it out` : 'Add to a playlist'}
        onClick={() => setOpen((o) => !o)}
      >
        <PlaylistIcon />
      </button>
      {open &&
        createPortal(
          <PlaylistPopover
            session={session}
            trackId={trackId}
            title={title}
            anchor={btn.current}
            onClose={(refocus) => {
              setOpen(false);
              if (refocus) btn.current?.focus();
            }}
          />,
          document.body,
        )}
    </>
  );
}

function PlaylistPopover({
  session,
  trackId,
  title,
  anchor,
  onClose,
}: {
  session: DjSession;
  trackId: string;
  title: string;
  anchor: HTMLElement | null;
  onClose: (refocus: boolean) => void;
}) {
  const lists = useStoreSelect(session.playlists.store, (s) => s.lists);
  const box = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Under the button, or above it when the window runs out; kept on screen.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    setPos({ left, top });
  }, [anchor, lists.length]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button, input')?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor?.contains(t)) onClose(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
    // onClose changes every render; the listener only needs the latest close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  const toggle = (id: string, has: boolean, name: string) => {
    if (has) {
      session.playlists.removeTrack(id, trackId);
      flashNote(`Took ${title} out of ${name}`);
    } else {
      session.playlists.add(id, [trackId]);
      flashNote(`Added ${title} to ${name}`);
    }
  };

  const create = () => {
    const pl = session.playlists.create(name, [trackId]);
    flashNote(`Made ${pl.name} with ${title} in it`);
    setName('');
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[data-item]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0 && document.activeElement?.tagName === 'INPUT') return;
    e.preventDefault();
    e.stopPropagation();
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`Add ${title} to a playlist`}
      className={p.popover}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}
      onKeyDown={onKey}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !box.current?.contains(next) && next !== anchor) onClose(false);
      }}
    >
      <p className={p.popHead}>Add to a playlist</p>
      {lists.length > 0 ? (
        <ul className={p.popList}>
          {lists.map((l) => {
            const has = l.trackIds.includes(trackId);
            return (
              <li key={l.id}>
                <button type="button" data-item className={p.popItem} aria-pressed={has} onClick={() => toggle(l.id, has, l.name)}>
                  <span className={p.popCheck} aria-hidden="true">
                    {has ? '✓' : '+'}
                  </span>
                  <span className={p.popName}>{l.name}</span>
                  <span className={p.popCount}>{l.trackIds.length}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={p.popEmpty}>No playlists yet. Name one to start it with this track.</p>
      )}
      <form
        className={p.popNew}
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <input
          type="text"
          className={p.popInput}
          value={name}
          maxLength={80}
          placeholder="New playlist"
          aria-label="New playlist name"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" data-item className={p.popCreate}>
          Create
        </button>
      </form>
    </div>
  );
}

export const PlaylistIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
    <path d="M3 5h9M3 9.5h9M3 14h5.5M15 10v7M11.5 13.5h7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);
