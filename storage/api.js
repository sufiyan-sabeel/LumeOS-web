/*
 * LumeOS - storage/api.ts
 * Typed client for the LumeOS C backend REST API.
 */
import { appUrl } from '../desktop/base.js';
export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'ApiError';
    }
}
export class ApiClient {
    /** Empty base == same origin (served by the C backend). */
    base = '';
    /** Session token for write endpoints (empty == auth disabled). */
    token = '';
    online = false;
    url(path) {
        return `${this.baseUrl()}${path}`;
    }
    /** The resolved base actually used for API calls, without a trailing slash. */
    baseUrl() {
        return this.base.replace(/\/+$/, '');
    }
    /** Absolute-or-root-relative URL of the health endpoint, for diagnostics. */
    healthUrl() {
        return this.url('/api/health');
    }
    headers(extra) {
        const h = { Accept: 'application/json' };
        if (this.token)
            h['X-Lume-Token'] = this.token;
        if (extra)
            Object.assign(h, extra);
        return h;
    }
    async request(path, init) {
        let res;
        try {
            res = await fetch(this.url(path), init);
        }
        catch (err) {
            this.online = false;
            throw new ApiError(0, `network error: ${err.message}`);
        }
        this.online = true;
        const text = await res.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            }
            catch {
                data = { raw: text };
            }
        }
        if (!res.ok) {
            const msg = data.message ?? `HTTP ${res.status}`;
            throw new ApiError(res.status, msg);
        }
        return data;
    }
    async health() {
        try {
            const r = await this.request('/api/health', {
                headers: this.headers(),
            });
            this.online = r.status === 'ok';
            return this.online;
        }
        catch {
            this.online = false;
            return false;
        }
    }
    systemInfo() {
        return this.request('/api/system/info', { headers: this.headers() });
    }
    async listPackages() {
        const r = await this.request('/api/packages', {
            headers: this.headers(),
        });
        return r.packages ?? [];
    }
    listFiles(path) {
        return this.request(`/api/files/list?path=${encodeURIComponent(path)}`, { headers: this.headers() });
    }
    readFile(path) {
        return this.request(`/api/files/read?path=${encodeURIComponent(path)}`, { headers: this.headers() });
    }
    writeFile(path, content) {
        return this.request('/api/files/write', {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ path, content }),
        });
    }
    mkdir(path) {
        return this.request('/api/files/mkdir', {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ path }),
        });
    }
    deletePath(path) {
        return this.request(`/api/files/delete?path=${encodeURIComponent(path)}`, { method: 'DELETE', headers: this.headers() });
    }
    execNative(binary) {
        return this.request('/api/system/exec-native', {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ binary }),
        });
    }
    sourceExportUrl() {
        /* With no C backend (e.g. the static GitHub Pages build) fall back to the
         * source archive shipped alongside the app. */
        if (!this.online)
            return appUrl('lumeos-source.tar.gz');
        return this.url('/api/export/project');
    }
}
