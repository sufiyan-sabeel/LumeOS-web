/*
 * LumeOS - apps/files/app.ts
 * Dual-pane file explorer: server-backed data/files/ on the left and the
 * offline OPFS volume on the right.
 */

import type { LumeApp, AppContext, FileEntry } from '../../desktop/types.js';

interface PaneState {
  path: string;
  root: HTMLElement;
  crumb: HTMLElement;
  list: HTMLElement;
  server: boolean;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const filesApp: LumeApp = {
  manifest: {
    id: 'files',
    name: 'Files',
    glyph: '🗂️',
    description: 'Browse the server virtual disk and offline OPFS storage.',
    category: 'system',
    type: 'builtin',
    width: 900,
    height: 540,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const { body } = ctx.window;

    const app = el('div', 'app');
    const toolbar = el('div', 'app__toolbar');
    const panes = el('div', 'files__panes');
    const status = el('div', 'app__status');

    const mkBtn = (label: string, fn: () => void): HTMLButtonElement => {
      const b = el('button', undefined, label) as HTMLButtonElement;
      b.onclick = fn;
      return b;
    };

    /* -------- panes -------- */
    const makePane = (server: boolean): PaneState => {
      const root = el('div', 'files__pane');
      const head = el('div', 'files__head');
      head.appendChild(el('span', undefined, server ? 'Server · data/files' : 'Offline · OPFS'));
      const crumb = el('div', 'files__crumb', '/');
      const list = el('div', 'files__list');
      root.append(head, crumb, list);
      panes.appendChild(root);
      return { path: '/', root, crumb, list, server };
    };

    const serverPane = makePane(true);
    const localPane = makePane(false);

    const vfsServer = ctx.kernel.vfs;
    const vfsLocal = ctx.kernel.vfs;

    const renderPane = async (pane: PaneState): Promise<void> => {
      pane.crumb.textContent = pane.path;
      pane.list.innerHTML = '';
      try {
        /* For the offline pane we read from OPFS directly by temporarily
         * disabling server preference. */
        let entries: FileEntry[];
        if (pane.server) {
          entries = await vfsServer.list(pane.path);
        } else {
          entries = await localList(pane.path);
        }

        if (pane.path !== '/') {
          const up = el('div', 'file-row');
          up.append(el('span', undefined, '⬆'), el('div', 'file-row__name', '..'));
          up.onclick = () => {
            const parts = pane.path.split('/').filter(Boolean);
            parts.pop();
            pane.path = '/' + parts.join('/');
            void renderPane(pane);
          };
          pane.list.appendChild(up);
        }

        if (entries.length === 0) {
          pane.list.appendChild(el('div', 'muted', '(empty)'));
        }
        for (const e of entries) {
          const row = el('div', 'file-row');
          row.append(
            el('span', undefined, e.type === 'dir' ? '📁' : '📄'),
            el('div', 'file-row__name', e.name),
            el('div', 'file-row__meta', e.type === 'dir' ? 'dir' : fmtSize(e.size))
          );
          row.onclick = () => {
            if (e.type === 'dir') {
              pane.path = (pane.path === '/' ? '' : pane.path) + '/' + e.name;
              void renderPane(pane);
            } else if (e.name.match(/\.(md|txt|json|log|csv)$/i)) {
              ctx.kernel.openApp('notes', {
                path: (pane.path === '/' ? '' : pane.path) + '/' + e.name,
                server: pane.server,
              });
            }
          };
          pane.list.appendChild(row);
        }
      } catch (err) {
        pane.list.appendChild(el('div', 'muted', `unavailable: ${(err as Error).message}`));
      }
    };

    /* OPFS-only listing helper (the VFS prefers the server when online). */
    const localList = async (path: string): Promise<FileEntry[]> => {
      try {
        const root = await (navigator.storage as unknown as {
          getDirectory: () => Promise<FileSystemDirectoryHandle>;
        }).getDirectory();
        const segs = path.split('/').filter(Boolean);
        let dir: FileSystemDirectoryHandle = root;
        for (const s of segs) dir = await dir.getDirectoryHandle(s);
        const out: FileEntry[] = [];
        const iter = (dir as unknown as {
          entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
        }).entries();
        for await (const [name, handle] of iter) {
          if (handle.kind === 'file') {
            const f = await (handle as FileSystemFileHandle).getFile();
            out.push({ name, type: 'file', size: f.size, mtime: 0 });
          } else {
            out.push({ name, type: 'dir', size: 0, mtime: 0 });
          }
        }
        return out;
      } catch {
        return [];
      }
    };

    /* -------- toolbar -------- */
    toolbar.append(
      mkBtn('⟳ Refresh', () => {
        void renderPane(serverPane);
        void renderPane(localPane);
      }),
      mkBtn('＋ New file', async () => {
        const name = prompt('New file name (server):');
        if (!name) return;
        const p = (serverPane.path === '/' ? '' : serverPane.path) + '/' + name;
        try {
          await vfsServer.writeText(p, '');
          ctx.kernel.notify('Created', p, 'success');
          void renderPane(serverPane);
        } catch (e) {
          ctx.kernel.notify('Create failed', (e as Error).message, 'error');
        }
      }),
      mkBtn('📁 New folder', async () => {
        const name = prompt('New folder name (server):');
        if (!name) return;
        const p = (serverPane.path === '/' ? '' : serverPane.path) + '/' + name;
        try {
          await vfsServer.mkdir(p);
          void renderPane(serverPane);
        } catch (e) {
          ctx.kernel.notify('mkdir failed', (e as Error).message, 'error');
        }
      }),
      mkBtn('🗑 Delete', async () => {
        const name = prompt('Delete path (server, relative to current):');
        if (!name) return;
        const p = (serverPane.path === '/' ? '' : serverPane.path) + '/' + name;
        try {
          await vfsServer.remove(p);
          void renderPane(serverPane);
        } catch (e) {
          ctx.kernel.notify('Delete failed', (e as Error).message, 'error');
        }
      }),
      mkBtn('⬇ Download LumeOS Source (.tar.gz)', () => {
        window.open(ctx.kernel.api.sourceExportUrl(), '_blank');
      })
    );

    app.append(toolbar, panes, status);
    body.appendChild(app);

    status.append(
      el('span', undefined, 'Server:'),
      el('span', undefined, ctx.kernel.isServerOnline() ? 'online' : 'offline'),
      el('span', undefined, `· v${'1.0.0'}`)
    );

    void renderPane(serverPane);
    void renderPane(localPane);
  },
};
