import { useEffect, useRef, useState } from 'react';
import type { DjSession } from '../engine/session';
import { useStore } from '../engine/store';
import { addFiles } from './crate/CrateActions';
import { crateBrowser, crateSlot, setCrateView } from './crate/model';
import { TrackBrowser } from './crate/TrackBrowser';
import { useDropTarget } from './frame';
import s from '../platter.module.css';
import c from './crate/crate.module.css';

/** The crate in the library. The same list can lift out into a mini window
 *  or full screen (see crate/CrateDock); while it's out, this slot says
 *  where it went. */
export function Crate({ session }: { session: DjSession }) {
  const { view } = useStore(crateBrowser);
  const [over, setOver] = useState(false);
  const section = useRef<HTMLElement>(null);
  // The crate's height while it's in the page, so the page keeps its shape
  // (and the decks stay put) when the list lifts out.
  const pageHeight = useRef(0);
  useEffect(() => {
    const el = section.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (crateBrowser.get().view === 'page') pageHeight.current = el.offsetHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = section.current;
    crateSlot.set({ el });
    return () => {
      if (crateSlot.get().el === el) crateSlot.set({ el: null });
    };
  }, []);

  useDropTarget(
    section,
    (types) => types.includes('Files'),
    setOver,
    (data) => addFiles(session, Array.from(data.files)),
  );

  return (
    <section
      ref={section}
      className={`${s.crate} ${c.pageCrate} ${view !== 'page' ? c.pageCrateLifted : ''} ${over ? s.crateOver : ''}`}
      style={view !== 'page' && pageHeight.current ? { minHeight: pageHeight.current } : undefined}
      aria-label="Crate"
    >
      <h2 className={s.srOnly}>Crate</h2>
      {view === 'page' ? (
        <TrackBrowser session={session} mode="page" />
      ) : (
        <div className={c.lifted}>
          <p>The track list is open in {view === 'full' ? 'full screen' : 'its own window'}. Search, sort and filters carry over.</p>
          <button type="button" className={c.action} onClick={() => setCrateView('page')}>
            Put it back here
          </button>
        </div>
      )}
    </section>
  );
}
