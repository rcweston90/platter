import { useEffect, useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { clipRate, laneHeard } from '../../slicer/model';
import type { Studio } from '../../slicer/studio';
import type { FrameLoop } from '../frame';
import { recordLaneId, useSel } from './arrangeStore';
import { ClipInspector, DupIcon, HearIcon } from './ClipInspector';
import { DrumIcon, LaneHeader, TrashIcon, WaveIcon } from './LaneHeader';
import { Popover } from './Popover';
import { StepTag } from './SlicerGuide';
import { SoundPicker } from './SoundPicker';
import { Timeline, type TimelineControl } from './Timeline';
import { useIsPhone, useIsTouch } from './usePhone';
import st from './arranger.module.css';

const PREFS_KEY = 'platter.slicer.arranger';

interface Prefs {
  follow: boolean;
  draw: boolean;
}

function readPrefs(): Prefs {
  const base: Prefs = { follow: true, draw: false };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { follow: saved.follow ?? base.follow, draw: saved.draw ?? base.draw };
  } catch {
    return base;
  }
}

/**
 * The arranger: one toolbar row, lanes of slices and drum hits on the song's
 * beat grid, and the selected clips' settings, which appear only while
 * something is selected (floating at the right; a sheet on phones). Fills
 * its container.
 */
