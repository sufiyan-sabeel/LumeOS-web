# PRD Analysis & Requirements Traceability

Source: `PRD.md` v1.0.0 — *LumeOS-web*.

This document records how the original Product Requirements Document was read,
what was built, and the honest status of each requirement.

## 1. What the PRD asks for

LumeOS-web is specified as a hybrid web-desktop OS:

* a custom **C** backend (HTTP/WebSocket server) and core engine;
* a **zero-framework Vanilla TypeScript** frontend desktop;
* installable as a **PWA** with **offline persistence**;
* three storage tiers (IndexedDB, OPFS, server `data/files/`);
* three package classes (**Web**, **AI-model**, **Native**) with a unified
  `.lume` manifest and a real install workflow;
* nine built-in applications;
* a self-contained **source export** action;
* a six-phase implementation plan and five acceptance criteria.

## 2. Phase status

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | C server foundation & build system | ✅ Complete — `Makefile`, `engine/core.*`, `backend/security.c`, `main.c`, `routes.c`, `files.c`, `system.c`; builds warning-free |
| **2** | Offline storage, VFS & PWA core | ✅ Complete — `manifest.json`, `service-worker.js` (shell cache, `/apps/installed`, `/__vfs__`), IndexedDB, OPFS, `vfs.ts` |
| **3** | Desktop environment & window manager | ✅ Complete — CSS3 tokens/glassmorphism, `WindowManager` (drag, resize, snap, z-index), taskbar, start menu, tray |
| **4** | Core built-in applications | ✅ Complete — files, terminal, settings, notes, calculator, browser (+ app-store, downloads, ai-center) |
| **5** | Real app install & AI Center workflow | ✅ Complete — packages repo, streaming downloads, install pipeline into OPFS + registry, capability detector, AI surface |
| **6** | Testing, source packaging & verification | ✅ Complete — 41 C unit assertions, 39 integration assertions, `/api/export/project` + in-app "Download Source" |

## 3. Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `make` compiles C + TypeScript cleanly | ✅ | Backend builds with `-Wall -Wextra` zero warnings; frontend `tsc` under `strict` zero errors |
| 2 | `http://localhost:8080` shows the desktop, passes PWA criteria, works offline | ✅ | `manifest.json` + `service-worker.js`; OPFS fallback in `vfs.ts`; shell pre-cached |
| 3 | End-to-end web app install (store → downloads → icon → offline launch) | ✅ | App Store → `downloads.ts` → OPFS → IndexedDB registry → desktop icon → sandboxed iframe served by the SW |
| 4 | Offline AI execution after download | ⚠️ Partial | Capability scan + offline chat work; a **rule-based micro-model** runs offline. Real neural inference needs a runtime that is not bundled — stated in the UI |
| 5 | Native app handling detects host OS, triggers installer or bridge | ✅ | `detectOs()` + `installers` map + `exec-native` (registry-gated) |

## 4. Deviations from the PRD (and why)

1. **No WebSocket endpoint.** The PRD lists WebSocket in the core-stack
   description. The HTTP/1.1 REST surface covers every listed endpoint, so
   WebSocket was deferred rather than half-implemented. The VFS sync design is
   request/response and works over REST.
2. **`.lume` packages are directory bundles, not zip archives.** A directory
   with `manifest.lume.json` avoids bundling a zip library in the frontend and
   keeps the install path dependency-free. `packages/` also supports `.lume`
   archive files in its listing.
3. **AI Center runs a rule-based micro-model.** The PRD asks for offline
   inference. Rather than fake a neural model, the build ships a deterministic
   offline responder and states plainly that a runtime is required for real
   weights. The message protocol is model-agnostic so a runtime can drop in.
4. **Downloads do not resume mid-file.** Pause/cancel are implemented via
   `AbortController`; true resumable range requests are future work.

## 5. Security requirements from the PRD

| Requirement | Implementation |
|-------------|----------------|
| Strict canonical path validation (`realpath`), no `../` escape | `lume_secure_path()` in `backend/security.c`; unit + integration tests |
| Local session token for sensitive endpoints | `lume_token_authorized()`, constant-time; enforced on write/mkdir/delete/exec-native |
| Sandboxing | installed apps run in a sandboxed `<iframe>` with a `postMessage` bridge only |
| CORS | `lume_apply_security_headers()` on every response |

## 6. Repository architecture vs PRD §2

Every directory named in the PRD exists with the specified responsibilities.
Notable file-level mapping:

| PRD file | Implemented as |
|----------|----------------|
| `backend/main.c` | socket, thread pool, request parsing, entry point |
| `backend/routes.c` | router, static serving, response helpers |
| `backend/files.c` | `data/files/` CRUD |
| `backend/system.c` | telemetry, packages, native exec, source export |
| `backend/security.c` | path containment, tokens, CORS |
| `engine/core.c` | hashing, JSON, strings, MIME, file helpers |
| `frontend/desktop/` | `kernel.ts`, `window-manager.ts`, `desktop.ts`, `state.ts`, `events.ts`, `downloads.ts` |
| `frontend/storage/` | `idb.ts`, `opfs.ts`, `vfs.ts`, `api.ts` |
| `frontend/workers/` | `hash-worker.ts`, `ai-worker.ts` |
| `frontend/apps/` | nine apps + `registry.ts` |
