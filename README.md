# LumeOS-web

**A lightweight hybrid web-desktop operating system** — a high-performance C
backend server paired with a zero-framework Vanilla TypeScript desktop,
installable as a Progressive Web App with full offline persistence, a
window-managed desktop, local AI capability detection and a real package
installation workflow.

```
Frontend : HTML5 · CSS3 · Vanilla TypeScript (no framework, strict mode)
Backend  : C11 · POSIX sockets · pthreads · HTTP/1.1
Storage  : IndexedDB + OPFS (offline) ⇄ data/files/ (C server, online)
Delivery : Installable PWA (manifest.json + service-worker.js)
```

---

## Quick start

```bash
# 1. Build everything (C backend + TypeScript frontend)
make

# 2. Run the OS
make run
#   -> LumeOS listening on http://127.0.0.1:8080
```

Open **http://localhost:8080** in a modern browser (Chrome/Edge/Safari/Firefox).
Your browser will offer to **install LumeOS** to your desktop — install it and
it runs as a standalone windowed application, and continues to work offline if
you stop the server.

### Requirements

| Tool | Purpose | Notes |
|------|---------|-------|
| C compiler | builds `backend/` + `engine/` | `gcc` or `clang`, C11 |
| `make` | build orchestration | GNU make |
| Node.js ≥ 18 | runs the TypeScript compiler | `tsc` |

TypeScript is the only build-time dependency. Install it with
`npm install` inside `frontend/`, or globally (`npm i -g typescript`).

### Manual build (no make)

```bash
# Backend
cc -std=c11 -Wall -Wextra -O2 -pthread -Iengine -Ibackend/include \
   engine/*.c backend/*.c -o build/lume-server

# Frontend
cd frontend && npx tsc -p tsconfig.json      # emits to ../build/web

# Run
./build/lume-server --port 8080 --webroot build/web --root .
```

---

## Make targets

| Target | Description |
|--------|-------------|
| `make` / `make all` | Build backend and frontend |
| `make backend` | Compile the C server only |
| `make frontend` | Compile TypeScript into `build/web/` |
| `make run` | Build, then start the server (`PORT=8080`) |
| `make test` | Build and run the C unit tests |
| `make package-source` | Create `build/lumeos-source.tar.gz` |
| `make clean` | Remove build artifacts |

Run the C tests directly with `./build/lume-tests`, and the backend
integration suite with `python3 tests/integration_test.py`.

---

## Server CLI

```
lume-server [options]

  -p, --port <n>      TCP port (default 8080)
      --webroot <dir> static frontend root (default frontend)
      --data <dir>    persistent data directory (default data)
      --packages <d>  package repository (default packages)
      --root <dir>    project root for source export (default .)
      --workers <n>   thread-pool size (default 4)
      --token <hex>   require X-Lume-Token on write endpoints
      --secure        generate a random session token and print it
      --verbose       debug logging
  -h, --help          show help
  -v, --version       show version
```

By default the server binds to **loopback only** (`127.0.0.1`) and runs with
token auth **off**, which is convenient for local development. Pass `--secure`
(or `--token <hex>`) to require a session token on all mutating endpoints; the
generated token is printed to the log and can be set in **Settings → C Backend
Connection**.

---

