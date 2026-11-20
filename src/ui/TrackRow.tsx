import type { ReactNode } from 'react';
import s from '../platter.module.css';

export interface TrackRowProps {
  title: string;
  artist: string;
  artwork: string | null;
  /** Short facts after the artist: duration, genre, tempo, licence. */
  meta: string[];
  /** A one-word status, e.g. whether the track can go on the decks. */
  badge?: { text: string; tone: 'go' | 'muted' };
  /** A line of explanation under the meta (why a track can't load). */
  note?: string | null;
  /** Deck buttons; leave out when the track can't load. */
  load?: { a: () => void; b: () => void; add: () => void; aDisabled: boolean; bDisabled: boolean };
  link: string;
  linkLabel: string;
  /** Accessible name for the link: "<title> by <artist> on <service>". */
  linkName: string;
  extra?: ReactNode;
}

/** One track from an online source, laid out for scanning: art, title, artist, facts, then what you can do with it. */
export function TrackRow(p: TrackRowProps) {
  return (
    <li className={s.trackRow}>
      {p.artwork ? <img src={p.artwork} alt="" className={s.trackArt} loading="lazy" /> : <span className={s.trackArt} aria-hidden="true" />}
      <div className={s.trackInfo}>
        <span className={s.trackRowTitle} title={p.title}>
          {p.title}
        </span>
        <span className={s.trackRowArtist}>{p.artist || 'Unknown artist'}</span>
        <span className={s.trackFacts}>
          {p.badge && (
            <span className={s.badge} data-tone={p.badge.tone}>
              {p.badge.text}
            </span>
          )}
          {p.meta.filter(Boolean).map((m) => (
            <span key={m}>{m}</span>
          ))}
        </span>
        {p.note && <span className={s.trackNote}>{p.note}</span>}
      </div>
      <div className={s.trackActions}>
        {p.load && (
          <>
            <button type="button" className={s.loadBtn} data-deck="A" disabled={p.load.aDisabled} onClick={p.load.a} aria-label={`Load ${p.title} on deck A`}>
              A
            </button>
            <button type="button" className={s.loadBtn} data-deck="B" disabled={p.load.bDisabled} onClick={p.load.b} aria-label={`Load ${p.title} on deck B`}>
              B
            </button>
            <button type="button" className={s.loadBtn} onClick={p.load.add} aria-label={`Add ${p.title} to the crate`} title="Add to the crate">
              +
            </button>
          </>
        )}
        <a className={s.trackLink} href={p.link} target="_blank" rel="noopener noreferrer" aria-label={p.linkName}>
          {p.linkLabel}
        </a>
        {p.extra}
      </div>
    </li>
  );
}
