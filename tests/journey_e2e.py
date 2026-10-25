#!/usr/bin/env python3
"""LumeOS user-journey test — finds real runtime breakage.

Serves the site from a subpath exactly like GitHub Pages (unknown paths
return a 404 HTML document, including /api/*), then walks a full user
journey in a real headless Chromium:

  * boot and check the shell is complete
  * open EVERY application from the launcher and assert each one renders
    something and throws nothing
  * exercise Settings controls
  * run the real package install flow
  * collect every uncaught exception and console error

Any uncaught error is reported with its message and stack.
"""
import functools
import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request

import websocket

SITE_ROOT = "/scratch/work/site"
SUBPATH = "/LumeOS-web/"
HTTP_PORT = int(os.environ.get("JOURNEY_HTTP_PORT", "8911"))
CDP_PORT = int(os.environ.get("JOURNEY_CDP_PORT", "9911"))
CHROME = "/usr/local/bin/chromium"
PROFILE = "/tmp/chrome-journey"

APPS = ["files", "terminal", "notes", "calculator", "settings",
        "app-store", "downloads", "ai-center", "browser"]

passed = 0
failed = 0
errors = []      # uncaught exceptions + console errors
failed_requests = []


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_error(self, code, message=None, explain=None):
        if code == 404:
            failed_requests.append(self.path)
        super().send_error(code, message, explain)


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=40, suppress_origin=True)
        self.ws.settimeout(40)
        self._id = 0

    def send(self, method, params=None):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                raw = self.ws.recv()
            except Exception:
                break
            if not raw:
                continue
            msg = json.loads(raw)
            if msg.get("id") == mid:
                return msg
            self._event(msg)
        return {}

    def _event(self, msg):
        m = msg.get("method")
        if m == "Runtime.exceptionThrown":
            d = msg["params"]["exceptionDetails"]
            desc = (d.get("exception") or {}).get("description") or d.get("text", "")
            errors.append(f"UNCAUGHT: {desc[:400]}")
        elif m == "Runtime.consoleAPICalled" and msg["params"].get("type") == "error":
            parts = [str(a.get("value", a.get("description", "")))[:200]
                     for a in msg["params"].get("args", [])]
            errors.append("CONSOLE.ERROR: " + " ".join(parts)[:400])
        elif m == "Log.entryAdded":
            e = msg["params"]["entry"]
            if e.get("level") == "error":
                errors.append(f"LOG.ERROR: {e.get('text','')[:300]}")

    def eval(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
        })
        res = r.get("result", {})
        if res.get("exceptionDetails"):
            d = res["exceptionDetails"]
            desc = (d.get("exception") or {}).get("description") or d.get("text", "")
            errors.append(f"EVAL: {desc[:300]}")
            return None
        return res.get("result", {}).get("value")

    def wait_for(self, expr, timeout=20, interval=0.2):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.eval(expr) is True:
                return True
            time.sleep(interval)
        return False

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def launch(url):
    subprocess.run(["rm", "-rf", PROFILE], check=False)
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
        "--disable-dev-shm-usage", f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*", f"--user-data-dir={PROFILE}",
        "--window-size=1280,800", url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 40
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/list", timeout=2) as r:
                targets = json.loads(r.read())
            pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                return proc, pages[0]["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.4)
    proc.kill()
    raise RuntimeError("chromium debugger never came up")


BOOTED = ("document.getElementById('lume-shell') && "
          "document.getElementById('lume-shell').hidden === false")


def main():
    handler = functools.partial(Handler, directory=SITE_ROOT)
    httpd = Server(("127.0.0.1", HTTP_PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{HTTP_PORT}{SUBPATH}"

    proc, ws = launch(base)
    cdp = CDP(ws)
    cdp.send("Runtime.enable")
    cdp.send("Log.enable")
    cdp.send("Page.enable")

    try:
        print("== boot ==")
        check("shell mounted", cdp.wait_for(BOOTED, timeout=45))
        check("no boot failure", cdp.eval("!document.body.innerText.includes('Boot failed')"))
        check("dock built", cdp.eval("!!document.querySelector('.dock__launcher')"))
        check("status bar built", cdp.eval("document.querySelector('.statusbar').children.length >= 2"))
        check("desktop icons built",
              (cdp.eval("document.querySelectorAll('.icon').length") or 0) >= 9,
              str(cdp.eval("document.querySelectorAll('.icon').length")))

        print("== launcher lists every app ==")
        cdp.eval("document.querySelector('.dock__launcher').click()")
        cdp.wait_for("document.getElementById('launcher').hidden === false")
        listed = cdp.eval("[...document.querySelectorAll('.launcher__app')].map(e=>e.innerText.trim())")
        check("launcher has 9 apps", isinstance(listed, list) and len(listed) == 9, str(listed))
        for name in ["Settings", "App Store", "Files", "Notes", "Terminal", "Browser",
                     "Calculator", "Downloads", "AI Center"]:
            check(f"launcher lists {name}", isinstance(listed, list) and name in listed, str(listed))
        cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")

        print("== open every application ==")
        for app in APPS:
            cdp.eval(f"window.LumeOS.apps.open('{app}')")
            time.sleep(0.9)
            info = cdp.eval("""(() => {
                const w = [...document.querySelectorAll('.window')]
                    .filter(x => x.dataset.windowId && x.dataset.windowId.includes(arguments0));
                return null;
            })()""") if False else None
            state = cdp.eval("""(() => {
                const wins = [...document.querySelectorAll('.window')];
                const w = wins[wins.length - 1];
                if (!w) return {found: false};
                const body = w.querySelector('.window__body');
                return {
                    found: true,
                    title: (w.querySelector('.titlebar__title')||{}).textContent || '',
                    bodyChildren: body ? body.children.length : -1,
                    bodyText: body ? body.innerText.trim().length : -1,
                    focused: w.classList.contains('focused'),
                };
            })()""")
            ok = bool(state) and state.get("found") and state.get("bodyChildren", 0) > 0
            check(f"app '{app}' mounts content", ok, str(state))
            if app == "settings" and state and state.get("found"):
                controls = cdp.eval("""(() => {
                    const wins = [...document.querySelectorAll('.window')];
                    const w = wins[wins.length - 1];
                    const b = w.querySelector('.window__body');
                    return {
                        sections: b.querySelectorAll('.settings__section').length,
                        rows: b.querySelectorAll('.settings__row').length,
                        selects: b.querySelectorAll('select').length,
                        inputs: b.querySelectorAll('input').length,
                        buttons: b.querySelectorAll('button').length,
                    };
                })()""")
                check("settings has sections", (controls or {}).get("sections", 0) >= 5, str(controls))
                check("settings has controls",
                      (controls or {}).get("rows", 0) >= 8 and (controls or {}).get("buttons", 0) >= 3,
                      str(controls))
            cdp.eval("""(() => {
                const wins = [...document.querySelectorAll('.window')];
                const w = wins[wins.length - 1];
                const c = w && w.querySelector('.win-btn.close');
                if (c) c.click();
            })()""")
            time.sleep(0.35)

        print("== app store install flow ==")
        cdp.eval("window.LumeOS.apps.open('app-store')")
        cdp.wait_for("document.querySelectorAll('.card').length >= 4", timeout=25)
        cards = cdp.eval("document.querySelectorAll('.card').length")
        check("catalog rendered", (cards or 0) >= 4, str(cards))
        cdp.eval("""(() => {
            const c = [...document.querySelectorAll('.card')]
                .find(x => x.textContent.includes('Hello Canvas'));
            [...c.querySelectorAll('button')].find(b => /install/i.test(b.textContent)).click();
        })()""")
        installed = cdp.wait_for(
            "window.LumeOS.apps.installed().some(a => a.id === 'hello-canvas')", timeout=40)
        check("package installed", installed)
        check("package files in OPFS", cdp.eval("""(async () => {
            try {
                const root = await navigator.storage.getDirectory();
                const d = await root.getDirectoryHandle('hello-canvas');
                const f = await d.getFileHandle('index.html');
                return (await (await f.getFile()).text()).includes('Hello Canvas');
            } catch (e) { return 'ERR: ' + e.message; }
        })()""", await_promise=True) is True)
        check("desktop icon added", cdp.wait_for(
            "[...document.querySelectorAll('.icon__label')].some(e=>e.textContent.includes('Hello Canvas'))"))

        print("== pinned dock apps (Settings always reachable) ==")
        pinned = cdp.eval("document.querySelectorAll('.dock__item').length")
        check("dock shows pinned apps", (pinned or 0) >= 5, str(pinned))
        labels = cdp.eval("[...document.querySelectorAll('.dock__item')].map(b=>b.getAttribute('aria-label'))")
        check("Settings is pinned to the dock",
              isinstance(labels, list) and any('Settings' in (l or '') for l in labels), str(labels))

        print("== storage tier integrity ==")
        tier_before = cdp.eval("import('./storage/local-fs.js').then(m=>m.localFs.tier())",
                               await_promise=True)
        check("local storage tier is opfs", tier_before == "opfs", str(tier_before))
        # A missing directory is a normal outcome and must NOT demote the tier.
        cdp.eval("import('./storage/local-fs.js').then(m=>m.localFs.list('/no-such-dir').catch(()=>0))",
                 await_promise=True)
        tier_after = cdp.eval("import('./storage/local-fs.js').then(m=>m.localFs.tier())",
                              await_promise=True)
        check("missing directory does not demote the storage tier",
              tier_after == tier_before, f"{tier_before} -> {tier_after}")

        print("== install fallback without DecompressionStream ==")
        cdp.eval("window.__ds = window.DecompressionStream; window.DecompressionStream = undefined;")
        cdp.eval("window.LumeOS.apps.open('app-store')")
        cdp.wait_for("document.querySelectorAll('.card').length >= 4", timeout=25)
        cdp.eval("""(() => {
            const c = [...document.querySelectorAll('.card')]
                .find(x => x.textContent.includes('Markdown Studio'));
            [...c.querySelectorAll('button')].find(b => /install/i.test(b.textContent)).click();
        })()""")
        fallback_ok = cdp.wait_for(
            "window.LumeOS.apps.installed().some(a => a.id === 'markdown-studio')", timeout=45)
        check("installs file-by-file when archives are unsupported", fallback_ok)
        check("fallback install wrote real files", cdp.eval("""(async () => {
            try {
                const r = await navigator.storage.getDirectory();
                const d = await r.getDirectoryHandle('markdown-studio');
                const f = await d.getFileHandle('index.html');
                return (await (await f.getFile()).text()).includes('Markdown Studio');
            } catch (e) { return 'ERR: ' + e.message; }
        })()""", await_promise=True) is True)
        cdp.eval("window.DecompressionStream = window.__ds;")

        print("== diagnostics ==")
        diag = cdp.eval("""(async () => {
            const win = [...document.querySelectorAll('.window')]
                .find(w => w.querySelector('.diag-list'));
            if (!win) return null;
            return [...win.querySelectorAll('.diag')].map(d => d.innerText.split('\\n')[0]);
        })()""", await_promise=True)
        cdp.eval("window.LumeOS.apps.open('settings')")
        cdp.wait_for("!!document.querySelector('.diag-list')", timeout=20)
        diag = cdp.eval("[...document.querySelectorAll('.diag')].map(d => d.innerText.split('\\n')[0])")
        check("diagnostics rendered in Settings", isinstance(diag, list) and len(diag) >= 5, str(diag))
        for want in ["Secure context", "Local file storage", "IndexedDB",
                     "Service worker", "C backend"]:
            check(f"diagnostics covers {want}",
                  isinstance(diag, list) and any(want in d for d in diag), str(diag))
        backend_detail = cdp.eval(
            "[...document.querySelectorAll('.diag')].map(d=>d.innerText).find(t=>t.includes('C backend')) || ''")
        check("backend diagnostic states the correct API URL",
              "/LumeOS-web/api/health" in (backend_detail or ""), (backend_detail or "")[:160])
        check("backend diagnostic explains how to fix it",
              "make run" in (backend_detail or "") and "GitHub Pages" in (backend_detail or ""),
              (backend_detail or "")[:200])

        print("== backend reachability (Pages has no C server) ==")
        online = cdp.eval("window.LumeOS && document.querySelector('.statusbar') ? "
                          "document.querySelector('.statusbar').innerText.includes('online') : null")
        print(f"   status bar reports online = {online}  (expected False on a static host)")
        check("no uncaught errors from the failed API probe",
              not any("UNCAUGHT" in e for e in errors), "; ".join(errors[:2])[:200])

        print("== console health ==")
        real = [e for e in errors
                if "favicon" not in e and "ERR_FAILED" not in e
                and "net::" not in e and "Failed to load resource" not in e]
        check("no uncaught exceptions / console errors", len(real) == 0,
              " || ".join(real[:3])[:500])

        print("== failed requests (expected: /api/* only) ==")
        unexpected = [p for p in failed_requests
                      if "/api/" not in p and "favicon" not in p]
        print(f"   {len(failed_requests)} 404s; unexpected (non-API): {unexpected[:6]}")
        check("no unexpected 404s", len(unexpected) == 0, str(unexpected[:6]))

    finally:
        cdp.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        httpd.shutdown()

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
