/*
 * LumeOS - desktop/desktop.ts
 * The desktop shell: status bar, icon grid, dock, application launcher,
 * notification centre with quick settings, and context menus.
 */

import type { AppManifest, DiagItem, ShellMode, ShellPreference, SystemInfo } from './types.js';
import { bus } from './events.js';
import { iconEl, mountIcon, iconHtml } from '../components/icons.js';

export interface WindowEntry {
  id: string;
  appId: string;
  manifest: AppManifest;
  minimized: boolean;
}

export interface DesktopHost {
  launch(appId: string, args?: Record<string, unknown>): void;
  manifests(): AppManifest[];
  serverOnline(): boolean;
  serverInfo(): Promise<SystemInfo | null>;
  storageUsage(): Promise<{ usage: number; quota: number }>;
  installedIds(): string[];
  uninstall(appId: string): void;
  sourceUrl(): string;
  windows(): WindowEntry[];
  activeWindowId(): string | null;
  focusWindow(id: string): void;
  closeWindow(id: string): void;
  /** Mobile only: return to the home screen, keeping apps running. */
  blurWindows?(): void;
  shellPreference(): ShellPreference;
  setShellPreference(pref: ShellPreference): void;
  shellMode(): ShellMode;
  diagnostics(): Promise<DiagItem[]>;
}

export interface Notice {
  title: string;
  body: string;
  kind: 'info' | 'success' | 'error';
  time: number;
}

export /* Applications pinned to the dock on every desktop session. */
const PINNED_DOCK = ['files', 'terminal', 'notes', 'settings', 'app-store'];

