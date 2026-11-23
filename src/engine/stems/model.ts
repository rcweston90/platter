/** Where the stems model comes from and where the browser keeps it. */
export const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
export const MODEL_CACHE = 'platter-models-v1';

/** Is the model already in this browser (so a split needs no download)? */
export async function modelCached(): Promise<boolean> {
  try {
    const cache = await caches.open(MODEL_CACHE);
    return !!(await cache.match(MODEL_URL));
  } catch {
    return false;
  }
}
