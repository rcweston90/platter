import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { compatible, keyName } from '../../engine/key';
import { keyRelation, type KeyRelation } from '../../library/mashup';
import type { DjSession } from '../../engine/session';
import type { TrackRecord } from '../../engine/types';
import { TRACK_MIME } from '../DeckPanel';
import { formatTime } from '../Waveforms';
import { SOURCE_LABEL, TEMPO_REACH, artUrl, crateBrowser, energyOf, folderOf, sourceOf, tempoGap, type SortKey } from './model';
import type { Rig } from './rig';
import c from './crate.module.css';

/** Every row is the same height, so only the rows on screen are rendered —
 *  a linked folder of thousands scrolls as lightly as the demo crate. The
 *  mini window keeps roomier rows; the library and full screen are denser. */
export const ROW_H = 52;
const DENSE_H = 46;
export const rowHeight = (mode: Mode) => (mode === 'mini' ? ROW_H : DENSE_H);

/** A Camelot move, as DJs say it: the same key, ±1 round the wheel, the
 *  relative major or minor, and so on. */
const MOVE: Partial<Record<KeyRelation, string>> = {
  same: 'same',
  relative: 'rel',
  'fifth-up': '+1',
  'fifth-down': '−1',
  diagonal: 'diag',
  'boost-2': '+2',
};
const MOVE_TITLE: Partial<Record<KeyRelation, string>> = {
  same: 'the same key',
  relative: 'its relative major or minor',
  'fifth-up': 'one step up the Camelot wheel',
  'fifth-down': 'one step down the Camelot wheel',
  diagonal: 'a diagonal move on the wheel (six of seven notes shared)',
  'boost-2': 'two steps up the wheel, an energy boost',
};

/** Whether a tempo meets the reference as it is, in double time or in half time. */
function tempoFactor(bpm: number, ref: number): 0.5 | 1 | 2 {
  let best: 0.5 | 1 | 2 = 1;
  for (const f of [0.5, 1, 2] as const) if (Math.abs(bpm * f - ref) < Math.abs(bpm * best - ref)) best = f;
  return best;
}

function signedPct(gap: number) {
  const v = Math.abs(gap * 100);
  if (v < 0.05) return '±0';
  return `${gap > 0 ? '+' : '−'}${v.toFixed(v < 10 ? 1 : 0)}%`;
}
const OVERSCAN = 8;

type Mode = 'page' | 'mini' | 'full';

interface Column {
  key: SortKey | null;
  label: string;
  className: string;
  /** Hidden from the header, but still the column's accessible name. */
  quiet?: boolean;
}

function columnsFor(mode: Mode, showEnergy: boolean): Column[] {
  if (mode === 'mini') {
    return [
      { key: 'title', label: 'Track', className: c.colTrack },
      { key: 'bpm', label: 'BPM', className: c.colNum },
      { key: 'key', label: 'Key', className: c.colKey },
      { key: null, label: 'Load', className: c.colLoad, quiet: true },
    ];
  }
  return [
    { key: 'title', label: 'Title', className: c.colTrack },
    { key: 'artist', label: 'Artist', className: c.colArtist },
    { key: 'bpm', label: 'BPM', className: c.colNum },
    { key: 'key', label: 'Key', className: c.colKey },
    ...(showEnergy ? [{ key: 'energy' as const, label: 'Energy', className: c.colEnergy }] : []),
    { key: 'duration', label: 'Time', className: c.colTime },
    { key: null, label: 'Actions', className: c.colActions, quiet: true },
  ];
}

