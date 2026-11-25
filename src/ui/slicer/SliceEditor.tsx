import { STEM_LABELS } from '../../engine/stems';
import { MAX_HITS } from '../../slicer/dsp';
import type { Studio, StudioState } from '../../slicer/studio';
import type { Source } from '../../slicer/types';
import type { FrameLoop } from '../frame';
import { Glyph, ICON } from './chopKit';
import { SliceWave } from './SliceWave';
import w from './workspace.module.css';

interface StageProps {
  studio: Studio;
  state: StudioState;
  src: Source;
  loop: FrameLoop;
  slice: number | null;
  pointer: number | null;
  onPointer: (t: number) => void;
  touch: boolean;
}

/** The waveform, or what's happening to the audio while it isn't ready. */
export function SliceStage({ studio, state, src, loop, slice, pointer, onPointer, touch }: StageProps) {
  const audio = state.audio[src.id];
  const status = audio?.status ?? 'loading';
  const ready = status === 'ready' && !!studio.buffer(src.id);
  return (
    <div className={w.stage}>
      {ready ? (
        <SliceWave studio={studio} source={src} slice={slice} meter={state.project.meter} loop={loop} pointer={pointer} onPointer={onPointer} touch={touch} />
      ) : (
        <div className={w.waveState} role="status">
          {status === 'loading' && (
            <>
              <div className={w.shimmer} aria-hidden="true" />
              <p>Reading “{src.name}”…</p>
            </>
          )}
          {status === 'splitting' && (
            <>
              <p>
                Splitting out the {src.stem ? STEM_LABELS[src.stem].toLowerCase() : 'stems'} · {Math.round((audio?.progress ?? 0) * 100)}%
              </p>
              <span
                className={w.bigProgress}
                role="progressbar"
                aria-label="Splitting stems"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((audio?.progress ?? 0) * 100)}
              >
                <span style={{ transform: `scaleX(${audio?.progress ?? 0})` }} />
              </span>
              <p className={w.fine}>Runs on this device. A whole song takes a minute or two.</p>
            </>
          )}
          {(status === 'missing' || status === 'error') && (
            <>
              <p>{audio?.message ?? `“${src.name}” couldn’t be read.`}</p>
              <button type="button" className={w.primary} onClick={() => studio.retry(src.id)}>
                Retry
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface EmptyProps {
  phone: boolean;
  over: boolean;
  onOpenFiles: () => void;
  onBrowse: () => void;
}

/** No sample yet: one big way in. */
export function ChopEmpty({ phone, over, onOpenFiles, onBrowse }: EmptyProps) {
  return (
    <div className={w.emptyState} data-over={over || undefined} data-phone={phone || undefined}>
      <div className={w.dropTarget}>
        <svg viewBox="0 0 64 32" aria-hidden="true" className={w.emptyArt}>
          <path d="M2 16h6l3-9 4 18 4-14 3 8 3-5 4 10 4-16 4 12 3-6 3 4h17" />
          <path d="M22 3v26M40 3v26" className={w.emptyCut} />
        </svg>
        {phone ? (
          <>
            <h2>Pick a sound to slice</h2>
            <p>It arrives cut on its hits, ready to play on the pads: up to {MAX_HITS} slices, even from a whole track.</p>
          </>
        ) : (
          <>
            <h2>Drop a FLAC or WAV here, or pick a track from your crate</h2>
            <p>It arrives cut on its hits, up to {MAX_HITS} slices. Play them on the pads (1–4, Q–R, A–F, Z–V), then build a song on the lanes below.</p>
          </>
        )}
        <div className={w.emptyActions}>
          {phone && (
            <button type="button" className={w.primary} data-big onClick={onBrowse}>
              Pick from your crate
            </button>
          )}
          <button type="button" className={phone ? w.btn : w.primary} data-big={phone || undefined} onClick={onOpenFiles}>
            <Glyph d={ICON.upload} /> Open audio files…
          </button>
        </div>
        <p className={w.fine}>FLAC, WAV, AIFF or MP3. Files stay on this device.</p>
      </div>
    </div>
  );
}
