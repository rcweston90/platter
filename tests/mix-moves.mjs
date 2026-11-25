/**
 * Move mixes, end to end in Chromium: Rec moves records a few moves on the
 * demo tracks through the real controls, Replay plays them back, and the
 * controls have to end where they were. Then: taking over mid-replay,
 * Download, Copy link opened in a fresh browser (no crate but the demos),
 * a mix with a track the listener doesn't have, and the format's guards.
 *
 *   npm run dev
 *   PLATTER_URL=http://localhost:5173/ node tests/mix-moves.mjs
 *
 * PLATTER_CHROMIUM points at a Chrome binary if Playwright has none.
 */
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(URL_).origin });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

async function open(p) {
  await p.goto(URL_, { waitUntil: 'networkidle' });
  await p.locator('section[aria-label="Deck A"]').getByText('Night Bus').waitFor({ timeout: 20000 });
  await p.locator('section[aria-label="Deck B"]').getByText('Paper Lanterns').waitFor({ timeout: 20000 });
}
await open(page);

/** Everything the test compares: what the controls show, read from the rig. */
const state = (p = page) =>
  p.evaluate(() => {
    const s = window.platter;
    const m = s.mixer.get();
    const f = s.fx.store.get();
    return {
      decks: s.decks.map((d) => {
        const st = d.store.get();
        return {
          track: st.track?.id ?? null,
          playing: st.playing,
          pitch: st.pitch,
          range: st.range,
          sync: st.sync,
          loop: st.loop.active,
          loopStart: st.loop.start,
          loopEnd: st.loop.end,
          pos: d.position(),
        };
      }),
      channels: m.channels.map((c) => ({ fader: c.fader, high: c.high, low: c.low, filter: c.filter, trim: c.trim })),
      crossfader: m.crossfader,
      fx: { on: f.on, channel: f.channel, depth: f.depth, type: f.type },
      replay: s.moves.store.get().replay,
      note: s.moves.store.get().note,
      mixes: s.moves.store.get().list.length,
    };
  });

const A = page.locator('section[aria-label="Deck A"]');
const B = page.locator('section[aria-label="Deck B"]');
const mixer = page.getByRole('region', { name: 'Mixer' });
const recMoves = page.getByRole('button', { name: /Record your moves|Stop recording moves/ });

/* ── Record ─────────────────────────────────────────────────────────────── */

await A.getByRole('button', { name: 'Deck A play' }).click();
await page.waitForFunction(() => document.querySelector('[aria-label="Deck A pause"]'), null, { timeout: 15000 });
await page.waitForTimeout(600);

// Instant doubles would make deck B join deck A when Night Bus loads there;
// this mix wants B to stay stopped until it's started by hand.
const doublesB = B.getByRole('button', { name: 'Deck B instant doubles' });
if ((await doublesB.getAttribute('aria-pressed')) === 'true') await doublesB.click();
await recMoves.click();
check((await recMoves.getAttribute('aria-pressed')) === 'true', 'Rec moves: the button lights while recording');
await page.waitForTimeout(400);
// A load mid-mix (deck B is stopped): Night Bus on B, then Paper Lanterns back.
await page.evaluate(() => window.platter.loadToDeck('demo-night-bus', 1));
await page.evaluate(() => window.platter.loadToDeck('demo-paper-lanterns', 1));
await page.waitForTimeout(300);
await A.getByRole('slider', { name: 'Deck A pitch' }).fill('0.4');
await page.waitForTimeout(200);
await mixer.getByRole('slider', { name: 'Channel A volume' }).fill('0.62');
// A fader drag: many values in a row, thinned on the way in.
for (let i = 0; i <= 20; i++) await page.evaluate((v) => window.platter.setCrossfader(v), -0.8 + i * 0.05);
await page.waitForTimeout(200);
const high = mixer.getByRole('slider', { name: 'Channel B high EQ' });
await high.focus();
for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
await page.locator('body').click({ position: { x: 5, y: 890 } }).catch(() => {});
await page.evaluate(() => document.activeElement?.blur());
await B.getByRole('button', { name: 'Deck B play' }).click();
await page.waitForTimeout(500);
await page.keyboard.press('KeyJ'); // loop on deck B
await page.waitForTimeout(300);
await page.keyboard.press('KeyX'); // beat jump forward on deck A
await page.waitForTimeout(300);
await page.keyboard.press('KeyF'); // Beat FX on for deck A
await page.evaluate(() => window.platter.fx.setDepth(0.55));
await page.waitForTimeout(300);
await page.keyboard.press('KeyE'); // sync deck A
await page.waitForTimeout(1200);
await recMoves.click();
const recorded = await state();
const mix = await page.evaluate(() => window.platter.moves.store.get().list[0]);
check(!!mix && mix.kind === 'moves', `Rec moves: a move mix is kept (${mix?.moves.length} moves, ${mix?.seconds.toFixed(1)} s)`);
const kinds = new Set(mix.moves.map((m) => m.m));
for (const k of ['load', 'setPitch', 'ch', 'xf', 'play', 'toggleLoop', 'beatJump', 'fx.setOn', 'fx.setDepth', 'setSync'])
  check(kinds.has(k), `Rec moves: logs ${k}`);
