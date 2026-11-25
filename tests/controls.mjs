/**
 * Every deck and mixer control, clicked in Chromium, with its effect checked:
 * what the screen says (pressed state, BPM, pitch readout) and, for anything
 * that moves the record, the speed it actually turns at, read from the
 * platter's rotation (the platter is drawn from the playhead, so its spin is
 * the speed you hear).
 *
 *   npm run dev
 *   npm run test:controls     # URL defaults to http://localhost:5173/
 *
 * Needs a Chromium for Playwright (`npx playwright install chromium`), or set
 * PLATTER_CHROMIUM to a Chrome binary.
 */
import { chromium } from 'playwright';

const URL_ = process.env.PLATTER_URL ?? 'http://localhost:5173/';
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await chromium.launch({
  executablePath: process.env.PLATTER_CHROMIUM || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// A stand-in Screen Wake Lock that counts what the app asks of it (headless
// Chrome's own may refuse), and lets the test drop it as a hidden tab would.
await page.addInitScript(() => {
  const w = { requests: 0, releases: 0, active: null };
  window.__wake = w;
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      async request() {
        w.requests++;
        const fns = [];
        const s = {
          released: false,
          type: 'screen',
          addEventListener: (_t, fn) => fns.push(fn),
          async release() {
            if (s.released) return;
            s.released = true;
            w.releases++;
            if (w.active === s) w.active = null;
            fns.forEach((fn) => fn());
          },
          drop() {
            s.released = true;
            if (w.active === s) w.active = null;
            fns.forEach((fn) => fn());
          },
        };
        w.active = s;
        return s;
      },
    },
  });
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL_, { waitUntil: 'networkidle' });
const A = page.locator('section[aria-label="Deck A"]');
const B = page.locator('section[aria-label="Deck B"]');
await A.getByText('Night Bus').waitFor({ timeout: 15000 });
await B.getByText('Paper Lanterns').waitFor({ timeout: 15000 });

const bpm = (deck) => deck.locator('[class*="bpmValue"]').textContent();
const pitch = (deck) => deck.locator('[class*="pitchReadout"]').textContent();
const pressed = async (loc) => (await loc.getAttribute('aria-pressed')) === 'true';
const fader = A.getByRole('slider', { name: 'Deck A pitch' });

/** Playback rate, from how fast deck's record turns: one revolution is
 *  1.8 s of track, so degrees per second × 1.8 / 360 = rate. */
