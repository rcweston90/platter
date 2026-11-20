import { useId } from 'react';
import s from '../platter.module.css';

/** The big search field at the top of a music source: Enter or the button searches, ✕ clears. */
export function SearchBar(p: {
  label: string;
  placeholder: string;
  value: string;
  busy?: boolean;
  onChange: (v: string) => void;
  onSearch: (q: string) => void;
  onClear?: () => void;
}) {
  const id = useId();
  return (
    <form
      className={s.searchBar}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = p.value.trim();
        if (q) p.onSearch(q);
      }}
    >
      <label htmlFor={id} className={s.srOnly}>
        {p.label}
      </label>
      <span className={s.searchIcon} aria-hidden="true">
        ⌕
      </span>
      <input id={id} type="search" className={s.searchInput} placeholder={p.placeholder} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      {p.value && p.onClear && (
        <button type="button" className={s.searchClear} onClick={p.onClear} aria-label="Clear search">
          ✕
        </button>
      )}
      <button type="submit" className={s.primaryBtn} disabled={p.busy || !p.value.trim()}>
        {p.busy ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}
