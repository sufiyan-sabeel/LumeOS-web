/*
 * LumeOS - service-worker.js
 * Offline asset caching, runtime interception of installed web apps and
 * virtual-file-system routes.
 *
 * Base-path aware: the same file works when LumeOS is served from the domain
 * root (by the C backend) or from a subpath, as on a GitHub Pages project
 * site. Everything is resolved relative to `self.registration.scope`.
 *
 * Strategy:
 *   - install: pre-cache the app shell
 *   - fetch:
 *       * apps/installed/<id>/*  -> served from OPFS (offline web apps)
 *       * __vfs__/*              -> served from OPFS
 *       * api/*                  -> network-only (never cached)
 *       * same-origin GET assets -> cache-first, then network
 */

const VERSION = 'lume-v1.1.0';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

/* Site base path, e.g. "/" or "/LumeOS-web/". */
const BASE = new URL(self.registration.scope).pathname;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './styles/base.css',
  './styles/desktop.css',
  './styles/apps.css',
  './desktop/kernel.js',
  './assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.all(
          SHELL_ASSETS.map((url) =>
            cache.add(url).catch(() => {
              /* a missing optional asset must not fail installation */
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    html: 'text/html', css: 'text/css', js: 'text/javascript',
    mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', wasm: 'application/wasm',
    txt: 'text/plain', md: 'text/markdown',
  };
  return map[ext] || 'application/octet-stream';
}

/** Serve a site-relative path (already stripped of BASE) from OPFS. */
async function serveFromOpfs(rel) {
  try {
    const clean = rel
      .replace(/^apps\/installed\//, '')
      .replace(/^__vfs__\//, '');
    const parts = clean.split('/').filter(Boolean);
    const file = parts.pop();
    if (!file) return new Response('Not found', { status: 404 });

    let dir = await navigator.storage.getDirectory();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(file);
    const f = await handle.getFile();
    return new Response(f, {
      status: 200,
      headers: { 'Content-Type': guessType(file) },
    });
  } catch (e) {
    return new Response('Offline resource unavailable', { status: 404 });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  /* Only handle requests inside our own scope/base. */
  if (!url.pathname.startsWith(BASE)) return;
  const rel = url.pathname.slice(BASE.length);

  /* Installed apps and VFS routes come from local storage first. */
  if (rel.startsWith('apps/installed/') || rel.startsWith('__vfs__/')) {
    event.respondWith(serveFromOpfs(rel));
    return;
  }

  /* Never cache the API - it is live state. */
  if (rel.startsWith('api/')) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.method !== 'GET') return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