export const WALLPAPERS: Array<{ name: string; value: string }> = [
  {
    name: 'Midnight',
    value:
      'radial-gradient(1100px 720px at 18% 8%, #14213d 0%, transparent 58%),' +
      'radial-gradient(900px 640px at 84% 92%, #2a1d3d 0%, transparent 52%),' +
      'linear-gradient(168deg, #05060a 0%, #0a0b10 100%)',
  },
  {
    name: 'Graphite',
    value:
      'radial-gradient(1000px 700px at 22% 12%, #1c1c20 0%, transparent 60%),' +
      'linear-gradient(160deg, #0b0b0d 0%, #141417 100%)',
  },
  {
    name: 'Deep teal',
    value:
      'radial-gradient(1000px 700px at 20% 10%, #0e2b2e 0%, transparent 58%),' +
      'radial-gradient(900px 600px at 86% 90%, #10222f 0%, transparent 54%),' +
      'linear-gradient(160deg, #04080a 0%, #080f13 100%)',
  },
  {
    name: 'Ember',
    value:
      'radial-gradient(1000px 700px at 78% 14%, #2c1a12 0%, transparent 58%),' +
      'linear-gradient(160deg, #0a0705 0%, #140d08 100%)',
  },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export class Desktop {
  private statusbar: HTMLElement;
  private iconsEl: HTMLElement;
  private dock: HTMLElement;
  private launcher: HTMLElement;
  private wallEl: HTMLElement;

  private notices: Notice[] = [];
  private panel: HTMLElement | null = null;
  private ctxMenu: HTMLElement | null = null;

  private clockEl!: HTMLButtonElement;
  private ctxTitleEl!: HTMLElement;
  private serverBtn!: HTMLButtonElement;
  private notifBtn!: HTMLButtonElement;
  private quickBtn!: HTMLButtonElement;

  constructor(private host: DesktopHost) {
    this.statusbar = document.getElementById('statusbar') as HTMLElement;
    this.iconsEl = document.getElementById('desktop-icons') as HTMLElement;
    this.dock = document.getElementById('dock') as HTMLElement;
    this.launcher = document.getElementById('launcher') as HTMLElement;
    this.wallEl = document.getElementById('wallpaper') as HTMLElement;
  }

  /* ================================================================== */
  mount(): void {
    this.buildStatusbar();
    this.buildDock();
    this.buildLauncher();
    this.renderIcons();
    this.renderDock();
    this.startClock();
    void this.refreshStorage();

    bus.on('server:status', ({ online }) => this.setServerStatus(online));
    bus.on('window:focused', () => this.renderStatusTitle());
    bus.on('app:opened', () => { this.renderDock(); this.renderStatusTitle(); });
    bus.on('app:closed', () => { this.renderDock(); this.renderStatusTitle(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!this.launcher.hidden) { this.toggleLauncher(false); return; }
        if (this.panel) { this.closePanel(); return; }
        if (this.ctxMenu) { this.closeContextMenu(); }
      }
      /* Launcher shortcut: Ctrl/Cmd + Space (or the Super-ish Meta+Space). */
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
        e.preventDefault();
        this.toggleLauncher();
      }
    });

    /* Right-click on the workspace background opens the desktop menu. */
    const workspace = this.wallEl.parentElement as HTMLElement;
    workspace.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.window, .launcher, .side-panel')) return;
      e.preventDefault();
      this.openDesktopMenu(e.clientX, e.clientY);
    });
    workspace.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      if (this.ctxMenu && !this.ctxMenu.contains(t)) this.closeContextMenu();
      if (!this.launcher.hidden && t === this.launcher) this.toggleLauncher(false);
    });
  }

  /* ================================================================== */
  /* Status bar                                                         */
  /* ================================================================== */
  private buildStatusbar(): void {
    this.statusbar.replaceChildren();

    const left = document.createElement('div');
    left.className = 'statusbar__group';
    const brand = document.createElement('span');
    brand.className = 'statusbar__title';
    brand.textContent = 'LumeOS';
    this.ctxTitleEl = document.createElement('span');
    this.ctxTitleEl.className = 'truncate';
    left.append(brand, this.ctxTitleEl);

    const right = document.createElement('div');
    right.className = 'statusbar__group';
    right.style.marginLeft = 'auto';

    this.serverBtn = this.statusButton('cloudOff', 'Server status', () => {
      void this.openPanel('info');
    });

    const storageBtn = this.statusButton('drive', 'Storage', () => {
      void this.openPanel('info');
    });
    storageBtn.dataset.role = 'storage';

    this.notifBtn = this.statusButton('bell', 'Notifications', () => {
      void this.openPanel('notifications');
    });
    this.notifBtn.dataset.role = 'notifications';

    this.quickBtn = this.statusButton('settings', 'Quick settings', () => {
      void this.openPanel('quick');
    });

    this.clockEl = document.createElement('button');
    this.clockEl.type = 'button';
    this.clockEl.className = 'statusbar__btn statusbar__clock';
    this.clockEl.title = 'Date and time';
    this.clockEl.addEventListener('click', () => void this.openPanel('quick'));

    right.append(this.serverBtn, storageBtn, this.notifBtn, this.quickBtn, this.clockEl);
    this.statusbar.append(left, right);
    this.setServerStatus(this.host.serverOnline());
  }

  private statusButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'statusbar__btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(iconEl(icon, 15));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  private startClock(): void {
    const tick = (): void => {
      const d = new Date();
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const date = d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
      this.clockEl.textContent = `${date}  ${time}`;
    };
    tick();
    setInterval(tick, 20000);
  }

  private renderStatusTitle(): void {
    const active = this.host.activeWindowId();
    const entry = this.host.windows().find((w) => w.id === active);
    this.ctxTitleEl.textContent = entry ? `— ${entry.manifest.name}` : '';
  }

  /** Refresh everything that depends on the open-window set. */
  onWindowsChanged(): void {
    this.renderDock();
    this.renderStatusTitle();
  }

  setServerStatus(online: boolean): void {
    this.serverBtn.replaceChildren(
      iconEl(online ? 'cloud' : 'cloudOff', 15),
      document.createTextNode(online ? 'online' : 'offline')
    );
    this.serverBtn.title = online
      ? 'Connected to the LumeOS C backend'
      : 'C backend offline — running from local storage';
    this.serverBtn.dataset.state = online ? 'ok' : 'off';
  }

  async refreshStorage(): Promise<void> {
    try {
      const { usage, quota } = await this.host.storageUsage();
      const btn = this.statusbar.querySelector<HTMLElement>('[data-role="storage"]');
      if (btn) {
        btn.replaceChildren(iconEl('drive', 15), document.createTextNode(quota ? fmtBytes(usage) : '—'));
        btn.title = quota ? `${fmtBytes(usage)} of ${fmtBytes(quota)} used` : 'Storage';
      }
      if (this.panel) this.renderPanelBody();
    } catch {
      /* storage API unavailable */
    }
  }

  /* ================================================================== */
  /* Desktop icons                                                      */
  /* ================================================================== */
  renderIcons(): void {
    this.iconsEl.replaceChildren();
    for (const m of this.host.manifests()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon';
      btn.title = m.description ?? m.name;
      btn.setAttribute('aria-label', `Open ${m.name}`);

      const glyph = document.createElement('div');
      glyph.className = 'icon__glyph';
      if (m.icon) mountIcon(glyph, m.icon, 22);
      else if (m.glyph) glyph.textContent = m.glyph;
      else mountIcon(glyph, 'file', 22);

      const label = document.createElement('div');
      label.className = 'icon__label';
      label.textContent = m.name;

      btn.append(glyph, label);
      btn.addEventListener('click', () => this.host.launch(m.id));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openAppMenu(m, e.clientX, e.clientY);
      });
      this.iconsEl.appendChild(btn);
    }
  }

  /* ================================================================== */
  /* Dock                                                               */
  /* ================================================================== */
  private buildDock(): void {
    this.dock.replaceChildren();

    const launcherBtn = document.createElement('button');
    launcherBtn.type = 'button';
    launcherBtn.className = 'dock__launcher';
    launcherBtn.title = 'Applications (Ctrl+Space)';
    launcherBtn.setAttribute('aria-label', 'Open application launcher');
    launcherBtn.appendChild(iconEl('grid', 20));
    launcherBtn.addEventListener('click', () => this.toggleLauncher());

    const items = document.createElement('div');
    items.className = 'dock__items';
    items.id = 'dock-items';

    this.dock.append(launcherBtn, items);
  }

  renderDock(): void {
    const items = document.getElementById('dock-items');
    if (!items) return;
    items.replaceChildren();

    const entries = this.host.windows();
    const active = this.host.activeWindowId();
    const byApp = new Map(entries.map((e) => [e.appId, e]));
    const manifests = this.host.manifests();
    const shown = new Set<string>();

    const addItem = (m: AppManifest, running: WindowEntry | undefined): void => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dock__item';
      if (running) btn.classList.add('running');
      if (running && running.id === active && !running.minimized) btn.classList.add('active');
      btn.title = running
        ? `${m.name}${running.minimized ? ' (minimised)' : ''}`
        : `Open ${m.name}`;
      btn.setAttribute('aria-label', btn.title);
      if (m.icon) mountIcon(btn, m.icon, 20);
      else if (m.glyph) btn.textContent = m.glyph;
      else mountIcon(btn, 'file', 20);

      btn.addEventListener('click', () => {
        if (running) {
          if (running.id === active && !running.minimized) this.host.closeWindow(running.id);
          else this.host.focusWindow(running.id);
        } else {
          this.host.launch(m.id);
        }
      });
      btn.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (running) this.openWindowMenu(running, ev.clientX, ev.clientY);
        else this.openAppMenu(m, ev.clientX, ev.clientY);
      });
      items.appendChild(btn);
    };

    /* Pinned applications are always one click away, so core apps such as
     * Settings are reachable without hunting through the launcher. */
    for (const id of PINNED_DOCK) {
      const m = manifests.find((x) => x.id === id);
      if (!m) continue;
      addItem(m, byApp.get(id));
      shown.add(id);
    }

    const others = entries.filter((e) => !shown.has(e.appId));
    if (others.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'dock__sep';
      sep.setAttribute('aria-hidden', 'true');
      items.appendChild(sep);
    }
    for (const e of others) addItem(e.manifest, e);
  }

  /* ================================================================== */
  /* Launcher                                                           */
  /* ================================================================== */
  private buildLauncher(): void {
    this.launcher.replaceChildren();

    const panel = document.createElement('div');
    panel.className = 'launcher__panel';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'launcher__search';
    mountIcon(searchWrap, 'search', 16);
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search applications…';
    input.setAttribute('aria-label', 'Search applications');
    input.addEventListener('input', () => this.renderLauncherGrid(input.value));
    searchWrap.appendChild(input);

    const grid = document.createElement('div');
    grid.className = 'launcher__grid';
    grid.id = 'launcher-grid';

    panel.append(searchWrap, grid);
    this.launcher.appendChild(panel);

    this.launcher.addEventListener('pointerdown', (e) => {
      if (e.target === this.launcher) this.toggleLauncher(false);
    });
  }

  toggleLauncher(force?: boolean): void {
    const open = force ?? this.launcher.hidden;
    this.launcher.hidden = !open;
    if (open) {
      this.closePanel();
      this.renderLauncherGrid('');
      const input = this.launcher.querySelector('input');
      if (input) {
        input.value = '';
        setTimeout(() => input.focus(), 30);
      }
    }
  }

  private renderLauncherGrid(filter: string): void {
    const grid = document.getElementById('launcher-grid');
    if (!grid) return;
    grid.replaceChildren();

    const f = filter.trim().toLowerCase();
    const apps = this.host
      .manifests()
      .filter((m) => !f || m.name.toLowerCase().includes(f) || m.id.includes(f));

    if (apps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'state launcher__empty';
      empty.appendChild(iconEl('search', 22, 'state__icon'));
      const t = document.createElement('div');
      t.className = 'state__title';
      t.textContent = 'No applications found';
      const b = document.createElement('div');
      b.className = 'state__body';
      b.textContent = `Nothing matches “${filter.trim()}”. Try a different search.`;
      empty.append(t, b);
      grid.appendChild(empty);
      return;
    }

    for (const m of apps) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'launcher__app';
      btn.title = m.description ?? m.name;

      const glyph = document.createElement('div');
      glyph.className = 'icon__glyph';
      if (m.icon) mountIcon(glyph, m.icon, 20);
      else if (m.glyph) glyph.textContent = m.glyph;
      else mountIcon(glyph, 'file', 22);

      const label = document.createElement('div');
      label.className = 'truncate';
      label.textContent = m.name;

      btn.append(glyph, label);
      btn.addEventListener('click', () => {
        this.toggleLauncher(false);
        this.host.launch(m.id);
      });
      grid.appendChild(btn);
    }
  }

  /* ================================================================== */
  /* Side panel: quick settings / notifications / system info           */
  /* ================================================================== */
  private async openPanel(view: 'quick' | 'notifications' | 'info'): Promise<void> {
    this.toggleLauncher(false);
    if (this.panel && this.panel.dataset.view === view) {
      this.closePanel();
      return;
    }
    this.closePanel();

    const panel = document.createElement('aside');
    panel.className = 'side-panel';
    panel.dataset.view = view;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'System panel');
    (document.querySelector('.workspace') as HTMLElement).appendChild(panel);
    this.panel = panel;
    await this.renderPanelBody();
  }

  private closePanel(): void {
    this.panel?.remove();
    this.panel = null;
  }

  private async renderPanelBody(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const view = panel.dataset.view as 'quick' | 'notifications' | 'info';
    panel.replaceChildren();

    if (view === 'notifications') {
      panel.appendChild(this.heading('Notifications', this.notices.length > 0 ? () => {
        this.notices = [];
        void this.renderPanelBody();
        this.updateNotifBadge();
      } : undefined, 'Clear'));

      if (this.notices.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'state';
        empty.appendChild(iconEl('bell', 22, 'state__icon'));
        const t = document.createElement('div');
        t.className = 'state__title';
        t.textContent = 'No notifications';
        const b = document.createElement('div');
        b.className = 'state__body';
        b.textContent = 'System and application events will appear here.';
        empty.append(t, b);
        panel.appendChild(empty);
        return;
      }

      const list = document.createElement('div');
      list.className = 'notif-list';
      for (const n of this.notices) {
        const item = document.createElement('div');
        item.className = `notif notif--${n.kind}`;
        const iconName = n.kind === 'success' ? 'checkCircle' : n.kind === 'error' ? 'alert' : 'info';
        item.appendChild(iconEl(iconName, 16, 'notif__icon'));
        const body = document.createElement('div');
        const t = document.createElement('div');
        t.className = 'notif__title';
        t.textContent = n.title;
        body.appendChild(t);
        if (n.body) {
          const b = document.createElement('div');
          b.className = 'notif__body';
          b.textContent = n.body;
          body.appendChild(b);
        }
        const time = document.createElement('div');
        time.className = 'notif__time';
        time.textContent = new Date(n.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        body.appendChild(time);
        item.appendChild(body);
        list.appendChild(item);
      }
      panel.appendChild(list);
      return;
    }

    if (view === 'quick') {
      panel.appendChild(this.heading('Quick settings'));

      const grid = document.createElement('div');
      grid.className = 'quick-grid';

      const prefs = this.host.shellPreference();
      grid.appendChild(this.quickTile(
        prefs === 'mobile' ? 'smartphone' : 'monitor',
        'Layout',
        prefs === 'auto' ? 'Automatic' : prefs === 'mobile' ? 'Phone' : 'Desktop',
        false,
        () => {
          const order: ShellPreference[] = ['auto', 'desktop', 'mobile'];
          const next = order[(order.indexOf(this.host.shellPreference()) + 1) % order.length];
          this.host.setShellPreference(next);
          void this.renderPanelBody();
        }
      ));

      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      grid.appendChild(this.quickTile('moon', 'Theme', dark ? 'Dark' : 'Light', false, () => {
        document.dispatchEvent(new CustomEvent('lume:toggle-theme'));
        setTimeout(() => void this.renderPanelBody(), 60);
      }));

      const online = this.host.serverOnline();
      grid.appendChild(this.quickTile('cloud', 'Backend', online ? 'Online' : 'Offline', false, () => {
        void this.host.serverInfo().then(() => this.renderPanelBody());
      }));

      grid.appendChild(this.quickTile('download', 'Downloads', 'Open queue', false, () => {
        this.closePanel();
        this.host.launch('downloads');
      }));

      panel.appendChild(grid);
      panel.appendChild(this.heading('Storage'));
      panel.appendChild(await this.storageBlock());
      return;
    }

    /* info */
    panel.appendChild(this.heading('System', () => void this.host.serverInfo().then(() => this.renderPanelBody()), 'Re-check'));
    const info = await this.host.serverInfo();
    if (!info) {
      const warn = document.createElement('div');
      warn.className = 'state';
      warn.appendChild(iconEl('cloudOff', 22, 'state__icon'));
      const t = document.createElement('div');
      t.className = 'state__title';
      t.textContent = 'C backend offline';
      const b = document.createElement('div');
      b.className = 'state__body';
      b.textContent =
        'Host telemetry needs the LumeOS server. LumeOS still runs from local storage (OPFS).';
      warn.append(t, b);
      panel.appendChild(warn);
    } else {
      const dl = document.createElement('dl');
      dl.className = 'info-grid';
      /* An edge runtime (Cloudflare Worker) cannot observe host CPU, memory,
       * load or disk. Show those as unavailable instead of as zero. */
      const edge = info.telemetry === false;
      const na = '—';
      const rows: Array<[string, string]> = [
        ['OS', `${info.os} ${info.kernel}`],
        ['Architecture', info.arch],
        ['Host', info.hostname],
        ['CPU cores', edge ? na : String(info.cpus)],
        ['Memory free', edge ? na : `${(info.mem_available_kb / 1024).toFixed(0)} MB`],
        ['Load (1m)', edge ? na : info.load1.toFixed(2)],
        ['Disk free', edge ? na : fmtBytes(info.disk_free_bytes)],
        ['LumeOS', `v${info.lume_version}`],
      ];
      if (info.runtime) rows.push(['Runtime', info.runtime]);
      if (info.colo) rows.push(['Edge location', String(info.colo)]);
      if (info.country) rows.push(['Edge country', String(info.country)]);
      for (const [k, v] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        dl.append(dt, dd);
      }
      panel.appendChild(dl);
      if (info.note) {
        const note = document.createElement('div');
        note.className = 'muted';
        note.style.cssText = 'font-size:var(--lume-fs-xs);margin-top:8px;line-height:1.5';
        note.textContent = info.note;
        panel.appendChild(note);
      }
    }

    panel.appendChild(this.heading('Diagnostics'));
    panel.appendChild(await this.diagBlock());

    panel.appendChild(this.heading('Storage'));
    panel.appendChild(await this.storageBlock());
  }

  /** Capability checks with plain-language remediation for each failure. */
  private async diagBlock(): Promise<HTMLElement> {
    const wrap = document.createElement('div');
    wrap.className = 'diag-list';
    let items: DiagItem[] = [];
    try {
      items = await this.host.diagnostics();
    } catch (e) {
      wrap.textContent = `Diagnostics unavailable: ${(e as Error).message}`;
      return wrap;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = `diag ${it.ok ? 'diag--ok' : 'diag--bad'}`;
      row.appendChild(iconEl(it.ok ? 'checkCircle' : 'alert', 15, 'diag__icon'));
      const text = document.createElement('div');
      const label = document.createElement('div');
      label.className = 'diag__label';
      label.textContent = it.label;
      const detail = document.createElement('div');
      detail.className = 'diag__detail';
      detail.textContent = it.detail;
      text.append(label, detail);
      row.appendChild(text);
      wrap.appendChild(row);
    }
    return wrap;
  }

  private heading(text: string, action?: () => void, actionLabel = ''): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    const h = document.createElement('h2');
    h.className = 'side-panel__section-title';
    h.textContent = text;
    row.appendChild(h);
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    row.appendChild(spacer);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = actionLabel;
      b.addEventListener('click', action);
      row.appendChild(b);
    }
    return row;
  }

  private quickTile(icon: string, title: string, sub: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quick-tile';
    b.setAttribute('aria-pressed', String(pressed));
    b.appendChild(iconEl(icon, 18));
    const text = document.createElement('span');
    text.className = 'quick-tile__text';
    const strong = document.createElement('span');
    strong.textContent = title;
    const small = document.createElement('small');
    small.textContent = sub;
    text.append(strong, small);
    b.appendChild(text);
    b.addEventListener('click', onClick);
    return b;
  }

  private async storageBlock(): Promise<HTMLElement> {
    const wrap = document.createElement('div');
    const { usage, quota } = await this.host.storageUsage();
    const pct = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
    const meter = document.createElement('div');
    meter.className = 'meter';
    const fill = document.createElement('span');
    fill.style.width = `${pct}%`;
    meter.appendChild(fill);
    const caption = document.createElement('div');
    caption.className = 'muted';
    caption.style.fontSize = 'var(--lume-fs-xs)';
    caption.style.marginTop = '6px';
    caption.textContent = quota
      ? `${fmtBytes(usage)} used of ${fmtBytes(quota)} (${pct.toFixed(1)}%)`
      : 'Storage estimate unavailable';
    wrap.append(meter, caption);
    return wrap;
  }

  /* ================================================================== */
  /* Notifications                                                      */
  /* ================================================================== */
  pushNotification(title: string, body: string, kind: 'info' | 'success' | 'error'): void {
    this.notices.unshift({ title, body, kind, time: Date.now() });
    if (this.notices.length > 50) this.notices.length = 50;
    this.updateNotifBadge();
    if (this.panel?.dataset.view === 'notifications') void this.renderPanelBody();
  }

  private updateNotifBadge(): void {
    if (!this.notifBtn) return;
    this.notifBtn.replaceChildren(iconEl('bell', 15));
    if (this.notices.length > 0) {
      const dot = document.createElement('span');
      dot.style.cssText =
        'width:6px;height:6px;border-radius:50%;background:var(--lume-accent);display:inline-block';
      this.notifBtn.appendChild(dot);
      this.notifBtn.title = `${this.notices.length} notification(s)`;
    } else {
      this.notifBtn.title = 'Notifications';
    }
  }

  /* ================================================================== */
  /* Context menus                                                      */
  /* ================================================================== */
  private closeContextMenu(): void {
    this.ctxMenu?.remove();
    this.ctxMenu = null;
  }

  private buildContextMenu(items: Array<{ label: string; icon: string; danger?: boolean; onClick: () => void } | 'sep'>): HTMLElement {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.setAttribute('role', 'menu');

    for (const it of items) {
      if (it === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'ctx-menu__sep';
        menu.appendChild(sep);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ctx-menu__item${it.danger ? ' danger' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.appendChild(iconEl(it.icon, 15));
      const span = document.createElement('span');
      span.textContent = it.label;
      b.appendChild(span);
      b.addEventListener('click', () => {
        this.closeContextMenu();
        it.onClick();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    this.ctxMenu = menu;
    return menu;
  }

  private placeMenu(menu: HTMLElement, x: number, y: number): void {
    const r = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 8);
    const py = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = `${Math.max(8, px)}px`;
    menu.style.top = `${Math.max(8, py)}px`;
  }

  private openDesktopMenu(x: number, y: number): void {
    const current = document.documentElement.style.getPropertyValue('--lume-wallpaper');
    const idx = WALLPAPERS.findIndex((w) => w.value === current);
    const next = WALLPAPERS[(idx + 1) % WALLPAPERS.length];

    const menu = this.buildContextMenu([
      { label: `Wallpaper: ${next.name}`, icon: 'image', onClick: () => document.dispatchEvent(new CustomEvent('lume:wallpaper', { detail: next.value })) },
      { label: 'Application launcher', icon: 'grid', onClick: () => this.toggleLauncher(true) },
      'sep',
      { label: 'Settings', icon: 'settings', onClick: () => this.host.launch('settings') },
      { label: 'Download source', icon: 'download', onClick: () => window.open(this.host.sourceUrl(), '_blank') },
      'sep',
      { label: 'Reload LumeOS', icon: 'refresh', onClick: () => location.reload() },
    ]);
    this.placeMenu(menu, x, y);
  }

  private openAppMenu(m: AppManifest, x: number, y: number): void {
    const installed = this.host.installedIds().includes(m.id);
    const items: Array<{ label: string; icon: string; danger?: boolean; onClick: () => void } | 'sep'> = [
      { label: 'Open', icon: 'play', onClick: () => this.host.launch(m.id) },
    ];
    if (installed) {
      items.push('sep');
      items.push({
        label: 'Uninstall',
        icon: 'trash',
        danger: true,
        onClick: () => this.host.uninstall(m.id),
      });
    }
    const menu = this.buildContextMenu(items);
    this.placeMenu(menu, x, y);
  }

  private openWindowMenu(e: WindowEntry, x: number, y: number): void {
    const menu = this.buildContextMenu([
      { label: 'Focus', icon: 'play', onClick: () => this.host.focusWindow(e.id) },
      { label: 'Close', icon: 'close', danger: true, onClick: () => this.host.closeWindow(e.id) },
    ]);
    this.placeMenu(menu, x, y);
  }

  /** Markup helper kept for callers that need an inline icon. */
  static icon(name: string, size = 18): string {
    return iconHtml(name, size);
  }
}
