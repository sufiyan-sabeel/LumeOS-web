/*
 * LumeOS - desktop/kernel.ts
 * The LumeKernel: boots the OS, wires the desktop, window manager, storage
 * layers and the built-in applications, and exposes the public LumeOS API
 * (window.LumeOS) to installed apps.
 */

import { osState } from './state.js';
import { appUrl } from './base.js';
import { bus } from './events.js';
import { Desktop, type DesktopHost } from './desktop.js';
import { WindowManager } from './window-manager.js';
import { registry } from '../apps/registry.js';
import { ApiClient } from '../storage/api.js';
import { opfs } from '../storage/opfs.js';
import { Vfs } from '../storage/vfs.js';
import { idb, STORE_REGISTRY } from '../storage/idb.js';
import { toast } from '../components/toast.js';
import type {
  AppContext,
  AppManifest,
  FileEntry,
  InstalledAppInfo,
  KernelApi,
  LumeApp,
  LumeWindowHandle,
  PackageEntry,
  SystemInfo,
} from './types.js';

/* built-in apps */
import { filesApp } from '../apps/files/app.js';
import { terminalApp } from '../apps/terminal/app.js';
import { notesApp } from '../apps/notes/app.js';
import { calculatorApp } from '../apps/calculator/app.js';
import { settingsApp } from '../apps/settings/app.js';
import { appStoreApp } from '../apps/app-store/app.js';
import { downloadsApp } from '../apps/downloads/app.js';
import { aiCenterApp } from '../apps/ai-center/app.js';
import { browserApp } from '../apps/browser/app.js';

const BUILTINS: LumeApp[] = [
  filesApp,
  terminalApp,
  notesApp,
  calculatorApp,
  settingsApp,
  appStoreApp,
  downloadsApp,
  aiCenterApp,
  browserApp,
];

function boot(msg: string, pct: number): void {
  const status = document.getElementById('boot-status');
  const bar = document.getElementById('boot-bar');
  if (status) status.textContent = msg;
  if (bar) bar.style.width = `${pct}%`;
}

class LumeKernel implements KernelApi, DesktopHost {
  public readonly api = new ApiClient();
  public readonly vfs: Vfs;
  public wm!: WindowManager;
  public desktop!: Desktop;
  public readonly version = '1.0.0';

  private installed = new Map<string, InstalledAppInfo>();
  /** Resolves once the service worker is active (or has failed to register). */
  private swReady: Promise<void> = Promise.resolve();

  constructor() {
    this.vfs = new Vfs(opfs, this.api);
  }

  /* ================================================================== */
  /* Boot                                                                */
  /* ================================================================== */
  async boot(): Promise<void> {
    /* Register the service worker first: it installs asynchronously and the
     * boot sequence's awaits would otherwise run past the window 'load' event. */
    this.registerServiceWorker();

    boot('Loading settings…', 10);
    await osState.load();
    osState.applyTheme();

    boot('Opening local storage…', 30);
    try {
      await idb.open();
    } catch {
      /* IndexedDB may be unavailable in private mode */
    }
    const opfsOk = await opfs.available();

    boot('Connecting to C backend…', 55);
    this.api.base = osState.settings.serverUrl;
    this.api.token = osState.settings.token;
    this.vfs.preferServer = osState.settings.preferServer;
    const online = await this.api.health();

    boot('Restoring installed apps…', 70);
    await this.restoreInstalled();

    boot('Registering applications…', 82);
    for (const app of BUILTINS) registry.register(app);
    for (const info of this.installed.values()) this.registerInstalled(info);

    boot('Starting window manager…', 92);
    document.getElementById('lume-boot')?.classList.add('hidden');
    const shell = document.getElementById('lume-desktop') as HTMLElement;
    shell.hidden = false;

    this.desktop = new Desktop(this);
    this.wm = new WindowManager();
    this.desktop.mount();
    this.desktop.setServerStatus(online);

    this.exposeGlobalApi();
    this.handleLaunchParams();

    boot('Ready', 100);
    setTimeout(() => document.getElementById('lume-boot')?.remove(), 400);

    this.notify(
      'LumeOS ready',
      online ? 'C backend online — VFS mounted.' : 'Running offline (OPFS only).',
      online ? 'success' : 'info'
    );
    void opfsOk;
  }

