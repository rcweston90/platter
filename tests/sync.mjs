/**
 * Sync lock, in Chromium with the demo tracks: the follower takes the
 * leader's tempo, its beat lands on the leader's and stays there through the
 * leader's cue jumps, either fader moves both, a nudge is kept as an offset,
 * bars line up on request, a double-time track locks at double time, and the
 * strip between the waveforms says all of that.
 *
 *   npm run dev
 *   npm run test:sync         # URL defaults to http://localhost:5173/
 *
 * PLATTER_SHOTS=dir saves screenshots of the waveform area along the way.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const URL_ = process.env.PLATTER_URL ?? 'http://localhost:5173/';
const SHOTS = process.env.PLATTER_SHOTS;
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.PLATTER_CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL_, { waitUntil: 'networkidle' });
const A = page.locator('section[aria-label="Deck A"]');
const B = page.locator('section[aria-label="Deck B"]');
await A.getByText('Night Bus').waitFor({ timeout: 15000 });
await B.getByText('Paper Lanterns').waitFor({ timeout: 15000 });

const waves = page.locator('[class*="_waves_"]').first();
const shot = async (name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await waves.screenshot({ path: `${SHOTS}/${name}.png` });
};
const bpm = (deck) => deck.locator('[class*="bpmValue"]').textContent();
const tempoText = () => page.locator('[data-side="tempo"]').textContent();
const phaseText = () => page.locator('[data-side="phase"] > span').first().textContent();
const tag = (L) => page.locator(`[class*="_waveTags_"][aria-label^="Deck ${L}: "]`).getAttribute('aria-label');

/** Follower's phase error against the leader, in heard ms, sampled over a
 *  while: worst and mean of the absolute error. */
const lockError = (ms = 1500) =>
  page.evaluate(
    (ms) =>
      new Promise((done) => {
        const [a, b] = window.platter.decks;
        const f = a.store.get().sync ? a : b;
        const errs = [];
        const t0 = performance.now();
        const step = () => {
          const e = f.phaseError();
          const st = f.store.get();
          if (e !== null) errs.push(Math.abs(((e * 60) / st.bpm / f.motor()) * 1000));
          if (performance.now() - t0 < ms) requestAnimationFrame(step);
          else done({ max: Math.max(...errs), mean: errs.reduce((x, y) => x + y, 0) / errs.length });
        };
        requestAnimationFrame(step);
      }),
    ms,
  );

/* ── Before sync: the strip compares, the tags say who's free ───────────── */

await A.getByRole('button', { name: 'Deck A play' }).click();
await page.waitForFunction(() => document.querySelector('[aria-label="Deck A pause"]'), null, { timeout: 15000 });
await B.getByRole('button', { name: 'Deck B play' }).click();
await page.waitForFunction(() => document.querySelector('[aria-label="Deck B pause"]'), null, { timeout: 15000 });
await page.waitForTimeout(1200);
check(/B 3\.2% faster/.test(await tempoText()), `unsynced, the strip compares tempos (“${await tempoText()}”)`);
check(/drifting/i.test(await phaseText()), `unsynced at different tempos, the beats drift (“${await phaseText()}”)`);
check((await tag('A')).includes('not synced'), 'deck A is tagged free');
await shot('1-free');

/* ── Sync: tempo, phase, roles ──────────────────────────────────────────── */

await B.getByRole('button', { name: 'Sync' }).click();
check((await bpm(B)) === '124.0', `Sync pulls deck B to deck A's 124.0 BPM (${await bpm(B)})`);
check((await tag('A')).includes('deck B follows it'), `deck A is tagged Leader (“${await tag('A')}”)`);
check((await tag('B')).includes('synced to deck A'), `deck B is tagged Sync ▸ A (“${await tag('B')}”)`);
await page.waitForTimeout(800);
let err = await lockError();
check(err.max < 8, `deck B's beat sits on deck A's (worst ${err.max.toFixed(1)} ms, mean ${err.mean.toFixed(1)} ms)`);
check(/^Tempo locked$/.test(await tempoText()), `the strip says the tempo is locked (“${await tempoText()}”)`);
check(/In phase/.test(await phaseText()), `the strip says in phase (“${await phaseText()}”)`);
await shot('2-locked');

/* ── The lock holds when the leader jumps ───────────────────────────────── */

for (const at of [37.3, 61.11, 82.77]) {
  await page.evaluate((t) => window.platter.decks[0].seek(t), at);
  await page.waitForTimeout(900);
  err = await lockError(1000);
  check(err.max < 8, `after deck A jumps to ${at}s, deck B is back on its beat (worst ${err.max.toFixed(1)} ms)`);
}

/* ── Either fader moves both ────────────────────────────────────────────── */

