import { useEffect, useRef } from 'react';

/**
 * One requestAnimationFrame for the whole rig. Platters, waveforms and meters
 * register a draw function; the loop runs continuously only while audio is
 * running, and otherwise draws a single frame when something asks (`kick`), so
 * the still preview in the playground costs nothing.
 */
export class FrameLoop {
  private fns = new Set<() => void>();
  private raf = 0;
  private running = false;

  add(fn: () => void) {
    this.fns.add(fn);
    this.kick();
    return () => {
      this.fns.delete(fn);
    };
  }

  setRunning(on: boolean) {
    this.running = on;
    if (on) this.kick();
  }

  kick() {
    if (!this.raf && typeof requestAnimationFrame !== 'undefined') this.raf = requestAnimationFrame(this.tick);
  }

  private tick = () => {
    this.raf = 0;
    this.fns.forEach((fn) => fn());
    if (this.running) this.kick();
  };

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.running = false;
  }
}

/** Registers `draw` with the loop for the component's lifetime; always calls
 *  the latest closure without re-registering. */
export function useFrame(loop: FrameLoop, draw: () => void) {
  const ref = useRef(draw);
  useEffect(() => {
    ref.current = draw;
    loop.kick();
  });
  useEffect(() => loop.add(() => ref.current()), [loop]);
}

/** Keeps a canvas's backing store at device-pixel size; returns CSS size. */
export function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  return { w, h, dpr };
}

/** Reads the rig's colour tokens off the root element, for canvas drawing. */
export function readPalette(el: Element) {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    bg: v('--dj-wave-bg'),
    low: v('--dj-wave-low'),
    mid: v('--dj-wave-mid'),
    high: v('--dj-wave-high'),
    grid: v('--dj-grid'),
    bar: v('--dj-grid-bar'),
    playhead: v('--dj-playhead'),
    cue: v('--dj-cue'),
    loop: v('--dj-loop'),
    played: v('--dj-played'),
    text: v('--dj-dim'),
    // Canvas fonts can't resolve var(); custom properties compute to the
    // substituted family list, so read the site's mono stack here.
    mono: v('--font-mono') || 'monospace',
    hot: [v('--dj-hot-1'), v('--dj-hot-2'), v('--dj-hot-3'), v('--dj-hot-4')],
  };
}

export type Palette = ReturnType<typeof readPalette>;

/**
 * Makes an element a drop target. Wired with addEventListener rather than JSX
 * props: dropping is a pointer shortcut for the Load and Add music buttons,
 * which are the keyboard path, so the region itself stays a plain landmark.
 */
export function useDropTarget(
  ref: React.RefObject<HTMLElement | null>,
  accepts: (types: readonly string[]) => boolean,
  onOver: (over: boolean) => void,
  onDrop: (data: DataTransfer) => void,
) {
  const latest = useRef({ accepts, onOver, onDrop });
  useEffect(() => {
    latest.current = { accepts, onOver, onDrop };
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer || !latest.current.accepts(e.dataTransfer.types)) return;
      e.preventDefault();
      latest.current.onOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) latest.current.onOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      latest.current.onOver(false);
      latest.current.onDrop(e.dataTransfer);
    };
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  }, [ref]);
}