const rate = (label, ms = 1000) =>
  page.evaluate(
    ({ label, ms }) =>
      new Promise((done) => {
        const el = document.querySelector(`section[aria-label="Deck ${label}"] [class*="_spin_"]`);
        const angle = () => {
          const m = /rotate\(([-\d.e]+)deg\)/.exec(el.style.transform);
          return m ? Number(m[1]) : 0;
        };
        let last = angle();
        let total = 0;
        const t0 = performance.now();
        const step = () => {
          const a = angle();
          let d = a - last;
          if (d > 180) d -= 360;
          if (d < -180) d += 360;
          total += d;
          last = a;
          const t = performance.now() - t0;
          if (t >= ms) done((total / (t / 1000)) * (1.8 / 360));
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { label, ms },
  );

/* ── Transport ──────────────────────────────────────────────────────────── */

// The fader set before the first play (before the audio engine exists) still counts.
await fader.fill('1');
await A.getByRole('button', { name: 'Deck A play' }).click();
await page.waitForFunction(() => document.querySelector('[aria-label="Deck A pause"]'), null, { timeout: 15000 });
await page.waitForTimeout(800);
const r0 = await rate('A');
check(near(r0, 1.08, 0.03) && (await pitch(A)) === '+8.00%', `Pitch set before the first play is heard (rate ${r0.toFixed(3)}, ${await pitch(A)})`);
await fader.dblclick();
await page.waitForTimeout(400);
const r1 = await rate('A');
check(near(r1, 1, 0.04), `Play: deck A turns at normal speed (rate ${r1.toFixed(3)})`);
check(await pressed(A.getByRole('button', { name: 'Deck A pause' })), 'Play: the button shows pause while playing');

/* ── Pitch range ────────────────────────────────────────────────────────── */

const range = (r) => A.getByRole('group', { name: 'Deck A pitch range' }).getByRole('button', { name: r === 'WIDE' ? 'WIDE' : `±${r}`, exact: true });
check(await pressed(range(8)), 'Pitch range: ±8 is selected at start');
const offered = await A.getByRole('group', { name: 'Deck A pitch range' }).getByRole('button').allTextContents();
check(offered.join(' ') === '±6 ±8 ±10 ±16 WIDE', `Pitch range: ±6, ±8, ±10, ±16 and WIDE are offered (${offered.join(' ')})`);
await fader.fill('1');
check((await pitch(A)) === '+8.00%' && (await bpm(A)) === '133.9', `Pitch fader at the end of ±8 gives +8% (${await pitch(A)}, ${await bpm(A)} BPM)`);
await page.waitForTimeout(400);
const r8 = await rate('A');
check(near(r8, 1.08, 0.05), `…and the record turns 8% fast (rate ${r8.toFixed(3)})`);

await range(16).click();
check(await pressed(range(16)) && !(await pressed(range(8))), 'Pitch range: ±16 selects, ±8 lets go');
check((await pitch(A)) === '+8.00%' && (await bpm(A)) === '133.9', `Pitch range: switching to ±16 keeps the tempo (${await pitch(A)})`);
check(Number(await fader.inputValue()) === 0.5, `Pitch range: the fader moves to half travel to show +8 of ±16 (${await fader.inputValue()})`);
check((await A.getByText('+16', { exact: true }).count()) === 1, 'Pitch range: the fader’s end reads +16');
await fader.fill('1');
check((await pitch(A)) === '+16.00%', `Pitch range: full travel at ±16 is +16% (${await pitch(A)})`);

await range(6).click();
check((await pitch(A)) === '+6.00%', `Pitch range: ±6 clamps +16% to +6% (${await pitch(A)})`);
await range(10).click();
await fader.fill('1');
check((await pitch(A)) === '+10.00%' && (await A.getByText('+10', { exact: true }).count()) === 1, `Pitch range: full travel at ±10 is +10% (${await pitch(A)})`);

await range('WIDE').click();
check((await A.getByText('+100', { exact: true }).count()) === 1, 'Pitch range: WIDE’s fader end reads +100');
await fader.fill('0.5');
check((await pitch(A)) === '+50.00%' && (await bpm(A)) === '186.0', `Pitch range: half travel at WIDE is +50% (${await bpm(A)} BPM)`);
await page.waitForTimeout(400);
const r50 = await rate('A');
check(near(r50, 1.5, 0.07), `…and the record turns 50% fast (rate ${r50.toFixed(3)})`);
await fader.fill('-1');
check((await pitch(A)) === '−100.00%', `Pitch range: WIDE reaches −100%, a crawl (${await pitch(A)})`);
await page.waitForTimeout(500);
const rStill = await rate('A', 500);
check(Math.abs(rStill) < 0.05 && errors.length === 0, `…the record all but stops, with no errors (rate ${rStill.toFixed(3)})`);
await fader.fill('0.5');

await range(8).click();
check((await pitch(A)) === '+8.00%', `Pitch range: back to ±8 clamps +50% to +8% (${await pitch(A)})`);
await fader.dblclick();
check((await pitch(A)) === '±0.00%' && (await bpm(A)) === '124.0', `Pitch fader: double-click resets to 0 (${await pitch(A)})`);

/* ── 33 / 45 ────────────────────────────────────────────────────────────── */

const rpm33 = A.getByRole('button', { name: '33⅓ rpm' });
const rpm45 = A.getByRole('button', { name: '45 rpm' });
check(await pressed(rpm33), '33/45: 33 is selected at start');
await rpm45.click();
check(await pressed(rpm45) && !(await pressed(rpm33)), '33/45: 45 selects, 33 lets go');
check((await bpm(A)) === '167.4', `33/45: 45 shows 124 × 1.35 = 167.4 BPM (${await bpm(A)})`);
await page.waitForTimeout(400);
const r45 = await rate('A');
check(near(r45, 1.35, 0.06), `33/45: at 45 the record turns 1.35× (rate ${r45.toFixed(3)})`);
await range(16).click();
await fader.fill('0.5');
check((await bpm(A)) === '180.8', `33/45: 45 stacks on the pitch fader, +8% → ${await bpm(A)} BPM`);
await fader.dblclick();
await range(8).click();

/* ── Sync follows the other deck, 45 included ───────────────────────────── */

const syncB = B.getByRole('button', { name: 'Sync' });
await syncB.click();
check(await pressed(syncB), 'Sync: deck B latches');
check((await bpm(B)) === '167.4', `Sync: deck B follows deck A at 45 (${await bpm(B)} BPM)`);
await rpm33.click();
check((await bpm(A)) === '124.0' && (await bpm(B)) === '124.0', `33/45: back to 33, and synced deck B follows (${await bpm(A)} / ${await bpm(B)})`);
await syncB.click();
check(!(await pressed(syncB)), 'Sync: deck B lets go');

/* ── Nudge (hold) ───────────────────────────────────────────────────────── */

for (const [dir, name] of [
  [1, 'Deck A: bend faster (hold)'],
  [-1, 'Deck A: bend slower (hold)'],
]) {
  const btn = A.getByRole('button', { name });
  await page.waitForTimeout(500);
  const base = await rate('A', 600);
  await btn.hover();
  await page.mouse.down();
  await page.waitForTimeout(300);
  const held = await rate('A', 600);
  const showsHeld = (await btn.getAttribute('data-held')) === 'true';
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await rate('A', 600);
  // The bend is ±4%; the record eases into it, so allow for the ramp.
  check(dir * (held - base) > 0.015 && showsHeld, `Nudge ${dir > 0 ? '▸' : '◂'}: holding bends from rate ${base.toFixed(3)} to ${held.toFixed(3)}, lit while held`);
  check(near(after, base, 0.025) && (await btn.getAttribute('data-held')) === 'false', `Nudge ${dir > 0 ? '▸' : '◂'}: letting go returns to rate ${after.toFixed(3)}`);
}
check((await bpm(A)) === '124.0', 'Nudge: the tempo setting is untouched afterwards');

/* ── Deck switches: tempo reset, key shift, jog mode, instant doubles ───── */

const reset = A.getByRole('button', { name: 'Deck A tempo reset' });
check(await reset.isDisabled(), 'Tempo reset: dimmed while the pitch is at 0');
await fader.fill('1');
check(!(await reset.isDisabled()), 'Tempo reset: lit once the fader moves');
await reset.click();
check((await pitch(A)) === '±0.00%' && (await bpm(A)) === '124.0' && Number(await fader.inputValue()) === 0, `Tempo reset: back to 0 (${await pitch(A)}, ${await bpm(A)} BPM)`);
check(await reset.isDisabled(), 'Tempo reset: dimmed again at 0');

const keyUp = A.getByRole('button', { name: 'Key up a semitone' });
const keyDown = A.getByRole('button', { name: 'Key down a semitone' });
for (let k = 0; k < 13; k++) if (!(await keyUp.isDisabled())) await keyUp.click();
check((await A.locator('[class*="keyShift"]').textContent()) === '+12' && (await keyUp.isDisabled()), `Key shift: ♯ goes up to +12 and stops (${await A.locator('[class*="keyShift"]').textContent()})`);
await A.getByRole('button', { name: 'Reset key shift' }).click();
for (let k = 0; k < 13; k++) if (!(await keyDown.isDisabled())) await keyDown.click();
check((await A.locator('[class*="keyShift"]').textContent()) === '-12' && (await keyDown.isDisabled()), `Key shift: ♭ goes down to −12 and stops (${await A.locator('[class*="keyShift"]').textContent()})`);
await A.getByRole('button', { name: 'Reset key shift' }).click();

const platterA = A.getByRole('slider', { name: /Deck A platter/ });
const jog = (deck, mode) => deck.getByRole('group', { name: /jog mode/ }).getByRole('button', { name: mode, exact: true });
check((await pressed(jog(A, 'Vinyl'))) && !(await pressed(jog(A, 'CDJ'))), 'Jog mode: Vinyl is selected at start');
await platterA.scrollIntoViewIfNeeded();
const pbox = await platterA.boundingBox();
const pcx = pbox.x + pbox.width / 2;
const pcy = pbox.y + pbox.height / 2;
/** The worklet's own playback rate, sampled every 20 ms for `ms`: its mean
 *  and its fastest. Unlike the platter's drawn spin, this doesn't depend on
 *  the page keeping up. */
const sampleRate = (ms) =>
  page.evaluate(
    (ms) =>
      new Promise((done) => {
        const d = window.platter.decks[0];
        const xs = [];
        const id = setInterval(() => xs.push(d.rate()), 20);
        setTimeout(() => {
          clearInterval(id);
          done({ mean: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs) });
        }, ms);
      }),
    ms,
  );
/** Rate while a hand rests on the platter `at` (a fraction of its radius) without turning. */
const restRate = async (at) => {
  await page.mouse.move(pcx + (pbox.width / 2) * at, pcy);
  await page.mouse.down();
  await page.waitForTimeout(400);
  const r = await sampleRate(400);
  await page.mouse.up();
  await page.waitForTimeout(300);
  return r.mean;
};
/** Fastest rate while a hand turns the platter forward at `at`, and whether
 *  the platter says it's nudging faster meanwhile. */
const turnRate = async (at) => {
  const rad = (pbox.width / 2) * at;
  await page.mouse.move(pcx + rad, pcy);
  await page.mouse.down();
  const measured = sampleRate(600);
  let said = false;
  for (let i = 1; i <= 40; i++) {
    const a = (i / 20) * 2 * Math.PI;
    await page.mouse.move(pcx + rad * Math.cos(a), pcy + rad * Math.sin(a), { steps: 2 });
    if (i === 20) said = (await platterA.getAttribute('aria-valuetext')) === 'nudging faster';
  }
  const r = await measured;
  await page.mouse.up();
  await page.waitForTimeout(300);
  return { max: r.max, said };
};
const vinylTop = await restRate(0.6);
check(vinylTop < 0.1, `Jog mode: in Vinyl a hand on top holds the record (rate ${vinylTop.toFixed(3)})`);
const vinylRim = await restRate(0.95);
check(near(vinylRim, 1, 0.03), `Jog mode: a hand resting on the rim doesn't stop it (rate ${vinylRim.toFixed(3)})`);
const rimTurn = await turnRate(0.95);
check(rimTurn.max > 1.01 && rimTurn.said, `Jog mode: turning the rim forward bends faster (up to rate ${rimTurn.max.toFixed(3)}, ${rimTurn.said ? 'shown' : 'not shown'})`);
await jog(A, 'CDJ').click();
check((await pressed(jog(A, 'CDJ'))) && !(await pressed(jog(A, 'Vinyl'))), 'Jog mode: CDJ selects, Vinyl lets go');
const cdjTop = await restRate(0.6);
check(near(cdjTop, 1, 0.03), `Jog mode: in CDJ a hand on top doesn't hold the record (rate ${cdjTop.toFixed(3)})`);
const cdjTurn = await turnRate(0.6);
check(cdjTurn.max > 1.01 && cdjTurn.said, `Jog mode: in CDJ turning the top bends faster, like the rim (up to rate ${cdjTurn.max.toFixed(3)})`);
const cdjAfter = await sampleRate(300);
check(near(cdjAfter.mean, 1, 0.01) && (await bpm(A)) === '124.0', `Jog mode: letting go returns to the fader's tempo (rate ${cdjAfter.mean.toFixed(3)})`);
await jog(A, 'Vinyl').click();
// Deck B's switch is its own: CDJ on B leaves A on Vinyl (and B's is checked after a reload).
await jog(B, 'CDJ').click();
check((await pressed(jog(A, 'Vinyl'))) && (await pressed(jog(B, 'CDJ'))), 'Jog mode: each deck has its own switch');

// Instant doubles: deck A plays Night Bus in a loop at +6%; load it on deck B.
const doublesB = B.getByRole('button', { name: 'Deck B instant doubles' });
check(await pressed(doublesB), 'Instant doubles: on at start');
await range(16).click();
await fader.fill('0.375');
await A.getByRole('button', { name: /(Start|Exit) .*-beat loop/ }).click();
await page.waitForTimeout(300);
await page.evaluate(() => {
  const p = window.platter;
  const id = p.decks[0].store.get().track.id;
  return p.loadToDeck(id, 1);
});
await page.waitForFunction(() => window.platter.decks[1].store.get().playing, null, { timeout: 15000 }).catch(() => undefined);
await page.waitForTimeout(300);
const dbl = await page.evaluate(() => {
  const [a, b] = window.platter.decks;
  const sa = a.store.get();
  const sb = b.store.get();
  return {
    title: sb.track?.title,
    playing: sb.playing,
    gap: Math.abs(a.position() - b.position()),
    pitch: [sa.pitch, sb.pitch],
    range: [sa.range, sb.range],
    loop: [sa.loop.active, sb.loop.active, Math.abs(sa.loop.start - sb.loop.start)],
  };
});
check(dbl.title === 'Night Bus' && dbl.playing, `Instant doubles: deck B loads Night Bus and plays with A (${dbl.title}, playing ${dbl.playing})`);
check(dbl.gap < 0.02, `Instant doubles: deck B starts where A is (${(dbl.gap * 1000).toFixed(1)} ms apart)`);
check(dbl.pitch[0] === dbl.pitch[1] && dbl.range[0] === dbl.range[1] && (await bpm(B)) === (await bpm(A)), `Instant doubles: same tempo (${await bpm(A)} / ${await bpm(B)} BPM)`);
check(dbl.loop[0] && dbl.loop[1] && dbl.loop[2] < 1e-6, 'Instant doubles: deck B loops the same loop');
await page.waitForTimeout(1500);
const drift = await page.evaluate(() => Math.abs(window.platter.decks[0].position() - window.platter.decks[1].position()));
check(drift < 0.02, `Instant doubles: still together 1.5 s later (${(drift * 1000).toFixed(1)} ms apart)`);
await A.getByRole('button', { name: /Exit .*-beat loop/ }).click();
await B.getByRole('button', { name: 'Deck B pause' }).click();
await B.getByRole('button', { name: /Exit .*-beat loop/ }).click().catch(() => undefined);
await fader.dblclick();
await range(8).click();
// Off: the same load starts at the cue point, stopped.
await doublesB.click();
check(!(await pressed(doublesB)), 'Instant doubles: switches off');
await page.evaluate(() => window.platter.loadToDeck(window.platter.decks[0].store.get().track.id, 1));
await page.waitForFunction(() => window.platter.decks[1].hasAudio && !window.platter.decks[1].store.get().loading, null, { timeout: 15000 });
await page.waitForTimeout(300);
const plain = await page.evaluate(() => ({ playing: window.platter.decks[1].store.get().playing, pos: window.platter.decks[1].position(), cue: window.platter.decks[1].store.get().cue }));
check(!plain.playing && Math.abs(plain.pos - plain.cue) < 0.05, `Instant doubles off: deck B waits at its cue point (${plain.pos.toFixed(2)} s, stopped)`);

/* ── Scroll to nudge ────────────────────────────────────────────────────── */

/** Puts the pointer on deck A's record, clear of the pinned waveforms. */
const overPlatter = async () => {
  await platterA.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
  const box = await platterA.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.7;
  const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[aria-label*="platter"]'), [x, y]);
  if (!hit) throw new Error('deck A’s record is covered');
  await page.mouse.move(x, y);
};
{
  await overPlatter();
  await page.waitForTimeout(400);
  const base = await rate('A', 600);
  const scrollY0 = await page.evaluate(() => window.scrollY);
  let wheeling = true;
  const spin = (async () => {
    while (wheeling) {
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(50);
    }
  })();
  await page.waitForTimeout(300);
  const held = await rate('A', 600);
  const showsHeld = await platterA.getAttribute('aria-valuenow');
  wheeling = false;
  await spin;
  const scrolled = (await page.evaluate(() => window.scrollY)) !== scrollY0;
  await page.waitForTimeout(400);
  const after = await rate('A', 600);
  check(held - base > 0.015 && showsHeld === '1', `Scroll nudge: scrolling down over the record bends it faster (rate ${base.toFixed(3)} → ${held.toFixed(3)}, nudge ${showsHeld})`);
  check(near(after, base, 0.04) && (await platterA.getAttribute('aria-valuenow')) === '0', `Scroll nudge: it lets go when the scrolling stops (rate ${after.toFixed(3)})`);
  check(!scrolled, 'Scroll nudge: the page doesn’t scroll under it');
  check((await bpm(A)) === '124.0', 'Scroll nudge: the tempo setting is untouched afterwards');
}

/* ── Toggles ────────────────────────────────────────────────────────────── */

for (const name of ['Deck A key lock', 'Quant', 'Slip']) {
  const t = A.getByRole('button', { name, exact: true });
  const was = await pressed(t);
  await t.click();
  const now = await pressed(t);
  await t.click();
  check(now !== was && (await pressed(t)) === was, `${name}: toggles on and off`);
}

/* ── Hot cues ───────────────────────────────────────────────────────────── */

await A.getByRole('button', { name: 'Set hot cue A' }).click();
const hot = A.getByRole('button', { name: /^Hot cue A at / });
check((await hot.count()) === 1, `Hot cue: pressing an empty pad sets it (${await hot.getAttribute('aria-label')})`);
await page.waitForTimeout(1500);
const before = await page.evaluate(() => document.querySelector('section[aria-label="Deck A"] [class*="_spin_"]').style.transform);
await hot.click();
await page.waitForTimeout(100);
const set = /at (\d+):(\d+)/.exec(await hot.getAttribute('aria-label'));
const at = Number(set[1]) * 60 + Number(set[2]);
const timeNow = await A.locator('[class*="time"] span').first().textContent();
const [m, sec] = timeNow.split(':').map(Number);
check(Math.abs(m * 60 + sec - at) <= 1, `Hot cue: pressing a set pad jumps back to it (${timeNow}, cue at ${at}s; was ${before})`);
await hot.click({ modifiers: ['Shift'] });
check((await A.getByRole('button', { name: 'Set hot cue A' }).count()) === 1, 'Hot cue: Shift-click clears it');

/* ── Loops and beat jump ────────────────────────────────────────────────── */

const loopBtn = A.getByRole('button', { name: /(Start|Exit) .*-beat loop/ });
await loopBtn.click();
check(await pressed(loopBtn), `Loop: starts (${await loopBtn.textContent()})`);
await A.getByRole('button', { name: 'Halve loop length' }).click();
check((await loopBtn.textContent()) === 'Loop 2', `Loop: ½ halves it (${await loopBtn.textContent()})`);
await A.getByRole('button', { name: 'Double loop length' }).click();
check((await loopBtn.textContent()) === 'Loop 4', `Loop: 2× doubles it (${await loopBtn.textContent()})`);
await loopBtn.click();
check(!(await pressed(loopBtn)), 'Loop: exits');
const secs = async () => {
  const [mm, ss] = (await A.locator('[class*="time"] span').first().textContent()).split(':').map(Number);
  return mm * 60 + ss;
};
// Manual loop: In, then Out a moment later, starts looping; Exit leaves it;
// Reloop brings it back.
const loopIn = A.getByRole('button', { name: /Deck A loop in/ });
await loopIn.click();
await page.waitForTimeout(700);
await A.getByRole('button', { name: /Deck A loop out/ }).click();
check(await pressed(loopBtn), `Loop: In then Out starts a loop (${await loopBtn.textContent()})`);
const exitBtn = A.getByRole('button', { name: /Deck A: exit the loop/ });
await exitBtn.click();
check(!(await pressed(loopBtn)), 'Loop: Exit leaves the manual loop');
await A.getByRole('button', { name: /Deck A reloop/ }).click();
check(await pressed(loopBtn), 'Loop: Reloop brings it back');
await A.getByRole('button', { name: /Deck A: exit the loop/ }).click();
// Beat jump has its own size (16 by default): bring it down to 4.
await A.getByRole('button', { name: 'Smaller beat jump' }).click();
await A.getByRole('button', { name: 'Smaller beat jump' }).click();
const j0 = await secs();
await A.getByRole('button', { name: /Jump forward 4 beats/ }).click();
await page.waitForTimeout(100);
const j1 = await secs();
check(j1 - j0 >= 1 && j1 - j0 <= 3, `Beat jump: ▸▸ jumps 4 beats ahead (${j0}s → ${j1}s)`);

/* ── Cue (CDJ style) ────────────────────────────────────────────────────── */

const cue = A.getByRole('button', { name: /Deck A cue/ });
await cue.click();
await page.waitForTimeout(200);
check(await A.getByRole('button', { name: 'Deck A play' }).isVisible(), 'Cue: pressed while playing, it goes back to the cue point and stops');
const c0 = await secs();
await cue.hover();
await page.mouse.down();
await page.waitForTimeout(1300);
const previewing = await rate('A', 300);
await page.mouse.up();
await page.waitForTimeout(200);
check(previewing > 0.9 && (await secs()) === c0, `Cue: held while stopped it previews (rate ${previewing.toFixed(2)}) and returns on release`);

/* ── Round transport buttons ────────────────────────────────────────────── */

for (const [label, name] of [
  ['Cue', /Deck A cue/],
  ['Play', /Deck A (play|pause)/],
]) {
  const box = await A.getByRole('button', { name }).boundingBox();
  check(box.width === box.height, `${label}: a true circle (${box.width} × ${box.height})`);
}

/* ── Shift-scroll to scrub (paused) ─────────────────────────────────────── */

{
  await overPlatter();
  const s0 = await secs();
  await page.keyboard.down('Shift');
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 100);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  const s1 = await secs();
  check(s1 - s0 >= 3 && s1 - s0 <= 5, `Shift-scroll: paused, it scrubs the record ahead (${s0}s → ${s1}s, 20 notches ≈ 4 s)`);
  check(await A.getByRole('button', { name: 'Deck A play' }).isVisible(), 'Shift-scroll: the deck stays paused');
}

/* ── Mixer ──────────────────────────────────────────────────────────────── */

await A.getByRole('button', { name: 'Deck A play' }).click();
const mixer = page.getByRole('region', { name: 'Mixer' });
const pfl = mixer.getByRole('button', { name: 'Channel A headphone cue' });
await pfl.click();
check(await pressed(pfl), 'Mixer: channel A headphone cue latches');
await pfl.click();
const vol = mixer.getByRole('slider', { name: 'Channel A volume' });
await vol.fill('0');
check((await vol.getAttribute('aria-valuetext')) === 'off', 'Mixer: channel A volume goes to off');
await vol.fill('1');
const xf = mixer.getByRole('slider', { name: 'Crossfader' });
await xf.fill('1');
check(/100% to deck B/.test(await xf.getAttribute('aria-valuetext')), 'Mixer: crossfader moves to B');
await xf.dblclick();
check((await xf.getAttribute('aria-valuetext')) === 'centre', 'Mixer: double-click centres the crossfader');
for (const knob of ['Channel A high EQ', 'Channel A filter', 'Master level']) {
  const k = mixer.getByRole('slider', { name: knob });
  const v0 = Number(await k.getAttribute('aria-valuenow'));
  await k.focus();
  await page.keyboard.press('ArrowUp');
  const v1 = Number(await k.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowDown');
  check(v1 > v0, `Mixer: ${knob} turns (${v0} → ${v1})`);
}
const curves = mixer.getByRole('group', { name: 'Crossfader curve' }).getByRole('button');
const n = await curves.count();
for (let i = 0; i < n; i++) {
  await curves.nth(i).click();
  check(await pressed(curves.nth(i)), `Mixer: crossfader curve “${await curves.nth(i).textContent()}” selects`);
}

/* ── Booth guide (the offline demo model) ───────────────────────────────── */

const guideBtn = page.getByRole('button', { name: 'Booth guide: ask how to do things' });
await guideBtn.click();
const guide = page.getByRole('region', { name: 'Booth guide' });
await guide.waitFor({ timeout: 5000 });
check(await guide.getByText('Not connected to an AI model yet.').isVisible(), 'Guide: opens from the top bar and says it isn’t connected to an AI model');
const askGuide = async (q) => {
  await guide.locator('#booth-guide-input').fill(q);
  await guide.getByRole('button', { name: 'Ask', exact: true }).click();
};
const xfAt = async () => Number(await xf.inputValue());
const runStatus = guide.getByRole('status', { name: 'Guide moves' });
const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

// The transition: deck A plays, the crossfader starts hard on A, and the
// guide brings B in on the bar and fades across.
await xf.fill('-1');
await askGuide('Play a quick transition between the demo tracks');
check(await waitFor(async () => (await guide.getByRole('button', { name: 'Stop', exact: true }).count()) > 0, 5000), 'Guide: the transition starts a run with a Stop button');
check(await waitFor(async () => (await xfAt()) > -0.85, 12000), `Guide: the transition moves the crossfader (now ${await xfAt()})`);
check(/Bar \d|Waiting/.test(await runStatus.textContent()), `Guide: the status line counts bars (“${await runStatus.textContent()}”)`);
await guide.getByRole('button', { name: 'Stop', exact: true }).click();
const held = await xfAt();
await page.waitForTimeout(1500);
check((await xfAt()) === held, `Guide: Stop halts the crossfader where it was (${held})`);
check(/^Stopped/.test(await runStatus.textContent()), `Guide: the status says it stopped (“${await runStatus.textContent()}”)`);
check((await guide.getByRole('button', { name: 'Stop', exact: true }).count()) === 0, 'Guide: the Stop button goes once stopped');

// A hand on the controls stops a run too.
await xf.fill('-1');
await askGuide('Bring the crossfader to centre over 8 bars');
await waitFor(async () => (await xfAt()) > -0.95, 8000);
await xf.focus();
await page.keyboard.press('ArrowRight');
check(await waitFor(async () => /you took over|by hand/.test(await runStatus.textContent()), 2000), `Guide: touching a control stops the run (“${await runStatus.textContent()}”)`);

// Chips in an answer ring their control.
await askGuide('what does the filter on deck b do');
const chip = guide.locator('button[class*="chip"]', { hasText: 'Channel B filter' }).last();
await chip.waitFor({ timeout: 5000 });
const ring = page.locator('[data-ring="B.filter"]');
await waitFor(async () => (await ring.count()) === 0, 6000); // the answer's own ring fades first
await chip.click();
const ringed = await waitFor(async () => (await ring.count()) === 1 && (await ring.isVisible()), 4000);
check(ringed, `Guide: a chip rings its control on screen${ringed ? '' : ` (rings: ${await page.evaluate(() => [...document.querySelectorAll('[data-ring]')].map((r) => `${r.dataset.ring} ${r.style.visibility}`).join(', ') || 'none')})`}`);
await guide.getByRole('button', { name: 'Close the booth guide' }).click();
check((await guide.count()) === 0, 'Guide: the close button closes the panel');

/* ── Mixer switches ─────────────────────────────────────────────────────── */

const group = (name) => mixer.getByRole('group', { name });
const seg = (name, button) => group(name).getByRole('button', { name: button, exact: true });

// EQ type: Iso's full-left is a kill, EQ's is −26 dB.
const low = mixer.getByRole('slider', { name: 'Channel A low EQ' });
await low.focus();
await page.keyboard.press('Home');
check((await low.getAttribute('aria-valuetext')) === 'kill', 'Mixer: in Iso, low EQ full left is a kill');
await seg('EQ type', 'EQ').click();
check(await pressed(seg('EQ type', 'EQ')), 'Mixer: EQ type switches to EQ');
check((await low.getAttribute('aria-valuetext')) === '−26.0 dB' || (await low.getAttribute('aria-valuetext')) === '-26.0 dB', `Mixer: in EQ, low EQ full left is −26 dB (${await low.getAttribute('aria-valuetext')})`);
await low.dblclick();

// Channel-fader curve: half travel reads −12 dB linear, −18 dB slow, full level fast.
await vol.fill('0.5');
const faderAt = async (curve) => {
  await seg('Channel fader curve', curve).click();
  return vol.getAttribute('aria-valuetext');
};
const lin = await faderAt('Lin');
const slow = await faderAt('Slow');
const fast = await faderAt('Fast');
check(lin === '−12.0 dB' && slow === '−18.1 dB' && fast === '+0.0 dB', `Mixer: channel-fader curves at half travel (lin ${lin}, slow ${slow}, fast ${fast})`);
const engineGain = (i) => page.evaluate((i) => new Promise((r) => setTimeout(() => r(window.platter.engine.channels[i].xfade.gain.value), 150)), i);
await seg('Channel fader curve', 'Lin').click();
await vol.fill('1');

// Crossfader assign: THRU ignores the crossfader; A follows its A side.
const assignA = group('Channel A crossfader assign');
check(await pressed(assignA.getByRole('button', { name: 'A', exact: true })), 'Mixer: channel A starts assigned to A');
check(await pressed(group('Channel B crossfader assign').getByRole('button', { name: 'B', exact: true })), 'Mixer: channel B starts assigned to B');
await xf.fill('1');
const cutA = await engineGain(0);
await assignA.getByRole('button', { name: 'Thru' }).click();
const thruA = await engineGain(0);
check(cutA < 0.01 && thruA > 0.99, `Mixer: with the crossfader at B, channel A is out on A (${cutA.toFixed(3)}) and full on THRU (${thruA.toFixed(3)})`);
await assignA.getByRole('button', { name: 'B', exact: true }).click();
check((await engineGain(0)) > 0.99, 'Mixer: channel A assigned to B follows the B side');
await assignA.getByRole('button', { name: 'A', exact: true }).click();
await xf.dblclick();

// Centre-lock filter: a small drag off centre stays off; a bigger one sweeps.
const filt = mixer.getByRole('slider', { name: 'Channel A filter' });
const dragFilter = async (dy) => {
  // Mid-screen, clear of the pinned waveforms above and the library bar below.
  await filt.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const fb = await filt.boundingBox();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2 - dy, { steps: 4 });
  await page.mouse.up();
  return [Number(await filt.getAttribute('aria-valuenow')), await filt.getAttribute('aria-valuetext')];
};
const [small, smallText] = await dragFilter(6);
check(small === 0 && smallText === 'off', `Mixer: filter locks off near centre (${small}, ${smallText})`);
await filt.dblclick();
const [big, bigText] = await dragFilter(40);
check(big > 0.3 && /high-pass/.test(bigText), `Mixer: filter sweeps past the lock (${big}, ${bigText})`);
await filt.dblclick();

// The switches are kept: set some, reload, and they're back.
await seg('Channel fader curve', 'Slow').click();
await group('Channel B crossfader assign').getByRole('button', { name: 'Thru' }).click();
await page.waitForTimeout(800);
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('region', { name: 'Mixer' }).waitFor();
await page.waitForFunction(() => window.platter?.mixer.get().faderCurve === 'slow', null, { timeout: 10000 }).catch(() => undefined);
check(
  (await pressed(seg('EQ type', 'EQ'))) &&
    (await pressed(seg('Channel fader curve', 'Slow'))) &&
    (await pressed(group('Channel B crossfader assign').getByRole('button', { name: 'Thru' }))) &&
    (await pressed(seg('Crossfader curve', 'Cut'))),
  'Mixer: EQ type, fader curve, crossfader curve and assign survive a reload',
);
await seg('EQ type', 'Iso').click();
await seg('Channel fader curve', 'Lin').click();
await group('Channel B crossfader assign').getByRole('button', { name: 'B', exact: true }).click();
await seg('Crossfader curve', 'Smooth').click();

/* ── Mixer DSP: the EQ, rendered offline ────────────────────────────────── */

// An impulse through the isolator alone and through a channel's EQ in each
// mode, in an OfflineAudioContext; each spectrum read by a plain DFT.
const dsp = await page.evaluate(async () => {
  const { ChannelEq, Isolator } = await import('/src/engine/mixer.ts');
  const sr = 48000;
  const N = 16384;
  const render = async (build) => {
    const ctx = new OfflineAudioContext(1, N, sr);
    const buf = ctx.createBuffer(1, N, sr);
    buf.getChannelData(0)[0] = 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const node = build(ctx);
    src.connect(node.input);
    node.output.connect(ctx.destination);
    src.start();
    const out = (await ctx.startRendering()).getChannelData(0);
    return (f) => {
      const w = (2 * Math.PI * f) / sr;
      let re = 0;
      let im = 0;
      for (let n = 0; n < N; n++) {
        re += out[n] * Math.cos(w * n);
        im -= out[n] * Math.sin(w * n);
      }
      return 10 * Math.log10(re * re + im * im + 1e-30);
    };
  };
  const spread = (db) => {
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < 120; k++) {
      const v = db(20 * 1000 ** (k / 119));
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return { min, max };
  };
  const eq = (mode, low, mid, high) => (ctx) => {
    const e = new ChannelEq(ctx);
    e.set(mode, low, mid, high, 0);
    return e;
  };
  const iso = spread(await render((ctx) => new Isolator(ctx)));
  const isoFlat = spread(await render(eq('iso', 0.5, 0.5, 0.5)));
  const eqFlat = spread(await render(eq('eq', 0.5, 0.5, 0.5)));
  const isoKill = await render(eq('iso', 0, 0.5, 0.5));
  const eqCut = await render(eq('eq', 0, 0.5, 0.5));
  return { iso, isoFlat, eqFlat, isoKill40: isoKill(40), eqCut30: eqCut(30), eqCut2k: eqCut(2000) };
});
const dbRange = ({ min, max }) => `${min.toFixed(2)} … ${max >= 0 ? '+' : ''}${max.toFixed(2)} dB`;
const flat = ({ min, max }) => max < 0.5 && min > -0.5;
check(flat(dsp.iso), `Mixer: isolator bands at centre sum flat (${dbRange(dsp.iso)})`);
check(flat(dsp.isoFlat) && flat(dsp.eqFlat), `Mixer: channel EQ flat at centre in Iso (${dbRange(dsp.isoFlat)}) and EQ (${dbRange(dsp.eqFlat)})`);
check(dsp.isoKill40 < -50, `Mixer: Iso low fully down kills the lows (${dsp.isoKill40.toFixed(1)} dB at 40 Hz)`);
check(
  dsp.eqCut30 < -22 && dsp.eqCut30 > -28 && Math.abs(dsp.eqCut2k) < 1,
  `Mixer: EQ low fully down is a shelf, not a kill (${dsp.eqCut30.toFixed(1)} dB at 30 Hz, ${dsp.eqCut2k.toFixed(1)} dB at 2 kHz)`,
);

/* ── Deck switches come back after a reload ─────────────────────────────── */

await page.waitForTimeout(800); // settings save a moment after a change
await page.reload({ waitUntil: 'networkidle' });
await B.getByRole('group', { name: /jog mode/ }).waitFor({ timeout: 15000 });
await page.waitForFunction(() => window.platter.decks[1].store.get().jogMode === 'cdj', null, { timeout: 5000 }).catch(() => undefined);
check((await pressed(jog(B, 'CDJ'))) && (await pressed(jog(A, 'Vinyl'))), 'Jog mode: each deck’s mode is kept after a reload');
check(!(await pressed(B.getByRole('button', { name: 'Deck B instant doubles' }))) && (await pressed(A.getByRole('button', { name: 'Deck A instant doubles' }))), 'Instant doubles: each deck’s setting is kept after a reload');

/* ── Waveform smarts: phrases, phase meter, beat countdown, grid edit ───── */

// Phrases: Night Bus is built intro 8, build 8, drop 16, break 8, drop 16, outro 8.
await page.waitForFunction(() => window.platter.decks[0].store.get().phrases?.length > 0, null, { timeout: 5000 });
const phraseList = await page.evaluate(() => window.platter.decks[0].store.get().phrases.map((p) => `${p.kind}${p.bars}`).join(' '));
check(phraseList === 'intro8 build8 drop16 break8 drop16 outro8', `Phrases: Night Bus reads as its arrangement (${phraseList})`);

// Phase meter: shown while both decks play, gone when one stops.
const phaseMeter = page.locator('[aria-label^="Phase"][role="img"]');
if (!(await A.getByRole('button', { name: 'Deck A pause' }).count())) await A.getByRole('button', { name: 'Deck A play' }).click();
await B.getByRole('button', { name: 'Deck B play' }).click();
await page.waitForFunction(() => document.querySelector('[aria-label="Deck B pause"]'), null, { timeout: 15000 });
await page.waitForTimeout(400);
const phaseText = await phaseMeter.textContent();
check((await phaseMeter.isVisible()) && /^[+−]0\.\d\d$/.test(phaseText), `Phase meter: shows B's offset in beats while both play (${phaseText})`);
await B.getByRole('button', { name: 'Deck B pause' }).click();
await A.getByRole('button', { name: 'Deck A pause' }).click();
await page.waitForTimeout(200);
check(!(await phaseMeter.isVisible()), 'Phase meter: hidden once a deck stops');

// Beat countdown: the arithmetic, then on the deck.
const cdUnit = await page.evaluate(async () => {
  const { countdownBeats, countdownTarget } = await import('/src/engine/countdown.ts');
  const b = 0.5;
  const hot = [null, { t: 10, color: 0 }, { t: 4, color: 1 }];
  const loop = { active: false, start: 0, end: 0 };
  return {
    texts: [34, 32, 31.5, 4.1, 0.5, 0].map((n) => countdownBeats(n * b, b).text).join(' '),
    nextHot: countdownTarget({ hotCues: hot, memoryCues: [6], loop }, 3, b),
    nextMem: countdownTarget({ hotCues: hot, memoryCues: [6], loop }, 4, b),
    passed: countdownTarget({ hotCues: hot, memoryCues: [6], loop }, 10, b),
    loop: countdownTarget({ hotCues: hot, memoryCues: [], loop: { active: true, start: 1, end: 3 } }, 2, b),
  };
});
check(cdUnit.texts === '8.2 8.0 8.0 1.1 0.1 0.0', `Countdown: beats to bars.beats, counted up (${cdUnit.texts})`);
check(cdUnit.nextHot?.kind === 'hot' && cdUnit.nextHot.slot === 2 && cdUnit.nextMem?.kind === 'memory' && cdUnit.nextMem.t === 6, 'Countdown: aims at the nearest hot or memory cue ahead');
check(cdUnit.passed === null && cdUnit.loop?.kind === 'loop' && cdUnit.loop.t === 3, 'Countdown: nothing once every cue is behind; a running loop counts to its end');

const beatA = await page.evaluate(() => 60 / window.platter.decks[0].store.get().bpm);
const countdownA = A.locator('[aria-label^="Deck A countdown"]');
await page.evaluate((b) => window.platter.decks[0].seek(34 * b), beatA);
await page.waitForTimeout(300);
await A.getByRole('button', { name: 'Set hot cue C' }).click();
await page.evaluate(() => window.platter.decks[0].seek(0));
await page.waitForTimeout(300);
check((await countdownA.textContent()) === 'C8.2', `Countdown: 34 beats before hot cue C reads C 8.2 (${await countdownA.textContent()})`);
await page.evaluate(() => window.platter.decks[0].setLoopBeats(4));
await A.getByRole('button', { name: /^Start 4-beat loop/ }).click();
await page.waitForTimeout(300);
check((await countdownA.textContent()) === 'LOOP1.0', `Countdown: in a 4-beat loop it counts to the loop's end (${await countdownA.textContent()})`);
await A.getByRole('button', { name: /Deck A: exit the loop/ }).click();
await A.getByRole('button', { name: /^Hot cue C at / }).click({ modifiers: ['Shift'] });

// Grid edit: nudges, the downbeat, ÷2 ×2 — and all of it saved with the track.
await A.getByRole('button', { name: 'Deck A grid edit' }).click();
const gridRow = A.getByRole('group', { name: 'Deck A grid edit' });
check(await gridRow.isVisible(), 'Grid: the Grid button opens the edit row');
const g0 = await page.evaluate(() => window.platter.decks[0].store.get().gridOffset);
await gridRow.getByRole('button', { name: 'Deck A: move the beat grid 10 ms later' }).click();
await gridRow.getByRole('button', { name: 'Deck A: move the beat grid 1 ms earlier' }).click();
const g1 = await page.evaluate(() => window.platter.decks[0].store.get().gridOffset);
check(near(g1 - g0, 0.009, 1e-6), `Grid: +10 ms then −1 ms moves the grid 9 ms (${((g1 - g0) * 1000).toFixed(2)} ms)`);
await page.evaluate(() => window.platter.decks[0].seek(3.5));
await page.waitForTimeout(300);
await gridRow.getByRole('button', { name: 'Deck A: make the playhead the downbeat' }).click();
const g2 = await page.evaluate(() => window.platter.decks[0].store.get().gridOffset);
check(near(g2, 3.5, 0.005), `Grid: 1 here puts a downbeat at the playhead (${g2.toFixed(4)} s)`);
await gridRow.getByRole('button', { name: 'Deck A: halve the detected tempo' }).click();
check((await bpm(A)) === '62.0', `Grid: ÷2 halves the tempo (${await bpm(A)})`);
await gridRow.getByRole('button', { name: 'Deck A: double the detected tempo' }).click();
check((await bpm(A)) === '124.0', `Grid: ×2 doubles it back (${await bpm(A)})`);
// Phrases are read again on the new grid, and saved with it.
await page.waitForFunction((g) => window.platter.crate.get().tracks.find((t) => t.id === 'demo-night-bus')?.phrases?.gridOffset === g, g2, { timeout: 3000 }).catch(() => {});
const savedGrid = await page.evaluate(() => {
  const t = window.platter.crate.get().tracks.find((t) => t.id === 'demo-night-bus');
  return { gridOffset: t.gridOffset, bpm: t.bpm, edited: t.gridEdited, phrasesAt: t.phrases?.gridOffset };
});
check(savedGrid.gridOffset === g2 && savedGrid.bpm === 124 && savedGrid.edited === true && savedGrid.phrasesAt === g2, `Grid: the edit is saved with the track, phrases too (${JSON.stringify(savedGrid)})`);
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'networkidle' });
await A.getByText('Night Bus').waitFor({ timeout: 15000 });
await page.waitForFunction(() => window.platter.decks[0].store.get().track?.id === 'demo-night-bus', null, { timeout: 15000 });
const reloaded = await page.evaluate(() => {
  const st = window.platter.decks[0].store.get();
  return { gridOffset: st.gridOffset, bpm: st.bpm, phrases: st.phrases?.length ?? 0 };
});
check(reloaded.gridOffset === g2 && reloaded.bpm === 124 && reloaded.phrases > 0, `Grid: after a reload deck A keeps the edited grid, with its phrases (${JSON.stringify(reloaded)})`);

