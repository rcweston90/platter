import type { TrackRecord } from './types';

/**
 * Everything Platter keeps lives in this browser, in IndexedDB — nothing is
 * uploaded:
 *   tracks      the crate: files (or references), analysis, cue points
 *   samples     sounds you've put on sampler pads
 *   recordings  mixes you've recorded
 *   kv          small things: settings, MIDI mappings, the last session
 * Every call degrades to "no persistence" if storage is blocked (private
 * windows, disabled site data): the session still works, it just forgets.
 */

const DB_NAME = 'platter';
const VERSION = 2;
type StoreName = 'tracks' | 'samples' | 'recordings' | 'kv';
const STORES: StoreName[] = ['tracks', 'samples', 'recordings', 'kv'];

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
          for (const name of STORES) {
            if (!req.result.objectStoreNames.contains(name)) {
              req.result.createObjectStore(name, name === 'kv' ? undefined : { keyPath: 'id' });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

/* ── Tracks ─────────────────────────────────────────────────────────────── */

export async function loadCrate(): Promise<TrackRecord[]> {
  const all = (await run<TrackRecord[]>('tracks', 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export function saveTrack(rec: TrackRecord) {
  return run('tracks', 'readwrite', (s) => s.put(rec));
}

export function removeTrack(id: string) {
  return run('tracks', 'readwrite', (s) => s.delete(id));
}

/* ── Sampler pads ───────────────────────────────────────────────────────── */

export interface SampleRecord {
  /** Pad index as a string. */
  id: string;
  name: string;
  blob: Blob;
}

export async function loadSamples(): Promise<SampleRecord[]> {
  return (await run<SampleRecord[]>('samples', 'readonly', (s) => s.getAll())) ?? [];
}

export function saveSample(rec: SampleRecord) {
  return run('samples', 'readwrite', (s) => s.put(rec));
}

export function removeSample(id: string) {
  return run('samples', 'readwrite', (s) => s.delete(id));
}

/* ── Recordings ─────────────────────────────────────────────────────────── */

export interface RecordingRecord {
  id: string;
  name: string;
  blob: Blob;
  seconds: number;
  createdAt: number;
}

export async function loadRecordings(): Promise<RecordingRecord[]> {
  const all = (await run<RecordingRecord[]>('recordings', 'readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export function saveRecording(rec: RecordingRecord) {
  return run('recordings', 'readwrite', (s) => s.put(rec));
}

export function removeRecording(id: string) {
  return run('recordings', 'readwrite', (s) => s.delete(id));
}

/* ── Small values ───────────────────────────────────────────────────────── */

export async function getValue<T>(key: string): Promise<T | null> {
  return ((await run<T>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T>)) ?? null) as T | null;
}

export function setValue(key: string, value: unknown) {
  return run('kv', 'readwrite', (s) => s.put(value, key));
}