  private async restoreInstalled(): Promise<void> {
    try {
      const rows = await idb.getAll<InstalledAppInfo>(STORE_REGISTRY);
      for (const r of rows) this.installed.set(r.id, r);
    } catch {
      /* ignore */
    }
  }

  private registerInstalled(info: InstalledAppInfo): void {
    const manifest: AppManifest = {
      id: info.id,
      name: info.name,
      glyph: info.glyph,
      description: `Installed ${info.type} package`,
      category: 'utility',
      type: 'web',
      version: info.version,
      width: 820,
      height: 560,
      onDesktop: true,
    };
    registry.registerFactory(manifest, () => this.webAppInstance(info));
  }

  /** Build a LumeApp that hosts an installed web package in a sandboxed iframe. */
  private webAppInstance(info: InstalledAppInfo): LumeApp {
    const kernel = this;
    return {
      manifest: {
        id: info.id,
        name: info.name,
        glyph: info.glyph,
        type: 'web',
        version: info.version,
        onDesktop: true,
      },
      mount(ctx: AppContext) {
        const frame = document.createElement('iframe');
        frame.className = 'browser__frame';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
        ctx.window.body.appendChild(frame);

        /* LumeOS IPC bridge: installed apps talk to the kernel via postMessage. */
        const onMessage = (e: MessageEvent): void => {
          if (e.source !== frame.contentWindow) return;
          const msg = e.data as { type?: string; method?: string; args?: unknown[] };
          if (!msg || msg.type !== 'lume:call') return;
          void kernel.bridgeCall(msg.method ?? '', msg.args ?? [], frame);
        };
        window.addEventListener('message', onMessage);
        ctx.window.el.addEventListener('lume:unmount', () =>
          window.removeEventListener('message', onMessage)
        );

        /* The package is served from OPFS by the service worker, so wait for
         * it to be active before navigating the frame. */
        void kernel.swReady.then(() => {
          frame.src = appUrl(`apps/installed/${info.id}/${info.entry ?? 'index.html'}`);
        });
      },
    };
  }

  private async bridgeCall(method: string, args: unknown[], frame: HTMLIFrameElement): Promise<void> {
    const reply = (result: unknown): void =>
      frame.contentWindow?.postMessage({ type: 'lume:result', result }, '*');
    try {
      switch (method) {
        case 'notify':
          this.notify(String(args[0] ?? 'App'), String(args[1] ?? ''), 'info');
          reply(true);
          break;
        case 'fs.read':
          reply(await this.vfs.readText(String(args[0])));
          break;
        case 'fs.write':
          await this.vfs.writeText(String(args[0]), String(args[1]));
          reply(true);
          break;
        case 'fs.list':
          reply(await this.vfs.list(String(args[0])));
          break;
        default:
          reply({ error: `unknown bridge method: ${method}` });
      }
    } catch (err) {
      reply({ error: (err as Error).message });
    }
  }

  /* ================================================================== */
  /* KernelApi                                                           */
  /* ================================================================== */
  notify(title: string, body = '', kind: 'info' | 'success' | 'error' = 'info'): void {
    toast(title, body, kind);
    bus.emit('toast', { title, body, kind });
  }

  openApp(id: string, args: Record<string, unknown> = {}): void {
    const reg = registry.get(id);
    if (!reg) {
      this.notify('App not found', `No application with id "${id}"`, 'error');
      return;
    }
    if (reg.manifest.singleton) {
      const existing = this.wm.findByApp(id);
      if (existing) {
        existing.win.restore();
        return;
      }
    }
    const instance = reg.create();
    let unmount: (() => void) | undefined = instance.unmount?.bind(instance);

    const win = this.wm.create(
      id,
      reg.manifest,
      (handle: LumeWindowHandle) => instance.mount({ window: handle, args, kernel: this }),
      () => {
        win.el.dispatchEvent(new Event('lume:unmount'));
        unmount?.();
        unmount = undefined;
      },
      args
    );
  }

  isServerOnline(): boolean {
    return this.api.online;
  }

  /* DesktopHost alias */
  serverOnline(): boolean {
    return this.api.online;
  }

