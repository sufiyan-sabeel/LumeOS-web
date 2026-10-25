/**
 * LumeOS - backend/worker/worker.js
 *
 * A Cloudflare Worker implementation of the LumeOS HTTP API.
 *
 * WHY THIS EXISTS
 * ---------------
 * The primary backend (backend/*.c) is a POSIX C server: it needs sockets,
 * threads, a real filesystem and /proc. Cloudflare Workers run JavaScript on
 * V8 isolates and provide none of those, so the C binary cannot run there.
 * This Worker re-implements the same HTTP contract on the edge, so a LumeOS
 * frontend hosted on a static site can talk to a real HTTPS backend.
 *
 * The routes, JSON shapes and CORS behaviour mirror backend/routes.c, so the
 * frontend needs no changes: set Settings -> C backend connection -> Server URL
 * to this Worker's URL.
 *
 * WHAT IS AND IS NOT POSSIBLE HERE
 * --------------------------------
 *  possible : health, package catalogue, file CRUD (Workers KV), CORS
 *  limited  : host telemetry - there is no /proc, no statvfs, no load average.
 *             Only edge metadata (colo, country) is real; the rest is reported
 *             as 0 with telemetry:false so the UI can say "not available".
 *  not here : native execution (exec-native) and source archiving (export).
 *             Those return 501 with an explanation rather than pretending.
 *
 * KV IS OPTIONAL
 * --------------
 * If no LUME_FS KV namespace is bound, every file route returns 501 with
 * instructions and the rest of the API still works - so you can deploy this
 * with a single command and still get a live backend.
 */

const VERSION = '1.1.0';
const MAX_WRITE_BYTES = 256 * 1024; // per file

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Lume-Token, Authorization',
  'Access-Control-Max-Age': '600',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/* The package repository. Mirrors packages/index.json in the repository.
 * The archives themselves are served by the static site. */
