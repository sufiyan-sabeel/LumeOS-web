/*
 * LumeOS - desktop/desktop.ts
 * The desktop surface: wallpaper, icon grid, start menu, taskbar and tray.
 */

import type { AppManifest } from './types.js';
import { bus } from './events.js';

export interface DesktopHost {
  launch(appId: string, args?: Record<string, unknown>): void;
  manifests(): AppManifest[];
  serverOnline(): boolean;
  storageUsage(): Promise<{ usage: number; quota: number }>;
  installedIds(): string[];
  uninstall(appId: string): void;
  sourceUrl(): string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export class Desktop {
  private iconsEl: HTMLElement;
  private taskbar: HTMLElement;
  private startMenu: HTMLElement;
  private startGrid: HTMLElement;
  private startSearch: HTMLInputElement;
  private trayServer!: HTMLElement;
  private trayStorage!: HTMLElement;
  private clock!: HTMLElement;
  private open = false;

  constructor(private host: DesktopHost) {
    this.iconsEl = document.getElementById('desktop-icons') as HTMLElement;
    this.taskbar = document.getElementById('taskbar') as HTMLElement;
    this.startMenu = document.getElementById('start-menu') as HTMLElement;

    this.startSearch = document.createElement('input');
    this.startSearch.type = 'text';
    this.startSearch.placeholder = 'Search apps…';

    this.startGrid = document.createElement('div');
    this.startGrid.className = 'start-menu__grid';

    this.buildTaskbar();
    this.buildStartMenu();
  }

  /* ------------------------------------------------------------------ */
  mount(): void {
    this.renderIcons();
    this.renderStartGrid('');
    this.startClock();
    void this.refreshStorage();
    bus.on('server:status', ({ online }) => this.setServerStatus(online));
  }

  /* ------------------------------------------------------------------ */
  private buildTaskbar(): void {
    const start = document.createElement('button');
    start.className = 'tb-start';
    start.title = 'Start';
    start.textContent = '◆';
    start.onclick = (e) => {
      e.stopPropagation();
      this.toggleStart();
    };

    const tasks = document.createElement('div');
    tasks.className = 'tb-tasks';
    tasks.id = 'tb-tasks';

    const tray = document.createElement('div');
    tray.className = 'tb-tray';

    this.trayServer = document.createElement('span');
    this.trayServer.className = 'tb-tray__item';
    this.trayServer.innerHTML = '<span class="badge badge--off">server</span>';

    this.trayStorage = document.createElement('span');
    this.trayStorage.className = 'tb-tray__item';

    this.clock = document.createElement('div');
    this.clock.className = 'tb-clock';

    tray.append(this.trayServer, this.trayStorage, this.clock);
    this.taskbar.append(start, tasks, tray);
  }

  private buildStartMenu(): void {
    const searchWrap = document.createElement('div');
    searchWrap.className = 'start-menu__search';
    searchWrap.appendChild(this.startSearch);

    const footer = document.createElement('div');
    footer.className = 'start-menu__footer';

    const exportBtn = document.createElement('button');
    exportBtn.textContent = '⬇ Source';
    exportBtn.onclick = () => window.open(this.host.sourceUrl(), '_blank');

    const reload = document.createElement('button');
    reload.textContent = '⟳ Reload OS';
    reload.onclick = () => location.reload();

    const spacer = document.createElement('div');
    spacer.className = 'spacer';

    footer.append(exportBtn, reload, spacer);

    this.startMenu.append(searchWrap, this.startGrid, footer);

    this.startSearch.addEventListener('input', () => {
      this.renderStartGrid(this.startSearch.value);
    });
    document.addEventListener('click', (e) => {
      if (!this.open) return;
      const t = e.target as Node;
      if (this.startMenu.contains(t)) return;
      if ((t as HTMLElement).closest('.tb-start')) return;
      this.toggleStart(false);
    });
  }

  private toggleStart(force?: boolean): void {
    this.open = force ?? !this.open;
    this.startMenu.hidden = !this.open;
    if (this.open) {
      this.renderStartGrid(this.startSearch.value);
      setTimeout(() => this.startSearch.focus(), 40);
    }
  }

  /* ------------------------------------------------------------------ */
  renderIcons(): void {
    this.iconsEl.innerHTML = '';
    for (const m of this.host.manifests()) {
      const icon = document.createElement('button');
      icon.className = 'icon';
      icon.title = m.description ?? m.name;

      const glyph = document.createElement('div');
      glyph.className = 'icon__glyph';
      glyph.textContent = m.glyph;

      const label = document.createElement('div');
      label.className = 'icon__label';
      label.textContent = m.name;

      icon.append(glyph, label);
      icon.ondblclick = () => this.host.launch(m.id);
      icon.onclick = () => this.host.launch(m.id);
      icon.oncontextmenu = (e) => {
        e.preventDefault();
        if (this.host.installedIds().includes(m.id)) {
          if (confirm(`Uninstall ${m.name}?`)) this.host.uninstall(m.id);
        }
      };
      this.iconsEl.appendChild(icon);
    }
  }

  private renderStartGrid(filter: string): void {
    this.startGrid.innerHTML = '';
    const f = filter.trim().toLowerCase();
    const apps = this.host
      .manifests()
      .filter((m) => !f || m.name.toLowerCase().includes(f) || m.id.includes(f));

    if (apps.length === 0) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.textContent = 'No matching apps';
      none.style.gridColumn = '1 / -1';
      this.startGrid.appendChild(none);
      return;
    }

    for (const m of apps) {
      const item = document.createElement('button');
      item.className = 'start-app';
      const g = document.createElement('div');
      g.className = 'start-app__glyph';
      g.textContent = m.glyph;
      const n = document.createElement('div');
      n.textContent = m.name;
      item.append(g, n);
      item.onclick = () => {
        this.toggleStart(false);
        this.host.launch(m.id);
      };
      this.startGrid.appendChild(item);
    }
  }

  private startClock(): void {
    const tick = (): void => {
      const d = new Date();
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const date = d.toLocaleDateString([], { day: '2-digit', month: 'short' });
      this.clock.innerHTML = `<div>${time}</div><div class="muted">${date}</div>`;
    };
    tick();
    setInterval(tick, 15000);
  }

  setServerStatus(online: boolean): void {
    this.trayServer.innerHTML = `<span class="badge ${online ? 'badge--ok' : 'badge--off'}">${online ? 'server online' : 'offline'}</span>`;
  }

  async refreshStorage(): Promise<void> {
    try {
      const { usage, quota } = await this.host.storageUsage();
      this.trayStorage.textContent = quota > 0 ? `${fmtBytes(usage)} / ${fmtBytes(quota)}` : '';
    } catch {
      this.trayStorage.textContent = '';
    }
  }
}
