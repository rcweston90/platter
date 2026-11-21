import { useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import { laneHeard } from '../../slicer/model';
import type { Studio } from '../../slicer/studio';
import type { FrameLoop } from '../frame';
import { ClipInspector } from './ClipInspector';
import { LaneHeader } from './LaneHeader';
import { SoundPicker } from './SoundPicker';
import { Timeline, type TimelineControl } from './Timeline';
import st from './arranger.module.css';

const PREFS_KEY = 'platter.slicer.arranger';

interface Prefs {
  follow: boolean;
  compact: boolean;
  inspector: boolean;
  draw: boolean;
}

function readPrefs(): Prefs {
  const base: Prefs = { follow: true, compact: false, inspector: true, draw: false };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return base;
  }
}

/**
 * The arranger: lanes of slices and drum hits on the song's beat grid, with
 * the selected clips' settings on the right. Fills its container.
 */
export function Arranger({ studio, session, loop }: { studio: Studio; session: DjSession; loop: FrameLoop }) {
  const s = useStore(studio.store);
  const p = s.project;
  const [prefs, setPrefs] = useState(readPrefs);
  const [drumPicker, setDrumPicker] = useState(false);
  const drumBtn = useRef<HTMLButtonElement>(null);
  const control = useRef<TimelineControl | null>(null);
  const laneH = prefs.compact ? 40 : 64;

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

  return (
    <section className={st.arranger} aria-label="Arrangement">
      <div className={st.toolbar}>
        <div className={st.group}>
          <button type="button" className={st.tool} onClick={() => studio.addLane('audio')}>
            <PlusIcon /> Sample lane
          </button>
          <button ref={drumBtn} type="button" className={st.tool} aria-haspopup="dialog" aria-expanded={drumPicker} onClick={() => setDrumPicker((o) => !o)}>
            <PlusIcon /> Drum lane
          </button>
        </div>
        <div className={st.group}>
          <button
            type="button"
            className={st.tool}
            aria-pressed={prefs.draw}
            title="Draw: drag across a drum lane to paint hits on the grid (B). Cmd/Ctrl-drag paints any time."
            onClick={() => pref({ draw: !prefs.draw })}
          >
            <PencilIcon /> Draw
          </button>
          <button type="button" className={st.tool} aria-pressed={prefs.follow} title="Keep the playhead in view while playing" onClick={() => pref({ follow: !prefs.follow })}>
            <FollowIcon /> Follow
          </button>
        </div>
        <div className={st.group} role="group" aria-label="Zoom">
          <button type="button" className={st.tool} aria-label="Zoom out" title="Zoom out (−, or Ctrl/Cmd + wheel)" onClick={() => control.current?.zoomBy(0.7)}>
            <MinusIcon />
          </button>
          <button type="button" className={st.tool} title="Show the whole song" onClick={() => control.current?.fit()}>
            Fit
          </button>
          <button type="button" className={st.tool} aria-label="Zoom in" title="Zoom in (=, or Ctrl/Cmd + wheel)" onClick={() => control.current?.zoomBy(1.4)}>
            <PlusIcon />
          </button>
        </div>
        <div className={`${st.group} ${st.push}`}>
          <button type="button" className={st.tool} aria-pressed={prefs.compact} title="Shorter lanes" onClick={() => pref({ compact: !prefs.compact })}>
            Compact
          </button>
          <button
            type="button"
            className={st.tool}
            aria-pressed={prefs.inspector}
            aria-controls="slicer-clip-inspector"
            title="Show or hide the clip settings"
            onClick={() => pref({ inspector: !prefs.inspector })}
          >
            Clip panel
          </button>
        </div>
      </div>

      <div className={st.main}>
        <Timeline
          studio={studio}
          loop={loop}
          laneH={laneH}
          draw={prefs.draw}
          follow={prefs.follow}
          onToggleDraw={() => pref({ draw: !prefs.draw })}
          control={control}
          corner={
            <>
              <span>Lanes</span>
              <span>{p.lanes.length}</span>
            </>
          }
          headers={p.lanes.map((lane, i) => (
            <LaneHeader
              key={lane.id}
              studio={studio}
              session={session}
              lane={lane}
              index={i}
              count={p.lanes.length}
              heard={laneHeard(lane, p.lanes)}
              compact={prefs.compact}
            />
          ))}
        />
        {prefs.inspector && (
          <div id="slicer-clip-inspector" style={{ display: 'contents' }}>
            <ClipInspector studio={studio} />
          </div>
        )}
      </div>

      {drumPicker && drumBtn.current && (
        <SoundPicker
          session={session}
          anchor={drumBtn.current}
          title="Sound for the new drum lane"
          category="kick"
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
