/*
 * LumeOS - service-worker.js
 * Offline asset caching, runtime interception of installed web apps and
 * virtual-file-system routes (/__vfs__/).
 *
 * Strategy:
 *   - install: pre-cache the app shell
 *   - fetch:
 *       * /apps/installed/<id>/*  -> served from OPFS/IndexedDB (offline)
 *       * /__vfs__/*              -> served from OPFS
 *       * same-origin GET assets  -> cache-first, then network
 *       * /api/*                  -> network-only (never cached)
 */

const VERSION = 'lume-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles/base.css',
  '/styles/desktop.css',
  '/styles/apps.css',
  '/desktop/kernel.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch(() => {
            /* a missing optional asset must not fail installation */
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

async function serveFromOpfs(pathname) {
  try {
    const root = await navigator.storage.getDirectory();
    const rel = pathname.replace(/^\/__vfs__\//, '').replace(/^\/apps\/installed\//, '');
    let dir = root;
    const parts = rel.split('/').filter(Boolean);
    const file = parts.pop();
    if (!file) return new Response('Not found', { status: 404 });
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(file);
    const f = await handle.getFile();
    const type = guessType(file);
    return new Response(f, { status: 200, headers: { 'Content-Type': type } });
  } catch (e) {
    return new Response('Offline resource unavailable', { status: 404 });
  }
}

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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  /* Installed apps and VFS routes come from local storage first. */
  if (url.pathname.startsWith('/__vfs__/') ||
      url.pathname.startsWith('/apps/installed/')) {
    event.respondWith(serveFromOpfs(url.pathname));
    return;
  }

  /* Never cache the API - it is live state. */
  if (url.pathname.startsWith('/api/')) {
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
        .catch(() => caches.match('/index.html'));
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