{
  // The wake-lock checks need deck A playing.
  const pause = A.getByRole('button', { name: 'Deck A pause' });
  if (!(await pause.isVisible())) {
    await A.getByRole('button', { name: 'Deck A play' }).click();
    await pause.waitFor({ timeout: 15000 });
  }
}

/* ── Screen wake lock ───────────────────────────────────────────────────── */

{
  const wake = () => page.evaluate(() => ({ requests: window.__wake.requests, releases: window.__wake.releases, held: !!window.__wake.active, state: document.documentElement.dataset.screenAwake }));
  // Deck A is playing (from the mixer checks).
  await page.waitForTimeout(200);
  let w = await wake();
  check(w.held && w.state === 'held', `Wake lock: held while deck A plays (${JSON.stringify(w)})`);
  await A.getByRole('button', { name: 'Deck A pause' }).click();
  await page.waitForTimeout(200);
  w = await wake();
  check(!w.held && w.state === 'off', `Wake lock: let go when nothing plays (${JSON.stringify(w)})`);
  await A.getByRole('button', { name: 'Deck A play' }).click();
  await page.waitForTimeout(200);
  const r0 = (await wake()).requests;
  // The tab hides: the browser drops the lock, then comes back.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.__wake.active?.drop();
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(100);
  w = await wake();
  check(!w.held && w.requests === r0, `Wake lock: gone while the tab is hidden, not asked for again (${JSON.stringify(w)})`);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  w = await wake();
  check(w.held && w.requests === r0 + 1 && w.state === 'held', `Wake lock: taken again when the tab is back (${JSON.stringify(w)})`);
}