const faderB = B.getByRole('slider', { name: 'Deck B pitch' });
await faderB.fill('0.25'); // B's range is ±8: +2% of B's own tempo
await page.waitForTimeout(300);
const [ta, tb] = [await bpm(A), await bpm(B)];
check(ta === tb && ta !== '124.0', `moving synced deck B's fader takes deck A with it (${ta} / ${tb})`);
check(await B.getByRole('button', { name: 'Sync' }).getAttribute('aria-pressed') === 'true', 'and deck B stays synced');
await page.waitForTimeout(800);
err = await lockError(1000);
check(err.max < 8, `still in phase at the new tempo (worst ${err.max.toFixed(1)} ms)`);
await A.getByRole('slider', { name: 'Deck A pitch' }).dblclick();
await page.waitForTimeout(300);
check((await bpm(A)) === '124.0' && (await bpm(B)) === '124.0', `resetting the leader's fader brings both back (${await bpm(A)} / ${await bpm(B)})`);

/* ── A nudge is kept as an offset ───────────────────────────────────────── */

const nudge = B.getByRole('button', { name: 'Deck B: bend faster (hold)' });
await nudge.hover();
await page.mouse.down();
await page.waitForTimeout(250);
await page.mouse.up();
await page.waitForTimeout(1500);
const offset = await page.evaluate(() => window.platter.decks[1].store.get().syncOffset);
err = await lockError(1000);
check(Math.abs(offset) > 0.005 && err.max < 8, `nudging deck B keeps it ${(offset * 60000 / 124).toFixed(0)} ms off deck A, held by the lock (worst ${err.max.toFixed(1)} ms from that)`);
check(/nudged \+\d+ ms/.test(await phaseText()), `the strip shows the nudge (“${await phaseText()}”)`);
await shot('3-nudged');
await page.getByRole('button', { name: "Reset deck B's nudge" }).click();
await page.waitForTimeout(1200);
err = await lockError(1000);
check(err.max < 8 && (await page.evaluate(() => window.platter.decks[1].store.get().syncOffset)) === 0, `Reset puts the beats back together (worst ${err.max.toFixed(1)} ms)`);

/* ── Bars ───────────────────────────────────────────────────────────────── */

await page.evaluate(() => window.platter.decks[1].shift(window.platter.decks[1].beatLength() * 2));
await page.waitForTimeout(900);
const bars = await page.evaluate(() => window.platter.decks[1].barOffset());
check(bars !== 0 && bars !== null, `two beats out, the strip knows the bars are off (offset ${bars}; “${await phaseText()}”)`);
await shot('4-bars-off');
await page.getByRole('button', { name: 'Line up bars' }).click();
await page.waitForTimeout(900);
check((await page.evaluate(() => window.platter.decks[1].barOffset())) === 0, `Line up bars puts deck B's 1 on deck A's (“${await phaseText()}”)`);
check(/on the 1/.test(await phaseText()), 'and the strip says so');
await page.waitForTimeout(400);
await shot('5-bars-lined-up');

/* ── Swap roles; double time ────────────────────────────────────────────── */

await A.getByRole('button', { name: 'Sync' }).click();
check((await tag('B')).includes('deck A follows it') && (await tag('A')).includes('synced to deck B'), 'Sync on the leader swaps roles');
await page.waitForTimeout(800);
err = await lockError(1000);
check(err.max < 8, `deck A now holds deck B's beat (worst ${err.max.toFixed(1)} ms)`);

await A.getByRole('button', { name: 'Deck A: halve the detected tempo' }).click();
await page.waitForTimeout(1000);
// The record doesn't change speed: deck A now reads as 62 BPM and locks at half time.
check((await bpm(A)) === '62.0' && (await bpm(B)) === '124.0', `a half-tempo grid on deck A locks at half time without changing speed (${await bpm(A)} / ${await bpm(B)})`);
check(/Tempo locked · half time/.test(await tempoText()), `the strip says half time (“${await tempoText()}”)`);
err = await lockError(1000);
check(err.max < 8, `and in phase (worst ${err.max.toFixed(1)} ms)`);
await A.getByRole('button', { name: 'Deck A: double the detected tempo' }).click();

/* ── Waveforms are drawn in heard time ──────────────────────────────────── */

const widths = await page.evaluate(() => window.platter.decks.map((d) => (60 / d.store.get().bpm) / d.motor()));
check(Math.abs(widths[0] - widths[1]) < 1e-6, 'synced, a beat is the same width on both waveforms');

await A.getByRole('button', { name: 'Sync' }).click();
check((await tag('A')).includes('not synced') && (await tag('B')).includes('not synced'), 'Sync off: both decks are free');

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
