/**
 * Writes Signalsmith Stretch's AudioWorklet module to public/worklets/stretch.js.
 *
 * The library builds its worklet at runtime as a blob: URL. Some hosts (the
 * claude.ai artifact viewer, strict CSPs) only let worklets load from the
 * page's own files, so we capture the exact module source it would have
 * blobbed and ship it as a file; src/engine/deck.ts points the library at it
 * through its documented `moduleUrl` hook. Runs before dev and build.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/worklets/stretch.js');

let captured = null;
globalThis.AudioWorkletNode = class {
  constructor() {
    throw new Error('not registered yet');
  }
};
const realCreate = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  captured = blob;
  return 'blob:captured';
};

const { default: SignalsmithStretch } = await import('signalsmith-stretch');
const fakeContext = { audioWorklet: { addModule: () => new Promise(() => {}) } };
void SignalsmithStretch(fakeContext);
// The library awaits nothing before building the module, but give it a tick.
await new Promise((r) => setTimeout(r, 0));
URL.createObjectURL = realCreate;

if (!captured) {
  console.error('extract-stretch-worklet: the library did not build a worklet module — has its API changed?');
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `// Generated from signalsmith-stretch (MIT, Geraint Luff / Signalsmith Audio Ltd.) by scripts/extract-stretch-worklet.mjs.\n${await captured.text()}\n`);
console.log(`extract-stretch-worklet: wrote ${out} (${Math.round((await captured.text()).length / 1024)} KB)`);
