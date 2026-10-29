import type { TrackRecord } from './types';

/**
 * The crate, kept in IndexedDB so tracks, their analysis and their cue points
 * survive a reload. Everything stays in this browser — nothing is uploaded.
 * Every call degrades to "no persistence" if storage is blocked (private
 * windows, disabled site data): the session still works, it just forgets.
 */

const DB_NAME = 'platter';
const STORE = 'tracks';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: 'id' });
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

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function loadCrate(): Promise<TrackRecord[]> {
  const all = (await run<TrackRecord[]>('readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => a.addedAt - b.addedAt);
}

export function saveTrack(rec: TrackRecord) {
  return run('readwrite', (s) => s.put(rec));
}

export function removeTrack(id: string) {
  return run('readwrite', (s) => s.delete(id));
}
