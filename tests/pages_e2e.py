#!/usr/bin/env python3
"""End-to-end verification of the static (GitHub Pages) LumeOS build.

Serves the site from a SUBPATH (/LumeOS-web/), exactly as a GitHub Pages
project site does, then drives a real headless Chromium over the Chrome
DevTools Protocol to:

  1. boot the desktop from the subpath
  2. open the App Store and read the static packages/index.json catalog
  3. click "Install" on a web package and watch it land in OPFS
  4. confirm the icon appears on the desktop
  5. launch the installed app offline, served from OPFS by the service worker

Requires: chromium, python websocket-client.
"""
import functools
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request

import websocket

SITE_ROOT = "/scratch/work/site"
SUBPATH = "/LumeOS-web/"
HTTP_PORT = int(os.environ.get("PAGES_HTTP_PORT", "8311"))
CDP_PORT = int(os.environ.get("PAGES_CDP_PORT", "9311"))
CHROME = "/usr/local/bin/chromium"
PROFILE = "/tmp/chrome-pages-e2e"

passed, failed = 0, 0
console_errors = []


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


# ----------------------------------------------------------------------
# static server
# ----------------------------------------------------------------------
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def start_server():
    handler = functools.partial(Handler, directory=SITE_ROOT)
    httpd = Server(("127.0.0.1", HTTP_PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


# ----------------------------------------------------------------------
# minimal CDP client
# ----------------------------------------------------------------------
class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
        self.ws.settimeout(30)
        self._id = 0

    def send(self, method, params=None):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + 30
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
            ev = msg.get("method", "")
            if ev in ("Runtime.consoleAPICalled", "Log.entryAdded", "Runtime.exceptionThrown"):
                console_errors.append(json.dumps(msg)[:400])
        return {}

    def eval(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": await_promise,
        })
        result = r.get("result", {}).get("result", {})
        if "value" in result:
            return result["value"]
        return None

    def wait_for(self, expr, timeout=30, interval=0.25):
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


def launch_chrome(url):
    subprocess.run(["rm", "-rf", PROFILE], check=False)
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
        "--disable-dev-shm-usage", f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={PROFILE}", "--window-size=1280,800",
        "--autoplay-policy=no-user-gesture-required", url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # wait for the debugger endpoint
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
    raise RuntimeError("chromium debugger endpoint never came up")


# ----------------------------------------------------------------------
def main():
    if not os.path.isdir(os.path.join(SITE_ROOT, "LumeOS-web")):
        print("site not built: run the site build first")
        return 1

    live = os.environ.get("LIVE_URL")
    if live:
        base = live if live.endswith("/") else live + "/"
        httpd = None
        print(f"targeting live site: {base}")
    else:
        httpd = start_server()
        base = f"http://127.0.0.1:{HTTP_PORT}{SUBPATH}"

    # ---------- 0. published package repository integrity ----------
    print("== 0. published package repository ==")
    import hashlib
    try:
        with urllib.request.urlopen(f"{base}packages/index.json", timeout=10) as r:
            idx = json.loads(r.read())
    except Exception as e:
        print("  FAIL  catalog fetch:", e)
        if httpd:
            httpd.shutdown()
        return 1
    check("catalog published with 4 packages", len(idx.get("packages", [])) == 4,
          str([p.get("id") for p in idx.get("packages", [])]))
    for p in idx.get("packages", []):
        arch = p.get("archive")
        if not arch:
            continue
        with urllib.request.urlopen(f"{base}packages/{arch}", timeout=10) as r:
            body = r.read()
        check(f"{arch} is a zip", body[:2] == b"PK", body[:4].hex())
        want = (p.get("checksums") or {}).get(arch)
        got = hashlib.sha256(body).hexdigest()
        check(f"{arch} sha256 matches catalog", want == got, f"{want} != {got}")

    proc, ws_url = launch_chrome(base)
    cdp = CDP(ws_url)
    cdp.send("Runtime.enable")
    cdp.send("Page.enable")

    try:
        # ---------- 1. boot ----------
        print("== 1. boot from subpath ==")
        ok = cdp.wait_for(
            "document.getElementById('lume-shell') && "
            "document.getElementById('lume-shell').hidden === false", timeout=45)
        check("desktop mounted", ok)
        check("no boot failure", cdp.eval("!document.body.innerText.includes('Boot failed')"))
        icons = cdp.eval("[...document.querySelectorAll('.icon__label')].map(e=>e.textContent)")
        check("desktop icons rendered", isinstance(icons, list) and len(icons) >= 9, str(icons))
        check("dock launcher present", cdp.eval("!!document.querySelector('.dock__launcher')"))
        check("launcher populated", cdp.eval("""(() => {
            document.querySelector('.dock__launcher').click();
            return document.querySelectorAll('.launcher__app').length >= 9;
        })()"""))
        cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
        time.sleep(0.3)
        check("status bar shows server offline", "offline" in (cdp.eval(
            "document.querySelector('.statusbar') ? document.querySelector('.statusbar').innerText : ''") or ""))
        check("service worker registered", cdp.eval(
            "navigator.serviceWorker.getRegistrations().then(r=>r.length>0)", await_promise=True))
        check("global LumeOS API exposed", cdp.eval("typeof window.LumeOS === 'object'"))

        # ---------- 2. app store catalog from static JSON ----------
        print("== 2. app store (static packages/index.json) ==")
        cdp.eval("window.LumeOS.apps.open('app-store')")
        ok = cdp.wait_for("document.querySelectorAll('.card').length >= 4", timeout=30)
        check("catalog cards rendered", ok,
              cdp.eval("document.querySelectorAll('.card').length") .__str__() if False else "")
        names = cdp.eval("[...document.querySelectorAll('.card__title')].map(e=>e.innerText)")
        check("catalog lists 4 packages", isinstance(names, list) and len(names) == 4, str(names))
        flat = " | ".join(names or [])
        for want in ("Hello Canvas", "Markdown Studio", "Tiny Offline Model", "Notes Pro"):
            check(f"catalog contains {want}", want in flat, flat)
        check("install buttons present", cdp.eval(
            "[...document.querySelectorAll('.card button')].some(b=>/install/i.test(b.textContent))"))

        # ---------- 3. install a web package ----------
        print("== 3. install Hello Canvas ==")
        clicked = cdp.eval("""(() => {
            const cards = [...document.querySelectorAll('.card')];
            const c = cards.find(x => x.textContent.includes('Hello Canvas'));
            if (!c) return 'no-card';
            const b = [...c.querySelectorAll('button')].find(x => /install/i.test(x.textContent));
            if (!b) return 'no-button';
            b.click();
            return 'clicked';
        })()""")
        check("install button clicked", clicked == "clicked", str(clicked))

        installed = cdp.wait_for(
            "window.LumeOS.apps.installed().some(a => a.id === 'hello-canvas')", timeout=45)
        check("package registered as installed", installed)

        opfs_ok = cdp.eval("""(async () => {
            try {
              const root = await navigator.storage.getDirectory();
              const d = await root.getDirectoryHandle('hello-canvas');
              const f = await d.getFileHandle('index.html');
              const file = await f.getFile();
              const txt = await file.text();
              return txt.includes('Hello Canvas');
            } catch (e) { return 'ERR: ' + e.message; }
        })()""", await_promise=True)
        check("files unpacked into OPFS", opfs_ok is True, str(opfs_ok))

        icon_present = cdp.wait_for(
            "[...document.querySelectorAll('.icon__label')].some(e=>e.textContent.includes('Hello Canvas'))",
            timeout=20)
        check("desktop icon added without reload", icon_present)

        # ---------- 4. launch it offline (served from OPFS by the SW) ----------
        print("== 4. launch installed app offline ==")
        cdp.eval("window.LumeOS.apps.open('hello-canvas')")
        frame_ok = cdp.wait_for("""(() => {
            const f = [...document.querySelectorAll('iframe')]
              .find(x => (x.src||'').includes('/apps/installed/hello-canvas/'));
            if (!f) return false;
            try {
              const d = f.contentDocument;
              return !!(d && d.body && d.body.innerText.includes('Hello Canvas'));
            } catch (e) { return false; }
        })()""", timeout=30)
        check("installed app served from OPFS and rendered", frame_ok,
              cdp.eval("[...document.querySelectorAll('iframe')].map(f=>f.src)"))

        # ---------- 5. no console errors ----------
        print("== 5. console health ==")
        real_errors = [e for e in console_errors
                       if "favicon" not in e and "ERR_FAILED" not in e]
        check("no uncaught console errors", len(real_errors) == 0,
              "; ".join(real_errors[:2])[:300])

        # ---------- 6. screenshot ----------
        shot = "/scratch/work/pages_desktop.png"
        cdp.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))",
                 await_promise=True)
        time.sleep(0.35)
        r = cdp.send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
        data = r.get("result", {}).get("data")
        if data:
            import base64
            open(shot, "wb").write(base64.b64decode(data))
        check("screenshot captured", os.path.exists(shot) and os.path.getsize(shot) > 10000)

    finally:
        cdp.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        if httpd:
            httpd.shutdown()

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
