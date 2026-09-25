// Mini key-value store sur IndexedDB : la bibliothèque et les enrichissements
// peuvent peser plusieurs Mo, trop pour localStorage.
const DB_NAME = 'sillon';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const kvGet = <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => run<void>('readwrite', (s) => s.put(value, key));
export const kvDel = (key: string) => run<void>('readwrite', (s) => s.delete(key));
export const kvClear = () => run<void>('readwrite', (s) => s.clear());