export function Arranger({ studio, session, loop }: { studio: Studio; session: DjSession; loop: FrameLoop }) {
  const lanes = useSel(studio.store, (s) => s.project.lanes);
  const recording = useSel(studio.store, (s) => s.recording);
  const armedId = useSel(studio.store, (s) => s.recordLane);
  const hasSel = useSel(studio.store, (s) => s.selection.length > 0);
  const selCount = useSel(studio.store, (s) => s.selection.length);
  const slices = useSel(studio.store, (s) => {
    const src = s.project.sources.find((x) => x.id === s.sourceId);
    return src && src.duration > 0 ? src.slices.length : 0;
  });
  const sourceName = useSel(studio.store, (s) => s.project.sources.find((x) => x.id === s.sourceId)?.name ?? null);
  const phone = useIsPhone();
  const touch = useIsTouch();
  const [prefs, setPrefs] = useState(readPrefs);
  const [addMenu, setAddMenu] = useState(false);
  const [drumPicker, setDrumPicker] = useState(false);
  const [sheet, setSheet] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const control = useRef<TimelineControl | null>(null);
  const laneH = phone || touch ? 52 : 44;
  const headerW = phone ? 60 : touch ? 256 : 224;
  const recLane = recordLaneId(lanes, armedId);

  useEffect(() => {
    if (!hasSel) setSheet(false);
  }, [hasSel]);

  const pref = (patch: Partial<Prefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* private window: just this session */
      }
      return next;
    });

  const layOut = (from?: number) => {
    const s = studio.store.get();
    if (!s.sourceId) return;
    studio.layoutSlices(s.sourceId, recordLaneId(s.project.lanes, s.recordLane) ?? undefined, from);
  };

  const label = (text: string) => (phone ? null : <span>{text}</span>);

  return (
    <section className={st.arranger} aria-label="Arrangement" data-phone={phone || undefined}>
      <div className={st.toolbar} role="toolbar" aria-label="Arrangement tools">
        <StepTag step="song" compact={phone} />
        <span className={st.sep} aria-hidden="true" />
        <button
          ref={addBtn}
          type="button"
          className={st.tool}
          aria-haspopup="menu"
          aria-expanded={addMenu}
          aria-label={phone ? 'Add a lane or lay out slices' : undefined}
          title="Add a lane, or lay out the slices"
          onClick={() => setAddMenu((o) => !o)}
        >
          <PlusIcon />
          {label('Lane')}
          {!phone && <CaretIcon />}
        </button>
        <span className={st.sep} aria-hidden="true" />
        <button
          type="button"
          className={st.tool}
          aria-pressed={prefs.draw}
          aria-label={phone ? 'Draw drum hits' : undefined}
          title="Draw: paint hits on drum lanes; start on a hit to erase (B)"
          onClick={() => pref({ draw: !prefs.draw })}
        >
          <PencilIcon />
          {label('Draw')}
        </button>
        <button
          type="button"
          className={st.tool}
          aria-pressed={prefs.follow}
          aria-label={phone ? 'Follow the playhead' : undefined}
          title="Keep the playhead in view while playing"
          onClick={() => pref({ follow: !prefs.follow })}
        >
          <FollowIcon />
          {label('Follow')}
        </button>
        {!phone && prefs.draw && <span className={st.hint}>Click or drag on a drum lane to add hits · start on a hit to erase</span>}
        <div className={`${st.group} ${st.push}`} role="group" aria-label="Timeline zoom">
          <button type="button" className={st.tool} aria-label="Zoom the timeline out" title="Zoom out (−, Ctrl/Cmd + wheel, or pinch)" onClick={() => control.current?.zoomBy(0.7)}>
            <MinusIcon />
          </button>
          <button type="button" className={st.tool} aria-label="Fit the song" title="Show the whole song" onClick={() => control.current?.fit()}>
            <FitIcon />
            {label('Fit')}
          </button>
          <button type="button" className={st.tool} aria-label="Zoom the timeline in" title="Zoom in (=, Ctrl/Cmd + wheel, or pinch)" onClick={() => control.current?.zoomBy(1.4)}>
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className={st.main}>
        <Timeline
          studio={studio}
          loop={loop}
          laneH={laneH}
          headerW={headerW}
          touch={touch || phone}
          draw={prefs.draw}
          follow={prefs.follow}
          onToggleDraw={() => pref({ draw: !prefs.draw })}
          onInspect={() => setSheet(true)}
          control={control}
          corner={phone ? null : <span>Lanes</span>}
          headers={lanes.map((lane, i) => (
            <LaneHeader
              key={lane.id}
              studio={studio}
              session={session}
              lane={lane}
              index={i}
              count={lanes.length}
              heard={laneHeard(lane, lanes)}
              armed={lane.id === recLane}
              recording={recording}
              phone={phone}
            />
          ))}
          empty={
            <div className={st.emptyCard} data-overlay>
              <p className={st.emptyTitle}>Build the song</p>
              <button type="button" className={st.primary} disabled={!slices} onClick={() => layOut(0)}>
                <LayoutIcon />
                {slices ? `Put all ${slices} slice${slices === 1 ? '' : 's'} in order` : 'Put all slices in order'}
              </button>
              <p className={st.emptySub}>{slices ? `${sourceName ?? 'The sample'} rebuilt from its slices, ready to rearrange` : 'Pick a sound in step 1 first'}</p>
              <ul className={st.emptyWays}>
                <li>
                  <span className={st.recDot} aria-hidden="true" />
                  <span>
                    Or press <b>Rec pads</b> and play the pads to record a take
                  </span>
                </li>
                <li>
                  <DragIcon />
                  <span>{phone || touch ? 'Turn on Draw and tap a drum lane to place hits' : 'Drag a slice here, or click a drum lane to add hits'}</span>
                </li>
              </ul>
            </div>
          }
        />
        {hasSel && !phone && <ClipInspector studio={studio} onClose={() => studio.select([])} />}
        {hasSel && phone && sheet && <ClipInspector studio={studio} sheet onClose={() => setSheet(false)} />}
        {hasSel && phone && !sheet && (
          <div className={st.selBar} role="toolbar" aria-label="Selected clips">
            <span className={st.selCount}>{selCount === 1 ? '1 clip' : `${selCount} clips`}</span>
            <button
              type="button"
              className={st.selBtn}
              aria-label="Hear it"
              onClick={() => {
                const s = studio.store.get();
                const c = s.project.clips.find((x) => x.id === s.selection[0]);
                if (c) void studio.audition(c.sourceId, c.start, c.end, { reverse: c.reverse, semitones: 12 * Math.log2(clipRate(c, studio.source(c.sourceId), s.project.bpm)) });
              }}
            >
              <HearIcon />
            </button>
            <button type="button" className={st.selBtn} aria-label="Duplicate" onClick={() => studio.duplicateClips()}>
              <DupIcon />
            </button>
            <button type="button" className={st.selBtn} data-danger="true" aria-label="Delete" onClick={() => studio.deleteClips()}>
              <TrashIcon />
            </button>
            <button type="button" className={`${st.selBtn} ${st.selEdit}`} onClick={() => setSheet(true)}>
              <SlidersIcon /> Edit
            </button>
          </div>
        )}
      </div>

      {addMenu && addBtn.current && (
        <Popover anchor={addBtn.current} onClose={() => setAddMenu(false)} label="Add" role="menu" className={st.menu} sheet={phone}>
          <button
            type="button"
            role="menuitem"
            className={st.menuItem}
            onClick={() => {
              setAddMenu(false);
              studio.addLane('audio');
            }}
          >
            <span className={st.menuIcon} style={{ color: 'var(--dj-b)' }}>
              <WaveIcon />
            </span>
            <span className={st.menuText}>
              Sample lane<small>Slices and recorded takes</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={st.menuItem}
            onClick={() => {
              setAddMenu(false);
              setDrumPicker(true);
            }}
          >
            <span className={st.menuIcon} style={{ color: 'var(--cat-kick, #ff6b86)' }}>
              <DrumIcon />
            </span>
            <span className={st.menuText}>
              Drum lane…<small>One sound from the library, drawn on the grid</small>
            </span>
          </button>
          <hr className={st.menuSep} />
          <button
            type="button"
            role="menuitem"
            className={st.menuItem}
            disabled={!slices}
            onClick={() => {
              setAddMenu(false);
              layOut();
            }}
          >
            <span className={st.menuIcon}>
              <LayoutIcon />
            </span>
            <span className={st.menuText}>
              All slices, in order<small>{slices ? `${slices} from ${sourceName ?? 'the sample'}, at the playhead` : 'Pick a sound in step 1 first'}</small>
            </span>
          </button>
        </Popover>
      )}
      {drumPicker && addBtn.current && (
        <SoundPicker
          session={session}
          anchor={addBtn.current}
          title="Sound for the new drum lane"
          category="kick"
          sheet={phone}
          onPick={(id) => {
            studio.addLane('drum', id);
            setDrumPicker(false);
          }}
          onClose={() => setDrumPicker(false)}
        />
      )}
    </section>
  );
}

const PlusIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const MinusIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const CaretIcon = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true" className={st.caret}>
    <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const PencilIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 13l1-3.5L11 2.5l2.5 2.5-7 7zM9.5 4l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);
const FollowIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 1.5v13M3 6l-2 2 2 2M13 6l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const FitIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.5 4v8M14.5 4v8M4 8h8M6 6l-2 2 2 2M10 6l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const LayoutIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1.5" y="5" width="3.5" height="6" rx="1" fill="currentColor" />
    <rect x="6.25" y="5" width="2.5" height="6" rx="1" fill="currentColor" opacity="0.75" />
    <rect x="10" y="5" width="4.5" height="6" rx="1" fill="currentColor" opacity="0.5" />
  </svg>
);
const DragIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={st.wayIcon}>
    <path d="M6 9V3.5a1.25 1.25 0 0 1 2.5 0V8M8.5 7.5a1.25 1.25 0 0 1 2.5 0V9M11 8.5a1.25 1.25 0 0 1 2.5 0v2.5a4 4 0 0 1-4 4H8.5a4 4 0 0 1-3.2-1.6L3 10.4a1.2 1.2 0 0 1 1.8-1.6L6 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const SlidersIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="10.5" cy="4.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="5.5" cy="11.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
