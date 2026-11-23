import { useEffect, useId, useMemo, useState } from 'react';
import { createStore } from '../../engine/store';
import { keyName } from '../../engine/key';
import type { DjSession } from '../../engine/session';
import { warmProps } from '../warm';
import { useStore, useStoreSelect } from '../../engine/store';
import { suggestMatches, verdict, type EnergyDirection, type Match, type MixTrack } from '../../library/mashup';
import { useRig } from '../crate/rig';
import { TRACK_MIME } from '../DeckPanel';
import { SoundMatchBar } from './SoundMatchBar';
import s from '../../platter.module.css';
import m from './mashups.module.css';
import u from './upnext.module.css';

/**
 * Up next: for the track you're mixing out of (the playing deck, or the one
 * the crossfader favours), the tracks that would follow it best, with the
 * reasons, and a button to load one on the other deck. It reads the deck as
 * it is now: tempo with the pitch fader, key with any key shift.
 */

const DIRECTIONS: { id: EnergyDirection; label: string; title: string }[] = [
  { id: 'any', label: 'Any', title: 'Close energy either way' },
  { id: 'hold', label: 'Keep it level', title: 'Stay at about the same energy' },
  { id: 'build', label: 'Build', title: 'Step the energy up one or two' },
  { id: 'drop', label: 'Bring it down', title: 'Step the energy down one or two' },
];

const VERDICT_LABEL = { great: 'Great', good: 'Good', possible: 'Possible', stretch: 'Stretch' } as const;
const SHOW = 8;
const RAIL_SHOW = 12;

/** Up next's options, shared by the tab and the rail beside the crate. */
const prefs = createStore<{ direction: EnergyDirection; skipPlayed: boolean; stretch: number }>({ direction: 'any', skipPlayed: true, stretch: 6 });

