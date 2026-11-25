/**
 * End-to-end check in Chromium: the rig opens cued up, plays, syncs,
 * scratches, key-locks, imports a file, records a mix; then key matching,
 * beat FX, rolls, the sampler's sound library and kits, the beat board, MIDI
 * learn, Auto-DJ, backup and Rekordbox import, playlists and play history,
 * recordings, stems (with a tiny
 * stand-in for the separation model), beat pitch lanes, Audius and SoundCloud (with their APIs
 * mocked).
 *
 *   npm run dev            # or: npm run build && npm run preview
 *   npm run test:e2e       # URL defaults to http://localhost:5173/
 *
 * Needs a Chromium for Playwright (`npx playwright install chromium`).
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const URL_ = process.env.PLATTER_URL ?? 'http://localhost:5173/';
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

/** A 120 BPM kick loop as a 16-bit stereo WAV, for the import test. */
function kickWav(seconds = 20, bpm = 120, sr = 44100) {
  const n = seconds * sr;
  const data = new Int16Array(n * 2);
  const beat = (60 / bpm) * sr;
  for (let k = 0; k * beat < n; k++) {
    let phase = 0;
    for (let i = 0; i < 0.3 * sr && k * beat + i < n; i++) {
      const t = i / sr;
      phase += (2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03))) / sr;
      const v = Math.sin(phase) * Math.exp(-t / 0.1) * 0.8 * 32767;
      const j = Math.floor(k * beat) + i;
      data[2 * j] = data[2 * j + 1] = v;
    }
  }
  const buf = Buffer.alloc(44 + data.byteLength);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data.byteLength, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data.byteLength, 40);
  Buffer.from(data.buffer).copy(buf, 44);
  return buf;
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  // Any recent Chrome works too, e.g. PLATTER_CHROME=/path/to/chrome.
  ...(process.env.PLATTER_CHROME ? { executablePath: process.env.PLATTER_CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// Stems: the 170 MB HTDemucs model is swapped for a stand-in with the same
// shapes (tests/fixtures/make-fake-demucs.py). Routed from the start, since
// auto-split fetches it as soon as a file is added.
const modelRequests = [];
await page.route('https://huggingface.co/**', (route) => {
  modelRequests.push(route.request().method());
  return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(new URL('./fixtures/fake-demucs.onnx', import.meta.url)) });
});

await page.goto(URL_, { waitUntil: 'networkidle' });
const A = page.locator('section[aria-label="Deck A"]');
const B = page.locator('section[aria-label="Deck B"]');
await A.getByText('Night Bus').waitFor({ timeout: 15000 });
await B.getByText('Paper Lanterns').waitFor({ timeout: 15000 });
check(true, 'opens with both demo tracks cued');

const time = (deck) => deck.locator('[class*="time"] span').first().textContent();
await A.getByRole('button', { name: 'Deck A play' }).click();
await page.waitForFunction(() => document.querySelector('[aria-label="Deck A pause"]'), null, { timeout: 15000 });
await page.waitForTimeout(2200);
check((await time(A)) !== '0:00', `deck A plays from the first press (at ${await time(A)})`);

await B.getByRole('button', { name: 'Sync' }).click();
check((await B.locator('[class*="bpmValue"]').textContent()) === '124.0', 'sync pulls deck B from 128 to 124 BPM');
await B.getByRole('button', { name: 'Deck B play' }).click();
await page.waitForTimeout(1500);
const meter = await page.$eval('[aria-label="Master left level meter"] [class*="meterCover"]', (e) => parseFloat(/scaleY\(([^)]+)\)/.exec(e.style.transform)?.[1] ?? '1') * 100);
check(meter < 95, `master meter shows signal (${meter.toFixed(0)}% covered)`);

// Beat pitch: both decks' hits are read on load and drawn in their lanes;
// the toggle hides and shows the lanes.
await page.waitForFunction(() => window.platter.hits.every((h) => h.store.get().status === 'ready'), null, { timeout: 20000 });
const hitCounts = await page.evaluate(() => window.platter.hits.map((h) => h.store.get().hits.length));
check(hitCounts.every((n) => n > 50), `beat pitch reads both demos' hits (${hitCounts.join(', ')})`);
// Each deck shows the mix lane, or its lanes by stem once auto-split has
// brought the stems in.
const lanes = page.getByRole('img', { name: /^Deck [AB] beat pitch/ });
const decksWithLanes = async () => (await Promise.all(['A', 'B'].map((d) => page.getByRole('img', { name: new RegExp(`^Deck ${d} beat pitch`) }).count()))).filter((n) => n > 0).length;
check((await decksWithLanes()) === 2, `a beat pitch lane shows for each deck (${await lanes.count()} lanes)`);
const pitchToggle = page.getByRole('button', { name: /^Beat pitch/ });
const laneMenu = page.getByRole('dialog', { name: 'Beat pitch lanes' });
await pitchToggle.click();
await laneMenu.getByRole('radio', { name: 'Off' }).click();
check((await lanes.count()) === 0 && (await pitchToggle.getAttribute('data-on')) === null, 'the beat pitch menu turns the lanes off');
await laneMenu.getByRole('radio', { name: 'Split' }).click();
check((await decksWithLanes()) === 2, 'and back on for both decks');
await page.keyboard.press('Escape');
check((await laneMenu.count()) === 0, 'Escape closes the beat pitch menu');

// Scratch deck A back one full turn (1.8 s of audio).
const platter = page.getByRole('slider', { name: /Deck A platter/ });
await platter.scrollIntoViewIfNeeded();
const box = await platter.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const r = box.width * 0.35;
const posA = () => page.$eval('section[aria-label="Deck A"] canvas[role="slider"]', (c) => Number(c.getAttribute('aria-valuenow')));
const before = await posA();
await page.mouse.move(cx + r, cy);
await page.mouse.down();
for (let i = 0; i <= 40; i++) {
  const a = -(i / 40) * 2 * Math.PI;
  await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
  await page.waitForTimeout(8);
}
await page.waitForTimeout(300);
const during = await posA();
await page.mouse.up();
check(during < before, `scratching back rewinds deck A (${before}s → ${during}s)`);

// Key lock at +8%.
await A.getByRole('button', { name: 'Deck A key lock' }).click();
await A.getByRole('slider', { name: 'Deck A pitch' }).focus();
await page.keyboard.press('End');
await page.waitForTimeout(1200);
const chMeter = await page.$eval('[aria-label="Channel A level meter"] [class*="meterCover"]', (e) => parseFloat(/scaleY\(([^)]+)\)/.exec(e.style.transform)?.[1] ?? '1') * 100);
check(chMeter < 95, `key-locked deck A still sounds at +8% (${chMeter.toFixed(0)}% covered)`);

