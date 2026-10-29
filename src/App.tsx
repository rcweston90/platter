
import { useEffect, useRef, useState } from 'react';
import { DjSession } from './engine/session';
import { useStore } from './engine/store';
import { Crate } from './ui/Crate';
import { DeckPanel } from './ui/DeckPanel';
import { FrameLoop } from './ui/frame';
import { usePrefersReducedMotion } from './ui/hooks';
import { Mixer } from './ui/Mixer';
import { TopBar } from './ui/TopBar';
import { ScrollingWave } from './ui/Waveforms';
import s from './platter.module.css';

/**
 * Platter — two turntables, a two-channel club mixer and a crate, in the
 * browser. The playheads are a custom AudioWorklet (so records scratch and
 * run backwards); key lock is Signalsmith Stretch, tempo detection is
 * web-audio-beat-detector, tags and cover art are music-metadata — all MIT.
 * Nothing touches audio until the first play or load.
 */

const ZOOMS = [4, 8, 16, 32]; // seconds of track across the scrolling waveform

const TEXT_ENTRY = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function isTyping(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t instanceof HTMLInputElement && TEXT_ENTRY.has(t.type);
}

export default function App() {
  const [session] = useState(() => new DjSession());
  const [loop] = useState(() => new FrameLoop());
  const [zoom, setZoom] = useState(8);
  const root = useRef<HTMLDivElement>(null);
  const mixer = useStore(session.mixer);
  const still = usePrefersReducedMotion();
  const [deckA, deckB] = session.decks;

  useEffect(() => {
    void session.init();
    return () => {
      session.dispose();
      loop.stop();
    };
  }, [session, loop]);

  useEffect(() => {
    loop.setRunning(mixer.audio === 'running');
  }, [loop, mixer.audio]);

  // Before audio starts nothing animates, so a resize has to ask for a frame
  // or the canvases stay stretched at their old size.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => loop.kick());
    ro.observe(el);
    return () => ro.disconnect();
  }, [loop]);

  // Performance keys. Physical key codes, so the layout works on any keyboard
  // language. Only while focus is in the rig (or nowhere), never while typing,
  // and never in the playground's inert still preview.
  useEffect(() => {
    const [A, B] = session.decks;
    const handles = (e: KeyboardEvent) => {
      const r = root.current;
      if (!r || r.closest('[inert]')) return false;
      const t = e.target as Node | null;
      if (t && t !== document.body && t !== document.documentElement && !r.contains(t)) return false;
      return !isTyping(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey;
    };
    const hot = (deck: typeof A, i: number, shift: boolean) => (shift ? deck.clearHotCue(i) : deck.hotCue(i));
    const x = () => session.mixer.get().crossfader;

    const down = (e: KeyboardEvent) => {
      if (!handles(e)) return;
      const once = !e.repeat;
      const step = e.shiftKey ? 2 : 0.1;
      const map: Record<string, () => void> = {
        KeyQ: () => once && A.cueDown(),
        KeyP: () => once && B.cueDown(),
        KeyW: () => once && A.togglePlay(),
        KeyO: () => once && B.togglePlay(),
        KeyE: () => once && A.setSync(!A.store.get().sync),
        KeyI: () => once && B.setSync(!B.store.get().sync),
        KeyA: () => once && A.setBend(-1),
        KeyS: () => once && A.setBend(1),
        KeyK: () => once && B.setBend(-1),
        KeyL: () => once && B.setBend(1),
        KeyD: () => once && A.toggleLoop(),
        KeyJ: () => once && B.toggleLoop(),
        KeyZ: () => A.beatJump(-1),
        KeyX: () => A.beatJump(1),
        KeyN: () => B.beatJump(-1),
        KeyM: () => B.beatJump(1),
        Digit1: () => once && hot(A, 0, e.shiftKey),
        Digit2: () => once && hot(A, 1, e.shiftKey),
        Digit3: () => once && hot(A, 2, e.shiftKey),
        Digit4: () => once && hot(A, 3, e.shiftKey),
        Digit7: () => once && hot(B, 0, e.shiftKey),
        Digit8: () => once && hot(B, 1, e.shiftKey),
        Digit9: () => once && hot(B, 2, e.shiftKey),
        Digit0: () => once && hot(B, 3, e.shiftKey),
        BracketLeft: () => session.setCrossfader(x() - step),
        BracketRight: () => session.setCrossfader(x() + step),
        Backslash: () => session.setCrossfader(0),
      };
      const fn = map[e.code];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    const up = (e: KeyboardEvent) => {
      const map: Record<string, () => void> = {
        KeyQ: () => A.cueUp(),
        KeyP: () => B.cueUp(),
        KeyA: () => A.setBend(0),
        KeyS: () => A.setBend(0),
        KeyK: () => B.setBend(0),
        KeyL: () => B.setBend(0),
      };
      map[e.code]?.();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [session]);

  return (
    <div ref={root} data-dj-root className={s.root}>
      <TopBar session={session} loop={loop} />

      <div className={s.waves}>
        <div className={s.waveRow} data-deck="A">
          <span className={s.waveTag} aria-hidden="true">
            A
          </span>
          <ScrollingWave deck={deckA} loop={loop} zoom={zoom} label="Deck A waveform around the playhead" />
        </div>
        <div className={s.waveRow} data-deck="B">
          <span className={s.waveTag} aria-hidden="true">
            B
          </span>
          <ScrollingWave deck={deckB} loop={loop} zoom={zoom} label="Deck B waveform around the playhead" />
        </div>
        <div className={s.zoom} role="group" aria-label="Waveform zoom">
          <button
            type="button"
            className={s.mini}
            onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])}
            disabled={zoom === ZOOMS[0]}
            aria-label="Zoom in"
          >
            +
          </button>
          <span className={s.zoomValue}>{zoom}s</span>
          <button
            type="button"
            className={s.mini}
            onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)])}
            disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            aria-label="Zoom out"
          >
            −
          </button>
        </div>
      </div>

      <div className={s.stage}>
        <DeckPanel session={session} deck={deckA} loop={loop} still={still} />
        <Mixer session={session} loop={loop} />
        <DeckPanel session={session} deck={deckB} loop={loop} still={still} />
      </div>

      <Crate session={session} />

      <footer className={s.credits}>
        <p>
          Platter is open source (MIT). It stands on{' '}
          <a href="https://github.com/Signalsmith-Audio/signalsmith-stretch" target="_blank" rel="noopener noreferrer">
            Signalsmith Stretch
          </a>{' '}
          for key lock,{' '}
          <a href="https://github.com/chrisguttandin/web-audio-beat-detector" target="_blank" rel="noopener noreferrer">
            web-audio-beat-detector
          </a>{' '}
          for tempo and the beat grid, and{' '}
          <a href="https://github.com/Borewit/music-metadata" target="_blank" rel="noopener noreferrer">
            music-metadata
          </a>{' '}
          for tags and cover art, all MIT. The deck and mixer follow the conventions of{' '}
          <a href="https://mixxx.org" target="_blank" rel="noopener noreferrer">
            Mixxx
          </a>
          , the open-source DJ app.
        </p>
      </footer>
    </div>
  );
}
