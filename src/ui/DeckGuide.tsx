import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BEND, JUMP_BEATS, LOOP_BEATS, PITCH_RANGES, QUANTIZE_BEATS, ROLL_BEATS, loopLabel } from '../engine/deck';
import { beatsLabel } from '../engine/fx';
import { HOT_CUES } from '../engine/types';
import { InfoIcon } from './icons';
import { usePhone } from './Phone';
import s from '../platter.module.css';

/*
 * The deck guide: what each control on a deck does. Every line is written
 * from what the code does (engine/deck.ts, engine/fx.ts, the deck worklet),
 * not from what a DJ might expect, and the numbers come from the same
 * constants the controls use, so a changed range or bend can't leave the
 * guide behind.
 */

export interface GuideItem {
  name: string;
  text: string;
}
export interface GuideSection {
  id: string;
  title: string;
  items: GuideItem[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const ranges = PITCH_RANGES.map((r) => `±${r * 100}`).join(' ');
/** "a, b, c or d" */
const either = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

export const PITCH_GUIDE: GuideSection = {
  id: 'pitch',
  title: 'Tempo and pitch',
  items: [
    {
      name: 'Pitch fader',
      text: 'Sets the deck’s tempo. Down, toward +, is faster; up, toward −, is slower. The numbers at its ends show how far it goes. Double-click or double-tap it to go back to 0. Without Keylock, the key moves with the tempo.',
    },
    {
      name: ranges,
      text: `How far the fader reaches: ${either(PITCH_RANGES.map(pct))} either way. Narrow for fine control, wide for big changes. Switching keeps your tempo and moves the fader to match, unless the tempo is past the new range; then it’s pulled in to the edge. With Sync on, the deck widens its own range when it has to.`,
    },
    {
      name: '<  >  under the range',
      text: `Nudge. Hold < to play ${pct(BEND)} slower or > to play ${pct(BEND)} faster, to pull the beats back into line. Let go and it’s back at the fader’s tempo. With Sync on, the new beat offset is kept until you press Sync again.`,
    },
    {
      name: '+0.00%',
      text: 'How far the pitch fader has moved the tempo. It doesn’t count 45 rpm or a nudge.',
    },
    {
      name: 'BPM',
      text: 'The tempo you hear: the track’s own, moved by the pitch fader and 33/45. A nudge doesn’t change it.',
    },
    {
      name: '33  45',
      text: 'Platter speed. 33 plays the track as it is; 45 plays it 1.35× faster, on top of the pitch fader.',
    },
  ],
};

export const DECK_GUIDE: GuideSection[] = [
  PITCH_GUIDE,
  {
    id: 'record',
    title: 'The record',
    items: [
      {
        name: 'Record',
        text: 'Drag it to scratch. With it selected, hold an arrow key to nudge, like the < > buttons by the fader.',
      },
      {
        name: 'Waveform strip',
        text: 'The whole track. Click or tap it to drop the needle there.',
      },
    ],
  },
  {
    id: 'transport',
    title: 'Play, cue and the four switches',
    items: [
      {
        name: 'Cue',
        text: 'While playing: back to the cue point, and stop. While stopped: sets the cue point where the track is, and holding it plays from there until you let go. Press Play while holding Cue to keep it playing.',
      },
      { name: 'Play', text: 'Plays and pauses the deck.' },
      {
        name: 'Sync',
        text: 'Locks this deck to the other deck’s tempo and keeps the beats together, at double or half time if that’s closer. Moving either deck’s fader then moves both. Press again to unlock.',
      },
      {
        name: 'Keylock',
        text: 'Changes the tempo without changing the key. It lets go while you hold the record, so scratches sound like a record.',
      },
      {
        name: 'Quant',
        text: `Cue points, hot cues and loops land on the nearest step of the grid — a beat, or ${either(QUANTIZE_BEATS.filter((b) => b < 1).map(loopLabel))} of one, set with the Q key by the loops — and rolls start on the beat just played.`,
      },
      {
        name: 'Slip',
        text: 'Scratches, loops and Reverse play over the track; when they end, the track carries on where it would have been if it had kept playing.',
      },
    ],
  },
  {
    id: 'pads',
    title: 'Pads',
    items: [
      {
        name: 'Hot cue',
        text: `${HOT_CUES} markers. Press an empty pad to mark the spot; press a marked pad to jump there. To clear one, Shift-click it, right-click it or long-press it.`,
      },
      {
        name: 'Roll',
        text: `Hold a pad to repeat a ${either(ROLL_BEATS.map(beatsLabel))}-beat slice over and over. Let go and the track carries on where it would have been.`,
      },
      {
        name: 'Censor',
        text: 'Hold to play backwards; let go and the track carries on where it would have been.',
      },
      { name: 'Reverse', text: 'Plays backwards until you press it again.' },
      { name: 'Brake', text: 'Stops the deck slowly, like a turntable winding down.' },
      { name: 'Spinback', text: 'Flicks the record backwards and lets it stop.' },
    ],
  },
  {
    id: 'loops',
    title: 'Loops and jumps',
    items: [
      { name: 'Loop', text: 'Loops that many beats from here. Press again to leave the loop.' },
      {
        name: 'In  Out',
        text: 'A loop of your own length. In marks where it starts, Out ends it there and starts looping; both snap to the grid with Quant on. Hold In for a 4-beat loop from the in point.',
      },
      {
        name: 'Reloop',
        text: 'While looping it reads Exit: leave the loop and play on. Press it again to jump back to the loop’s start and loop it again.',
      },
      {
        name: '½  2×',
        text: `Halve or double the loop, yours or a beat loop, from ${loopLabel(LOOP_BEATS[0])} of a beat to ${loopLabel(LOOP_BEATS[LOOP_BEATS.length - 1])} beats, even while it’s looping. It keeps its start.`,
      },
      {
        name: 'Edge  <  >',
        text: 'While looping, press In or Out (or Edge) to pick that end of the loop, then move it with < and > or the arrow keys: a grid step with Quant on, 10 ms with it off, 1 ms with Shift. You can also drag an end on the scrolling waveform. The pick lets go after a few seconds untouched, or with Esc.',
      },
      {
        name: '◂◂  − Jump +  ▸▸',
        text: `Jump back or forward by the jump size, ${loopLabel(JUMP_BEATS[0])} to ${loopLabel(JUMP_BEATS[JUMP_BEATS.length - 1])} beats, set with − and +. A running loop moves with the jump.`,
      },
      {
        name: 'Q',
        text: `The quantise step: ${either(QUANTIZE_BEATS.map(loopLabel))} beat. Press for the next. It only snaps while Quant is on.`,
      },
    ],
  },
  {
    id: 'fx',
    title: 'Beat FX',
    items: [
      {
        name: 'Effect',
        text: 'Echo, Reverb, Flanger, Phaser, Trans (chops the sound on the beat) or Crush (lo-fi, fewer bits).',
      },
      {
        name: '<  3/4  >',
        text: 'The effect’s timing in beats of this deck’s tempo: the echo’s repeat, the Flanger and Phaser sweep, the Trans chop, the Reverb’s size. Crush doesn’t use it.',
      },
      {
        name: 'Depth',
        text: 'How much effect: the effect’s level, how deep Trans chops, how hard Crush crushes.',
      },
      {
        name: 'FX',
        text: 'Turns the effect on and off. Echo, Reverb, Flanger and Phaser ring out when you turn them off.',
      },
    ],
  },
  {
    id: 'stems',
    title: 'Stems',
    items: [
      {
        name: 'Split',
        text: 'Splits the track into vocals, drums, bass and other, in your browser. The first split downloads a model of about 170 MB.',
      },
      {
        name: 'Parts',
        text: 'Once split, tap a part to mute it; hold it or Shift-click it to hear it alone. All brings every part back.',
      },
    ],
  },
  {
    id: 'key',
    title: 'Key',
    items: [
      {
        name: 'Key (8A)',
        text: 'The key you hear, in Camelot notation. Green: it mixes with the other deck. Red: it clashes.',
      },
      { name: '♭  ♯', text: 'Moves the key down or up a semitone, up to 6 each way, without changing the tempo.' },
      { name: 'Match', text: 'Moves to the nearest key that mixes with the other deck.' },
      { name: '0', text: 'Takes the key shift off.' },
    ],
  },
  {
    id: 'grid',
    title: 'Tempo set-up',
    items: [
      { name: '÷2  ×2', text: 'Halve or double the detected tempo, when the analysis picked the wrong one.' },
      {
        name: 'Tap',
        text: 'Tap on the beat four or more times to set the tempo yourself. The beat grid lines up with your last tap; a pause of a couple of seconds starts over.',
      },
      {
        name: '<  >  beside Tap',
        text: 'Move the beat grid 10 ms earlier or later, so its lines sit on the beats. This moves the grid, not the music.',
      },
      { name: '⏏', text: 'Unloads the track. Pause first.' },
    ],
  },
];

/**
 * An ⓘ button that opens a guide panel. Click or tap pins it open; with
 * `hover`, a mouse resting on the button opens it too. Escape, a press
 * outside, or the close button shuts it. On a phone it rises from the bottom
 * of the screen. The panel is portalled to the body so a deck's container
 * query can't clip or re-anchor it.
 */
export function InfoTip({
  label,
  title,
  sections,
  deck,
  hover = false,
  className,
}: {
  label: string;
  title: string;
  sections: GuideSection[];
  deck: 'A' | 'B';
  hover?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState<null | 'hover' | 'pinned'>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const id = useId();
  const phone = usePhone();

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const enter = (pointerType: string) => {
    if (!hover || pointerType !== 'mouse' || open === 'pinned') return;
    clear();
    timer.current = window.setTimeout(() => setOpen((o) => o ?? 'hover'), 250);
  };
  const leave = () => {
    if (open === 'pinned') return;
    clear();
    timer.current = window.setTimeout(() => setOpen((o) => (o === 'hover' ? null : o)), 200);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`${s.infoBtn} ${className ?? ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        aria-controls={open ? id : undefined}
        onPointerEnter={(e) => enter(e.pointerType)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && leave()}
        onClick={() => {
          clear();
          setOpen((o) => (o === 'pinned' ? null : 'pinned'));
        }}
      >
        <InfoIcon />
      </button>
      {open && btn.current && (
        <GuidePanel
          id={id}
          anchor={btn.current}
          title={title}
          sections={sections}
          deck={deck}
          sheet={phone}
          takeFocus={open === 'pinned'}
          onEnter={() => clear()}
          onLeave={leave}
          onClose={() => {
            clear();
            setOpen(null);
          }}
        />
      )}
    </>
  );
}

function GuidePanel({
  id,
  anchor,
  title,
  sections,
  deck,
  sheet,
  takeFocus,
  onEnter,
  onLeave,
  onClose,
}: {
  id: string;
  anchor: HTMLElement;
  title: string;
  sections: GuideSection[];
  deck: 'A' | 'B';
  sheet: boolean;
  takeFocus: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // Beside the button where there's room (left of it for a button near the
  // right edge), else below or above it, always inside the window.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el || sheet) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left: number;
      let top: number;
      if (a.right + 8 + w <= vw - 8) {
        left = a.right + 8;
        top = a.top;
      } else if (a.left - 8 - w >= 8) {
        left = a.left - 8 - w;
        top = a.top;
      } else {
        left = a.left;
        top = a.bottom + 6 + h <= vh - 8 ? a.bottom + 6 : a.top - 6 - h;
      }
      setPos({
        left: Math.max(8, Math.min(left, vw - w - 8)),
        top: Math.max(8, Math.min(top, vh - h - 8)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, sheet]);

  useEffect(() => {
    const el = panel.current;
    if (takeFocus) el?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      // The sheet's backdrop closes it on click instead, so the tap that
      // dismisses it doesn't also land on whatever is underneath.
      if (t === backdrop.current) return;
      if (!el?.contains(t) && !anchor.contains(t)) close.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc);
      // By now the panel has left the page, so focus that was inside it has
      // fallen back to the body: hand it to the button that opened it.
      const lost = !document.activeElement || document.activeElement === document.body || el?.contains(document.activeElement);
      if (takeFocus && anchor.isConnected && lost) anchor.focus({ preventScroll: true });
    };
  }, [anchor, takeFocus]);

  const style = {
    '--deck': `var(--dj-${deck.toLowerCase()})`,
    ...(sheet ? null : pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }),
  } as CSSProperties;

  const body: ReactNode = (
    <div
      ref={panel}
      id={id}
      className={`${s.guide} ${sheet ? s.guideSheet : ''}`}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      style={style}
      onPointerEnter={(e) => e.pointerType === 'mouse' && onEnter()}
      onPointerLeave={(e) => e.pointerType === 'mouse' && onLeave()}
    >
      <div className={s.guideHead}>
        <h2 className={s.guideTitle}>{title}</h2>
        <button type="button" className={s.guideClose} onClick={onClose} aria-label="Close the guide">
          ×
        </button>
      </div>
      {sections.map((sec) => (
        <section key={sec.id} className={s.guideSection} aria-label={sections.length > 1 ? sec.title : undefined}>
          {sections.length > 1 && <h3 className={s.guideSub}>{sec.title}</h3>}
          <dl className={s.guideList}>
            {sec.items.map((it) => (
              <div key={it.name} className={s.guideItem}>
                <dt>{it.name}</dt>
                <dd>{it.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );

  return createPortal(
    sheet ? (
      <>
        <div ref={backdrop} className={s.guideBackdrop} aria-hidden="true" onClick={onClose} />
        {body}
      </>
    ) : (
      body
    ),
    document.body,
  );
}
