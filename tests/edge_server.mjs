#!/usr/bin/env node
/*
 * LumeOS - tests/edge_server.mjs
 * Runs backend/worker/worker.js behind a plain Node HTTP server with an
 * in-memory KV, so the edge backend can be exercised over real HTTP
 * (including cross-origin CORS) without deploying it.
 *
 * Usage: node tests/edge_server.mjs <port>
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

class FakeKV {
  constructor() { this.map = new Map(); }
  async put(name, value, opts = {}) {
    this.map.set(name, { value, metadata: opts.metadata ?? null });
  }
  async get(name) {
    const e = this.map.get(name);
    return e ? e.value : null;
  }
  async getWithMetadata(name) {
    const e = this.map.get(name);
    return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null };
  }
  async delete(name) { this.map.delete(name); }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + limit);
    const complete = start + limit >= all.length;
    return {
      keys: slice.map((name) => ({ name, metadata: this.map.get(name).metadata })),
      list_complete: complete,
      cursor: complete ? undefined : String(start + limit),
    };
  }
}

const src = readFileSync(new URL('../backend/worker/worker.js', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'lume-edge-'));
const modPath = join(dir, 'worker.mjs');
writeFileSync(modPath, src);
const worker = (await import(pathToFileURL(modPath).href)).default;

const env = { LUME_FS: new FakeKV() };
const port = Number(process.argv[2] || 8787);

/* Hop-by-hop headers must not be forwarded into a Fetch Request: undici
 * rejects some of them (a browser sends `connection: keep-alive`, which
 * Python's urllib does not, so this only breaks real browser requests). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  'content-length', 'accept-encoding',
]);

/* Keep the harness alive and loud: a crash here would look like a network
 * failure in the browser and hide the real cause. */
process.on('uncaughtException', (e) => {
  console.error('[edge harness] uncaught:', e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', (e) => {
  console.error('[edge harness] unhandled rejection:', e && e.stack ? e.stack : e);
});

createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const reqHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) reqHeaders[k] = v;
    }

    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers: reqHeaders,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });

    const response = await worker.fetch(request, env);
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    /* Echo the error as JSON *with* CORS so the browser surfaces the real
     * reason instead of an opaque "Failed to fetch". */
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    console.error('[edge harness] request failed:', req.method, req.url, e && e.stack ? e.stack : e);
    res.end(JSON.stringify({ error: true, adapter: true, message: e.message }));
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`edge backend listening on http://127.0.0.1:${port}`);
});
