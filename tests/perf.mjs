/**
 * Frame-rate bench for the rig: both demo decks playing, then three scenes.
 *
 *   1. mix      — both decks playing, hands off
 *   2. faders   — the crossfader and an EQ knob moving 60 times a second
 *   3. analysis — a 4-minute file added to the crate while both decks play
 *                 (background analysis: decode, peaks, tempo, key)
 *
 * Each scene reports frame intervals (p50/p95/max, frames over 25 ms and
 * 50 ms), long tasks, and Chrome's own counters for style, layout and script
 * time. Run against a built preview:
 *
 *   npm run build && npx vite preview --port 4173 &
 *   PLATTER_URL=http://localhost:4173/ PLATTER_CHROME=/path/to/chrome node tests/perf.mjs
 *
 * PERF_CPU=4 slows the CPU 4× (a busier or older machine); PERF_SECONDS sets
 * the length of each scene (default 8). Prints JSON with PERF_JSON=1.
 */
import { chromium } from 'playwright';
import { addBenchTrack, moveFaders } from './perf-scenes.mjs';

const URL_ = process.env.PLATTER_URL ?? 'http://localhost:4173/';
const SECONDS = Number(process.env.PERF_SECONDS ?? 8);
const CPU = Number(process.env.PERF_CPU ?? 1);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(process.env.PLATTER_CHROME ? { executablePath: process.env.PLATTER_CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

await page.goto(URL_);
await page.waitForFunction(() => document.querySelector('[data-dj-root]'));
await page.getByRole('button', { name: 'Deck A play' }).click();
await page.getByRole('button', { name: 'Deck B play' }).click();
await page.waitForFunction(
  () => {
    const p = window.platter;
    return p?.decks.every((d) => d.store.get().playing && d.hasAudio);
  },
  null,
  { timeout: 60_000 },
);
await page.waitForTimeout(1500);

const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

async function scene(name, setup) {
  await page.evaluate(setup ?? (() => {}));
  const before = await metrics();
  const frames = await page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const dts = [];
        const longs = [];
        const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push(e.duration)));
        try {
          po.observe({ type: 'longtask', buffered: false });
        } catch {}
        let last = performance.now();
        const end = last + ms;
        const tick = (t) => {
          dts.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else {
            po.disconnect();
            resolve({ dts, longs });
          }
        };
        requestAnimationFrame(tick);
      }),
    SECONDS * 1000,
  );
  const after = await metrics();
  await page.evaluate(() => {
    clearInterval(window.__perfTimer);
    window.__perfTimer = 0;
  });
  const d = (k) => after[k] - before[k];
  const s = [...frames.dts].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const secs = SECONDS;
  const playing = await page.evaluate(() => window.platter.decks.map((x) => x.store.get().playing));
  return {
    scene: name,
    fps: +(frames.dts.length / secs).toFixed(1),
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    over25: frames.dts.filter((x) => x > 25).length,
    over50: frames.dts.filter((x) => x > 50).length,
    longTasks: frames.longs.length,
    longestTask: +(Math.max(0, ...frames.longs)).toFixed(0),
    layoutsPerSec: +(d('LayoutCount') / secs).toFixed(0),
    styleRecalcsPerSec: +(d('RecalcStyleCount') / secs).toFixed(0),
    layoutMsPerSec: +((d('LayoutDuration') * 1000) / secs).toFixed(1),
    styleMsPerSec: +((d('RecalcStyleDuration') * 1000) / secs).toFixed(1),
    scriptMsPerSec: +((d('ScriptDuration') * 1000) / secs).toFixed(1),
    mainThreadBusyPct: +((d('TaskDuration') / secs) * 100).toFixed(0),
    stillPlaying: playing.every(Boolean),
  };
}

const results = [];
results.push(await scene('mix'));
results.push(await scene('faders', moveFaders));
results.push(await scene('analysis', addBenchTrack));

await browser.close();

if (process.env.PERF_JSON) console.log(JSON.stringify({ cpu: CPU, seconds: SECONDS, results }, null, 2));
else {
  console.log(`CPU ×${CPU}, ${SECONDS} s per scene`);
  console.table(results);
}