// Import a file: tags fall back to "Artist - Title", tempo is detected.
await page.getByLabel('Audio files to add to the crate').setInputFiles({ name: 'Test Artist - Kick Loop.wav', mimeType: 'audio/wav', buffer: kickWav() });
await page.locator('tbody tr', { hasText: 'Kick Loop' }).waitFor({ timeout: 15000 });
await page.waitForFunction(() => !document.body.textContent.includes('analysing…'), null, { timeout: 30000 });
const row = await page.locator('tbody tr', { hasText: 'Kick Loop' }).textContent();
check(/Test Artist/.test(row) && /120\.0/.test(row), `imported file reads as Test Artist, 120 BPM (${row.replace(/\s+/g, ' ').trim()})`);
// Auto-split: the added file is queued for stems at once. Here (no GPU) it waits while deck A plays,
// so the audio thread isn't starved; on a GPU it would carry on.
const stemsChip = page.locator('tbody tr', { hasText: 'Kick Loop' }).locator('[class*="stems"]').first();
await page.waitForFunction(() => ['waiting', 'running', 'done'].includes(window.platter.presplit.store.get().phase), null, { timeout: 15000 }).catch(() => undefined);
const chip = ((await stemsChip.textContent().catch(() => '')) ?? '').trim();
const split = await page.evaluate(() => window.platter.presplit.store.get());
check(
  split.total === 1 && (chip === 'Stems' || (chip === 'Stems queued' && split.waitingFor === 'deck') || chip.startsWith('Stems ')),
  `the added file is queued for auto-split (row: "${chip}", ${split.phase}${split.waitingFor ? ` for ${split.waitingFor}` : ''})`,
);

// Record three seconds, then save.
await page.getByRole('button', { name: 'Record the mix' }).click();
await page.waitForTimeout(3000);
await page.getByRole('button', { name: 'Stop recording the mix' }).click();
const save = page.getByRole('button', { name: 'Save mix' });
await save.waitFor({ timeout: 5000 });
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), save.click()]);
check(/^platter-mix-.*\.(webm|mp4|ogg)$/.test(download.suggestedFilename()), `recording saves as ${download.suggestedFilename()}`);
// The file holds the whole mix: it decodes, runs about as long as the take,
// and isn't silent. (A recorder that drops its timeslice chunks leaves a few
// kilobytes with no header, which decodes to nothing.)
const take = await page.evaluate(async () => {
  const blob = window.platter.mixer.get().lastRecording?.blob;
  if (!blob) return null;
  const ctx = new OfflineAudioContext(2, 1, 48000);
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ch = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    return { bytes: blob.size, seconds: buf.duration, rms: Math.sqrt(sum / ch.length) };
  } catch (e) {
    return { bytes: blob.size, seconds: 0, rms: 0, error: String(e) };
  }
});
check(
  !!take && take.bytes > 20_000 && take.seconds > 2 && take.rms > 0.005,
  `the recorded mix has sound (${take ? `${(take.bytes / 1e3).toFixed(0)} KB, ${take.seconds.toFixed(1)} s, rms ${take.rms.toFixed(3)}` : 'none'})`,
);

// ── Harmonic mixing ──
// Deck B follows A's +8% through sync, which lifts its key a semitone.
const keyOf = (deck) => deck.locator('[class*="keyChip"]').textContent();
const bKey = await keyOf(B);
await B.getByRole('button', { name: 'Match' }).click();
await page.waitForTimeout(800);
const matched = (await B.locator('[class*="keyChip"]').getAttribute('data-match')) === 'true';
check(matched, `Match shifts deck B from ${bKey} to ${await keyOf(B)}, compatible with deck A (${await keyOf(A)})`);

// ── Beat FX ──
// The mixer's one unit, put on deck A by the deck's FX button, with some level.
await page.getByRole('button', { name: 'Deck A effect on' }).click();
await page.getByRole('slider', { name: 'Beat FX level' }).focus();
for (let i = 0; i < 5; i++) await page.keyboard.press('PageUp');
for (const fx of ['delay', 'echo', 'pingpong', 'spiral', 'reverb', 'helix', 'roll', 'triroll', 'flanger', 'phaser', 'filter', 'trifilter', 'mobius', 'trans', 'crush']) {
  await page.getByLabel('Beat FX effect').selectOption(fx);
  await page.waitForTimeout(250);
}
const fxMeter = await page.$eval('[aria-label="Channel A level meter"] [class*="meterCover"]', (e) => parseFloat(/scaleY\(([^)]+)\)/.exec(e.style.transform)?.[1] ?? '1') * 100);
check(fxMeter < 95, `deck A sounds through every beat FX (${fxMeter.toFixed(0)}% covered)`);
await page.getByRole('button', { name: 'Deck A effect off' }).click();

// ── Beat roll returns on release ──
await A.getByRole('button', { name: 'Roll', exact: true }).click();
const roll = A.getByRole('button', { name: /Hold for a 1\/4-beat roll/ });
await roll.scrollIntoViewIfNeeded();
const rb = await roll.boundingBox();
const r0 = await posA();
await page.mouse.move(rb.x + 10, rb.y + 10);
await page.mouse.down();
await page.waitForTimeout(2000);
const r1 = await posA();
await page.mouse.up();
await page.waitForTimeout(400);
const r2 = await posA();
check(r1 - r0 <= 1 && r2 - r0 >= 2, `a held roll holds the playhead (${r0}s → ${r1}s) and slips back on release (${r2}s)`);

// ── Sampler ──
const before0 = await page.$eval('[aria-label="Master left level meter"] [class*="meterCover"]', (e) => parseFloat(/scaleY\(([^)]+)\)/.exec(e.style.transform)?.[1] ?? '1') * 100);
await page.getByRole('button', { name: 'Sampler pad 7: Boom' }).click();
check(true, `sampler pad fires (master meter ${before0.toFixed(0)}% covered before)`);