/* ── Listen to ──────────────────────────────────────────────────────────── */

{
  // What the main output carries, read from the engine's output node: deck A
  // plays with its channel fader down, so the master is silent but deck A's
  // cue is not.
  const outLevel = () =>
    page.evaluate(
      () =>
        new Promise((done) => {
          const e = window.platter.engine;
          const an = e.ctx.createAnalyser();
          an.fftSize = 2048;
          e.out.connect(an);
          setTimeout(() => {
            const buf = new Float32Array(an.fftSize);
            an.getFloatTimeDomainData(buf);
            e.out.disconnect(an);
            done(Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length));
          }, 300);
        }),
    );
  const masterLevel = () =>
    page.evaluate(() => {
      const an = window.platter.engine.masterMeters[0];
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      return Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length);
    });
  await mixer.getByRole('slider', { name: 'Channel A volume' }).fill('0');
  await page.getByText('Outputs', { exact: true }).click();
  const listen = page.getByRole('group', { name: 'Listen to' });
  check(await pressed(listen.getByRole('button', { name: 'Master', exact: true })), 'Listen to: Master at start');
  const onMaster = await outLevel();
  await listen.getByRole('button', { name: 'Deck A cue' }).click();
  await page.waitForTimeout(150);
  const onCueA = await outLevel();
  check(onMaster < 0.002 && onCueA > 0.01, `Listen to: Deck A cue plays deck A with its fader down (out ${onMaster.toFixed(4)} → ${onCueA.toFixed(4)})`);
  check((await masterLevel()) < 0.002, 'Listen to: the master stays silent meanwhile');
  await listen.getByRole('button', { name: 'Deck B cue' }).click();
  await page.waitForTimeout(150);
  check((await outLevel()) < 0.002, 'Listen to: Deck B cue doesn’t hear deck A');
  await listen.getByRole('button', { name: 'Deck A cue' }).click();
  const vol = page.getByRole('slider', { name: 'Listening volume' });
  await vol.fill('0');
  await page.waitForTimeout(150);
  check((await outLevel()) < 0.0005 && (await vol.getAttribute('aria-valuetext')) === 'off', 'Listening volume: down to off silences the output');
  // Volume still off: the master carries on (its meter, and so the recorder,
  // which taps the same point).
  await mixer.getByRole('slider', { name: 'Channel A volume' }).fill('1');
  await listen.getByRole('button', { name: 'Master', exact: true }).click();
  await page.waitForTimeout(150);
  let peak = 0;
  for (let i = 0; i < 20; i++) {
    peak = Math.max(peak, await masterLevel());
    await page.waitForTimeout(25);
  }
  const silentOut = await outLevel();
  check(peak > 0.05 && silentOut < 0.0005, `Listening volume: off here leaves the master playing (meter ${peak.toFixed(3)}, out ${silentOut.toFixed(4)})`);
  await listen.getByRole('button', { name: 'Deck A cue' }).click();
  await vol.fill('0.2');
  const hp = page.getByLabel('Headphones (cue)');
  await hp.selectOption('split');
  await page.waitForTimeout(100);
  check(await listen.getByRole('button', { name: 'Deck B cue' }).isDisabled(), 'Listen to: with Split headphones only Master can be picked');
  await hp.selectOption('off');
  await page.waitForTimeout(700); // saved a moment after the change
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Outputs', { exact: true }).click();
  check(await pressed(page.getByRole('group', { name: 'Listen to' }).getByRole('button', { name: 'Deck A cue' })), 'Listen to: the choice is remembered after a reload');
  check((await page.getByRole('slider', { name: 'Listening volume' }).inputValue()) === '0.2', 'Listening volume: remembered after a reload');
  await page.getByRole('group', { name: 'Listen to' }).getByRole('button', { name: 'Master', exact: true }).click();
  await page.getByRole('slider', { name: 'Listening volume' }).fill('0.8');
  await page.waitForTimeout(700);
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
