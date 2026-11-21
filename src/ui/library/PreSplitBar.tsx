import type { PreSplitState, PreSplitter } from '../../engine/stems/presplit';
import { useStore } from '../../engine/store';
import s from '../../platter.module.css';
import m from './mashups.module.css';

export const STAGE: Record<string, string> = {
  download: 'getting the model',
  prepare: 'reading',
  separate: 'splitting',
  save: 'saving',
};

function size(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export const WAITING: Record<'deck' | 'analysis' | 'model', string> = {
  deck: 'waiting while a deck plays (splitting on the CPU here)',
  analysis: 'waiting for the tempo and key reading',
  model: 'couldn’t get the stems model, trying again shortly',
};

/** “splitting “Song” 42%”, for the track being split now. */
export function currentLine(cur: PreSplitState['current']) {
  if (!cur) return null;
  const pct = cur.stage === 'separate' || cur.stage === 'download' ? ` ${Math.round(cur.progress * 100)}%` : '';
  return `${STAGE[cur.stage]} “${cur.title}”${pct}`;
}

/** How fast the last split ran, against the track's own length. */
function speedLine(st: PreSplitState) {
  if (!st.last || st.last.seconds <= 0) return null;
  const x = st.last.duration / st.last.seconds;
  return `last one ${Math.round(st.last.seconds)} s on the ${st.backend === 'webgpu' ? 'GPU' : 'CPU'} (${x >= 10 ? Math.round(x) : x.toFixed(1)}× real time)`;
}

/**
 * Auto-split, in the Mashups header: what it's doing, and the controls to
 * pause it, turn it off or keep a linked folder's stems next to the music.
 */
export function PreSplitBar({ presplit }: { presplit: PreSplitter }) {
  const st = useStore(presplit.store);
  const counts = st.total ? `${st.done} of ${st.total} tracks split` : null;
  const saved = st.bytes ? `${size(st.bytes)} kept` : null;

  let line: string;
  let action: { label: string; title: string; run: () => void } | null = null;
  switch (st.phase) {
    case 'off':
      line = 'Auto-split is off. Turn it on to split every track you add into stems in the background, about 30 MB a track, so Split is instant.';
      action = { label: 'Turn on', title: 'Split your own tracks in the background as they’re added', run: () => void presplit.start() };
      break;
    case 'checking':
      line = 'Stems: looking for tracks already split…';
      break;
    case 'running':
      line = ['Auto-split', counts, currentLine(st.current), saved].filter(Boolean).join(' · ');
      break;
    case 'waiting':
      line = ['Auto-split', counts, WAITING[st.waitingFor ?? 'analysis'], saved].filter(Boolean).join(' · ');
      break;
    case 'paused':
      line = ['Auto-split paused', counts, saved].filter(Boolean).join(' · ');
      action = { label: 'Resume', title: 'Carry on splitting in the background', run: () => void presplit.start() };
      break;
    case 'done':
      line = [st.total ? (st.done === st.total ? `All ${st.total} tracks split into stems` : `Auto-split: ${counts}`) : 'Auto-split is on: tracks you add are split into stems', saved, speedLine(st)].filter(Boolean).join(' · ');
      break;
  }
  const busy = st.phase === 'running' || st.phase === 'waiting' || st.phase === 'checking';
  const where = st.hasFolder && st.phase !== 'off' && !st.inFolder;

  return (
    <div className={m.presplit} role="group" aria-label="Auto-split stems">
      <p className={m.presplitLine} role="status" aria-live="polite">
        {line}
        {st.failed > 0 && ` · ${st.failed} skipped`}
        {st.locked > 0 && ` · ${st.locked} linked track${st.locked === 1 ? '' : 's'} wait for folder access`}
      </p>
      {action && (
        <button type="button" className={s.action} onClick={action.run} title={action.title}>
          {action.label}
        </button>
      )}
      {where && (
        <button type="button" className={s.linkBtn} onClick={() => void presplit.saveInFolder()} title="Asks to save files in your music folder: your linked tracks’ stems go in a “Platter Stems” folder next to them instead of the browser">
          Keep in music folder
        </button>
      )}
      {busy && (
        <button type="button" className={s.action} onClick={() => presplit.pause()} title="Stop splitting for now; Resume carries on">
          Pause
        </button>
      )}
      {st.phase !== 'off' && (
        <button type="button" className={`${s.linkBtn} ${m.syncStop}`} onClick={() => presplit.turnOff()} title="Stop splitting tracks as they’re added. Stems already kept stay, and still load.">
          Turn off
        </button>
      )}
      {st.message && <p className={m.presplitNote}>{st.message}</p>}
    </div>
  );
}
