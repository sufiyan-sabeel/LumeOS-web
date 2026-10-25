# LumeOS Architecture

## 1. Overview

LumeOS is two cooperating halves joined by HTTP:

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (installable PWA)                                       │
│                                                                  │
│  kernel.ts ──► WindowManager ──► LumeWindow  (desktop shell)     │
│      │                                                           │
│      ├── storage/api.ts   ── HTTP ──┐                            │
│      ├── storage/opfs.ts  (local)   │                            │
│      ├── storage/idb.ts   (local)   │                            │
│      └── storage/vfs.ts   ─ routes ─┘                            │
│                                                                  │
│  service-worker.js  ── offline cache + /apps/installed + /__vfs__│
└──────────────────────────────────────────────────────────────────┘
                                 │ HTTP/1.1 (loopback)
┌──────────────────────────────────────────────────────────────────┐
│  C server                                                        │
│                                                                  │
│  main.c      socket → thread pool → parse → route → respond      │
│  routes.c    router · static serving · response helpers          │
│  files.c     data/files/ CRUD                                    │
│  system.c    telemetry · packages · native exec · source export  │
│  security.c  realpath containment · token auth · CORS            │
│  engine/core.c  logging · SHA-256 · CRC32 · JSON · MIME · files  │
└──────────────────────────────────────────────────────────────────┘
```

The frontend is **usable without the server**: `storage/vfs.ts` falls back to
OPFS whenever the backend is unreachable, and the service worker keeps the app
shell available offline. The server adds a shared, on-disk virtual disk, host
telemetry and package hosting.

## 2. Backend (C11)

### 2.1 Concurrency model (`backend/main.c`)

* One listener socket bound to `127.0.0.1:<port>`.
* A **bounded thread pool** (default 4 workers) consumes accepted connections
  from a mutex/cond-protected ring buffer (`conn_queue_t`). The queue applies
  back-pressure at 128 pending connections.
* Each worker parses one request, dispatches it, writes the response and closes
  the connection (`Connection: close`). Socket read/write timeouts (15 s) stop a
  stalled client from pinning a worker.
* `SIGINT`/`SIGTERM` set a flag, shut the listener down and drain the pool.

### 2.2 Request parsing

`read_headers()` accumulates bytes until `\r\n\r\n`, then `parse_request()`
splits the request line (method, target, version), separates `?query`,
percent-decodes the path, and extracts `Content-Length`, `Content-Type`,
`X-Lume-Token`, `Authorization`, `Host` and `Origin`.

A subtle but important detail: header parsing writes `\0` over CRLFs in place,
so the pointer to the body (`body_start + 4`) is captured **before** the header
loop runs — otherwise the terminator is destroyed and the body is lost.

### 2.3 Routing (`backend/routes.c`)

`lume_route()` maps exact paths to handlers, serves `/packages/*` from the
repository, and treats everything else as a static asset under `webroot`. Static
paths run through `lume_secure_path()` first; directories fall back to
`index.html`; MIME types come from `lume_mime_type()`.

### 2.4 Security (`backend/security.c`)

`lume_secure_path(root, requested, out, outsz)`:

1. rejects control characters and over-long paths;
2. canonicalises `root` with `realpath`;
3. if the target exists, resolves it and requires it to be **within** root;
4. if it does not exist (writes, `mkdir`), walks up to the **deepest existing
   ancestor**, requires that ancestor to be within root, validates every
   remaining path component (no `.`, `..`, empty), and re-attaches the suffix.

This supports creating `data/files/a/b/c.txt` while making a climb out of the
root (for example, reaching the host password file) impossible. Token checks use constant-time comparison; CORS and hardening
headers are applied to every response.

### 2.5 Engine (`engine/core.c`)

A dependency-free utility library: levelled logging, string helpers, a growable
string buffer, JSON escaping and object builders, a from-scratch **SHA-256**
(FIPS 180-4) and **CRC32**, MIME resolution, portable file helpers and ISO-8601
timestamps. `lume_sha256_hex()` powers the `sha256` field on file reads and the
integrity model for packages.

## 3. Frontend (Vanilla TypeScript, `strict`)

### 3.1 Kernel (`desktop/kernel.ts`)

`LumeKernel.boot()` sequences: settings → IndexedDB → OPFS → backend health →
restore installed apps → register built-ins → mount `Desktop` and
`WindowManager` → expose `window.LumeOS` → register the service worker →
honour `?app=` / `?open=` launch parameters. It implements both `KernelApi`
(what apps consume) and `DesktopHost` (what the shell consumes), and owns the
`postMessage` bridge used by sandboxed installed apps.

### 3.2 Window manager (`desktop/window-manager.ts`)

Windows are absolutely positioned in `#window-layer`; focus is a monotonically
increasing `z-index`. Dragging uses pointer capture on the title bar; releasing
near an edge **snaps** (left half / right half / maximise) with a live preview.
Resize handles support the east, south and south-east edges. Each window owns a
taskbar button reflecting focus and minimise state.

### 3.3 Storage tiers

| Tier | File | Contents |
|------|------|----------|
| IndexedDB | `storage/idb.ts` | OS registry (installed apps), settings (`kv`) |
| OPFS | `storage/opfs.ts` | web-app bundles, AI model weights, binary blobs |
| C server | `data/files/` | shared on-disk virtual disk |

`storage/vfs.ts` is the single API apps use. It prefers the server when online
and `preferServer` is set, and transparently falls back to OPFS on any failure —
so the same `vfs.readText()` call works online and offline.

### 3.4 Service worker (`service-worker.js`)

* pre-caches the app shell on install;
* intercepts `/apps/installed/<id>/*` and `/__vfs__/*` and serves them from
  OPFS (this is what makes installed web apps run offline);
* never caches `/api/*` (live state);
* cache-first for same-origin GET assets, falling back to the cached shell.

### 3.5 Downloads and installation

`desktop/downloads.ts` streams each file with `ReadableStream`, tracks
`loaded/total`, and supports pause/cancel via `AbortController`. The App Store
drives it, verifies optional SHA-256 checksums, writes files into OPFS, then
registers the app in IndexedDB and on the desktop.

## 4. Data flow: installing a web app

```
App Store            Downloads            OPFS            IndexedDB     Desktop
    │  click Install      │                  │                 │           │
    ├─ GET /packages/<id>/manifest.lume.json │                 │           │
    ├────────────────────►│  stream files    │                 │           │
    │                     ├─ write /<id>/* ─►│                 │           │
    │                     │  (verify SHA-256)│                 │           │
    │◄── done ────────────┤                  │                 │           │
    ├─ kernel.installWebApp ─────────────────────────────────► │           │
    │                                                         │◄── icons ─┤
    └─ launch → iframe /apps/installed/<id>/index.html ◄── service worker ──┘
```

## 4b. Shell modes (desktop and mobile)

LumeOS has two shells and one set of application elements.

* **Desktop shell** (`desktop/desktop.ts`, `desktop/window-manager.ts`):
  status bar, icon grid, dock, launcher, notification centre with quick
  settings, context menus. Windows live in `#window-layer` and are freely
  positioned, draggable, resizable, snappable and keyboard-managed.
* **Mobile shell** (`desktop/mobile.ts`): home screen, bottom navigation and a
  recents sheet. Application views live in `#app-layer` and are presented
  full-screen, one at a time, with a back action.

The mode is derived from `window.innerWidth <= 820` unless the user pins a
preference, and is written to `data-shell` on the root element. All layout
differences are expressed in CSS against `[data-shell='mobile']`, so there is
exactly one place where the two shells diverge.

**State across the switch.** `WindowManager.setMode()` moves the *same*
`LumeWindow` elements between `#window-layer` and `#app-layer` and toggles the
`mobile-active` class. Because the DOM nodes are moved rather than rebuilt, an
open application keeps its state, scroll position and listeners when the
viewport crosses the breakpoint. The title bar carries both desktop controls
(minimise/maximise) and a mobile back button; CSS shows the appropriate set.

**Back semantics.** On mobile, back returns to the home screen and leaves the
application running (it appears in recents); on desktop, back closes the window.
The browser/device back action is wired through the History API so Android's
back gesture returns home before leaving LumeOS.

## 4c. Application state and honesty rules

* The Notes editor is inert until a note is selected, so text typed into an
  unsaved buffer can never be silently lost; notes are autosaved and flushed on
  close.
* The Files app targets a storage tier explicitly (`Vfs.listFrom('server'|'opfs')`)
  so the server volume and offline volume can be shown side by side, and it
  reports the real reason when a tier is unavailable.
* The Browser states plainly that many sites refuse framing and offers a
  one-click escape to a real tab; it does not claim unrestricted control.
* The AI Center runs a deterministic rule-based micro-model and says so rather
  than implying neural inference it cannot perform.

## 5. Testing

Five suites, 192 assertions, all run against the real build:

| Suite | Command | Assertions |
|-------|---------|-----------|
| C unit | `./build/lume-tests` | 41 — hashing, helpers, path traversal, token auth |
| Backend integration | `python3 tests/integration_test.py` | 39 — live server CRUD, auth, traversal, packages, export |
| Archive reader | `make test-zip` | 8 — `.lume` ZIP extraction vs real `zip` output |
| Static site E2E | `make test-e2e` | 29 — subpath boot, catalog, install, offline launch |
| Responsive / interaction | `python3 tests/responsive_e2e.py` | 76 — six viewports, both shells, window controls, keyboard, panels, persistence, breakpoint switching |

The browser suites drive headless Chromium over CDP and assert against the live
DOM. One caveat learned while building them: headless Chromium without a GPU can
leave a stale composited layer for elements that use `backdrop-filter`, so a
screenshot may show a ghost overlay even when the DOM asserts it is hidden.
The suites therefore assert DOM state rather than trusting the pixels.

## 6. Known limitations

* The AI Center ships a deterministic **rule-based micro-model**. Neural weights
  can be downloaded, but no GGUF/ONNX runtime is bundled, and the UI says so.
* Downloads pause and cancel, but do not resume mid-file.
* No WebSocket endpoint yet — the REST surface covers every PRD endpoint.
* Native packages detect the host OS and expose the installer/runtime bridge;
  launching a native binary requires it to be present and allow-listed in
  `data/database/native_registry.txt`.
* The Browser cannot embed sites that send `X-Frame-Options` /
  `frame-ancestors`, and cannot inspect cross-origin frames. It says so and
  offers to open the page in a real tab.
* The server is HTTP/1.1 with `Connection: close`; keep-alive is future work.
* Screenshots taken in headless Chromium without a GPU may show stale
  compositor layers for blurred elements (a capture artefact, not a UI bug).
