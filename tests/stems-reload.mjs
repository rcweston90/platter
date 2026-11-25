/**
 * Stems survive a reload: a deck's split is kept (demos too), and after a
 * reload the decks' tracks get their stems back with nothing pressed, saved
 * ones loaded and others split straight away once the model is in the browser.
 *
 *   npm run dev & npm run test:stems-reload   # URL defaults to http://localhost:5173/
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const URL_ = process.env.PLATTER_URL ?? 'http://localhost:5173/';
const SHOTS = process.env.SHOTS;
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.PLATTER_CHROME || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// The 170 MB model, swapped for a stand-in with the same shapes.
const modelGets = [];
await page.route('https://huggingface.co/timcsy/**', (route) => {
  modelGets.push(route.request().url());
  route.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(new URL('./fixtures/fake-demucs.onnx', import.meta.url)) });
});
const shot = async (name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const g = page.getByRole('group', { name: 'Deck A stems' });
  if (await g.count()) await g.screenshot({ path: `${SHOTS}/${name}.png` });
};
const status = (i) => page.evaluate((i) => window.platter.stems[i].store.get().status, i);

await page.goto(URL_, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.platter?.decks[0].store.get().track && window.platter.decks[1].store.get().track, null, { timeout: 20000 });
const titles = await page.evaluate(() => window.platter.decks.map((d) => d.store.get().track.title));
check((await status(0)) === 'none' && modelGets.length === 0, `a first visit downloads nothing for stems before anything is played (${titles.join(', ')})`);

// Play deck A once: its stems arrive by themselves and are kept.
await page.getByRole('button', { name: 'Deck A play' }).click();
await page.getByRole('group', { name: 'Deck A stems' }).getByRole('button', { name: 'Vocals' }).waitFor({ timeout: 90000 });
await page.getByRole('button', { name: 'Deck A pause' }).click();
const kept = await page.evaluate(async () => {
  const id = window.platter.decks[0].store.get().track.id;
  for (let i = 0; i < 60; i++) {
    if (await window.platter.presplit.has(id)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
});
check(kept, `deck A's stems (${titles[0]}) are kept in the browser`);

// Hard reload: nothing pressed afterwards.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.platter?.decks[0].store.get().track, null, { timeout: 20000 });
const t0 = Date.now();
await page.getByRole('group', { name: 'Deck A stems' }).getByRole('button', { name: 'Vocals' }).waitFor({ timeout: 30000 });
check(true, `after a reload, deck A shows its stems again with nothing pressed (${Date.now() - t0} ms)`);
await shot('after-reload');
check((await page.evaluate(() => window.platter.decks[0].hasAudio)) === false, 'deck A still has no audio loaded (only the picture), so nothing played by itself');

// Deck B was never split; the model is in the browser now, so it splits right away.
await page.getByRole('group', { name: 'Deck B stems' }).getByRole('button', { name: 'Vocals' }).waitFor({ timeout: 90000 });
check(true, `deck B (${titles[1]}) is split after the reload without being played`);

// Play: the held stems go onto the deck and are heard.
await page.getByRole('group', { name: 'Deck A stems' }).getByRole('button', { name: 'Vocals' }).click();
await page.getByRole('button', { name: 'Deck A play' }).click();
await page.waitForFunction(() => window.platter.decks[0].store.get().playing, null, { timeout: 15000 });
// Muting eases over a few milliseconds as play starts: read after that.
await page.waitForTimeout(300);
await page.evaluate(() => window.platter.stems[0].levels());
// The stems row's meters take the same peaks every frame: sample often for a
// few seconds (the demo has quiet stretches), keep the loudest.
const lv = await page.evaluate(async () => {
  const top = { vocals: 0, drums: 0, bass: 0, other: 0 };
  for (let i = 0; i < 300; i++) {
    const l = window.platter.stems[0].levels();
    for (const k of Object.keys(top)) top[k] = Math.max(top[k], l[k]);
    await new Promise((r) => setTimeout(r, 10));
  }
  return top;
});
check((await status(0)) === 'ready' && lv.drums + lv.bass + lv.other > 0 && lv.vocals === 0, `on play deck A sounds through its stems, vocals muted as set before play (${JSON.stringify(Object.fromEntries(Object.entries(lv).map(([k, v]) => [k, +v.toFixed(2)])))})`);
check(modelGets.length <= 2, `the model was fetched once per page load at most (${modelGets.length})`);
check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);

await browser.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
