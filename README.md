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

**Live demo (GitHub Pages):** https://sufiyan-sabeel.github.io/LumeOS-web/
— the frontend-only build. It runs entirely offline from OPFS + the
service worker, so the C backend is not required (the tray will read
"offline", which is expected there).

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

There are four suites in total:

| Suite | Command | Covers |
|-------|---------|--------|
| C unit | `./build/lume-tests` | hashing, string/JSON/URL helpers, path-traversal rejection, token auth |
| Backend integration | `python3 tests/integration_test.py` | live server: CRUD, auth gating, traversal, packages, source export |
| Archive reader | `make test-zip` | `.lume` ZIP extraction against real `zip` output (STORE + DEFLATE) |
| Static site E2E | `make test-e2e` | headless Chromium: boot from a subpath, App Store catalog, install, offline launch |
| Responsive / interaction | `python3 tests/responsive_e2e.py` | all six viewports, desktop + mobile shells, window controls, keyboard management, panels, persistence, breakpoint switching |


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

## The shell

LumeOS ships two deliberately designed shells and switches between them
automatically at 820px (or on request in **Settings → Layout**).

**Desktop** — a top status bar (clock, backend state, storage, notifications,
quick settings), a desktop icon grid, a dock with a launcher and running-app
indicators, a searchable application launcher, a notification centre with quick
settings, and context menus on the desktop, icons and dock items.

**Mobile** — a home screen with a clock and app grid, full-screen app views with
a back action, a bottom navigation bar within thumb reach, and a recents sheet.
Touch targets are at least 44×44 CSS pixels, safe-area insets are respected,
and the layout is verified from 320px up in both orientations.

Switching between them **moves the live application elements** between the
desktop and app layers, so an app keeps its state and DOM across the change.

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl`/`Cmd` + `Space` | Open the application launcher |
| `Alt` + arrows | Move the focused window |
| `Alt` + `Shift` + arrows | Resize the focused window |
| `Alt` + `W` | Maximise / restore |
| `Alt` + `M` | Minimise |
| `Alt` + `Q` | Close the focused window |
| `Alt` + `Tab` | Cycle windows |
| `Escape` | Close the launcher, panel, menu or recents |
| `Ctrl`/`Cmd` + `S` | Save (Notes, where applicable) |

### Interface icons

Interface icons are inline, stroke-based SVGs (`frontend/components/icons.ts`)
that inherit `currentColor`. Emoji are not used for UI icons — they render
inconsistently across platforms and cannot be styled or aligned reliably. They
are still accepted as a fallback for third-party packages that supply one.

## Applications

| App | What it does |
|-----|--------------|
| **Files** | Dual-source explorer: the C backend's `data/files/` volume and the offline OPFS volume. Create, rename, delete, open in Notes. Single-pane with a segmented control on mobile. |
| **Terminal** | Shell over the VFS: `ls`, `cat`, `mkdir`, `touch`, `write`, `rm`, `cd`, `sysinfo`, `pkgs`, `open`, `theme`, `help` |
| **Notes** | Real note management: create, open, rename, delete and autosave, persisted through the VFS |
| **Calculator** | Arithmetic with keyboard input, history and safe expression parsing |
| **Settings** | Theme, accent, wallpaper, reduced motion, shell layout, backend connection, storage usage, source download, reset |
| **App Store** | Installs Web / AI-model / Native packages from `packages/` |
| **Downloads** | Live queue with real progress, pause and cancel |
| **AI Center** | WebGPU / WASM SIMD / threads capability scan, downloaded-model list, offline chat |
| **Browser** | Local VFS documents via blob URLs and external pages where embedding is permitted |

Every visible control performs its advertised action or is disabled with a
reason. Failures surface as real error states — the Files app, for example,
shows why the server volume is unavailable instead of inventing contents.

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
│   ├── styles/        design tokens, desktop, mobile, apps
│   ├── components/    Window, Toast, Modal, SVG icon set
│   ├── desktop/       kernel, window manager, desktop, mobile, state, events, downloads
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
├── tests/             C unit tests + Python integration and browser suites
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

## Deployment

### GitHub Pages (static, frontend-only)

```bash
make pages          # -> build/pages/
```

Publish the contents of `build/pages/` to a `gh-pages` branch (or any static
host). The live demo above is exactly this build.

Because Pages serves static files only, the C backend cannot run there — and it
does not need to. The PWA is designed to work offline: the kernel falls back to
OPFS, the service worker serves the shell and any installed apps, and the App
Store reads the **static** `packages/index.json` catalog. Everything is
base-path aware, so the same build works at the domain root (behind the C
server) and under a subpath such as `/LumeOS-web/`.

### GitHub Releases

```bash
make release-assets   # -> build/release/
```

Produces the source archive plus the published `.lume` packages, which are
attached to each tagged release.

## Packages

LumeOS packages are distributed two ways, and the App Store understands both.

**1. Directory bundle** — a folder in `packages/` with `manifest.lume.json` and
its assets. Listed by `GET /api/packages`.

**2. `.lume` archive** — a standard ZIP containing `manifest.lume.json` at the
root. Built with `make release-assets`, published as a release asset, and
listed in the static catalog `packages/index.json`:

```json
{
  "id": "hello-canvas",
  "name": "Hello Canvas",
  "glyph": "🎨",
  "type": "web",
  "version": "1.0.0",
  "entry": "index.html",
  "path": "hello-canvas",
  "archive": "hello-canvas.lume",
  "checksums": { "hello-canvas.lume": "<sha256>" }
}
```

The App Store downloads the archive, **verifies its SHA-256** against the
catalog, and extracts it entirely client-side with `storage/zip.ts` — a
dependency-free ZIP reader built on the browser's native
`DecompressionStream('deflate-raw')`. Files land in OPFS under `/<id>/`, the app
is registered, and an icon appears on the desktop with no reload.

Package types: `web` (runs in a sandboxed iframe), `ai-model` (weights into
`OPFS/models/`), and `native` (host-OS detection + installer or runtime
bridge).

## License

MIT — see [LICENSE](LICENSE).
