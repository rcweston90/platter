# Third-party notices

Platter bundles three MIT-licensed libraries, each loaded the first time it
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