  async refreshServerStatus(): Promise<boolean> {
    this.api.base = osState.settings.serverUrl;
    this.api.token = osState.settings.token;
    this.vfs.preferServer = osState.settings.preferServer;
    const online = await this.api.health();
    bus.emit('server:status', { online });
    this.desktop?.setServerStatus(online);
    return online;
  }

  async installWebApp(info: InstalledAppInfo): Promise<void> {
    this.installed.set(info.id, info);
    try {
      await idb.put(STORE_REGISTRY, info);
    } catch {
      /* persistence optional */
    }
    this.registerInstalled(info);
    this.desktop.renderIcons();
    void this.desktop.refreshStorage();
  }

  async uninstallApp(id: string): Promise<void> {
    this.installed.delete(id);
    try {
      await idb.delete(STORE_REGISTRY, id);
    } catch {
      /* ignore */
    }
    registry.unregister(id);
    this.wm.closeByApp(id);
    try {
      await opfs.remove(`/${id}`);
    } catch {
      /* ignore */
    }
    this.desktop.renderIcons();
  }

  installedApps(): InstalledAppInfo[] {
    return Array.from(this.installed.values());
  }

  /* ================================================================== */
  /* DesktopHost                                                         */
  /* ================================================================== */
  launch(appId: string, args: Record<string, unknown> = {}): void {
    this.openApp(appId, args);
  }

  manifests(): AppManifest[] {
    return registry.desktopApps();
  }

  storageUsage(): Promise<{ usage: number; quota: number }> {
    return this.vfs.usage();
  }

  installedIds(): string[] {
    return Array.from(this.installed.keys());
  }

  uninstall(appId: string): void {
    void this.uninstallApp(appId).then(() =>
      this.notify('Uninstalled', appId, 'success')
    );
  }

  sourceUrl(): string {
    return this.api.sourceExportUrl();
  }

  /* ================================================================== */
  /* Public API + PWA                                                    */
  /* ================================================================== */
  private exposeGlobalApi(): void {
    const kernel = this;
    const LumeOS = {
      version: this.version,
      fs: {
        read: (p: string): Promise<string> => kernel.vfs.readText(p),
        write: (p: string, c: string): Promise<void> => kernel.vfs.writeText(p, c),
        list: (p: string): Promise<FileEntry[]> => kernel.vfs.list(p),
        mkdir: (p: string): Promise<void> => kernel.vfs.mkdir(p),
        remove: (p: string): Promise<void> => kernel.vfs.remove(p),
      },
      notifications: {
        send: (title: string, body?: string): void => kernel.notify(title, body ?? ''),
      },
      apps: {
        open: (id: string): void => kernel.openApp(id),
        installed: (): InstalledAppInfo[] => kernel.installedApps(),
      },
      system: {
        info: (): Promise<SystemInfo> => kernel.api.systemInfo(),
        packages: (): Promise<PackageEntry[]> => kernel.api.listPackages(),
      },
    };
    (window as unknown as { LumeOS: typeof LumeOS }).LumeOS = LumeOS;
  }

  private registerServiceWorker(): void {
    if (!('serviceWorker' in navigator)) return;

    const register = (): void => {
      this.swReady = navigator.serviceWorker
        .register(appUrl('service-worker.js'))
        .then(() => navigator.serviceWorker.ready.then(() => undefined))
        .catch((err: unknown) => {
          console.warn('[LumeOS] service worker failed', err);
        });
    };

    /* If the document already finished loading, register immediately;
     * otherwise wait for the load event. */
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  private handleLaunchParams(): void {
    const params = new URLSearchParams(location.search);
    const app = params.get('app');
    if (app) this.openApp(app);
    const open = params.get('open');
    if (open) this.openApp('notes', { path: open });
  }
}

/* ---------------------------------------------------------------------- */
/* Entry                                                                  */
/* ---------------------------------------------------------------------- */
const kernel = new LumeKernel();

kernel.boot().catch((err: unknown) => {
  console.error('[LumeOS] boot failed', err);
  boot(`Boot failed: ${(err as Error).message}`, 100);
  toast('Boot failed', (err as Error).message, 'error');
});

export { kernel };