// ── Sounds library, kits and the beat board ──
const libSize = await page.evaluate(() => window.platter.sampler.count());
check(libSize >= 800, `the sampler's library has ${libSize} sounds`);
await page.getByRole('button', { name: /^Sounds \d+/ }).click();
const sounds = page.locator('aside[aria-label="Sounds"]');
await sounds.getByRole('searchbox', { name: 'Search sounds' }).fill('vinyl scratch');
await sounds.getByRole('button', { name: 'Hear Vinyl scratch' }).first().click();
await page.waitForFunction(() => window.platter.sampler.store.get().preview !== null || window.platter.sampler.store.get().loading.length === 0, null, { timeout: 8000 });
await sounds.getByRole('button', { name: /^Put Vinyl scratch on pad A7$/ }).click();
check((await page.evaluate(() => window.platter.sampler.store.get().pads[6].sound)) === 'cc0:vinyl_scratch', 'a recorded sound from the library goes on the selected pad');
await sounds.getByRole('searchbox', { name: 'Search sounds' }).fill('');
await sounds.getByRole('button', { name: /^Bass \d+/ }).click();
const bassCount = await sounds.locator('li').count();
check(bassCount >= 20, `the Bass category lists ${bassCount} sounds`);
await sounds.getByRole('tab', { name: 'Kits' }).click();
await sounds.getByRole('button', { name: 'Load Acoustic Room onto bank C' }).click();
check((await page.evaluate(() => window.platter.sampler.store.get().bankKits[2])) === 'acoustic', 'a kit loads onto a bank');
await sounds.getByRole('button', { name: 'Close sounds' }).click();
await page.getByRole('button', { name: 'Bank A' }).click();
check((await page.getByRole('button', { name: /^Sampler pad 7: Vinyl scratch$/ }).count()) === 1, 'bank A shows the new sound on pad 7');

const board = page.locator('section[aria-label="Beat board"]');
await board.getByLabel('Start from a groove').selectOption('boombap');
const on = await board.locator('[role="gridcell"][aria-pressed="true"]').count();
check(on >= 10, `a groove writes ${on} steps onto the beat board`);
const beat = await page.evaluate(async () => {
  const { beats, sampler, decks } = window.platter;
  const hits = [];
  const off = sampler.onHit((h) => h.from === 'board' && hits.push(h.when));
  beats.setTempo('free');
  beats.setFreeBpm(120);
  beats.play();
  await new Promise((r) => setTimeout(r, 1600));
  const free = { n: hits.length, bpm: beats.store.get().bpm };
  // Now lock to deck A, playing.
  if (!decks[0].store.get().playing) decks[0].togglePlay();
  beats.setTempo('A');
  await new Promise((r) => setTimeout(r, 1200));
  const st = beats.store.get();
  const out = { free, following: st.following, bpm: st.bpm, deckBpm: decks[0].effectiveBpm(), heard: beats.heardStep() };
  beats.stop();
  off();
  return out;
});
check(beat.free.n >= 6 && beat.free.bpm === 120, `the beat board plays a groove on its own clock (${beat.free.n} hits at ${beat.free.bpm} BPM)`);
check(beat.following === 0 && Math.abs(beat.bpm - (beat.deckBpm ?? 0)) < 0.2 && beat.heard !== null, `the beat board locks to deck A (${beat.bpm} vs ${beat.deckBpm?.toFixed(1)} BPM)`);

// ── MIDI (simulated messages through the same parser a controller feeds) ──
const midiResult = await page.evaluate(async () => {
  const { midi, decks } = window.platter;
  midi.store.set({ connected: true });
  midi.learn('B.play');
  midi.receive(new Uint8Array([0x91, 40, 127])); // note 40, channel 2
  const bound = midi.store.get().bindings['B.play'];
  const was = decks[1].store.get().playing;
  midi.receive(new Uint8Array([0x91, 40, 127]));
  await new Promise((r) => setTimeout(r, 200));
  const now = decks[1].store.get().playing;
  midi.learn('xfader');
  midi.receive(new Uint8Array([0xb0, 8, 0]));
  midi.receive(new Uint8Array([0xb0, 8, 127]));
  return { bound, toggled: was !== now, xfader: window.platter.mixer.get().crossfader };
});
check(midiResult.bound === 'n:2:40', `MIDI learn binds deck B play to ${midiResult.bound}`);
check(midiResult.toggled, 'the learned note toggles deck B');
check(midiResult.xfader === 1, `a learned CC moves the crossfader (now ${midiResult.xfader})`);

// Crossfader assign is learnable: one note per position, and one that steps.
const midiAssign = await page.evaluate(() => {
  const { midi, mixer } = window.platter;
  midi.learn('A.xfThru');
  midi.receive(new Uint8Array([0x90, 50, 127]));
  midi.learn('A.xfAssign');
  midi.receive(new Uint8Array([0x90, 51, 127]));
  midi.receive(new Uint8Array([0x90, 50, 127]));
  const thru = mixer.get().xfAssign[0];
  midi.receive(new Uint8Array([0x90, 51, 127]));
  const stepped = mixer.get().xfAssign[0];
  midi.receive(new Uint8Array([0x90, 51, 127]));
  midi.receive(new Uint8Array([0x90, 51, 127]));
  return { thru, stepped, back: mixer.get().xfAssign[0] };
});
check(
  midiAssign.thru === 'thru' && midiAssign.stepped === 'B' && midiAssign.back === 'thru',
  `MIDI: crossfader assign learns and steps A → THRU → B (${midiAssign.thru}, ${midiAssign.stepped}, ${midiAssign.back})`,
);
await page.evaluate(() => window.platter.setXfAssign(0, 'A'));

// ── Auto-DJ cues the next track ──
await page.getByRole('tab', { name: /Auto-DJ/ }).click();
await page.getByRole('tab', { name: 'Crate' }).click();
await page.getByRole('button', { name: 'Queue Kick Loop for Auto-DJ' }).click();
await page.getByRole('tab', { name: /Auto-DJ/ }).click();
await page.getByRole('button', { name: /Auto-DJ off/ }).click();
await page
  .waitForFunction(() => /Kick Loop/.test(document.querySelector('section[aria-label="Deck A"]')?.textContent + document.querySelector('section[aria-label="Deck B"]')?.textContent), null, { timeout: 15000 })
  .catch(async (e) => {
    console.log('auto-dj state:', JSON.stringify(await page.evaluate(() => ({ dj: window.platter.autoDj.store.get(), a: window.platter.decks[0].store.get().playing, b: window.platter.decks[1].store.get().playing, bErr: window.platter.decks[1].store.get().error, bTrack: window.platter.decks[1].store.get().track?.title }))));
    throw e;
  });
check(true, 'Auto-DJ cues the queued track on the idle deck');
await page.getByRole('button', { name: /Auto-DJ on/ }).click();

