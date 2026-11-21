/// <reference lib="webworker" />
/**
 * The sound-match worker: LAION's CLAP audio encoder (Apache-2.0, the
 * 8-bit ONNX export) on ONNX Runtime Web, off the main thread.
 *
 * The model (~34 MB) and its preprocessor settings are fetched once from
 * Hugging Face and kept in the browser's Cache Storage. Track audio arrives
 * here as three 10-second windows of PCM and leaves as three short vectors;
 * none of it is sent anywhere or written down.
 */
// The same build and files as the stems worker, so the browser fetches them once.
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { embedWindows, type Runner, type SoundPrint } from './embed';
import { configFrom, createExtractor, type Extractor } from './features';

const REPO = 'https://huggingface.co/Xenova/clap-htsat-unfused/resolve/main';
export const MODEL_URL = `${REPO}/onnx/audio_model_quantized.onnx`;
export const CONFIG_URL = `${REPO}/preprocessor_config.json`;
const MODEL_CACHE = 'platter-models-v1';

export type ToWorker = { type: 'embed'; id: number; windows: Float32Array[] };

export type FromWorker =
  | { type: 'progress'; id: number; phase: 'download' | 'prepare'; progress: number }
  | { type: 'done'; id: number; print: SoundPrint; seconds: number }
  | { type: 'error'; id: number; message: string };

declare const self: DedicatedWorkerGlobalScope;

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// Threads need cross-origin isolation; without it, one (it's a small model).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);
let ready: Promise<{ runner: Runner; ex: Extractor }> | null = null;
let queue: Promise<void> = Promise.resolve();

async function cached(url: string, id: number, expect: number): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
  } catch {
    cache = null; // no Cache Storage (private window): download every session
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`The sound-match model couldn’t be downloaded (${res.status}).`);
  const size = Number(res.headers.get('Content-Length')) || expect;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (expect > 100_000 && got - last > 1_000_000) {
      last = got;
      post({ type: 'progress', id, phase: 'download', progress: Math.min(1, got / size) });
    }
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  try {
    await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/octet-stream' } }));
  } catch {
    // Out of quota: fine, it downloads again next time.
  }
  return bytes.buffer;
}

function open(id: number) {
  if (!ready) {
    ready = (async () => {
      let config = null;
      try {
        config = JSON.parse(new TextDecoder().decode(await cached(CONFIG_URL, id, 0)));
      } catch {
        // The built-in settings are the same checkpoint's.
      }
      const bytes = await cached(MODEL_URL, id, 34_000_000);
      post({ type: 'progress', id, phase: 'prepare', progress: 0 });
      const runner = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      return { runner, ex: createExtractor(configFrom(config)) };
    })();
    ready.catch(() => (ready = null));
  }
  return ready;
}

async function job(id: number, windows: Float32Array[]) {
  try {
    const { runner, ex } = await open(id);
    const t0 = performance.now();
    const print = await embedWindows(runner, (data, dims) => new ort.Tensor('float32', data, dims), windows, ex);
    post({ type: 'done', id, print, seconds: (performance.now() - t0) / 1000 });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'embed') queue = queue.then(() => job(m.id, m.windows));
};
