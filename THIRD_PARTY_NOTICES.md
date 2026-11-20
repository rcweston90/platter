# Third-party notices

Platter bundles these MIT-licensed libraries, each loaded the first time it
is needed:

- [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch)
  (`signalsmith-stretch`) — key lock (pitch-shifting against the tempo fader).
  Its AudioWorklet module is written to `public/worklets/stretch.js` at build
  time by `scripts/extract-stretch-worklet.mjs`, unchanged.
  Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.
- [web-audio-beat-detector](https://github.com/chrisguttandin/web-audio-beat-detector)
  — tempo and first-beat detection for the beat grid.
  Copyright (c) 2026 Christoph Guttandin
- [music-metadata](https://github.com/Borewit/music-metadata) — title, artist
  and cover art from audio files. Copyright © 2026 Borewit
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)
  (`onnxruntime-web`) — runs the stem separation model, on WebGPU or WebAssembly.
  Copyright (c) Microsoft Corporation
- [demucs-web](https://github.com/timcsy/demucs-web) — the STFT and model
  input/output handling around HTDemucs. Copyright (c) 2024 timcsy

The stem separation model itself is [HTDemucs](https://github.com/facebookresearch/demucs)
(Hybrid Transformer Demucs, MIT, Copyright (c) Meta Platforms, Inc. and
affiliates), exported to ONNX by demucs-web. It is not bundled: the browser
downloads it from Hugging Face the first time you split a track.

Each is distributed under the MIT License:

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The deck and mixer workflow (CDJ-style cue, quantised hot cues and loops,
isolator EQ, crossfader curves, split cue) follows conventions documented by
[Mixxx](https://mixxx.org), the open-source DJ application. No Mixxx code is
included.

## Sampler sounds

Most of the sampler's library is synthesised in the browser by Platter's own
code (`src/engine/sounds/`), so it carries Platter's MIT licence.

The 189 recordings in `public/sounds/cc0/` come from the sample set that ships
with [Sonic Pi](https://github.com/sonic-pi-net/sonic-pi) (`etc/samples`),
whose README states that every sample is released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain).
Most were originally shared on [Freesound](https://freesound.org); the
arovane_ sounds were donated by Uwe Zahn (Arovane). CC0 asks for no credit, but
each sound's maker is credited in the Sounds browser and in
`src/engine/sounds/cc0.ts`. They were converted to 112 kbps MP3 and renamed;
nothing else was changed. Three of Sonic Pi's loops (the Amen and other break
loops cut from commercial records) and the samples its README doesn't list
were left out.

## Beat board

The beat board's scheduler uses the lookahead technique from Chris Wilson's
[metronome](https://github.com/cwilso/metronome) and his article "A Tale of
Two Clocks" (MIT License, Copyright (c) 2014 Chris Wilson). The swing setting
uses MPC-style percentages, as in [Tone.js](https://github.com/Tonejs/Tone.js)
(MIT). Both were references for technique; no code is copied. The step grid
and the pads-beside-sequence layout follow the open-source drum machines
[Hydrogen](http://hydrogen-music.org) and [LMMS](https://lmms.io) for
workflow only; both are GPL, and no code from either is included.