// ── Backup round-trip and Rekordbox import ──
const backup = await page.evaluate(async () => {
  const p = window.platter;
  const { blob } = p.exportBackup();
  const text = await blob.text();
  const data = JSON.parse(text);
  const id = data.tracks.find((t) => t.title === 'Kick Loop').id;
  // A version 1 backup: four hot cues as plain numbers, no memory cues.
  data.version = 1;
  data.tracks.find((t) => t.id === id).cues = { main: 1.5, hot: [2, null, 4, null] };
  await p.importFile(new File([JSON.stringify(data)], 'b.json'));
  const after = p.crate.get().tracks.find((t) => t.id === id);
  // And today's form, with a hot loop, a colour and memory cues, round-trips.
  const v2 = JSON.parse(await p.exportBackup().blob.text());
  v2.tracks.find((t) => t.id === id).cues = {
    main: 1.5,
    hot: [{ t: 2, color: 9 }, null, null, null, null, null, null, null, null, { t: 6, color: 4, loop: { end: 8, beats: 4 } }],
    memory: [3, 1],
  };
  await p.importFile(new File([JSON.stringify(v2)], 'b2.json'));
  const again = JSON.parse(await p.exportBackup().blob.text()).tracks.find((t) => t.id === id).cues;
  const rb = `<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1"><TRACK Name="Kick Loop" Artist="Test Artist" Location="file://localhost/Users/me/Music/Test%20Artist%20-%20Kick%20Loop.wav" AverageBpm="120.00" Tonality="Am" TotalTime="20"><TEMPO Inizio="0.050" Bpm="120.00" Metro="4/4" Battito="1"/><POSITION_MARK Name="" Type="0" Start="0.050" Num="-1"/><POSITION_MARK Name="" Type="0" Start="8.050" Num="0"/><POSITION_MARK Name="" Type="4" Start="2.050" End="4.050" Num="1" Red="69" Green="216" Blue="140"/></TRACK></COLLECTION></DJ_PLAYLISTS>`;
  await p.importFile(new File([rb], 'rekordbox.xml'));
  const rbAfter = p.crate.get().tracks.find((t) => t.id === id);
  return { cues: after.cues, again, note: p.crate.get().note, rbKey: rbAfter.key, rbHot: rbAfter.cues.hot, rbGrid: rbAfter.gridOffset };
});
check(
  backup.cues.main === 1.5 && backup.cues.hot.length === 16 && backup.cues.hot[0]?.t === 2 && backup.cues.hot[2]?.t === 4 && backup.cues.hot[2]?.color === 2 && backup.cues.hot[1] === null,
  'a version 1 backup imports its four hot cues into the first slots, in their old colours',
);
check(
  backup.again.hot[0]?.color === 9 && backup.again.hot[9]?.loop?.end === 8 && backup.again.memory.join() === '1,3',
  'a backup round-trips hot cue colours, hot loops and memory cues',
);
check(
  backup.rbKey === '8A' && backup.rbHot[0]?.t === 8.05 && backup.rbHot[1]?.loop?.beats === 4 && backup.rbHot[1]?.color === 1 && backup.rbGrid === 0.05,
  `Rekordbox XML imports key, grid, hot cues and hot loops (${backup.note})`,
);

// ── Recordings are kept ──
await page.getByRole('tab', { name: /Recordings/ }).click();
check((await page.locator('[role="tabpanel"] li').count()) >= 1, 'the recorded mix is listed under Recordings');

