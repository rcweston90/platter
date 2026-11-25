
import { useEffect, useRef, useState } from 'react';
import { DjSession } from './engine/session';
import { useStore, useStoreSelect } from './engine/store';
import { Library } from './ui/Library';
import { DeckPanel } from './ui/DeckPanel';
import { FrameLoop } from './ui/frame';
import { usePrefersReducedMotion } from './ui/hooks';
import { Mixer } from './ui/Mixer';
import { SyncStrip } from './ui/SyncStrip';
import { WaveTag } from './ui/WaveTag';
import { TopBar } from './ui/TopBar';
import { MusicFlyout } from './ui/MusicFlyout';
import { PadsAndBeats } from './ui/beats/PadsAndBeats';
import { SoundsFlyout } from './ui/beats/SoundsFlyout';
import { CrateDock } from './ui/crate/CrateDock';
import { crateBrowser } from './ui/crate/model';
import { focusCrateSearch } from './ui/crate/TrackBrowser';
import { openBrowse } from './ui/browse';
import { cameBackFromSoundCloud } from './engine/soundcloud';
import { ScrollingWave } from './ui/Waveforms';
import { PitchLane } from './ui/PitchLane';
import { PitchIcon } from './ui/icons';
import { LIB_BAR, closeLibrary, libraryFlyout, openLibrary, toggleLibrary, useDocked } from './ui/library/dock';
import { useSheetSize } from './ui/library/Splitter';
import { Studio } from './slicer/studio';
import { SlicerView } from './ui/slicer/SlicerView';
import { PhoneDock, PhoneTabs, usePhone, type PhoneFocus } from './ui/Phone';
import { BoothGuide } from './guide/BoothGuide';
import s from './platter.module.css';

/**
 * Platter — two turntables, a two-channel club mixer and a crate, in the
 * browser. The playheads are a custom AudioWorklet (so records scratch and
 * run backwards); key lock is Signalsmith Stretch, tempo detection is
 * web-audio-beat-detector, tags and cover art are music-metadata — all MIT.
 * Nothing touches audio until the first play or load.
 */

