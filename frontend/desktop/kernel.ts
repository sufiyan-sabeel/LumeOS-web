/*
 * LumeOS - desktop/kernel.ts
 * The LumeKernel: boots the OS, chooses the shell layout, wires the desktop,
 * window manager, storage layers and applications, and exposes the public
 * LumeOS API (window.LumeOS) to installed apps.
 */

import { osState } from './state.js';
import { appUrl, appBasePath } from './base.js';
import { bus } from './events.js';
import { Desktop, type DesktopHost, type WindowEntry } from './desktop.js';
import { WindowManager } from './window-manager.js';
import { MobileShell } from './mobile.js';
import { registry } from '../apps/registry.js';
import { ApiClient } from '../storage/api.js';
import { localFs } from '../storage/local-fs.js';
import { Vfs } from '../storage/vfs.js';
import { idb, STORE_REGISTRY } from '../storage/idb.js';
import { toast } from '../components/toast.js';
import type {
  AppContext,
  AppManifest,
  DiagItem,
  FileEntry,
  InstalledAppInfo,
  KernelApi,
  LumeApp,
  LumeWindowHandle,
  PackageEntry,
  ShellMode,
  ShellPreference,
  SystemInfo,
} from './types.js';

/* built-in applications */
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

/** Viewport width at or below which the mobile shell is used. */
const MOBILE_MAX_WIDTH = 820;

function boot(msg: string, pct: number): void {
  const status = document.getElementById('boot-status');
  const bar = document.getElementById('boot-bar');
  if (status) status.textContent = msg;
  if (bar) bar.style.width = `${pct}%`;
}

class LumeKernel implements KernelApi, DesktopHost {
  public readonly api = new ApiClient();
  public readonly vfs: Vfs;
  public readonly version = '1.1.0';
  public wm!: WindowManager;
  public desktop!: Desktop;
  public mobile!: MobileShell;

  private installed = new Map<string, InstalledAppInfo>();
  private swReady: Promise<void> = Promise.resolve();
  private mode: ShellMode = 'desktop';
  private mq: MediaQueryList | null = null;

  constructor() {
    this.vfs = new Vfs(localFs, this.api);
  }

  /* ================================================================== */
  /* Boot                                                               */
  /* ================================================================== */
  async boot(): Promise<void> {
    this.registerServiceWorker();

    boot('Loading settings…', 10);
    await osState.load();
    osState.applyTheme();

    boot('Opening local storage…', 30);
    try {
      await idb.open();
    } catch {
      /* IndexedDB may be unavailable (private mode) */
    }
    await localFs.available();

    boot('Connecting to C backend…', 55);
    /* Resolve the API against the site base so LumeOS works when served from
     * the domain root or from a subpath such as /LumeOS-web/. */
    this.api.base = osState.settings.serverUrl || appBasePath();
    this.api.token = osState.settings.token;
    this.vfs.preferServer = osState.settings.preferServer;
    const online = await this.api.health();

    boot('Restoring installed apps…', 70);
    await this.restoreInstalled();

    boot('Registering applications…', 82);
    for (const app of BUILTINS) registry.register(app);
    for (const info of this.installed.values()) this.registerInstalled(info);

    boot('Starting window manager…', 92);
    this.applyShellMode(true);

    const shell = document.getElementById('lume-shell') as HTMLElement;
    shell.hidden = false;
    document.getElementById('lume-boot')?.classList.add('hidden');

    this.desktop = new Desktop(this);
    this.wm = new WindowManager(() => this.onWindowsChanged());
    this.mobile = new MobileShell(this);

    this.desktop.mount();
    this.mobile.mount();
    this.wm.setBackHandler(() => this.mobile.showHome());
    this.desktop.setServerStatus(online);
    this.wm.setMode(this.mode);
    this.mobile.sync();

    this.bindGlobalEvents();
    this.exposeGlobalApi();
    this.handleLaunchParams();

    boot('Ready', 100);
    setTimeout(() => document.getElementById('lume-boot')?.remove(), 400);

    this.notify(
      'LumeOS ready',
      online ? 'C backend online — VFS mounted.' : 'Running offline from local storage (OPFS).',
      online ? 'success' : 'info'
    );
  }

  private async restoreInstalled(): Promise<void> {
    try {
      const rows = await idb.getAll<InstalledAppInfo>(STORE_REGISTRY);
      for (const r of rows) this.installed.set(r.id, r);
    } catch {
      /* ignore */
    }
  }

