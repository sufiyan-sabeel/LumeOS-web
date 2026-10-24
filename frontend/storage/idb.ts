/*
 * LumeOS - storage/idb.ts
 * Promise-based IndexedDB wrapper. Stores the OS registry, installed app
 * manifests, user settings and arbitrary metadata.
 */

export interface InstalledApp {
  id: string;
  name: string;
  glyph: string;
  type: 'web' | 'ai-model' | 'native';
  version: string;
  entry?: string;
  installedAt: number;
  sizeBytes?: number;
}

const DB_NAME = 'lumeos';
const DB_VERSION = 1;
export const STORE_REGISTRY = 'registry';
export const STORE_KV = 'kv';

export class Idb {
  private db: IDBDatabase | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_REGISTRY)) {
          db.createObjectStore(STORE_REGISTRY, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_KV)) {
          db.createObjectStore(STORE_KV);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private tx(store: string, mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) throw new Error('Idb not open');
    return this.db.transaction(store, mode).objectStore(store);
  }

  private wrap<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put<T>(store: string, value: T, key?: IDBValidKey): Promise<void> {
    await this.wrap(this.tx(store, 'readwrite').put(value as unknown, key));
  }

  async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    return this.wrap<T | undefined>(this.tx(store, 'readonly').get(key) as IDBRequest<T | undefined>);
  }

  async getAll<T>(store: string): Promise<T[]> {
    return this.wrap<T[]>(this.tx(store, 'readonly').getAll() as IDBRequest<T[]>);
  }

  async delete(store: string, key: IDBValidKey): Promise<void> {
    await this.wrap(this.tx(store, 'readwrite').delete(key));
  }

  async clear(store: string): Promise<void> {
    await this.wrap(this.tx(store, 'readwrite').clear());
  }

  /* ---- convenience for settings ---- */
  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const v = await this.get<T>(STORE_KV, key);
    return v === undefined ? fallback : v;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.put(STORE_KV, value, key);
  }
}

export const idb = new Idb();
