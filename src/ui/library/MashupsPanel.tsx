import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { compatible, keyName } from '../../engine/key';
import { canLinkFolder } from '../../engine/folder';
import type { DjSession } from '../../engine/session';
import { useStore } from '../../engine/store';
import type { TrackRecord } from '../../engine/types';
import { suggestMatches, verdict, type Match, type MixTrack } from '../../library/mashup';
import { TRACK_MIME } from '../DeckPanel';
import { formatTime } from '../Waveforms';
import s from '../../platter.module.css';
import m from './mashups.module.css';

/**
 * The Mashups tab: the whole library with what the analysis found (tempo, key,
 * energy, loudness, tags), filters a DJ reaches for, and — for the track you
 * pick — the tracks that mix or mash with it, best first, with the reasons.
 */

type SortKey = 'title' | 'bpm' | 'key' | 'energy' | 'lufs' | 'genre' | 'year' | 'duration';

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'title', label: 'Title / Artist' },
  { key: 'bpm', label: 'BPM', className: s.colNum },
  { key: 'key', label: 'Key', className: s.colNum },
  { key: 'energy', label: 'Energy', className: m.colEnergy },
  { key: 'lufs', label: 'LUFS', className: `${s.colNum} ${m.colWide}` },
  { key: 'genre', label: 'Genre', className: m.colWide },
  { key: 'year', label: 'Year', className: `${s.colNum} ${m.colWide}` },
  { key: 'duration', label: 'Time', className: `${s.colNum} ${m.colWide}` },
];

const CAMELOT = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();
const STRETCHES = [3, 6, 8, 10];
const PAGE = 300;
const LOW_BPM_CONFIDENCE = 0.35;

/** A crate track with everything the table sorts and filters on, worked out once. */
interface Item {
  rec: TrackRecord;
  mix: MixTrack;
  energy: number | null;
  lufs: number | null;
  genre: string | null;
  year: number | null;
  /** Lower-cased title, artist, album, genre, label and file name. */
  text: string;
  /** Other tempo readings worth trying, when the chosen one is unsure. */
  bpmDoubt: string | null;
}

const keyOrder = (k: string | null) => (k ? parseInt(k, 10) * 2 + (k.endsWith('B') ? 1 : 0) : Infinity);
const nullsLast = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);
const textLast = (a: string | null, b: string | null) => (a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0);

function compare(a: Item, b: Item, key: SortKey) {
  switch (key) {
    case 'title':
      return a.rec.title.localeCompare(b.rec.title) || a.rec.artist.localeCompare(b.rec.artist);
    case 'bpm':
      return nullsLast(a.rec.bpm, b.rec.bpm);
    case 'key':
      return keyOrder(a.rec.key) - keyOrder(b.rec.key);
    case 'energy':
      return nullsLast(a.energy, b.energy);
    case 'lufs':
      return nullsLast(a.lufs, b.lufs);
    case 'genre':
      return textLast(a.genre, b.genre);
    case 'year':
      return nullsLast(a.year, b.year);
    case 'duration':
      return a.rec.duration - b.rec.duration;
  }
}

