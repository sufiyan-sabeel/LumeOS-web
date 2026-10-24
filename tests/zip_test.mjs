#!/usr/bin/env node
/*
 * LumeOS - tests/zip_test.mjs
 * Verifies storage/zip.ts against archives produced by the real `zip` tool.
 *
 * Run:  node tests/zip_test.mjs <path-to-compiled-zip.mjs>
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const zipModulePath = process.argv[2];
if (!zipModulePath) {
  console.error('usage: node tests/zip_test.mjs <compiled-zip.mjs>');
  process.exit(2);
}
const { unzip, normalizeEntryName } = await import(zipModulePath);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};

const work = mkdtempSync(join(tmpdir(), 'lume-zip-'));

try {
  // ---- build a package-like tree ----
  const src = join(work, 'pkg');
  mkdirSync(join(src, 'sub'), { recursive: true });
  const files = {
    'manifest.lume.json': JSON.stringify({ id: 'test-pkg', type: 'web', entry: 'index.html' }),
    'index.html': '<!DOCTYPE html><html><body>Hello Archive</body></html>',
    'app.js': 'console.log("hi");\n'.repeat(200), // compressible
    'sub/data.txt': 'x'.repeat(5000),
  };
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(src, rel), content);
  }

  const archive = join(work, 'test.lume');
  execFileSync('zip', ['-r', '-X', '-q', archive, '.'], { cwd: src });

  const buf = readFileSync(archive);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  console.log('== unzip (real zip tool output) ==');
  const entries = await unzip(ab);
  const byName = Object.fromEntries(
    entries.map((e) => [normalizeEntryName(e.name), new TextDecoder().decode(e.bytes)])
  );

  check('entry count matches', Object.keys(byName).length === Object.keys(files).length,
    `got ${Object.keys(byName).sort()} want ${Object.keys(files).sort()}`);
  for (const [rel, content] of Object.entries(files)) {
    check(`content round-trips: ${rel}`, byName[rel] === content,
      `got ${(byName[rel] ?? '').slice(0, 40)}…`);
  }
  check('no directory entries returned', !entries.some((e) => e.name.endsWith('/')));

  // ---- deflate path is actually exercised (app.js is large + compressible) ----
  const raw = readFileSync(join(src, 'app.js')).length;
  check('archive smaller than raw (deflate used)', buf.length < raw, `${buf.length} vs ${raw}`);

  // ---- reject a non-zip ----
  console.log('== rejects non-archives ==');
  let threw = false;
  try {
    await unzip(new TextEncoder().encode('definitely not a zip file').buffer);
  } catch { threw = true; }
  check('throws on non-zip input', threw);

} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
