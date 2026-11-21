/**
 * Where the main thread's time goes while both demo decks play: a 5 s
 * DevTools trace, summed by event (Paint, Layout, FunctionCall, …).
 * Same setup as tests/perf.mjs. PERF_SCENE=faders moves the crossfader;
 * PERF_SCENE=analysis adds a track (background analysis). Also lists the
 * tasks over 50 ms and what ran inside them.
 */
import { chromium } from 'playwright';
import { addBenchTrack, moveFaders } from './perf-scenes.mjs';

const URL_ = process.env.PLATTER_URL ?? 'http://localhost:4173/';
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(process.env.PLATTER_CHROME ? { executablePath: process.env.PLATTER_CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(URL_);
await page.getByRole('button', { name: 'Deck A play' }).click();
await page.getByRole('button', { name: 'Deck B play' }).click();
await page.waitForFunction(() => window.platter?.decks.every((d) => d.store.get().playing && d.hasAudio), null, { timeout: 60_000 });
await page.waitForTimeout(1500);
if (process.env.PERF_SCENE === 'faders') await page.evaluate(moveFaders);
if (process.env.PERF_SCENE === 'analysis') await page.evaluate(addBenchTrack);

await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
await page.waitForTimeout(5000);
const buf = await browser.stopTracing();
await browser.close();

const { traceEvents } = JSON.parse(buf.toString());
const main = traceEvents.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
const totals = new Map();
for (const e of traceEvents) {
  if (e.ph !== 'X' || e.pid !== main.pid || e.tid !== main.tid || !e.dur) continue;
  totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / 1000);
}
const rows = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([name, ms]) => ({ name, msPerSec: +(ms / 5).toFixed(1) }));
console.table(rows);

// Long tasks: the top-level task and the biggest things inside it.
const evs = traceEvents.filter((e) => e.ph === 'X' && e.pid === main.pid && e.tid === main.tid && e.dur);
const longs = evs.filter((e) => e.name === 'RunTask' && e.dur > 50_000);
for (const t of longs) {
  const inner = evs
    .filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur && e.name !== 'RunTask')
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 4)
    .map((e) => `${e.name}${e.args?.data?.functionName ? ` ${e.args.data.functionName}` : e.args?.data?.url ? ` ${String(e.args.data.url).split('/').pop()}` : ''} ${(e.dur / 1000).toFixed(0)}ms`);
  console.log(`long task ${(t.dur / 1000).toFixed(0)} ms: ${inner.join(', ')}`);
}
