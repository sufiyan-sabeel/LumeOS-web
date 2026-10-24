/*
 * LumeOS - apps/registry.ts
 * Central registry of launchable applications (built-in and installed).
 */

import type { AppManifest, LumeApp } from '../desktop/types.js';

export interface RegisteredApp {
  manifest: AppManifest;
  create: () => LumeApp;
}

export class AppRegistry {
  private apps = new Map<string, RegisteredApp>();

  register(app: LumeApp): void {
    this.apps.set(app.manifest.id, { manifest: app.manifest, create: () => app });
  }

  registerFactory(manifest: AppManifest, create: () => LumeApp): void {
    this.apps.set(manifest.id, { manifest, create });
  }

  get(id: string): RegisteredApp | undefined {
    return this.apps.get(id);
  }

  has(id: string): boolean {
    return this.apps.has(id);
  }

  all(): AppManifest[] {
    return Array.from(this.apps.values())
      .map((a) => a.manifest)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  desktopApps(): AppManifest[] {
    return this.all().filter((m) => m.onDesktop !== false);
  }

  unregister(id: string): void {
    this.apps.delete(id);
  }
}

export const registry = new AppRegistry();
