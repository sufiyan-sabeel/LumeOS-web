#!/usr/bin/env node
/*
 * LumeOS - tests/worker_test.mjs
 * Exercises backend/worker/worker.js against a stubbed Workers KV, so the edge
 * backend is verified without deploying it.
 *
 * Run: node tests/worker_test.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

/* ---------------- stub KV ---------------- */
class FakeKV {
  constructor() {
    this.map = new Map(); // name -> {value, metadata}
  }
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
  async delete(name) {
    this.map.delete(name);
  }
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

/* ---------------- load the worker as ESM ---------------- */
const src = readFileSync(new URL('../backend/worker/worker.js', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'lume-worker-'));
const modPath = join(dir, 'worker.mjs');
writeFileSync(modPath, src);
const worker = (await import(pathToFileURL(modPath).href)).default;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};

const BASE = 'https://lumeos-api.example.workers.dev';

async function call(path, init = {}, env = {}) {
  const res = await worker.fetch(new Request(BASE + path, init), env);
  let body = null;
  const text = await res.text();
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: res.status, body, headers: res.headers };
}

const kvEnv = () => ({ LUME_FS: new FakeKV() });

/* ---------------- tests ---------------- */
try {
  console.log('== health & metadata (no bindings) ==');
  let r = await call('/api/health');
  check('health 200', r.status === 200 && r.body.status === 'ok', JSON.stringify(r.body));
  check('health reports worker runtime', r.body.runtime === 'cloudflare-worker');
  check('CORS header present', r.headers.get('Access-Control-Allow-Origin') === '*');

  r = await call('/api/system/info');
  check('system/info 200', r.status === 200);
  check('system/info marks telemetry unavailable', r.body.telemetry === false, JSON.stringify(r.body));
  check('system/info has a real note', typeof r.body.note === 'string' && r.body.note.length > 10);

  r = await call('/api/packages');
  check('packages listed', r.status === 200 && r.body.packages.length === 4,
    JSON.stringify(r.body.packages?.length));

  r = await call('/', { method: 'OPTIONS' });
  check('OPTIONS preflight 204', r.status === 204);

  console.log('== honest 501s ==');
  r = await call('/api/system/exec-native', { method: 'POST' });
  check('exec-native 501', r.status === 501 && /not possible on an edge runtime/.test(r.body.message),
    JSON.stringify(r.body));
  r = await call('/api/export/project');
  check('export 501', r.status === 501 && /filesystem/.test(r.body.message));

  console.log('== storage not configured ==');
  r = await call('/api/files/list?path=/');
  check('files/list 501 without KV', r.status === 501 && /KV namespace/.test(r.body.message),
    JSON.stringify(r.body));

  console.log('== file CRUD with KV ==');
  const env = kvEnv();
  r = await call('/api/files/list?path=/', {}, env);
  check('empty root lists', r.status === 200 && r.body.entries.length === 0, JSON.stringify(r.body));

  r = await call('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/notes/a.txt', content: 'hello edge' }),
  }, env);
  check('write 200', r.status === 200 && r.body.ok === 'written', JSON.stringify(r.body));

  r = await call('/api/files/read?path=/notes/a.txt', {}, env);
  check('read returns content', r.status === 200 && r.body.content === 'hello edge', JSON.stringify(r.body));
  check('read returns sha256', /^[0-9a-f]{64}$/.test(r.body.sha256 || ''), r.body.sha256);

  r = await call('/api/files/list?path=/', {}, env);
  check('root shows created dir', r.body.entries.some((e) => e.name === 'notes' && e.type === 'dir'),
    JSON.stringify(r.body.entries));
  r = await call('/api/files/list?path=/notes', {}, env);
  check('nested dir shows file', r.body.entries.some((e) => e.name === 'a.txt' && e.type === 'file'),
    JSON.stringify(r.body.entries));

  r = await call('/api/files/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/empty-dir' }),
  }, env);
  check('mkdir 200', r.status === 200, JSON.stringify(r.body));

  r = await call('/api/files/delete?path=/notes/a.txt', { method: 'DELETE' }, env);
  check('delete 200', r.status === 200, JSON.stringify(r.body));
  r = await call('/api/files/read?path=/notes/a.txt', {}, env);
  check('deleted file 404s', r.status === 404, JSON.stringify(r.body));

  console.log('== path traversal is rejected ==');
  for (const bad of ['/../etc/passwd', '/a/../../etc/passwd', '/a\u0000b']) {
    const w = await call('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: bad, content: 'x' }),
    }, env);
    check(`write rejected: ${JSON.stringify(bad)}`, w.status === 403, `${w.status} ${JSON.stringify(w.body)}`);
    const rd = await call(`/api/files/read?path=${encodeURIComponent(bad)}`, {}, env);
    check(`read rejected: ${JSON.stringify(bad)}`, rd.status === 403, `${rd.status}`);
  }
  r = await call('/api/files/delete?path=/', { method: 'DELETE' }, env);
  check('refuses to delete the root', r.status === 403, JSON.stringify(r.body));

  console.log('== write limits & validation ==');
  r = await call('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/big.txt', content: 'x'.repeat(300 * 1024) }),
  }, env);
  check('oversized write 413', r.status === 413, JSON.stringify(r.body));
  r = await call('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  }, env);
  check('invalid JSON 400', r.status === 400, JSON.stringify(r.body));

  console.log('== token auth ==');
  const tokEnv = { LUME_FS: new FakeKV(), LUME_TOKEN: 'secret123' };
  r = await call('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/x.txt', content: 'x' }),
  }, tokEnv);
  check('write without token 401', r.status === 401, JSON.stringify(r.body));
  r = await call('/api/files/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lume-Token': 'secret123' },
    body: JSON.stringify({ path: '/x.txt', content: 'x' }),
  }, tokEnv);
  check('write with token 200', r.status === 200, JSON.stringify(r.body));
  r = await call('/api/files/read?path=/x.txt', {}, tokEnv);
  check('reads stay public', r.status === 200, JSON.stringify(r.body));

  console.log('== unknown routes ==');
  r = await call('/api/nope');
  check('unknown api 404', r.status === 404);
  r = await call('/packages/hello-canvas.lume');
  check('package archive explains it is static', r.status === 404 && /static site/.test(r.body.message));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
