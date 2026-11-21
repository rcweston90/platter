import { useEffect, useId, useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import { canLinkFolder } from '../../engine/folder';
import { openBrowse } from '../browse';
import { saveFile } from '../save';
import c from './crate.module.css';

/** Getting music in, then the housekeeping. One set, wherever the list
 *  sits. `compact` leaves the housekeeping out; `overflow` tucks it into a
 *  More menu, for the library where the search wants the room. */
export function CrateActions({ session, compact = false, overflow = false }: { session: DjSession; compact?: boolean; overflow?: boolean }) {
  const { loaded } = useStore(session.crate);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const note = (msg: string | null) => session.crate.set({ note: msg });
  const backup = () => {
    const { name, blob } = session.exportBackup();
    const url = URL.createObjectURL(blob);
    void saveFile(name, blob, url).then((msg) => {
      if (msg) note(msg);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  };
  const demos = !session.hasAllDemos() && loaded;

  return (
    <div className={c.actionsBar} data-compact={compact || undefined}>
      <button type="button" className={c.action} onClick={() => fileInput.current?.click()}>
        Add files
      </button>
      {canLinkFolder() && (
        <button type="button" className={c.action} onClick={() => void session.linkFolder()} title="Link a folder: the crate reads your files in place">
          Link folder
        </button>
      )}
      <button type="button" className={c.action} onClick={() => openBrowse()}>
        Browse online
      </button>
      {overflow && !compact && (
        <MoreMenu
          items={[
            { label: 'Import cues and keys…', title: 'From a Platter backup (.json) or a Rekordbox collection (.xml)', run: () => importInput.current?.click() },
            { label: 'Back up cues and keys', title: 'Cue points, tempo, keys, settings and MIDI mappings (not the audio)', run: backup },
            ...(demos ? [{ label: 'Add demo tracks', run: () => session.addDemos() }] : []),
          ]}
        />
      )}
      {!compact && !overflow && (
        <>
          <span className={c.actionsGap} aria-hidden="true" />
          <button
            type="button"
            className={c.action}
            data-quiet
            onClick={() => importInput.current?.click()}
            title="Import cues, tempo and key from a Platter backup (.json) or a Rekordbox collection (.xml)"
          >
            Import
          </button>
          <button
            type="button"
            className={c.action}
            data-quiet
            onClick={backup}
            title="Save cue points, tempo, keys, settings and MIDI mappings (not the audio)"
          >
            Backup
          </button>
          {demos && (
            <button type="button" className={c.action} data-quiet onClick={() => session.addDemos()}>
              Add demo tracks
            </button>
          )}
        </>
      )}
      <input
        ref={importInput}
        type="file"
        accept=".json,.xml,application/json,text/xml"
        hidden
        aria-label="Backup or Rekordbox file to import"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void session.importFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.mp3,.wav,.aif,.aiff,.flac,.ogg,.opus,.m4a,.aac"
        multiple
        hidden
        aria-label="Audio files to add to the crate"
        onChange={(e) => {
          addFiles(session, Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}

function MoreMenu({ items }: { items: { label: string; title?: string; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const all = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  };
  return (
    <div ref={wrap} className={c.more} onKeyDown={onKey}>
      <button
        ref={btn}
        type="button"
        className={c.action}
        data-quiet
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        title="Import, back up"
      >
        More
      </button>
      {open && (
        <div id={id} role="menu" className={c.menu}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={c.menuItem}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function addFiles(session: DjSession, files: File[]) {
  if (!files.length) return;
  void session.addFiles(files).then((n) => {
    if (!n) session.crate.set({ note: 'Those files don’t look like audio.' });
  });
}