export function TrackList({
  session,
  rows,
  mode,
  rig,
  showEnergy,
  sort,
  onExitTop,
  listRef,
}: {
  session: DjSession;
  rows: TrackRecord[];
  mode: Mode;
  rig: Rig;
  showEnergy: boolean;
  sort: { key: SortKey; dir: 1 | -1 };
  /** Arrow-up past the first row: back to the search field. */
  onExitTop: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const scroller = listRef;
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);
  const [active, setActive] = useState(0);
  const head = useRef<HTMLTableSectionElement>(null);
  const focusNext = useRef(false);
  const columns = columnsFor(mode, showEnergy);
  const H = rowHeight(mode);
  const { ref, target, playing, loadedOn, queue } = rig;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [scroller]);

  // A new search or filter starts at the top.
  const first = rows[0]?.id;
  useEffect(() => {
    setActive(0);
    const el = scroller.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [first, rows.length, scroller]);

  const headH = head.current?.offsetHeight ?? 40;
  const start = Math.max(0, Math.floor((scrollTop - headH) / H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / H) + OVERSCAN);
  const visible = rows.slice(start, end);
  const safeActive = Math.min(active, Math.max(0, rows.length - 1));

  // Keyboard moves focus row to row; the row may only exist once the window
  // has moved, so focusing waits for the render that brings it in.
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    scroller.current?.querySelector<HTMLElement>(`[data-row="${safeActive}"]`)?.focus({ preventScroll: true });
  });

  const moveTo = (i: number) => {
    const el = scroller.current;
    const n = Math.max(0, Math.min(rows.length - 1, i));
    if (el) {
      const top = headH + n * H;
      let next = el.scrollTop;
      if (top < el.scrollTop + headH) next = top - headH;
      else if (top + H > el.scrollTop + el.clientHeight) next = top + H - el.clientHeight;
      if (next !== el.scrollTop) {
        el.scrollTop = next;
        setScrollTop(el.scrollTop);
      }
    }
    focusNext.current = true;
    setActive(n);
  };

  const load = (t: TrackRecord, deck: 0 | 1 | null) => {
    if (deck === null || t.status === 'error' || playing[deck]) return;
    void session.loadToDeck(t.id, deck);
  };
  const toggleQueue = (t: TrackRecord) => (queue.includes(t.id) ? session.autoDj.dequeue(t.id) : session.autoDj.enqueue(t.id));

  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // On a row, every list key; on a button inside one, only the arrows that
    // walk the list (the button keeps Enter and Space).
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!row) return;
    if (row !== e.target && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = Number(row.dataset.row);
    const t = rows[i];
    if (!t) return;
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / H) - 1);
    const act: Record<string, () => void> = {
      ArrowDown: () => moveTo(i + 1),
      ArrowUp: () => (i === 0 ? onExitTop() : moveTo(i - 1)),
      PageDown: () => moveTo(i + page),
      PageUp: () => moveTo(i - page),
      Home: () => moveTo(0),
      End: () => moveTo(rows.length - 1),
      ArrowLeft: () => load(t, 0),
      ArrowRight: () => load(t, 1),
      Enter: () => load(t, target),
      '+': () => toggleQueue(t),
      '=': () => toggleQueue(t),
    };
    const fn = act[e.key];
    if (!fn) return;
    // Keep these keys from also reaching the rig's performance shortcuts.
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  const onDouble = (e: MouseEvent, t: TrackRecord) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    load(t, target);
  };

  const sortBy = (key: SortKey) => {
    const cur = crateBrowser.get().sort;
    crateBrowser.set({ sort: cur.key === key ? { key, dir: cur.dir === 1 ? -1 : 1 } : { key, dir: 1 } });
  };

  const span = columns.length;

  return (
    <div
      ref={scroller}
      className={c.scroller}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      data-mode={mode}
    >
      <table className={c.table} data-mode={mode} aria-rowcount={rows.length + 1}>
        <thead ref={head}>
          <tr aria-rowindex={1}>
            {columns.map((col) => (
              <th
                key={col.label}
                className={col.className}
                scope="col"
                aria-sort={col.key && sort.key === col.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
              >
                {col.key ? (
                  <button type="button" className={c.sortBtn} onClick={() => sortBy(col.key!)} data-on={sort.key === col.key || undefined}>
                    {col.label}
                    <span aria-hidden="true" className={c.sortArrow}>
                      {sort.key === col.key ? (sort.dir === 1 ? '▴' : '▾') : ''}
                    </span>
                  </button>
                ) : (
                  <span className={col.quiet ? c.srOnly : undefined}>{col.label}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody onKeyDown={onKey}>
          {start > 0 && (
            <tr aria-hidden="true" className={c.spacer} style={{ height: start * H }}>
              <td colSpan={span} />
            </tr>
          )}
          {visible.map((t, k) => {
            const i = start + k;
            const on = loadedOn(t.id);
            const kind = sourceOf(t);
            const art = artUrl(t.art);
            const isActive = i === safeActive;
            const gap = tempoGap(t.bpm, ref?.bpm ?? null);
            const keyFits = t.key && ref?.key ? compatible(t.key, ref.key) : undefined;
            const move = keyRelation(ref?.key ?? null, t.key);
            const factor = gap !== null && t.bpm && ref?.bpm ? tempoFactor(t.bpm, ref.bpm) : 1;
            const qi = queue.indexOf(t.id);
            const dir = folderOf(t);
            const second = mode === 'mini' ? t.artist || null : t.library?.tags.album || dir || null;
            const tab = isActive ? 0 : -1;
            return (
              <tr
                key={t.id}
                data-row={i}
                aria-rowindex={i + 2}
                tabIndex={tab}
                className={c.row}
                data-active={isActive || undefined}
                data-loaded={on || undefined}
                data-error={t.status === 'error' || undefined}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TRACK_MIME, t.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onFocus={(e) => {
                  if (e.target === e.currentTarget || e.currentTarget.contains(e.target)) setActive(i);
                }}
                onDoubleClick={(e) => onDouble(e, t)}
                aria-label={`${t.title}${t.artist ? `, ${t.artist}` : ''}${t.bpm ? `, ${t.bpm.toFixed(0)} BPM` : ''}${t.key ? `, ${t.key}` : ''}${on ? `, on deck ${on}` : ''}`}
              >
                <td className={c.colTrack}>
                  <div className={c.trackCell}>
                    {art ? (
                      <img src={art} alt="" className={c.art} loading="lazy" draggable={false} />
                    ) : (
                      <span className={c.art} data-kind={kind} aria-hidden="true" />
                    )}
                    <span className={c.titles}>
                      <span className={c.titleLine}>
                        <span className={c.title}>{t.title}</span>
                        {on &&
                          on.split(' ').map((d) => (
                            <span key={d} className={c.onDeck} data-deck={d} title={`Loaded on deck ${d}`}>
                              {d}
                            </span>
                          ))}
                        {qi >= 0 && <span className={c.queued}>Q{qi + 1}</span>}
                      </span>
                      <span className={c.subLine}>
                        {t.link ? (
                          <a
                            className={c.badge}
                            data-kind={kind}
                            href={t.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            tabIndex={tab}
                            aria-label={`${t.title} by ${t.artist} on ${t.soundcloud ? 'SoundCloud' : 'Audius'}`}
                          >
                            {SOURCE_LABEL[kind]} ↗
                          </a>
                        ) : (
                          <span className={c.badge} data-kind={kind}>
                            {SOURCE_LABEL[kind]}
                          </span>
                        )}
                        {t.status === 'error' ? (
                          <span className={c.error} title={t.error}>
                            can’t read this file
                          </span>
                        ) : (
                          second && <span className={c.sub}>{second}</span>
                        )}
                        {mode !== 'mini' && <span className={c.artistInline}>{t.artist}</span>}
                      </span>
                    </span>
                  </div>
                </td>
                {mode !== 'mini' && <td className={c.colArtist}>{t.artist || <span className={c.dim}>—</span>}</td>}
                <td className={c.colNum}>
                  {t.status === 'analysing' ? (
                    <span className={c.analysing} title="Finding the tempo and key">
                      <span className={c.srOnly}>analysing…</span>
                    </span>
                  ) : t.bpm ? (
                    <span className={c.stack}>
                      <span
                        className={c.bpm}
                        data-match={gap === null ? undefined : Math.abs(gap) <= TEMPO_REACH}
                        title={gap === null ? undefined : `${signedPct(gap)} from deck ${ref?.deck}${factor === 2 ? ', played double time' : factor === 0.5 ? ', played half time' : ''}`}
                      >
                        {t.bpm.toFixed(mode === 'mini' ? 0 : 1)}
                      </span>
                      {gap !== null && mode !== 'mini' && (
                        <span className={c.delta} data-match={Math.abs(gap) <= TEMPO_REACH} aria-hidden="true">
                          {factor === 2 ? '2× ' : factor === 0.5 ? '½× ' : ''}
                          {signedPct(gap)}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className={c.dim}>—</span>
                  )}
                </td>
                <td className={c.colKey}>
                  {t.key ? (
                    <span className={c.stack}>
                      <span
                        className={c.key}
                        data-match={keyFits}
                        title={`${keyName(t.key)}${ref?.key ? (keyFits ? ` — mixes with ${ref.key} on deck ${ref.deck}${MOVE_TITLE[move] ? `: ${MOVE_TITLE[move]}` : ''}` : ` — clashes with ${ref.key} on deck ${ref.deck}`) : ''}`}
                      >
                        {t.key}
                      </span>
                      {ref?.key && mode !== 'mini' && (
                        <span className={c.delta} data-match={!!keyFits} aria-hidden="true">
                          {MOVE[move] ?? (keyFits ? 'fits' : '✕')}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className={c.dim}>—</span>
                  )}
                </td>
                {mode !== 'mini' && showEnergy && (
                  <td className={c.colEnergy}>
                    {energyOf(t) !== null ? (
                      <span className={c.energy} style={{ '--e': energyOf(t)! / 10 } as React.CSSProperties} title={`Energy ${energyOf(t)!.toFixed(0)} of 10`}>
                        {energyOf(t)!.toFixed(0)}
                      </span>
                    ) : (
                      <span className={c.dim}>—</span>
                    )}
                  </td>
                )}
                {mode !== 'mini' && <td className={c.colTime}>{t.duration ? formatTime(t.duration) : <span className={c.dim}>—</span>}</td>}
                <td className={mode === 'mini' ? c.colLoad : c.colActions}>
                  <div className={c.actions}>
                    {([0, 1] as const).map((d) => {
                      const L = d === 0 ? 'A' : 'B';
                      return (
                        <button
                          key={L}
                          type="button"
                          className={c.load}
                          data-deck={L}
                          data-target={target === d || undefined}
                          tabIndex={tab}
                          disabled={t.status === 'error' || playing[d]}
                          title={playing[d] ? `Deck ${L} is playing` : `Load on deck ${L} (${d === 0 ? '←' : '→'})`}
                          onClick={() => load(t, d)}
                          aria-label={`Load ${t.title} on deck ${L}`}
                        >
                          {L}
                        </button>
                      );
                    })}
                    {mode !== 'mini' && (
                      <>
                        <button
                          type="button"
                          className={c.load}
                          tabIndex={tab}
                          aria-pressed={qi >= 0}
                          disabled={t.status === 'error'}
                          onClick={() => toggleQueue(t)}
                          aria-label={qi >= 0 ? `Take ${t.title} off the Auto-DJ queue` : `Queue ${t.title} for Auto-DJ`}
                          title="Auto-DJ queue (+)"
                        >
                          {qi >= 0 ? `Q${qi + 1}` : '+Q'}
                        </button>
                        <button
                          type="button"
                          className={c.remove}
                          tabIndex={tab}
                          disabled={!!on}
                          onClick={() => session.removeTrack(t.id)}
                          aria-label={`Remove ${t.title} from the crate`}
                          title={on ? 'Loaded on a deck' : 'Remove from the crate'}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
          {end < rows.length && (
            <tr aria-hidden="true" className={c.spacer} style={{ height: (rows.length - end) * H }}>
              <td colSpan={span} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
