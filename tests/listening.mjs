/**
 * Listening and phone polish, the parts that don't need a browser:
 *   1. the screen wake lock — taken while a deck plays, let go when nothing
 *      does, dropped when the tab hides and taken again when it's back, a
 *      refusal retried on the next play, a missing API left alone;
 *   2. scroll to nudge — a wheel over a playing platter bends and lets go,
 *      Shift over a paused one scrubs, anything else is left to the page;
 *   3. the saved Listen to choice reads safely from old or broken saves.
 * The same features are checked in the running app by tests/controls.mjs.
 * Run: node tests/listening.mjs
 */
import { loadTs } from '../scripts/load-ts.mjs';

const { mods, close } = await loadTs('/src/ui/wakeLock.ts', '/src/ui/scrollNudge.ts', '/src/engine/listen.ts');
const [{ ScreenAwake }, { ScrollNudge, wheelAction, wheelPixels, BEND_RELEASE_MS }, { readListen }] = mods;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── Wake lock ──────────────────────────────────────────────────────────── */

function fakeBrowser({ refuse = false } = {}) {
  const doc = {
    visibilityState: 'visible',
    fns: new Set(),
    addEventListener: (_t, fn) => doc.fns.add(fn),
    removeEventListener: (_t, fn) => doc.fns.delete(fn),
    set(v) {
      doc.visibilityState = v;
      doc.fns.forEach((fn) => fn());
    },
  };
  const lock = {
    requests: 0,
    releases: 0,
    active: null,
    refuse,
    async request(type) {
      lock.requests++;
      if (type !== 'screen') throw new Error('wrong type');
      if (lock.refuse) throw new DOMException('no', 'NotAllowedError');
      const fns = [];
      const sentinel = {
        released: false,
        addEventListener: (_t, fn) => fns.push(fn),
        async release() {
          if (sentinel.released) return;
          sentinel.released = true;
          lock.releases++;
          if (lock.active === sentinel) lock.active = null;
          fns.forEach((fn) => fn());
        },
        // What the browser does when the page is hidden.
        drop() {
          sentinel.released = true;
          if (lock.active === sentinel) lock.active = null;
          fns.forEach((fn) => fn());
        },
      };
      lock.active = sentinel;
      return sentinel;
    },
  };
  return { doc, lock };
}

{
  const { doc, lock } = fakeBrowser();
  const awake = new ScreenAwake(lock, doc);
  const state = () => awake.store.get().state;
  check(state() === 'off' && lock.requests === 0, 'Wake lock: nothing asked for before a deck plays');
  awake.setWanted(true);
  await tick();
  check(state() === 'held' && lock.requests === 1 && lock.active, 'Wake lock: taken when a deck plays');
  awake.setWanted(true);
  await tick();
  check(lock.requests === 1, 'Wake lock: a second deck playing asks for nothing more');
  awake.setWanted(false);
  await tick();
  check(state() === 'off' && lock.releases === 1 && !lock.active, 'Wake lock: let go when nothing plays');

  awake.setWanted(true);
  await tick();
  // Hidden: the page turns hidden, the browser drops the lock itself, then
  // fires visibilitychange.
  doc.visibilityState = 'hidden';
  lock.active.drop();
  doc.set('hidden');
  await tick();
  check(state() === 'off' && lock.requests === 2, 'Wake lock: dropped while the tab is hidden, not asked for again');
  doc.set('visible');
  await tick();
  check(state() === 'held' && lock.requests === 3 && lock.active, 'Wake lock: taken again when the tab is back and a deck still plays');
  doc.set('hidden');
  await tick();
  check(!lock.active && state() === 'off', 'Wake lock: let go when the tab hides, even if the browser hasn’t yet');
  awake.setWanted(false);
  doc.set('visible');
  await tick();
  check(lock.requests === 3 && !lock.active, 'Wake lock: back in view with nothing playing asks for nothing');

  // Play then pause before the browser answers: the lock comes back and goes.
  awake.setWanted(true);
  awake.setWanted(false);
  await tick();
  await tick();
  check(!lock.active && state() === 'off', 'Wake lock: a pause before the browser answers lets the late lock go');
  awake.dispose();
}

