/*
 * LumeOS - apps/settings/app.ts
 * System settings: appearance, layout, backend connection and storage.
 * Every control writes to real persisted state and takes effect immediately.
 */

import type { AppContext, LumeApp, ShellPreference } from '../../desktop/types.js';
import { osState } from '../../desktop/state.js';
import { WALLPAPERS } from '../../desktop/desktop.js';
import { confirmDialog } from '../../components/modal.js';
import { iconEl } from '../../components/icons.js';

const ACCENTS: Array<{ name: string; value: string }> = [
  { name: 'Blue', value: '#5b8def' },
  { name: 'Violet', value: '#8f6be0' },
  { name: 'Teal', value: '#2fbfa8' },
  { name: 'Amber', value: '#d9a066' },
  { name: 'Rose', value: '#e0657a' },
];

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
    icon: 'settings',
    description: 'Appearance, layout, backend connection and storage.',
    category: 'system',
    type: 'builtin',
    width: 760,
    height: 600,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const app = el('div', 'app');
    const content = el('div', 'app__content');
    app.appendChild(content);
    ctx.window.body.appendChild(app);

    const section = (title: string): HTMLElement => {
      const s = el('div', 'settings__section');
      s.appendChild(el('h3', undefined, title));
      return s;
    };

    const row = (label: string, hint: string, control: HTMLElement): HTMLElement => {
      const r = el('div', 'settings__row');
      const l = el('label');
      l.appendChild(document.createTextNode(label));
      if (hint) l.appendChild(el('small', undefined, hint));
      r.append(l, control);
      return r;
    };

    /* ================= Appearance ================= */
    const appearance = section('Appearance');

    const themeSel = el('select');
    themeSel.setAttribute('aria-label', 'Theme');
    for (const [value, label] of [['dark', 'Dark'], ['light', 'Light']] as const) {
      const o = el('option', undefined, label);
      o.value = value;
      themeSel.appendChild(o);
    }
    themeSel.value = osState.settings.theme;
    themeSel.addEventListener('change', () =>
      void osState.update({ theme: themeSel.value as 'dark' | 'light' })
    );
    appearance.appendChild(row('Theme', 'Dark is optimised for AMOLED displays.', themeSel));

    const accentWrap = el('div', 'row');
    for (const a of ACCENTS) {
      const b = el('button');
      b.type = 'button';
      b.title = a.name;
      b.setAttribute('aria-label', `Accent colour ${a.name}`);
      b.style.cssText = `width:26px;min-width:26px;height:26px;min-height:26px;padding:0;border-radius:50%;background:${a.value};border:2px solid ${
        osState.settings.accent.toLowerCase() === a.value.toLowerCase()
          ? 'var(--lume-text)'
          : 'transparent'
      }`;
      b.addEventListener('click', () => void osState.update({ accent: a.value }));
      accentWrap.appendChild(b);
    }
    appearance.appendChild(row('Accent', 'Used for highlights and focus.', accentWrap));

    const wallSel = el('select');
    wallSel.setAttribute('aria-label', 'Wallpaper');
    const custom = el('option', undefined, 'Default');
    custom.value = '';
    wallSel.appendChild(custom);
    for (const w of WALLPAPERS) {
      const o = el('option', undefined, w.name);
      o.value = w.value;
      wallSel.appendChild(o);
    }
    wallSel.value = osState.settings.wallpaper;
    wallSel.addEventListener('change', () => osState.setWallpaper(wallSel.value));
    appearance.appendChild(row('Wallpaper', 'Right-click the desktop to cycle quickly.', wallSel));

    const motion = el('input');
    motion.type = 'checkbox';
    motion.checked = osState.settings.reducedMotion;
    motion.setAttribute('aria-label', 'Reduce motion');
    motion.addEventListener('change', () =>
      void osState.update({ reducedMotion: motion.checked })
    );
    appearance.appendChild(
      row('Reduce motion', 'Disables interface animations. Your system setting is always respected.', motion)
    );

    content.appendChild(appearance);

    /* ================= Layout ================= */
    const layout = section('Layout');

    const shellSel = el('select');
    shellSel.setAttribute('aria-label', 'Shell layout');
    for (const [value, label] of [
      ['auto', 'Automatic (by screen width)'],
      ['desktop', 'Desktop'],
      ['mobile', 'Mobile'],
    ] as const) {
      const o = el('option', undefined, label);
      o.value = value;
      shellSel.appendChild(o);
    }
    shellSel.value = osState.settings.shell;
    shellSel.addEventListener('change', () => {
      ctx.kernel.setShellPreference(shellSel.value as ShellPreference);
      modeLabel.textContent = `Active: ${ctx.kernel.shellMode()}`;
    });
    layout.appendChild(
      row('Shell', 'Mobile uses a home screen and full-screen apps.', shellSel)
    );

    const modeLabel = el('div', 'muted');
    modeLabel.style.fontSize = 'var(--lume-fs-xs)';
    modeLabel.style.margin = '-4px 0 10px 4px';
    modeLabel.textContent = `Active: ${ctx.kernel.shellMode()}`;
    layout.appendChild(modeLabel);

    content.appendChild(layout);

    /* ================= Backend ================= */
    const backend = section('C backend connection');

    const url = el('input');
    url.type = 'text';
    url.placeholder = 'https://lumeos-api.<sub>.workers.dev';
    url.value = osState.settings.serverUrl;
    url.setAttribute('aria-label', 'Server URL');

    const token = el('input');
    token.type = 'password';
    token.placeholder = 'X-Lume-Token (optional)';
    token.value = osState.settings.token;
    token.setAttribute('aria-label', 'Session token');

    const statusBadge = el('span', 'badge');
    const applyBtn = el('button', 'primary', 'Apply and reconnect');
    applyBtn.type = 'button';

    const refreshBadge = (): void => {
      const online = ctx.kernel.isServerOnline();
      statusBadge.className = `badge ${online ? 'badge--ok' : 'badge--off'}`;
      statusBadge.replaceChildren(iconEl(online ? 'cloud' : 'cloudOff', 12));
      statusBadge.appendChild(document.createTextNode(online ? 'online' : 'offline'));
    };
    refreshBadge();

    applyBtn.addEventListener('click', async () => {
      applyBtn.disabled = true;
      applyBtn.textContent = 'Connecting…';
      await osState.update({ serverUrl: url.value.trim(), token: token.value });
      const online = await ctx.kernel.refreshServerStatus();
      refreshBadge();
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply and reconnect';
      ctx.kernel.notify(
        'Backend',
        online ? 'Connected to the C backend.' : 'Could not reach the C backend.',
        online ? 'success' : 'error'
      );
    });

    const statusRow = el('div', 'settings__row');
    const statusLabel = el('label');
    statusLabel.textContent = 'Status';
    statusRow.append(statusLabel, statusBadge, applyBtn);
    backend.append(
      row('Server URL',
          'Leave empty to use the page origin. For a hosted backend, paste its https:// URL ' +
          '(for example a Cloudflare Worker from backend/worker/).', url),
      row('Session token', 'Required only when the server runs with --secure.', token),
      statusRow
    );

    const prefer = el('input');
    prefer.type = 'checkbox';
    prefer.checked = osState.settings.preferServer;
    prefer.setAttribute('aria-label', 'Prefer server storage');
    prefer.addEventListener('change', () =>
      void osState.update({ preferServer: prefer.checked }).then(() => ctx.kernel.refreshServerStatus())
    );
    backend.appendChild(
      row('Prefer server storage', 'When online, the VFS reads and writes through the backend.', prefer)
    );

    content.appendChild(backend);

    /* ================= Storage ================= */
    const storage = section('Storage');
    const meter = el('div', 'meter');
    const fill = el('span');
    meter.appendChild(fill);
    const caption = el('div', 'muted');
    caption.style.fontSize = 'var(--lume-fs-xs)';
    caption.style.marginTop = '6px';
    storage.append(meter, caption);

    const refreshUsage = async (): Promise<void> => {
      const { usage, quota } = await ctx.kernel.vfs.usage();
      const pct = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
      fill.style.width = `${pct}%`;
      caption.textContent = quota
        ? `${fmtBytes(usage)} used of ${fmtBytes(quota)} (${pct.toFixed(1)}%)`
        : 'Storage estimate unavailable in this browser.';
    };
    void refreshUsage();

    const usageBtn = el('button', undefined, 'Refresh');
    usageBtn.type = 'button';
    usageBtn.addEventListener('click', () => void refreshUsage());
    storage.appendChild(row('Browser storage', 'IndexedDB, OPFS and caches for this origin.', usageBtn));
    content.appendChild(storage);

    /* ================= About / source ================= */
    const about = section('About LumeOS');
    const exportBtn = el('button', 'primary', 'Download source (.tar.gz)');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', () =>
      window.open(ctx.kernel.api.sourceExportUrl(), '_blank')
    );
    about.appendChild(row('Project source', 'Complete C + TypeScript source tree.', exportBtn));

    const resetBtn = el('button', 'danger', 'Reset settings');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(
        'Reset settings',
        'Theme, accent, wallpaper, layout and connection settings will return to their defaults.'
      );
      if (!ok) return;
      await osState.reset();
      ctx.kernel.notify('Settings reset', 'Defaults restored.', 'success');
      themeSel.value = osState.settings.theme;
      wallSel.value = osState.settings.wallpaper;
      shellSel.value = osState.settings.shell;
      motion.checked = osState.settings.reducedMotion;
      url.value = osState.settings.serverUrl;
      token.value = osState.settings.token;
      prefer.checked = osState.settings.preferServer;
      modeLabel.textContent = `Active: ${ctx.kernel.shellMode()}`;
      refreshBadge();
    });
    about.appendChild(row('Reset', 'Restore all defaults.', resetBtn));

    const version = el('div', 'muted');
    version.style.fontSize = 'var(--lume-fs-xs)';
    version.textContent = 'LumeOS v1.1.0 · hybrid web desktop (C backend + TypeScript shell)';
    about.appendChild(version);

    content.appendChild(about);

    /* ================= Diagnostics ================= */
    const diag = section('Diagnostics');
    const diagHint = el('div', 'muted');
    diagHint.style.fontSize = 'var(--lume-fs-xs)';
    diagHint.style.marginBottom = 'var(--lume-sp-3)';
    diagHint.textContent =
      'Environment checks for this browser. Anything marked with a warning explains what is unavailable and how to fix it.';
    diag.appendChild(diagHint);

    const diagList = el('div', 'diag-list');
    diag.appendChild(diagList);

    const renderDiag = async (): Promise<void> => {
      diagList.replaceChildren();
      const items = await ctx.kernel.diagnostics();
      for (const it of items) {
        const row = el('div', `diag ${it.ok ? 'diag--ok' : 'diag--bad'}`);
        row.appendChild(iconEl(it.ok ? 'checkCircle' : 'alert', 15, 'diag__icon'));
        const text = el('div');
        text.appendChild(el('div', 'diag__label', it.label));
        text.appendChild(el('div', 'diag__detail', it.detail));
        row.appendChild(text);
        diagList.appendChild(row);
      }
    };
    void renderDiag();

    const recheckBtn = el('button', undefined, 'Re-run checks');
    recheckBtn.type = 'button';
    recheckBtn.addEventListener('click', () => {
      void ctx.kernel.refreshServerStatus().then(() => {
        refreshBadge();
        void renderDiag();
      });
    });
    diag.appendChild(row('Re-check', 'Reconnect to the backend and re-run every check.', recheckBtn));

    content.appendChild(diag);
  },
};
