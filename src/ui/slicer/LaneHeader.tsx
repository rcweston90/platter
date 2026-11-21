import { useId, useRef, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { getSound } from '../../engine/sounds/catalog';
import type { Studio } from '../../slicer/studio';
import type { Lane } from '../../slicer/types';
import { Popover } from './Popover';
import { SoundPicker } from './SoundPicker';
import st from './arranger.module.css';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const panText = (v: number) => (Math.abs(v) < 0.01 ? 'C' : `${Math.round(Math.abs(v) * 100)}${v < 0 ? 'L' : 'R'}`);
const panLong = (v: number) => (Math.abs(v) < 0.01 ? 'centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`);

interface Props {
  studio: Studio;
  session: DjSession;
  lane: Lane;
  index: number;
  count: number;
  heard: boolean;
  /** Pads record onto this lane. */
  armed: boolean;
  recording: boolean;
  /** The narrow phone column: one button that opens the lane sheet. */
  phone: boolean;
}

/**
 * One lane's header. Desktop: colour, kind, name, record-arm (sample lanes),
 * mute, solo and a "…" panel with level, pan, sound and order. Phone: a
 * narrow tile (colour, kind, short name, state) that opens all of that as a
 * sheet, so the timeline keeps the width.
 */
export function LaneHeader({ studio, session, lane, index, count, heard, armed, recording, phone }: Props) {
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const drum = lane.kind === 'drum';
  const sound = lane.sound ? getSound(lane.sound) : undefined;
  const style = { ['--lane' as string]: drum ? lane.color : 'var(--dj-b)' };
  const live = armed && recording;

  const panel = menu && menuBtn.current && (
    <LanePanel
      studio={studio}
      lane={lane}
      index={index}
      count={count}
      armed={armed}
      full={phone}
      anchor={menuBtn.current}
      onClose={() => setMenu(false)}
      onSound={() => {
        setMenu(false);
        setPicker(true);
      }}
    />
  );
  const soundPicker = picker && menuBtn.current && (
    <SoundPicker
      session={session}
      anchor={menuBtn.current}
      title={`Sound for ${lane.name}`}
      current={lane.sound}
      category={sound?.category}
      sheet={phone}
      onPick={(id) => {
        studio.setLaneSound(lane.id, id);
        setPicker(false);
      }}
      onClose={() => setPicker(false)}
    />
  );

  if (phone) {
    return (
      <div className={st.lane} data-phone="true" data-drum={drum} data-heard={heard} style={style}>
        <button
          ref={menuBtn}
          type="button"
          className={st.tile}
          aria-haspopup="dialog"
          aria-expanded={menu}
          aria-label={`${lane.name} lane${lane.mute ? ', muted' : ''}${lane.solo ? ', solo' : ''}${armed && !drum ? ', record lane' : ''}. Lane settings`}
          onClick={() => setMenu((m) => !m)}
        >
          <span className={st.swatch} aria-hidden="true" />
          <span className={st.tileTop} aria-hidden="true">
            <span className={st.kind}>{drum ? <DrumIcon /> : <WaveIcon />}</span>
            {lane.mute ? <b className={st.flag} data-role="mute">M</b> : lane.solo ? <b className={st.flag} data-role="solo">S</b> : !drum && armed ? <span className={st.armMark} data-live={live} /> : null}
          </span>
          <span className={st.tileName} aria-hidden="true">
            {lane.name}
          </span>
        </button>
        {panel}
        {soundPicker}
      </div>
    );
  }

  return (
    <div className={st.lane} data-drum={drum} data-heard={heard} style={style} role="group" aria-label={`${lane.name} lane`}>
      <span className={st.swatch} aria-hidden="true" />
      <span className={st.kind} title={drum ? `Drum lane${sound ? `: ${sound.name}` : ''}` : 'Sample lane'} aria-hidden="true">
        {drum ? <DrumIcon /> : <WaveIcon />}
      </span>
      <NameInput studio={studio} lane={lane} index={index} className={st.laneName} />
      <div className={st.laneBtns}>
        {!drum && (
          <button
            type="button"
            className={st.arm}
            aria-pressed={armed}
            data-live={live}
            aria-label={`Record pads onto ${lane.name}`}
            title={armed ? (live ? 'Recording onto this lane' : 'Pads record onto this lane') : 'Record pads onto this lane'}
            onClick={() => studio.setRecordLane(lane.id)}
          >
            <span aria-hidden="true" />
          </button>
        )}
        <MuteSolo studio={studio} lane={lane} />
        <button
          ref={menuBtn}
          type="button"
          className={st.chip}
          aria-label={`${lane.name} settings`}
          aria-haspopup="dialog"
          aria-expanded={menu}
          title="Level, pan, sound, order"
          onClick={() => setMenu((m) => !m)}
        >
          <MoreIcon />
        </button>
      </div>
      {panel}
      {soundPicker}
    </div>
  );
}

function MuteSolo({ studio, lane, big }: { studio: Studio; lane: Lane; big?: boolean }) {
  return (
    <>
      <button
        type="button"
        className={big ? st.bigToggle : st.chip}
        data-role="mute"
        aria-pressed={lane.mute}
        aria-label={big ? undefined : `Mute ${lane.name}`}
        title="Mute"
        onClick={() => studio.updateLane(lane.id, { mute: !lane.mute })}
      >
        {big ? 'Mute' : 'M'}
      </button>
      <button
        type="button"
        className={big ? st.bigToggle : st.chip}
        data-role="solo"
        aria-pressed={lane.solo}
        aria-label={big ? undefined : `Solo ${lane.name}`}
        title="Solo"
        onClick={() => studio.updateLane(lane.id, { solo: !lane.solo })}
      >
        {big ? 'Solo' : 'S'}
      </button>
    </>
  );
}

function NameInput({ studio, lane, index, className, id }: { studio: Studio; lane: Lane; index: number; className: string; id?: string }) {
  const drum = lane.kind === 'drum';
  return (
    <input
      id={id}
      className={className}
      value={lane.name}
      aria-label={id ? undefined : `Lane ${index + 1} name`}
      maxLength={40}
      spellCheck={false}
      onChange={(e) => studio.updateLane(lane.id, { name: e.target.value }, `lname:${lane.id}`)}
      onBlur={(e) => {
        if (!e.target.value.trim()) studio.updateLane(lane.id, { name: drum ? ((lane.sound && getSound(lane.sound)?.name) || 'Drums') : `Sample ${index + 1}` });
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
  );
}

/** Level, pan, sound and order of a lane; on phones also its name, mute, solo and record. */
function LanePanel({
  studio,
  lane,
  index,
  count,
  armed,
  full,
  anchor,
  onClose,
  onSound,
}: {
  studio: Studio;
  lane: Lane;
  index: number;
  count: number;
  armed: boolean;
  full: boolean;
  anchor: HTMLElement;
  onClose: () => void;
  onSound: () => void;
}) {
  const ids = useId();
  const drum = lane.kind === 'drum';
  const sound = lane.sound ? getSound(lane.sound) : undefined;
  const run = (fn: () => void) => {
    onClose();
    fn();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} label={`${lane.name} lane`} className={st.lanePanel} sheet={full}>
      <div className={st.lpHead} style={{ ['--lane' as string]: drum ? lane.color : 'var(--dj-b)' }}>
        <span className={st.kind} aria-hidden="true">
          {drum ? <DrumIcon /> : <WaveIcon />}
        </span>
        {full ? (
          <>
            <label htmlFor={`${ids}-name`} className={st.srOnly}>
              Lane name
            </label>
            <NameInput studio={studio} lane={lane} index={index} id={`${ids}-name`} className={st.lpName} />
            <button type="button" className={st.iconBtn} aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </>
        ) : (
          <span className={st.lpTitle}>{lane.name}</span>
        )}
      </div>

      {full && (
        <div className={st.lpToggles}>
          <MuteSolo studio={studio} lane={lane} big />
          {!drum && (
            <button type="button" className={st.bigToggle} data-role="arm" aria-pressed={armed} onClick={() => studio.setRecordLane(lane.id)}>
              <span className={st.armMark} aria-hidden="true" /> Rec here
            </button>
          )}
        </div>
      )}

      <div className={st.lpRow}>
        <label htmlFor={`${ids}-gain`}>Level</label>
        <input
          id={`${ids}-gain`}
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={lane.gain}
          aria-valuetext={pct(lane.gain)}
          onChange={(e) => studio.updateLane(lane.id, { gain: Number(e.target.value) }, `lgain:${lane.id}`)}
          onPointerUp={() => studio.endGesture()}
          onDoubleClick={() => studio.updateLane(lane.id, { gain: 1 })}
        />
        <output htmlFor={`${ids}-gain`}>{pct(lane.gain)}</output>
      </div>
      <div className={st.lpRow}>
        <label htmlFor={`${ids}-pan`}>Pan</label>
        <input
          id={`${ids}-pan`}
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={lane.pan}
          aria-valuetext={panLong(lane.pan)}
          onChange={(e) => studio.updateLane(lane.id, { pan: Math.abs(Number(e.target.value)) < 0.04 ? 0 : Number(e.target.value) }, `lpan:${lane.id}`)}
          onPointerUp={() => studio.endGesture()}
          onDoubleClick={() => studio.updateLane(lane.id, { pan: 0 })}
        />
        <output htmlFor={`${ids}-pan`}>{panText(lane.pan)}</output>
      </div>

      {drum && (
        <button type="button" className={st.lpSound} onClick={onSound} aria-label={`Sound: ${sound?.name ?? 'none'}. Change`}>
          <span className={st.lpSoundLabel}>Sound</span>
          <span className={st.dot} style={{ ['--lane' as string]: lane.color }} aria-hidden="true" />
          <span className={st.lpSoundName}>{sound?.name ?? 'Choose a sound'}</span>
          <ChevronIcon />
        </button>
      )}

      <div className={st.lpActions}>
        <button type="button" className={st.menuItem} disabled={index === 0} onClick={() => run(() => studio.moveLane(lane.id, -1))}>
          <ArrowIcon up /> Move up
        </button>
        <button type="button" className={st.menuItem} disabled={index === count - 1} onClick={() => run(() => studio.moveLane(lane.id, 1))}>
          <ArrowIcon /> Move down
        </button>
        <button type="button" className={st.menuItem} data-danger="true" disabled={count <= 1} onClick={() => run(() => studio.removeLane(lane.id))}>
          <TrashIcon /> Delete lane
        </button>
      </div>
    </Popover>
  );
}

export const WaveIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1 8h2M4 5v6M6.5 2v12M9 4.5v7M11.5 6v4M14 7.5v1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const DrumIcon = () => (
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
export const CloseIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);
const ChevronIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={st.chev}>
    <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ArrowIcon = ({ up }: { up?: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" style={up ? { transform: 'rotate(180deg)' } : undefined}>
    <path d="M8 3v10M4 9l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const TrashIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
