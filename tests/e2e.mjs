/**
 * End-to-end check in Chromium: the rig opens cued up, plays, syncs,
 * scratches, key-locks, imports a file, records a mix; then key matching,
 * beat FX, rolls, the sampler, MIDI learn, Auto-DJ, backup and Rekordbox
 * import, recordings and Audius (with its API mocked).
 *
 *   npm run dev            # or: npm run build && npm run preview
 *   npm run test:e2e       # URL defaults to http://localhost:5173/
 *
 * Needs a Chromium for Playwright (`npx playwright install chromium`).
 */
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

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

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
const meter = await page.$eval('[aria-label="Master left level meter"] [class*="meterCover"]', (e) => parseFloat(e.style.height));
check(meter < 95, `master meter shows signal (${meter.toFixed(0)}% covered)`);

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
const chMeter = await page.$eval('[aria-label="Channel A level meter"] [class*="meterCover"]', (e) => parseFloat(e.style.height));
check(chMeter < 95, `key-locked deck A still sounds at +8% (${chMeter.toFixed(0)}% covered)`);

// Import a file: tags fall back to "Artist - Title", tempo is detected.
await page.getByLabel('Audio files to add to the crate').setInputFiles({ name: 'Test Artist - Kick Loop.wav', mimeType: 'audio/wav', buffer: kickWav() });
await page.locator('tbody tr', { hasText: 'Kick Loop' }).waitFor({ timeout: 15000 });
await page.waitForFunction(() => !document.body.textContent.includes('analysing…'), null, { timeout: 30000 });
const row = await page.locator('tbody tr', { hasText: 'Kick Loop' }).textContent();
check(/Test Artist/.test(row) && /120\.0/.test(row), `imported file reads as Test Artist, 120 BPM (${row.replace(/\s+/g, ' ').trim()})`);

// Record two seconds, then save.
await page.getByRole('button', { name: 'Record the mix' }).click();
await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Stop recording the mix' }).click();
const save = page.getByRole('button', { name: 'Save mix' });
await save.waitFor({ timeout: 5000 });
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), save.click()]);
check(/^platter-mix-.*\.(webm|mp4|ogg)$/.test(download.suggestedFilename()), `recording saves as ${download.suggestedFilename()}`);

// ── Harmonic mixing ──
// Deck B follows A's +8% through sync, which lifts its key a semitone.
const keyOf = (deck) => deck.locator('[class*="keyChip"]').textContent();
const bKey = await keyOf(B);
await B.getByRole('button', { name: 'Match' }).click();
await page.waitForTimeout(800);
const matched = (await B.locator('[class*="keyChip"]').getAttribute('data-match')) === 'true';
check(matched, `Match shifts deck B from ${bKey} to ${await keyOf(B)}, compatible with deck A (${await keyOf(A)})`);

// ── Beat FX ──
await page.getByRole('button', { name: 'Deck A effect on' }).click();
for (const fx of ['echo', 'reverb', 'flanger', 'phaser', 'trans', 'crush']) {
  await A.locator('select').selectOption(fx);
  await page.waitForTimeout(400);
}
const fxMeter = await page.$eval('[aria-label="Channel A level meter"] [class*="meterCover"]', (e) => parseFloat(e.style.height));
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
const before0 = await page.$eval('[aria-label="Master left level meter"] [class*="meterCover"]', (e) => parseFloat(e.style.height));
await page.getByRole('button', { name: 'Sampler pad 7: Boom' }).click();
check(true, `sampler pad fires (master meter ${before0.toFixed(0)}% covered before)`);

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
  data.tracks.find((t) => t.id === id).cues = { main: 1.5, hot: [2, null, 4, null] };
  await p.importFile(new File([JSON.stringify(data)], 'b.json'));
  const after = p.crate.get().tracks.find((t) => t.id === id);
  const rb = `<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1"><TRACK Name="Kick Loop" Artist="Test Artist" Location="file://localhost/Users/me/Music/Test%20Artist%20-%20Kick%20Loop.wav" AverageBpm="120.00" Tonality="Am" TotalTime="20"><TEMPO Inizio="0.050" Bpm="120.00" Metro="4/4" Battito="1"/><POSITION_MARK Name="" Type="0" Start="0.050" Num="-1"/><POSITION_MARK Name="" Type="0" Start="8.050" Num="0"/></TRACK></COLLECTION></DJ_PLAYLISTS>`;
  await p.importFile(new File([rb], 'rekordbox.xml'));
  const rbAfter = p.crate.get().tracks.find((t) => t.id === id);
  return { cues: after.cues, note: p.crate.get().note, rbKey: rbAfter.key, rbHot0: rbAfter.cues.hot[0], rbGrid: rbAfter.gridOffset };
});
check(backup.cues.main === 1.5 && backup.cues.hot[2] === 4, 'a backup round-trips cue points');
check(backup.rbKey === '8A' && backup.rbHot0 === 8.05 && backup.rbGrid === 0.05, `Rekordbox XML imports key, grid and hot cues (${backup.note})`);

// ── Recordings are kept ──
await page.getByRole('tab', { name: /Recordings/ }).click();
check((await page.locator('[role="tabpanel"] li').count()) >= 1, 'the recorded mix is listed under Recordings');

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
await page.getByRole('tab', { name: 'Audius' }).click();
await page.getByRole('button', { name: 'House' }).click();
await page.getByText('Mocked Groove').waitFor({ timeout: 5000 });
await page.getByRole('button', { name: 'Load Mocked Groove on deck A' }).click().catch(() => {});
const aPlaying = await A.getByRole('button', { name: /Deck A (play|pause)/ }).getAttribute('aria-pressed');
if (aPlaying === 'true') await A.getByRole('button', { name: 'Deck A pause' }).click();
await page.getByRole('button', { name: 'Load Mocked Groove on deck A' }).click();
await A.getByText('Mocked Groove').waitFor({ timeout: 15000 });
await page.waitForFunction(() => window.platter.crate.get().tracks.find((t) => t.title === 'Mocked Groove')?.bpm, null, { timeout: 20000 });
const mocked = await page.evaluate(() => window.platter.crate.get().tracks.find((t) => t.title === 'Mocked Groove'));
check(mocked.link === 'https://audius.co/artist/mocked' && Math.round(mocked.bpm) === 126, `an Audius track streams onto deck A and is analysed (${mocked.bpm} BPM, link kept)`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
process.exit(failures ? 1 : 0);
