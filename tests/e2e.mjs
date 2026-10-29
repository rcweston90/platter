/**
 * End-to-end check in Chromium: the rig opens cued up, plays, syncs,
 * scratches, key-locks, imports a file, and records a mix.
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
await A.getByRole('button', { name: 'Key' }).click();
await A.getByRole('slider', { name: 'Deck A pitch' }).focus();
await page.keyboard.press('End');
await page.waitForTimeout(1200);
const chMeter = await page.$eval('[aria-label="Channel A level meter"] [class*="meterCover"]', (e) => parseFloat(e.style.height));
check(chMeter < 95, `key-locked deck A still sounds at +8% (${chMeter.toFixed(0)}% covered)`);

// Import a file: tags fall back to "Artist - Title", tempo is detected.
await page.locator('input[type=file]').setInputFiles({ name: 'Test Artist - Kick Loop.wav', mimeType: 'audio/wav', buffer: kickWav() });
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

check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
await browser.close();
process.exit(failures ? 1 : 0);