const ZOOMS = [4, 8, 16, 32]; // seconds of track across the scrolling waveform
/** Whether the beat pitch lanes show (on unless turned off). */
const PITCH_KEY = 'platter.pitchLanes';

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
  const [pitchLanes, setPitchLanes] = useState(() => {
    try {
      return localStorage.getItem(PITCH_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const togglePitchLanes = () =>
    setPitchLanes((on) => {
      try {
        localStorage.setItem(PITCH_KEY, on ? 'off' : 'on');
      } catch {
        /* private mode: just this visit */
      }
      return !on;
    });
  const root = useRef<HTMLDivElement>(null);
  const pinned = useRef<HTMLDivElement>(null);
  const docked = useDocked();
  const phone = usePhone();
  const [focus, setFocus] = useState<PhoneFocus>('A');
  const [guideOpen, setGuideOpen] = useState(false);
  // The library flyout sits on the phone's play dock (see .phoneDock).
  const sheet = useSheetSize(pinned, phone ? 68 : 0);
  const { open: libOpen } = useStore(libraryFlyout);
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
    // Number keys play pads 1–4 of the bank each deck shows (there's no room
    // on the row for 5–8 without taking another key; 5 and 6 switch bank
    // instead, so all sixteen are in reach). Held for Gate mode;
    // the slot pressed is kept so a bank switch mid-hold lets go of it.
    const heldHot = new Map<string, [typeof A, number]>();
    const hot = (deck: typeof A, i: number, e: KeyboardEvent) => {
      const slot = deck.bankSlot(i);
      if (e.shiftKey) {
        deck.clearHotCue(slot);
        return;
      }
      heldHot.set(e.code, [deck, slot]);
      deck.hotCueDown(slot);
    };
    const x = () => session.mixer.get().crossfader;

    // A loop edge picked for adjusting takes ← and →, unless something with
    // its own use for arrows has focus (a fader, a knob, a list, the record).
    const edgeDeck = () => session.decks.find((d) => d.store.get().loop.active && d.store.get().loopEdge);
    const arrowsFree = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return false;
      const t = e.target;
      if (t === document.body || t === document.documentElement || t === null) return true;
      return t instanceof HTMLButtonElement && !t.hasAttribute('role');
    };

    const down = (e: KeyboardEvent) => {
      if (!handles(e)) return;
      const ed = (e.code === 'ArrowLeft' || e.code === 'ArrowRight') && arrowsFree(e) ? edgeDeck() : undefined;
      if (ed) {
        e.preventDefault();
        ed.nudgeLoopEdge(e.code === 'ArrowLeft' ? -1 : 1, e.shiftKey);
        return;
      }
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
        KeyD: () => once && (e.shiftKey ? A.reloop() : A.toggleLoop()),
        KeyJ: () => once && (e.shiftKey ? B.reloop() : B.toggleLoop()),
        KeyR: () => once && A.loopInDown(),
        KeyG: () => once && A.loopOut(),
        KeyU: () => once && B.loopInDown(),
        KeyY: () => once && B.loopOut(),
        KeyZ: () => A.beatJump(-1),
        KeyX: () => A.beatJump(1),
        KeyN: () => B.beatJump(-1),
        KeyM: () => B.beatJump(1),
        Digit1: () => once && hot(A, 0, e),
        Digit2: () => once && hot(A, 1, e),
        Digit3: () => once && hot(A, 2, e),
        Digit4: () => once && hot(A, 3, e),
        Digit5: () => once && A.toggleHotBank(),
        Digit6: () => once && B.toggleHotBank(),
        Digit7: () => once && hot(B, 0, e),
        Digit8: () => once && hot(B, 1, e),
        Digit9: () => once && hot(B, 2, e),
        Digit0: () => once && hot(B, 3, e),
        // Beat FX on deck A and deck B: F and H, either side of the mixer. B for the master (G is loop out on deck A).
        KeyF: () => once && session.fx.toggleFor('A'),
        KeyB: () => once && session.fx.toggleFor('M'),
        KeyH: () => once && session.fx.toggleFor('B'),
        KeyC: () => once && A.censor(true),
        Comma: () => once && B.censor(true),
        KeyV: () => once && A.setSlip(!A.store.get().slip),
        Period: () => once && B.setSlip(!B.store.get().slip),
        BracketLeft: () => session.setCrossfader(x() - step),
        BracketRight: () => session.setCrossfader(x() + step),
        Backslash: () => session.setCrossfader(0),
        // The track list, from anywhere: the mini window's search when it's
        // out, else the library's, opening the library on the crate.
        Slash: () => {
          if (!once || e.shiftKey) return;
          if (crateBrowser.get().view === 'page') openLibrary('crate');
          requestAnimationFrame(() => focusCrateSearch());
        },
        KeyT: () => once && toggleLibrary(),
        // Esc puts the library away from anywhere in the rig (inside it, the
        // library handles Esc itself, after its search and menus).
        ...(libraryFlyout.get().open
          ? { Escape: () => closeLibrary() }
          : edgeDeck()
            ? { Escape: () => edgeDeck()?.selectLoopEdge(null) }
            : {}),
      };
      const fn = map[e.code];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    const up = (e: KeyboardEvent) => {
      const held = heldHot.get(e.code);
      if (held) {
        heldHot.delete(e.code);
        held[0].hotCueUp(held[1]);
      }
      const map: Record<string, () => void> = {
        KeyQ: () => A.cueUp(),
        KeyP: () => B.cueUp(),
        KeyA: () => A.setBend(0),
        KeyS: () => A.setBend(0),
        KeyK: () => B.setBend(0),
        KeyL: () => B.setBend(0),
        KeyC: () => A.censor(false),
        Comma: () => B.censor(false),
        KeyR: () => A.loopInUp(),
        KeyU: () => B.loopInUp(),
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
    <div ref={phone ? undefined : pinned} className={s.waves}>
      <div className={s.waveRow} data-deck="A">
        {pitchLanes && <PitchLane deck={deckA} hits={session.hits[0]} loop={loop} zoom={zoom} />}
        <div className={s.waveBox}>
          <WaveTag deck={deckA} />
          <ScrollingWave deck={deckA} loop={loop} zoom={zoom} label="Deck A waveform around the playhead" />
        </div>
      </div>
      <SyncStrip decks={session.decks} loop={loop} zoom={zoom} />
      <div className={s.waveRow} data-deck="B">
        <div className={s.waveBox}>
          <WaveTag deck={deckB} />
          <ScrollingWave deck={deckB} loop={loop} zoom={zoom} label="Deck B waveform around the playhead" />
        </div>
        {pitchLanes && <PitchLane deck={deckB} hits={session.hits[1]} loop={loop} zoom={zoom} />}
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
        <button
          type="button"
          className={`${s.mini} ${s.pitchToggle}`}
          onClick={togglePitchLanes}
          aria-pressed={pitchLanes}
          aria-label="Beat pitch: show each hit, higher or lower"
          title="Beat pitch"
        >
          <PitchIcon />
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
      // What the library flyout covers at the bottom, so the rig (or page)
      // can scroll everything above it.
      style={{ '--lib-reserve': `${libOpen ? sheet.height : LIB_BAR}px`, ...(slicing ? { display: 'none' } : {}) } as React.CSSProperties}
    >
      <TopBar session={session} loop={loop} onSlicer={() => void studio.open()} guide={{ open: guideOpen, toggle: () => setGuideOpen((o) => !o) }} />

      {phone ? (
        <div ref={pinned} className={s.phoneTop}>
          {waves}
          <PhoneTabs session={session} focus={focus} onFocus={setFocus} />
        </div>
      ) : (
        waves
      )}

      <div className={s.rig}>
        <div className={s.stage}>
          <DeckPanel session={session} deck={deckA} loop={loop} still={still} />
          <Mixer session={session} loop={loop} />
          <DeckPanel session={session} deck={deckB} loop={loop} still={still} />
        </div>

        <PadsAndBeats session={session} loop={loop} />
        {docked && credits}
      </div>

      {!docked && credits}
      <Library session={session} height={sheet.height} max={sheet.max} />
      <MusicFlyout session={session} />
      <SoundsFlyout session={session} />
      <CrateDock session={session} />
    </div>
    {/* Outside the root on purpose: see .phoneDock in platter.module.css. */}
    {phone && !slicing && <PhoneDock session={session} />}
    {/* The booth guide, outside the root too: the rig's keys stay out of its chat. */}
    <BoothGuide
      session={session}
      open={guideOpen && !slicing}
      onClose={() => setGuideOpen(false)}
      onReveal={(area) => phone && area !== 'top' && setFocus(area)}
    />
    {slicing && <SlicerView studio={studio} session={session} loop={loop} />}
    </>
  );
}
