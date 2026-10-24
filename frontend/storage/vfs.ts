/*
 * LumeOS - storage/vfs.ts
 * The Virtual File System: a single async API that transparently routes
 * between OPFS (offline, browser-local) and the C backend's data/files/
 * directory (online). If the server is unreachable it degrades to OPFS.
 */

import type { FileEntry, VfsApi } from '../desktop/types.js';
import type { ApiClient } from './api.js';
import type { OpfsManager } from './opfs.js';

export type VfsBackend = 'server' | 'opfs';

export class Vfs implements VfsApi {
  /** When true and the server is online, prefer server-backed storage. */
  public preferServer = true;
  /** Records which backend served the most recent operation. */
  public lastBackend: VfsBackend = 'opfs';

  constructor(private opfsMgr: OpfsManager, private api: ApiClient) {}

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
    return this.opfsMgr.readText(p);
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
    await this.opfsMgr.writeText(p, content);
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
    const entries = await this.opfsMgr.list(p);
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
    await this.opfsMgr.mkdir(p);
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
    await this.opfsMgr.remove(p);
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
    return this.opfsMgr.exists(p);
  }

  /** Storage usage across the whole origin (IndexedDB + OPFS + caches). */
  async usage(): Promise<{ usage: number; quota: number }> {
    return this.opfsMgr.usage();
  }
}
