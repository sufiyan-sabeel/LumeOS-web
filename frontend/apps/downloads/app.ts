/*
 * LumeOS - apps/downloads/app.ts
 * Live view of the download manager: progress, pause/resume/cancel.
 */

import type { LumeApp, AppContext } from '../../desktop/types.js';
import { downloads, type DownloadTask } from '../../desktop/downloads.js';

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export const downloadsApp: LumeApp = {
  manifest: {
    id: 'downloads',
    name: 'Downloads',
    glyph: '⬇️',
    description: 'Download queue, progress and installer trigger.',
    category: 'system',
    type: 'builtin',
    width: 620,
    height: 460,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const app = el('div', 'app');
    const toolbar = el('div', 'app__toolbar');
    const content = el('div', 'app__content');

    const clearBtn = el('button', undefined, 'Clear finished') as HTMLButtonElement;
    clearBtn.onclick = () => downloads.clearFinished();
    toolbar.append(clearBtn);
    app.append(toolbar, content);
    ctx.window.body.appendChild(app);

    const render = (tasks: DownloadTask[]): void => {
      content.innerHTML = '';
      if (tasks.length === 0) {
        content.appendChild(el('p', 'muted', 'No downloads. Install something from the App Store.'));
        return;
      }
      for (const t of tasks) {
        const row = el('div', 'dl-row');
        const top = el('div', 'dl-row__top');
        const left = el('div');
        left.append(el('div', undefined, `${t.kind === 'ai-model' ? '🧠' : t.kind === 'native' ? '💽' : '🌐'}  ${t.name}`));
        left.append(el('div', 'muted', `${fmtBytes(t.loaded)}${t.total ? ` / ${fmtBytes(t.total)}` : ''}  ·  ${t.status}`));
        const actions = el('div', 'row');

        if (t.status === 'active') {
          const pause = el('button', undefined, 'Pause') as HTMLButtonElement;
          pause.onclick = () => downloads.pause(t.id);
          const cancel = el('button', undefined, 'Cancel') as HTMLButtonElement;
          cancel.onclick = () => downloads.cancel(t.id);
          actions.append(pause, cancel);
        } else if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
          const rm = el('button', undefined, 'Remove') as HTMLButtonElement;
          rm.onclick = () => downloads.remove(t.id);
          actions.append(rm);
        }

        top.append(left, actions);

        const pct = t.total > 0 ? Math.min(100, (t.loaded / t.total) * 100) : t.status === 'done' ? 100 : 0;
        const prog = el('div', `progress${t.status === 'done' ? ' done' : ''}${t.status === 'error' ? ' err' : ''}`);
        const span = el('span');
        span.style.width = `${pct.toFixed(1)}%`;
        prog.appendChild(span);

        row.append(top, prog);
        if (t.error) row.append(el('div', 'muted', t.error));
        content.appendChild(row);
      }
    };

    const unsub = downloads.subscribe(render);
    ctx.window.el.addEventListener('lume:unmount', () => unsub());
  },
};
