
import { useEffect, useRef, useState } from 'react';
import { DjSession } from './engine/session';
import { useStore, useStoreSelect } from './engine/store';
import { Library } from './ui/Library';
import { DeckPanel } from './ui/DeckPanel';
import { FrameLoop } from './ui/frame';
import { usePrefersReducedMotion } from './ui/hooks';
import { Mixer } from './ui/Mixer';
import { PhaseMeter } from './ui/PhaseMeter';
import { TopBar } from './ui/TopBar';
import { MusicFlyout } from './ui/MusicFlyout';
import { PadsAndBeats } from './ui/beats/PadsAndBeats';
import { SoundsFlyout } from './ui/beats/SoundsFlyout';
import { CrateDock, openCrate } from './ui/crate/CrateDock';
import { crateBrowser } from './ui/crate/model';
import { focusCrateSearch } from './ui/crate/TrackBrowser';
import { openBrowse } from './ui/browse';
import { cameBackFromSoundCloud } from './engine/soundcloud';
import { ScrollingWave } from './ui/Waveforms';
import { DOCK_QUERY, useDocked } from './ui/library/dock';
import { Splitter, useDockSize } from './ui/library/Splitter';
import { Studio } from './slicer/studio';
import { SlicerView } from './ui/slicer/SlicerView';
import { PhoneDock, PhoneTabs, usePhone, type PhoneFocus } from './ui/Phone';
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
  const [studio] = useState(() => new Studio(session));
  const { open: slicing } = useStore(studio.store);
  const [zoom, setZoom] = useState(8);
  const root = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const docked = useDocked();
  const phone = usePhone();
  const [focus, setFocus] = useState<PhoneFocus>('A');
  const dock = useDockSize(rig, docked);
  // Only the audio state: subscribing to the whole mixer re-rendered the
  // entire rig on every fader and knob movement.
  const audio = useStoreSelect(session.mixer, (m) => m.audio);
  const still = usePrefersReducedMotion();
  const [deckA, deckB] = session.decks;

  useEffect(() => {
    // The rig, reachable from the browser console (and the end-to-end tests).
    (window as unknown as { platter: DjSession }).platter = session;
    (window as unknown as { platterSlicer: Studio }).platterSlicer = studio;
    void session.init();
    return () => {
      studio.dispose();
      session.dispose();
      loop.stop();
    };
  }, [session, loop, studio]);

  useEffect(() => {
    loop.setRunning(audio === 'running');
  }, [loop, audio]);

  // Before audio starts nothing animates, so a resize has to ask for a frame
  // or the canvases stay stretched at their old size.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => loop.kick());
    ro.observe(el);
    return () => ro.disconnect();
  }, [loop]);

  // Nothing animates before audio starts, so a deck that gets its track (and
  // its waveform) after the first frame has to ask for one, or its waveforms
  // stay black until the first play. The phone's tabs bring a hidden deck's
  // canvases back at a new size, which also needs a frame.
  useEffect(() => {
    const offs = session.decks.map((d) => d.store.subscribe(() => loop.kick()));
    return () => offs.forEach((off) => off());
  }, [session, loop]);
  useEffect(() => loop.kick(), [loop, focus, phone]);

  // Back from SoundCloud's sign-in page: carry on where it started, in the flyout.
  useEffect(() => {
    if (cameBackFromSoundCloud()) openBrowse('soundcloud');
  }, []);

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
    const toggleFx = (i: 0 | 1) => {
      const fx = session.mixer.get().channels[i].fx;
      session.setChannel(i, { fx: { ...fx, on: !fx.on } });
    };

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
        KeyF: () => once && toggleFx(0),
        KeyH: () => once && toggleFx(1),
        KeyC: () => once && A.censor(true),
        Comma: () => once && B.censor(true),
        KeyV: () => once && A.setSlip(!A.store.get().slip),
        Period: () => once && B.setSlip(!B.store.get().slip),
        BracketLeft: () => session.setCrossfader(x() - step),
        BracketRight: () => session.setCrossfader(x() + step),
        Backslash: () => session.setCrossfader(0),
        // The track list, from anywhere: the library's search when it's
        // docked in view, else the mini window (or its search if it's open).
        Slash: () => {
          if (!once || e.shiftKey) return;
          if (crateBrowser.get().view !== 'page' || window.matchMedia(DOCK_QUERY).matches) focusCrateSearch();
          else openCrate('mini');
        },
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
        KeyC: () => A.censor(false),
        Comma: () => B.censor(false),
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

  const credits = (
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
            for tags and cover art, all MIT. Streaming is{' '}
            <a href="https://audius.co" target="_blank" rel="noopener noreferrer">
              Audius
            </a>
            ’s open API, and your own and remix-licensed tracks from{' '}
            <a href="https://soundcloud.com" target="_blank" rel="noopener noreferrer">
              SoundCloud
            </a>
            . The deck and mixer follow the conventions of{' '}
            <a href="https://mixxx.org" target="_blank" rel="noopener noreferrer">
              Mixxx
            </a>
            , the open-source DJ app. The sampler's recorded sounds are from{' '}
            <a href="https://github.com/sonic-pi-net/sonic-pi" target="_blank" rel="noopener noreferrer">
              Sonic Pi
            </a>
            ’s public-domain (CC0) sample set, by Freesound contributors, and the beat board keeps time the way Chris Wilson’s{' '}
            <a href="https://github.com/cwilso/metronome" target="_blank" rel="noopener noreferrer">
              metronome
            </a>{' '}
            (MIT) does.
          </p>
        </footer>
  );

  const waves = (
    <div className={s.waves}>
      <div className={s.waveRow} data-deck="A">
        <span className={s.waveTag} aria-hidden="true">
          A
        </span>
        <ScrollingWave deck={deckA} loop={loop} zoom={zoom} label="Deck A waveform around the playhead" />
      </div>
      <PhaseMeter decks={session.decks} loop={loop} />
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
  );

  return (
    <>
    <div
      ref={root}
      data-dj-root
      data-docked={docked || undefined}
      data-phone={phone || undefined}
      data-focus={phone ? focus : undefined}
      className={s.root}
      // The slicer covers the rig: it's inert (no keys, no focus) and not drawn
      // underneath, while the decks keep playing.
      inert={slicing || undefined}
      style={{ ...(docked ? ({ '--dock-h': `${dock.height}px` } as React.CSSProperties) : {}), ...(slicing ? { display: 'none' } : {}) }}
    >
      <TopBar session={session} loop={loop} onSlicer={() => void studio.open()} />

      {phone ? (
        <div className={s.phoneTop}>
          {waves}
          <PhoneTabs session={session} focus={focus} onFocus={setFocus} />
        </div>
      ) : (
        waves
      )}

      <div ref={rig} className={s.rig}>
        <div className={s.stage}>
          <DeckPanel session={session} deck={deckA} loop={loop} still={still} />
          <Mixer session={session} loop={loop} />
          <DeckPanel session={session} deck={deckB} loop={loop} still={still} />
        </div>

        <PadsAndBeats session={session} loop={loop} />
        {docked && credits}
      </div>

      {docked && <Splitter height={dock.height} max={dock.max} rig={rig} />}
      <Library session={session} docked={docked} />
      {!docked && credits}
      <MusicFlyout session={session} />
      <SoundsFlyout session={session} />
      <CrateDock session={session} />
    </div>
    {/* Outside the root on purpose: see .phoneDock in platter.module.css. */}
    {phone && !slicing && <PhoneDock session={session} />}
    {slicing && <SlicerView studio={studio} session={session} loop={loop} />}
    </>
  );
}
