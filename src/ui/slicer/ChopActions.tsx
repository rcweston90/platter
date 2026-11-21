import { useState } from 'react';
import { sliceRange } from '../../slicer/model';
import type { Studio, StudioState } from '../../slicer/studio';
import type { Source } from '../../slicer/types';
import { CUT_KEY, fmtLen, Glyph, ICON, sliceColor } from './chopKit';
import { Popover } from './Popover';
import w from './workspace.module.css';

/** Where a cut lands now: what's sounding of this sample, else the cursor. */
export function cutPoint(studio: Studio, src: Source, pointer: number | null): number | null {
  const a = studio.auditionPosition();
  const t = a && a.sourceId === src.id ? a.time : pointer;
  if (t === null || !(t > 0.01) || t >= src.duration - 0.01) return null;
  return src.slices.some((x) => Math.abs(x - t) < 0.01) ? null : t;
}

/** Plays the sample through from the cursor (or the top). */
export function playWhole(studio: Studio, src: Source, pointer: number | null) {
  const from = pointer !== null && pointer < src.duration - 0.05 ? pointer : 0;
  void studio.audition(src.id, from, src.duration);
}

/** True while the sample plays through (not one slice). */
export function playingWhole(state: StudioState, src: Source): boolean {
  const au = state.audition;
  if (!au || au.sourceId !== src.id || au.loop || au.reverse || Math.abs(au.end - src.duration) > 0.005) return false;
  // A pad's slice also ends at the end of the sample: only the last one.
  const last = src.slices[src.slices.length - 1] ?? 0;
  return Math.abs(au.start - last) > 0.005 || src.slices.length === 1;
}

interface Props {
  studio: Studio;
  state: StudioState;
  src: Source;
  ready: boolean;
  slice: number | null;
  pointer: number | null;
  phone: boolean;
}

/**
 * Listening and cutting on the left (play the sample through, tap Cut on the
 * hits), the picked slice and what to do with it on the right. Lay out all is
 * the way in to the song on a phone, where nothing drags.
 */
