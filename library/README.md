# Your library record

`library/tracks.json` is Platter's record of your music: one entry per track
with its tags and what the analyser heard — tempo, key, loudness, energy,
beat grid. **It never holds audio.** The schema is
[`track.schema.json`](./track.schema.json) (JSON Schema 2020-12); the same
types are in [`src/library/types.ts`](../src/library/types.ts).

This repo is public, so `tracks.json` is in `.gitignore`: your track list stays
on your machine unless you choose otherwise (see [Keeping it in
git](#keeping-it-in-git)). Audio files are ignored everywhere in the repo too.

## Where to keep your music

Keep every track Platter should know about in one folder on your Mac:

```
~/Music/Platter/
  House/
  Techno/
  Disco/
  Hip-Hop/
  …one folder per crate, named however you like
```

- **One level of crates** is enough. Subfolders deeper down are read too
  (up to eight levels), and the crate folder is kept in each record's `path`.
- **Keep the store's file names** (`Artist - Album - 03 Title.flac` from
  Bandcamp is fine). Title, artist, genre and key come from the tags inside
  the file; the name is only a fallback.
- **FLAC or WAV** for lossless. Chrome can't decode AIFF or ALAC, so convert
  those to FLAC first (`ffmpeg -i in.aiff out.flac` keeps the tags).
- **Not in iCloud Drive.** Desktop and Documents may be synced, and "Optimise
  Mac Storage" can leave a file on the server and only a placeholder on disk,
  which the browser can't read. `~/Music` isn't synced by iCloud Drive.
- **Add files any time**, then press **Rescan folder** (or rerun the scanner).
  Moving a file between crates keeps its analysis.

Link that folder once, and point the scanner at the same folder, so their
paths match.

## Two ways to build it

**In the browser** (Chrome, Edge, Arc, Brave): in the library area open
**Mashups → Link folder** and pick your music folder. Every track is analysed
in the background as it's added, off the main thread so the decks keep
playing. **Rescan folder** picks up files you've added since. To keep the
record in this folder, click **Keep in sync with a folder…** and choose this
`library/` folder in your clone: Platter rewrites `tracks.json` a few seconds
after anything changes. **Save library file** downloads it instead.

**From the terminal**, on the folder itself (fast for a big first pass):

```sh
npm run library -- ~/Music/Platter
```

It uses ffmpeg if you have it (`brew install ffmpeg`), otherwise macOS's
built-in `afconvert`. Unchanged files are skipped on the next run, and a file
you move or rename keeps its record (it's matched by fingerprint). Options:
`--force` re-analyses everything, `--out <file>` writes somewhere else,
`--keep-missing` keeps records of files that have gone. In the browser,
**Import library file** (or choosing this folder to sync with) reads what the
scanner wrote, so linked files that match skip analysis.

Paths in the record are relative to the folder you scanned or linked, so the
browser and the scanner agree when you point both at the same folder.

## What's in a record

```jsonc
{
  "id": "9f2c…",                     // fingerprint: SHA-256 of size + first/last 256 KB
  "path": "House/Ada - Each and Every One.flac",
  "fileName": "Ada - Each and Every One.flac",
  "format": "flac",
  "fileSize": 41234567,
  "modified": 1763600000000,
  "fingerprint": "9f2c…",
  "addedAt": "2026-11-20T22:40:00.000Z",
  "tags": {                          // ID3, FLAC/Vorbis comments, MP4 atoms
    "title": "Each and Every One", "artist": "Ada", "album": "Blondie",
    "albumArtist": null, "genre": "House", "year": 2004, "label": "Areal",
    "bpm": null,                     // tempo written in the tags, if any
    "key": null,                     // key written in the tags (INITIALKEY/TKEY), as Camelot
    "hasArt": true
  },
  "analysis": {
    "analyzer": "platter-analyzer-1",
    "analyzedAt": "2026-11-20T22:40:03.000Z",
    "duration": 402.6,
    "bpm": 122,                      // what the decks use
    "bpmConfidence": 0.81,           // 0–1
    "bpmSource": "analysis",         // or "tag" when the store's tag set the octave
    "bpmCandidates": [{ "bpm": 122, "salience": 1 }, { "bpm": 61, "salience": 0.42 }, { "bpm": 244, "salience": 0.2 }],
    "tempoStability": 0.97,
    "firstBeat": 0.112,              // seconds; grid = firstBeat + n × 60 / bpm
    "firstDownbeat": 0.112,          // the bar's "one" (4/4 assumed)
    "key": "8A", "keyName": "Am", "keyConfidence": 0.6, "keySource": "analysis",
    "lufs": -9.4, "peakDb": -0.3, "lra": 5.1,
    "energy": 6,                     // 1–10, for comparing tracks
    "onsetRate": 4.2, "brightness": 2310, "lowEnd": 0.38
  }
}
```

## How accurate it is

Measured on 27 real tracks (dance, hip-hop, pop, jazz, classical, loops)
against Essentia's reference algorithms, plus 5 with published tempos, using
`npm run eval:accuracy -- manifest.json` (bring your own audio; none ships
with Platter). The synthetic checks in `npm run test:library-dsp` and
`npm run test:library` run on every change.

- **Tempo**: an onset envelope and tempogram, with a separate kick/bass band
  so offbeat hi-hats don't pull it to two thirds of the real tempo. Agrees
  with Essentia on 74% of tracks, 85% counting half or double time; steady
  electronic tracks land within a tenth of a BPM with the beat grid within a
  couple of milliseconds. The usual miss is the octave (87 vs 174), which is
  why half and double time are kept as candidates and the decks have ×2 / ÷2.
  Solo piano, classical and some loops read with low confidence (shown as
  "?"), and then the decks use their own detector. For reference, Rekordbox
  and Traktor score about 75–77% (89% with octaves) on the GiantSteps
  benchmark. A tempo in the tags sets the octave when it agrees with the audio.
- **Key**: chroma against Krumhansl–Kessler profiles. Same key as Essentia's
  EDM profile on 74% of tracks, and a mixable neighbour (relative or a fifth)
  on 78%. Commercial tools (Mixed In Key, Rekordbox) score around 67–72% on
  GiantSteps. A key already in your tags (from Rekordbox, Mixed In Key or the
  store) always wins.
- **Loudness**: ITU-R BS.1770-4 integrated LUFS, a standard measurement.
- **Energy**: a heuristic (loudness, onset density, brightness, low end). Use
  it to compare your own tracks, not as a measurement.
- **Speed**: about 170× real time in Node, so a 6-minute track takes about two
  seconds, including decoding.

## Keeping it in git

Because this repo is public, committing `tracks.json` publishes your track
list. If you want it versioned:

- make the repo private, then remove the `/library/tracks.json` line from
  `.gitignore`; or
- keep the record in a separate private repo and point the scanner there:
  `npm run library -- ~/Music/Platter --out ~/code/my-library/tracks.json`; or
- leave it as is: it lives in this folder on your Mac and nowhere else.