const xfMoves = mix.moves.filter((m) => m.m === 'xf').length;
check(xfMoves >= 1 && xfMoves < 21, `Rec moves: a 21-step crossfader drag is thinned (${xfMoves} kept)`);
check(mix.moves.filter((m) => m.m === 'xf').at(-1).a[0] === Math.round(recorded.crossfader * 1e4) / 1e4, 'Rec moves: …and keeps where the drag ended');
check(mix.tracks.some((t) => t.id === 'demo-night-bus' && t.demo) && mix.tracks.every((t) => t.title), 'Rec moves: the tracks are listed with ids and titles');
check(mix.moves.every((m, i, a) => i === 0 || a[i - 1].t <= m.t), 'Rec moves: moves are in time order');

// The Recordings tab shows it, labelled.
await page.evaluate(() => document.activeElement?.blur());
await page.getByRole('tab', { name: /Recordings/ }).click();
const row = page.locator('li[data-kind="moves"]').first();
await row.waitFor({ timeout: 5000 });
check((await row.textContent()).includes('Moves'), 'Recordings: the move mix is labelled Moves');
for (const b of ['Replay', 'Copy link', 'Download']) check(await row.getByRole('button', { name: b }).isVisible(), `Recordings: the row has ${b}`);
check(await row.getByRole('button', { name: /Delete/ }).isVisible(), 'Recordings: the row has Delete');

/* ── Mess everything up, then replay ────────────────────────────────────── */

await page.evaluate(() => {
  const s = window.platter;
  s.decks.forEach((d) => {
    d.setSync(false);
    d.pause();
    d.exitLoop();
    d.setPitch(0);
  });
  s.setChannel(0, { fader: 0.2 });
  s.setChannel(1, { high: 0.9 });
  s.setCrossfader(-1);
  s.fx.setOn(false);
  s.fx.setDepth(0);
});
await page.waitForTimeout(300);

await row.getByRole('button', { name: 'Replay' }).click();
await page.waitForFunction(() => window.platter.moves.store.get().replay?.phase === 'playing', null, { timeout: 15000 });
check(await page.getByRole('region', { name: 'Move mix replay' }).getByText('Replaying').isVisible(), 'Replay: the replay bar shows');
// Mid-replay the controls move: the pitch fader is back where it was at the start (0) and goes to the recorded value.
await page.waitForFunction(() => !window.platter.moves.store.get().replay, null, { timeout: (mix.seconds + 10) * 1000 });
const replayed = await state();
check(/finished/.test(replayed.note ?? ''), `Replay: it runs to the end (${replayed.note})`);
for (const i of [0, 1]) {
  const a = recorded.decks[i];
  const b = replayed.decks[i];
  check(b.track === a.track, `Replay: deck ${'AB'[i]} ends on ${a.track}`);
  check(b.playing === a.playing, `Replay: deck ${'AB'[i]} ${a.playing ? 'is playing' : 'is stopped'}`);
  check(near(b.pitch, a.pitch, 1e-3), `Replay: deck ${'AB'[i]} pitch ${b.pitch.toFixed(4)} (was ${a.pitch.toFixed(4)})`);
  check(b.sync === a.sync, `Replay: deck ${'AB'[i]} sync ${b.sync}`);
  check(b.loop === a.loop && (!a.loop || (near(b.loopStart, a.loopStart, 0.002) && near(b.loopEnd, a.loopEnd, 0.002))), `Replay: deck ${'AB'[i]} loop ${b.loop ? `${b.loopStart.toFixed(3)}–${b.loopEnd.toFixed(3)}` : 'off'}`);
}
check(near(replayed.decks[0].pos, recorded.decks[0].pos, 0.5), `Replay: deck A ends at the same place (${replayed.decks[0].pos.toFixed(2)} vs ${recorded.decks[0].pos.toFixed(2)} s)`);
check(near(replayed.channels[0].fader, recorded.channels[0].fader, 1e-3), `Replay: channel A volume ${replayed.channels[0].fader}`);
check(near(replayed.channels[1].high, recorded.channels[1].high, 1e-3), `Replay: channel B high EQ ${replayed.channels[1].high}`);
check(near(replayed.crossfader, recorded.crossfader, 1e-3), `Replay: crossfader ${replayed.crossfader}`);
check(replayed.fx.on === recorded.fx.on && replayed.fx.channel === recorded.fx.channel && near(replayed.fx.depth, recorded.fx.depth, 1e-3), `Replay: Beat FX ${replayed.fx.on ? 'on' : 'off'} on ${replayed.fx.channel}, level ${replayed.fx.depth}`);
check(Number(await mixer.getByRole('slider', { name: 'Channel A volume' }).inputValue()) === recorded.channels[0].fader, 'Replay: the volume fader on screen moved too');