// ── Stems: the 170 MB HTDemucs model is swapped for a stand-in with the same
// shapes (tests/fixtures/make-fake-demucs.py), so the whole path runs: worker,
// ONNX Runtime, the split, the worklet mix. ──
const otherDuringSplit = [];
const watchUploads = (req) => req.method() !== 'GET' && otherDuringSplit.push(`${req.method()} ${req.url()}`);
page.on('request', watchUploads);
const stemsB = page.getByRole('group', { name: 'Deck B stems' });
const bTrack = await page.evaluate(() => window.platter.decks[1].store.get().track?.title);
// No click: with auto-split on, the stems arrive by themselves once the track is on the deck.
await stemsB.getByRole('button', { name: 'Vocals' }).waitFor({ timeout: 60000 });
check((await stemsB.getByRole('button', { name: /^(Split|Load stems)$/ }).count()) === 0, 'deck B gets its stems without anyone pressing Split');
page.off('request', watchUploads);
check(modelRequests.length === 1 && modelRequests[0] === 'GET', `the separation model is fetched once, for auto-split and deck B's split of ${bTrack} together`);
check(otherDuringSplit.length === 0, `nothing is sent anywhere while splitting${otherDuringSplit.length ? `: ${otherDuringSplit.join(', ')}` : ''}`);
await stemsB.getByRole('button', { name: 'Vocals' }).click();
await stemsB.getByRole('button', { name: 'Drums' }).click({ modifiers: ['Shift'] });
const pressed = await stemsB.getByRole('button').evaluateAll((bs) => bs.map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`));
check(pressed.includes('Drums:true') && pressed.includes('Vocals:false') && pressed.includes('Bass:false'), `soloing drums on deck B (${pressed.join(' ')})`);
const bState = await page.evaluate(() => ({ playing: window.platter.decks[1].store.get().playing, title: window.platter.decks[1].store.get().track?.title }));
if (!bState.playing) await B.getByRole('button', { name: 'Deck B play' }).click();
await page.waitForTimeout(800);
const bMeter = await page.$eval('[aria-label="Channel B level meter"] [class*="meterCover"]', (e) => parseFloat(/scaleY\(([^)]+)\)/.exec(e.style.transform)?.[1] ?? '1') * 100);
check(bMeter < 95, `deck B still sounds with drums soloed (${bMeter.toFixed(0)}% covered, ${bState.title}${bState.playing ? '' : ', started'})`);
// The row says the split worked, and each part's own meter shows what it plays.
check(await stemsB.getByRole('status').filter({ hasText: 'Stems ready' }).isVisible(), 'deck B says "Stems ready" once split');
// The split stems are read part by part, and deck B's pitch lanes split by part, each with its chip.
await page.waitForFunction(() => window.platter.hits[1].store.get().stemStatus === 'ready', null, { timeout: 30000 });
const stemLanesB = page.getByRole('group', { name: 'Deck B beat pitch by stem' });
check(await stemLanesB.isVisible(), 'deck B’s pitch lanes split by stem once the stems are in');
check((await stemLanesB.getByRole('button', { name: /^Deck B (vocals|drums|bass|other):/ }).count()) === 4, 'each part has its chip by the lanes');
const stemBars = async () => {
  const best = { Vocals: 0, Drums: 0, Bass: 0, Other: 0 };
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(100);
    const now = await stemsB.getByRole('button').evaluateAll((bs) => bs.map((b) => [b.textContent, parseFloat(b.querySelector('[data-level]')?.dataset.level ?? 'NaN')]));
    for (const [name, v] of now) if (name in best) best[name] = Math.max(best[name], v);
  }
  return best;
};
const soloBars = await stemBars();
check(soloBars.Drums > 0.3 && soloBars.Vocals < 0.05 && soloBars.Bass < 0.05 && soloBars.Other < 0.05, `with drums soloed only the drums meter moves (${JSON.stringify(soloBars)})`);
await stemsB.getByRole('button', { name: 'Hear every part' }).click();
await page.waitForTimeout(300);
const allBars = await stemBars();
check(Object.values(allBars).every((v) => v > 0.3), `with every part on, every part's meter moves (${JSON.stringify(allBars)})`);
// Muting every part has to be heard, not just shown on the buttons.
await stemsB.getByRole('button', { name: 'Hear every part' }).click();
for (const part of ['Vocals', 'Drums', 'Bass', 'Other']) await stemsB.getByRole('button', { name: part }).click();
await page.waitForTimeout(1200); // the key shift's stretcher and the meter's fall
let mutedMeter = 0;
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(100);
  mutedMeter = Math.max(mutedMeter, 100 - (await page.$eval('[aria-label="Channel B level meter"] [class*="meterCover"]', (e) => parseFloat(/scaleY\(([^)]+)\)/.exec(e.style.transform)?.[1] ?? '1') * 100)));
}
check(mutedMeter < 3, `muting every part silences deck B (peak ${mutedMeter.toFixed(0)}% while ${bMeter < 95 ? 'it was sounding' : 'quiet'} before)`);
const mutedBars = await stemBars();
check(Object.values(mutedBars).every((v) => v < 0.05), `muted parts' meters drop to nothing (${JSON.stringify(mutedBars)})`);
const cached = await page.evaluate(async () => {
  const keys = [];
  for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) keys.push(`${name} ${r.url}`);
  return keys.filter((k) => !k.startsWith('platter-v1 '));
});
check(cached.length === 1 && cached[0].includes('huggingface.co'), `only the model is in Cache Storage (${cached.join(', ')})`);
// Deck B's split is kept (in the browser's own storage, for a dropped file), so the row says Stems.
await page.waitForFunction(() => Object.values(window.platter.presplit.rows.get()).some((r) => r.state === 'ready'), null, { timeout: 60000 }).catch(() => undefined);
const kept = await page.evaluate(() => ({ rows: JSON.stringify(window.platter.presplit.rows.get()), msg: window.platter.presplit.store.get().message }));
check(/"ready"/.test(kept.rows), `deck B’s split is kept, so Kick Loop shows Stems in the crate (${kept.rows}${kept.msg ? `, ${kept.msg}` : ''})`);
await stemsB.getByRole('button', { name: 'Hear every part' }).click();

