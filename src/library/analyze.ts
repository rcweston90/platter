import { detectKeyDetailed, keyName } from '../engine/key';
import { measureEnergy, measureLoudness } from './dsp/loudness';
import { asAudioBufferLike, toMono } from './dsp/pcm';
import { estimateTempo } from './dsp/tempo';
import { ANALYZER_VERSION, type Pcm, type TrackAnalysis, type TrackTags } from './types';

/**
 * Everything the library knows about a track's sound, from decoded audio.
 * Runs the same in the browser (in a worker) and in Node (the scanner).
 *
 *   tempo     src/library/dsp/tempo.ts — onset envelope + tempogram, with an
 *             octave rule so half/double-time reads are offered, not hidden
 *   key       src/engine/key.ts — chroma vs Krumhansl–Kessler profiles
 *   loudness  src/library/dsp/loudness.ts — ITU-R BS.1770-4 LUFS, EBU LRA
 *   energy    the same file — a 1…10 heuristic for comparing tracks
 *
 * Tags written by a store or DJ software win where they agree with the audio
 * (a tagged 87 on a track the audio reads as 174 keeps the store's octave);
 * a tag that disagrees with a confident analysis is ignored.
 */
export function analyzePcm(pcm: Pcm, tags: TrackTags): TrackAnalysis {
  const duration = pcm.channels[0].length / pcm.sampleRate;
  const mono = toMono(pcm);
  const tempo = estimateTempo(mono, pcm.sampleRate);
  const loud = measureLoudness(pcm);
  const energy = measureEnergy(pcm, loud, tempo);
  const key = detectKeyDetailed(asAudioBufferLike(pcm));

  let bpm = tempo?.bpm ?? null;
  let bpmSource: TrackAnalysis['bpmSource'] = 'analysis';
  let bpmConfidence = tempo?.confidence ?? 0;
  if (tags.bpm) {
    if (!tempo || tempo.confidence < 0.2) {
      bpm = tags.bpm;
      bpmSource = 'tag';
    } else {
      // Same tempo family? Keep the analysis' precision at the tag's octave.
      for (const mult of [1, 2, 0.5]) {
        const read = tempo.bpm * mult;
        if (Math.abs(read / tags.bpm - 1) < 0.015) {
          bpm = Math.round(read * 100) / 100;
          bpmSource = mult === 1 ? 'analysis' : 'tag';
          bpmConfidence = Math.max(bpmConfidence, 0.9);
          break;
        }
      }
    }
  }

  const keyFromTag = tags.key;
  const code = keyFromTag ?? key?.code ?? null;
  return {
    analyzer: ANALYZER_VERSION,
    analyzedAt: new Date().toISOString(),
    duration: round(duration, 3),
    bpm: bpm == null ? null : round(bpm, 2),
    bpmConfidence: round(bpmConfidence, 3),
    bpmSource,
    bpmCandidates: (tempo?.candidates ?? []).slice(0, 5).map((c) => ({ bpm: round(c.bpm, 2), salience: round(c.salience, 3) })),
    tempoStability: round(tempo?.stability ?? 0, 3),
    firstBeat: round(tempo?.firstBeat ?? 0, 4),
    firstDownbeat: round(tempo?.firstDownbeat ?? 0, 4),
    key: code,
    keyName: code ? keyName(code) || null : null,
    // A tagged key is trusted; when detection agrees, say so with its margin.
    keyConfidence: round(keyFromTag ? (key?.code === keyFromTag ? Math.max(0.9, key.confidence) : 0.8) : (key?.confidence ?? 0), 3),
    keySource: keyFromTag ? 'tag' : 'analysis',
    lufs: Number.isFinite(loud.lufs) ? round(loud.lufs, 1) : null,
    peakDb: Number.isFinite(loud.peakDb) ? round(loud.peakDb, 1) : null,
    lra: Number.isFinite(loud.lra) ? round(loud.lra, 1) : null,
    energy: energy.energy,
    onsetRate: round(energy.onsetRate, 2),
    brightness: Math.round(energy.brightness),
    lowEnd: round(energy.lowEnd, 3),
  };
}

function round(n: number, places: number) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