/* ── Take over ──────────────────────────────────────────────────────────── */

await page.evaluate(() => window.platter.decks.forEach((d) => d.pause()));
await page.evaluate(() => window.platter.setCrossfader(-1));
await row.getByRole('button', { name: 'Replay' }).click();
await page.waitForFunction(() => window.platter.moves.store.get().replay?.phase === 'playing', null, { timeout: 15000 });
await page.waitForTimeout(300);
await mixer.getByRole('slider', { name: 'Crossfader' }).fill('-0.5');
await page.waitForTimeout(100);
const took = await state();
check(!took.replay && /took over/.test(took.note ?? ''), `Take over: touching the crossfader stops the replay (${took.note})`);
await page.waitForTimeout(Math.min(4000, mix.seconds * 1000));
const after = await state();
check(near(after.crossfader, -0.5, 1e-3), `Take over: the replay doesn't move it again (${after.crossfader})`);
check(after.decks[0].playing, 'Take over: the decks keep playing as they were');

/* ── Download ───────────────────────────────────────────────────────────── */

const [dl] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: 'Download' }).click()]);
check(dl.suggestedFilename().endsWith('.plattermix'), `Download: a .plattermix file (${dl.suggestedFilename()})`);
const dir = mkdtempSync(join(tmpdir(), 'mixmoves-'));
const file = join(dir, dl.suggestedFilename());
await dl.saveAs(file);
const saved = JSON.parse(readFileSync(file, 'utf8'));
check(saved.format === 'platter-mix' && saved.v === 1 && saved.moves.length === mix.moves.length, 'Download: the file holds the whole mix');

/* ── Copy link, opened somewhere fresh ──────────────────────────────────── */

await row.getByRole('button', { name: 'Copy link' }).click();
await page.waitForFunction(() => /Link copied|too long|Copy the link/.test(document.body.textContent), null, { timeout: 5000 });
const link = await page.evaluate(() => navigator.clipboard.readText());
check(link.includes('#mix=') && link.length < 16000, `Copy link: a #mix= link (${link.length} characters)`);

const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const other = await fresh.newPage();
other.on('pageerror', (e) => errors.push(`fresh: ${e.message}`));
await other.goto(link, { waitUntil: 'networkidle' });
await other.locator('section[aria-label="Deck A"]').getByText('Night Bus').waitFor({ timeout: 20000 });
const bar = other.getByRole('region', { name: 'Move mix replay' });
await bar.getByText('A mix was shared with you').waitFor({ timeout: 10000 });
check(true, 'Link: opening it offers the shared mix');
check(!(await other.evaluate(() => location.hash)), 'Link: the hash is taken out of the address');
await bar.getByRole('button', { name: 'Replay' }).click();
// A first visit is still drawing the demos' waveforms: getting ready takes longer there.
await other.waitForFunction(() => window.platter.moves.store.get().replay?.phase === 'playing', null, { timeout: 90000 });
await other.waitForFunction(() => !window.platter.moves.store.get().replay, null, { timeout: (mix.seconds + 10) * 1000 });
const there = await state(other);
check(/finished/.test(there.note ?? ''), `Link: the demo tracks replay there (${there.note})`);
check(near(there.crossfader, recorded.crossfader, 1e-3) && near(there.decks[0].pitch, recorded.decks[0].pitch, 1e-3), 'Link: …and the controls end where they did here');
await fresh.close();