// ── Audius (API mocked: the test shouldn't depend on the network) ──
await page.route('https://api.audius.co/**', async (route) => {
  const url = route.request().url();
  if (url.includes('/stream')) return route.fulfill({ status: 200, contentType: 'audio/wav', body: kickWav(8, 126) });
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'abc1', title: 'Mocked Groove', duration: 8, genre: 'House', permalink: '/artist/mocked', is_streamable: true, artwork: null, user: { name: 'Mock Artist' } }] }),
  });
});
await page.getByRole('button', { name: 'Browse music' }).click();
const flyout = page.getByRole('complementary', { name: 'Browse music' });
await flyout.getByRole('tab', { name: 'Audius' }).click();
await flyout.getByRole('button', { name: 'House' }).click();
await page.getByText('Mocked Groove').waitFor({ timeout: 5000 });
await page.getByRole('button', { name: 'Load Mocked Groove on deck A' }).click().catch(() => {});
const aPlaying = await A.getByRole('button', { name: /Deck A (play|pause)/ }).getAttribute('aria-pressed');
if (aPlaying === 'true') await A.getByRole('button', { name: 'Deck A pause' }).click();
await page.getByRole('button', { name: 'Load Mocked Groove on deck A' }).click();
await A.getByText('Mocked Groove').waitFor({ timeout: 15000 });
await page.waitForFunction(() => window.platter.crate.get().tracks.find((t) => t.title === 'Mocked Groove')?.bpm, null, { timeout: 20000 });
const mocked = await page.evaluate(() => window.platter.crate.get().tracks.find((t) => t.title === 'Mocked Groove'));
check(mocked.link === 'https://audius.co/artist/mocked' && Math.round(mocked.bpm) === 126, `an Audius track streams onto deck A and is analysed (${mocked.bpm} BPM, link kept)`);
check(
  (await page.getByRole('group', { name: 'Deck A stems' }).getByRole('button', { name: 'Split' }).isDisabled()) &&
    (await page.getByRole('group', { name: 'Deck A stems' }).getByText('doesn’t allow remixing').count()) === 1,
  'an all-rights-reserved Audius track can’t be split',
);
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelector('aside[aria-label="Browse music"]')?.inert === true, null, { timeout: 3000 });
check(
  (await page.getByRole('button', { name: 'Browse music' }).getAttribute('aria-expanded')) === 'false' &&
    (await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Browse music',
  'Escape closes the browse flyout and puts focus back on its button',
);

// ── SoundCloud (its Vercel function and media host mocked). Last: the
// sign-in comes back through /soundcloud-callback, which reloads the page. ──
const scTrack = (id, title, license, userId) => ({
  kind: 'track',
  id,
  urn: `soundcloud:tracks:${id}`,
  title,
  duration: 8000,
  artwork_url: null,
  genre: 'House',
  license,
  permalink_url: `https://soundcloud.com/mock/${id}`,
  streamable: true,
  access: 'playable',
  user: { id: userId, username: `Artist ${userId}` },
});
const scCalls = [];
await page.route('**/api/soundcloud?**', async (route) => {
  const q = new URL(route.request().url()).searchParams;
  const op = q.get('op');
  scCalls.push(op === 'api' ? `api ${q.get('path')}` : op);
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (op === 'status') return json({ configured: true, clientId: 'mock' });
  if (op === 'token' || op === 'refresh') return json({ accessToken: 'tok', expiresIn: 3600 });
  if (op === 'stream') return json({ kind: 'mp3', url: 'https://cf-media.sndcdn.com/mock.mp3' });
  if (op === 'api' && q.get('path') === '/me') return json({ id: 7, username: 'Me', permalink_url: 'https://soundcloud.com/me' });
  if (op === 'api' && q.get('path').startsWith('/me/likes/tracks')) {
    return json({ collection: [scTrack(1, 'Free Remix Bait', 'cc-by', 9), scTrack(2, 'Locked Down Banger', 'all-rights-reserved', 9), scTrack(3, 'My Own Tune', 'all-rights-reserved', 7)], next_href: null });
  }
  if (op === 'api' && q.get('path').startsWith('/tracks?')) {
    const query = new URLSearchParams(q.get('path').split('?')[1]).get('q');
    return json({ collection: [scTrack(4, `Searched ${query}`, 'cc-by-sa', 5)], next_href: null });
  }
  return json({ error: 'unmocked' }, 404);
});
await page.route('https://cf-media.sndcdn.com/**', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: kickWav(8, 122) }));
await page.evaluate(() => sessionStorage.setItem('platter.sc.pkce', JSON.stringify({ verifier: 'v', state: 's' })));
await page.goto(new URL('/soundcloud-callback?code=c&state=s', URL_).toString());
await page.getByText('Free Remix Bait').waitFor({ timeout: 15000 });
check(
  new URL(page.url()).pathname === '/' && scCalls.includes('token') && (await page.getByRole('tab', { name: 'SoundCloud' }).getAttribute('aria-selected')) === 'true',
  'SoundCloud sign-in completes from the callback and opens the browse flyout on SoundCloud',
);
check((await page.getByText('3 tracks in your likes · 2 can go on the decks').count()) === 1, 'the likes list says how many tracks can go on the decks');
await page.getByRole('switch', { name: 'Mixable only' }).check();
check((await page.getByText('Locked Down Banger').count()) === 0, '“Mixable only” hides tracks that can’t go on the decks');
await page.getByRole('switch', { name: 'Mixable only' }).uncheck();
check(
  (await page.getByRole('button', { name: 'Load Locked Down Banger on deck A' }).count()) === 0 &&
    (await page.getByRole('link', { name: 'Locked Down Banger by Artist 9 on SoundCloud' }).count()) === 1,
  'an all-rights-reserved SoundCloud track links out instead of loading',
);
check((await page.getByRole('button', { name: 'Load My Own Tune on deck A' }).count()) === 1, 'your own upload can go on a deck');
await page.getByRole('button', { name: 'Load Free Remix Bait on deck B' }).click();
await page.locator('section[aria-label="Deck B"]').getByText('Free Remix Bait').waitFor({ timeout: 15000 });
await page.waitForFunction(() => window.platter.crate.get().tracks.find((t) => t.title === 'Free Remix Bait')?.bpm, null, { timeout: 20000 });
const sc = await page.evaluate(() => {
  const t = window.platter.crate.get().tracks.find((x) => x.title === 'Free Remix Bait');
  return { urn: t.soundcloud, link: t.link, blob: t.blob, bpm: t.bpm };
});
check(
  sc.urn === 'soundcloud:tracks:1' && sc.link === 'https://soundcloud.com/mock/1' && sc.blob === null && Math.round(sc.bpm) === 122,
  `a CC-BY SoundCloud track streams onto deck B, is analysed (${sc.bpm} BPM) and its audio isn't stored`,
);
check(
  await page.getByRole('group', { name: 'Deck B stems' }).getByRole('button', { name: 'Split' }).isDisabled(),
  'no SoundCloud track can be split, CC-BY included',
);
await page.getByRole('searchbox', { name: 'Search SoundCloud' }).fill('acid');
await page.getByRole('searchbox', { name: 'Search SoundCloud' }).press('Enter');
await page.getByText('Searched acid').waitFor({ timeout: 5000 });
check(scCalls.some((c) => c.startsWith('api /tracks?') && c.includes('q=acid')), 'SoundCloud search asks for matching tracks and lists them');

// ── Sound match and Up next: the CLAP model is mocked by a tiny stand-in
// with the same input and output (tests/fixtures/make-fake-clap.py). Only
// your own files are listened to; nothing is uploaded. ──
const clapRequests = [];
const postsDuringSound = [];
await page.route('https://huggingface.co/Xenova/clap-htsat-unfused/**', (route) => {
  const url = route.request().url();
  clapRequests.push(`${route.request().method()} ${url}`);
  if (url.endsWith('/preprocessor_config.json'))
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sampling_rate: 48000, feature_size: 64, fft_window_size: 1024, hop_length: 480, frequency_min: 50, frequency_max: 14000, nb_max_samples: 480000, padding: 'repeatpad' }) });
  return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(new URL('./fixtures/fake-clap.onnx', import.meta.url)) });
});
const watchSoundUploads = (req) => req.method() !== 'GET' && postsDuringSound.push(`${req.method()} ${req.url()}`);
page.on('request', watchSoundUploads);
if ((await page.getByRole('button', { name: 'Browse music', exact: true }).getAttribute('aria-expanded')) === 'true') await page.getByRole('button', { name: 'Close browse music' }).click();
await page.getByRole('tab', { name: 'Crate' }).click(); // the add-files button lives on the Crate tab
await page.getByLabel('Audio files to add to the crate').setInputFiles([
  { name: 'Test Artist - Kick Loop 122.wav', mimeType: 'audio/wav', buffer: kickWav(20, 122) },
  { name: 'Test Artist - Kick Loop 124.wav', mimeType: 'audio/wav', buffer: kickWav(20, 124) },
]);
await page.waitForFunction(() => window.platter.crate.get().tracks.filter((t) => /Kick Loop/.test(t.title) && t.status === 'ready' && t.bpm).length >= 3, null, { timeout: 30000 });
await page.getByRole('tab', { name: 'Up next' }).click();
await page.getByRole('button', { name: 'Listen to my tracks' }).click();
await page.waitForFunction(() => window.platter.sound.store.get().phase === 'done', null, { timeout: 90000 });
const prints = await page.evaluate(() =>
  window.platter.crate.get().tracks.map((t) => ({ title: t.title, own: !t.soundcloud && !t.audius && !t.demo, print: !!window.platter.sound.printOf(t.id) })),
);
check(
  prints.filter((p) => p.own).every((p) => p.print) && prints.filter((p) => !p.own).every((p) => !p.print),
  `sound match listens to every own file and nothing else (${prints.filter((p) => p.print).length} of ${prints.length} tracks)`,
);
check(
  clapRequests.length > 0 && clapRequests.every((r) => r.startsWith('GET ')) && postsDuringSound.length === 0,
  `the sound model is downloaded and nothing is uploaded${postsDuringSound.length ? `: ${postsDuringSound.join(', ')}` : ''}`,
);
page.off('request', watchSoundUploads);
// Kick Loop 122 on deck A, A is the deck to mix out of.
await page.evaluate(async () => {
  const p = window.platter;
  for (const d of p.decks) if (d.store.get().playing) d.togglePlay();
  p.setCrossfader(-1);
  const id = p.crate.get().tracks.find((t) => t.title === 'Kick Loop 122').id;
  await p.loadToDeck(id, 0);
});
const upNext = page.getByRole('region', { name: 'Up next after Kick Loop 122' });
await upNext.waitFor({ timeout: 15000 });
const firstCard = upNext.getByRole('listitem').first();
const firstText = (await firstCard.textContent()) ?? '';
check(/Kick Loop/.test(firstText) && /sound \d+/.test(firstText), `Up next suggests another kick loop first, with its sound score (${firstText.replace(/\s+/g, ' ').slice(0, 90)})`);
check((await upNext.getByText('Kick Loop 122', { exact: true }).count()) === 1, 'the track on the deck isn\'t suggested after itself');
await upNext.getByRole('button', { name: 'Build' }).click();
check((await upNext.getByRole('button', { name: 'Build' }).getAttribute('aria-pressed')) === 'true', 'energy direction can be set to Build');
const loadB = upNext.getByRole('button', { name: /^Load .* on deck B$/ }).first();
const loadName = (await loadB.getAttribute('aria-label')) ?? '';
await loadB.click();
const wanted = loadName.replace(/^Load (.*) on deck B$/, '$1');
await page.locator('section[aria-label="Deck B"]').getByText(wanted, { exact: true }).waitFor({ timeout: 15000 });
check(true, `Load on B puts “${wanted}” on deck B`);

