import { useId } from 'react';
import { useStore } from '../../engine/store';
import { clipBeats, clipLabel, clipRate } from '../../slicer/model';
import type { Studio } from '../../slicer/studio';
import type { Clip } from '../../slicer/types';
import { posLabel } from './Timeline';
import st from './arranger.module.css';

const dB = (g: number) => (g <= 0.0001 ? '−∞ dB' : `${g >= 1 ? '+' : '−'}${Math.abs(20 * Math.log10(g)).toFixed(1)} dB`);
const ms = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const st_ = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} st`;

/**
 * Edits the selected clips: level, pitch, tempo sync, reverse, fades and name.
 * With several selected, a change applies to all of them; values that differ
 * show as "mixed" until you set them.
 */
export function ClipInspector({ studio }: { studio: Studio }) {
  const s = useStore(studio.store);
  const p = s.project;
  const ids = useId();
  const sel = p.clips.filter((c) => s.selection.includes(c.id));
  const first = sel[0];

  if (!first) {
    return (
      <aside className={st.inspector} aria-label="Clip">
        <div className={st.inspHead}>
          <h2 className={st.inspTitle}>Clip</h2>
        </div>
        <p className={st.inspHint}>Select a clip to edit its level, pitch, fades and more. Shift-click or drag a box to pick several.</p>
        <p className={st.inspHint}>Double-click a clip to hear it on its own. Alt-drag copies; Shift-drag ignores the grid.</p>
      </aside>
    );
  }

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
  const rate = clipRate(first, src, p.bpm);

  return (
    <aside className={st.inspector} aria-label={sel.length === 1 ? 'Clip' : `${sel.length} clips`}>
      <div className={st.inspHead}>
        <h2 className={st.inspTitle}>{sel.length === 1 ? 'Clip' : `${sel.length} clips`}</h2>
        {sel.length === 1 ? (
          <p className={st.inspSub}>
            {clipLabel(first, src)}
            <br />
            at {posLabel(first.at, p.meter)} · {beats.toFixed(2)} beats
            <br />
            {first.start.toFixed(3)}–{first.end.toFixed(3)} s{Math.abs(rate - 1) > 0.001 ? ` · ×${rate.toFixed(3)} speed` : ''}
          </p>
        ) : (
          <p className={st.inspSub}>Changes apply to all {sel.length}.</p>
        )}
      </div>

      {sel.length === 1 && (
        <div className={st.prop}>
          <label htmlFor={`${ids}-name`}>Name</label>
          <input
            id={`${ids}-name`}
            className={st.nameInput}
            value={first.name ?? ''}
            placeholder={clipLabel({ ...first, name: undefined }, src)}
            maxLength={60}
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
        </div>
      )}

      <div className={st.prop}>
        <label htmlFor={`${ids}-gain`}>Level</label>
        <span className={st.value} data-mixed={mixed('gain')}>
          {mixed('gain') ? 'mixed' : dB(first.gain)}
        </span>
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
      </div>

      <div className={st.prop}>
        <label htmlFor={`${ids}-pitch`}>Pitch</label>
        <span className={st.value} data-mixed={mixed('semitones')}>
          {mixed('semitones') ? 'mixed' : st_(first.semitones)}
        </span>
        <input
          id={`${ids}-pitch`}
          type="range"
          min={-24}
          max={24}
          step={1}
          value={first.semitones}
          aria-valuetext={st_(first.semitones)}
          onChange={(e) => set({ semitones: Number(e.target.value) }, 'pitch')}
          onPointerUp={end}
          onDoubleClick={() => set({ semitones: 0 }, 'pitch')}
        />
        <div className={st.steps} role="group" aria-label="Pitch steps">
          {[-12, -1, 1, 12].map((d) => (
            <button
              key={d}
              type="button"
              className={st.step}
              aria-label={`${d > 0 ? 'Up' : 'Down'} ${Math.abs(d) === 12 ? 'an octave' : 'a semitone'}`}
              onClick={() => {
                studio.updateClips(sel.map((c) => ({ id: c.id, patch: { semitones: c.semitones + d } })));
              }}
            >
              {d > 0 ? '+' : '−'}
              {Math.abs(d)}
            </button>
          ))}
        </div>
      </div>

      <div className={st.prop}>
        <span className={st.propName}>Playback</span>
        <span />
        <div className={st.switches} style={{ gridColumn: '1 / -1' }}>
          <button
            type="button"
            className={st.tool}
            aria-pressed={!mixed('sync') && first.sync}
            disabled={!canSync}
            aria-describedby={canSync ? undefined : `${ids}-why`}
            title="Play at the song’s tempo (repitched, like a classic chop)"
            onClick={() => set({ sync: !(first.sync && !mixed('sync')) }, 'sync')}
          >
            Sync tempo
          </button>
          <button
            type="button"
            className={st.tool}
            aria-pressed={!mixed('reverse') && first.reverse}
            onClick={() => set({ reverse: !(first.reverse && !mixed('reverse')) }, 'reverse')}
          >
            Reverse
          </button>
        </div>
        {!canSync && (
          <p id={`${ids}-why`} className={st.why}>
            Sync needs the sample’s BPM. Set it in the editor above{sel.some((c) => srcOf(c)?.origin.kind === 'sound') ? ' (drum sounds play as they are)' : ''}.
          </p>
        )}
      </div>

      <div className={st.prop}>
        <label htmlFor={`${ids}-fin`}>Fade in</label>
        <span className={st.value} data-mixed={mixed('fadeIn')}>
          {mixed('fadeIn') ? 'mixed' : ms(first.fadeIn)}
        </span>
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
      </div>

      <div className={st.prop}>
        <label htmlFor={`${ids}-fout`}>Fade out</label>
        <span className={st.value} data-mixed={mixed('fadeOut')}>
          {mixed('fadeOut') ? 'mixed' : ms(first.fadeOut)}
        </span>
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
      </div>

      <div className={st.actions}>
        <button
          type="button"
          className={st.tool}
          onClick={() => {
            const r = clipRate(first, src, p.bpm);
            void studio.audition(first.sourceId, first.start, first.end, { reverse: first.reverse, semitones: 12 * Math.log2(r) });
          }}
        >
          Hear it
        </button>
        <button type="button" className={st.tool} title="Cmd/Ctrl+D" onClick={() => studio.duplicateClips(sel.map((c) => c.id))}>
          Duplicate
        </button>
        <button type="button" className={st.tool} title="Cmd/Ctrl+E" onClick={() => studio.splitAt(studio.position(), sel.map((c) => c.id))}>
          Split here
        </button>
        <button type="button" className={st.tool} title="Cmd/Ctrl+U: snap starts to the grid" onClick={() => studio.quantize(sel.map((c) => c.id))}>
          Quantize
        </button>
        <button type="button" className={`${st.tool} ${st.danger}`} title="Delete" style={{ gridColumn: '1 / -1' }} onClick={() => studio.deleteClips(sel.map((c) => c.id))}>
          Delete {sel.length === 1 ? 'clip' : `${sel.length} clips`}
        </button>
      </div>
    </aside>
  );
}
