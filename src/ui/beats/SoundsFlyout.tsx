import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { compatible } from '../../engine/key';
import { BANK_NAMES } from '../../engine/sampler';
import type { DjSession } from '../../engine/session';
import { CATEGORIES, CATEGORY_LABEL, LIBRARY, type Category, type SoundInfo } from '../../engine/sounds/catalog';
import { KITS } from '../../engine/sounds/kits';
import { useStore } from '../../engine/store';
import { closeSounds, soundsUi, type SoundsTab } from './sounds';
import s from './beats.module.css';

type Filter = Category | 'all' | 'favorites' | 'mine';

const PAGE = 120;

const SOURCE_LABEL = { synth: 'Synth', cc0: 'Recorded', user: 'Yours' } as const;

/**
 * "Sounds": the sampler's library in a sheet from the right, in the manner of
 * the sample browsers in Ableton's and Bitwig's sidebars and Splice's search.
 * Categories down the side, one search box, click to hear (in the headphones
 * when they're set up), and one button to put the sound on the selected pad.
 */
export function SoundsFlyout({ session }: { session: DjSession }) {
  const { open, tab } = useStore(soundsUi);
  const sampler = useStore(session.sampler.store);
  const decks = [useStore(session.decks[0].store), useStore(session.decks[1].store)];
  const [mounted, setMounted] = useState(open);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [keyMatch, setKeyMatch] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const deferred = useDeferredValue(query);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMounted(true);
    opener.current = document.activeElement;
    const id = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('input[type="search"], [role="tab"][aria-selected="true"]')?.focus());
    return () => {
      cancelAnimationFrame(id);
      session.sampler.stopPreview();
      const back = opener.current as HTMLElement | null;
      if (back?.isConnected) back.focus();
    };
  }, [open, session]);

  const deckKeys = decks.map((d) => d.key).filter((k): k is string => !!k);
  const fav = useMemo(() => new Set(sampler.favorites), [sampler.favorites]);

  // The library changes when you add your own sounds; userVersion says so.
  const all = useMemo(() => [...LIBRARY], [sampler.userVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = new Map<Filter, number>([['all', all.length]]);
    for (const x of all) {
      c.set(x.category, (c.get(x.category) ?? 0) + 1);
      if (x.source === 'user') c.set('mine', (c.get('mine') ?? 0) + 1);
    }
    c.set('favorites', all.filter((x) => fav.has(x.id)).length);
    return c;
  }, [all, fav]);

  const results = useMemo(() => {
    const words = deferred.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((x) => {
      if (filter === 'favorites' ? !fav.has(x.id) : filter === 'mine' ? x.source !== 'user' : filter !== 'all' && x.category !== filter) return false;
      if (keyMatch && (!x.key || !deckKeys.some((k) => compatible(k, x.key!)))) return false;
      return words.every((w) => x.words.includes(w));
    });
  }, [all, deferred, filter, fav, keyMatch, deckKeys.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setShown(PAGE), [deferred, filter, keyMatch]);

  if (!mounted) return null;

  const target = sampler.selected;
  const targetName = `${BANK_NAMES[Math.floor(target / 16)]}${(target % 16) + 1}`;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeSounds();
    }
  };

  const setTab = (t: SoundsTab) => soundsUi.set({ tab: t });

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All sounds' },
    { id: 'favorites', label: 'Favourites' },
    { id: 'mine', label: 'My sounds' },
    ...CATEGORIES,
  ];

  return (
    <aside ref={panel} className={s.flyout} data-open={open} aria-label="Sounds" inert={!open} aria-hidden={!open} onKeyDown={onKey}>
      <header className={s.flyHead}>
        <div>
          <h2 className={s.flyTitle}>Sounds</h2>
          <p className={s.flySub}>
            {LIBRARY.length.toLocaleString()} sounds · loading onto pad <strong>{targetName}</strong>
          </p>
        </div>
        <button type="button" className={s.close} onClick={closeSounds} aria-label="Close sounds">
          ✕
        </button>
        <div className={s.flyTabs} role="tablist" aria-label="Sounds or kits">
          {(['sounds', 'kits'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={s.flyTab} onClick={() => setTab(t)}>
              {t === 'sounds' ? 'Sounds' : 'Kits'}
            </button>
          ))}
        </div>
      </header>

      {tab === 'kits' ? (
        <div className={s.kitGrid} role="tabpanel" aria-label="Kits">
          {KITS.map((k) => (
            <article key={k.id} className={s.kitCard} style={{ ['--hue' as string]: k.hue }}>
              <h3 className={s.kitName}>{k.name}</h3>
              <p className={s.kitBlurb}>{k.blurb}</p>
              <div className={s.kitLoad} role="group" aria-label={`Load ${k.name} onto a bank`}>
                {BANK_NAMES.map((b, i) => (
                  <button
                    key={b}
                    type="button"
                    className={s.chip}
                    aria-pressed={sampler.bankKits[i] === k.id}
                    aria-label={`Load ${k.name} onto bank ${b}`}
                    onClick={() => {
                      session.sampler.loadKit(i, k.id);
                      session.sampler.setBank(i);
                    }}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className={s.browser} role="tabpanel" aria-label="Sounds">
          <nav className={s.cats} aria-label="Categories">
            {filters.map((f) => (
              <button key={f.id} type="button" className={s.cat} data-cat={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                <span>{f.label}</span>
                <span className={s.catCount}>{counts.get(f.id) ?? 0}</span>
              </button>
            ))}
          </nav>
          <div className={s.results}>
            <div className={s.searchRow}>
              <input
                type="search"
                className={s.search}
                placeholder="Search: kick, 808, dusty snare, vinyl…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search sounds"
              />
              <button
                type="button"
                className={s.chip}
                aria-pressed={keyMatch}
                disabled={!deckKeys.length}
                title={deckKeys.length ? `Only sounds in a key that mixes with ${deckKeys.join(' and ')}` : 'Load a track to match its key'}
                onClick={() => setKeyMatch(!keyMatch)}
              >
                In key{deckKeys.length ? ` · ${deckKeys.join('/')}` : ''}
              </button>
              <button type="button" className={s.chip} onClick={() => file.current?.click()}>
                Add your own
              </button>
              <input
                ref={file}
                type="file"
                accept="audio/*"
                multiple
                hidden
                aria-label="Add your own sounds"
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = '';
                  const ids = await session.sampler.importFiles(files);
                  setNote(ids.length ? `Added ${ids.length} sound${ids.length === 1 ? '' : 's'} to My sounds.` : 'Those files are not audio this browser can play.');
                  if (ids.length) setFilter('mine');
                }}
              />
            </div>
            <p className={s.resultCount} aria-live="polite">
              {note ?? `${results.length.toLocaleString()} ${results.length === 1 ? 'sound' : 'sounds'}${filter !== 'all' && filter !== 'favorites' && filter !== 'mine' ? ` in ${CATEGORY_LABEL[filter]}` : ''}`}
            </p>
            <ul className={s.soundList} aria-label="Sound results">
              {results.slice(0, shown).map((x) => (
                <SoundRow
                  key={x.id}
                  x={x}
                  session={session}
                  playing={sampler.preview === x.id}
                  loading={sampler.loading.includes(x.id)}
                  favorite={fav.has(x.id)}
                  inKey={!!x.key && deckKeys.some((k) => compatible(k, x.key!))}
                  targetName={targetName}
                  onPick={() => {
                    session.sampler.assign(target, x.id);
                    setNote(`${x.name} is on pad ${targetName}.`);
                  }}
                />
              ))}
            </ul>
            {results.length > shown && (
              <button type="button" className={s.more} onClick={() => setShown(shown + PAGE)}>
                Show {Math.min(PAGE, results.length - shown)} more
              </button>
            )}
            {!results.length && <p className={s.empty}>Nothing matches. Try fewer words, or another category.</p>}
          </div>
        </div>
      )}
    </aside>
  );
}

function SoundRow(props: {
  x: SoundInfo;
  session: DjSession;
  playing: boolean;
  loading: boolean;
  favorite: boolean;
  inKey: boolean;
  targetName: string;
  onPick: () => void;
}) {
  const { x, session, playing, loading, favorite, inKey, targetName, onPick } = props;
  const sampler = session.sampler;
  return (
    <li className={s.sound} data-cat={x.category} data-playing={playing}>
      <button
        type="button"
        className={s.audition}
        aria-label={`${playing ? 'Stop' : 'Hear'} ${x.name}`}
        onClick={async () => {
          await session.ensureEngine();
          if (playing) sampler.stopPreview();
          else void sampler.preview(x.id);
        }}
      >
        <span aria-hidden="true">{loading ? '…' : playing ? '■' : '▶'}</span>
      </button>
      <span className={s.soundMain}>
        <span className={s.soundName}>{x.name}</span>
        <span className={s.soundMeta}>
          {CATEGORY_LABEL[x.category]} · {SOURCE_LABEL[x.source]}
          {x.credit ? ` · by ${x.credit}` : ''}
          {x.seconds ? ` · ${x.seconds < 10 ? x.seconds.toFixed(1) : Math.round(x.seconds)}s` : ''}
        </span>
      </span>
      {x.key && (
        <span className={s.keyBadge} data-match={inKey} title={inKey ? 'Mixes with a loaded track' : 'Camelot key'}>
          {x.key}
        </span>
      )}
      <button type="button" className={s.star} aria-pressed={favorite} aria-label={`${favorite ? 'Remove' : 'Add'} ${x.name} ${favorite ? 'from' : 'to'} favourites`} onClick={() => sampler.toggleFavorite(x.id)}>
        <span aria-hidden="true">{favorite ? '★' : '☆'}</span>
      </button>
      {x.source === 'user' && (
        <button type="button" className={s.rowBtn} aria-label={`Delete ${x.name}`} onClick={() => void sampler.deleteUserSound(x.id)}>
          Delete
        </button>
      )}
      <button type="button" className={s.rowBtn} data-primary onClick={onPick} aria-label={`Put ${x.name} on pad ${targetName}`}>
        To {targetName}
      </button>
    </li>
  );
}