// ── Playlists and play history (last, as it reloads both decks) ──
// The 60-second rule, on a history with its own clock: only time actually
// playing counts, a play is logged once, a new track starts the count again,
// and two hours of silence start a new session.
const rule = await page.evaluate(() => {
  const H = window.platter.history.constructor;
  let t = 1_000_000;
  const h = new H({ now: () => t, persist: false, timers: false });
  const a = { id: 'a', title: 'Alpha', artist: 'One', bpm: 124, key: '8A' };
  const b = { id: 'b', title: 'Beta', artist: 'Two', bpm: 126, key: '9A' };
  const c = { id: 'c', title: 'Gamma', artist: '', bpm: null, key: null };
  const out = {};
  h.update(0, a, true);
  t += 59_000;
  h.tick();
  out.at59 = h.store.get().entries.length;
  h.update(0, a, false); // paused at 59 s
  t += 10 * 60_000; // ten minutes paused
  h.tick();
  out.paused = h.store.get().entries.length;
  h.update(0, a, true);
  t += 999;
  h.tick();
  out.at59_999 = h.store.get().entries.length;
  t += 1;
  h.tick();
  out.at60 = h.store.get().entries.map((e) => `${e.trackId}:${e.deck}:${e.startedAt}`).join();
  t += 120_000;
  h.tick();
  out.once = h.store.get().entries.length;
  // Another track on deck A starts from nothing; deck B counts on its own.
  h.update(0, b, true);
  h.update(1, c, true);
  t += 30_000;
  h.tick();
  out.newTrack = h.store.get().entries.length;
  t += 30_000;
  h.tick();
  out.both = h.store.get().entries.slice(1).map((e) => `${e.trackId}:${e.deck}`).sort().join();
  out.played = [...h.store.get().played].sort().join();
  const first = h.store.get().session;
  // An hour of silence keeps the session; two hours start a new one.
  h.update(0, b, false);
  h.update(1, c, false);
  t += 60 * 60_000;
  h.update(1, a, true);
  t += 60_000;
  h.tick();
  out.sameSession = h.store.get().session === first;
  h.update(1, a, false);
  t += 2 * 60 * 60_000;
  h.update(0, c, true);
  t += 60_000;
  h.tick();
  out.newSession = h.store.get().session !== first;
  out.sessions = h.sessions().map((x) => x.entries.length).join();
  out.playedNow = [...h.store.get().played].join();
  return out;
});
check(rule.at59 === 0 && rule.at59_999 === 0, 'history: a track isn’t logged before 60 seconds of playing');
check(rule.paused === 0, 'history: time paused doesn’t count towards the 60 seconds');
check(rule.at60 === 'a:A:1000000', `history: at 60 seconds of playing it is logged once, with its deck and start (${rule.at60})`);
check(rule.once === 1, 'history: a play is logged only once');
check(rule.newTrack === 1 && rule.both === 'b:A,c:B', `history: a new track starts the count again, and each deck counts on its own (${rule.both})`);
check(rule.played === 'a,b,c', 'history: played this session lists every logged track');
check(rule.sameSession && rule.newSession && rule.sessions === '1,4' && rule.playedNow === 'c', `history: two hours with nothing playing start a new session (${rule.sessions})`);

