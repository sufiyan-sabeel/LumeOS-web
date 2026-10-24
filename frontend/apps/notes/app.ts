/*
 * LumeOS - apps/notes/app.ts
 * Markdown / text editor persisted through the VFS.
 */

import type { LumeApp, AppContext } from '../../desktop/types.js';

export const notesApp: LumeApp = {
  manifest: {
    id: 'notes',
    name: 'Notes',
    glyph: '📝',
    description: 'Markdown and text editor synced with the virtual file system.',
    category: 'productivity',
    type: 'builtin',
    width: 640,
    height: 480,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const app = document.createElement('div');
    app.className = 'app';

    const toolbar = document.createElement('div');
    toolbar.className = 'app__toolbar';

    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.style.flex = '1';
    pathInput.value = (ctx.args.path as string) ?? '/notes/untitled.md';

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';

    toolbar.append(pathInput, openBtn, saveBtn);

    const area = document.createElement('textarea');
    area.className = 'notes__area';
    area.spellcheck = false;
    area.placeholder = 'Start typing… (Ctrl/Cmd+S to save)';

    const status = document.createElement('div');
    status.className = 'app__status';

    app.append(toolbar, area, status);
    ctx.window.body.appendChild(app);

    const setStatus = (msg: string): void => {
      status.textContent = msg;
    };

    const doOpen = async (): Promise<void> => {
      try {
        const text = await ctx.kernel.vfs.readText(pathInput.value);
        area.value = text;
        ctx.window.setTitle(`Notes — ${pathInput.value}`);
        setStatus(`Loaded ${pathInput.value} (${text.length} bytes)`);
      } catch (e) {
        setStatus(`Open failed: ${(e as Error).message}`);
      }
    };

    const doSave = async (): Promise<void> => {
      try {
        await ctx.kernel.vfs.writeText(pathInput.value, area.value);
        setStatus(`Saved ${pathInput.value} (${area.value.length} bytes)`);
        ctx.kernel.notify('Saved', pathInput.value, 'success');
      } catch (e) {
        setStatus(`Save failed: ${(e as Error).message}`);
        ctx.kernel.notify('Save failed', (e as Error).message, 'error');
      }
    };

    openBtn.onclick = () => void doOpen();
    saveBtn.onclick = () => void doSave();
    area.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSave();
      }
    });

    if (ctx.args.path) void doOpen();
    else setStatus('New document');
    setTimeout(() => area.focus(), 50);
  },
};
