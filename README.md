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
  slows, stops and runs backwards under your hand. Turn the rim to bend the
  tempo. A per-deck **Vinyl / CDJ** jog switch: in CDJ mode the top of the
  record bends like the rim instead of holding the track.
- **Instant doubles** (per deck, on by default): load the track the other deck
  has and it joins it at the same place, tempo, loop and play state.
- Scroll over a playing record (wheel or trackpad) to nudge it; hold Shift
  and scroll over a paused one to inch the playhead.
- CDJ-style CUE: while playing, back to the cue point and stop; while stopped,
  set the cue point and hold to preview.
- Performance pads in three modes: **hot cues** (two banks of eight, A–H
  and I–P, saved per track, each in a colour you pick; press one while a
  loop runs for a **hot loop**; **Gate** plays a cue only while held),
  **beat rolls** (1/8 to 1 beat, held), and **tricks** — censor (hold to play
  backwards), reverse, brake and spinback. Up to ten **memory cues** per
  track, stepped through to set the cue point.
- **Slip**: scratches, loops, rolls and reverse return to where the track
  would have been; a dashed ghost playhead shows where that is.
- Beat loops (1/4 to 32 beats) and manual loops (LOOP IN, LOOP OUT; hold IN
  for 4 beats), halve and double for either, RELOOP / EXIT, and in/out edge
  adjust by button, arrow key or a drag on the waveform. Beat jump has its own
  size (1/2 to 64 beats) and carries a running loop with it. QUANT snaps to
  1/8, 1/4, 1/2 or 1 beat.
- Pitch fader with ±6 / ±8 / ±10 / ±16 / WIDE (±100%) ranges, a tempo reset
  button, hold-to-bend nudge buttons, and a 33 / 45 platter speed switch
  (45 plays 1.35× fast, on top of the fader).
- **Sync lock**: press SYNC and that deck follows the other (tagged
  *Sync ▸ A* on its waveform; the other is tagged *Leader*). It takes the
  leader's tempo, at double or half time when one track is twice the other,
  and keeps its beat on the leader's for as long as SYNC is lit: through the
  leader's tempo changes, cue jumps, loops and scratches. Either fader moves
  both; nudging either deck sets an offset the lock keeps (Reset clears it).
  SYNC on the leader swaps roles, and loading a new track on the leader while
  its follower plays hands the lead to the deck that's playing.
- **Sync strip** between the waveforms: both decks' beat grids around the
  playhead, A's from the top and B's from the bottom, with bars long and in
  the deck's colour. Lined up, they meet in straight lines; out of phase they
  stagger, and a bracket at the playhead spans the gap. The readouts say how
  the tempos compare, how many ms apart the beats are and whether the bars
  start together, with **Line up bars** to put the 1s together. The
  waveforms scroll in heard time, so at the same tempo a beat is the same
  width on both.
