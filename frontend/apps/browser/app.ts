/*
 * LumeOS - apps/browser/app.ts
 * Embedded viewer that renders local VFS documents (via blob URLs) and
 * external URLs inside a sandboxed iframe.
 */

import type { LumeApp, AppContext } from '../../desktop/types.js';

export const browserApp: LumeApp = {
  manifest: {
    id: 'browser',
    name: 'Browser',
    glyph: '🌐',
    description: 'View local VFS pages and external URLs.',
    category: 'media',
    type: 'builtin',
    width: 900,
    height: 620,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const app = document.createElement('div');
    app.className = 'app';

    const toolbar = document.createElement('div');
    toolbar.className = 'app__toolbar';

    const back = document.createElement('button');
    back.textContent = '←';
    const reload = document.createElement('button');
    reload.textContent = '⟳';

    const omni = document.createElement('input');
    omni.className = 'browser__omni';
    omni.type = 'text';
    omni.placeholder = 'Enter URL (https://…) or local path (/index.html)';
    omni.value = (ctx.args.url as string) ?? '/index.html';

    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Go';

    toolbar.append(back, reload, omni, go);

    const frame = document.createElement('iframe');
    frame.className = 'browser__frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');

    const status = document.createElement('div');
    status.className = 'app__status';

    app.append(toolbar, frame, status);
    ctx.window.body.appendChild(app);

    const history: string[] = [];

    const setStatus = (msg: string): void => {
      status.textContent = msg;
    };

    const navigate = async (raw: string): Promise<void> => {
      const target = raw.trim();
      if (!target) return;
      history.push(target);

      if (target.startsWith('/')) {
        /* Local VFS document -> render through the virtual file system. */
        try {
          const html = await ctx.kernel.vfs.readText(target);
          const blob = new Blob([html], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          frame.src = url;
          ctx.window.setTitle(`Browser — ${target}`);
          setStatus(`Local: ${target}`);
        } catch (e) {
          setStatus(`Local load failed: ${(e as Error).message}`);
        }
        return;
      }

      const url = /^https?:\/\//i.test(target) ? target : `https://${target}`;
      frame.src = url;
      ctx.window.setTitle(`Browser — ${url}`);
      setStatus(`External: ${url} (sandboxed)`);
    };

    go.onclick = () => void navigate(omni.value);
    omni.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void navigate(omni.value);
    });
    reload.onclick = () => void navigate(omni.value);
    back.onclick = () => {
      if (history.length > 1) {
        history.pop();
        void navigate(history.pop() as string);
      }
    };

    void navigate(omni.value);
  },
};
