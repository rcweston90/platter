import { useId } from 'react';
import { clipBeats, clipLabel, clipRate, soundColor } from '../../slicer/model';
import type { Studio } from '../../slicer/studio';
import { SLICE_COLORS, type Clip } from '../../slicer/types';
import { useSel } from './arrangeStore';
import { CloseIcon, TrashIcon } from './LaneHeader';
import { posLabel } from './Timeline';
import st from './arranger.module.css';

const dB = (g: number) => (g <= 0.0001 ? '−∞ dB' : `${g >= 1 ? '+' : '−'}${Math.abs(20 * Math.log10(g)).toFixed(1)} dB`);
const ms = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const semis = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} st`;

/**
 * The selected clips' settings: level, pitch, fades, tempo sync, reverse and
 * the clip actions. Only there while something is selected: a floating panel
 * at the timeline's right edge on desktop, a bottom sheet on phones. With
 * several selected a change applies to all; values that differ read "mixed".
 */
export function ClipInspector({ studio, sheet = false, onClose }: { studio: Studio; sheet?: boolean; onClose: () => void }) {
  const p = useSel(studio.store, (s) => s.project);
  const selection = useSel(studio.store, (s) => s.selection);
  const ids = useId();
  const sel = p.clips.filter((c) => selection.includes(c.id));
  const first = sel[0];
  if (!first) return null;

  const srcOf = (c: Clip) => p.sources.find((x) => x.id === c.sourceId);
  const mixed = <K extends keyof Clip>(k: K) => sel.some((c) => c[k] !== first[k]);
  const set = (patch: Partial<Clip>, key: string) =>
    studio.updateClips(
      sel.map((c) => ({ id: c.id, patch })),
      `insp:${key}`,
    );
  const end = () => studio.endGesture();
  const canSync = sel.every((c) => !!srcOf(c)?.bpm);
  const maxFade = Math.max(0.005, Math.min(...sel.map((c) => (c.end - c.start) / 2)));
  const src = srcOf(first);
  const beats = clipBeats(first, src, p.bpm);
  const one = sel.length === 1;
  const lane = p.lanes.find((l) => l.id === first.laneId);
  const color = lane?.kind === 'drum' ? lane.color : src?.origin.kind === 'sound' ? soundColor(src.origin.soundId) : SLICE_COLORS[src?.color ?? 0];
  const ids_ = sel.map((c) => c.id);
  const hear = () => {
    const r = clipRate(first, src, p.bpm);
    void studio.audition(first.sourceId, first.start, first.end, { reverse: first.reverse, semitones: 12 * Math.log2(r) });
  };

  return (
    <aside
      className={`${st.inspector} ${sheet ? st.inspSheet : ''}`}
      aria-label={one ? 'Clip' : `${sel.length} clips`}
      style={{ ['--clip' as string]: color }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {sheet && <span className={st.grabber} aria-hidden="true" />}
      <div className={st.inspHead}>
        <span className={st.inspDot} aria-hidden="true" />
        {one ? (
          <input
            id={`${ids}-name`}
            className={st.inspName}
            aria-label="Clip name"
            value={first.name ?? ''}
            placeholder={clipLabel({ ...first, name: undefined }, src)}
            maxLength={60}
            spellCheck={false}
            onChange={(e) => set({ name: e.target.value || undefined }, `name:${first.id}`)}
            onBlur={end}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <h2 className={st.inspTitle}>{sel.length} clips</h2>
        )}
        <button type="button" className={st.iconBtn} aria-label={sheet ? 'Close clip settings' : 'Deselect'} title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <p className={st.inspSub}>
        {one ? `${posLabel(first.at, p.meter)} · ${beats < 10 ? beats.toFixed(2) : beats.toFixed(1)} beats${lane ? ` · ${lane.name}` : ''}` : 'Changes apply to all of them'}
      </p>

      <div className={st.props}>
        <div className={st.prop}>
          <label htmlFor={`${ids}-gain`}>Level</label>
          <input
            id={`${ids}-gain`}
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={first.gain}
            aria-valuetext={dB(first.gain)}
            onChange={(e) => set({ gain: Number(e.target.value) }, 'gain')}
            onPointerUp={end}
            onDoubleClick={() => set({ gain: 1 }, 'gain')}
          />
          <output className={st.value} data-mixed={mixed('gain')} htmlFor={`${ids}-gain`}>
            {mixed('gain') ? 'mixed' : dB(first.gain)}
          </output>
        </div>

        <div className={st.prop}>
          <span className={st.propName} id={`${ids}-pitch`}>
            Pitch
          </span>
          <div className={st.stepper} role="group" aria-labelledby={`${ids}-pitch`}>
            {[-12, -1].map((d) => (
              <PitchStep key={d} d={d} onClick={() => studio.updateClips(sel.map((c) => ({ id: c.id, patch: { semitones: c.semitones + d } })))} />
            ))}
            <button type="button" className={st.stepValue} data-mixed={mixed('semitones')} title="Reset to 0" aria-label={`Pitch ${mixed('semitones') ? 'mixed' : semis(first.semitones)}. Reset`} onClick={() => set({ semitones: 0 }, 'pitch')}>
              {mixed('semitones') ? 'mixed' : semis(first.semitones)}
            </button>
            {[1, 12].map((d) => (
              <PitchStep key={d} d={d} onClick={() => studio.updateClips(sel.map((c) => ({ id: c.id, patch: { semitones: c.semitones + d } })))} />
            ))}
          </div>
        </div>

        <div className={st.prop}>
          <label htmlFor={`${ids}-fin`}>Fade in</label>
          <input
            id={`${ids}-fin`}
            type="range"
            min={0}
            max={maxFade}
            step={0.001}
            value={Math.min(first.fadeIn, maxFade)}
            aria-valuetext={ms(first.fadeIn)}
            onChange={(e) => set({ fadeIn: Number(e.target.value) }, 'fadeIn')}
            onPointerUp={end}
            onDoubleClick={() => set({ fadeIn: 0 }, 'fadeIn')}
          />
          <output className={st.value} data-mixed={mixed('fadeIn')} htmlFor={`${ids}-fin`}>
            {mixed('fadeIn') ? 'mixed' : ms(first.fadeIn)}
          </output>
        </div>

        <div className={st.prop}>
          <label htmlFor={`${ids}-fout`}>Fade out</label>
          <input
            id={`${ids}-fout`}
            type="range"
            min={0}
            max={maxFade}
            step={0.001}
            value={Math.min(first.fadeOut, maxFade)}
            aria-valuetext={ms(first.fadeOut)}
            onChange={(e) => set({ fadeOut: Number(e.target.value) }, 'fadeOut')}
            onPointerUp={end}
            onDoubleClick={() => set({ fadeOut: 0 }, 'fadeOut')}
          />
          <output className={st.value} data-mixed={mixed('fadeOut')} htmlFor={`${ids}-fout`}>
            {mixed('fadeOut') ? 'mixed' : ms(first.fadeOut)}
          </output>
        </div>

        <div className={st.segs}>
          <button
            type="button"
            className={st.seg}
            aria-pressed={!mixed('sync') && first.sync}
            disabled={!canSync}
            title={canSync ? 'Play at the song’s tempo (repitched, like a classic chop)' : 'Needs the sample’s BPM (set it in Chop)'}
            onClick={() => set({ sync: !(first.sync && !mixed('sync')) }, 'sync')}
          >
            Sync tempo
          </button>
          <button type="button" className={st.seg} aria-pressed={!mixed('reverse') && first.reverse} onClick={() => set({ reverse: !(first.reverse && !mixed('reverse')) }, 'reverse')}>
            Reverse
          </button>
        </div>
      </div>

      <div className={st.inspActions}>
        <button type="button" className={st.act} onClick={hear} title="Hear it on its own (Enter)">
          <HearIcon />
          <span>Hear</span>
        </button>
        <button type="button" className={st.act} title="Duplicate (Cmd/Ctrl+D)" onClick={() => studio.duplicateClips(ids_)}>
          <DupIcon />
          <span>Copy</span>
        </button>
        <button type="button" className={st.act} title="Split at the playhead (Cmd/Ctrl+E)" onClick={() => studio.splitAt(studio.position(), ids_)}>
          <SplitIcon />
          <span>Split</span>
        </button>
        <button type="button" className={st.act} title="Snap starts to the grid (Cmd/Ctrl+U)" onClick={() => studio.quantize(ids_)}>
          <QuantIcon />
          <span>Snap</span>
        </button>
        <button type="button" className={st.act} data-danger="true" title="Delete (Backspace)" onClick={() => studio.deleteClips(ids_)}>
          <TrashIcon />
          <span>Delete</span>
        </button>
      </div>
    </aside>
  );
}

function PitchStep({ d, onClick }: { d: number; onClick: () => void }) {
  return (
    <button type="button" className={st.step} aria-label={`${d > 0 ? 'Up' : 'Down'} ${Math.abs(d) === 12 ? 'an octave' : 'a semitone'}`} onClick={onClick}>
      {d > 0 ? '+' : '−'}
      {Math.abs(d)}
    </button>
  );
}

export const HearIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.5 6v4h2.5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const DupIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2" y="4.5" width="7.5" height="7.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M6.5 2.5h6a1 1 0 0 1 1 1v6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const SplitIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 1.5v13M2 4.5h4v7H2M14 4.5h-4v7h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const QuantIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 2.5v11M6 2.5v11M10 2.5v11M14 2.5v11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
    <rect x="6" y="5.5" width="4" height="5" rx="1" fill="currentColor" />
  </svg>
);