- **Waveform smarts**: phrases (intro, verse, build, drop, breakdown,
  outro) read from the waveform on 8-bar lines of the beat grid, shown as a
  coloured band and tint on both waveforms with short labels; a **beat
  countdown** on each deck (bars.beats to the next hot or memory cue, or to
  the loop's end); a **phase meter** on deck B's waveform while both play;
  and **grid edit** (the Grid button): nudge the grid 1 or 10 ms, set the
  downbeat at the playhead, halve or double the tempo — saved with the
  track, and kept when it's analysed again.
- **Beat pitch** lanes above deck A's waveform and below deck B's: each hit
  as a bar, higher hits higher, so you can hear and see which beats in a
  loop sit above or below the others. Notes read as note names (C#3);
  drums and other unpitched hits show hollow, placed by their brightness.
  The hit under the playhead lights up, and with a loop set the lane holds
  the whole pattern still and a playhead sweeps across it. Read in your
  browser when a track loads; the pitch button by the zoom hides them.
- **Keylock** holds the key while you change tempo.
- **Stems**: split a track into vocals, drums, bass and other, then tap a part
  to mute it or hold it to hear it alone. The split runs in your browser
  (Meta's HTDemucs on ONNX Runtime Web, on the GPU through WebGPU where it
  can, otherwise the CPU) and the stems stay in memory with the deck; nothing
  is uploaded. The ~170 MB model downloads once and is cached. Your
  own files can be split; SoundCloud tracks never (its API terms forbid AI
  source separation); Audius tracks only under a Creative Commons license
  that allows adaptations.
- **Auto-split stems** (on by default; Pause or Turn off in the Mashups
  tab): every track you add from your own files is split into stems in the
  background, so Split on a deck loads them at once. A deck's own track goes
  first, then the newest added. Each row in the crate shows its stems
  (queued, splitting with a percentage, saving, ready) and the crate's
  status bar shows the queue. On the GPU it carries on while you play; on the
  CPU it waits for the decks to stop, so the audio never stutters. A deck that
  presses Split on the track being split joins that split instead of starting
  again, and a file that changes is split again. Stems are kept as Opus at
  256 kb/s, about 30 MB a five-minute track: for a linked folder, in
  `Platter Stems/` next to your music once you choose "Keep in music folder"
  (the browser asks), otherwise in the browser's own private storage for this
  site, by file fingerprint, so the same file added twice is split once.
  Nothing is uploaded.
- **Splitting speed**: while the model works on one 7.8 s window (on the
  GPU), the next window's spectrogram and the last one's output are worked
  out alongside it, with an FFT that transforms both stereo channels at once
  (`stems/spectral.ts`, the same numbers as demucs-web to about 1e-7, 2 to 3
  times faster), so our own JavaScript adds little to the model's time.

**Harmonic mixing**
- Each track's key is detected (or read from its tags) and shown in Camelot
  notation (8A = A minor). The key you hear follows the pitch fader unless key
  lock holds it.
- The crate colours keys that mix with what's playing.
- Key shift ♭/♯ by semitones, up to an octave each way, and **Match** shifts to the nearest key that
  mixes with the other deck.

**Mixer**
- Trim, three-band EQ and a one-knob low-/high-pass filter per channel. The
  EQ switches between ISO, an isolator (fully left kills the band), and EQ, a
  classic shelf / mid / shelf from +6 to −26 dB. The filter locks off at centre.
- **Beat FX**: one unit you send to deck A, deck B or the master — delay,
  echo, ping pong, spiral, reverb, helix, roll, triplet roll, flanger, phaser,
  filter, triplet filter, mobius, trans and crush — timed in beats of the
  deck's live tempo (or a tapped one), with a TIME readout, low/mid/high band
  select, an X-pad and FX quantize.
- Channel and master peak meters, a safety limiter on the master.
- Crossfader with Smooth, Full and Cut (scratch) curves, and an A / THRU / B
  assign per channel. Channel faders have Slow, Linear and Fast-cut curves.
- Headphone cue (PFL) with a cue/master blend: split one output (master left,
  cue right, for a splitter cable) or send the cue to a second audio device.
- **Listen to** (Outputs, or More on a phone): on a single output, hear the
  master, deck A's cue, deck B's cue or the cue/master blend, at a listening
  volume that leaves the master, the meters and recordings alone. The same
  menu shows the sample rate, latency and, where the browser reports them,
  dropouts. The screen stays awake while a deck plays.
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
- **Library flyout**: the library lives in a sheet pinned to the bottom of
  the window, so it's always one click away and never below the fold.
  Closed, only its header shows: the tabs (Crate, Playlists, Up next,
  Mashups, Auto-DJ, Recordings) and decks A and B as drop targets, with the deck
  <kbd>Enter</kbd> would load to marked **Next**. Click a tab, the chevron or
  **Tracks**, or press <kbd>T</kbd>, and it slides up over the lower part of
  the rig; the top bar and waveforms stay in view. Drag its top edge (or
  focus it and use the arrow keys) to resize it, double-click it or use the
  double chevron to give it all the room under the waveforms, and press
  <kbd>Esc</kbd> or <kbd>T</kbd> to put it away. Its height, whether it was
  open and the last tab carry over between visits. On a laptop or bigger the
  rest of the rig fills the window like DJ software: the waveforms stay
  pinned and the decks and mixer scroll in the middle. On a phone the sheet
  sits on the play and crossfader dock.
- **Track list**: search, sort by any column, and filter by source, folder
  (down the side when there's room) or **Mix with**, which keeps to keys and
  tempos that fit the deck you're on. With a deck loaded, every row shows its
  tempo change and Camelot move from that deck (+1, −1, rel, +2…), green when
  it's an easy mix. <kbd>/</kbd> opens the library on the crate and jumps to
  its search from anywhere. The list
  can also pop out into a mini window or go full screen; search, sort and
  filters carry over. Keyboard: <kbd>↑</kbd>/<kbd>↓</kbd> pick,
  <kbd>←</kbd>/<kbd>→</kbd> load to deck A or B, <kbd>Enter</kbd> loads to
  the idle deck, <kbd>+</kbd> queues for Auto-DJ; or drag a row onto a deck.
  Long crates stay smooth: only the rows on screen are drawn.
- **Playlists** (the Playlists tab): make, rename, reorder and delete
  playlists. Add a track with the playlist button on its crate row (press a
  playlist to add the track or take it out, or name a new one), or drag rows
  from the crate's mini window or full screen onto a playlist. In a playlist,
  drag rows or use ▴ ▾ (or <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>) to
  reorder, × or <kbd>Delete</kbd> to take one out, and load to a deck just as
  from the crate (A and B, <kbd>←</kbd>/<kbd>→</kbd>, <kbd>Enter</kbd>, or
  drag a row onto a deck).
- **History** (under the playlists): a track is logged once it has played on
  a deck for 60 seconds, counting only time it was actually playing, with the
  time it started and the deck. History is grouped into sessions: one starts
  when the page loads, and a new one after two hours with nothing playing.
  **Export tracklist** downloads a session as plain text (time into the set,
  artist and title), and you can clear a session or all of history. Tracks
  played this session get a tick, and a dimmed title, in the crate and in
  playlists.
- **Mashups**: every track in a linked folder is analysed in the background
  for tempo (with half and double time), key in Camelot, loudness (LUFS),
  energy (1–10) and beat grid. Sort and filter by any of them, pick a track
  and **Mix with…** lists what mashes with it (same key or a neighbour on the
  wheel, tempo within ±6% or half/double, similar energy), with the reason,
  and loads the pair onto decks A and B. FLAC is first-class, Vorbis tags
  and cover art included. The record of your library (`library/tracks.json`,
  never audio) can be kept in sync with a folder, and `npm run library --
  <folder>` builds the same record from the terminal. See
  [library/README.md](library/README.md).
- **Up next** (a rail beside the crate on a wide window, and a tab): for the
  track you're mixing out of, the tracks that would follow it best, each with
  its score, Camelot move, tempo change and energy step, and A and B buttons
  to load it (or drag it onto a deck). The tab adds the reasons in full. It reads the deck as it sounds now (tempo with the
  pitch fader, key with any key shift), weighs key, tempo (half and double
  time too) and energy, and lets you say where the energy should go: keep
  it level, build, or bring it down. Tracks you've played this session are
  skipped unless you say otherwise.
- **Sound match** (in Up next and Mashups, off until you switch it on): an
  open audio model, LAION's [CLAP](https://github.com/LAION-AI/CLAP), listens
  to your own files in the browser and keeps a short "sound print" of each
  (the opening, the middle and the ending), so suggestions also weigh how a
  track's opening sounds next to the current one's ending. The model is a
  one-time download of about 34 MB from Hugging Face. Your music never
  leaves the browser, and the prints stay in IndexedDB, not in the library
  file or the repo. Only files you added or linked are listened to: never
  SoundCloud (its API terms forbid feeding its audio to AI), Audius or the
  demos.
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

**Slicer**
- A separate studio for chopping samples, opened with **Slicer** in the top
  bar. Bring in tracks from the crate, audio files (FLAC, WAV, MP3 …), sounds
  from the sampler's library, or one part of a track (drums, bass, vocals or
  the rest, split by the stems model or read from saved pre-splits).
- A sample arrives **already chopped** on its hits (long tracks in bars), so
  the pads play at once. Re-chop live by **transients**, the **beat grid** or
  **equal** parts with one control, or by hand: click to add a slice point,
  drag to move it, or play the sample and hit **Cut** (`/`) on the beat.
- A **4×4 pad grid** in banks, played with `1234` / `QWER` / `ASDF` / `ZXCV`
  (the same shape as the grid). Arm **Rec** (`Shift+R`) and the pads you play
  land on the timeline, choked like a sampler. **Lay out all** puts every
  slice back in its original groove, ready to flip.
- Works on a phone: one area at a time (Chop or Arrange), pads in thumb
  reach, touch to pan, pinch to zoom, long-press a clip to edit it.
- Drag slices onto a **multi-lane timeline** with sample lanes and drum lanes
  (any sound from the library). Clips snap to the grid, follow the song's
  tempo, and can be trimmed, moved, split, duplicated, reversed, pitched and
  faded. Loop brace, metronome, swing on the drum lanes, mute and solo.
- **Export** the song or the loop as a 16-, 24- or 32-bit WAV, send it to the
  crate to mix on the decks, or put slices on sampler pads.
- Projects save in this browser as you go, with undo and redo. Audio files
  you open stay in the browser too.

**Controllers and keyboard**
- **MIDI learn** for every deck, mixer and sampler control: press Learn, move
  a knob or button. Jog wheels scratch while touched and nudge otherwise (in
  CDJ jog mode a touched jog nudges too);
  mapped buttons light up to match the rig.
- A full keyboard layout (below).

**Saves**
- The crate, its analysis and every cue point; settings; MIDI mappings;
  sampler pads; recordings; playlists and play history; and which tracks
  were on the decks — all kept in this browser (IndexedDB).
- **Backup** saves cues, tempo, keys, playlists, settings and MIDI mappings
  (not the audio) as one JSON file; **Import** restores it on another browser once the
  same files are added, matched by file name.
- **Import** also reads a **Rekordbox** collection export (`.xml`): tempo,
  first beat, key, memory cues, and hot cues and hot loops A–H with their
  colours.

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
| `R` `G` · `U` `Y` | Loop in (hold for 4 beats) / loop out; while looping, pick that edge |
| `Shift+D` · `Shift+J` | Reloop / exit |
| `←` `→` | Nudge the picked loop edge (`Shift`: 1 ms; `Esc` lets go) |
| `Z` `X` · `N` `M` | Beat jump back / forward |
| `1`–`4` · `7`–`0` | Hot cue pads 1–4 of the bank shown (`Shift` to clear) |
| `5` · `6` | Hot cue bank A–H / I–P |
| `F` · `H` · `B` | Beat FX on / off for deck A, deck B, the master |
| `C` · `,` | Censor (hold) |
| `V` · `.` | Slip on / off |
| `[` `]` | Crossfader left / right (`Shift`: all the way) |
| `\` | Crossfader to centre |

Knobs and sliders take the arrow keys when focused; double-click resets them.
Focus a platter and hold an arrow key to nudge.

In the slicer: `Space` plays and stops, `1234` / `QWER` / `ASDF` / `ZXCV` play
the pads, `/` cuts where the sample is sounding, `Shift+R` records the pads,
`?` lists every shortcut, `Enter` adds the selected slice to the end of its lane, `⌘/Ctrl+Z` undoes
(`Shift` to redo), `⌘/Ctrl+D` duplicates, `⌘/Ctrl+E` splits at the playhead,
`⌘/Ctrl+L` loops the selection, `⌘/Ctrl+U` quantizes, `Delete` removes clips
and `Esc` goes back to the decks.

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
npm run test:sync      # sync lock: tempo, phase through jumps, nudges, bars, the strip
npm run test:library      # tags, fingerprints, mashup scorer, folder scanner
npm run test:library-dsp  # tempo, loudness and energy on synthetic audio
npm run test:sound        # sound match: CLAP features against Python, scoring
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
  mixer.ts      channel strip: trim → isolator EQ → filter → FX slot → fader/cue/meter
  fx.ts         the beat FX unit and its insert slots
  beatfx.ts     the Beat FX section: channel, tempo and tap, quantize, X-pad, saves
  engine.ts     AudioContext, master bus and limiter, headphone routing, recorder
  session.ts    the rig: decks, mixer, crate, sampler, MIDI, Auto-DJ, saves
  analysis.ts   decoding, three-band waveform peaks, tempo, tags
  phrases.ts    phrase detection (intro, build, drop …) from peaks and grid
  countdown.ts  the beat countdown to the next cue or the loop's end
  key.ts        key detection and Camelot arithmetic
  sampler.ts    the 64 pads: playing, choke groups, kits, your own sounds
  beatboard.ts  the step sequencer and its lock to the decks' beat grid
  sounds/       the sound library: synth voices, kits, grooves, CC0 credits
  midi.ts       MIDI learn, mappings, LED feedback
  autodj.ts     queue and automatic transitions
  audius.ts     Audius search, trending and streaming
  stems/        stem separation: which tracks may be split, the worker, the HTDemucs loop,
                the spectrogram in and out (spectral.ts), auto-splitting (presplit.ts) and the
                saved-stems file (stemfile.ts, codec.ts, saved.ts)
  soundcloud.ts SoundCloud sign-in (PKCE), browsing, streaming, licence checks
  folder.ts     linked music folders (File System Access)
src/slicer/      the slicer: the project model (model.ts), slicing and WAV
                export (dsp.ts), the scheduler and offline render (player.ts),
                and the studio that ties them to the rig (studio.ts)
src/ui/slicer/  the slicer view: sources, slice editor, pads, timeline
src/library/    track analysis (tempo, key, loudness, energy), tags, fingerprints,
                the library record and folder sync, mashup and up-next scoring
  sound/        sound match: CLAP features (features.ts), windows and prints
                (embed.ts), the model worker and the background listener
scripts/library.mjs  the same analysis from the terminal, writing library/tracks.json
  backup.ts     JSON backup, Rekordbox XML import
  library.ts    everything kept in IndexedDB
  demo.ts       the two demo tracks, synthesised sample by sample
api/soundcloud.ts  Vercel Function: OAuth token exchange, API and media relay
src/ui/         React: turntables, waveforms, sync strip, mixer, panels
src/ui/beats/   pads, beat board and the Sounds browser
src/ui/crate/   the track list: page, mini window and full screen
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
- **The EQ is an isolator** (in ISO, the default): Linkwitz–Riley crossovers at 220 Hz and 2.6 kHz,
  so a band turned all the way down is gone. Waveforms split at the same
  frequencies, so killing the low is the blue you'd expect to lose.
- **Beat FX** read the deck's live tempo, so a 3/4-beat echo stays 3/4 of a
  beat when the pitch fader moves; send effects ring out when switched off.
  There's one unit, which sits in an insert slot on either channel (before
  the fader, so the cue hears it) or on the master bus. With quantize on,
  switching and beat changes are scheduled on the audio clock for the next
  beat of the deck's grid.
- **Positions on screen** come from the context's output timestamp, so what
  you see is what you hear, output latency included. Loops are placed at the
  beat you hear and fold the playhead in if it has already passed.
- **No audio until the first press.** The decks open armed (title, waveform,
  cue point); the audio is decoded or synthesised on the first play.

- **The slicer plays through the master bus**, so the meters, limiter and
  recorder hear it. Clips are scheduled a little ahead on the audio clock (a
  lookahead scheduler), and the WAV export runs the same scheduling through
  an `OfflineAudioContext`, so the file is what you heard. Slices are found
  by spectral flux with adaptive peak picking, each nudged back to the start
  of its attack.

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
[metronome](https://github.com/cwilso/metronome).
The library analysis is written for Platter from published methods: the
Fourier tempogram of Grosche and Müller, Krumhansl–Kessler key profiles,
ITU-R BS.1770-4 loudness and EBU Tech 3342 loudness range. The slicer's
waveform editor is drawn with [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js)
(BSD 3-Clause). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
