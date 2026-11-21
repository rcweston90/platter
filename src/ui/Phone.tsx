import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Deck } from '../engine/deck';
import type { DjSession } from '../engine/session';
import type { Store } from '../engine/store';
import { PauseIcon, PlayIcon } from './icons';
import s from '../platter.module.css';

/**
 * The phone layout. A portrait phone can't show two decks, a mixer and a
 * sampler side by side, and a 6,000 px page of them is unplayable: by the
 * time you've scrolled to deck B, deck A's waveform is gone. So on a phone
 * the rig shows one thing at a time, chosen from a tab bar that stays pinned
 * under the waveforms, and the two controls a mix needs from either deck,
 * play and the crossfader, stay docked at the bottom, under the thumb.
 * Everything else is the same components as on a laptop, laid out by
 * platter.module.css under the same query.
 */

/** When the phone layout applies. Matches the media query in platter.module.css. */
export const PHONE_QUERY = '(max-width: 639px)';

export type PhoneFocus = 'A' | 'mix' | 'B' | 'pads';

/** True while the phone layout applies. */
export function usePhone() {
  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/** One field of a store, re-rendering only when that field changes. */
function useField<T extends object, V>(store: Store<T>, pick: (st: T) => V): V {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()), () => pick(store.get()));
}

function DeckTab({ deck, selected, onSelect }: { deck: Deck; selected: boolean; onSelect: () => void }) {
  const title = useField(deck.store, (st) => (st.loading ? 'Loading…' : st.track?.title ?? 'No track'));
  const playing = useField(deck.store, (st) => st.playing);
  return (
    <button
      type="button"
      role="tab"
      id={`phone-tab-${deck.label}`}
      aria-selected={selected}
      className={s.phoneTab}
      data-deck={deck.label}
      onClick={onSelect}
    >
      <span className={s.phoneTabBadge} aria-hidden="true">
        {deck.label}
      </span>
      <span className={s.phoneTabText}>
        <span className={s.srOnly}>Deck {deck.label}: </span>
        {title}
        {playing && <span className={s.srOnly}>, playing</span>}
      </span>
      {playing && <span className={s.phoneLive} aria-hidden="true" />}
    </button>
  );
}

/** The tab bar: deck A, the mixer, deck B and the pads. Each deck's tab names
 *  its track and shows when it's playing, so the other deck is never a mystery. */
export function PhoneTabs({
  session,
  focus,
  onFocus,
}: {
  session: DjSession;
  focus: PhoneFocus;
  onFocus: (f: PhoneFocus) => void;
}) {
  const [A, B] = session.decks;
  const order: PhoneFocus[] = ['A', 'mix', 'B', 'pads'];
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = order.indexOf(focus);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    const f = order[(next + order.length) % order.length];
    onFocus(f);
    document.getElementById(`phone-tab-${f}`)?.focus();
  };
  const plain = (id: 'mix' | 'pads', label: string) => (
    <button
      type="button"
      role="tab"
      id={`phone-tab-${id}`}
      aria-selected={focus === id}
      className={`${s.phoneTab} ${s.phoneTabPlain}`}
      onClick={() => onFocus(id)}
    >
      {label}
    </button>
  );
  return (
    <nav className={s.phoneTabs} aria-label="Rig">
      <div role="tablist" aria-label="Show" className={s.phoneTabList} onKeyDown={onKeyDown}>
        <DeckTab deck={A} selected={focus === 'A'} onSelect={() => onFocus('A')} />
        {plain('mix', 'Mix')}
        <DeckTab deck={B} selected={focus === 'B'} onSelect={() => onFocus('B')} />
        {plain('pads', 'Pads')}
      </div>
    </nav>
  );
}

function DockPlay({ deck }: { deck: Deck }) {
  const playing = useField(deck.store, (st) => st.playing);
  const loaded = useField(deck.store, (st) => !!st.track);
  return (
    <button
      type="button"
      className={s.dockPlay}
      data-deck={deck.label}
      aria-pressed={playing}
      disabled={!loaded}
      onClick={() => deck.togglePlay()}
      aria-label={`Deck ${deck.label} ${playing ? 'pause' : 'play'}`}
    >
      <span className={s.dockPlayLabel} aria-hidden="true">
        {deck.label}
      </span>
      {playing ? <PauseIcon /> : <PlayIcon />}
    </button>
  );
}

/** Docked along the bottom: each deck's play, and the crossfader between them. */
export function PhoneDock({ session }: { session: DjSession }) {
  const [A, B] = session.decks;
  const x = useField(session.mixer, (m) => m.crossfader);
  return (
    <div className={s.phoneDock} role="group" aria-label="Play and crossfade">
      <DockPlay deck={A} />
      <input
        type="range"
        className={`${s.xfader} ${s.dockXfader}`}
        min={-1}
        max={1}
        step={0.01}
        value={x}
        onChange={(e) => session.setCrossfader(Number(e.target.value))}
        onDoubleClick={() => session.setCrossfader(0)}
        aria-label="Crossfader"
        aria-valuetext={x === 0 ? 'centre' : x < 0 ? `${Math.round(-x * 100)}% to deck A` : `${Math.round(x * 100)}% to deck B`}
      />
      <DockPlay deck={B} />
    </div>
  );
}