## HTTP API

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/health` | Liveness + version |
| `GET` | `/api/system/info` | Host OS, arch, CPU count, RAM, load, disk |
| `GET` | `/api/packages` | Lists `.lume` packages in `packages/` |
| `GET` | `/api/files/list?path=/` | Directory listing under `data/files/` |
| `GET` | `/api/files/read?path=/a.txt` | Read a file (+ SHA-256) |
| `POST` | `/api/files/write` | Write `{"path","content"}` *(token)* |
| `POST` | `/api/files/mkdir` | Create `{"path"}` *(token)* |
| `DELETE` | `/api/files/delete?path=` | Delete a file/dir *(token)* |
| `POST` | `/api/system/exec-native` | Run a **registered** binary *(token)* |
| `GET` | `/api/export/project` | Download the whole source tree as `.tar.gz` |
| `GET` | `/packages/<id>/<file>` | Serve package repository files |

All file routes are canonicalised through `realpath` and confined to
`data/files/`; `../` traversal is rejected before any filesystem access.

---

## Applications

| App | What it does |
|-----|--------------|
| **Files** | Dual-pane explorer: server `data/files/` ⇄ offline OPFS, with "Download LumeOS Source" |
| **Terminal** | Shell over the VFS (`ls`, `cat`, `mkdir`, `write`, `rm`, `cd`, `sysinfo`, `pkgs`, `open`, …) |
| **Notes** | Markdown/text editor persisted through the VFS |
| **Calculator** | Scientific/programmer calculator |
| **Settings** | Theme engine, backend connection, storage inspector, source export |
| **App Store** | Installs Web / AI-model / Native packages from `packages/` |
| **Downloads** | Live download queue with progress, pause, cancel |
| **AI Center** | WebGPU/SIMD/threads capability scan + offline micro-model chat |
| **Browser** | Renders local VFS documents and external URLs in a sandboxed frame |

---

## Installable web apps

A web package is a directory under `packages/` containing `manifest.lume.json`:

```json
{
  "id": "hello-canvas",
  "name": "Hello Canvas",
  "glyph": "🎨",
  "type": "web",
  "version": "1.0.0",
  "entry": "index.html",
  "files": ["index.html", "app.js", "lume-bridge.js"]
}
```

Installation flow (App Store → Downloads → Desktop):

1. **Download** — each file is streamed with progress (`ReadableStream`).
2. **Verify** — optional `checksums` map is checked with SHA-256.
3. **Unpack** — files are written into OPFS under `/<id>/`.
4. **Register** — the app is recorded in IndexedDB and an icon appears on the
   desktop immediately, with no page reload.
5. **Run** — launched in a sandboxed `<iframe>` at
   `/apps/installed/<id>/<entry>`, which the **service worker** serves straight
   from OPFS — so it runs with the network (and the server) switched off.

Installed apps reach the OS through `window.LumeOS` (see
`packages/hello-canvas/lume-bridge.js`), which relays
`fs.read` / `fs.write` / `fs.list` / `notify` calls to the kernel over
`postMessage`.

Sample packages shipped: `hello-canvas`, `markdown-studio` (web),
`tiny-ai` (AI model), `notes-pro` (native).

---

## Repository layout

```
LumeOS-web/
├── frontend/          Vanilla TypeScript desktop client
│   ├── index.html     bootloader + desktop shell
│   ├── styles/        CSS3 design tokens, desktop, apps
│   ├── components/    Window, Toast, Modal
│   ├── desktop/       kernel, window manager, desktop, state, events, downloads
│   ├── apps/          the nine built-in applications + registry
│   ├── storage/       IndexedDB, OPFS, VFS, API client
│   ├── workers/       hash worker, AI worker
│   ├── service-worker.js
│   └── manifest.json
├── backend/           C HTTP/1.1 server
│   ├── main.c         sockets, thread pool, request parsing
│   ├── routes.c       router, static serving, response helpers
│   ├── files.c        data/files/ CRUD
│   ├── system.c       telemetry, packages, native exec, source export
│   ├── security.c     path canonicalisation, tokens, CORS
│   └── include/
├── engine/            core.c / core.h — logging, SHA-256, CRC32, JSON, VFS utils
├── data/              persistent state (files, database, models, logs)
├── packages/          downloadable .lume package repository
├── tests/             C unit tests + Python integration suite
├── docs/              architecture and PRD analysis
├── Makefile
└── README.md
```

---

## Security model

* **Path containment** — every request path is resolved with `realpath` and
  verified to stay inside its root; `..`, encoded traversal and control
  characters are rejected (`lume_secure_path`).
* **Token auth** — mutating endpoints accept `X-Lume-Token` or
  `Authorization: Bearer …`, compared in constant time.
* **Native execution** — `exec-native` only runs basenames present in
  `data/database/native_registry.txt`; shell metacharacters are refused.
* **Hardening headers** — `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, and CORS on the API.
* **Loopback binding** — the listener binds `127.0.0.1` by default.

See `docs/ARCHITECTURE.md` for the full design and `docs/PRD-ANALYSIS.md` for
the requirements traceability matrix.

---

## License

MIT — see [LICENSE](LICENSE).