// Playlists, through the crate and the Playlists tab.
await page.evaluate(() => {
  for (const pl of window.platter.playlists.store.get().lists) window.platter.playlists.remove(pl.id);
  for (const d of window.platter.decks) if (d.store.get().playing) d.togglePlay();
});
await page.getByRole('tab', { name: 'Crate' }).click();
await page.getByRole('button', { name: 'Add Night Bus to a playlist' }).click();
await page.getByLabel('New playlist name').fill('Opening set');
await page.getByRole('dialog', { name: 'Add Night Bus to a playlist' }).getByRole('button', { name: 'Create' }).click();
await page.keyboard.press('Escape');
for (const title of ['Paper Lanterns', 'Kick Loop']) {
  await page.getByRole('button', { name: `Add ${title} to a playlist`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Opening set/ }).click();
  await page.keyboard.press('Escape');
}
const order = () => page.evaluate(() => {
  const p = window.platter;
  const byId = new Map(p.crate.get().tracks.map((t) => [t.id, t.title]));
  return p.playlists.store.get().lists.find((l) => l.name === 'Opening set')?.trackIds.map((id) => byId.get(id)).join(' / ');
});
check((await order()) === 'Night Bus / Paper Lanterns / Kick Loop', 'a playlist is made from a crate row and tracks are added in order');
await page.getByRole('tab', { name: 'Playlists' }).click();
const plTracks = page.getByRole('list', { name: 'Tracks in Opening set' });
await plTracks.waitFor({ timeout: 5000 });
check((await plTracks.getByRole('listitem').count()) === 3, 'the Playlists tab lists the playlist’s tracks');
await page.getByRole('button', { name: 'Move Night Bus down' }).click();
check((await order()) === 'Paper Lanterns / Night Bus / Kick Loop', 'a track moves down its playlist');
await plTracks.getByRole('listitem').nth(2).focus();
await page.keyboard.press('Alt+ArrowUp');
check((await order()) === 'Paper Lanterns / Kick Loop / Night Bus', 'Alt+↑ moves the focused track up');
await plTracks.getByRole('listitem').nth(2).dragTo(plTracks.getByRole('listitem').nth(0), { targetPosition: { x: 40, y: 4 } });
check((await order()) === 'Night Bus / Paper Lanterns / Kick Loop', 'a track can be dragged to a new place');
await page.getByRole('button', { name: 'Take Kick Loop out of Opening set' }).click();
check((await order()) === 'Night Bus / Paper Lanterns', 'a track can be taken out of a playlist');
await page.getByRole('button', { name: 'Rename' }).click();
await page.getByLabel('Playlist name').fill('Peak time');
await page.getByLabel('Playlist name').press('Enter');
check(await page.getByRole('heading', { name: 'Peak time' }).isVisible(), 'a playlist can be renamed');
// Something else on B first, so Paper Lanterns arrives as a fresh load.
await page.evaluate(() => window.platter.loadToDeck(window.platter.crate.get().tracks.find((t) => t.title === 'Night Bus').id, 1));
await page.locator('section[aria-label="Deck B"]').getByText('Night Bus', { exact: true }).waitFor({ timeout: 15000 });
await page.getByRole('button', { name: 'Load Paper Lanterns on deck B' }).click();
await page.locator('section[aria-label="Deck B"]').getByText('Paper Lanterns', { exact: true }).waitFor({ timeout: 15000 });
check(true, 'a track loads onto a deck from a playlist');
const plBackup = await page.evaluate(async () => {
  const p = window.platter;
  const second = p.playlists.create('Second', [p.crate.get().tracks[0].id]);
  p.playlists.moveList(second.id, 0);
  const names = p.playlists.store.get().lists.map((l) => l.name).join();
  const data = JSON.parse(await p.exportBackup().blob.text());
  const saved = data.playlists?.find((l) => l.name === 'Peak time');
  const titles = saved?.tracks.map((id) => data.tracks.find((t) => t.id === id)?.title).join(' / ');
  for (const pl of p.playlists.store.get().lists) p.playlists.remove(pl.id);
  await p.importFile(new File([JSON.stringify(data)], 'b.json'));
  const back = p.playlists.store.get().lists.find((l) => l.name === 'Peak time');
  const byId = new Map(p.crate.get().tracks.map((t) => [t.id, t.title]));
  // A backup from before playlists still imports.
  delete data.playlists;
  await p.importFile(new File([JSON.stringify(data)], 'old.json'));
  p.playlists.remove(p.playlists.store.get().lists.find((l) => l.name === 'Second').id);
  return { names, titles, version: data.version, back: back?.trackIds.map((id) => byId.get(id)).join(' / '), lists: p.playlists.store.get().lists.length, note: p.crate.get().note };
});
check(plBackup.names === 'Second,Peak time', 'playlists can be reordered');
check(plBackup.version === 2 && plBackup.titles === 'Night Bus / Paper Lanterns', 'a backup keeps playlists, in order (still version 2)');
check(plBackup.back === 'Night Bus / Paper Lanterns' && plBackup.lists === 1, `importing a backup brings its playlists back (${plBackup.note})`);

// Play history in the app, with the threshold cut to 1.5 s for the test.
await page.evaluate(() => {
  const p = window.platter;
  // Tracks heard earlier in this test cross the lowered line at once; log
  // them now, then start from an empty history.
  p.history.threshold = 1500;
  p.history.tick();
  p.history.clear();
  if (!p.decks[1].store.get().playing) p.decks[1].togglePlay();
});
await page.waitForFunction(() => window.platter.history.store.get().entries.some((e) => e.title === 'Paper Lanterns' && e.deck === 'B'), null, { timeout: 10000 });
check(true, 'a track playing on a deck past the threshold joins the history');
check((await page.locator('[aria-label="Tracks in Peak time"] li[data-played]').count()) === 1, 'the playlist ticks the track played this session');
await page.getByRole('button', { name: /^This session/ }).click();
const played = page.getByRole('list', { name: 'Played tracks' });
check(/Paper Lanterns/.test((await played.textContent()) ?? '') && (await played.locator('[title="Played on deck B"]').count()) === 1, 'the History view shows the track with its deck');
const [tracklist] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export tracklist' }).click()]);
const tracklistTxt = readFileSync(await tracklist.path(), 'utf8');
check(
  /^Platter tracklist/.test(tracklistTxt) && /\n1\. 00:00 {2}.*Paper Lanterns\n/.test(tracklistTxt) && /\.txt$/.test(tracklist.suggestedFilename()),
  `a session exports as a plain-text tracklist (${tracklist.suggestedFilename()})`,
);
await page.getByRole('tab', { name: 'Crate' }).click();
check((await page.locator('tr[data-played]').count()) === 1 && (await page.locator('tr[data-played]').textContent())?.includes('Paper Lanterns'), 'the crate marks the track played this session');
await page.getByRole('tab', { name: 'Playlists' }).click();
await page.getByRole('button', { name: /^This session/ }).click();
const plPanel = page.getByRole('tabpanel', { name: 'Playlists' });
await plPanel.getByRole('button', { name: 'Clear all' }).click();
await plPanel.getByRole('button', { name: 'Clear', exact: true }).click();
check((await page.evaluate(() => window.platter.history.store.get().entries.length)) === 0, 'history can be cleared');
await page.evaluate(() => {
  const p = window.platter;
  p.history.threshold = 60_000;
  if (p.decks[1].store.get().playing) p.decks[1].togglePlay();
});

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
process.exit(failures ? 1 : 0);
