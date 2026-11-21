import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import st from './arranger.module.css';

/**
 * A small floating panel next to the button that opened it. Portalled into the
 * slicer view so the timeline's scroll box can't clip it; closes on Escape or
 * a press outside and hands focus back to its button.
 */
export function Popover({
  anchor,
  onClose,
  label,
  role = 'dialog',
  className,
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  label: string;
  role?: 'dialog' | 'menu';
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const below = a.bottom + 4 + h <= window.innerHeight - 8 || a.top < h + 12;
      setPos({
        left: Math.max(8, Math.min(a.left, window.innerWidth - w - 8)),
        top: below ? Math.min(a.bottom + 4, window.innerHeight - h - 8) : a.top - h - 4,
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  useEffect(() => {
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], input, [role="menuitem"]:not(:disabled), button:not(:disabled)');
    first?.focus();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!el?.contains(t) && !anchor.contains(t)) close.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      if (anchor.isConnected && (!document.activeElement || document.activeElement === document.body || el?.contains(document.activeElement))) anchor.focus();
    };
  }, [anchor]);

  const host = anchor.closest('[data-slicer]') ?? document.body;
  return createPortal(
    <div
      ref={panel}
      className={`${st.popover} ${className ?? ''}`}
      role={role}
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Handled here: the view's Escape would otherwise close the slicer.
          e.preventDefault();
          e.stopPropagation();
          close.current();
        }
        if (role === 'menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
          const i = items.indexOf(document.activeElement as HTMLElement);
          items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
        if (role === 'menu' && e.key === 'Tab') close.current();
      }}
    >
      {children}
    </div>,
    host,
  );
}
