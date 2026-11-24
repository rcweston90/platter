import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { bankLabel, CUE_COLORS, cueColorVar, defaultCueColor, hotLetter } from '../engine/cues';
import type { Deck } from '../engine/deck';
import { beatsLabel } from '../engine/fx';
import { useStore } from '../engine/store';
import { HOT_BANK_SIZE, HOT_BANKS, MEMORY_CUES } from '../engine/types';
import { ChevronIcon } from './icons';
import { formatTime } from './Waveforms';
import s from '../platter.module.css';
import h from './hotcues.module.css';

/*
 * The hot cue pads: eight to a bank, two banks (A–H, I–P). An empty pad
 * marks the spot, or keeps the running loop as a hot loop; a set pad jumps
 * there or loops again. Shift-click, right-click or long-press clears. With
 * Edit on, a set pad opens its editor instead: colour, and Clear. Gate makes
 * a pad play only while held. The memory cue controls sit at the end of the
 * bar above the pads.
 */

const LONG_PRESS_MS = 600;
const SWATCH_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function HotCues({ deck }: { deck: Deck }) {
  const st = useStore(deck.store);
  const L = deck.label;
  const [editing, setEditing] = useState(false);
  /** The slot whose editor is open, or null. */
  const [open, setOpen] = useState<number | null>(null);
  const pads = useRef<(HTMLButtonElement | null)[]>([]);
  /** The slot each pad pressed, so letting go after a bank switch lets go of the right one. */
  const held = useRef<(number | null)[]>([]);
  const longPress = useRef<{ timer: number; pad: number } | null>(null);
  const bankStart = st.hotBank * HOT_BANK_SIZE;

  // A cleared cue, a new track, the other bank or Edit turned off closes the editor.
  const openCue = open === null ? null : st.hotCues[open];
  const openShown = open !== null && open >= bankStart && open < bankStart + HOT_BANK_SIZE;
  useEffect(() => {
    if (open !== null && (!openCue || !editing || !openShown)) setOpen(null);
  }, [open, openCue, editing, openShown]);

  const cancelLongPress = () => {
    if (!longPress.current) return;
    window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  };

  const press = (pad: number) => {
    const slot = bankStart + pad;
    held.current[pad] = slot;
    deck.hotCueDown(slot);
  };
  const release = (pad: number) => {
    const slot = held.current[pad];
    held.current[pad] = null;
    if (slot !== null && slot !== undefined) deck.hotCueUp(slot);
  };

  const onDown = (pad: number, e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const slot = bankStart + pad;
    const cue = st.hotCues[slot];
    if (e.shiftKey) {
      deck.clearHotCue(slot);
      return;
    }
    if (editing && cue) {
      setOpen(open === slot ? null : slot);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    // Long press clears on touch screens, where there's no Shift or
    // right-click. In Gate mode holding is playing, so clear from the editor.
    if (e.pointerType === 'touch' && cue && !st.hotGate) {
      cancelLongPress();
      longPress.current = {
        pad,
        timer: window.setTimeout(() => {
          longPress.current = null;
          deck.clearHotCue(slot);
        }, LONG_PRESS_MS),
      };
      return;
    }
    press(pad);
  };
  const onUp = (pad: number) => {
    if (longPress.current?.pad === pad) {
      cancelLongPress();
      press(pad);
    }
    release(pad);
  };
  const onCancel = (pad: number) => {
    if (longPress.current?.pad === pad) cancelLongPress();
    release(pad);
  };
  const onKeyDown = (pad: number, e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (e.repeat) return;
    const slot = bankStart + pad;
    if (e.shiftKey) deck.clearHotCue(slot);
    else if (editing && st.hotCues[slot]) setOpen(open === slot ? null : slot);
    else press(pad);
  };
  const onKeyUp = (pad: number, e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') release(pad);
  };

  const closeEditor = (refocus: boolean) => {
    const slot = open;
    setOpen(null);
    if (refocus && slot !== null) pads.current[slot - bankStart]?.focus();
  };

  const memAt = deck.memoryAtCue();
  const memCount = st.memoryCues.length;
  const cueTime = formatTime(st.cue);

  return (
    <div className={h.hot}>
      <div className={h.bar}>
        <div className={h.group} role="group" aria-label={`Deck ${L} hot cue bank`}>
          {Array.from({ length: HOT_BANKS }, (_, b) => {
            const count = st.hotCues.slice(b * HOT_BANK_SIZE, (b + 1) * HOT_BANK_SIZE).filter(Boolean).length;
            return (
              <button
                key={b}
                type="button"
                className={`${s.mini} ${h.bank}`}
                aria-pressed={st.hotBank === b}
                onClick={() => deck.setHotBank(b)}
                aria-label={`Hot cues ${bankLabel(b)}, ${count} set`}
                data-filled={count > 0 || undefined}
              >
                {bankLabel(b)}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={s.mini}
          aria-pressed={st.hotGate}
          onClick={() => deck.setHotGate(!st.hotGate)}
          aria-label={`Deck ${L} gate: hot cues play only while held`}
          title="Gate: a hot cue plays only while you hold it, then goes back to the cue point"
        >
          Gate
        </button>
        <button
          type="button"
          className={s.mini}
          aria-pressed={editing}
          onClick={() => setEditing(!editing)}
          aria-label={`Deck ${L}: edit hot cues — press a set pad to change its colour or clear it`}
          title="Edit: press a set pad to change its colour or clear it"
        >
          Edit
        </button>
        <div className={h.memory} role="group" aria-label={`Deck ${L} memory cues, ${memCount} of ${MEMORY_CUES}`}>
          <span className={h.memLabel} aria-hidden="true">
            Mem
          </span>
          <button
            type="button"
            className={s.mini}
            onClick={() => deck.stepMemoryCue(-1)}
            disabled={!st.track || !memCount}
            aria-label="Previous memory cue: make it the cue point"
          >
            <ChevronIcon dir={-1} />
          </button>
          <button
            type="button"
            className={s.mini}
            onClick={() => deck.addMemoryCue()}
            disabled={!st.track || memCount >= MEMORY_CUES}
            aria-label={`Save a memory cue here (${memCount} of ${MEMORY_CUES})`}
            title={`Save a memory cue here — ${memCount} of ${MEMORY_CUES}`}
          >
            +<span className={h.memCount} aria-hidden="true">{memCount}</span>
          </button>
          <button
            type="button"
            className={s.mini}
            onClick={() => deck.stepMemoryCue(1)}
            disabled={!st.track || !memCount}
            aria-label="Next memory cue: make it the cue point"
          >
            <ChevronIcon dir={1} />
          </button>
          <button
            type="button"
            className={s.mini}
            onClick={() => deck.deleteMemoryCue()}
            disabled={memAt < 0}
            aria-label={memAt < 0 ? 'Delete memory cue — call one up first' : `Delete the memory cue at ${cueTime}`}
            title="Delete the memory cue at the cue point"
          >
            ×
          </button>
        </div>
      </div>

      <div className={h.wrap} data-editing={editing || undefined}>
        <div
          className={s.hotCues}
          role="group"
          aria-label={`Deck ${L} hot cues ${bankLabel(st.hotBank)} — Shift-click, right-click or long-press to clear`}
        >
          {Array.from({ length: HOT_BANK_SIZE }, (_, pad) => {
            const slot = bankStart + pad;
            const cue = st.hotCues[slot];
            const letter = hotLetter(slot);
            const color = cue ? cue.color : defaultCueColor(slot);
            const live = !!cue?.loop && st.loop.active && Math.abs(st.loop.start - cue.t) < 0.001 && Math.abs(st.loop.end - cue.loop.end) < 0.001;
            const label = !cue
              ? `Set hot cue ${letter}${st.loop.active ? ' to the running loop' : ''}`
              : `${cue.loop ? `Hot loop ${letter}, ${beatsLabel(cue.loop.beats)} beats from` : `Hot cue ${letter} at`} ${formatTime(cue.t)}, ${CUE_COLORS[cue.color]}${editing ? ' — press to edit' : ''}`;
            return (
              <button
                key={pad}
                ref={(el) => {
                  pads.current[pad] = el;
                }}
                type="button"
                className={`${s.hotCue} ${h.pad}`}
                style={{ '--pad': cueColorVar(color) } as CSSProperties}
                data-set={!!cue}
                data-loop={!!cue?.loop || undefined}
                data-live={live || undefined}
                disabled={!st.track}
                aria-haspopup={editing && cue ? 'dialog' : undefined}
                aria-expanded={editing && cue ? open === slot : undefined}
                onPointerDown={(e) => onDown(pad, e)}
                onPointerUp={() => onUp(pad)}
                onPointerCancel={() => onCancel(pad)}
                onKeyDown={(e) => onKeyDown(pad, e)}
                onKeyUp={(e) => onKeyUp(pad, e)}
                onBlur={() => release(pad)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  deck.clearHotCue(slot);
                }}
                aria-label={label}
              >
                <span className={s.hotNum}>{letter}</span>
                <span className={s.hotTime}>
                  {cue?.loop && (
                    <span className={h.loopTag} aria-hidden="true">
                      ⟲{beatsLabel(cue.loop.beats)}
                    </span>
                  )}
                  {cue ? formatTime(cue.t) : ''}
                </span>
              </button>
            );
          })}
        </div>
        {open !== null && openCue && openShown && (
          <CueEditor
            deck={deck}
            slot={open}
            color={openCue.color}
            anchor={pads.current[open - bankStart] ?? null}
            onClose={closeEditor}
          />
        )}
      </div>
    </div>
  );
}

function CueEditor({
  deck,
  slot,
  color,
  anchor,
  onClose,
}: {
  deck: Deck;
  slot: number;
  color: number;
  anchor: HTMLElement | null;
  onClose: (refocus: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const swatches = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  const cue = deck.store.get().hotCues[slot];
  const letter = hotLetter(slot);

  // Under the pad, kept inside the pad grid's width.
  useLayoutEffect(() => {
    const el = box.current;
    const wrap = el?.offsetParent as HTMLElement | null;
    if (!el || !anchor || !wrap) return;
    const left = Math.max(0, Math.min(anchor.offsetLeft, wrap.clientWidth - el.offsetWidth));
    setPos({ top: anchor.offsetTop + anchor.offsetHeight + 6, left });
  }, [anchor, slot]);

  useEffect(() => {
    // Opening it moves focus here once; recolouring keeps focus where it is.
    // A frame later, so the press that opened it can't take focus back.
    const id = requestAnimationFrame(() => swatches.current[color]?.focus());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot]);

  // A press anywhere else closes it (the pad itself toggles it).
  useEffect(() => {
    const away = (e: globalThis.PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (box.current?.contains(t) || anchor?.contains(t))) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [anchor, onClose]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };

  // Arrow keys move round the colours, as in any radio group.
  const onSwatchKey = (i: number, e: KeyboardEvent<HTMLButtonElement>) => {
    const step = SWATCH_STEP[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (i + step + CUE_COLORS.length) % CUE_COLORS.length;
    deck.setHotCueColor(slot, next);
    swatches.current[next]?.focus();
  };

  if (!cue) return null;
  return (
    <div ref={box} className={h.editor} style={pos} role="dialog" aria-label={`Edit hot cue ${letter}`} onKeyDown={onKey}>
      <p className={h.editorTitle}>
        {cue.loop ? 'Hot loop' : 'Hot cue'} {letter}
        <span className={h.editorTime}>
          {formatTime(cue.t)}
          {cue.loop ? ` · ${beatsLabel(cue.loop.beats)} beats` : ''}
        </span>
      </p>
      <div className={h.swatches} role="radiogroup" aria-label="Colour">
        {CUE_COLORS.map((name, i) => (
          <button
            key={name}
            ref={(el) => {
              swatches.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={color === i}
            tabIndex={color === i ? 0 : -1}
            aria-label={name}
            title={name}
            className={h.swatch}
            style={{ '--pad': cueColorVar(i) } as CSSProperties}
            onClick={() => deck.setHotCueColor(slot, i)}
            onKeyDown={(e) => onSwatchKey(i, e)}
          />
        ))}
      </div>
      <div className={h.editorActions}>
        <button
          type="button"
          className={s.mini}
          onClick={() => {
            deck.clearHotCue(slot);
            onClose(true);
          }}
        >
          Clear
        </button>
        <button type="button" className={s.mini} onClick={() => onClose(true)}>
          Done
        </button>
      </div>
    </div>
  );
}