function fmtBpm(n: number) {
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

function signed(n: number, places = 1) {
  const v = n.toFixed(places);
  return n > 0 ? `+${v}` : n < 0 ? `−${v.slice(1)}` : v;
}

/** What Up next ranks against and what it suggests, read from the decks as they are now. */
function useUpNext(session: DjSession, limit: number) {
  const { tracks, loaded } = useStore(session.crate);
  const { revision } = useStore(session.sound.store);
  const { ids: played } = useStore(session.sound.played);
  const { direction, skipPlayed, stretch } = useStore(prefs);
  const rig = useRig(session);
  const [busy, setBusy] = useState(false);

  const refIdx = rig.ref ? (rig.ref.deck === 'A' ? 0 : 1) : null;
  const deckTracks = [session.decks[0].store.get().track?.id ?? null, session.decks[1].store.get().track?.id ?? null];
  const seedId = refIdx === null ? null : deckTracks[refIdx];
  const seedRec = seedId ? (tracks.find((t) => t.id === seedId) ?? null) : null;

  const pool = useMemo<MixTrack[]>(
    () => tracks.map((t) => session.library.toMixTrack(t)),
    // revision: a new sound print re-ranks.
    [tracks, session, revision],
  );

  const seed = useMemo<MixTrack | null>(() => {
    if (!seedRec || !rig.ref) return null;
    // The deck as it sounds now: tempo with the fader, key with the shift.
    return { ...session.library.toMixTrack(seedRec), bpm: rig.ref.bpm ?? seedRec.bpm, key: rig.ref.key ?? seedRec.key };
  }, [seedRec, rig.ref?.bpm, rig.ref?.key, session, revision]);

  const exclude = useMemo(() => {
    const out = new Set<string>(deckTracks.filter((x): x is string => !!x));
    if (skipPlayed) for (const id of played) out.add(id);
    return out;
  }, [deckTracks[0], deckTracks[1], played, skipPlayed]);

  const matches = useMemo<Match[]>(
    () => (seed ? suggestMatches(seed, pool, { direction, exclude, maxStretchPct: stretch, limit }) : []),
    [seed, pool, direction, exclude, stretch, limit],
  );

  // The best match is the likeliest next load: decode it ahead, once audio is on.
  const top = matches[0]?.track.id ?? null;
  const audioOn = useStoreSelect(session.mixer, (m) => m.audio === 'running');
  useEffect(() => {
    if (top && audioOn) session.warmTrack(top);
  }, [top, audioOn, session]);

  const load = async (id: string, deck: 0 | 1) => {
    setBusy(true);
    try {
      await session.loadToDeck(id, deck);
    } finally {
      setBusy(false);
    }
  };

  return { loaded, rig, seed, seedRec, matches, busy, load, direction, skipPlayed, stretch };
}

export function UpNextPanel({ session, variant = 'tab', onMore }: { session: DjSession; variant?: 'tab' | 'rail'; onMore?: () => void }) {
  if (variant === 'rail') return <UpNextRail session={session} onMore={onMore} />;
  return <UpNextTab session={session} />;
}

function UpNextTab({ session }: { session: DjSession }) {
  const { loaded, rig, seed, seedRec, matches, busy, load, direction, skipPlayed, stretch } = useUpNext(session, SHOW);
  const stretchId = useId();
  const target = rig.target;

  const soundOn = !!seed?.sound;
  const seedSoundNote =
    seed && !seed.sound && session.sound.on && seedRec && !seedRec.soundcloud && !seedRec.audius && !seedRec.demo ? 'Sound match hasn’t listened to this track yet; it goes first.' : null;

  return (
    <div className={`${s.panelBody} ${m.panel}`}>
      <header className={m.head}>
        <h2 className={s.srOnly}>Up next</h2>
        <SoundMatchBar sound={session.sound} />
      </header>

      {!loaded ? null : !seed || !rig.ref ? (
        <p className={s.crateEmpty}>Load a track on a deck: what would follow it best shows here, with the reasons.</p>
      ) : (
        <section className={m.mixPane} aria-label={`Up next after ${seed.title}`}>
          <div className={m.seed}>
            <div className={m.seedInfo}>
              <span className={m.facts}>
                <span>
                  After deck <b>{rig.ref.deck}</b>
                </span>
              </span>
              <span className={`${s.rowTitle} ${m.seedTitle} ${m.clip}`}>{seed.title}</span>
              <span className={`${m.artist} ${m.clip}`}>{seed.artist || 'Unknown artist'}</span>
              <span className={m.facts}>
                <span>{seed.bpm ? `${seed.bpm.toFixed(1)} BPM` : 'BPM unknown'}</span>
                <span>{seed.key ? `${seed.key} · ${keyName(seed.key)}` : 'Key unknown'}</span>
                <span>{seed.energy != null ? `Energy ${seed.energy}/10` : 'Energy unknown'}</span>
                <span>{soundOn ? 'Sound matched' : 'Key, tempo and energy only'}</span>
              </span>
            </div>
          </div>

          <div className={m.mixOpts}>
            <div className={m.directions} role="group" aria-label="Where the energy should go">
              {DIRECTIONS.map((d) => (
                <button key={d.id} type="button" className={s.toggle} aria-pressed={direction === d.id} title={d.title} onClick={() => prefs.set({ direction: d.id })}>
                  {d.label}
                </button>
              ))}
            </div>
            <div className={m.field}>
              <label htmlFor={stretchId}>Stretch reach</label>
              <select id={stretchId} className={m.select} value={stretch} onChange={(e) => prefs.set({ stretch: Number(e.target.value) })}>
                {[3, 6, 8, 10].map((n) => (
                  <option key={n} value={n}>
                    ±{n}%
                  </option>
                ))}
              </select>
            </div>
            <label className={s.switch}>
              <input type="checkbox" checked={skipPlayed} onChange={(e) => prefs.set({ skipPlayed: e.target.checked })} />
              Skip tracks played this session
            </label>
          </div>
          {seedSoundNote && <p className={m.warn}>{seedSoundNote}</p>}
          {(!seed.bpm || !seed.key) && <p className={m.warn}>This track's {!seed.bpm ? 'tempo' : 'key'} isn’t known yet, so these are rough guesses.</p>}

          {!matches.length ? (
            <p className={m.empty}>Nothing in the crate within ±{stretch}% of {seed.bpm ? fmtBpm(seed.bpm) : 'this'} BPM. Widen the stretch reach, or add more music.</p>
          ) : (
            <ol className={m.matches} aria-label={`Tracks to play after ${seed.title}, best first`}>
              {matches.map((mt) => (
                <NextCard key={mt.track.id} match={mt} seed={seed} target={target} busy={busy} playing={rig.playing} onLoad={(d) => void load(mt.track.id, d)} warm={warmProps(session, mt.track.id)} />
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

function NextCard(p: { match: Match; seed: MixTrack; target: 0 | 1 | null; busy: boolean; playing: [boolean, boolean]; onLoad: (d: 0 | 1) => void; warm?: ReturnType<typeof warmProps> }) {
  const { match: mt, seed } = p;
  const v = verdict(mt.score);
  const t = mt.track;
  const pct = Math.round(mt.score * 100);
  const keyBit = seed.key && t.key ? `${seed.key} → ${t.key}` : null;
  const tempoBit =
    seed.bpm && t.bpm ? `${fmtBpm(t.bpm)} BPM${mt.stretchPct != null && Math.abs(mt.stretchPct) >= 0.05 ? ` (${signed(mt.stretchPct)}%)` : ''}` : null;
  const energyBit = seed.energy != null && t.energy != null ? `energy ${seed.energy} → ${t.energy}` : null;
  const decks = p.target === null ? [] : [p.target];
  return (
    <li
      className={m.card}
      data-verdict={v}
      {...p.warm}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TRACK_MIME, t.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className={m.cardHead}>
        <div className={m.cardInfo}>
          <span className={`${s.rowTitle} ${m.clip}`}>{t.title}</span>
          <span className={`${m.artist} ${m.clip}`}>{t.artist || 'Unknown artist'}</span>
        </div>
        <span className={m.verdict} data-verdict={v}>
          {VERDICT_LABEL[v]}
        </span>
      </div>
      <div className={m.scoreRow}>
        <span className={m.scoreBar} aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className={m.scoreNum}>
          {pct}
          <span className={s.srOnly}> out of 100</span>
        </span>
      </div>
      <p className={m.summary}>
        {keyBit && <span>{keyBit}</span>}
        {mt.keyShift !== 0 && <span className={m.tag}>shift {signed(mt.keyShift, 0)}</span>}
        {tempoBit && <span>{tempoBit}</span>}
        {mt.tempoRelation !== 'same' && <span className={m.tag}>{mt.tempoRelation === 'half' ? '½×' : '2×'}</span>}
        {energyBit && <span>{energyBit}</span>}
        {mt.soundScore != null && (
          <span className={m.tag} title="How close it sounds, against the rest of your library (100 = the closest)">
            sound {Math.round(mt.soundScore * 100)}
          </span>
        )}
      </p>
      <ul className={m.reasons}>
        {mt.reasons.slice(0, 3).map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div className={m.cardActions}>
        {decks.length ? (
          decks.map((d) => (
            <button
              key={d}
              type="button"
              className={`${s.action} ${m.pairBtn}`}
              disabled={p.busy || p.playing[d]}
              onClick={() => p.onLoad(d)}
              aria-label={`Load ${t.title} on deck ${d === 0 ? 'A' : 'B'}`}
            >
              Load on {d === 0 ? 'A' : 'B'}
            </button>
          ))
        ) : (
          <span className={m.artist}>Both decks are playing</span>
        )}
      </div>
    </li>
  );
}

const MOVE: Partial<Record<Match['keyRelation'], string>> = {
  same: 'same key',
  relative: 'relative',
  'fifth-up': '+1',
  'fifth-down': '−1',
  diagonal: 'diagonal',
  'boost-2': '+2 boost',
  semitone: 'semitone',
};

const SHORT_DIRECTIONS: { id: EnergyDirection; label: string; title: string }[] = [
  { id: 'any', label: 'Any', title: 'Close energy either way' },
  { id: 'hold', label: 'Level', title: 'Stay at about the same energy' },
  { id: 'build', label: 'Build', title: 'Step the energy up one or two' },
  { id: 'drop', label: 'Down', title: 'Step the energy down one or two' },
];

/**
 * Up next as a rail beside the crate: the seed, where the energy should go,
 * and a dense ranked list where every row says why in three signals
 * (Camelot move, tempo change, energy step) and loads to A or B in one
 * press, or drags onto a deck. The tab has the reasons in full and the
 * other options.
 */
function UpNextRail({ session, onMore }: { session: DjSession; onMore?: () => void }) {
  const { loaded, rig, seed, matches, busy, load, direction } = useUpNext(session, RAIL_SHOW);
  const ref = rig.ref;
  if (!loaded) return null;
  if (!seed || !ref) {
    return (
      <div className={u.rail}>
        <p className={u.kicker}>Up next</p>
        <p className={u.hint}>Load a track on a deck and the tracks that would follow it best line up here, with why.</p>
      </div>
    );
  }
  return (
    <section className={u.rail} aria-label={`Up next after ${seed.title}`}>
      <header className={u.head}>
        <p className={u.kicker}>
          Up next after <span className={u.deck} data-deck={ref.deck}>{ref.deck}</span>
        </p>
        <p className={u.seedTitle} title={seed.title}>
          {seed.title}
        </p>
        <p className={u.seedFacts}>
          <span>{seed.bpm ? fmtBpm(seed.bpm) : '—'}</span>
          <span>{seed.key ?? '—'}</span>
          {seed.energy != null && <span>E{seed.energy}</span>}
          {seed.sound && <span title="Sound match is weighing how they sound together">sound</span>}
        </p>
        <div className={u.seg} role="group" aria-label="Where the energy should go">
          {SHORT_DIRECTIONS.map((d) => (
            <button key={d.id} type="button" aria-pressed={direction === d.id} title={d.title} onClick={() => prefs.set({ direction: d.id })}>
              {d.label}
            </button>
          ))}
        </div>
      </header>
      {!matches.length ? (
        <p className={u.hint}>Nothing in the crate mixes with this within reach. Try another energy, or widen the stretch in the full view.</p>
      ) : (
        <ol className={u.list} aria-label={`Tracks to play after ${seed.title}, best first`}>
          {matches.map((mt) => (
            <RailRow key={mt.track.id} match={mt} seed={seed} target={rig.target} playing={rig.playing} busy={busy} onLoad={(d) => void load(mt.track.id, d)} warm={warmProps(session, mt.track.id)} />
          ))}
        </ol>
      )}
      {onMore && (
        <button type="button" className={u.more} onClick={onMore}>
          Reasons and options
        </button>
      )}
    </section>
  );
}

function RailRow(p: { match: Match; seed: MixTrack; target: 0 | 1 | null; playing: [boolean, boolean]; busy: boolean; onLoad: (d: 0 | 1) => void; warm?: ReturnType<typeof warmProps> }) {
  const { match: mt, seed } = p;
  const t = mt.track;
  const v = verdict(mt.score);
  const pct = Math.round(mt.score * 100);
  const move = MOVE[mt.keyRelation];
  const shifted = mt.keyShift !== 0;
  const stretch = mt.stretchPct;
  const eStep = seed.energy != null && t.energy != null ? t.energy - seed.energy : null;
  const keyOk = mt.keyScore >= 0.8 || shifted;
  const tempoOk = stretch != null && Math.abs(stretch) <= 3;
  return (
    <li
      className={u.row}
      data-verdict={v}
      {...p.warm}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TRACK_MIME, t.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        if (p.target !== null && !p.playing[p.target]) p.onLoad(p.target);
      }}
      title={mt.reasons.join(' ')}
    >
      <span className={u.score} data-verdict={v} style={{ '--s': mt.score } as React.CSSProperties} aria-label={`${VERDICT_LABEL[v]} match, ${pct} out of 100`}>
        {pct}
      </span>
      <span className={u.info}>
        <span className={u.title}>{t.title}</span>
        <span className={u.artist}>{t.artist || 'Unknown artist'}</span>
        <span className={u.signals}>
          {t.key && (
            <span className={u.sig} data-ok={keyOk} title={shifted ? `Shift its key ${signed(mt.keyShift, 0)} with key lock to mix` : undefined}>
              {seed.key ? `${t.key} ${shifted ? `shift ${signed(mt.keyShift, 0)}` : (move ?? '')}`.trim() : t.key}
            </span>
          )}
          {t.bpm && (
            <span className={u.sig} data-ok={tempoOk}>
              {fmtBpm(t.bpm)}
              {mt.tempoRelation !== 'same' ? (mt.tempoRelation === 'half' ? ' ½×' : ' 2×') : ''}
              {stretch != null && Math.abs(stretch) >= 0.05 ? ` ${signed(stretch)}%` : ''}
            </span>
          )}
          {eStep !== null && (
            <span className={u.sig} data-ok={Math.abs(eStep) <= 2} title={`Energy ${seed.energy} → ${t.energy}`}>
              E{t.energy}
              {eStep > 0 ? ' ↑' : eStep < 0 ? ' ↓' : ' ='}
            </span>
          )}
          {mt.soundScore != null && (
            <span className={u.sig} data-ok={mt.soundScore >= 0.6} title="How close it sounds, against the rest of your library (100 = the closest)">
              sound {Math.round(mt.soundScore * 100)}
            </span>
          )}
        </span>
      </span>
      <span className={u.loads}>
        {([0, 1] as const).map((d) => {
          const L = d === 0 ? 'A' : 'B';
          return (
            <button
              key={L}
              type="button"
              className={u.load}
              data-deck={L}
              data-target={p.target === d || undefined}
              disabled={p.busy || p.playing[d]}
              onClick={() => p.onLoad(d)}
              aria-label={`Load ${t.title} on deck ${L}`}
              title={p.playing[d] ? `Deck ${L} is playing` : `Load on deck ${L}`}
            >
              {L}
            </button>
          );
        })}
      </span>
    </li>
  );
}
