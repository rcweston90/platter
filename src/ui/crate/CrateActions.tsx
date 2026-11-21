import { useRef } from 'react';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import { canLinkFolder } from '../../engine/folder';
import { openBrowse } from '../browse';
import { saveFile } from '../save';
import c from './crate.module.css';

/** Getting music in, then the housekeeping. One set, wherever the list sits. */
export function CrateActions({ session, compact = false }: { session: DjSession; compact?: boolean }) {
  const { loaded } = useStore(session.crate);
  const fileInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const note = (msg: string | null) => session.crate.set({ note: msg });

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
      {!compact && (
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
            onClick={() => {
              const { name, blob } = session.exportBackup();
              const url = URL.createObjectURL(blob);
              void saveFile(name, blob, url).then((msg) => {
                if (msg) note(msg);
                window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
              });
            }}
            title="Save cue points, tempo, keys, settings and MIDI mappings (not the audio)"
          >
            Backup
          </button>
          {!session.hasAllDemos() && loaded && (
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

export function addFiles(session: DjSession, files: File[]) {
  if (!files.length) return;
  void session.addFiles(files).then((n) => {
    if (!n) session.crate.set({ note: 'Those files don’t look like audio.' });
  });
}
