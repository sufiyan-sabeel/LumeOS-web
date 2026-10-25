/*
 * LumeOS - apps/app-store/app.ts
 * Package manager for Web Apps, Offline AI Models and Native apps.
 * Reads the packages/ repository exposed by the C backend and drives the
 * real install pipeline (download -> verify -> unpack into OPFS -> register).
 */

import type { LumeApp, AppContext } from '../../desktop/types.js';
import { downloads } from '../../desktop/downloads.js';
import { appUrl } from '../../desktop/base.js';
import { opfs } from '../../storage/opfs.js';
import { unzip, normalizeEntryName } from '../../storage/zip.js';

interface LumePackageManifest {
  id: string;
  name: string;
  glyph: string;
  type: 'web' | 'ai-model' | 'native';
  version: string;
  description?: string;
  entry?: string;
  files?: string[];
  checksums?: Record<string, string>;
  size?: number;
  runtime?: string;
  installers?: Record<string, string>;
  /** Optional published `.lume` archive (a standard zip) in packages/. */
  archive?: string;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function detectOs(): string {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return 'windows';
  if (/Mac/i.test(ua)) return 'macos';
  if (/Android/i.test(ua)) return 'android';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

export const appStoreApp: LumeApp = {
  manifest: {
    id: 'app-store',
    name: 'App Store',
    icon: 'store',
    description: 'Install web apps, offline AI models and native packages.',
    category: 'system',
    type: 'builtin',
    width: 860,
    height: 600,
    onDesktop: true,
  },

  mount(ctx: AppContext) {
    const app = el('div', 'app');
    const toolbar = el('div', 'app__toolbar');
    const content = el('div', 'app__content');
    const status = el('div', 'app__status');

    const refresh = el('button', undefined, '⟳ Refresh catalog') as HTMLButtonElement;
    toolbar.append(refresh);
    app.append(toolbar, content, status);
    ctx.window.body.appendChild(app);

    let catalog: LumePackageManifest[] = [];

    /* Base-aware so the repository works from the root (C backend) or a
     * subpath (static GitHub Pages deployment). */
    const pkgBase = (name: string): string => appUrl(`packages/${name}`);

    const loadCatalog = async (): Promise<void> => {
      content.innerHTML = '';
      catalog = [];

      /* 1) Static catalog — works with the C backend AND with a purely
       *    static deployment (GitHub Pages), where there is no /api. */
      try {
        const res = await fetch(appUrl('packages/index.json'), { cache: 'no-cache' });
        if (res.ok) {
          const idx = (await res.json()) as { packages?: LumePackageManifest[] };
          if (Array.isArray(idx.packages)) catalog = idx.packages;
        }
      } catch {
        /* ignore and try the live listing */
      }

      /* 2) Fall back to the live backend repository listing. */
      if (catalog.length === 0 && ctx.kernel.isServerOnline()) {
        try {
          const packages = await ctx.kernel.api.listPackages();
          for (const p of packages) {
            if (p.kind !== 'bundle') continue;
            try {
              const res = await fetch(`${pkgBase(p.name)}/manifest.lume.json`);
              if (res.ok) catalog.push((await res.json()) as LumePackageManifest);
            } catch {
              /* skip malformed package */
            }
          }
        } catch {
          /* ignore */
        }
      }

      if (catalog.length === 0) {
        content.appendChild(
          el('p', 'muted', 'No package repository available. Start the C backend or deploy the packages/ folder.')
        );
        status.textContent = 'repository unavailable';
        return;
      }
      render();
      status.textContent =
        `${catalog.length} package(s) · ` +
        (ctx.kernel.isServerOnline() ? 'server online' : 'offline (static repository)');
    };

    const render = (): void => {
      content.innerHTML = '';
      if (catalog.length === 0) {
        content.appendChild(el('p', 'muted', 'No installable packages found in packages/.'));
        return;
      }
      const cards = el('div', 'cards');
      for (const pkg of catalog) {
        cards.appendChild(renderCard(pkg));
      }
      content.appendChild(cards);
    };

    const renderCard = (pkg: LumePackageManifest): HTMLElement => {
      const card = el('div', 'card');
      const title = el('div', 'card__title');
      title.append(el('span', undefined, pkg.glyph), el('span', undefined, pkg.name));
      const desc = el('div', 'card__desc', pkg.description ?? '');
      const meta = el('div', 'card__meta');
      meta.append(
        el('span', 'badge', pkg.type),
        el('span', 'badge', `v${pkg.version}`),
        el('span', 'badge', `${pkg.files?.length ?? 0} files`)
      );
      const actions = el('div', 'card__actions');

      const installed = ctx.kernel.installedApps().some((a) => a.id === pkg.id);
      const installBtn = el('button', 'primary', installed ? 'Reinstall' : 'Install') as HTMLButtonElement;
      installBtn.onclick = () => void install(pkg, installBtn);

      if (installed) {
        const rm = el('button', undefined, 'Uninstall') as HTMLButtonElement;
        rm.onclick = async () => {
          await ctx.kernel.uninstallApp(pkg.id);
          ctx.kernel.notify('Uninstalled', pkg.name, 'success');
          render();
        };
        actions.append(installBtn, rm);
      } else {
        actions.append(installBtn);
      }

      card.append(title, desc, meta, actions);
      return card;
    };

    const install = async (pkg: LumePackageManifest, btn: HTMLButtonElement): Promise<void> => {
      btn.disabled = true;
      btn.textContent = 'Installing…';

      try {
        if (pkg.type === 'native') {
          const os = detectOs();
          const installer = pkg.installers?.[os];
          ctx.kernel.notify(
            'Native package',
            installer
              ? `Detected ${os}. Installer: ${installer}`
              : `No installer for ${os}; using local runtime bridge if available.`,
            'info'
          );
          /* Trigger installer download (or bridge execution). */
          const files = (pkg.files ?? []).map((f) => `${pkgBase(pkg.id)}/${f}`);
          if (files.length > 0) {
            await downloads.start(pkg.name, 'native', files);
          }
          btn.textContent = 'Install';
          btn.disabled = false;
          return;
        }

        const root = pkg.type === 'web' ? `/${pkg.id}` : `/models/${pkg.id}`;

        if (pkg.archive) {
          /* Published .lume archive: a single download, extracted in-browser
           * with the native DecompressionStream (see storage/zip.ts). */
          const url = appUrl(`packages/${pkg.archive}`);
          await downloads.start(pkg.name, pkg.type, [url], async (_u, blob) => {
            const buffer = await blob.arrayBuffer();
            const expected = pkg.checksums?.[pkg.archive as string];
            if (expected) {
              const actual = await sha256Hex(buffer.slice(0));
              if (actual !== expected) throw new Error('archive checksum mismatch');
            }
            const entries = await unzip(buffer);
            if (entries.length === 0) throw new Error('archive contained no files');
            for (const e of entries) {
              const rel = normalizeEntryName(e.name);
              if (!rel || rel === 'manifest.lume.json') continue;
              await opfs.writeBlob(`${root}/${rel}`, new Blob([e.bytes as BlobPart]));
            }
          });
        } else {
          /* Directory bundle: one download per declared file. */
          const files = pkg.files ?? ['index.html'];
          const urls = files.map((f) => `${pkgBase(pkg.id)}/${f}`);
          await downloads.start(pkg.name, pkg.type, urls, async (url, blob) => {
            const rel = url.slice(pkgBase(pkg.id).length + 1);
            /* Verify integrity when a checksum is declared. */
            const expected = pkg.checksums?.[rel];
            if (expected) {
              const actual = await sha256Hex(await blob.arrayBuffer());
              if (actual !== expected) {
                throw new Error(`checksum mismatch for ${rel}`);
              }
            }
            await opfs.writeBlob(`${root}/${rel}`, blob);
          });
        }

        if (pkg.type === 'web') {
          const info = {
            id: pkg.id,
            name: pkg.name,
            glyph: pkg.glyph,
            type: 'web' as const,
            version: pkg.version,
            entry: pkg.entry ?? 'index.html',
            installedAt: Date.now(),
            sizeBytes: 0,
          };
          await ctx.kernel.installWebApp(info);
          ctx.kernel.notify('Installed', `${pkg.name} is now on your desktop`, 'success');
        } else {
          ctx.kernel.notify('Model downloaded', `${pkg.name} is available in AI Center`, 'success');
        }
        render();
      } catch (e) {
        ctx.kernel.notify('Install failed', (e as Error).message, 'error');
        btn.textContent = 'Retry';
        btn.disabled = false;
      }
    };

    refresh.onclick = () => void loadCatalog();
    void loadCatalog();
    void (async () => {
      /* ensure OPFS is initialised before installs */
      await opfs.available();
    })();
  },
};

