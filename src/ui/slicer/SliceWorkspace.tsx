import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import type { Studio } from '../../slicer/studio';
import { useDropTarget, type FrameLoop } from '../frame';
import { ChopActions, cutPoint } from './ChopActions';
import { ChopToolbar } from './ChopToolbar';
import { BANK, bankOf, CUT_KEY, PAD_CODES } from './chopKit';
import { ChopEmpty, SliceStage } from './SliceEditor';
import { SlicePads } from './SlicePads';
import { AUDIO_ACCEPT, SourcePanel, type SourceTab } from './SourcePanel';
import { useIsPhone, useIsTouch } from './usePhone';
import w from './workspace.module.css';

const TEXT_ENTRY = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function isTyping(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t instanceof HTMLInputElement && TEXT_ENTRY.has(t.type);
}

/** Controls that use arrows or Enter themselves. */
function ownsKeys(t: EventTarget | null) {
  return (
    t instanceof HTMLElement && !!t.closest('input, select, textarea, [role="tablist"], [role="radiogroup"], [role="menu"], [role="dialog"], summary, a[href]')
  );
}

const hasFiles = (types: readonly string[]) => types.includes('Files');

/**
 * Chop: the sample on top (one toolbar, the waveform, listen / cut / place),
 * the pads beside it on a desk and under it on a phone. Owns the pad keys
 * while the view is open: 1–4 / Q–R / A–F / Z–V play the current bank of 16,
 * / cuts where the sample is sounding, Enter adds the picked slice to the
 * timeline, left/right pick the previous/next slice when focus is in here.
 */
export function SliceWorkspace({ studio, session, loop }: { studio: Studio; session: DjSession; loop: FrameLoop }) {
  const state = useStore(studio.store);
  const phone = useIsPhone();
  const touch = useIsTouch();
  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<SourceTab>(() => (studio.store.get().project.sources.length ? 'project' : 'crate'));
  const [folded, setFolded] = useState(() => studio.store.get().sourceId !== null);
  const [sheet, setSheet] = useState(false);
  const [over, setOver] = useState(false);
  const [ptr, setPtr] = useState<{ id: string; t: number } | null>(null);
  const [bankState, setBank] = useState(0);

  const src = studio.source(state.sourceId);
  const ready = !!src && state.audio[src.id]?.status === 'ready' && !!studio.buffer(src.id);
  const slice = src && state.slice !== null && state.slice < src.slices.length ? state.slice : null;
  const pointer = src && ptr?.id === src.id ? ptr.t : null;
  const banks = src ? Math.max(1, Math.ceil(src.slices.length / BANK)) : 1;
  const bank = Math.min(bankState, banks - 1);

  // Event handlers read the latest of these.
  const live = useRef({ bank, pointer });
  live.current = { bank, pointer };

  // The first sample in: fold the samples list away so the pads have room.
  const hadSource = useRef(!!src);
  useEffect(() => {
    if (src && !hadSource.current) setFolded(true);
    hadSource.current = !!src;
  }, [src]);

  // The pads follow the picked slice into its bank (arrows, a cut, the waveform).
  useEffect(() => {
    if (slice !== null) setBank(bankOf(slice));
  }, [slice, src?.id]);

  useDropTarget(main, hasFiles, setOver, (dt) => addFiles(Array.from(dt.files)));

  function addFiles(files: File[]) {
    if (!files.length) return;
    setSheet(false);
    void studio.addFiles(files).then((ids) => {
      if (ids.length) setTab('project');
    });
  }

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = studio.store.get();
      if (!s.open || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const cur = studio.source(s.sourceId);
      if (!cur) return;
      // Shift+R records and ? opens the shortcuts in the view: pads never take Shift.
      const pad = e.shiftKey ? -1 : PAD_CODES.indexOf(e.code);
      if (pad >= 0) {
        const i = live.current.bank * BANK + pad;
        if (i >= cur.slices.length || !studio.buffer(cur.id)) return;
        e.preventDefault();
        if (!e.repeat) studio.auditionSlice(cur.id, i);
        return;
      }
      if (e.key === CUT_KEY && !e.shiftKey) {
        if (!studio.buffer(cur.id)) return;
        e.preventDefault();
        const t = cutPoint(studio, cur, live.current.pointer);
        if (t !== null && !e.repeat) studio.addSlice(cur.id, t);
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

  const openFiles = () => fileInput.current?.click();
  const openSheet = (t?: SourceTab) => {
    if (t) setTab(t);
    setSheet(true);
  };
  const onPointer = (t: number) => src && setPtr({ id: src.id, t });

  const fileField = (
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
  );

  const editor = src && (
    <>
      <ChopToolbar key={src.id} studio={studio} state={state} src={src} ready={ready} phone={phone} onPickSource={() => openSheet('project')} />
      <SliceStage studio={studio} state={state} src={src} loop={loop} slice={slice} pointer={pointer} onPointer={onPointer} touch={touch} />
      <ChopActions studio={studio} state={state} src={src} ready={ready} slice={slice} pointer={pointer} phone={phone} />
    </>
  );
  const pads = src && ready && (
    <SlicePads studio={studio} source={src} peaks={studio.peaks(src.id)} slice={slice} bank={bank} onBank={setBank} loop={loop} touch={touch} />
  );

  if (phone) {
    const host = root.current?.closest('[data-slicer]') ?? document.body;
    return (
      <div ref={root} className={w.workspace}>
        <div className={w.ws} data-phone>
          {src ? (
            <>
              {editor}
              {pads}
            </>
          ) : (
            <ChopEmpty phone over={false} onOpenFiles={openFiles} onBrowse={() => openSheet('crate')} />
          )}
          {fileField}
        </div>
        {sheet &&
          createPortal(
            <div
              className={w.sheetScrim}
              onPointerDown={(e) => e.target === e.currentTarget && setSheet(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  // Here, or the view's Escape would close the slicer.
                  e.preventDefault();
                  e.stopPropagation();
                  setSheet(false);
                }
              }}
            >
              <div className={w.sheet} role="dialog" aria-modal="true" aria-label="Pick a sound">
                <div className={w.sheetHead}>
                  <span className={w.sheetGrip} aria-hidden="true" />
                  <h2>Pick a sound</h2>
                  <button type="button" className={w.btn} onClick={() => setSheet(false)} autoFocus>
                    Done
                  </button>
                </div>
                <SourcePanel
                  studio={studio}
                  session={session}
                  state={state}
                  tab={tab}
                  onTab={setTab}
                  onOpenFiles={openFiles}
                  onFiles={addFiles}
                  variant="sheet"
                  onPicked={() => setSheet(false)}
                />
              </div>
            </div>,
            host,
          )}
      </div>
    );
  }

  return (
    <div ref={root} className={w.workspace}>
      <div className={w.ws} data-folded={(src && folded) || undefined} data-has-pads={!!pads || undefined}>
        <SourcePanel
          studio={studio}
          session={session}
          state={state}
          tab={tab}
          onTab={setTab}
          onOpenFiles={openFiles}
          onFiles={addFiles}
          collapsed={!!src && folded}
          onCollapse={src ? setFolded : undefined}
        />
        <div ref={main} className={w.main} data-over={over || undefined}>
          {editor ?? <ChopEmpty phone={false} over={over} onOpenFiles={openFiles} onBrowse={() => setTab('crate')} />}
        </div>
        {pads}
        {fileField}
      </div>
    </div>
  );
}
