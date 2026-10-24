/*
 * LumeOS - storage/opfs.ts
 * Origin Private File System manager: high-performance browser storage for
 * binary blobs, installed web-app bundles and offline AI model weights.
 */

type DirHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

export interface OpfsEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
}

export class OpfsManager {
  private root: DirHandle | null = null;

  async available(): Promise<boolean> {
    try {
      const storage = navigator.storage as StorageManager & {
        getDirectory?: () => Promise<FileSystemDirectoryHandle>;
      };
      if (typeof storage?.getDirectory !== 'function') return false;
      this.root = (await storage.getDirectory()) as DirHandle;
      return true;
    } catch {
      return false;
    }
  }

  private async getRoot(): Promise<DirHandle> {
    if (this.root) return this.root;
    const storage = navigator.storage as StorageManager & {
      getDirectory: () => Promise<FileSystemDirectoryHandle>;
    };
    this.root = (await storage.getDirectory()) as DirHandle;
    return this.root;
  }

  private segments(path: string): string[] {
    return path.split('/').filter((s) => s.length > 0);
  }

  private async resolveDir(path: string, create: boolean): Promise<DirHandle> {
    let dir = await this.getRoot();
    for (const seg of this.segments(path)) {
      dir = (await dir.getDirectoryHandle(seg, { create })) as DirHandle;
    }
    return dir;
  }

  async writeText(path: string, content: string): Promise<void> {
    const parts = this.segments(path);
    const name = parts.pop();
    if (!name) throw new Error('OPFS: invalid path');
    const dir = await this.resolveDir('/' + parts.join('/'), true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    const parts = this.segments(path);
    const name = parts.pop();
    if (!name) throw new Error('OPFS: invalid path');
    const dir = await this.resolveDir('/' + parts.join('/'), true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  async readText(path: string): Promise<string> {
    const parts = this.segments(path);
    const name = parts.pop();
    if (!name) throw new Error('OPFS: invalid path');
    const dir = await this.resolveDir('/' + parts.join('/'), false);
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    return file.text();
  }

  async readBlob(path: string): Promise<Blob> {
    const parts = this.segments(path);
    const name = parts.pop();
    if (!name) throw new Error('OPFS: invalid path');
    const dir = await this.resolveDir('/' + parts.join('/'), false);
    const fh = await dir.getFileHandle(name);
    return fh.getFile();
  }

  async list(path: string): Promise<OpfsEntry[]> {
    const dir = await this.resolveDir(path, false);
    const out: OpfsEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        const f = await (handle as FileSystemFileHandle).getFile();
        out.push({ name, type: 'file', size: f.size });
      } else {
        out.push({ name, type: 'dir', size: 0 });
      }
    }
    out.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
    );
    return out;
  }

  async mkdir(path: string): Promise<void> {
    await this.resolveDir(path, true);
  }

  async remove(path: string): Promise<void> {
    const parts = this.segments(path);
    const name = parts.pop();
    if (!name) throw new Error('OPFS: invalid path');
    const dir = await this.resolveDir('/' + parts.join('/'), false);
    await dir.removeEntry(name, { recursive: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      const parts = this.segments(path);
      const name = parts.pop();
      if (!name) return false;
      const dir = await this.resolveDir('/' + parts.join('/'), false);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async usage(): Promise<{ usage: number; quota: number }> {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
    }
    return { usage: 0, quota: 0 };
  }
}

export const opfs = new OpfsManager();