function fmtBpm(n: number) {
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

function bpmDoubt(rec: TrackRecord): string | null {
  const a = rec.library?.analysis;
  if (!a || !rec.bpm || a.bpmConfidence >= LOW_BPM_CONFIDENCE) return null;
  const others = a.bpmCandidates
    .map((c) => c.bpm)
    .filter((b) => Math.abs(b - (rec.bpm ?? 0)) > 0.5)
    .slice(0, 3)
    .map(fmtBpm);
  const unique = [...new Set(others)];
  if (!unique.length) return 'Tempo unsure';
  const list = unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(', ')} or ${unique[unique.length - 1]}`;
  return `Tempo unsure — could also be ${list}`;
}

function signed(n: number, places = 1) {
  const v = n.toFixed(places);
  return n > 0 ? `+${v}` : n < 0 ? `−${v.slice(1)}` : v;
}

function rangeOk(v: number | null, lo: number | null, hi: number | null) {
  if (lo == null && hi == null) return true;
  if (v == null) return false;
  return (lo == null || v >= lo) && (hi == null || v <= hi);
}

const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const VERDICT_LABEL = { great: 'Great', good: 'Good', possible: 'Possible', stretch: 'Stretch' } as const;

export function MashupsPanel({ session }: { session: DjSession }) {
  const { library } = session;
  const { tracks, loaded } = useStore(session.crate);
  const lib = useStore(library.store);
  const a = useStore(session.decks[0].store);
  const b = useStore(session.decks[1].store);
  const importInput = useRef<HTMLInputElement>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);
  const ids = { search: useId(), bpmLo: useId(), bpmHi: useId(), key: useId(), eLo: useId(), eHi: useId(), genre: useId(), stretch: useId(), heading: useId(), more: useId() };

  // ── Filters and sort ──────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [bpmLo, setBpmLo] = useState('');
  const [bpmHi, setBpmHi] = useState('');
  const [octaves, setOctaves] = useState(true);
  const [keyMode, setKeyMode] = useState('any'); // 'any' | 'mixes' | a Camelot code
  const [eLo, setELo] = useState('');
  const [eHi, setEHi] = useState('');
  const [genre, setGenre] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'title', dir: 1 });
  const [limit, setLimit] = useState(PAGE);
  /** Phones: the filters beyond search fold away behind a button. */
  const [showFilters, setShowFilters] = useState(false);

  // ── Seed and match options ────────────────────────────────────────────
  const [seedId, setSeedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [stretch, setStretch] = useState(6);
  const [allowShift, setAllowShift] = useState(true);
  const [busy, setBusy] = useState(false);

  const items = useMemo<Item[]>(
    () =>
      tracks.map((rec) => {
        const tags = rec.library?.tags;
        const an = rec.library?.analysis;
        return {
          rec,
          mix: library.toMixTrack(rec),
          energy: an?.energy ?? null,
          lufs: an?.lufs ?? null,
          genre: tags?.genre?.trim() || null,
          year: tags?.year ?? null,
          text: [rec.title, rec.artist, rec.fileName, tags?.album, tags?.genre, tags?.label].filter(Boolean).join(' ').toLowerCase(),
          bpmDoubt: bpmDoubt(rec),
        };
      }),
    [tracks, library],
  );

  const genres = useMemo(() => {
    const seen = new Map<string, string>();
    for (const it of items) if (it.genre && !seen.has(it.genre.toLowerCase())) seen.set(it.genre.toLowerCase(), it.genre);
    return [...seen.values()].sort((x, y) => x.localeCompare(y));
  }, [items]);

  const seed = useMemo(() => items.find((it) => it.rec.id === seedId) ?? null, [items, seedId]);
  const seedKey = seed?.rec.key ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const lo = num(bpmLo);
    const hi = num(bpmHi);
    const el = num(eLo);
    const eh = num(eHi);
    const g = genre.toLowerCase();
    return items.filter((it) => {
      if (q && !it.text.includes(q)) return false;
      if (lo != null || hi != null) {
        const bpm = it.rec.bpm;
        if (!bpm) return false;
        const fits = rangeOk(bpm, lo, hi) || (octaves && (rangeOk(bpm * 2, lo, hi) || rangeOk(bpm / 2, lo, hi)));
        if (!fits) return false;
      }
      if (keyMode === 'mixes') {
        if (!seedKey || !it.rec.key || !compatible(it.rec.key, seedKey)) return false;
      } else if (keyMode !== 'any' && it.rec.key !== keyMode) return false;
      if (!rangeOk(it.energy, el, eh)) return false;
      if (g && it.genre?.toLowerCase() !== g) return false;
      return true;
    });
  }, [items, query, bpmLo, bpmHi, octaves, keyMode, seedKey, eLo, eHi, genre]);

  const rows = useMemo(() => [...filtered].sort((x, y) => compare(x, y, sort.key) * sort.dir || x.rec.addedAt - y.rec.addedAt), [filtered, sort]);

  // A new filter starts the list from the top again.
  useEffect(() => setLimit(PAGE), [filtered]);

  const shown = rows.slice(0, limit);

  const sortBy = (key: SortKey) => setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  // ── Matches ───────────────────────────────────────────────────────────
  const pool = useMemo(() => items.map((it) => it.mix), [items]);
  const mixable = useMemo(() => pool.filter((t) => t.bpm && t.key).length, [pool]);
  const matches = useMemo<Match[]>(
    () => (seed ? suggestMatches(seed.mix, pool, { maxStretchPct: stretch, allowKeyShift: allowShift }) : []),
    [seed, pool, stretch, allowShift],
  );

  // ── Rows: roving focus, selection follows focus ───────────────────────
  const rovingId = shown.some((it) => it.rec.id === focusId) ? focusId : shown.some((it) => it.rec.id === seedId) ? seedId : (shown[0]?.rec.id ?? null);

  const focusRow = (id: string) => {
    setFocusId(id);
    setSeedId(id);
    requestAnimationFrame(() => tbody.current?.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"]`)?.focus());
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    if (e.target !== e.currentTarget) return;
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = Math.min(shown.length - 1, index + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = shown.length - 1;
    else if (e.key === 'PageDown') next = Math.min(shown.length - 1, index + 10);
    else if (e.key === 'PageUp') next = Math.max(0, index - 10);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSeedId(shown[index].rec.id);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    focusRow(shown[next].rec.id);
  };

  // ── Loading ───────────────────────────────────────────────────────────
  const loadPair = async (seedTrack: string, match: string) => {
    setBusy(true);
    try {
      await session.loadToDeck(seedTrack, 0);
      await session.loadToDeck(match, 1);
    } finally {
      setBusy(false);
    }
  };

  const analysing = lib.progress != null;
  const status = [
    lib.progress ? `Analysing ${lib.progress.done} of ${lib.progress.total}` : null,
    lib.note,
  ]
    .filter(Boolean)
    .join(' · ');

  const activeFilters = [bpmLo || bpmHi, keyMode !== 'any', eLo || eHi, genre].filter(Boolean).length;
  const filtersOn = !!query || activeFilters > 0;
  const clearFilters = () => {
    setQuery('');
    setBpmLo('');
    setBpmHi('');
    setKeyMode('any');
    setELo('');
    setEHi('');
    setGenre('');
  };

  return (
    <div className={`${s.panelBody} ${m.panel}`}>
      <header className={m.head}>
        <h2 className={s.srOnly}>Mashups</h2>
        <div className={s.crateActions}>
          {lib.canRescan ? (
            <button type="button" className={s.action} onClick={() => void library.rescan()} title={lib.folderName ? `Look in “${lib.folderName}” for new or removed files` : undefined}>
              Rescan folder
            </button>
          ) : (
            canLinkFolder() && (
              <button type="button" className={s.action} onClick={() => void library.linkFolder()} title="Link a music folder: tracks are read in place and analysed as they're added">
                Link folder
              </button>
            )
          )}
          <span className={s.crateActionsGap} aria-hidden="true" />
          <button type="button" className={s.action} onClick={() => void library.saveFile()} title="Write the library (tags and analysis, never audio) as tracks.json">
            Save library file
          </button>
          <button type="button" className={s.action} onClick={() => importInput.current?.click()} title="Read a tracks.json from the command-line scanner or another browser">
            Import library file
          </button>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            hidden
            aria-label="Library file to import (tracks.json)"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void library.importFile(f);
              e.target.value = '';
            }}
          />
          {lib.syncFolder ? (
            <span className={m.sync}>
              Syncing to <strong>{lib.syncFolder}</strong>
              <button type="button" className={`${s.linkBtn} ${m.syncStop}`} onClick={() => void library.forgetSyncFolder()} aria-label={`Stop syncing the library file to ${lib.syncFolder}`}>
                Stop
              </button>
            </span>
          ) : (
            canLinkFolder() && (
              <button type="button" className={s.action} onClick={() => void library.chooseSyncFolder()} title="Pick a folder (e.g. the repo's library/ folder) to keep tracks.json up to date in">
                Keep in sync with a folder…
              </button>
            )
          )}
        </div>
        <p className={s.crateNote} role="status" aria-live="polite">
          {status || (lib.folderName ? `Library from “${lib.folderName}”.` : 'Tempo, key, energy and loudness are worked out in this browser as tracks are added.')}
          {lib.lastSaved && !status ? ` Library file saved ${new Date(lib.lastSaved).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}
        </p>
      </header>

      {loaded && !tracks.length ? (
        <p className={s.crateEmpty}>Add or link music — each track's tempo, key and energy is worked out as it's added.</p>
      ) : (
        <div className={m.panes}>
          <section className={m.libPane} aria-label="Library">
            <div className={m.filters} role="group" aria-label="Filter the library">
              <div className={`${m.field} ${m.fieldSearch}`}>
                <label htmlFor={ids.search}>Search</label>
                <input id={ids.search} type="search" className={s.search} placeholder="Title, artist, album, label" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <button
                type="button"
                className={`${s.action} ${m.filterToggle}`}
                aria-expanded={showFilters}
                aria-controls={ids.more}
                onClick={() => setShowFilters((v) => !v)}
              >
                Filters{activeFilters ? ` (${activeFilters})` : ''}
              </button>
              <div id={ids.more} className={m.moreFilters} data-open={showFilters}>
              <fieldset className={m.range}>
                <legend>BPM</legend>
                <label htmlFor={ids.bpmLo} className={s.srOnly}>
                  Lowest BPM
                </label>
                <input id={ids.bpmLo} type="number" inputMode="decimal" min={40} max={250} className={m.num} placeholder="min" value={bpmLo} onChange={(e) => setBpmLo(e.target.value)} />
                <span aria-hidden="true">–</span>
                <label htmlFor={ids.bpmHi} className={s.srOnly}>
                  Highest BPM
                </label>
                <input id={ids.bpmHi} type="number" inputMode="decimal" min={40} max={250} className={m.num} placeholder="max" value={bpmHi} onChange={(e) => setBpmHi(e.target.value)} />
                <label className={m.check} title="Also match tracks at half or double the range (64 or 256 for 128)">
                  <input type="checkbox" checked={octaves} onChange={(e) => setOctaves(e.target.checked)} />
                  ½/2× too
                </label>
              </fieldset>
              <div className={m.field}>
                <label htmlFor={ids.key}>Key</label>
                <select id={ids.key} className={`${m.select} ${m.keySelect}`} value={keyMode} onChange={(e) => setKeyMode(e.target.value)}>
                  <option value="any">Any</option>
                  <option value="mixes" disabled={!seedKey}>
                    {seedKey ? `Mixes with ${seedKey}` : 'Mixes with selected'}
                  </option>
                  {CAMELOT.map((k) => (
                    <option key={k} value={k}>
                      {k} · {keyName(k)}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className={m.range}>
                <legend>Energy</legend>
                <label htmlFor={ids.eLo} className={s.srOnly}>
                  Lowest energy
                </label>
                <input id={ids.eLo} type="number" min={1} max={10} className={m.numSmall} placeholder="1" value={eLo} onChange={(e) => setELo(e.target.value)} />
                <span aria-hidden="true">–</span>
                <label htmlFor={ids.eHi} className={s.srOnly}>
                  Highest energy
                </label>
                <input id={ids.eHi} type="number" min={1} max={10} className={m.numSmall} placeholder="10" value={eHi} onChange={(e) => setEHi(e.target.value)} />
              </fieldset>
              <div className={m.field}>
                <label htmlFor={ids.genre}>Genre</label>
                <select id={ids.genre} className={m.select} value={genre} onChange={(e) => setGenre(e.target.value)} disabled={!genres.length}>
                  <option value="">{genres.length ? 'All' : 'None tagged'}</option>
                  {genres.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
              </div>
            </div>
            <p className={m.count}>
              <span>
                {rows.length === items.length ? `${items.length} track${items.length === 1 ? '' : 's'}` : `${rows.length} of ${items.length} tracks`}
              </span>
              {filtersOn && (
                <button type="button" className={s.linkBtn} onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </p>

            <div className={`${s.tableWrap} ${m.tableWrap}`}>
              <table className={`${s.table} ${m.table}`} aria-label="Library tracks — pick one to see what mixes with it">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th key={c.key} scope="col" className={c.className} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                        <button type="button" className={s.sortBtn} onClick={() => sortBy(c.key)}>
                          {c.label}
                          <span aria-hidden="true">{sort.key === c.key ? (sort.dir === 1 ? ' ▴' : ' ▾') : ''}</span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody ref={tbody}>
                  {shown.map((it, i) => {
                    const t = it.rec;
                    const selected = t.id === seedId;
                    const match = seedKey && t.key && !selected ? compatible(t.key, seedKey) : undefined;
                    const pending = !it.rec.library?.analysis && t.status !== 'error';
                    const pendingCell = pending ? <span className={s.dim}>{analysing || t.status === 'analysing' ? 'Analysing…' : '—'}</span> : '—';
                    return (
                      <tr
                        key={t.id}
                        data-id={t.id}
                        tabIndex={t.id === rovingId ? 0 : -1}
                        aria-selected={selected}
                        className={`${m.row} ${selected ? m.rowSelected : ''}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(TRACK_MIME, t.id);
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={() => {
                          setFocusId(t.id);
                          setSeedId(t.id);
                        }}
                        onKeyDown={(e) => onRowKey(e, i)}
                      >
                        <td className={m.colTitle}>
                          <span className={`${s.rowTitle} ${m.clip}`}>{t.title}</span>
                          <span className={`${m.artist} ${m.clip}`}>{t.artist || 'Unknown artist'}</span>
                        </td>
                        <td className={s.colNum}>
                          {t.status === 'analysing' && !t.bpm ? (
                            <span className={s.dim}>Analysing…</span>
                          ) : t.status === 'error' ? (
                            <span className={s.rowError} title={t.error}>
                              can’t read
                            </span>
                          ) : t.bpm ? (
                            <>
                              {t.bpm.toFixed(1)}
                              {it.bpmDoubt && (
                                <span className={m.doubt} title={it.bpmDoubt}>
                                  <span aria-hidden="true">?</span>
                                  <span className={s.srOnly}>{it.bpmDoubt}</span>
                                </span>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className={s.colNum}>
                          {t.key ? (
                            <span className={`${s.rowKey} ${m.key}`} data-match={match} title={`${keyName(t.key)}${match === true ? ` — mixes with ${seedKey}` : match === false ? ` — doesn't mix with ${seedKey}` : ''}`}>
                              {t.key}
                              <small>{keyName(t.key)}</small>
                              {match && <span className={s.srOnly}>, mixes with the selected track</span>}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className={m.colEnergy}>{it.energy != null ? <EnergyBar value={it.energy} /> : pendingCell}</td>
                        <td className={`${s.colNum} ${m.colWide}`}>{it.lufs != null ? signed(it.lufs) : pending ? '' : '—'}</td>
                        <td className={`${m.colWide} ${m.colGenre}`}>
                          <span className={m.clip}>{it.genre ?? '—'}</span>
                        </td>
                        <td className={`${s.colNum} ${m.colWide}`}>{it.year ?? '—'}</td>
                        <td className={`${s.colNum} ${m.colWide}`}>{t.duration ? formatTime(t.duration) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!rows.length && <p className={`${s.crateEmpty} ${m.tableEmpty}`}>No tracks match these filters.</p>}
            </div>
            {rows.length > shown.length && (
              <button type="button" className={s.moreBtn} onClick={() => setLimit((n) => n + PAGE)}>
                Show more ({rows.length - shown.length} left)
              </button>
            )}
          </section>

          <section className={m.mixPane} aria-labelledby={ids.heading}>
            <h3 id={ids.heading} className={m.paneTitle}>
              Mix with…
            </h3>
            {!mixable ? (
              <p className={m.empty}>Add or link music — each track's tempo, key and energy is worked out as it's added.</p>
            ) : !seed ? (
              <p className={m.empty}>Pick a track to see what mixes with it.</p>
            ) : (
              <>
                <div className={m.seed}>
                  <div className={m.seedInfo}>
                    <span className={`${s.rowTitle} ${m.seedTitle} ${m.clip}`}>{seed.rec.title}</span>
                    <span className={`${m.artist} ${m.clip}`}>{seed.rec.artist || 'Unknown artist'}</span>
                    <span className={m.facts}>
                      <span>{seed.rec.bpm ? `${seed.rec.bpm.toFixed(1)} BPM` : 'BPM unknown'}</span>
                      <span>{seed.rec.key ? `${seed.rec.key} · ${keyName(seed.rec.key)}` : 'Key unknown'}</span>
                      <span>{seed.energy != null ? `Energy ${seed.energy}/10` : 'Energy unknown'}</span>
                    </span>
                  </div>
                  <div className={m.deckBtns}>
                    <LoadBtn deck="A" title={seed.rec.title} playing={a.playing} disabled={busy || seed.rec.status === 'error'} onClick={() => void session.loadToDeck(seed.rec.id, 0)} />
                    <LoadBtn deck="B" title={seed.rec.title} playing={b.playing} disabled={busy || seed.rec.status === 'error'} onClick={() => void session.loadToDeck(seed.rec.id, 1)} />
                  </div>
                </div>
                <div className={m.mixOpts}>
                  <div className={m.field}>
                    <label htmlFor={ids.stretch}>Stretch reach</label>
                    <select id={ids.stretch} className={m.select} value={stretch} onChange={(e) => setStretch(Number(e.target.value))}>
                      {STRETCHES.map((n) => (
                        <option key={n} value={n}>
                          ±{n}%
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className={s.switch}>
                    <input type="checkbox" checked={allowShift} onChange={(e) => setAllowShift(e.target.checked)} />
                    Allow key shift
                  </label>
                </div>
                {(!seed.rec.bpm || !seed.rec.key) && (
                  <p className={m.warn}>This track's {!seed.rec.bpm ? (!seed.rec.key ? 'tempo and key aren’t' : 'tempo isn’t') : 'key isn’t'} known yet, so these are rough guesses.</p>
                )}
                {!matches.length ? (
                  <p className={m.empty}>
                    Nothing within ±{stretch}% of {seed.rec.bpm ? fmtBpm(seed.rec.bpm) : 'this'} BPM.{' '}
                    {stretch < STRETCHES[STRETCHES.length - 1] ? (
                      <button type="button" className={s.linkBtn} onClick={() => setStretch(STRETCHES[STRETCHES.indexOf(stretch) + 1] ?? 10)}>
                        Widen the stretch to ±{STRETCHES[STRETCHES.indexOf(stretch) + 1] ?? 10}%
                      </button>
                    ) : (
                      'Add tracks closer in tempo, or try one of them half- or double-time.'
                    )}
                  </p>
                ) : (
                  <ol className={m.matches} aria-label={`Tracks that mix with ${seed.rec.title}, best first`}>
                    {matches.map((mt) => (
                      <MatchCard
                        key={mt.track.id}
                        match={mt}
                        seed={seed.mix}
                        busy={busy}
                        aPlaying={a.playing}
                        bPlaying={b.playing}
                        onPair={() => void loadPair(seed.rec.id, mt.track.id)}
                        onDeck={(d) => void session.loadToDeck(mt.track.id, d)}
                      />
                    ))}
                  </ol>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function EnergyBar({ value }: { value: number }) {
  const v = Math.max(1, Math.min(10, Math.round(value)));
  return (
    <span className={m.energy} title={`Energy ${v} of 10`}>
      <span className={m.segments} aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} data-on={i < v} />
        ))}
      </span>
      <span className={m.energyNum}>
        {v}
        <span className={s.srOnly}> of 10</span>
      </span>
    </span>
  );
}

function LoadBtn({ deck, title, playing, disabled, onClick }: { deck: 'A' | 'B'; title: string; playing: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`${s.loadBtn} ${m.loadBtn}`}
      data-deck={deck}
      disabled={disabled || playing}
      title={playing ? `Deck ${deck} is playing` : `Load on deck ${deck}`}
      aria-label={`Load ${title} on deck ${deck}`}
      onClick={onClick}
    >
      {deck}
    </button>
  );
}

function MatchCard(p: {
  match: Match;
  seed: MixTrack;
  busy: boolean;
  aPlaying: boolean;
  bPlaying: boolean;
  onPair: () => void;
  onDeck: (d: 0 | 1) => void;
}) {
  const { match: mt, seed } = p;
  const v = verdict(mt.score);
  const t = mt.track;
  const pct = Math.round(mt.score * 100);
  const keyBit = seed.key && t.key ? `${seed.key} → ${t.key}` : null;
  const tempoBit =
    seed.bpm && t.bpm ? `${fmtBpm(seed.bpm)} → ${fmtBpm(t.bpm)}${mt.stretchPct != null && Math.abs(mt.stretchPct) >= 0.05 ? ` (${signed(mt.stretchPct)}%)` : ''}` : null;
  const pairBlocked = p.aPlaying || p.bPlaying;
  return (
    <li className={m.card} data-verdict={v}>
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
        {keyBit && <span title="Selected track's key → this track's key">{keyBit}</span>}
        {mt.keyShift !== 0 && <span className={m.tag}>shift {signed(mt.keyShift, 0)}</span>}
        {tempoBit && <span title={mt.stretchPct != null ? `Change this track's speed ${signed(mt.stretchPct)}% to meet the selected track` : undefined}>{tempoBit}</span>}
        {mt.tempoRelation !== 'same' && (
          <span className={m.tag} title={mt.tempoRelation === 'half' ? 'Played half-time' : 'Played double-time'}>
            {mt.tempoRelation === 'half' ? '½×' : '2×'}
          </span>
        )}
      </p>
      <ul className={m.reasons}>
        {mt.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div className={m.cardActions}>
        <button
          type="button"
          className={`${s.action} ${m.pairBtn}`}
          disabled={p.busy || pairBlocked}
          title={pairBlocked ? 'Stop the playing deck first' : 'Selected track on deck A, this one on deck B'}
          onClick={p.onPair}
          aria-label={`Load pair: ${seed.title} on deck A, ${t.title} on deck B`}
        >
          Load pair
        </button>
        <LoadBtn deck="A" title={t.title} playing={p.aPlaying} disabled={p.busy} onClick={() => p.onDeck(0)} />
        <LoadBtn deck="B" title={t.title} playing={p.bPlaying} disabled={p.busy} onClick={() => p.onDeck(1)} />
      </div>
    </li>
  );
}
