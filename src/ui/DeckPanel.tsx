import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { LOOP_BEATS, PITCH_RANGES, ROLL_BEATS, type Deck } from '../engine/deck';
import { beatsLabel } from '../engine/fx';
import { compatible, keyName } from '../engine/key';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { useDropTarget, useFrame, type FrameLoop } from './frame';
import { FxStrip } from './FxStrip';
import { Turntable } from './Turntable';
import { formatTime, Overview } from './Waveforms';
import s from '../platter.module.css';

export const TRACK_MIME = 'application/x-dj-track';

const loopLabel = (b: number) => (b < 1 ? `1/${Math.round(1 / b)}` : String(b));
type PadMode = 'hot' | 'roll' | 'tricks';
const PAD_MODES: { id: PadMode; label: string }[] = [
  { id: 'hot', label: 'Hot cue' },
  { id: 'roll', label: 'Roll' },
  { id: 'tricks', label: 'Tricks' },
];

/** Pointer and keyboard handlers for a button that acts while held. */
function hold(down: () => void, up: () => void) {
  return {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      down();
    },
    onPointerUp: up,
    onPointerCancel: up,
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault();
        down();
      }
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => (e.key === ' ' || e.key === 'Enter') && up(),
  };
}
const pct = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p * 100).toFixed(2)}%`;

export function DeckPanel({
  session,
  deck,
  loop,
  still,
}: {
  session: DjSession;
  deck: Deck;
  loop: FrameLoop;
  still: boolean;
}) {
  const st = useStore(deck.store);
  const other = useStore((deck.other ?? deck).store);
  const mixer = useStore(session.mixer);
  const [padMode, setPadMode] = useState<PadMode>('hot');
  const time = useRef<HTMLSpanElement>(null);
  const remain = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(false);
  const cueHeld = useRef(false);
  const longPress = useRef<number | null>(null);

  useFrame(loop, () => {
    const track = deck.store.get().track;
    const pos = track ? deck.position() : 0;
    if (time.current) time.current.textContent = track ? formatTime(pos) : '0:00';
    if (remain.current) remain.current.textContent = track ? `−${formatTime(track.duration - pos)}` : '−0:00';
  });

  const effBpm = deck.effectiveBpm();
  const idx = deck.index;
  const effKey = deck.effectiveKey();
  // Recomputed on every render of either deck (both stores are subscribed).
  const otherKey = other.track ? deck.other?.effectiveKey() ?? null : null;
  const keyMatch = effKey && otherKey ? compatible(effKey, otherKey) : null;

  const section = useRef<HTMLElement>(null);
  useDropTarget(
    section,
    (types) => types.includes(TRACK_MIME) || types.includes('Files'),
    setOver,
    (data) => {
      const id = data.getData(TRACK_MIME);
      if (id) {
        void session.loadToDeck(id, idx);
        return;
      }
      const files = Array.from(data.files);
      if (!files.length) return;
      // Dropping a file on a deck adds it to the crate and loads it here.
      void session.addFiles(files).then(() => {
        const added = session.crate.get().tracks.find((t) => t.blob === files[0]);
        if (added) void session.loadToDeck(added.id, idx);
      });
    },
  );

  const cueDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    cueHeld.current = true;
    deck.cueDown();
  };
  const cueUp = () => {
    if (!cueHeld.current) return;
    cueHeld.current = false;
    deck.cueUp();
  };

  const hotDown = (i: number, e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      deck.clearHotCue(i);
      return;
    }
    // Long press clears on touch screens, where there's no Shift or right-click.
    if (e.pointerType === 'touch' && st.hotCues[i] !== null) {
      longPress.current = window.setTimeout(() => {
        longPress.current = null;
        deck.clearHotCue(i);
      }, 600);
      return;
    }
    deck.hotCue(i);
  };
  const hotUp = (i: number, e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType !== 'touch' || longPress.current === null) return;
    window.clearTimeout(longPress.current);
    longPress.current = null;
    deck.hotCue(i);
  };

  return (
    <section ref={section} className={`${s.deck} ${over ? s.deckOver : ''}`} data-deck={deck.label} aria-label={`Deck ${deck.label}`}>
      <header className={s.deckHead}>
        <span className={s.deckBadge} aria-hidden="true">
          {deck.label}
        </span>
        <div className={s.deckTitle}>
          {st.loading ? (
            <p className={s.trackTitle}>Loading…</p>
          ) : st.track ? (
            <>
              <p className={s.trackTitle} title={st.track.title}>
                {st.track.title}
              </p>
              <p className={s.trackArtist}>{st.track.artist || '—'}</p>
            </>
          ) : (
            <>
              <p className={s.trackTitle}>No track</p>
              <p className={s.trackArtist}>Drop a file here or load from the crate</p>
            </>
          )}
        </div>
        <div className={s.deckBpm}>
          <span className={s.bpmValue} aria-label={effBpm ? `${effBpm.toFixed(1)} BPM` : 'BPM unknown'}>
            {effBpm ? effBpm.toFixed(1) : st.track ? '…' : '—'}
          </span>
          <span className={s.bpmUnit}>BPM</span>
          <span
            className={s.keyChip}
            data-match={keyMatch === null ? undefined : keyMatch}
            title={
              effKey
                ? `${keyName(effKey)}${keyMatch === null ? '' : keyMatch ? ' — mixes with the other deck' : ' — clashes with the other deck'}`
                : 'Key unknown'
            }
          >
            {effKey ?? '—'}
          </span>
        </div>
      </header>

      {st.error && (
        <p className={s.deckError} role="status">
          {st.error}
        </p>
      )}

      <div className={s.deckMeta}>
        <span className={s.time}>
          <span ref={time}>0:00</span> <span className={s.dim} ref={remain}>−0:00</span>
        </span>
        <span className={s.pitchReadout} aria-label={`Pitch ${pct(st.pitch)}`}>
          {pct(st.pitch)}
        </span>
        <span className={s.bpmTools}>
          <button type="button" className={s.mini} onClick={() => deck.scaleBpm(0.5)} disabled={!st.bpm} aria-label={`Deck ${deck.label}: halve the detected tempo`}>
            ÷2
          </button>
          <button type="button" className={s.mini} onClick={() => deck.scaleBpm(2)} disabled={!st.bpm} aria-label={`Deck ${deck.label}: double the detected tempo`}>
            ×2
          </button>
          <button type="button" className={s.mini} onClick={() => deck.tap()} disabled={!st.track} aria-label={`Deck ${deck.label}: tap tempo — tap on the beat four or more times`}>
            Tap
          </button>
          <button type="button" className={s.mini} onClick={() => deck.nudgeGrid(-0.01)} disabled={!st.bpm} aria-label={`Deck ${deck.label}: move the beat grid 10 ms earlier`}>
            ‹
          </button>
          <button type="button" className={s.mini} onClick={() => deck.nudgeGrid(0.01)} disabled={!st.bpm} aria-label={`Deck ${deck.label}: move the beat grid 10 ms later`}>
            ›
          </button>
          <button type="button" className={s.mini} onClick={() => deck.eject()} disabled={!st.track || st.playing} aria-label={`Eject deck ${deck.label}`}>
            ⏏
          </button>
        </span>
      </div>

      <Overview deck={deck} loop={loop} />

      <div className={s.deckBody}>
        <Turntable deck={deck} loop={loop} still={still} />
        <div className={s.pitchCol}>
          <span className={s.pitchEnd} aria-hidden="true">
            −
          </span>
          <input
            type="range"
            className={s.pitch}
            min={-1}
            max={1}
            step={0.0025}
            value={st.pitch / st.range}
            aria-label={`Deck ${deck.label} pitch`}
            aria-valuetext={`${pct(st.pitch)}, range ±${st.range * 100}%`}
            onChange={(e) => deck.setPitch(Number(e.target.value) * st.range)}
            onDoubleClick={() => deck.resetPitch()}
          />
          <span className={s.pitchEnd} aria-hidden="true">
            +
          </span>
          <div className={s.rangeGroup} role="group" aria-label={`Deck ${deck.label} pitch range`}>
            {PITCH_RANGES.map((r) => (
              <button key={r} type="button" className={s.mini} aria-pressed={st.range === r} onClick={() => deck.setRange(r)}>
                ±{r * 100}
              </button>
            ))}
          </div>
          <div className={s.bendGroup} role="group" aria-label={`Deck ${deck.label} pitch bend`}>
            {([-1, 1] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                className={s.mini}
                aria-label={dir < 0 ? 'Bend slower (hold)' : 'Bend faster (hold)'}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  deck.setBend(dir);
                }}
                onPointerUp={() => deck.setBend(0)}
                onPointerCancel={() => deck.setBend(0)}
                onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && deck.setBend(dir)}
                onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && deck.setBend(0)}
              >
                {dir < 0 ? '◂' : '▸'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={s.transport}>
        <button
          type="button"
          className={`${s.bigBtn} ${s.cueBtn}`}
          disabled={!st.track}
          onPointerDown={cueDown}
          onPointerUp={cueUp}
          onPointerCancel={cueUp}
          onKeyDown={(e) => {
            if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
              e.preventDefault();
              cueHeld.current = true;
              deck.cueDown();
            }
          }}
          onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && cueUp()}
          aria-label={`Deck ${deck.label} cue — playing: back to the cue point; stopped: set it here and hold to preview`}
        >
          Cue
        </button>
        <button
          type="button"
          className={`${s.bigBtn} ${s.playBtn}`}
          disabled={!st.track}
          aria-pressed={st.playing}
          onClick={() => deck.togglePlay()}
          aria-label={`Deck ${deck.label} ${st.playing ? 'pause' : 'play'}`}
        >
          <span aria-hidden="true">{st.playing ? '❚❚' : '▶'}</span>
        </button>
        <div className={s.toggles}>
          <button
            type="button"
            className={s.toggle}
            aria-pressed={st.sync}
            disabled={!st.track || !st.bpm}
            onClick={() => deck.setSync(!st.sync)}
            title="Match the other deck's tempo and line up the beats"
          >
            Sync
          </button>
          <button
            type="button"
            className={s.toggle}
            aria-pressed={st.keyLock}
            aria-label={`Deck ${deck.label} key lock`}
            onClick={() => void deck.setKeyLock(!st.keyLock)}
            title="Key lock: change tempo without changing pitch (Signalsmith Stretch)"
          >
            Keylock
          </button>
          <button
            type="button"
            className={s.toggle}
            aria-pressed={st.quantize}
            onClick={() => deck.setQuantize(!st.quantize)}
            title="Quantise: cues and loops snap to the beat grid"
          >
            Quant
          </button>
          <button
            type="button"
            className={s.toggle}
            aria-pressed={st.slip}
            onClick={() => deck.setSlip(!st.slip)}
            title="Slip: scratches, loops and reverse return to where the track would have been"
          >
            Slip
          </button>
        </div>
      </div>

      <div className={s.padModes} role="group" aria-label={`Deck ${deck.label} pad mode`}>
        {PAD_MODES.map((m) => (
          <button key={m.id} type="button" className={s.mini} aria-pressed={padMode === m.id} onClick={() => setPadMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {padMode === 'hot' && (
      <div className={s.hotCues} role="group" aria-label={`Deck ${deck.label} hot cues — Shift-click, right-click or long-press to clear`}>
        {st.hotCues.map((t, i) => (
          <button
            key={i}
            type="button"
            className={s.hotCue}
            data-hot={i + 1}
            data-set={t !== null}
            disabled={!st.track}
            onPointerDown={(e) => hotDown(i, e)}
            onPointerUp={(e) => hotUp(i, e)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              if (e.shiftKey) deck.clearHotCue(i);
              else deck.hotCue(i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              deck.clearHotCue(i);
            }}
            aria-label={t === null ? `Set hot cue ${i + 1}` : `Hot cue ${i + 1} at ${formatTime(t)}`}
          >
            <span className={s.hotNum}>{i + 1}</span>
            <span className={s.hotTime}>{t === null ? '' : formatTime(t)}</span>
          </button>
        ))}
      </div>
      )}

      {padMode === 'roll' && (
        <div className={s.hotCues} role="group" aria-label={`Deck ${deck.label} beat rolls — hold`}>
          {ROLL_BEATS.map((b) => (
            <button
              key={b}
              type="button"
              className={`${s.hotCue} ${s.pad}`}
              data-active={st.roll === b}
              disabled={!st.track}
              aria-label={`Hold for a ${beatsLabel(b)}-beat roll`}
              {...hold(
                () => deck.roll(b),
                () => deck.roll(null),
              )}
            >
              <span className={s.hotNum}>{beatsLabel(b)}</span>
              <span className={s.hotTime}>roll</span>
            </button>
          ))}
        </div>
      )}

      {padMode === 'tricks' && (
        <div className={s.hotCues} role="group" aria-label={`Deck ${deck.label} tricks`}>
          <button
            type="button"
            className={`${s.hotCue} ${s.pad}`}
            disabled={!st.track}
            aria-label="Hold to censor: plays backwards, then carries on where the track would be"
            {...hold(
              () => deck.censor(true),
              () => deck.censor(false),
            )}
          >
            <span className={s.hotNum}>Censor</span>
          </button>
          <button
            type="button"
            className={`${s.hotCue} ${s.pad}`}
            aria-pressed={st.reverse}
            data-active={st.reverse}
            disabled={!st.track}
            onClick={() => deck.setReverse(!st.reverse)}
          >
            <span className={s.hotNum}>Reverse</span>
          </button>
          <button
            type="button"
            className={`${s.hotCue} ${s.pad}`}
            disabled={!st.playing}
            onClick={() => deck.brake()}
            aria-label="Brake: a slow turntable stop"
          >
            <span className={s.hotNum}>Brake</span>
          </button>
          <button
            type="button"
            className={`${s.hotCue} ${s.pad}`}
            disabled={!st.playing}
            onClick={() => deck.spinback()}
            aria-label="Spinback: flick the record back and let it stop"
          >
            <span className={s.hotNum}>Spinback</span>
          </button>
        </div>
      )}

      <div className={s.loops} role="group" aria-label={`Deck ${deck.label} loop and beat jump`}>
        <button type="button" className={s.mini} onClick={() => deck.beatJump(-1)} disabled={!st.track} aria-label={`Jump back ${loopLabel(st.loop.beats)} beats`}>
          ◂◂
        </button>
        <button type="button" className={s.mini} onClick={() => deck.stepLoop(-1)} disabled={st.loop.beats === LOOP_BEATS[0]} aria-label="Halve loop length">
          ½
        </button>
        <button
          type="button"
          className={`${s.toggle} ${s.loopBtn}`}
          aria-pressed={st.loop.active}
          disabled={!st.track}
          onClick={() => deck.toggleLoop()}
          aria-label={`${st.loop.active ? 'Exit' : 'Start'} ${loopLabel(st.loop.beats)}-beat loop`}
        >
          Loop {loopLabel(st.loop.beats)}
        </button>
        <button
          type="button"
          className={s.mini}
          onClick={() => deck.stepLoop(1)}
          disabled={st.loop.beats === LOOP_BEATS[LOOP_BEATS.length - 1]}
          aria-label="Double loop length"
        >
          2×
        </button>
        <button type="button" className={s.mini} onClick={() => deck.beatJump(1)} disabled={!st.track} aria-label={`Jump forward ${loopLabel(st.loop.beats)} beats`}>
          ▸▸
        </button>
      </div>

      <FxStrip session={session} index={idx} fx={mixer.channels[idx].fx} />

      <div className={s.keyRow} role="group" aria-label={`Deck ${deck.label} key`}>
        <span className={s.keyLabel}>Key</span>
        <button type="button" className={s.mini} onClick={() => void deck.setKeyShift(st.keyShift - 1)} disabled={!st.track || st.keyShift <= -6} aria-label="Key down a semitone">
          ♭
        </button>
        <span className={s.keyShift} aria-label={`Key shift ${st.keyShift} semitones`}>
          {st.keyShift > 0 ? `+${st.keyShift}` : st.keyShift}
        </span>
        <button type="button" className={s.mini} onClick={() => void deck.setKeyShift(st.keyShift + 1)} disabled={!st.track || st.keyShift >= 6} aria-label="Key up a semitone">
          ♯
        </button>
        <button
          type="button"
          className={s.mini}
          onClick={() => deck.keySync()}
          disabled={!st.key || !otherKey}
          title="Shift to the nearest key that mixes with the other deck"
        >
          Match
        </button>
        <button type="button" className={s.mini} onClick={() => void deck.setKeyShift(0)} disabled={st.keyShift === 0} aria-label="Reset key shift">
          0
        </button>
      </div>
    </section>
  );
}