  /* ================================================================== */
  /* Shell mode                                                         */
  /* ================================================================== */
  private resolveMode(): ShellMode {
    const pref = osState.settings.shell;
    if (pref === 'desktop' || pref === 'mobile') return pref;
    return window.innerWidth <= MOBILE_MAX_WIDTH ? 'mobile' : 'desktop';
  }

  private applyShellMode(initial = false): void {
    const next = this.resolveMode();
    document.documentElement.setAttribute('data-shell', next);
    this.mode = next;

    if (initial) {
      if (!this.mq && typeof window.matchMedia === 'function') {
        this.mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
        const onChange = (): void => {
          if (osState.settings.shell !== 'auto') return;
          this.setMode(this.resolveMode());
        };
        if (this.mq.addEventListener) this.mq.addEventListener('change', onChange);
        else this.mq.addListener(onChange);
      }
      return;
    }
    this.setMode(next);
  }

  private setMode(mode: ShellMode): void {
    if (mode === this.mode && document.documentElement.getAttribute('data-shell') === mode) return;
    this.mode = mode;
    document.documentElement.setAttribute('data-shell', mode);
    this.wm?.setMode(mode);

    if (mode === 'mobile') {
      this.mobile?.sync();
    } else {
      this.mobile?.closeRecents();
      this.mobile?.resetHistory();
    }
    this.desktop?.onWindowsChanged();
  }

  shellMode(): ShellMode {
    return this.mode;
  }

  shellPreference(): ShellPreference {
    return osState.settings.shell;
  }

  setShellPreference(pref: ShellPreference): void {
    void osState.update({ shell: pref });
    this.setMode(this.resolveMode());
  }

  /* ================================================================== */
  /* Global events                                                      */
  /* ================================================================== */
  private bindGlobalEvents(): void {
    document.addEventListener('lume:toggle-theme', () => {
      void osState.update({ theme: osState.settings.theme === 'dark' ? 'light' : 'dark' });
    });

    document.addEventListener('lume:wallpaper', (e) => {
      const value = (e as CustomEvent<string>).detail;
      if (typeof value === 'string' && value) {
        osState.setWallpaper(value);
        this.notify('Wallpaper changed', '', 'success');
      }
    });

    /* Keep the viewport honest: no horizontal overflow anywhere. */
    window.addEventListener('resize', () => {
      if (osState.settings.shell === 'auto') this.setMode(this.resolveMode());
    });
  }

  private onWindowsChanged(): void {
    this.desktop?.onWindowsChanged();
    this.mobile?.sync();
  }

  /* ================================================================== */
  /* Installed web packages                                             */
  /* ================================================================== */
  private registerInstalled(info: InstalledAppInfo): void {
    const manifest: AppManifest = {
      id: info.id,
      name: info.name,
      glyph: info.glyph,
      description: `Installed ${info.type} package`,
      category: 'utility',
      type: 'web',
      version: info.version,
      width: 860,
      height: 580,
      onDesktop: true,
    };
    registry.registerFactory(manifest, () => this.webAppInstance(info));
  }

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
        frame.title = info.name;
        ctx.window.body.appendChild(frame);

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

