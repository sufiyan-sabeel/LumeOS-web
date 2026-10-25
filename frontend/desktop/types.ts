/*
 * LumeOS - desktop/types.ts
 * Shared type contracts for the kernel, apps and storage layers.
 */

import type { IconName } from '../components/icons.js';

/** Which shell layout is active. */
export type ShellMode = 'desktop' | 'mobile';

/** User preference for the shell layout. */
export type ShellPreference = 'auto' | 'desktop' | 'mobile';

export type AppCategory =
  | 'system'
  | 'productivity'
  | 'developer'
  | 'ai'
  | 'media'
  | 'game'
  | 'utility';

export type PackageType = 'builtin' | 'web' | 'ai-model' | 'native';

export interface AppManifest {
  id: string;
  name: string;
  /** Icon name from components/icons.ts (preferred). */
  icon?: IconName;
  /** Emoji fallback, used only by third-party packages that supply one. */
  glyph?: string;
  description?: string;
  category?: AppCategory;
  type?: PackageType;
  version?: string;
  width?: number;
  height?: number;
  /** Only one instance may be open at a time. */
  singleton?: boolean;
  /** Entry module for installed web packages. */
  entry?: string;
  /** Whether the app should appear on the desktop grid. */
  onDesktop?: boolean;
}

export interface LumeWindowHandle {
  id: string;
  el: HTMLElement;
  body: HTMLElement;
  setTitle(title: string): void;
  close(): void;
  focus(): void;
}

export interface NotificationKind {
  kind: 'info' | 'success' | 'error';
}

export interface AppContext {
  window: LumeWindowHandle;
  args: Record<string, unknown>;
  kernel: KernelApi;
}

export interface LumeApp {
  manifest: AppManifest;
  mount(ctx: AppContext): void | Promise<void>;
  unmount?(): void;
}

/* ---- API surface exposed to apps ---- */
export interface SystemInfo {
  os: string;
  kernel: string;
  arch: string;
  hostname: string;
  cpus: number;
  mem_total_kb: number;
  mem_available_kb: number;
  load1: number;
  load5: number;
  load15: number;
  disk_total_bytes: number;
  disk_free_bytes: number;
  lume_version: string;
  time: string;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtime: number;
}

export interface PackageEntry {
  name: string;
  path: string;
  size: number;
  kind: 'bundle' | 'archive';
}

export interface VfsApi {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  list(path: string): Promise<FileEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  usage(): Promise<{ usage: number; quota: number }>;
  /** Target a specific storage tier explicitly. */
  listFrom(source: 'auto' | 'server' | 'opfs', path: string): Promise<FileEntry[]>;
  readFrom(source: 'auto' | 'server' | 'opfs', path: string): Promise<string>;
  writeFrom(source: 'auto' | 'server' | 'opfs', path: string, content: string): Promise<void>;
  mkdirFrom(source: 'auto' | 'server' | 'opfs', path: string): Promise<void>;
  removeFrom(source: 'auto' | 'server' | 'opfs', path: string): Promise<void>;
}

export interface InstalledAppInfo {
  id: string;
  name: string;
  glyph: string;
  type: PackageType;
  version: string;
  entry?: string;
  installedAt: number;
  sizeBytes?: number;
}

export interface KernelApi {
  vfs: VfsApi;
  notify(title: string, body?: string, kind?: NotificationKind['kind']): void;
  openApp(id: string, args?: Record<string, unknown>): void;
  isServerOnline(): boolean;
  refreshServerStatus(): Promise<boolean>;
  /** Current shell layout, and the user's preference for it. */
  shellMode(): ShellMode;
  shellPreference(): ShellPreference;
  setShellPreference(pref: ShellPreference): void;
  /** Register an installed web app and add it to the desktop. */
  installWebApp(info: InstalledAppInfo): Promise<void>;
  uninstallApp(id: string): Promise<void>;
  installedApps(): InstalledAppInfo[];
  api: {
    systemInfo(): Promise<SystemInfo>;
    listPackages(): Promise<PackageEntry[]>;
    execNative(binary: string): Promise<{ exit_code: number; stdout: string }>;
    sourceExportUrl(): string;
  };
}
