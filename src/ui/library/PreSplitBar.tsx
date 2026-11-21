import type { PreSplitter } from '../../engine/stems/presplit';
import { useStore } from '../../engine/store';
import s from '../../platter.module.css';
import m from './mashups.module.css';

const STAGE: Record<string, string> = {
  download: 'getting the model',
  prepare: 'reading',
  separate: 'splitting',
  save: 'saving',
};

function size(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * Pre-splitting, in the Mashups header: switch it on, see how far it's got,
 * pause or resume. Only shown once a music folder is linked.
 */
export function PreSplitBar({ presplit }: { presplit: PreSplitter }) {
  const st = useStore(presplit.store);
  if (!st.hasFolder) return null;
  const counts = st.total ? `${st.done} of ${st.total} tracks split` : null;
  const saved = st.bytes ? `${size(st.bytes)} saved` : null;

  let line: string;
  let action: { label: string; title: string; run: () => void } | null = null;
  let off: boolean = st.phase !== 'off';
  switch (st.phase) {
    case 'off':
      line = 'Split your linked tracks ahead of time, so Split loads at once. Stems are saved in a “Platter Stems” folder inside your music folder, about 30 MB a track.';
      action = { label: 'Pre-split stems', title: 'Asks to save files in your music folder, then splits in the background while Platter is open', run: () => void presplit.start() };
      off = false;
      break;
    case 'checking':
      line = 'Stems: looking for tracks already split…';
      break;
    case 'running': {
      const cur = st.current;
      line = [counts, cur ? `${STAGE[cur.stage]} “${cur.title}”${cur.stage === 'separate' || cur.stage === 'download' ? ` ${Math.round(cur.progress * 100)}%` : ''}` : null, saved].filter(Boolean).join(' · ');
      break;
    }
    case 'waiting':
      line = [counts, st.waitingFor === 'deck' ? 'waiting while a deck plays' : 'waiting for the analysis to finish', saved].filter(Boolean).join(' · ');
      break;
    case 'paused':
      line = ['Stems paused', counts, saved].filter(Boolean).join(' · ');
      action = { label: 'Resume', title: 'Carry on splitting in the background', run: () => void presplit.start() };
      break;
    case 'needs-permission':
      line = 'Stems: the browser needs to be asked again before Platter can save in your music folder.';
      action = { label: 'Resume', title: 'Allow Platter to save in your music folder', run: () => void presplit.start() };
      break;
    case 'done':
      line = ['All tracks split', counts, saved].filter(Boolean).join(' · ');
      break;
  }
  const running = st.phase === 'running' || st.phase === 'waiting' || st.phase === 'checking';

  return (
    <div className={m.presplit} role="group" aria-label="Pre-split stems">
      <p className={m.presplitLine} role="status" aria-live="polite">
        {line}
        {st.failed > 0 && ` · ${st.failed} skipped`}
      </p>
      {action && (
        <button type="button" className={s.action} onClick={action.run} title={action.title}>
          {action.label}
        </button>
      )}
      {running && (
        <button type="button" className={s.action} onClick={() => presplit.pause()} title="Stop splitting for now; Resume carries on">
          Pause
        </button>
      )}
      {off && (
        <button type="button" className={`${s.linkBtn} ${m.syncStop}`} onClick={() => presplit.turnOff()} title="Stop pre-splitting. Stems already saved stay and still load.">
          Turn off
        </button>
      )}
      {st.message && <p className={m.presplitNote}>{st.message}</p>}
    </div>
  );
}
