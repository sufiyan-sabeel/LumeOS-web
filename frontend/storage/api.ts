/*
 * LumeOS - storage/api.ts
 * Typed client for the LumeOS C backend REST API.
 */

import type { SystemInfo, FileEntry, PackageEntry } from '../desktop/types.js';

interface FilesListResponse {
  path: string;
  entries: FileEntry[];
}

interface FileReadResponse {
  path: string;
  size: number;
  content: string;
  sha256: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  /** Empty base == same origin (served by the C backend). */
  public base = '';
  /** Session token for write endpoints (empty == auth disabled). */
  public token = '';
  public online = false;

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (this.token) h['X-Lume-Token'] = this.token;
    if (extra) Object.assign(h, extra);
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), init);
    } catch (err) {
      this.online = false;
      throw new ApiError(0, `network error: ${(err as Error).message}`);
    }
    this.online = true;
    const text = await res.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) {
      const msg =
        (data as { message?: string }).message ?? `HTTP ${res.status}`;
      throw new ApiError(res.status, msg);
    }
    return data as T;
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.request<{ status: string }>('/api/health', {
        headers: this.headers(),
      });
      this.online = r.status === 'ok';
      return this.online;
    } catch {
      this.online = false;
      return false;
    }
  }

  systemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>('/api/system/info', { headers: this.headers() });
  }

  async listPackages(): Promise<PackageEntry[]> {
    const r = await this.request<{ packages: PackageEntry[] }>('/api/packages', {
      headers: this.headers(),
    });
    return r.packages ?? [];
  }

  listFiles(path: string): Promise<FilesListResponse> {
    return this.request<FilesListResponse>(
      `/api/files/list?path=${encodeURIComponent(path)}`,
      { headers: this.headers() }
    );
  }

  readFile(path: string): Promise<FileReadResponse> {
    return this.request<FileReadResponse>(
      `/api/files/read?path=${encodeURIComponent(path)}`,
      { headers: this.headers() }
    );
  }

  writeFile(path: string, content: string): Promise<{ ok: string }> {
    return this.request<{ ok: string }>('/api/files/write', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path, content }),
    });
  }

  mkdir(path: string): Promise<{ ok: string }> {
    return this.request<{ ok: string }>('/api/files/mkdir', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path }),
    });
  }

  deletePath(path: string): Promise<{ ok: string }> {
    return this.request<{ ok: string }>(
      `/api/files/delete?path=${encodeURIComponent(path)}`,
      { method: 'DELETE', headers: this.headers() }
    );
  }

  execNative(binary: string): Promise<{ binary: string; exit_code: number; stdout: string }> {
    return this.request('/api/system/exec-native', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ binary }),
    });
  }

  sourceExportUrl(): string {
    return this.url('/api/export/project');
  }
}
