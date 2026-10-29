# Platter

Two turntables, a club mixer and a crate, in the browser. Drop in your own
music and mix it: scratch the records, sync the beats, loop, set hot cues,
cue in headphones and record the set. Nothing is uploaded — files stay in your
browser.

It opens with two demo tracks cued (synthesised in the browser at 124 and
128 BPM), so you can press play and try SYNC straight away.

## Features

**Decks**
- Grab the record to scratch. The platter's rotation *is* the playhead, so it
  slows, stops and runs backwards under your hand.
- CDJ-style CUE: while playing, back to the cue point and stop; while stopped,
  set the cue point and hold to preview.
- Four hot cues and beat loops (1/4 to 32 beats, halve and double), beat
  jump, all snapped to the beat grid when QUANT is on.
- Pitch fader with ±8 / ±16 / ±50% ranges and hold-to-bend nudge buttons.
- SYNC matches the other deck's tempo and lines up the beats.
- KEY locks the key while you change tempo.
- Tempo and beat grid are detected on import; ÷2, ×2, TAP and grid nudge fix
  the cases detection gets wrong (half-time drum & bass, live drums).

**Mixer**
- Trim, three-band isolator EQ (fully left kills the band), and a one-knob
  low-/high-pass filter per channel.
- Channel and master peak meters, a safety limiter on the master.
- Crossfader with Smooth, Full and Cut (scratch) curves.
- Headphone cue (PFL) with a cue/master blend: split one output (master
  left, cue right, for a splitter cable) or send the cue to a second audio
  device.
- Record the master and save it as a file.

**Crate**
- Add files by dropping them on the crate or straight onto a deck. Title,
  artist and cover art are read from the tags, or from an `Artist - Title`
  file name.
- Tracks, their analysis and their cue points are kept in IndexedDB, so the
  crate is still there next time.

## Keyboard

Physical keys, so the layout works on any keyboard language. Deck A on the
left hand, deck B on the right.

| Deck A · Deck B | Action |
|---|---|
| `Q` · `P` | Cue (hold to preview) |
| `W` · `O` | Play / pause |
| `E` · `I` | Sync |
| `A` `S` · `K` `L` | Bend slower / faster (hold) |
| `D` · `J` | Loop on / off |
| `Z` `X` · `N` `M` | Beat jump back / forward |
| `1`–`4` · `7`–`0` | Hot cues (`Shift` to clear) |
| `[` `]` | Crossfader left / right (`Shift`: all the way) |
| `\` | Crossfader to centre |

Knobs and sliders take the arrow keys when focused; double-click resets them.
Focus a platter and hold an arrow key to nudge.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/ — host it anywhere, any sub-path
npm run preview
```

Requires a current Chromium, Firefox or Safari. Audio starts on your first
press of play (browsers don't allow sound before a click). Choosing output
devices by name uses `setSinkId`, which Chromium supports best; it asks for
microphone permission only because that's when browsers reveal device names
— nothing is recorded.

```bash
npm run test:e2e     # against a running dev or preview server
```

The end-to-end check drives a real browser through cueing, playing, sync,
scratching, key lock, file import and recording. It needs a Playwright
Chromium (`npx playwright install chromium`); set `PLATTER_URL` to test
another address.

## How it works

```
public/worklets/deck.js   the turntable: one signed, variable-rate playhead
src/engine/
  deck.ts       transport, cue, hot cues, loops, pitch, sync, key lock, scratch
  mixer.ts      channel strip: trim → isolator EQ → filter → fader/cue/meter
  engine.ts     AudioContext, master bus and limiter, headphone routing, recorder
  session.ts    the rig: two decks, the mixer, the crate, loading and analysis
  analysis.ts   decoding, three-band waveform peaks, tempo, tags
  library.ts    the crate in IndexedDB
  demo.ts       the two demo tracks, synthesised sample by sample
src/ui/         React: turntables, waveforms, mixer, crate, top bar
```

- **The playhead is an AudioWorklet.** An `AudioBufferSourceNode` can't play
  backwards or follow a hand, so each deck runs its own processor: decoded
  PCM and one fractional read position, read with Hermite interpolation. The
  motor eases the rate toward `1 + pitch` (with a spin-up and a brake). While
  scratching, the UI sends where your hand has dragged the record and the
  playhead chases it, which turns 60 Hz pointer events into a smooth,
  sample-accurate rate. Jumps (cues, loops, needle drops) cross-fade over six
  milliseconds, so they don't click.
- **Key lock** runs Signalsmith Stretch as a live pitch-shifter after the
  playhead: play at rate *r*, shift by −12·log₂(*r*) semitones. Its latency is
  taken out of the displayed position so waveforms and SYNC stay honest. While
  your hand is on the record the deck bypasses it, as DJ hardware does.
- **The EQ is an isolator**: Linkwitz–Riley crossovers at 220 Hz and 2.6 kHz,
  so a band turned all the way down is gone, not just quieter.
- **Waveforms** are three-band peak envelopes split at the same crossovers,
  so killing the low on the mixer is the blue you'd expect to lose.
- **Positions on screen** come from the context's output timestamp, so what
  you see is what you hear, output latency included.
- **One requestAnimationFrame** draws everything, and only while audio runs.
- **No audio until the first press.** The decks open armed (title, waveform,
  cue point); the audio is decoded or synthesised on the first play.

### Hosts that refuse `blob:` worklets

Signalsmith Stretch builds its worklet as a `blob:` URL. Some hosts (strict
CSPs, sandboxed frames) only allow worklets from the site's own files, so
`scripts/extract-stretch-worklet.mjs` captures that exact module source at
build time and writes it to `public/worklets/stretch.js`, and the app points
the library at it through its `moduleUrl` hook.

## Open source

Platter is MIT-licensed. It stands on three MIT libraries —
[Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch),
[web-audio-beat-detector](https://github.com/chrisguttandin/web-audio-beat-detector)
and [music-metadata](https://github.com/Borewit/music-metadata) — and its
deck and mixer follow the conventions of [Mixxx](https://mixxx.org), the
open-source DJ app. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
