/*
 * LumeOS - desktop/state.ts
 * Persistent OS settings (theme engine, backend connection, storage policy).
 */

import { idb, STORE_KV } from '../storage/idb.js';
import { bus } from './events.js';

export interface LumeSettings {
  theme: 'dark' | 'light';
  accent: string;
  serverUrl: string;
  token: string;
  preferServer: boolean;
  wallpaper: string;
}

const DEFAULTS: LumeSettings = {
  theme: 'dark',
  accent: '#6ea8fe',
  serverUrl: '',
  token: '',
  preferServer: true,
  wallpaper: '',
};

export class OsState {
  public settings: LumeSettings = { ...DEFAULTS };
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      await idb.open();
      const saved = await idb.get<LumeSettings>(STORE_KV, 'settings');
      if (saved) this.settings = { ...DEFAULTS, ...saved };
    } catch {
      /* IndexedDB unavailable: run with defaults */
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    try {
      await idb.put(STORE_KV, this.settings, 'settings');
    } catch {
      /* ignore persistence failure */
    }
  }

  applyTheme(): void {
    document.documentElement.setAttribute('data-theme', this.settings.theme);
    document.documentElement.style.setProperty('--lume-accent', this.settings.accent);
    document.documentElement.style.setProperty(
      '--lume-accent-soft',
      hexToRgba(this.settings.accent, 0.16)
    );
    if (this.settings.wallpaper) {
      document.documentElement.style.setProperty('--lume-wallpaper', this.settings.wallpaper);
    }
    bus.emit('theme:changed', { theme: this.settings.theme });
  }

  async update(patch: Partial<LumeSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    this.applyTheme();
    await this.save();
  }

  async reset(): Promise<void> {
    this.settings = { ...DEFAULTS };
    this.applyTheme();
    await this.save();
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(110,168,254,${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export const osState = new OsState();
