/*
 * LumeOS - storage/vfs.ts
 * The Virtual File System: a single async API that transparently routes
 * between OPFS (offline, browser-local) and the C backend's data/files/
 * directory (online). If the server is unreachable it degrades to OPFS.
 */

import type { FileEntry, VfsApi } from '../desktop/types.js';
import type { ApiClient } from './api.js';
import type { LocalFs } from './local-fs.js';

export type VfsBackend = 'server' | 'opfs';

export class Vfs implements VfsApi {
  /** When true and the server is online, prefer server-backed storage. */
  public preferServer = true;
  /** Records which backend served the most recent operation. */
  public lastBackend: VfsBackend = 'opfs';

  constructor(private local: LocalFs, private api: ApiClient) {}

  private norm(path: string): string {
    let p = path.trim();
    if (!p.startsWith('/')) p = '/' + p;
    // collapse duplicate slashes
    p = p.replace(/\/{2,}/g, '/');
    return p;
  }

  private serverAvailable(): boolean {
    return this.preferServer && this.api.online;
  }

  async readText(path: string): Promise<string> {
    const p = this.norm(path);
    if (this.serverAvailable()) {
      try {
        const r = await this.api.readFile(p);
        this.lastBackend = 'server';
        return r.content;
      } catch {
        /* fall through to OPFS */
      }
    }
    this.lastBackend = 'opfs';
    return this.local.readText(p);
  }

  async writeText(path: string, content: string): Promise<void> {
    const p = this.norm(path);
    if (this.serverAvailable()) {
      try {
        await this.api.writeFile(p, content);
        this.lastBackend = 'server';
        return;
      } catch {
        /* fall through to OPFS */
      }
    }
    this.lastBackend = 'opfs';
    await this.local.writeText(p, content);
  }

  async list(path: string): Promise<FileEntry[]> {
    const p = this.norm(path);
    if (this.serverAvailable()) {
      try {
        const r = await this.api.listFiles(p);
        this.lastBackend = 'server';
        return r.entries;
      } catch {
        /* fall through */
      }
    }
    this.lastBackend = 'opfs';
    const entries = await this.local.list(p);
    return entries.map((e) => ({
      name: e.name,
      type: e.type,
      size: e.size,
      mtime: 0,
    }));
  }

  async mkdir(path: string): Promise<void> {
    const p = this.norm(path);
    if (this.serverAvailable()) {
      try {
        await this.api.mkdir(p);
        this.lastBackend = 'server';
        return;
      } catch {
        /* fall through */
      }
    }
    this.lastBackend = 'opfs';
    await this.local.mkdir(p);
  }

  async remove(path: string): Promise<void> {
    const p = this.norm(path);
    if (this.serverAvailable()) {
      try {
        await this.api.deletePath(p);
        this.lastBackend = 'server';
        return;
      } catch {
        /* fall through */
      }
    }
    this.lastBackend = 'opfs';
    await this.local.remove(p);
  }

  /**
   * Explicitly target one storage tier. 'server' fails when the backend is
   * offline; 'opfs' always reads browser-local storage; 'auto' follows the
   * normal preference. Used by the Files app to show both tiers side by side.
   */
  async listFrom(source: 'auto' | 'server' | 'opfs', path: string): Promise<FileEntry[]> {
    if (source === 'auto') return this.list(path);
    if (source === 'server') {
      if (!this.api.online) throw new Error('C backend is offline');
      const r = await this.api.listFiles(this.norm(path));
      this.lastBackend = 'server';
      return r.entries;
    }
    this.lastBackend = 'opfs';
    const entries = await this.local.list(this.norm(path));
    return entries.map((e) => ({ name: e.name, type: e.type, size: e.size, mtime: 0 }));
  }

  async readFrom(source: 'auto' | 'server' | 'opfs', path: string): Promise<string> {
    if (source === 'auto') return this.readText(path);
    if (source === 'server') {
      if (!this.api.online) throw new Error('C backend is offline');
      const r = await this.api.readFile(this.norm(path));
      this.lastBackend = 'server';
      return r.content;
    }
    this.lastBackend = 'opfs';
    return this.local.readText(this.norm(path));
  }

  async writeFrom(source: 'auto' | 'server' | 'opfs', path: string, content: string): Promise<void> {
    if (source === 'auto') return this.writeText(path, content);
    if (source === 'server') {
      if (!this.api.online) throw new Error('C backend is offline');
      await this.api.writeFile(this.norm(path), content);
      this.lastBackend = 'server';
      return;
    }
    this.lastBackend = 'opfs';
    await this.local.writeText(this.norm(path), content);
  }

  async mkdirFrom(source: 'auto' | 'server' | 'opfs', path: string): Promise<void> {
    if (source === 'auto') return this.mkdir(path);
    if (source === 'server') {
      if (!this.api.online) throw new Error('C backend is offline');
      await this.api.mkdir(this.norm(path));
      return;
    }
    await this.local.mkdir(this.norm(path));
  }

  async removeFrom(source: 'auto' | 'server' | 'opfs', path: string): Promise<void> {
    if (source === 'auto') return this.remove(path);
    if (source === 'server') {
      if (!this.api.online) throw new Error('C backend is offline');
      await this.api.deletePath(this.norm(path));
      return;
    }
    await this.local.remove(this.norm(path));
  }

  async exists(path: string): Promise<boolean> {
    const p = this.norm(path);
    if (this.serverAvailable()) {
      try {
        await this.api.readFile(p);
        return true;
      } catch {
        /* not on server; still check OPFS */
      }
    }
    return this.local.exists(p);
  }

  /** Storage usage across the whole origin (IndexedDB + OPFS + caches). */
  async usage(): Promise<{ usage: number; quota: number }> {
    return this.local.usage();
  }

  /** Which local storage tier is active: 'opfs', 'idb' or 'none'. */
  localTier(): string {
    return this.local.tier();
  }
}