const PACKAGES = [
  { name: 'hello-canvas', path: 'hello-canvas', size: 2354, kind: 'bundle' },
  { name: 'markdown-studio', path: 'markdown-studio', size: 2057, kind: 'bundle' },
  { name: 'notes-pro', path: 'notes-pro', size: 0, kind: 'bundle' },
  { name: 'tiny-ai', path: 'tiny-ai', size: 747, kind: 'bundle' },
];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function fail(status, message) {
  return json({ error: true, status, message }, status);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Reject traversal and control characters; return a canonical path or null. */
function safePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  const parts = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

function key(path) {
  return `n:${path}`;
}

function parentOf(path) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function baseName(path) {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/** Optional shared-secret gate. Set the LUME_TOKEN secret to enable it. */
function authorised(env, request) {
  if (!env.LUME_TOKEN) return true; // auth disabled
  const header = request.headers.get('X-Lume-Token') || '';
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return header === env.LUME_TOKEN || bearer === env.LUME_TOKEN;
}

function storageReady(env) {
  return !!env.LUME_FS;
}

function storageUnavailable() {
  return fail(
    501,
    'File storage is not configured on this Worker. Create a KV namespace and bind it as ' +
      'LUME_FS, then redeploy. The rest of the API (health, system info, packages) works ' +
      'without it, and the LumeOS client keeps using local storage for files.'
  );
}

/* ------------------------------------------------------------------ */
/* file operations (Workers KV)                                        */
/* ------------------------------------------------------------------ */

async function listDir(env, path) {
  const prefix = path === '/' ? 'n:/' : `n:${path}/`;
  const out = [];
  let cursor;
  do {
    const page = await env.LUME_FS.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) {
      const full = k.name.slice(2); // strip "n:"
      const rest = full.slice(prefix.length - 2);
      if (rest.includes('/')) continue; // not a direct child
      out.push({
        name: rest,
        type: k.metadata && k.metadata.isDir ? 'dir' : 'file',
        size: (k.metadata && k.metadata.size) || 0,
        mtime: (k.metadata && k.metadata.mtime) || 0,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

async function ensureDirs(env, path) {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    const existing = await env.LUME_FS.getWithMetadata(key(cur));
    if (!existing.value && !existing.metadata) {
      await env.LUME_FS.put(key(cur), '', { metadata: { isDir: true, size: 0, mtime: Date.now() } });
    }
  }
}

async function deleteTree(env, path) {
  const prefix = `n:${path}`;
  let cursor;
  do {
    const page = await env.LUME_FS.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) await env.LUME_FS.delete(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

/* ------------------------------------------------------------------ */
/* route handlers                                                      */
/* ------------------------------------------------------------------ */

function health() {
  return json({
    status: 'ok',
    service: 'LumeOS',
    version: VERSION,
    runtime: 'cloudflare-worker',
    time: nowIso(),
  });
}

function systemInfo(request) {
  const cf = request.cf || {};
  return json({
    os: 'cloudflare-workers',
    kernel: 'v8-isolate',
    arch: 'wasm32',
    hostname: cf.colo ? `edge-${String(cf.colo).toLowerCase()}` : 'edge',
    cpus: 0,
    mem_total_kb: 0,
    mem_available_kb: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    disk_total_bytes: 0,
    disk_free_bytes: 0,
    lume_version: VERSION,
    time: nowIso(),
    /* Extra fields the local C server does not provide. */
    runtime: 'cloudflare-worker',
    telemetry: false,
    colo: cf.colo || null,
    country: cf.country || null,
    region: cf.region || null,
    note:
      'Edge runtime: host CPU, memory, load and disk are not observable. ' +
      'Only edge metadata is real.',
  });
}

async function filesList(env, url) {
  if (!storageReady(env)) return storageUnavailable();
  const raw = url.searchParams.get('path') || '/';
  const path = safePath(raw);
  if (!path) return fail(403, 'path outside of data/files (rejected)');
  try {
    return json({ path, entries: await listDir(env, path) });
  } catch (e) {
    return fail(500, `list failed: ${e.message}`);
  }
}

async function filesRead(env, url) {
  if (!storageReady(env)) return storageUnavailable();
  const raw = url.searchParams.get('path');
  if (!raw) return fail(400, 'missing ?path');
  const path = safePath(raw);
  if (!path) return fail(403, 'path outside of data/files (rejected)');

  const rec = await env.LUME_FS.getWithMetadata(key(path));
  if (rec.value === null) return fail(404, 'file not found');
  if (rec.metadata && rec.metadata.isDir) return fail(400, 'path is a directory');

  const content = rec.value;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return json({ path, size: content.length, content, sha256 });
}

async function filesWrite(env, request) {
  if (!storageReady(env)) return storageUnavailable();
  if (!authorised(env, request)) return fail(401, 'unauthorized: missing or invalid X-Lume-Token');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'invalid JSON body');
  }
  const path = safePath(body && body.path);
  if (!path) return fail(403, 'path outside of data/files (rejected)');
  if (typeof body.content !== 'string') return fail(400, "missing 'content'");

  const bytes = new TextEncoder().encode(body.content).length;
  if (bytes > MAX_WRITE_BYTES) {
    return fail(413, `file exceeds the ${MAX_WRITE_BYTES}-byte limit of this edge backend`);
  }

  try {
    await ensureDirs(env, parentOf(path));
    await env.LUME_FS.put(key(path), body.content, {
      metadata: { isDir: false, size: bytes, mtime: Date.now() },
    });
    return json({ ok: 'written', path, bytes });
  } catch (e) {
    return fail(500, `write failed: ${e.message}`);
  }
}

async function filesMkdir(env, request) {
  if (!storageReady(env)) return storageUnavailable();
  if (!authorised(env, request)) return fail(401, 'unauthorized');

  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'invalid JSON body');
  }
  const path = safePath(body && body.path);
  if (!path) return fail(403, 'path outside of data/files (rejected)');

  try {
    await ensureDirs(env, path);
    return json({ ok: 'created' });
  } catch (e) {
    return fail(500, `mkdir failed: ${e.message}`);
  }
}

async function filesDelete(env, request, url) {
  if (!storageReady(env)) return storageUnavailable();
  if (!authorised(env, request)) return fail(401, 'unauthorized');

  const raw = url.searchParams.get('path');
  if (!raw) return fail(400, 'missing ?path');
  const path = safePath(raw);
  if (!path) return fail(403, 'path outside of data/files (rejected)');
  if (path === '/') return fail(403, 'refusing to delete the data root');

  try {
    const rec = await env.LUME_FS.getWithMetadata(key(path));
    if (rec.value === null && !rec.metadata) return fail(404, 'not found');
    await deleteTree(env, path);
    return json({ ok: 'deleted' });
  } catch (e) {
    return fail(500, `delete failed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === '/' ) {
        return json({
          service: 'LumeOS edge backend',
          version: VERSION,
          runtime: 'cloudflare-worker',
          storage: storageReady(env) ? 'kv' : 'not configured',
          endpoints: [
            'GET /api/health',
            'GET /api/system/info',
            'GET /api/packages',
            'GET /api/files/list?path=/',
            'GET /api/files/read?path=/a.txt',
            'POST /api/files/write',
            'POST /api/files/mkdir',
            'DELETE /api/files/delete?path=/a.txt',
          ],
          note:
            'This is the edge port of the LumeOS API. The native C backend ' +
            '(native exec, host telemetry, source export) only runs on a real host.',
        });
      }

      if (path === '/api/health') return health();
      if (path === '/api/system/info') return systemInfo(request);
      if (path === '/api/packages') return json({ packages: PACKAGES });

      if (path === '/api/files/list') return await filesList(env, url);
      if (path === '/api/files/read') return await filesRead(env, url);
      if (path === '/api/files/write' && method === 'POST') return await filesWrite(env, request);
      if (path === '/api/files/mkdir' && method === 'POST') return await filesMkdir(env, request);
      if (path === '/api/files/delete' && method === 'DELETE') {
        return await filesDelete(env, request, url);
      }

      if (path === '/api/system/exec-native') {
        return fail(
          501,
          'Native execution is not possible on an edge runtime. Run the native C ' +
            'backend (make run) for /api/system/exec-native.'
        );
      }
      if (path === '/api/export/project') {
        return fail(
          501,
          'Source archiving needs a filesystem. Download the source from the GitHub ' +
            'release, or run the native C backend.'
        );
      }

      if (path.startsWith('/api/')) return fail(404, 'unknown API route');
      if (path.startsWith('/packages/')) {
        return fail(
          404,
          'Package archives are served by the static site, not by this edge backend.'
        );
      }

      return fail(404, 'not found');
    } catch (e) {
      return fail(500, `unhandled error: ${e.message}`);
    }
  },
};
