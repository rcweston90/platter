/**
 * Repackages dist/ as a claude.ai artifact: a page body (the host supplies
 * the doctype, <head> and <body>) plus the assets and worklets beside it.
 *
 *   npm run artifact [-- <out-dir>]      # default: artifact/
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const out = resolve(process.argv[2] ?? resolve(root, 'artifact'));
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');

const pick = (re) => [...html.matchAll(re)].map((m) => m[0]);
const title = pick(/<title>[\s\S]*?<\/title>/g)[0];
const description = pick(/<meta name="description"[^>]*>/g);
const links = pick(/<link\b[^>]*>/g);
const scripts = pick(/<script\b[^>]*><\/script>/g);
if (!title || !scripts.length) throw new Error('artifact: dist/index.html is missing its title or entry script');

const page = [
  title,
  // The rig's outer wrapper pads both sides with max(16px, safe-area inset).
  '<meta name="claude:viewport-fit-sides" content="cover">',
  ...description,
  ...links,
  '<div id="platter"></div>',
  ...scripts,
  '',
].join('\n');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'index.html'), page);
cpSync(resolve(dist, 'assets'), resolve(out, 'assets'), { recursive: true });
cpSync(resolve(dist, 'worklets'), resolve(out, 'worklets'), { recursive: true });
console.log(`artifact: wrote ${out}`);
