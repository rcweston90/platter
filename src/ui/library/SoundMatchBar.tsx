import type { SoundMatch } from '../../library/sound';
import { useStore } from '../../engine/store';
import s from '../../platter.module.css';
import m from './mashups.module.css';

/**
 * Sound match: switch it on, see how many tracks have been listened to,
 * switch it off. Shown in Up next and in the Mashups header.
 */
export function SoundMatchBar({ sound }: { sound: SoundMatch }) {
  const st = useStore(sound.store);
  const counts = st.total ? `${st.done} of ${st.total} tracks listened to` : null;

  let line: string;
  let action: { label: string; title: string; run: () => void } | null = null;
  let canStop = true;
  switch (st.phase) {
    case 'off':
      canStop = false;
      line =
        st.done > 0
          ? `Sound match is off. ${counts}; those still count.`
          : 'Sound match: an open audio model listens to your own tracks in this browser, so suggestions also weigh how they sound together. It downloads once (about 34 MB); your music never leaves this browser.';
      action = { label: st.done > 0 ? 'Turn on' : 'Listen to my tracks', title: 'Downloads the model once, then listens to your own files in the background', run: () => sound.start() };
      break;
    case 'starting':
      line = 'Sound match: starting…';
      break;
    case 'download':
      line = `Sound match: getting the model ${Math.round(st.download * 100)}%`;
      break;
    case 'running':
      line = [counts, st.current ? `listening to “${st.current}”` : null].filter(Boolean).join(' · ');
      break;
    case 'waiting':
      line = [counts, 'waiting for the analysis to finish'].filter(Boolean).join(' · ');
      break;
    case 'done':
      line = st.total ? `Sound match: all ${st.total} of your tracks listened to.` : 'Sound match is on. Add or link your own music for it to listen to.';
      break;
    case 'error':
      canStop = false;
      line = st.message ?? 'Sound match stopped.';
      action = { label: 'Try again', title: 'Start sound match again', run: () => sound.start() };
      break;
  }

  return (
    <div className={m.presplit} role="group" aria-label="Sound match">
      <p className={m.presplitLine} role="status" aria-live="polite">
        {line}
        {st.failed > 0 && st.phase !== 'error' && ` · ${st.failed} couldn’t be read`}
      </p>
      {action && (
        <button type="button" className={s.action} onClick={action.run} title={action.title}>
          {action.label}
        </button>
      )}
      {canStop && (
        <button type="button" className={`${s.linkBtn} ${m.syncStop}`} onClick={() => sound.stop()} title="Stop listening. Tracks already listened to keep counting.">
          Turn off
        </button>
      )}
    </div>
  );
}
