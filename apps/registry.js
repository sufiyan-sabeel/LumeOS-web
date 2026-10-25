/*
 * LumeOS - apps/registry.ts
 * Central registry of launchable applications (built-in and installed).
 */
export class AppRegistry {
    apps = new Map();
    register(app) {
        this.apps.set(app.manifest.id, { manifest: app.manifest, create: () => app });
    }
    registerFactory(manifest, create) {
        this.apps.set(manifest.id, { manifest, create });
    }
    get(id) {
        return this.apps.get(id);
    }
    has(id) {
        return this.apps.has(id);
    }
    all() {
        return Array.from(this.apps.values())
            .map((a) => a.manifest)
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    desktopApps() {
        return this.all().filter((m) => m.onDesktop !== false);
    }
    unregister(id) {
        this.apps.delete(id);
    }
}
export const registry = new AppRegistry();
