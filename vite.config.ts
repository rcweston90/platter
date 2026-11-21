import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The worklets keep fixed names (public/worklets/*.js), so the service worker
// (public/sw.js, cache first) would serve a returning visitor last build's
// copy for ever. Their URLs carry a hash of their contents instead.
const worklets = new URL('./public/worklets/', import.meta.url);
const workletHash = createHash('sha256');
for (const f of readdirSync(worklets).sort()) workletHash.update(f).update(readFileSync(new URL(f, worklets)));

// Relative base: the build runs from any sub-path or static host, and the
// worklets in public/worklets resolve against the page (engine.ts workletUrl).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022' },
  define: { __WORKLETS_VERSION__: JSON.stringify(workletHash.digest('hex').slice(0, 12)) },
  // The stems worker (engine/stems) is an ES module: ONNX Runtime resolves
  // its files against import.meta.url.
  worker: { format: 'es' },
});
