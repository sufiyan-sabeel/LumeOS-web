/*
 * LumeOS - storage/local-fs.ts
 * Browser-local file storage with two interchangeable back ends.
 *
 *   OPFS  - Origin Private File System. Preferred: real files, large binary
 *           capacity, streamed writes.
 *   IDB   - an IndexedDB key/value file store. Used automatically when OPFS
 *           is missing or refuses an operation, so that reading, writing and
 *           listing keep working on browsers without OPFS (older Android
 *           WebViews, some private-browsing modes, iOS restrictions).
 *
 * Both expose the same surface, so the VFS and applications never need to
 * know which one is in play. `usingOpfs()` reports the active tier.
 */
const DB_NAME = 'lumeos-fs';
const DB_VERSION = 1;
const STORE = 'vfs';
export class IdbFs {
    db = null;
    async open() {
        if (this.db)
            return;
        this.db = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'path' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    store(mode) {
        if (!this.db)
            throw new Error('IdbFs not open');
        return this.db.transaction(STORE, mode).objectStore(STORE);
    }
    wrap(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    norm(path) {
        const p = '/' + path.split('/').filter(Boolean).join('/');
        return p === '/' ? '/' : p.replace(/\/+$/, '');
    }
    split(path) {
        const p = this.norm(path);
        const i = p.lastIndexOf('/');
        return { dir: i <= 0 ? '/' : p.slice(0, i), name: p.slice(i + 1) };
    }
    async write(path, blob) {
        await this.open();
        const { dir, name } = this.split(path);
        if (!name)
            throw new Error('invalid path');
        /* Materialise parent directories so listings behave like a real FS. */
        const parts = this.norm(path).split('/').filter(Boolean);
        let cur = '';
        for (let i = 0; i < parts.length - 1; i++) {
            cur += '/' + parts[i];
            await this.put({ path: cur, dir: this.split(cur).dir, name: parts[i], isDir: true, blob: new Blob([]) });
        }
        await this.put({ path: this.norm(path), dir, name, isDir: false, blob });
    }
    async put(rec) {
        await this.wrap(this.store('readwrite').put(rec));
    }
    async readBlob(path) {
        await this.open();
        const rec = await this.wrap(this.store('readonly').get(this.norm(path)));
        if (!rec || rec.isDir)
            throw new Error(`not found: ${path}`);
        return rec.blob;
    }
    async readText(path) {
        return (await this.readBlob(path)).text();
    }
    async exists(path) {
        await this.open();
        const rec = await this.wrap(this.store('readonly').get(this.norm(path)));
        return !!rec;
    }
    async mkdir(path) {
        await this.open();
        const parts = this.norm(path).split('/').filter(Boolean);
        let cur = '';
        for (const part of parts) {
            cur += '/' + part;
            if (!(await this.exists(cur))) {
                await this.put({ path: cur, dir: this.split(cur).dir, name: part, isDir: true, blob: new Blob([]) });
            }
        }
    }
    async list(path) {
        await this.open();
        const dir = this.norm(path);
        const all = await this.wrap(this.store('readonly').getAll());
        return all
            .filter((r) => r.dir === dir && r.path !== dir)
            .map((r) => ({
            name: r.name,
            type: r.isDir ? 'dir' : 'file',
            size: r.isDir ? 0 : r.blob.size,
        }))
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    }
    async remove(path) {
        await this.open();
        const target = this.norm(path);
        const all = await this.wrap(this.store('readonly').getAll());
        const doomed = all
            .filter((r) => r.path === target || r.path.startsWith(target + '/'))
            .map((r) => r.path);
        const store = this.store('readwrite');
        for (const p of doomed)
            await this.wrap(store.delete(p));
    }
}
/* ===================================================================== */
/* Unified local file system                                              */
/* ===================================================================== */
export class LocalFs {
    root = null;
    opfsUsable = false;
    idb = new IdbFs();
    idbUsable = false;
    probed = false;
    /** Which tier is actually in use: 'opfs', 'idb' or 'none'. */
    usingOpfs() {
        return this.opfsUsable;
    }
    tier() {
        if (this.opfsUsable)
            return 'opfs';
        if (this.idbUsable)
            return 'idb';
        return 'none';
    }
    async available() {
        if (this.probed)
            return this.opfsUsable || this.idbUsable;
        this.probed = true;
        try {
            const storage = navigator.storage;
            if (typeof storage?.getDirectory === 'function') {
                this.root = (await storage.getDirectory());
                this.opfsUsable = true;
            }
        }
        catch {
            this.opfsUsable = false;
        }
        if (!this.opfsUsable) {
            try {
                await this.idb.open();
                this.idbUsable = true;
            }
            catch {
                this.idbUsable = false;
            }
        }
        return this.opfsUsable || this.idbUsable;
    }
    /**
     * Decide whether an error means "OPFS itself is unusable" (demote to the
     * IndexedDB tier) or is just a normal operation outcome.
     *
     * A missing directory or file raises NotFoundError, and a path mismatch
     * raises TypeMismatchError. Those are ordinary results — treating them as an
     * OPFS failure would silently move every later write to IndexedDB. Only
     * errors that indicate the API itself is unavailable trigger a demotion.
     */
    shouldDemote(err) {
        const name = err?.name ?? '';
        return (name === 'SecurityError' ||
            name === 'NotSupportedError' ||
            name === 'InvalidStateError');
    }
    /** Drop to the IndexedDB tier after a genuine OPFS failure. */
    demote(err) {
        console.warn('[LumeOS] OPFS unavailable, falling back to IndexedDB storage', err);
        this.opfsUsable = false;
        this.root = null;
        this.idbUsable = true;
    }
    segments(path) {
        return path.split('/').filter((s) => s.length > 0);
    }
    async getRoot() {
        if (this.root)
            return this.root;
        const storage = navigator.storage;
        this.root = (await storage.getDirectory());
        return this.root;
    }
    async resolveDir(path, create) {
        let dir = await this.getRoot();
        for (const seg of this.segments(path)) {
            dir = (await dir.getDirectoryHandle(seg, { create }));
        }
        return dir;
    }
    async withFallback(op, idbOp) {
        if (this.opfsUsable) {
            try {
                return await op();
            }
            catch (err) {
                if (!this.shouldDemote(err))
                    throw err;
                this.demote(err);
            }
        }
        if (!this.idbUsable) {
            try {
                await this.idb.open();
                this.idbUsable = true;
            }
            catch (err) {
                throw new Error(`no local storage available: ${err.message}`);
            }
        }
        return idbOp();
    }
    async writeText(path, content) {
        await this.withFallback(async () => {
            const parts = this.segments(path);
            const name = parts.pop();
            if (!name)
                throw new Error('invalid path');
            const dir = await this.resolveDir('/' + parts.join('/'), true);
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(content);
            await w.close();
        }, () => this.idb.write(path, new Blob([content], { type: 'text/plain' })));
    }
    async writeBlob(path, blob) {
        await this.withFallback(async () => {
            const parts = this.segments(path);
            const name = parts.pop();
            if (!name)
                throw new Error('invalid path');
            const dir = await this.resolveDir('/' + parts.join('/'), true);
            const fh = await dir.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(blob);
            await w.close();
        }, () => this.idb.write(path, blob));
    }
    async readText(path) {
        return this.withFallback(async () => {
            const parts = this.segments(path);
            const name = parts.pop();
            if (!name)
                throw new Error('invalid path');
            const dir = await this.resolveDir('/' + parts.join('/'), false);
            const fh = await dir.getFileHandle(name);
            return (await fh.getFile()).text();
        }, () => this.idb.readText(path));
    }
    async readBlob(path) {
        return this.withFallback(async () => {
            const parts = this.segments(path);
            const name = parts.pop();
            if (!name)
                throw new Error('invalid path');
            const dir = await this.resolveDir('/' + parts.join('/'), false);
            const fh = await dir.getFileHandle(name);
            return fh.getFile();
        }, () => this.idb.readBlob(path));
    }
    async list(path) {
        return this.withFallback(async () => {
            const dir = await this.resolveDir(path, false);
            const out = [];
            for await (const [name, handle] of dir.entries()) {
                if (handle.kind === 'file') {
                    const f = await handle.getFile();
                    out.push({ name, type: 'file', size: f.size });
                }
                else {
                    out.push({ name, type: 'dir', size: 0 });
                }
            }
            out.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
            return out;
        }, () => this.idb.list(path));
    }
    async mkdir(path) {
        await this.withFallback(async () => {
            await this.resolveDir(path, true);
        }, () => this.idb.mkdir(path));
    }
    async remove(path) {
        await this.withFallback(async () => {
            const parts = this.segments(path);
            const name = parts.pop();
            if (!name)
                throw new Error('invalid path');
            const dir = await this.resolveDir('/' + parts.join('/'), false);
            await dir.removeEntry(name, { recursive: true });
        }, () => this.idb.remove(path));
    }
    async exists(path) {
        try {
            return await this.withFallback(async () => {
                const parts = this.segments(path);
                const name = parts.pop();
                if (!name)
                    return false;
                const dir = await this.resolveDir('/' + parts.join('/'), false);
                await dir.getFileHandle(name);
                return true;
            }, () => this.idb.exists(path));
        }
        catch {
            return false;
        }
    }
    async usage() {
        if (navigator.storage?.estimate) {
            try {
                const est = await navigator.storage.estimate();
                return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
            }
            catch {
                /* fall through */
            }
        }
        return { usage: 0, quota: 0 };
    }
}
export const localFs = new LocalFs();
