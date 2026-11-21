import { useDeferredValue, useMemo, useState } from 'react';
import type { DjSession } from '../../engine/session';
import { CATEGORIES, CATEGORY_LABEL, LIBRARY, type Category } from '../../engine/sounds/catalog';
import { useStore } from '../../engine/store';
import { Popover } from './Popover';
import st from './arranger.module.css';

const PAGE = 80;
const SOURCE_LABEL = { synth: 'Synth', cc0: 'Recorded', user: 'Yours' } as const;

/**
 * Picks a drum lane's sound from the sampler's library: a search box, the
 * categories as chips, click ▶ to hear one, click its name to use it.
 */
export function SoundPicker({
  session,
  anchor,
  title,
  current,
  category,
  onPick,
  onClose,
}: {
  session: DjSession;
  anchor: HTMLElement;
  title: string;
  current?: string | null;
  category?: Category | 'all';
  onPick: (soundId: string) => void;
  onClose: () => void;
}) {
  const sampler = useStore(session.sampler.store);
  const [filter, setFilter] = useState<Category | 'all'>(category ?? 'all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const deferred = useDeferredValue(query);

  const all = useMemo(() => [...LIBRARY], [sampler.userVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => {
    const words = deferred.toLowerCase().split(/\s+/).filter(Boolean);
    // A search looks everywhere; the category narrows browsing.
    return all.filter((x) => (words.length || filter === 'all' ? true : x.category === filter) && words.every((w) => x.words.includes(w)));
  }, [all, deferred, filter]);

  const close = () => {
    session.sampler.stopPreview();
    onClose();
  };

  return (
    <Popover anchor={anchor} onClose={close} label={title} className={st.picker}>
      <div className={st.pickHead}>
        <p className={st.pickTitle}>{title}</p>
        <input
          type="search"
          className={st.search}
          placeholder="Search: kick, 808, dusty snare…"
          aria-label="Search sounds"
          value={query}
          data-autofocus
          onChange={(e) => {
            setQuery(e.target.value);
            setShown(PAGE);
          }}
        />
        <div className={st.cats} role="group" aria-label="Category">
          {[{ id: 'all' as const, label: 'All' }, ...CATEGORIES].map((c) => (
            <button
              key={c.id}
              type="button"
              className={st.cat}
              aria-pressed={filter === c.id}
              style={c.id === 'all' ? undefined : { ['--c' as string]: `var(--cat-${c.id})` }}
              onClick={() => {
                setFilter(c.id);
                setShown(PAGE);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <ul className={st.results} aria-label={`${results.length} sounds`}>
        {results.slice(0, shown).map((x) => (
          <li key={x.id} className={st.result} data-current={x.id === current} style={{ ['--c' as string]: `var(--cat-${x.category})` }}>
            <button
              type="button"
              className={st.play}
              aria-label={`Hear ${x.name}`}
              aria-pressed={sampler.preview === x.id}
              onClick={() => (sampler.preview === x.id ? session.sampler.stopPreview() : void session.sampler.preview(x.id))}
            >
              <svg viewBox="0 0 14 14" aria-hidden="true">
                {sampler.preview === x.id ? <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" /> : <path d="M3 2l9 5-9 5z" fill="currentColor" />}
              </svg>
            </button>
            <button
              type="button"
              className={st.pickName}
              onClick={() => {
                session.sampler.stopPreview();
                onPick(x.id);
              }}
            >
              <span className={st.pickDot} aria-hidden="true" />
              <span>{x.name}</span>
              <span className={st.pickMeta}>
                {CATEGORY_LABEL[x.category]} · {SOURCE_LABEL[x.source]}
                {x.id === current ? ' · on this lane' : ''}
              </span>
            </button>
          </li>
        ))}
        {!results.length && <li className={st.none}>No sounds match “{deferred}”.</li>}
        {results.length > shown && (
          <li>
            <button type="button" className={st.more} onClick={() => setShown((n) => n + PAGE)}>
              Show more ({results.length - shown} left)
            </button>
          </li>
        )}
      </ul>
    </Popover>
  );
}
