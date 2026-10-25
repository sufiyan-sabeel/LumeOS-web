/*
 * LumeOS - apps/files/app.ts
 * Dual-source file explorer: the C backend's data/files/ volume and the
 * browser-local OPFS volume, side by side on desktop and switchable on
 * mobile. Every operation performs a real read, write or delete on the
 * selected tier and reports the actual outcome.
 */

import type { AppContext, FileEntry, LumeApp } from '../../desktop/types.js';
import { confirmDialog, promptDialog } from '../../components/modal.js';
import { iconEl, mountIcon } from '../../components/icons.js';

type Source = 'server' | 'opfs';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const TEXT_EXT = /\.(md|txt|json|log|csv|js|ts|css|html|xml|yml|yaml)$/i;

export const filesApp: LumeApp = {
  manifest: {
    id: 'files',
    name: 'Files',
    icon: 'folder',
    description: 'Browse the server volume and offline storage, and manage files.',
    category: 'system',
    type: 'builtin',
    width: 940,
    height: 560,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const vfs = ctx.kernel.vfs;

    const app = el('div', 'app');
    const toolbar = el('div', 'app__toolbar');
    const tabs = el('div', 'files__tabs');
    const panes = el('div', 'files__panes');
    const status = el('div', 'app__status');
    app.append(toolbar, tabs, panes, status);
    ctx.window.body.appendChild(app);

    interface Pane {
      source: Source;
      path: string;
      root: HTMLElement;
      crumb: HTMLElement;
      list: HTMLElement;
      count: HTMLElement;
    }

    const makePane = (source: Source): Pane => {
      const root = el('div', 'files__pane');
      root.dataset.source = source;

      const head = el('div', 'files__head');
      const title = el('span');
      title.appendChild(iconEl(source === 'server' ? 'cloud' : 'drive', 13));
      const titleText = el('span', undefined, source === 'server' ? 'Server volume' : 'Offline storage');
      title.append(document.createTextNode(' '), titleText);
      const count = el('span', undefined, '');
      head.append(title, count);

      const crumb = el('div', 'files__crumb', '/');
      const list = el('div', 'files__list');
      list.setAttribute('role', 'list');
      root.append(head, crumb, list);
      panes.appendChild(root);

      return { source, path: '/', root, crumb, list, count };
    };

    const serverPane = makePane('server');
    const offlinePane = makePane('opfs');

    /* ---------------- rendering ---------------- */
    const joinPath = (base: string, name: string): string =>
      (base === '/' ? '' : base) + '/' + name;

    const parentOf = (p: string): string => {
      const parts = p.split('/').filter(Boolean);
      parts.pop();
      return '/' + parts.join('/');
    };

    const renderPane = async (pane: Pane): Promise<void> => {
      pane.crumb.textContent = pane.path === '/' ? '/' : pane.path;
      pane.list.replaceChildren();

      let entries: FileEntry[];
      try {
        entries = await vfs.listFrom(pane.source, pane.path);
      } catch (e) {
        const state = el('div', 'state state--error');
        state.appendChild(iconEl('alert', 22, 'state__icon'));
        state.appendChild(el('div', 'state__title', 'Cannot read this location'));
        state.appendChild(el('div', 'state__body', (e as Error).message));
        if (pane.source === 'server') {
          const hint = el('div', 'state__body muted', 'Start the C backend with `make run` to mount the server volume.');
          state.appendChild(hint);
        }
        pane.list.appendChild(state);
        pane.count.textContent = '';
        return;
      }

      pane.count.textContent = `${entries.length} item${entries.length === 1 ? '' : 's'}`;

      if (pane.path !== '/') {
        const up = el('div', 'file-row');
        up.setAttribute('role', 'listitem');
        up.appendChild(iconEl('up', 15, 'file-row__icon'));
        up.appendChild(el('div', 'file-row__name', '..'));
        up.appendChild(el('div', 'file-row__meta', 'parent'));
        up.addEventListener('click', () => {
          pane.path = parentOf(pane.path);
          void renderPane(pane);
        });
        pane.list.appendChild(up);
      }

      if (entries.length === 0) {
        const empty = el('div', 'state');
        empty.appendChild(iconEl('folder', 22, 'state__icon'));
        empty.appendChild(el('div', 'state__title', 'This folder is empty'));
        empty.appendChild(el('div', 'state__body', 'Create a file or folder to get started.'));
        pane.list.appendChild(empty);
        return;
      }

      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));

      for (const e of entries) {
        const row = el('div', `file-row${e.type === 'dir' ? ' is-dir' : ''}`);
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;
        row.appendChild(iconEl(e.type === 'dir' ? 'folder' : 'file', 15, 'file-row__icon'));
        row.appendChild(el('div', 'file-row__name', e.name));
        row.appendChild(el('div', 'file-row__meta', e.type === 'dir' ? 'folder' : fmtSize(e.size)));

        const open = (): void => {
          if (e.type === 'dir') {
            pane.path = joinPath(pane.path, e.name);
            void renderPane(pane);
          } else if (TEXT_EXT.test(e.name)) {
            ctx.kernel.openApp('notes', { path: joinPath(pane.path, e.name) });
          } else {
            ctx.kernel.notify('Cannot preview', `${e.name} is not a text file`, 'info');
          }
        };

        row.addEventListener('click', open);
        row.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            open();
          }
        });
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          void rowMenu(pane, e, ev.clientX, ev.clientY);
        });
        pane.list.appendChild(row);
      }
    };

    const renderAll = (): void => {
      void renderPane(serverPane);
      void renderPane(offlinePane);
      renderStatus();
    };

    /* ---------------- operations ---------------- */
    const createFile = async (pane: Pane): Promise<void> => {
      const name = await promptDialog('New file', 'File name', 'untitled.txt');
      if (!name) return;
      const path = joinPath(pane.path, name);
      try {
        await vfs.writeFrom(pane.source, path, '');
        ctx.kernel.notify('File created', path, 'success');
        await renderPane(pane);
      } catch (e) {
        ctx.kernel.notify('Could not create file', (e as Error).message, 'error');
      }
    };

    const createFolder = async (pane: Pane): Promise<void> => {
      const name = await promptDialog('New folder', 'Folder name', 'New folder');
      if (!name) return;
      const path = joinPath(pane.path, name);
      try {
        await vfs.mkdirFrom(pane.source, path);
        ctx.kernel.notify('Folder created', path, 'success');
        await renderPane(pane);
      } catch (e) {
        ctx.kernel.notify('Could not create folder', (e as Error).message, 'error');
      }
    };

    const removeEntry = async (pane: Pane, entry: FileEntry): Promise<void> => {
      const path = joinPath(pane.path, entry.name);
      const ok = await confirmDialog(
        `Delete ${entry.type === 'dir' ? 'folder' : 'file'}`,
        `“${entry.name}” will be permanently deleted from ${
          pane.source === 'server' ? 'the server volume' : 'offline storage'
        }.`
      );
      if (!ok) return;
      try {
        await vfs.removeFrom(pane.source, path);
        ctx.kernel.notify('Deleted', path, 'success');
        await renderPane(pane);
      } catch (e) {
        ctx.kernel.notify('Delete failed', (e as Error).message, 'error');
      }
    };

    const renameEntry = async (pane: Pane, entry: FileEntry): Promise<void> => {
      const name = await promptDialog('Rename', 'New name', entry.name);
      if (!name || name === entry.name) return;
      const from = joinPath(pane.path, entry.name);
      const to = joinPath(pane.path, name);
      try {
        if (entry.type === 'file') {
          const content = await vfs.readFrom(pane.source, from);
          await vfs.writeFrom(pane.source, to, content);
        } else {
          await vfs.mkdirFrom(pane.source, to);
        }
        await vfs.removeFrom(pane.source, from);
        ctx.kernel.notify('Renamed', `${entry.name} → ${name}`, 'success');
        await renderPane(pane);
      } catch (e) {
        ctx.kernel.notify('Rename failed', (e as Error).message, 'error');
      }
    };

    const rowMenu = async (pane: Pane, entry: FileEntry, x: number, y: number): Promise<void> => {
      const menu = el('div', 'ctx-menu');
      menu.setAttribute('role', 'menu');
      const items: Array<[string, string, () => void, boolean?]> = [
        ['Open', entry.type === 'dir' ? 'folder' : 'file', () => {
          if (entry.type === 'dir') {
            pane.path = joinPath(pane.path, entry.name);
            void renderPane(pane);
          } else if (TEXT_EXT.test(entry.name)) {
            ctx.kernel.openApp('notes', { path: joinPath(pane.path, entry.name) });
          }
        }],
        ['Rename', 'file', () => void renameEntry(pane, entry)],
        ['Delete', 'trash', () => void removeEntry(pane, entry), true],
      ];
      for (const [label, icon, action, danger] of items) {
        const b = el('button', `ctx-menu__item${danger ? ' danger' : ''}`);
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.appendChild(iconEl(icon, 15));
        b.appendChild(el('span', undefined, label));
        b.addEventListener('click', () => {
          menu.remove();
          action();
        });
        menu.appendChild(b);
      }
      document.body.appendChild(menu);
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
      const close = (ev: PointerEvent): void => {
        if (!menu.contains(ev.target as Node)) {
          menu.remove();
          document.removeEventListener('pointerdown', close, true);
        }
      };
      setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    };

    /* ---------------- toolbar + tabs ---------------- */
    const mkBtn = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
      const b = el('button');
      b.type = 'button';
      b.appendChild(iconEl(icon, 15));
      b.appendChild(el('span', undefined, label));
      b.addEventListener('click', onClick);
      return b;
    };

    const activePane = (): Pane => (serverPane.root.hidden ? offlinePane : serverPane);

    toolbar.append(
      mkBtn('refresh', 'Refresh', renderAll),
      mkBtn('plus', 'New file', () => void createFile(activePane())),
      mkBtn('folderPlus', 'New folder', () => void createFolder(activePane())),
      mkBtn('download', 'Source', () => window.open(ctx.kernel.api.sourceExportUrl(), '_blank'))
    );

    /* Mobile: a segmented control chooses which volume is shown. */
    const mkTab = (label: string, pane: Pane, other: Pane): HTMLButtonElement => {
      const b = el('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        pane.root.hidden = false;
        other.root.hidden = true;
        serverTab.setAttribute('aria-pressed', String(pane === serverPane));
        offlineTab.setAttribute('aria-pressed', String(pane === offlinePane));
        renderStatus();
      });
      return b;
    };
    const serverTab = mkTab('Server', serverPane, offlinePane);
    const offlineTab = mkTab('Offline', offlinePane, serverPane);
    serverTab.setAttribute('aria-pressed', 'true');
    offlineTab.setAttribute('aria-pressed', 'false');
    tabs.append(serverTab, offlineTab);

    const renderStatus = (): void => {
      status.replaceChildren();
      const online = ctx.kernel.isServerOnline();
      status.appendChild(iconEl(online ? 'cloud' : 'cloudOff', 13));
      status.appendChild(
        el('span', undefined, online ? 'C backend online' : 'C backend offline — server volume unavailable')
      );
      status.appendChild(el('span', 'spacer'));
      status.appendChild(el('span', undefined, `Server: ${serverPane.path}`));
      status.appendChild(el('span', undefined, `Offline: ${offlinePane.path}`));
    };

    renderAll();
  },
};