        /* The package is served from OPFS by the service worker. */
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
  /* KernelApi                                                          */
  /* ================================================================== */
  notify(title: string, body = '', kind: 'info' | 'success' | 'error' = 'info'): void {
    toast(title, body, kind);
    this.desktop?.pushNotification(title, body, kind);
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
        this.wm.focus(existing.win.id);
        return;
      }
    }

    const instance = reg.create();
    let unmount: (() => void) | undefined = instance.unmount?.bind(instance);

    this.wm.create(
      id,
      reg.manifest,
      (handle: LumeWindowHandle) => instance.mount({ window: handle, args, kernel: this }),
      () => {
        unmount?.();
        unmount = undefined;
      },
      args
    );

    if (this.mode === 'mobile') {
      this.mobile.notifyAppOpened();
      this.mobile.pushHistory();
    }
  }

  isServerOnline(): boolean {
    return this.api.online;
  }

  async refreshServerStatus(): Promise<boolean> {
    this.api.base = osState.settings.serverUrl || appBasePath();
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
    this.mobile.renderHome();
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
      await localFs.remove(`/${id}`);
    } catch {
      /* ignore */
    }
    this.desktop.renderIcons();
    this.mobile.renderHome();
  }

  /* ================================================================== */
  /* Diagnostics                                                        */
  /* ================================================================== */
  async diagnostics(): Promise<DiagItem[]> {
    const items: DiagItem[] = [];

    const secure = typeof window !== 'undefined' && window.isSecureContext;
    items.push({
      label: 'Secure context',
      ok: secure,
      detail: secure
        ? 'Yes — service workers, local storage and crypto are available.'
        : 'No — LumeOS is being served over http:// on a non-localhost host. ' +
          'Use https:// or http://localhost; otherwise storage and offline features are blocked.',
    });

    const tier = localFs.tier();
    items.push({
      label: 'Local file storage',
      ok: tier !== 'none',
      detail:
        tier === 'opfs'
          ? 'OPFS — fast, large capacity.'
          : tier === 'idb'
            ? 'IndexedDB fallback — OPFS is unavailable in this browser, so files are stored in IndexedDB.'
            : 'Unavailable — files cannot be saved locally in this browser.',
    });

    let idbOk = true;
    try {
      await idb.open();
    } catch {
      idbOk = false;
    }
    items.push({
      label: 'IndexedDB',
      ok: idbOk,
      detail: idbOk
        ? 'Available — settings and installed apps persist.'
        : 'Blocked (often private browsing). Settings and installs will not persist.',
    });

    const ds = typeof DecompressionStream !== 'undefined';
    items.push({
      label: '.lume archive extraction',
      ok: ds,
      detail: ds
        ? 'Supported — packages install from a single .lume archive.'
        : 'Not supported by this browser — packages install file by file instead.',
    });

    let swOk = false;
    let swDetail = 'Not registered.';
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      swOk = regs.length > 0;
      swDetail = swOk
        ? 'Registered — installed apps can launch offline.'
        : 'Not registered — installed apps cannot be served offline.';
    } catch {
      swDetail = 'Unavailable in this browser or context.';
    }
    items.push({ label: 'Service worker', ok: swOk, detail: swDetail });

    const apiUrl = this.api.healthUrl();
    items.push({
      label: 'C backend',
      ok: this.api.online,
      detail: this.api.online
        ? `Connected — ${apiUrl}`
        : `Not reachable at ${apiUrl}. A static host such as GitHub Pages cannot run the ` +
          'C server. To bring the backend online, run "make run" and open ' +
          'http://localhost:8080, or set an https:// backend URL in Settings.',
    });

    return items;
  }

  installedApps(): InstalledAppInfo[] {
    return Array.from(this.installed.values());
  }

  /* ================================================================== */
  /* DesktopHost                                                        */
  /* ================================================================== */
  launch(appId: string, args: Record<string, unknown> = {}): void {
    this.openApp(appId, args);
  }

  manifests(): AppManifest[] {
    return registry.desktopApps();
  }

  serverOnline(): boolean {
    return this.api.online;
  }

  async serverInfo(): Promise<SystemInfo | null> {
    if (!this.api.online) return null;
    try {
      return await this.api.systemInfo();
    } catch {
      return null;
    }
  }

  storageUsage(): Promise<{ usage: number; quota: number }> {
    return this.vfs.usage();
  }

  installedIds(): string[] {
    return Array.from(this.installed.keys());
  }

  uninstall(appId: string): void {
    void this.uninstallApp(appId).then(() => this.notify('Uninstalled', appId, 'success'));
  }

  sourceUrl(): string {
    return this.api.sourceExportUrl();
  }

  windows(): WindowEntry[] {
    return this.wm.entries();
  }

  activeWindowId(): string | null {
    return this.wm.activeWindowId();
  }

  focusWindow(id: string): void {
    this.wm.focus(id);
  }

  closeWindow(id: string): void {
    this.wm.close(id);
  }

  blurWindows(): void {
    this.wm.blur();
  }

  /* ================================================================== */
  /* Public API + PWA                                                   */
  /* ================================================================== */
  private exposeGlobalApi(): void {
    const kernel = this;
    const LumeOS = {
      version: this.version,
      shell: {
        mode: (): ShellMode => kernel.shellMode(),
        preference: (): ShellPreference => kernel.shellPreference(),
        setPreference: (p: ShellPreference): void => kernel.setShellPreference(p),
      },
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
const kernel = new LumeKernel();

kernel.boot().catch((err: unknown) => {
  console.error('[LumeOS] boot failed', err);
  boot(`Boot failed: ${(err as Error).message}`, 100);
  toast('Boot failed', (err as Error).message, 'error');
});

export { kernel };
