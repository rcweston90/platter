import { useEffect, useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import type { Studio } from '../../slicer/studio';
import type { FrameLoop } from '../frame';
import { SliceEditor } from './SliceEditor';
import { PAD_KEYS, SlicePads } from './SlicePads';
import { AUDIO_ACCEPT, SourcePanel, type SourceTab } from './SourcePanel';
import w from './workspace.module.css';

const TEXT_ENTRY = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function isTyping(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t instanceof HTMLInputElement && TEXT_ENTRY.has(t.type);
}

/** Controls that use arrows or Enter themselves. */
function ownsKeys(t: EventTarget | null) {
  return t instanceof HTMLElement && !!t.closest('input, select, textarea, [role="tablist"], [role="radiogroup"], summary, a[href]');
}

/**
 * The top half of the slicer: samples on the left, the slice editor and the
 * slice pads beside it. Owns the slice keys while the view is open: 1–0 and
 * Q–P play slices 1–20, Enter adds the selected slice to the timeline,
 * left/right pick the previous/next slice when focus is in here.
 */
export function SliceWorkspace({ studio, session, loop }: { studio: Studio; session: DjSession; loop: FrameLoop }) {
  const state = useStore(studio.store);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<SourceTab>(() => (studio.store.get().project.sources.length ? 'project' : 'crate'));
  const src = studio.source(state.sourceId);
  const ready = !!src && state.audio[src.id]?.status === 'ready';

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    void studio.addFiles(files).then((ids) => {
      if (ids.length) setTab('project');
    });
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = studio.store.get();
      if (!s.open || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const cur = studio.source(s.sourceId);
      if (!cur) return;
      const k = e.key.toLowerCase();
      const pad = e.shiftKey ? -1 : PAD_KEYS.indexOf(k);
      if (pad >= 0) {
        if (pad >= cur.slices.length || !studio.buffer(cur.id)) return;
        e.preventDefault();
        if (!e.repeat) studio.auditionSlice(cur.id, pad);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // A focused button's Enter is its own click.
        if (s.slice === null || ownsKeys(e.target) || (e.target instanceof HTMLElement && e.target.closest('button'))) return;
        e.preventDefault();
        studio.appendSlice(cur.id, s.slice);
        return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) {
        const inside = root.current?.contains(document.activeElement);
        if (!inside || ownsKeys(e.target)) return;
        e.preventDefault();
        const n = cur.slices.length;
        const from = s.slice ?? (e.key === 'ArrowRight' ? -1 : n);
        const next = Math.max(0, Math.min(n - 1, from + (e.key === 'ArrowRight' ? 1 : -1)));
        if (studio.buffer(cur.id)) studio.auditionSlice(cur.id, next);
        else studio.selectSlice(next);
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [studio]);

  return (
    <div ref={root} className={w.workspace}>
      <div className={w.ws} data-has-pads={ready || undefined}>
        <SourcePanel
          studio={studio}
          session={session}
          state={state}
          tab={tab}
          onTab={setTab}
          onOpenFiles={() => fileInput.current?.click()}
          onFiles={addFiles}
        />
        <SliceEditor
          studio={studio}
          state={state}
          loop={loop}
          onOpenFiles={() => fileInput.current?.click()}
          onFiles={addFiles}
          onBrowse={() => setTab('crate')}
        />
        {src && ready && (
          <SlicePads
            studio={studio}
            source={src}
            peaks={studio.peaks(src.id)}
            slice={state.slice !== null && state.slice < src.slices.length ? state.slice : null}
            audition={state.audition}
            loop={loop}
          />
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={AUDIO_ACCEPT}
          aria-label="Audio files to open in the slicer"
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = '';
          }}
        />
      </div>
    </div>
  );
}
