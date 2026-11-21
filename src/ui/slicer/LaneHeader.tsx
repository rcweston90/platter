import { useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { getSound } from '../../engine/sounds/catalog';
import type { Studio } from '../../slicer/studio';
import type { Lane } from '../../slicer/types';
import { Popover } from './Popover';
import { SoundPicker } from './SoundPicker';
import st from './arranger.module.css';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const panText = (v: number) => (Math.abs(v) < 0.01 ? 'centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`);

/** One lane's header: name, mute/solo, level, pan and (drum lanes) its sound. */
export function LaneHeader({
  studio,
  session,
  lane,
  index,
  count,
  heard,
  compact,
}: {
  studio: Studio;
  session: DjSession;
  lane: Lane;
  index: number;
  count: number;
  heard: boolean;
  compact: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const soundBtn = useRef<HTMLButtonElement>(null);
  const drum = lane.kind === 'drum';
  const sound = lane.sound ? getSound(lane.sound) : undefined;

  const closeMenu = (fn?: () => void) => {
    setMenu(false);
    fn?.();
  };

  return (
    <div className={st.lane} data-drum={drum} data-heard={heard} style={{ ['--lane' as string]: drum ? lane.color : 'var(--dj-b)' }} role="group" aria-label={`${lane.name} lane`}>
      <span className={st.swatch} aria-hidden="true" />
      <div className={st.row}>
        <span className={st.kind} title={drum ? 'Drum lane' : 'Sample lane'} aria-hidden="true">
          {drum ? <DrumIcon /> : <WaveIcon />}
        </span>
        <input
          className={st.laneName}
          value={lane.name}
          aria-label={`Lane ${index + 1} name`}
          maxLength={40}
          onChange={(e) => studio.updateLane(lane.id, { name: e.target.value }, `lname:${lane.id}`)}
          onBlur={(e) => {
            if (!e.target.value.trim()) studio.updateLane(lane.id, { name: drum ? (sound?.name ?? 'Drums') : `Sample ${index + 1}` });
            studio.endGesture();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className={st.chip}
          data-role="mute"
          aria-pressed={lane.mute}
          aria-label={`Mute ${lane.name}`}
          title="Mute"
          onClick={() => studio.updateLane(lane.id, { mute: !lane.mute })}
        >
          M
        </button>
        <button
          type="button"
          className={st.chip}
          data-role="solo"
          aria-pressed={lane.solo}
          aria-label={`Solo ${lane.name}`}
          title="Solo"
          onClick={() => studio.updateLane(lane.id, { solo: !lane.solo })}
        >
          S
        </button>
        <button
          ref={menuBtn}
          type="button"
          className={st.chip}
          aria-label={`More for ${lane.name}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <MoreIcon />
        </button>
      </div>
      {!compact && (
        <div className={st.row}>
          {drum && (
            <button
              ref={soundBtn}
              type="button"
              className={st.soundBtn}
              aria-haspopup="dialog"
              aria-expanded={picker}
              aria-label={`Sound: ${sound?.name ?? 'none'}. Change`}
              title={sound?.name ?? 'Choose a sound'}
              onClick={() => setPicker((o) => !o)}
            >
              <span className={st.dot} aria-hidden="true" />
              <span>{sound?.name ?? 'Choose sound'}</span>
            </button>
          )}
          <input
            type="range"
            className={st.slider}
            min={0}
            max={1.5}
            step={0.01}
            value={lane.gain}
            aria-label={`${lane.name} level`}
            aria-valuetext={pct(lane.gain)}
            title={`Level ${pct(lane.gain)} (double-click: 100%)`}
            onChange={(e) => studio.updateLane(lane.id, { gain: Number(e.target.value) }, `lgain:${lane.id}`)}
            onPointerUp={() => studio.endGesture()}
            onDoubleClick={() => studio.updateLane(lane.id, { gain: 1 })}
          />
          <input
            type="range"
            className={`${st.slider} ${st.pan}`}
            min={-1}
            max={1}
            step={0.01}
            value={lane.pan}
            aria-label={`${lane.name} pan`}
            aria-valuetext={panText(lane.pan)}
            title={`Pan ${panText(lane.pan)} (double-click: centre)`}
            onChange={(e) => studio.updateLane(lane.id, { pan: Math.abs(Number(e.target.value)) < 0.04 ? 0 : Number(e.target.value) }, `lpan:${lane.id}`)}
            onPointerUp={() => studio.endGesture()}
            onDoubleClick={() => studio.updateLane(lane.id, { pan: 0 })}
          />
        </div>
      )}

      {menu && menuBtn.current && (
        <Popover anchor={menuBtn.current} onClose={() => setMenu(false)} label={`${lane.name} lane`} role="menu" className={st.menu}>
          {drum && (
            <button type="button" role="menuitem" className={st.menuItem} onClick={() => closeMenu(() => setPicker(true))}>
              Change sound…
            </button>
          )}
          {drum && (
            <button type="button" role="menuitem" className={st.menuItem} disabled={!lane.sound} onClick={() => closeMenu(() => studio.addHit(lane.id, studio.position()))}>
              Add a hit at the playhead
            </button>
          )}
          <button type="button" role="menuitem" className={st.menuItem} disabled={index === 0} onClick={() => closeMenu(() => studio.moveLane(lane.id, -1))}>
            Move up
          </button>
          <button type="button" role="menuitem" className={st.menuItem} disabled={index === count - 1} onClick={() => closeMenu(() => studio.moveLane(lane.id, 1))}>
            Move down
          </button>
          <button
            type="button"
            role="menuitem"
            className={st.menuItem}
            data-danger="true"
            disabled={count <= 1}
            onClick={() => closeMenu(() => studio.removeLane(lane.id))}
          >
            Delete lane
          </button>
        </Popover>
      )}
      {picker && (soundBtn.current ?? menuBtn.current) && (
        <SoundPicker
          session={session}
          anchor={(soundBtn.current ?? menuBtn.current)!}
          title={`Sound for ${lane.name}`}
          current={lane.sound}
          category={sound?.category}
          onPick={(id) => {
            studio.setLaneSound(lane.id, id);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

const WaveIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1 8h2M4 5v6M6.5 2v12M9 4.5v7M11.5 6v4M14 7.5v1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const DrumIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <ellipse cx="8" cy="6" rx="6" ry="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M2 6v4.5C2 11.9 4.7 13 8 13s6-1.1 6-2.5V6" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const MoreIcon = () => (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="3" cy="7" r="1.3" fill="currentColor" />
    <circle cx="7" cy="7" r="1.3" fill="currentColor" />
    <circle cx="11" cy="7" r="1.3" fill="currentColor" />
  </svg>
);
