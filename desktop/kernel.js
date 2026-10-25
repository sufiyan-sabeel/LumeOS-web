/*
 * LumeOS - desktop/kernel.ts
 * The LumeKernel: boots the OS, chooses the shell layout, wires the desktop,
 * window manager, storage layers and applications, and exposes the public
 * LumeOS API (window.LumeOS) to installed apps.
 */
import { osState } from './state.js';
import { appUrl, appBasePath } from './base.js';
import { bus } from './events.js';
import { Desktop } from './desktop.js';
import { WindowManager } from './window-manager.js';
import { MobileShell } from './mobile.js';
import { registry } from '../apps/registry.js';
import { ApiClient } from '../storage/api.js';
import { localFs } from '../storage/local-fs.js';
import { Vfs } from '../storage/vfs.js';
import { idb, STORE_REGISTRY } from '../storage/idb.js';
import { toast } from '../components/toast.js';
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
const BUILTINS = [
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
function boot(msg, pct) {
    const status = document.getElementById('boot-status');
    const bar = document.getElementById('boot-bar');
    if (status)
        status.textContent = msg;
    if (bar)
        bar.style.width = `${pct}%`;
}
class LumeKernel {
    api = new ApiClient();
    vfs;
    version = '1.1.0';
    wm;
    desktop;
    mobile;
    installed = new Map();
    swReady = Promise.resolve();
    mode = 'desktop';
    mq = null;
    constructor() {
        this.vfs = new Vfs(localFs, this.api);
    }
    /* ================================================================== */
    /* Boot                                                               */
    /* ================================================================== */
    async boot() {
        this.registerServiceWorker();
        boot('Loading settings…', 10);
        await osState.load();
        osState.applyTheme();
        /* Deep link: ?backend=https://lumeos-api.<sub>.workers.dev points this
         * session at a hosted backend without touching Settings. */
        const backendParam = new URLSearchParams(location.search).get('backend');
        if (backendParam) {
            osState.settings.serverUrl = backendParam.trim();
            void osState.save();
        }
        boot('Opening local storage…', 30);
        try {
            await idb.open();
        }
        catch {
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
        for (const app of BUILTINS)
            registry.register(app);
        for (const info of this.installed.values())
            this.registerInstalled(info);
        boot('Starting window manager…', 92);
        this.applyShellMode(true);
        const shell = document.getElementById('lume-shell');
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
        this.notify('LumeOS ready', online ? 'C backend online — VFS mounted.' : 'Running offline from local storage (OPFS).', online ? 'success' : 'info');
    }
    async restoreInstalled() {
        try {
            const rows = await idb.getAll(STORE_REGISTRY);
            for (const r of rows)
                this.installed.set(r.id, r);
        }
        catch {
            /* ignore */
        }
    }
    /* ================================================================== */
    /* Shell mode                                                         */
    /* ================================================================== */
    resolveMode() {
        const pref = osState.settings.shell;
        if (pref === 'desktop' || pref === 'mobile')
            return pref;
        return window.innerWidth <= MOBILE_MAX_WIDTH ? 'mobile' : 'desktop';
    }
    applyShellMode(initial = false) {
        const next = this.resolveMode();
        document.documentElement.setAttribute('data-shell', next);
        this.mode = next;
        if (initial) {
            if (!this.mq && typeof window.matchMedia === 'function') {
                this.mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
                const onChange = () => {
                    if (osState.settings.shell !== 'auto')
                        return;
                    this.setMode(this.resolveMode());
                };
                if (this.mq.addEventListener)
                    this.mq.addEventListener('change', onChange);
                else
                    this.mq.addListener(onChange);
            }
            return;
        }
        this.setMode(next);
    }
    setMode(mode) {
        if (mode === this.mode && document.documentElement.getAttribute('data-shell') === mode)
            return;
        this.mode = mode;
        document.documentElement.setAttribute('data-shell', mode);
        this.wm?.setMode(mode);
        if (mode === 'mobile') {
            this.mobile?.sync();
        }
        else {
            this.mobile?.closeRecents();
            this.mobile?.resetHistory();
        }
        this.desktop?.onWindowsChanged();
    }
    shellMode() {
        return this.mode;
    }
    shellPreference() {
        return osState.settings.shell;
    }
    setShellPreference(pref) {
        void osState.update({ shell: pref });
        this.setMode(this.resolveMode());
    }
    /* ================================================================== */
    /* Global events                                                      */
    /* ================================================================== */
    bindGlobalEvents() {
        document.addEventListener('lume:toggle-theme', () => {
            void osState.update({ theme: osState.settings.theme === 'dark' ? 'light' : 'dark' });
        });
        document.addEventListener('lume:wallpaper', (e) => {
            const value = e.detail;
            if (typeof value === 'string' && value) {
                osState.setWallpaper(value);
                this.notify('Wallpaper changed', '', 'success');
            }
        });
        /* Keep the viewport honest: no horizontal overflow anywhere. */
        window.addEventListener('resize', () => {
            if (osState.settings.shell === 'auto')
                this.setMode(this.resolveMode());
        });
    }
    onWindowsChanged() {
        this.desktop?.onWindowsChanged();
        this.mobile?.sync();
    }
    /* ================================================================== */
    /* Installed web packages                                             */
    /* ================================================================== */
    registerInstalled(info) {
        const manifest = {
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
    webAppInstance(info) {
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
            mount(ctx) {
                const frame = document.createElement('iframe');
                frame.className = 'browser__frame';
                frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
                frame.title = info.name;
                ctx.window.body.appendChild(frame);
                const onMessage = (e) => {
                    if (e.source !== frame.contentWindow)
                        return;
                    const msg = e.data;
                    if (!msg || msg.type !== 'lume:call')
                        return;
                    void kernel.bridgeCall(msg.method ?? '', msg.args ?? [], frame);
                };
                window.addEventListener('message', onMessage);
                ctx.window.el.addEventListener('lume:unmount', () => window.removeEventListener('message', onMessage));
                /* The package is served from OPFS by the service worker. */
                void kernel.swReady.then(() => {
                    frame.src = appUrl(`apps/installed/${info.id}/${info.entry ?? 'index.html'}`);
                });
            },
        };
    }
    async bridgeCall(method, args, frame) {
        const reply = (result) => frame.contentWindow?.postMessage({ type: 'lume:result', result }, '*');
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
        }
        catch (err) {
            reply({ error: err.message });
        }
    }
    /* ================================================================== */
    /* KernelApi                                                          */
    /* ================================================================== */
    notify(title, body = '', kind = 'info') {
        toast(title, body, kind);
        this.desktop?.pushNotification(title, body, kind);
        bus.emit('toast', { title, body, kind });
    }
    openApp(id, args = {}) {
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
        let unmount = instance.unmount?.bind(instance);
        this.wm.create(id, reg.manifest, (handle) => instance.mount({ window: handle, args, kernel: this }), () => {
            unmount?.();
            unmount = undefined;
        }, args);
        if (this.mode === 'mobile') {
            this.mobile.notifyAppOpened();
            this.mobile.pushHistory();
        }
    }
    isServerOnline() {
        return this.api.online;
    }
    async refreshServerStatus() {
        this.api.base = osState.settings.serverUrl || appBasePath();
        this.api.token = osState.settings.token;
        this.vfs.preferServer = osState.settings.preferServer;
        const online = await this.api.health();
        bus.emit('server:status', { online });
        this.desktop?.setServerStatus(online);
        return online;
    }
    async installWebApp(info) {
        this.installed.set(info.id, info);
        try {
            await idb.put(STORE_REGISTRY, info);
        }
        catch {
            /* persistence optional */
        }
        this.registerInstalled(info);
        this.desktop.renderIcons();
        this.mobile.renderHome();
        void this.desktop.refreshStorage();
    }
    async uninstallApp(id) {
        this.installed.delete(id);
        try {
            await idb.delete(STORE_REGISTRY, id);
        }
        catch {
            /* ignore */
        }
        registry.unregister(id);
        this.wm.closeByApp(id);
        try {
            await localFs.remove(`/${id}`);
        }
        catch {
            /* ignore */
        }
        this.desktop.renderIcons();
        this.mobile.renderHome();
    }
    /* ================================================================== */
    /* Diagnostics                                                        */
    /* ================================================================== */
    async diagnostics() {
        const items = [];
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
            detail: tier === 'opfs'
                ? 'OPFS — fast, large capacity.'
                : tier === 'idb'
                    ? 'IndexedDB fallback — OPFS is unavailable in this browser, so files are stored in IndexedDB.'
                    : 'Unavailable — files cannot be saved locally in this browser.',
        });
        let idbOk = true;
        try {
            await idb.open();
        }
        catch {
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
        }
        catch {
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
    installedApps() {
        return Array.from(this.installed.values());
    }
    /* ================================================================== */
    /* DesktopHost                                                        */
    /* ================================================================== */
    launch(appId, args = {}) {
        this.openApp(appId, args);
    }
    manifests() {
        return registry.desktopApps();
    }
    serverOnline() {
        return this.api.online;
    }
    async serverInfo() {
        if (!this.api.online)
            return null;
        try {
            return await this.api.systemInfo();
        }
        catch {
            return null;
        }
    }
    storageUsage() {
        return this.vfs.usage();
    }
    installedIds() {
        return Array.from(this.installed.keys());
    }
    uninstall(appId) {
        void this.uninstallApp(appId).then(() => this.notify('Uninstalled', appId, 'success'));
    }
    sourceUrl() {
        return this.api.sourceExportUrl();
    }
    windows() {
        return this.wm.entries();
    }
    activeWindowId() {
        return this.wm.activeWindowId();
    }
    focusWindow(id) {
        this.wm.focus(id);
    }
    closeWindow(id) {
        this.wm.close(id);
    }
    blurWindows() {
        this.wm.blur();
    }
    /* ================================================================== */
    /* Public API + PWA                                                   */
    /* ================================================================== */
    exposeGlobalApi() {
        const kernel = this;
        const LumeOS = {
            version: this.version,
            shell: {
                mode: () => kernel.shellMode(),
                preference: () => kernel.shellPreference(),
                setPreference: (p) => kernel.setShellPreference(p),
            },
            fs: {
                read: (p) => kernel.vfs.readText(p),
                write: (p, c) => kernel.vfs.writeText(p, c),
                list: (p) => kernel.vfs.list(p),
                mkdir: (p) => kernel.vfs.mkdir(p),
                remove: (p) => kernel.vfs.remove(p),
            },
            notifications: {
                send: (title, body) => kernel.notify(title, body ?? ''),
            },
            apps: {
                open: (id) => kernel.openApp(id),
                installed: () => kernel.installedApps(),
            },
            system: {
                info: () => kernel.api.systemInfo(),
                packages: () => kernel.api.listPackages(),
            },
        };
        window.LumeOS = LumeOS;
    }
    registerServiceWorker() {
        if (!('serviceWorker' in navigator))
            return;
        const register = () => {
            this.swReady = navigator.serviceWorker
                .register(appUrl('service-worker.js'))
                .then(() => navigator.serviceWorker.ready.then(() => undefined))
                .catch((err) => {
                console.warn('[LumeOS] service worker failed', err);
            });
        };
        if (document.readyState === 'complete')
            register();
        else
            window.addEventListener('load', register, { once: true });
    }
    handleLaunchParams() {
        const params = new URLSearchParams(location.search);
        const app = params.get('app');
        if (app)
            this.openApp(app);
        const open = params.get('open');
        if (open)
            this.openApp('notes', { path: open });
    }
}
/* ---------------------------------------------------------------------- */
const kernel = new LumeKernel();
kernel.boot().catch((err) => {
    console.error('[LumeOS] boot failed', err);
    boot(`Boot failed: ${err.message}`, 100);
    toast('Boot failed', err.message, 'error');
});
export { kernel };
