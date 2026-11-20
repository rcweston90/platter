/**
 * Loads the app's TypeScript modules in Node, through Vite (already a dev
 * dependency), so the library scanner and the tests share the exact analysis
 * code the browser runs. Usage:
 *   const { mod, close } = await loadTs('/src/library/analyze.ts');
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function loadTs(...paths) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const mods = [];
  for (const p of paths) mods.push(await server.ssrLoadModule(p));
  return { mods, mod: mods[0], close: () => server.close() };
}
