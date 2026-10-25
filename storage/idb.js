/*
 * LumeOS - storage/idb.ts
 * Promise-based IndexedDB wrapper. Stores the OS registry, installed app
 * manifests, user settings and arbitrary metadata.
 */
const DB_NAME = 'lumeos';
const DB_VERSION = 1;
export const STORE_REGISTRY = 'registry';
export const STORE_KV = 'kv';
export class Idb {
    db = null;
    async open() {
        if (this.db)
            return;
        this.db = await new Promise((resolve, reject) => {
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
    tx(store, mode) {
        if (!this.db)
            throw new Error('Idb not open');
        return this.db.transaction(store, mode).objectStore(store);
    }
    wrap(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async put(store, value, key) {
        await this.wrap(this.tx(store, 'readwrite').put(value, key));
    }
    async get(store, key) {
        return this.wrap(this.tx(store, 'readonly').get(key));
    }
    async getAll(store) {
        return this.wrap(this.tx(store, 'readonly').getAll());
    }
    async delete(store, key) {
        await this.wrap(this.tx(store, 'readwrite').delete(key));
    }
    async clear(store) {
        await this.wrap(this.tx(store, 'readwrite').clear());
    }
    /* ---- convenience for settings ---- */
    async getSetting(key, fallback) {
        const v = await this.get(STORE_KV, key);
        return v === undefined ? fallback : v;
    }
    async setSetting(key, value) {
        await this.put(STORE_KV, value, key);
    }
}
export const idb = new Idb();