{
  const { doc, lock } = fakeBrowser({ refuse: true });
  const awake = new ScreenAwake(lock, doc);
  awake.setWanted(true);
  await tick();
  check(awake.store.get().state === 'refused', 'Wake lock: a refusal is noted, nothing thrown');
  lock.refuse = false;
  awake.setWanted(false);
  awake.setWanted(true);
  await tick();
  check(awake.store.get().state === 'held', 'Wake lock: a refusal is retried on the next play');
}

{
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const awake = new ScreenAwake(undefined, doc);
  awake.setWanted(true);
  await tick();
  check(awake.store.get().state === 'unsupported', 'Wake lock: no API, nothing happens');
}

/* ── Scroll to nudge ────────────────────────────────────────────────────── */

const wheel = (deltaY, extra = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ...extra });
check(wheelPixels(wheel(3, { deltaMode: 1 })) === 48, 'Scroll: line deltas count as 16 px a line');
check(wheelPixels({ deltaX: 100, deltaY: 0, deltaMode: 0, shiftKey: true }) === 100, 'Scroll: Shift’s sideways wheel still counts');
check(wheelAction(wheel(100), { playing: false, hasAudio: true }) === null, 'Scroll: over a paused record without Shift the page scrolls');
check(wheelAction(wheel(100), { playing: true, hasAudio: false }) === null, 'Scroll: over a deck with no audio the page scrolls');
check(wheelAction(wheel(400), { playing: true, hasAudio: true }).amount === 1, 'Scroll: a big scroll bends no more than the nudge buttons');
check(wheelAction(wheel(-20), { playing: true, hasAudio: true }).amount === -0.2, 'Scroll: a small scroll up bends a little slower');

{
  const calls = [];
  const shifts = [];
  let playing = true;
  const deck = { hasAudio: true, store: { get: () => ({ playing }) }, setBend: (d) => calls.push(d), shift: (s) => shifts.push(s) };
  const timers = [];
  const nudge = new ScrollNudge(deck, () => {}, {
    set: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1),
    clear: (i) => (timers[i].live = false),
  });
  check(nudge.handle(wheel(100)) && calls.at(-1) === 1, 'Scroll nudge: a notch down bends the playing deck faster');
  check(nudge.handle(wheel(30)) && calls.at(-1) > 0.3, `Scroll nudge: smaller steps in the same direction keep most of the push (${calls.at(-1).toFixed(2)})`);
  const live = timers.filter((t) => t.live);
  check(live.length === 1 && live[0].ms === BEND_RELEASE_MS, 'Scroll nudge: one release timer, restarted by each step');
  live[0].fn();
  check(calls.at(-1) === 0 && nudge.bending === 0, 'Scroll nudge: lets go when the scrolling stops');
  nudge.handle(wheel(-100));
  check(calls.at(-1) === -1, 'Scroll nudge: a notch up bends slower');
  nudge.release();
  check(calls.at(-1) === 0, 'Scroll nudge: a hand on the record lets go of the bend');

  playing = false;
  const n = calls.length;
  check(!nudge.handle(wheel(100)) && calls.length === n && !shifts.length, 'Scroll nudge: paused, no Shift — not taken');
  check(nudge.handle(wheel(100, { shiftKey: true })) && Math.abs(shifts[0] - 0.2) < 1e-9, 'Scroll nudge: paused with Shift scrubs 0.2 s a notch');
  nudge.handle(wheel(-50, { shiftKey: true }));
  check(Math.abs(shifts[1] + 0.1) < 1e-9 && calls.length === n, 'Scroll nudge: Shift-scroll up scrubs back, without bending');
}

/* ── Saved choice ───────────────────────────────────────────────────────── */

const d = readListen(null);
check(d.source === 'master' && d.level === 0.8, 'Listen to: no save starts on the master at 0 dB');
const odd = readListen({ source: 'side', level: 7 });
check(odd.source === 'master' && odd.level === 1, 'Listen to: an unknown source and an out-of-range volume are tidied');
const ok = readListen({ source: 'cueB', level: 0.5 });
check(ok.source === 'cueB' && ok.level === 0.5, 'Listen to: a saved choice reads back');

await close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
