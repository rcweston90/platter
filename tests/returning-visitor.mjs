/**
 * A returning visitor gets the new build's worklets, not the copy the service
 * worker cached on an earlier visit. Visits an older build (playing a deck, so
 * the worklet is fetched and cached), then the new build on the same origin,
 * splits deck B with the stand-in model and checks that muting every part
 * silences it.
 *
 *   git worktree add /tmp/platter-old <older commit> && (cd /tmp/platter-old && npm ci && npm run build)
 *   npm run build
 *   node tests/returning-visitor.mjs /tmp/platter-old/dist dist
 *
 * Serves both builds itself on http://localhost:4180/ and switches on the
 * service worker there (the app registers it on https only).
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const [oldDist, newDist] = process.argv.slice(2);
if (!oldDist || !newDist) throw new Error('usage: node tests/returning-visitor.mjs <older dist> <new dist>');
const root = mkdtempSync(join(tmpdir(), 'platter-serve-'));
const serve = (dist) => {
  rmSync(root, { recursive: true, force: true });
  cpSync(dist, root, { recursive: true });
  for (const f of readdirSync(join(root, 'assets')))
    if (f.endsWith('.js')) {
      const p = join(root, 'assets', f);
      writeFileSync(p, readFileSync(p, 'utf8').replaceAll('location.protocol==="https:"', 'true'));
    }
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.endsWith('/') ? path + 'index.html' : path;
  try {
    const body = readFileSync(join(root, file));
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(4180);
const URL_ = 'http://localhost:4180/';

const profile = mkdtempSync(join(tmpdir(), 'platter-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  args: ['--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1440, height: 900 },
  ...(process.env.PLATTER_CHROME ? { executablePath: process.env.PLATTER_CHROME } : {}),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const open = async () => {
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.locator('section[aria-label="Deck B"]').getByText('Paper Lanterns').waitFor({ timeout: 15000 });
};

serve(oldDist);
await open();
await open(); // now the service worker controls the page
await page.getByRole('button', { name: 'Deck A play' }).click();
await page.waitForTimeout(2500); // the engine starts and its worklet is cached

serve(newDist);
await open();
await page.route('https://huggingface.co/**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(new URL('./fixtures/fake-demucs.onnx', import.meta.url)) }),
);
await page.getByRole('button', { name: 'Deck B play' }).click();
await page.waitForFunction(() => window.platter.decks[1].store.get().playing, null, { timeout: 15000 });
const stems = page.getByRole('group', { name: 'Deck B stems' });
await stems.getByRole('button', { name: 'Split' }).click();
await stems.getByRole('button', { name: 'Vocals' }).waitFor({ timeout: 60000 });
const level = async () => {
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(100);
    peak = Math.max(peak, 100 - (await page.$eval('[aria-label="Channel B level meter"] [class*="meterCover"]', (e) => {
        // Newer builds move the meter by transform, older ones by height.
        const m = /scaleY\(([^)]+)\)/.exec(e.style.transform);
        return m ? parseFloat(m[1]) * 100 : parseFloat(e.style.height || '100');
      })));
  }
  return peak;
};
const all = await level();
for (const part of ['Vocals', 'Drums', 'Bass', 'Other']) await stems.getByRole('button', { name: part }).click();
await page.waitForTimeout(800);
const none = await level();
const ok = all > 20 && none < 3;
console.log(`${ok ? 'ok  ' : 'FAIL'} after an older visit, muting every part silences deck B (level ${all.toFixed(0)}% → ${none.toFixed(0)}%)`);
await ctx.close();
server.close();
rmSync(root, { recursive: true, force: true });
rmSync(profile, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
