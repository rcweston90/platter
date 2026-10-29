import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Relative base: the build runs from any sub-path or static host, and the
// worklets in public/worklets resolve against the page (engine.ts workletUrl).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022' },
});
