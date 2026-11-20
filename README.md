# Platter

Two turntables, a club mixer, a sampler and a crate, in the browser. Drop in
your own music, stream from Audius or link a music folder, and mix: scratch
the records, sync the beats, mix in key, loop and roll, throw on beat FX, fire
samples, cue in headphones, play from a MIDI controller, let Auto-DJ take
over, and record the set. Nothing is uploaded — files stay in your browser.

It opens with two demo tracks cued (synthesised in the browser at 124 and
128 BPM), so you can press play and try SYNC straight away.

**Live:** https://rcweston90.github.io/platter/ (published from `main` by
GitHub Actions).

## Features

**Decks**
- Grab the record to scratch. The platter's rotation *is* the playhead, so it
  slows, stops and runs backwards under your hand.
- CDJ-style CUE: while playing, back to the cue point and stop; while stopped,
  set the cue point and hold to preview.
- Performance pads in three modes: **hot cues** (four, saved per track),
  **beat rolls** (1/8 to 1 beat, held), and **tricks** — censor (hold to play
  backwards), reverse, brake and spinback.
- **Slip**: scratches, loops, rolls and reverse return to where the track
  would have been; a dashed ghost playhead shows where that is.
- Beat loops (1/4 to 32 beats, halve and double) and beat jump, snapped to
  the grid when QUANT is on.
- Pitch fader with ±8 / ±16 / ±50% ranges and hold-to-bend nudge buttons, and a
  33 / 45 platter speed switch (45 plays 1.35× fast, on top of the fader).
- SYNC matches the other deck's tempo and lines up the beats; the phase meter
  between the waveforms shows each deck's beat in the bar and how far apart
  their beats are.
- **Keylock** holds the key while you change tempo.
- **Stems**: split a track into vocals, drums, bass and other, then tap a part
  to mute it or hold it to hear it alone. The split runs in your browser
  (Meta's HTDemucs on ONNX Runtime Web, on the GPU through WebGPU where it
  can, otherwise the CPU) and the stems stay in memory with the deck; nothing
  is saved or uploaded. The ~170 MB model downloads once and is cached. Your
  own files can be split; SoundCloud tracks never (its API terms forbid AI
  source separation); Audius tracks only under a Creative Commons license
  that allows adaptations.

**Harmonic mixing**
- Each track's key is detected (or read from its tags) and shown in Camelot
  notation (8A = A minor). The key you hear follows the pitch fader unless key
  lock holds it.
- The crate colours keys that mix with what's playing.
- Key shift ♭/♯ by semitones, and **Match** shifts to the nearest key that
  mixes with the other deck.

**Mixer**
- Trim, three-band isolator EQ (fully left kills the band) and a one-knob
  low-/high-pass filter per channel.
- **Beat FX** per channel — echo, reverb, flanger, phaser, trans and crush —
  timed in beats of that deck's live tempo.
- Channel and master peak meters, a safety limiter on the master.
- Crossfader with Smooth, Full and Cut (scratch) curves.
- Headphone cue (PFL) with a cue/master blend: split one output (master left,
  cue right, for a splitter cable) or send the cue to a second audio device.
- **Sampler**: 64 pads in four banks of 16, and a library of 860+ sounds
  (kicks, snares, claps, hats, cymbals, toms, percussion, bass, chord stabs,
  keys, FX, vox, loops and textures) with categories, search, favourites and
  click-to-hear in the headphones. Tonal sounds carry a Camelot key, and
  "In key" keeps to the ones that mix with the loaded tracks. Twenty kits
  load a whole bank at once; drop your own audio files on a pad or into the
  library. Each pad has its own volume, tune and choke group; drag a pad onto
  another to swap them. Most sounds are synthesised in the browser on first
  use; 189 are recordings from Sonic Pi's public-domain (CC0) sample set,
  fetched only when you use them.
- **Beat board**: a 16- or 32-step sequencer over one bank's 16 pads, with
  eight patterns (switched on the bar), accents, MPC-style swing, per-lane
  volume, mute and solo, eight starter grooves, tap tempo and live recording
  from the pads. It locks to a playing deck's beat grid, not just its tempo,
  so it stays on the beat through tempo changes, hot cues and beat jumps, and
  falls back to its own clock when the decks stop.

