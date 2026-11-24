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

const range = (r) => A.getByRole('group', { name: 'Deck A pitch range' }).getByRole('button', { name: `±${r}` });
check(await pressed(range(8)), 'Pitch range: ±8 is selected at start');
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

await range(50).click();
await fader.fill('1');
check((await pitch(A)) === '+50.00%' && (await bpm(A)) === '186.0', `Pitch range: full travel at ±50 is +50% (${await bpm(A)} BPM)`);
await page.waitForTimeout(400);
const r50 = await rate('A');
check(near(r50, 1.5, 0.07), `…and the record turns 50% fast (rate ${r50.toFixed(3)})`);

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

/* ── Scroll to nudge ────────────────────────────────────────────────────── */

const platterA = A.getByRole('slider', { name: /Deck A platter/ });
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
