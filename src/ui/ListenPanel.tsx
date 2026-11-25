import { useEffect, useId, useState } from 'react';
import type { AudioHealth } from '../engine/engine';
import { LISTEN_SOURCES } from '../engine/listen';
import type { DjSession } from '../engine/session';
import { useStore, useStoreSelect } from '../engine/store';
import { LISTEN_GUIDE, InfoTip } from './DeckGuide';
import { screenAwake } from './wakeLock';
import s from '../platter.module.css';
import l from './listen.module.css';

const levelText = (v: number) => (v <= 0 ? 'off' : `${v >= 0.8 ? '+' : '−'}${Math.abs(40 * Math.log10(v / 0.8)).toFixed(1)} dB`);
/** The desktop Outputs menu grew a section: keep it inside short windows. */
export const outputsPanel = l.outputsPanel;
const ms = (sec: number) => `${Math.round(sec * 1000)} ms`;

/**
 * The top of the Outputs menu (and the phone's More menu): what you hear on
 * the main output, its own volume, and how the audio is holding up.
 */
export function ListenPanel({ session }: { session: DjSession }) {
  const { source, level } = useStore(session.listen.store);
  const routing = useStoreSelect(session.mixer, (m) => m.cueRouting.kind);
  const volId = useId();
  const applies = routing === 'off';

  return (
    <div className={l.listen}>
      <div className={l.head}>
        <span className={l.title} id={`${volId}-h`}>
          Listen to
        </span>
        <InfoTip label="About Listen to and audio health" title="Listening" sections={[LISTEN_GUIDE]} deck="A" className={l.info} />
      </div>
      <div className={l.sources} role="group" aria-labelledby={`${volId}-h`}>
        {LISTEN_SOURCES.map((o) => (
          <button
            key={o.id}
            type="button"
            className={s.mini}
            aria-pressed={source === o.id}
            disabled={!applies && o.id !== 'master'}
            title={o.hint}
            onClick={() => session.listen.setSource(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {!applies && source !== 'master' && (
        <p className={s.popNote}>
          The headphones have their own output ({routing === 'split' ? 'Split' : 'a second device'}), so this output plays the master. Your pick comes back with Headphones off.
        </p>
      )}
      <div className={l.volume}>
        <label htmlFor={volId}>Listening volume</label>
        <input
          id={volId}
          type="range"
          className={l.slider}
          min={0}
          max={1}
          step={0.01}
          value={level}
          onChange={(e) => session.listen.setLevel(Number(e.target.value))}
          onDoubleClick={() => session.listen.setLevel(0.8)}
          aria-valuetext={levelText(level)}
        />
        <output htmlFor={volId} className={l.readout}>
          {levelText(level)}
        </output>
      </div>
      <p className={s.popNote}>Only what you hear here: the master level, the meters and a recording stay as they are.</p>
      <Health session={session} />
    </div>
  );
}

/** Sample rate, latency, dropouts (where the browser counts them) and the screen lock. */
function Health({ session }: { session: DjSession }) {
  const audio = useStoreSelect(session.mixer, (m) => m.audio);
  const [h, setH] = useState<AudioHealth | null>(null);
  const awake = useStore(screenAwake().store).state;

  useEffect(() => {
    if (audio !== 'running') return;
    const read = () => {
      const next = session.engine?.health() ?? null;
      setH((was) =>
        was && next && was.sampleRate === next.sampleRate && was.baseLatency === next.baseLatency && was.outputLatency === next.outputLatency && was.dropouts === next.dropouts
          ? was
          : next,
      );
    };
    read();
    const t = window.setInterval(read, 1000);
    return () => window.clearInterval(t);
  }, [audio, session]);

  return (
    <section className={l.health} aria-label="Audio health">
      <h3 className={l.title}>Audio health</h3>
      {!h ? (
        <p className={s.popNote}>Shown once the audio starts.</p>
      ) : (
        <dl className={l.stats}>
          <div>
            <dt>Sample rate</dt>
            <dd data-stat="rate">{h.sampleRate.toLocaleString('en-US')} Hz</dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd data-stat="latency">
              {ms(h.baseLatency)} base{h.outputLatency ? ` · ${ms(h.outputLatency)} to the speakers` : ''}
            </dd>
          </div>
          <div>
            <dt>Dropouts</dt>
            <dd data-stat="dropouts" className={h.dropouts ? l.warn : undefined}>
              {h.dropouts === null
                ? 'Not reported by this browser'
                : h.dropouts === 0
                  ? 'None'
                  : `${h.dropouts}${h.dropoutMs ? ` (${Math.round(h.dropoutMs)} ms of gap)` : ''}`}
            </dd>
          </div>
          {awake !== 'unsupported' && (
            <div>
              <dt>Screen</dt>
              <dd data-stat="screen">{awake === 'held' ? 'Kept awake: a deck is playing' : awake === 'refused' ? 'The browser won’t keep it awake right now' : 'Kept awake while a deck plays'}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
