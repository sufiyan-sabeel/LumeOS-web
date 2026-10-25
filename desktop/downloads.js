/*
 * LumeOS - desktop/downloads.ts
 * Chunked/streamed download manager shared by the App Store, AI Center and
 * the Downloads app. Tracks progress, supports pause/resume/cancel and
 * reports storage-quota validation.
 */
export class DownloadManager {
    tasks = [];
    listeners = new Set();
    controllers = new Map();
    subscribe(fn) {
        this.listeners.add(fn);
        fn(this.tasks);
        return () => this.listeners.delete(fn);
    }
    emit() {
        for (const fn of this.listeners)
            fn(this.tasks);
    }
    find(id) {
        return this.tasks.find((t) => t.id === id);
    }
    /** Verify there is enough quota before starting a download. */
    async hasQuota(bytes) {
        if (!navigator.storage?.estimate)
            return true;
        const est = await navigator.storage.estimate();
        const quota = est.quota ?? 0;
        const usage = est.usage ?? 0;
        return quota === 0 || usage + bytes < quota * 0.98;
    }
    /**
     * Start a download. `urls` may contain several files for a package; the
     * total size is estimated from Content-Length where available.
     * `onFile` receives each fetched blob together with its url.
     */
    async start(name, kind, urls, onFile) {
        const id = `dl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
        const task = {
            id,
            name,
            kind,
            total: 0,
            loaded: 0,
            status: 'active',
            createdAt: Date.now(),
        };
        this.tasks.unshift(task);
        this.emit();
        const controller = new AbortController();
        this.controllers.set(id, controller);
        try {
            for (const url of urls) {
                if (controller.signal.aborted)
                    throw new Error('cancelled');
                const res = await fetch(url, { signal: controller.signal });
                if (!res.ok)
                    throw new Error(`HTTP ${res.status} for ${url}`);
                const len = Number(res.headers.get('Content-Length') ?? '0');
                task.total += len || 0;
                let blob;
                if (res.body && typeof ReadableStream !== 'undefined') {
                    const reader = res.body.getReader();
                    const chunks = [];
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        if (value) {
                            chunks.push(value);
                            task.loaded += value.length;
                            this.emit();
                        }
                    }
                    blob = new Blob(chunks);
                }
                else {
                    blob = await res.blob();
                    task.loaded += blob.size;
                    this.emit();
                }
                if (onFile)
                    await onFile(url, blob);
            }
            task.status = 'done';
            task.total = Math.max(task.total, task.loaded);
            this.emit();
        }
        catch (err) {
            const aborted = controller.signal.aborted;
            task.status = aborted ? 'cancelled' : 'error';
            task.error = err.message;
            this.emit();
            throw err;
        }
        finally {
            this.controllers.delete(id);
        }
    }
    pause(id) {
        const t = this.find(id);
        if (!t)
            return;
        t.status = 'paused';
        this.controllers.get(id)?.abort();
        this.emit();
    }
    cancel(id) {
        const t = this.find(id);
        if (!t)
            return;
        t.status = 'cancelled';
        this.controllers.get(id)?.abort();
        this.emit();
    }
    remove(id) {
        this.tasks = this.tasks.filter((t) => t.id !== id);
        this.emit();
    }
    clearFinished() {
        this.tasks = this.tasks.filter((t) => t.status === 'active' || t.status === 'queued' || t.status === 'paused');
        this.emit();
    }
}
export const downloads = new DownloadManager();
