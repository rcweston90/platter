import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { PITCH_RANGES, ROLL_BEATS, type Deck } from '../engine/deck';
import { beatsLabel } from '../engine/fx';
import { compatible, keyName } from '../engine/key';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { setText, useDropTarget, useFrame, type FrameLoop } from './frame';
import { DECK_GUIDE, InfoTip, PITCH_GUIDE } from './DeckGuide';
import { FxStrip } from './FxStrip';
import { HotCues } from './HotCues';
import { LoopControls } from './LoopControls';
import { StemsControl } from './StemsControl';
import { Turntable } from './Turntable';
import { formatTime, Overview } from './Waveforms';
import { openBrowse } from './browse';
import { ChevronIcon, ListIcon, PauseIcon, PlayIcon } from './icons';
import { openCrate } from './crate/CrateDock';
import { usePhone } from './Phone';
import s from '../platter.module.css';

export const TRACK_MIME = 'application/x-dj-track';

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
  const [padMode, setPadMode] = useState<PadMode>('hot');
  const time = useRef<HTMLSpanElement>(null);
  const remain = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(false);
  const cueHeld = useRef(false);
  const [bending, setBending] = useState<0 | -1 | 1>(0);
  const bend = (dir: 0 | -1 | 1) => {
    setBending(dir);
    deck.setBend(dir);
  };
  const phone = usePhone();
  // A double-tap on a touch screen resets the pitch, as a double-click does:
  // touch browsers don't reliably turn two taps into a dblclick.
  const lastTap = useRef(0);
  const tapStart = useRef({ t: 0, y: 0 });
  const faderDown = (e: PointerEvent<HTMLInputElement>) => {
    if (e.pointerType === 'touch') tapStart.current = { t: e.timeStamp, y: e.clientY };
  };
  const faderTap = (e: PointerEvent<HTMLInputElement>) => {
    if (e.pointerType !== 'touch') return;
    // A drag isn't a tap: only short presses that stay put count.
    const quick = e.timeStamp - tapStart.current.t < 300 && Math.abs(e.clientY - tapStart.current.y) < 10;
    if (!quick) {
      lastTap.current = 0;
      return;
    }
    if (e.timeStamp - lastTap.current < 400) {
      lastTap.current = 0;
      deck.resetPitch();
    } else lastTap.current = e.timeStamp;
  };

  useFrame(loop, () => {
    const track = deck.store.get().track;
    const pos = track ? deck.position() : 0;
    setText(time.current, track ? formatTime(pos) : '0:00');
    setText(remain.current, track ? `−${formatTime(track.duration - pos)}` : '−0:00');
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
              <p className={s.trackArtist}>
                {st.track.artist || '—'}
                {st.track.source && (
                  <>
                    {' · '}
                    <a className={s.deckSource} href={st.track.source.link} target="_blank" rel="noopener noreferrer">
                      {st.track.source.name} ↗
                    </a>
                  </>
                )}
              </p>
            </>
          ) : (
            <>
              <p className={s.trackTitle}>No track</p>
              <p className={s.trackArtist}>
                Drop a file here, load from the crate, or{' '}
                <button type="button" className={s.linkBtn} onClick={() => openBrowse()}>
                  browse music
                </button>
              </p>
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
        <InfoTip
          label={`What deck ${deck.label}'s controls do`}
          title={`Deck ${deck.label}: what each control does`}
          sections={DECK_GUIDE}
          deck={deck.label}
          className={s.deckInfo}
        />
        {phone && (
          // On a phone the track list is a tap away from the deck you're on,
          // not at the bottom of a long page.
          <button
            type="button"
            className={`${s.mini} ${s.deckTracks}`}
            onClick={(e) => openCrate('full', e.currentTarget)}
            aria-label={`Open the track list to load deck ${deck.label}`}
          >
            <ListIcon />
          </button>
        )}
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
            <ChevronIcon dir={-1} />
          </button>
          <button type="button" className={s.mini} onClick={() => deck.nudgeGrid(0.01)} disabled={!st.bpm} aria-label={`Deck ${deck.label}: move the beat grid 10 ms later`}>
            <ChevronIcon dir={1} />
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
            −{st.range * 100}
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
            onPointerDown={faderDown}
            onPointerUp={faderTap}
            onKeyDown={(e) => {
              // The fader runs top (−) to bottom (+). Arrow keys follow the
              // thumb, but the browser's Page Up/Down go by value, which on
              // this fader moves the thumb the opposite way to the key.
              if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
              e.preventDefault();
              const step = e.key === 'PageDown' ? 0.1 : -0.1;
              deck.setPitch(Math.max(-1, Math.min(1, st.pitch / st.range + step)) * st.range);
            }}
          />
          <span className={s.pitchEnd} aria-hidden="true">
            +{st.range * 100}
          </span>
          <div className={s.rangeGroup} role="group" aria-label={`Deck ${deck.label} pitch range`}>
            {PITCH_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                className={`${s.mini} ${s.rangeBtn}`}
                aria-pressed={st.range === r}
                onClick={() => deck.setRange(r)}
                title={`Pitch fader covers −${r * 100}% to +${r * 100}%`}
              >
                ±{r * 100}
              </button>
            ))}
          </div>
          <div className={s.bendGroup} role="group" aria-label={`Deck ${deck.label} pitch bend`}>
            {([-1, 1] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                className={`${s.mini} ${s.bendBtn}`}
                data-held={bending === dir}
                aria-label={`Deck ${deck.label}: ${dir < 0 ? 'bend slower' : 'bend faster'} (hold)`}
                title={dir < 0 ? 'Hold to slow down 4% — nudge the beat back into line' : 'Hold to speed up 4% — nudge the beat into line'}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  bend(dir);
                }}
                onPointerUp={() => bend(0)}
                onPointerCancel={() => bend(0)}
                onLostPointerCapture={() => bending === dir && bend(0)}
                onKeyDown={(e) => {
                  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                    e.preventDefault();
                    bend(dir);
                  }
                }}
                onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && bend(0)}
                onBlur={() => bending === dir && bend(0)}
                onContextMenu={(e) => e.preventDefault()}
              >
                <ChevronIcon dir={dir} />
              </button>
            ))}
          </div>
          <InfoTip
            label={`What deck ${deck.label}'s pitch fader, range and nudge buttons do`}
            title={`Deck ${deck.label}: tempo and pitch`}
            sections={[PITCH_GUIDE]}
            deck={deck.label}
            hover
            className={s.pitchInfo}
          />
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
          {st.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <div className={s.toggles}>
          <button
            type="button"
            className={s.toggle}
            aria-pressed={st.sync}
            data-leader={(!st.sync && other.sync) || undefined}
            disabled={!st.track || !st.bpm}
            onClick={() => deck.setSync(!st.sync)}
            title={
              st.sync
                ? `Synced to deck ${deck.other?.label}: tempo and beats locked. Either fader moves both; a nudge is kept. Press to unlock.`
                : other.sync
                  ? `Deck ${deck.other?.label} follows this deck. Press to follow deck ${deck.other?.label} instead.`
                  : "Lock to the other deck: match its tempo and keep the beats together"
            }
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
            title={`Quantise: cues and loops snap to the beat grid, every ${st.quantizeBeats === 1 ? 'beat' : `${beatsLabel(st.quantizeBeats)} beat`} (set the step by the loops)`}
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

      {padMode === 'hot' && <HotCues deck={deck} />}

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

      <LoopControls deck={deck} />

      <FxStrip session={session} index={idx} />

      <StemsControl stems={session.stems[idx]} label={deck.label} />

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
