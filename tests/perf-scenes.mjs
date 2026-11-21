/** Page-side setups shared by tests/perf.mjs and tests/perf-trace.mjs. */

/** Adds four minutes of a kick-and-noise loop (44.1 kHz stereo WAV) to the
 *  crate, which starts background analysis. Runs in the page. */
export function addBenchTrack() {
  const sr = 44100;
  const n = sr * 240;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 4, true);
  const beat = Math.round((sr * 60) / 126);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    const k = i % beat;
    const kick = k < 4000 ? Math.sin((2 * Math.PI * 55 * k) / sr) * Math.exp(-k / 1500) : 0;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((seed / 0x7fffffff) * 2 - 1) * 0.08;
    const x = Math.max(-1, Math.min(1, kick * 0.8 + noise)) * 32767;
    v.setInt16(44 + i * 4, x, true);
    v.setInt16(46 + i * 4, x, true);
  }
  const file = new File([buf], 'perf-bench.wav', { type: 'audio/wav' });
  void window.platter.addFiles([file]);
}

/** Moves the crossfader and deck A's low EQ 60 times a second. Runs in the page. */
export function moveFaders() {
  const p = window.platter;
  let t = 0;
  window.__perfTimer = setInterval(() => {
    t += 1 / 60;
    p.setCrossfader(Math.sin(t * 2) * 0.9);
    p.setChannel(0, { low: 0.5 + 0.4 * Math.sin(t * 3) });
  }, 1000 / 60);
}