export function ChopActions({ studio, state, src, ready, slice, pointer, phone }: Props) {
  const [more, setMore] = useState<HTMLElement | null>(null);
  const n = src.slices.length;
  const sel = slice ?? 0;
  const [a, b] = sliceRange(src, sel);
  const au = state.audition && state.audition.sourceId === src.id ? state.audition : null;
  const thisSlice = !!au && Math.abs(au.start - a) < 0.005 && Math.abs(au.end - b) < 0.005;
  const looping = thisSlice && au!.loop;
  const reversing = thisSlice && au!.reverse;
  const whole = playingWhole(state, src);
  const sounding = !!au;
  const canCut = ready && (sounding || pointer !== null);

  const cut = () => {
    const t = cutPoint(studio, src, pointer);
    if (t !== null) studio.addSlice(src.id, t);
  };
  const close = () => setMore(null);

  const listen = (
    <div className={w.listen}>
      <button
        type="button"
        className={w.btn}
        data-big={phone || undefined}
        disabled={!ready}
        aria-pressed={whole}
        onClick={() => (whole ? studio.stopAudition() : playWhole(studio, src, pointer))}
        title={pointer ? 'Play the sample from the cursor' : 'Play the whole sample'}
      >
        <Glyph d={whole ? ICON.stop : ICON.play} fill />
        {whole ? 'Stop' : phone ? 'Play' : 'Play sample'}
      </button>
      <button
        type="button"
        className={w.cut}
        data-big={phone || undefined}
        disabled={!canCut}
        onPointerDown={(e) => {
          // Cut on press: a tap lands where you heard the hit, not 100 ms later.
          if (e.button !== 0) return;
          e.preventDefault();
          cut();
        }}
        onClick={(e) => e.detail === 0 && cut()}
        title={`Cut a new slice where the sample is sounding (or at the cursor) · key ${CUT_KEY}`}
        aria-label={`Cut here (key ${CUT_KEY})`}
      >
        <Glyph d={ICON.cut} /> Cut
        {!phone && <kbd className={w.kbd}>{CUT_KEY}</kbd>}
      </button>
    </div>
  );

  const info = (
    <span className={w.sliceInfo} aria-live="polite">
      {slice === null ? (
        <span className={w.dim}>{phone ? 'Tap a pad' : 'Press a pad to pick a slice'}</span>
      ) : (
        <>
          <span className={w.swatchDot} style={{ background: sliceColor(src, sel) }} aria-hidden="true" />
          Slice <b>{sel + 1}</b>
          <span className={w.dim}>
            /{n} · {fmtLen(b - a)}
          </span>
        </>
      )}
    </span>
  );

  const audition = (
    <div className={w.btnGroup} role="group" aria-label="Hear the slice">
      <button
        type="button"
        className={w.iconBtn}
        data-on={(thisSlice && !looping && !reversing) || undefined}
        disabled={!ready}
        aria-label={thisSlice && !looping && !reversing ? 'Stop the slice' : 'Play the slice'}
        onClick={() => (thisSlice && !looping && !reversing ? studio.stopAudition() : studio.auditionSlice(src.id, sel))}
        title="Play the slice"
      >
        <Glyph d={thisSlice && !looping && !reversing ? ICON.stop : ICON.play} fill />
      </button>
      <button
        type="button"
        className={w.iconBtn}
        data-on={looping || undefined}
        disabled={!ready}
        aria-pressed={looping}
        aria-label="Loop the slice"
        onClick={() => (looping ? studio.stopAudition() : studio.auditionSlice(src.id, sel, { loop: true }))}
        title="Loop the slice"
      >
        <Glyph d={ICON.loop} />
      </button>
      <button
        type="button"
        className={w.iconBtn}
        data-on={reversing || undefined}
        disabled={!ready}
        aria-pressed={reversing}
        aria-label="Play the slice reversed"
        onClick={() => (reversing ? studio.stopAudition() : (studio.selectSlice(sel), void studio.audition(src.id, a, b, { reverse: true })))}
        title="Hear the slice backwards"
      >
        <Glyph d={ICON.reverse} fill />
      </button>
    </div>
  );

  const place = (
    <div className={w.place}>
      <button
        type="button"
        className={w.btn}
        disabled={!ready}
        onClick={() => (studio.selectSlice(sel), studio.appendSlice(src.id, sel))}
        title="Add the slice after the last clip on the sample lane (Enter) — or drag a pad onto any lane"
        aria-label="Add the slice to the timeline"
      >
        <Glyph d={ICON.add} /> {phone ? 'Add' : 'Add to timeline'}
      </button>
      <button
        type="button"
        className={w.primary}
        disabled={!ready || n < 1}
        onClick={() => studio.layoutSlices(src.id)}
        title="Put every slice on a lane in its original groove, from the cursor: a starting point for a flip"
      >
        <Glyph d={ICON.layout} /> Lay out all
      </button>
      <button
        type="button"
        className={w.iconBtn}
        aria-haspopup="dialog"
        aria-expanded={!!more}
        onClick={(e) => {
          const el = e.currentTarget;
          setMore((m) => (m ? null : el));
        }}
        aria-label="More slice actions"
        title="Save WAV, sampler pads, remove a cut"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.4" />
          <circle cx="10" cy="10" r="1.4" />
          <circle cx="15.5" cy="10" r="1.4" />
        </svg>
      </button>
    </div>
  );

  return (
    <div className={w.actions} data-phone={phone || undefined} role="toolbar" aria-label="Listen, cut and place">
      {listen}
      <span className={w.vrule} aria-hidden="true" />
      {info}
      {!phone && audition}
      {place}
      {more && (
        <Popover anchor={more} onClose={close} label="Slice actions" role="menu" className={w.chopPop}>
          {phone && (
            <div className={w.popSection}>
              <span className={w.popLabel}>Slice {sel + 1}</span>
              {audition}
            </div>
          )}
          <button type="button" role="menuitem" className={w.menuItem} disabled={!ready} onClick={() => (close(), void studio.saveSlice(src.id, sel))}>
            Save slice {sel + 1} as WAV
            <span className={w.dim}>24-bit, to your downloads</span>
          </button>
          <button type="button" role="menuitem" className={w.menuItem} disabled={!ready} onClick={() => (close(), void studio.sendToPads(src.id, [sel]))}>
            Slice {sel + 1} to the sampler
            <span className={w.dim}>On the sampler’s selected pad, on the decks</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={w.menuItem}
            disabled={!ready}
            onClick={() => (
              close(),
              void studio.sendToPads(
                src.id,
                src.slices.map((_, i) => i),
              )
            )}
          >
            All {n} slices to the sampler
            <span className={w.dim}>From the sampler’s selected pad on</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={w.menuItem}
            disabled={slice === null || slice === 0}
            onClick={() => (close(), slice !== null && studio.removeSlice(src.id, slice))}
          >
            Join with slice {Math.max(1, sel)}
            <span className={w.dim}>Remove the cut before slice {sel + 1} (or Alt-click its line)</span>
          </button>
        </Popover>
      )}
    </div>
  );
}