**Library**
- **Crate**: drop files, use **Add files**, or **link a music folder**
  (Chrome and Edge) so the crate reads files in place. Title, artist, cover art and key come from the
  tags, or from an `Artist - Title` file name. Tempo, beat grid and key are
  analysed on import.
- **Browse music** (top bar, or **Browse online** in the crate) opens a panel
  beside the decks with Audius and SoundCloud, so you can search and load
  while you mix. Each track shows its artwork, length, tempo and whether it
  can go on the decks.
- **Audius**: search or browse trending tracks on
  [Audius](https://audius.co) — open, free music — and stream them onto the
  decks. Tracks keep a link back to the artist.
- **SoundCloud** (on the Vercel site): sign in to browse your likes,
  playlists and uploads, or search. Your own uploads, and tracks whose artist
  chose a Creative Commons license that allows remixes, stream onto the
  decks; SoundCloud's API terms keep every other track on SoundCloud, so
  those rows link out instead. Audio is streamed each time a track loads and
  never saved, and every track credits its artist and links back.
- **Auto-DJ**: queue tracks and it mixes them like a DJ would — the next
  track waits synced on the idle deck, starts on its first beat 8, 16 or 32
  bars before the end, and crossfades with a bass swap halfway.
- **Recordings**: every recorded mix is kept until you delete it.

**Controllers and keyboard**
- **MIDI learn** for every deck, mixer and sampler control: press Learn, move
  a knob or button. Jog wheels scratch while touched and nudge otherwise;
  mapped buttons light up to match the rig.
- A full keyboard layout (below).

**Saves**
- The crate, its analysis and every cue point; settings; MIDI mappings;
  sampler pads; recordings; and which tracks were on the decks — all kept in
  this browser (IndexedDB).
- **Backup** saves cues, tempo, keys, settings and MIDI mappings (not the
  audio) as one JSON file; **Import** restores it on another browser once the
  same files are added, matched by file name.
- **Import** also reads a **Rekordbox** collection export (`.xml`): tempo,
  first beat, key, memory cue and hot cues A–D.

**Install**: on a real host Platter is an installable app that opens
offline after the first visit.

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
| `F` · `H` | Beat FX on / off |
| `C` · `,` | Censor (hold) |
| `V` · `.` | Slip on / off |
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

Requires a current Chromium, Firefox or Safari (Safari has no Web MIDI, and
only Chromium-based browsers can link a folder). Audio starts on your first
press of play. Choosing output devices by name uses `setSinkId`, which
Chromium supports best; it asks for microphone permission only because
that's when browsers reveal device names — nothing is recorded.

```bash
npm run test:e2e     # against a running dev or preview server
npm run test:controls  # clicks every deck and mixer control and checks its effect
```

The end-to-end check drives a real browser through cueing, playing, sync,
scratching, key lock, import, recording, key matching, beat FX, rolls, the
sampler, its sound library and kits, the beat board (on its own clock and
locked to a deck), MIDI learn, Auto-DJ, backup and Rekordbox import, recordings,
Audius and SoundCloud (with their APIs mocked). It needs a Playwright Chromium
(`npx playwright install chromium`), or any recent Chrome named in
`PLATTER_CHROME`; set `PLATTER_URL` to test another address. `window.platter` is the running rig, for the console.

### Deploying

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on every
push to `main`. Turn it on once under Settings → Pages → Source: GitHub
Actions. Any static host works the same way: serve `dist/`.

**SoundCloud** needs the Vercel deployment: `api/soundcloud.ts` is a Vercel
Function that holds the app's secret for the OAuth exchange and keeps the
refresh token in an HttpOnly cookie. Register an app at SoundCloud with the
redirect URI `https://<your-site>/soundcloud-callback` (`vercel.json`
rewrites that path to the app), then set `SOUNDCLOUD_CLIENT_ID` and
`SOUNDCLOUD_CLIENT_SECRET` in the Vercel project. On a static host the
SoundCloud side of Browse music says it isn't available.

`npm run artifact` packages the build as a claude.ai artifact. That sandbox
keeps pages away from other sites and devices, so Audius, MIDI, folder
linking and offline install are only on a normal host.

## How it works

```
public/worklets/deck.js   the turntable: a signed, variable-rate playhead, plus slip and stems
src/engine/
  deck.ts       transport, cues, loops, rolls, tricks, pitch, sync, key lock/shift
  mixer.ts      channel strip: trim → isolator EQ → filter → beat FX → fader/cue/meter
  fx.ts         the beat FX unit
  engine.ts     AudioContext, master bus and limiter, headphone routing, recorder
  session.ts    the rig: decks, mixer, crate, sampler, MIDI, Auto-DJ, saves
  analysis.ts   decoding, three-band waveform peaks, tempo, tags
  key.ts        key detection and Camelot arithmetic
  sampler.ts    the 64 pads: playing, choke groups, kits, your own sounds
  beatboard.ts  the step sequencer and its lock to the decks' beat grid
  sounds/       the sound library: synth voices, kits, grooves, CC0 credits
  midi.ts       MIDI learn, mappings, LED feedback
  autodj.ts     queue and automatic transitions
  audius.ts     Audius search, trending and streaming
  stems/        stem separation: which tracks may be split, the worker, the HTDemucs loop
  soundcloud.ts SoundCloud sign-in (PKCE), browsing, streaming, licence checks
  folder.ts     linked music folders (File System Access)
  backup.ts     JSON backup, Rekordbox XML import
  library.ts    everything kept in IndexedDB
  demo.ts       the two demo tracks, synthesised sample by sample
api/soundcloud.ts  Vercel Function: OAuth token exchange, API and media relay
src/ui/         React: turntables, waveforms, phase meter, mixer, panels
src/ui/beats/   pads, beat board and the Sounds browser
public/sounds/cc0/  the CC0 recordings, fetched on first use
```

- **The playhead is an AudioWorklet.** An `AudioBufferSourceNode` can't play
  backwards or follow a hand, so each deck runs its own processor: decoded
  PCM and one fractional read position, read with Hermite interpolation. The
  motor eases the rate toward `±(1 + pitch)` with a spin-up and a brake.
  While scratching, the UI sends where your hand has dragged the record and
  the playhead chases it. Jumps cross-fade over six milliseconds, so they
  don't click.
- **Slip** is a second, shadow playhead in the same worklet that keeps
  running at the motor's speed during a scratch, roll, censor or reverse;
  when that ends, playback jumps to it.
- **Key lock and key shift** run Signalsmith Stretch as a live pitch-shifter
  after the playhead: play at rate *r*, shift by −12·log₂(*r*) semitones plus
  any key shift. Its latency is taken out of the displayed position so
  waveforms and SYNC stay honest.
- **Key detection** builds a pitch-class profile from the spectral peaks of
  the whole track (bass weighted, since it names the tonic) and correlates it
  with the Krumhansl–Kessler major and minor profiles. The open-source key
  finders worth using are GPL/AGPL, so this one is written here, MIT.
- **The EQ is an isolator**: Linkwitz–Riley crossovers at 220 Hz and 2.6 kHz,
  so a band turned all the way down is gone. Waveforms split at the same
  frequencies, so killing the low is the blue you'd expect to lose.
- **Beat FX** read each deck's live tempo, so a 3/4-beat echo stays 3/4 of a
  beat when the pitch fader moves; send effects ring out when switched off.
- **Positions on screen** come from the context's output timestamp, so what
  you see is what you hear, output latency included. Loops are placed at the
  beat you hear and fold the playhead in if it has already passed.
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
and [music-metadata](https://github.com/Borewit/music-metadata) — streams
from [Audius](https://audius.co)'s open API, and its deck and mixer follow
the conventions of [Mixxx](https://mixxx.org), the open-source DJ app. The
sampler's recorded sounds are from [Sonic Pi](https://github.com/sonic-pi-net/sonic-pi)'s
CC0 sample set (Freesound contributors, credited per sound in the app), and
the beat board's timing follows Chris Wilson's MIT-licensed
[metronome](https://github.com/cwilso/metronome). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