/* ── A track the listener doesn't have ──────────────────────────────────── */

const foreign = { ...saved, id: 'test-foreign', name: 'Foreign mix' };
foreign.tracks = saved.tracks.map((t) =>
  t.id === 'demo-paper-lanterns' ? { ...t, id: 'someone-elses-track', title: 'Someone Else’s Track', artist: 'Nobody Here', demo: false } : t,
);
const swap = (v) => (v === 'demo-paper-lanterns' ? 'someone-elses-track' : v);
foreign.start = { ...saved.start, decks: saved.start.decks.map((d) => ({ ...d, track: swap(d.track) })) };
foreign.moves = saved.moves.map((m) => (m.m === 'load' ? { ...m, a: [swap(m.a[0]), m.a[1]] } : m));
const foreignFile = join(dir, 'foreign.plattermix');
writeFileSync(foreignFile, JSON.stringify(foreign));
await page.locator('input[aria-label="Import a move mix file"]').setInputFiles(foreignFile);
const frow = page.locator('li[data-kind="moves"]', { hasText: 'Foreign mix' });
await frow.waitFor({ timeout: 5000 });
check((await frow.textContent()).includes('not in your crate'), 'Missing: the row says which track isn’t in the crate');
await page.evaluate(() => window.platter.decks.forEach((d) => d.pause()));
await frow.getByRole('button', { name: 'Replay' }).click();
const dialog = page.getByRole('dialog', { name: /isn’t in your crate/ });
await dialog.waitFor({ timeout: 5000 });
check(await dialog.getByText('Someone Else’s Track').isVisible(), 'Missing: Replay names the missing track');
check((await dialog.getByRole('combobox').inputValue()) === '', 'Missing: it offers Skip, or a track of yours instead');
await dialog.getByRole('button', { name: 'Replay' }).click();
await page.waitForFunction(() => window.platter.moves.store.get().replay?.phase === 'playing', null, { timeout: 15000 });
check(true, 'Missing: skipping it, the replay starts');
await page.getByRole('region', { name: 'Move mix replay' }).getByRole('button', { name: 'Stop' }).click();
check(!(await state()).replay, 'Stop: the replay bar’s Stop ends it');

/* ── The format's guards ────────────────────────────────────────────────── */

const guards = await page.evaluate(async (good) => {
  const f = await import('/src/engine/moves/format.ts');
  const bad = (patch) => {
    try {
      f.parseMix({ ...good, ...patch });
      return false;
    } catch {
      return true;
    }
  };
  const big = { ...good, moves: Array.from({ length: 60000 }, (_, i) => ({ t: i * 0.01, m: 'xf', a: [Math.sin(i) * 0.999] })) };
  const tooLong = await f.mixLink(f.parseMix(big));
  const fine = await f.mixLink(f.parseMix(good));
  const back = await f.mixFromHash(new URL(fine.url).hash);
  return {
    unknownMove: bad({ moves: [{ t: 0, m: 'constructor', d: 0 }] }),
    badArg: bad({ moves: [{ t: 0, m: 'seek', d: 0, a: ['x'] }] }),
    badChannel: bad({ moves: [{ t: 0, m: 'ch', d: 0, a: ['__proto__', 1] }] }),
    wrongFormat: bad({ format: 'other' }),
    tooLong: !tooLong.ok && /too long/.test(tooLong.reason),
    roundTrip: back.moves.length === good.moves.length && back.id === good.id,
  };
}, saved);
check(guards.unknownMove && guards.badArg && guards.badChannel && guards.wrongFormat, 'Format: unknown moves, bad arguments and other files are refused');
check(guards.tooLong, 'Copy link: a mix too long for a link says so (Download instead)');
check(guards.roundTrip, 'Link: a mix comes back from its link whole');

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
