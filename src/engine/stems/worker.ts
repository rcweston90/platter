/// <reference lib="webworker" />
/**
 * The stems worker: ONNX Runtime Web and the HTDemucs model, off the main
 * thread so the decks never stutter while a track is split. One job at a
 * time (the GPU is shared, and two runs in flight only slow both down).
 *
 * The model is fetched once from Hugging Face and kept in the browser's
 * Cache Storage, so later splits start at once. That is the model file only:
 * track audio arrives here as PCM, leaves as PCM, and is never written down.
 */
import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { Cancelled, MODEL_FAILED, MODEL_OFFLINE, separate, type Runner, type StemPcm } from './separate';

export const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const MODEL_CACHE = 'platter-models-v1';

export type ToWorker =
  | { type: 'separate'; id: number; left: Float32Array; right: Float32Array }
  | { type: 'cancel'; id: number };

export type FromWorker =
  | { type: 'progress'; id: number; phase: 'download' | 'prepare' | 'separate'; progress: number; backend?: Backend }
  | { type: 'done'; id: number; stems: StemPcm[]; seconds: number; backend: Backend }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string };

export type Backend = 'webgpu' | 'wasm';

declare const self: DedicatedWorkerGlobalScope;

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// Threads need cross-origin isolation (SharedArrayBuffer); without it, one.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);
const cancelled = new Set<number>();
let session: Promise<{ runner: Runner; backend: Backend }> | null = null;
let queue: Promise<void> = Promise.resolve();

async function modelBytes(id: number): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(MODEL_URL);
    if (hit) return hit.arrayBuffer();
  } catch {
    cache = null; // no Cache Storage (private window): download every session
  }
  let res: Response;
  try {
    res = await fetch(MODEL_URL);
  } catch {
    throw new Error(MODEL_OFFLINE);
  }
  if (!res.ok || !res.body) throw new Error(`${MODEL_FAILED} (${res.status}).`);
  const size = Number(res.headers.get('Content-Length')) || 172_000_000;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (got - last > 2_000_000) {
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
    await cache?.put(MODEL_URL, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  } catch {
    // Out of quota: fine, it downloads again next time.
  }
  return bytes.buffer;
}

async function hasWebGpu() {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

function openSession(id: number) {
  if (!session) {
    session = (async () => {
      const bytes = await modelBytes(id);
      post({ type: 'progress', id, phase: 'prepare', progress: 0 });
      const opts = { graphOptimizationLevel: 'basic' as const, enableCpuMemArena: false };
      if (await hasWebGpu()) {
        try {
          const s = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['webgpu', 'wasm'] });
          return { runner: s, backend: 'webgpu' as Backend };
        } catch {
          // Some GPUs or drivers refuse the graph: fall back to the CPU.
        }
      }
      const s = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['wasm'] });
      return { runner: s, backend: 'wasm' as Backend };
    })();
    session.catch(() => (session = null));
  }
  return session;
}

async function job(id: number, left: Float32Array, right: Float32Array) {
  try {
    if (cancelled.has(id)) throw new Cancelled();
    const { runner, backend } = await openSession(id);
    post({ type: 'progress', id, phase: 'separate', progress: 0, backend });
    const t0 = performance.now();
    const stems = await separate(runner, (data, dims) => new ort.Tensor('float32', data, dims), left, right, {
      cancelled: () => cancelled.has(id),
      onProgress: (done, total) => post({ type: 'progress', id, phase: 'separate', progress: done / total, backend }),
    });
    const seconds = (performance.now() - t0) / 1000;
    post(
      { type: 'done', id, stems, seconds, backend },
      stems.flatMap((s) => [s.left.buffer, s.right.buffer]),
    );
  } catch (err) {
    if (err instanceof Cancelled) post({ type: 'cancelled', id });
    else post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    cancelled.delete(id);
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'cancel') cancelled.add(m.id);
  else if (m.type === 'separate') queue = queue.then(() => job(m.id, m.left, m.right));
};
