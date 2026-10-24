/*
 * LumeOS - apps/settings/app.ts
 * OS configuration: theme engine, backend connection, storage inspector.
 */

import type { LumeApp, AppContext } from '../../desktop/types.js';
import { osState } from '../../desktop/state.js';

function row(label: string, control: HTMLElement): HTMLElement {
  const r = document.createElement('div');
  r.className = 'settings__row';
  const l = document.createElement('label');
  l.textContent = label;
  r.append(l, control);
  return r;
}

function section(title: string): HTMLElement {
  const s = document.createElement('div');
  s.className = 'settings__section';
  const h = document.createElement('h3');
  h.textContent = title;
  s.appendChild(h);
  return s;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const settingsApp: LumeApp = {
  manifest: {
    id: 'settings',
    name: 'Settings',
    glyph: '⚙️',
    description: 'Configure the desktop, storage and C backend connection.',
    category: 'system',
    type: 'builtin',
    width: 720,
    height: 560,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const app = document.createElement('div');
    app.className = 'app';
    const content = document.createElement('div');
    app.className = 'app';
    content.className = 'app__content';
    app.appendChild(content);
    ctx.window.body.appendChild(app);

    /* ---- Appearance ---- */
    const appear = section('Appearance');

    const themeSel = document.createElement('select');
    themeSel.innerHTML = '<option value="dark">Dark</option><option value="light">Light</option>';
    themeSel.value = osState.settings.theme;
    themeSel.onchange = () => void osState.update({ theme: themeSel.value as 'dark' | 'light' });
    appear.appendChild(row('Theme', themeSel));

    const accent = document.createElement('input');
    accent.type = 'color';
    accent.value = osState.settings.accent;
    accent.oninput = () => void osState.update({ accent: accent.value });
    appear.appendChild(row('Accent colour', accent));

    const wall = document.createElement('input');
    wall.type = 'text';
    wall.placeholder = 'CSS background value (optional)';
    wall.value = osState.settings.wallpaper;
    wall.style.width = '260px';
    wall.onchange = () => void osState.update({ wallpaper: wall.value });
    appear.appendChild(row('Wallpaper (CSS)', wall));

    content.appendChild(appear);

    /* ---- Backend connection ---- */
    const backend = section('C Backend Connection');

    const url = document.createElement('input');
    url.type = 'text';
    url.placeholder = 'same origin (default)';
    url.value = osState.settings.serverUrl;
    url.style.width = '240px';

    const token = document.createElement('input');
    token.type = 'password';
    token.placeholder = 'X-Lume-Token (optional)';
    token.value = osState.settings.token;
    token.style.width = '240px';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'primary';
    applyBtn.textContent = 'Apply & Reconnect';
    applyBtn.onclick = async () => {
      await osState.update({ serverUrl: url.value.trim(), token: token.value });
      const online = await ctx.kernel.refreshServerStatus();
      statusBadge.textContent = online ? 'online' : 'offline';
      statusBadge.className = `badge ${online ? 'badge--ok' : 'badge--off'}`;
      ctx.kernel.notify('Backend', online ? 'Connected' : 'Unreachable', online ? 'success' : 'error');
    };

    const statusBadge = document.createElement('span');
    statusBadge.className = `badge ${ctx.kernel.isServerOnline() ? 'badge--ok' : 'badge--off'}`;
    statusBadge.textContent = ctx.kernel.isServerOnline() ? 'online' : 'offline';

    backend.append(row('Server URL', url), row('Session token', token));
    const statusRow = document.createElement('div');
    statusRow.className = 'settings__row';
    statusRow.append(document.createElement('label'), statusBadge, applyBtn);
    (statusRow.querySelector('label') as HTMLElement).textContent = 'Status';
    backend.appendChild(statusRow);

    const prefer = document.createElement('input');
    prefer.type = 'checkbox';
    prefer.checked = osState.settings.preferServer;
    prefer.onchange = () => void osState.update({ preferServer: prefer.checked });
    backend.appendChild(row('Prefer server-backed VFS when online', prefer));

    content.appendChild(backend);

    /* ---- Storage inspector ---- */
    const storage = section('Storage Inspector');
    const bar = document.createElement('div');
    bar.className = 'storage-bar';
    const used = document.createElement('span');
    used.style.background = 'linear-gradient(90deg,#6ea8fe,#a06bff)';
    bar.appendChild(used);

    const legend = document.createElement('div');
    legend.className = 'storage-legend';

    const usageText = document.createElement('div');
    usageText.className = 'muted';

    storage.append(bar, legend, usageText);
    content.appendChild(storage);

    const refreshUsage = async (): Promise<void> => {
      const { usage, quota } = await ctx.kernel.vfs.usage();
      const pct = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
      used.style.width = `${pct.toFixed(1)}%`;
      usageText.textContent = `${fmtBytes(usage)} used of ${fmtBytes(quota)} quota (${pct.toFixed(1)}%)`;
      legend.innerHTML =
        `<span><span class="swatch" style="background:#6ea8fe"></span>Origin usage</span>` +
        `<span><span class="swatch" style="background:rgba(255,255,255,0.15)"></span>Free</span>`;
    };
    void refreshUsage();

    /* ---- Source export ---- */
    const source = section('LumeOS Source');
    const exportBtn = document.createElement('button');
    exportBtn.className = 'primary';
    exportBtn.textContent = '⬇ Download LumeOS Source (.tar.gz)';
    exportBtn.onclick = () => window.open(ctx.kernel.api.sourceExportUrl(), '_blank');
    const exportRow = document.createElement('div');
    exportRow.className = 'settings__row';
    const exportLabel = document.createElement('label');
    exportLabel.textContent = 'Export the complete C + TypeScript project source.';
    exportRow.append(exportLabel, exportBtn);
    source.appendChild(exportRow);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset all settings';
    resetBtn.onclick = () => void osState.reset().then(() => ctx.kernel.notify('Settings reset', '', 'success'));
    const resetRow = document.createElement('div');
    resetRow.className = 'settings__row';
    const resetLabel = document.createElement('label');
    resetLabel.textContent = 'Restore default theme and connection settings.';
    resetRow.append(resetLabel, resetBtn);
    source.appendChild(resetRow);

    content.appendChild(source);
  },
};
