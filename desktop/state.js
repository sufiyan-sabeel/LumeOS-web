/*
 * LumeOS - desktop/state.ts
 * Persistent OS settings (theme engine, backend connection, storage policy).
 */
import { idb, STORE_KV } from '../storage/idb.js';
import { bus } from './events.js';
const DEFAULTS = {
    theme: 'dark',
    accent: '#5b8def',
    serverUrl: '',
    token: '',
    preferServer: true,
    wallpaper: '',
    shell: 'auto',
    reducedMotion: false,
};
export class OsState {
    settings = { ...DEFAULTS };
    loaded = false;
    async load() {
        if (this.loaded)
            return;
        try {
            await idb.open();
            const saved = await idb.get(STORE_KV, 'settings');
            if (saved)
                this.settings = { ...DEFAULTS, ...saved };
        }
        catch {
            /* IndexedDB unavailable: run with defaults */
        }
        this.loaded = true;
    }
    async save() {
        try {
            await idb.put(STORE_KV, this.settings, 'settings');
        }
        catch {
            /* ignore persistence failure */
        }
    }
    applyTheme() {
        const root = document.documentElement;
        root.setAttribute('data-theme', this.settings.theme);
        root.style.setProperty('--lume-accent', this.settings.accent);
        root.style.setProperty('--lume-accent-hi', lighten(this.settings.accent, 0.14));
        root.style.setProperty('--lume-accent-dim', hexToRgba(this.settings.accent, 0.14));
        root.style.setProperty('--lume-accent-line', hexToRgba(this.settings.accent, 0.42));
        if (this.settings.wallpaper) {
            root.style.setProperty('--lume-wallpaper', this.settings.wallpaper);
        }
        else {
            root.style.removeProperty('--lume-wallpaper');
        }
        root.setAttribute('data-reduced-motion', String(this.settings.reducedMotion));
        bus.emit('theme:changed', { theme: this.settings.theme });
    }
    setWallpaper(value) {
        this.settings.wallpaper = value;
        document.documentElement.style.setProperty('--lume-wallpaper', value);
        void this.save();
    }
    async update(patch) {
        this.settings = { ...this.settings, ...patch };
        this.applyTheme();
        await this.save();
    }
    async reset() {
        this.settings = { ...DEFAULTS };
        this.applyTheme();
        await this.save();
    }
}
function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexToRgba(hex, alpha) {
    const c = parseHex(hex);
    if (!c)
        return `rgba(91,141,239,${alpha})`;
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
function lighten(hex, amount) {
    const c = parseHex(hex);
    if (!c)
        return hex;
    const mix = (v) => Math.round(v + (255 - v) * amount);
    return `#${[mix(c[0]), mix(c[1]), mix(c[2])]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')}`;
}
export const osState = new OsState();
