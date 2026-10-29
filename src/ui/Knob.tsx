
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import s from '../platter.module.css';

interface KnobProps {
  /** Visible caption under the knob (HI, MID, FILTER …). */
  label: string;
  /** Full accessible name, e.g. "Deck A high EQ". */
  name: string;
  value: number;
  min: number;
  max: number;
  /** Where double-click (or Delete) puts it back. */
  defaultValue: number;
  onChange: (v: number) => void;
  /** Spoken and shown on hover: "−6.0 dB", "low-pass 1.2 kHz". */
  format: (v: number) => string;
  /** Draw the arc from the default (centre-detent knobs) rather than the minimum. */
  bipolar?: boolean;
  size?: 'sm' | 'md';
}

const SWEEP = 270; // degrees of travel, −135° … +135°, like the hardware
const DRAG_PX = 200; // px of vertical drag for the full range

/**
 * A rotary control: drag up/down (Shift for fine), arrow keys, Page Up/Down,
 * Home/End, double-click or Delete to reset. An ARIA slider underneath.
 */
export function Knob({ label, name, value, min, max, defaultValue, onChange, format, bipolar, size = 'md' }: KnobProps) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const span = max - min;
  const t = (value - min) / span;
  const angle = -SWEEP / 2 + t * SWEEP;

  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = { y: e.clientY, v: value };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const fine = e.shiftKey ? 0.2 : 1;
    let v = d.v + ((d.y - e.clientY) / DRAG_PX) * span * fine;
    // A soft detent at the default, so centring by feel works.
    if (bipolar && Math.abs(v - defaultValue) < span * 0.02) v = defaultValue;
    set(v);
  };
  const end = () => {
    drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = span / (e.shiftKey ? 200 : 40);
    const big = span / 8;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        set(value + step);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        set(value - step);
        break;
      case 'PageUp':
        set(value + big);
        break;
      case 'PageDown':
        set(value - big);
        break;
      case 'Home':
        set(min);
        break;
      case 'End':
        set(max);
        break;
      case 'Delete':
      case 'Backspace':
        set(defaultValue);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // Arc from the start (or the centre) to the current angle.
  const r = 15;
  const polar = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [18 + r * Math.cos(rad), 18 + r * Math.sin(rad)];
  };
  const from = bipolar ? -SWEEP / 2 + ((defaultValue - min) / span) * SWEEP : -SWEEP / 2;
  const [a0, a1] = from <= angle ? [from, angle] : [angle, from];
  const [x0, y0] = polar(a0);
  const [x1, y1] = polar(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  const [tx0, ty0] = polar(-SWEEP / 2);
  const [tx1, ty1] = polar(SWEEP / 2);

  const text = format(value);
  return (
    <div className={`${s.knobWrap} ${size === 'sm' ? s.knobSm : ''}`}>
      <div
        className={s.knob}
        role="slider"
        tabIndex={0}
        aria-label={name}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(3))}
        aria-valuetext={text}
        title={`${name}: ${text}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => set(defaultValue)}
        onKeyDown={onKeyDown}
      >
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <path
            className={s.knobTrack}
            d={`M ${tx0} ${ty0} A ${r} ${r} 0 1 1 ${tx1} ${ty1}`}
          />
          {Math.abs(a1 - a0) > 0.5 && (
            <path className={s.knobArc} d={`M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`} />
          )}
          <g transform={`rotate(${angle} 18 18)`}>
            <circle className={s.knobCap} cx="18" cy="18" r="11" />
            <line className={s.knobTick} x1="18" y1="9" x2="18" y2="14" />
          </g>
        </svg>
      </div>
      <span className={s.knobLabel} aria-hidden="true">
        {label}
      </span>
    </div>
  );
}
