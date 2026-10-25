# LumeOS edge backend — Cloudflare Worker

A Worker implementation of the LumeOS HTTP API, so a LumeOS frontend hosted on a
static site (GitHub Pages, Netlify, S3) can talk to a **real HTTPS backend**.

## Why a port, not the C server

The native backend (`backend/*.c`) is a POSIX C server: it needs sockets,
threads, a real filesystem and `/proc`. Cloudflare Workers run JavaScript on V8
isolates and provide none of those, so **the C binary cannot run on Cloudflare**.
This Worker re-implements the same HTTP contract on the edge.

| Capability | Native C server | This Worker |
|---|---|---|
| `/api/health` | yes | yes |
| `/api/system/info` | real CPU/RAM/load/disk | edge metadata only (`telemetry: false`) |
| `/api/packages` | scans `packages/` | bundled catalogue |
| `/api/files/*` CRUD | `data/files/` on disk | Workers KV (optional binding) |
| `/api/system/exec-native` | allow-listed binaries | **501 — not possible** |
| `/api/export/project` | tars the source tree | **501 — needs a filesystem** |

## Deploy (about two minutes)

```bash
cd backend/worker
npx wrangler login          # opens a browser once
npx wrangler deploy
```

Wrangler prints a URL such as:

```
https://lumeos-api.<your-subdomain>.workers.dev
```

That is your backend link. Check it:

```bash
curl https://lumeos-api.<your-subdomain>.workers.dev/api/health
# {"status":"ok","service":"LumeOS","version":"1.1.0","runtime":"cloudflare-worker",...}
```

### Point LumeOS at it

Open LumeOS → **Settings → C backend connection → Server URL**, paste the
`https://…workers.dev` URL, and press **Apply and reconnect**. The status bar
should switch to *online*, and **Settings → Diagnostics** will confirm it.

You can also deep-link it: `https://<your-site>/?backend=https://lumeos-api.<sub>.workers.dev`

## Optional: persistent file storage

Without a KV binding the Worker still answers health, system info and packages —
file routes return `501` and the LumeOS client quietly keeps using local storage
for files. To enable server-side files:

```bash
npx wrangler kv namespace create LUME_FS
```

Paste the printed id into `wrangler.toml`, uncomment the `[[kv_namespaces]]`
block, and redeploy.

**Caveats of KV storage:** values are capped at 25 MB (this Worker enforces a
256 KB write limit), and KV is eventually consistent — a read immediately after
a write may briefly miss it. LumeOS falls back to local storage when a server
read fails, so this degrades gracefully rather than breaking.

## Optional: require a token

```bash
npx wrangler secret put LUME_TOKEN
```

Then paste the same value into LumeOS → Settings → Session token. Write,
mkdir and delete requests will require `X-Lume-Token`.

## Local development

```bash
npx wrangler dev            # http://localhost:8787
```

## Tests

The routes are covered by a Node harness that stubs KV — no deployment needed:

```bash
node tests/worker_test.mjs
```
