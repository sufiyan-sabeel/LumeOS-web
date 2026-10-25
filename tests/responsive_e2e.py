#!/usr/bin/env python3
"""LumeOS responsive + interaction verification.

Drives a real headless Chromium over CDP against the static build served
from a subpath, and checks:

  * all six representative viewports for horizontal overflow and shell mode
  * desktop shell: launcher + search, window controls, keyboard management,
    notification centre / quick settings, theme toggle
  * mobile shell: home screen, app views, back, recents, touch target sizes
  * persistence: notes survive a reload
  * resizing across the mobile/desktop breakpoint

Requires: chromium, python websocket-client.
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
HTTP_PORT = int(os.environ.get("RESP_HTTP_PORT", "8411"))
CDP_PORT = int(os.environ.get("RESP_CDP_PORT", "9411"))
CHROME = "/usr/local/bin/chromium"
PROFILE = "/tmp/chrome-resp-e2e"

VIEWPORTS = [
    ("small mobile", 320, 568, "mobile"),
    ("Android phone", 360, 800, "mobile"),
    ("modern phone", 390, 844, "mobile"),
    ("tablet", 768, 1024, "mobile"),
    ("laptop", 1280, 800, "desktop"),
    ("desktop", 1440, 900, "desktop"),
]

passed = 0
failed = 0
console_errors = []


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
            if msg.get("method") in (
                "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"
            ):
                console_errors.append(json.dumps(msg)[:300])
        return {}

    def eval(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
        })
        res = r.get("result", {})
        if res.get("exceptionDetails"):
            return None
        out = res.get("result", {})
        return out.get("value")

    def wait_for(self, expr, timeout=25, interval=0.2):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.eval(expr) is True:
                return True
            time.sleep(interval)
        return False

    def viewport(self, w, h, mobile):
        self.send("Emulation.setDeviceMetricsOverride", {
            "width": w, "height": h, "deviceScaleFactor": 1, "mobile": mobile,
        })
        self.send("Emulation.setTouchEmulationEnabled", {"enabled": mobile})
        time.sleep(0.45)

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



def shot(cdp, path):
    """Capture a screenshot from a freshly composited frame.

    Headless Chromium without a GPU leaves stale compositor layers behind for
    elements that use backdrop-filter, so blur is suspended for the capture
    only. This affects the screenshot, never the application.
    """
    import base64
    cdp.eval("""(() => {
        const s = document.createElement('style');
        s.id = 'lume-capture';
        s.textContent = '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}';
        document.head.appendChild(s);
        return 1;
    })()""")
    cdp.eval("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))",
             await_promise=True)
    time.sleep(0.4)
    r = cdp.send("Page.captureScreenshot", {"format": "png", "fromSurface": True})
    data = r.get("result", {}).get("data")
    if data:
        open(path, "wb").write(base64.b64decode(data))
    cdp.eval("document.getElementById('lume-capture')?.remove()")
    return os.path.exists(path) and os.path.getsize(path) > 8000

NO_OVERFLOW = (
    "document.documentElement.scrollWidth <= window.innerWidth + 1 && "
    "document.body.scrollWidth <= window.innerWidth + 1"
)
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
    cdp.send("Page.enable")

    try:
        # ============ 1. boot ============
        print("== 1. boot ==")
        check("shell mounted", cdp.wait_for(BOOTED, timeout=45))
        check("no boot failure", cdp.eval("!document.body.innerText.includes('Boot failed')"))
        check("icon system loaded (svg icons present)",
              cdp.eval("document.querySelectorAll('svg.lume-icon').length > 5"))
        check("no emoji used as UI icons",
              not cdp.eval(r"/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test("
                           "document.querySelector('.dock').innerText + "
                           "document.querySelector('.statusbar').innerText)"))
        check("service worker registered",
              cdp.eval("navigator.serviceWorker.getRegistrations().then(r=>r.length>0)",
                       await_promise=True))

        # ============ 2. viewports ============
        print("== 2. representative viewports ==")
        for label, w, h, expect in VIEWPORTS:
            cdp.viewport(w, h, expect == "mobile")
            cdp.eval("window.dispatchEvent(new Event('resize'))")
            time.sleep(0.5)
            mode = cdp.eval("document.documentElement.getAttribute('data-shell')")
            check(f"{label} {w}x{h}: shell={expect}", mode == expect, f"got {mode}")
            check(f"{label} {w}x{h}: no horizontal overflow", cdp.eval(NO_OVERFLOW) is True)

        # ============ 3. desktop shell ============
        print("== 3. desktop shell (1280x800) ==")
        cdp.viewport(1280, 800, False)
        cdp.eval("window.dispatchEvent(new Event('resize'))")
        time.sleep(0.5)
        check("desktop mode restored",
              cdp.eval("document.documentElement.getAttribute('data-shell')") == "desktop")
        icons = cdp.eval("[...document.querySelectorAll('.icon__label')].map(e=>e.textContent)")
        check("desktop icons rendered", isinstance(icons, list) and len(icons) >= 9, str(icons))
        check("dock launcher present", cdp.eval("!!document.querySelector('.dock__launcher')"))
        check("status bar clock present",
              cdp.eval("!!document.querySelector('.statusbar__clock')"))
        check("no overlay open before capture", cdp.eval(
            "document.getElementById('launcher').hidden === true && "
            "!document.querySelector('.side-panel') && !document.querySelector('.recents-sheet')"),
              f"launcherHidden={cdp.eval('document.getElementById(\'launcher\').hidden')} "
              f"panel={cdp.eval('!!document.querySelector(\'.side-panel\')')}")
        check("clean desktop screenshot captured", shot(cdp, "/scratch/work/shot_desktop.png"))

        # launcher + search
        cdp.eval("document.querySelector('.dock__launcher').click()")
        check("launcher opens", cdp.wait_for("document.getElementById('launcher').hidden === false"))
        check("launcher lists apps",
              (cdp.eval("document.querySelectorAll('.launcher__app').length") or 0) >= 9)
        cdp.eval("""(() => {
            const i = document.querySelector('.launcher__search input');
            i.value = 'term'; i.dispatchEvent(new Event('input', {bubbles:true}));
        })()""")
        time.sleep(0.25)
        filtered = cdp.eval("[...document.querySelectorAll('.launcher__app')].map(e=>e.innerText)")
        check("launcher search filters", isinstance(filtered, list) and len(filtered) == 1
              and "Terminal" in (filtered[0] or ""), str(filtered))
        cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
        check("Escape closes launcher",
              cdp.wait_for("document.getElementById('launcher').hidden === true"))

        # window management
        cdp.eval("window.LumeOS.apps.open('files')")
        check("app window opens", cdp.wait_for(
            "!!document.querySelector('#window-layer .window')"))
        check("window has title bar controls",
              cdp.eval("!!document.querySelector('#window-layer .window .win-btn.min') && "
                       "!!document.querySelector('#window-layer .window .win-btn.close')"))
        check("dock shows running app",
              cdp.eval("document.querySelectorAll('.dock__item.running').length >= 1"))
        check("active window is focused",
              cdp.eval("!!document.querySelector('#window-layer .window.focused')"))

        cdp.eval("document.querySelector('#window-layer .win-btn.max').click()")
        check("maximise applies", cdp.wait_for(
            "document.querySelector('#window-layer .window').classList.contains('maximized')"))
        cdp.eval("document.querySelector('#window-layer .win-btn.max').click()")
        check("restore from maximise", cdp.wait_for(
            "!document.querySelector('#window-layer .window').classList.contains('maximized')"))

        cdp.eval("document.querySelector('#window-layer .win-btn.min').click()")
        check("minimise hides window", cdp.wait_for(
            "document.querySelector('#window-layer .window').classList.contains('minimized')"))
        cdp.eval("document.querySelector('.dock__item').click()")
        check("dock restores minimised window", cdp.wait_for(
            "!document.querySelector('#window-layer .window').classList.contains('minimized')"))

        # keyboard window management
        cdp.eval("""document.dispatchEvent(new KeyboardEvent('keydown',
            {key:'ArrowRight', altKey:true, bubbles:true, cancelable:true}))""")
        moved = cdp.eval("document.querySelector('#window-layer .window').offsetLeft")
        check("Alt+Arrow moves the focused window", isinstance(moved, (int, float)) and moved > 0,
              str(moved))
        cdp.eval("""document.dispatchEvent(new KeyboardEvent('keydown',
            {key:'q', altKey:true, bubbles:true, cancelable:true}))""")
        check("Alt+Q closes the focused window",
              cdp.wait_for("document.querySelectorAll('#window-layer .window').length === 0"))

        # notification centre + quick settings
        cdp.eval("document.querySelector('[aria-label=\"Notifications\"]').click()")
        check("notification panel opens", cdp.wait_for("!!document.querySelector('.side-panel')"))
        check("notification panel has content",
              (cdp.eval("document.querySelector('.side-panel').innerText.length") or 0) > 5)
        cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
        check("Escape closes the panel", cdp.wait_for("!document.querySelector('.side-panel')"))

        # quick settings + theme toggle
        cdp.eval("document.querySelector('[aria-label=\"Quick settings\"]').click()")
        check("quick settings opens", cdp.wait_for("!!document.querySelector('.quick-grid')"))
        before = cdp.eval("document.documentElement.getAttribute('data-theme')")
        cdp.eval("""[...document.querySelectorAll('.quick-tile')]
            .find(b=>b.innerText.includes('Theme')).click()""")
        time.sleep(0.5)
        after = cdp.eval("document.documentElement.getAttribute('data-theme')")
        check("theme toggle switches theme", before != after, f"{before} -> {after}")
        cdp.eval("""[...document.querySelectorAll('.quick-tile')]
            .find(b=>b.innerText.includes('Theme')).click()""")
        time.sleep(0.4)
        cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")

        # ============ 4. mobile shell ============
        print("== 4. mobile shell (390x844) ==")
        cdp.viewport(390, 844, True)
        cdp.eval("window.dispatchEvent(new Event('resize'))")
        time.sleep(0.6)
        check("mobile mode active",
              cdp.eval("document.documentElement.getAttribute('data-shell')") == "mobile")
        check("desktop dock hidden", cdp.eval(
            "getComputedStyle(document.querySelector('.dock')).display === 'none'"))
        check("mobile nav visible", cdp.eval(
            "getComputedStyle(document.getElementById('mobile-nav')).display !== 'none'"))
        check("home screen visible", cdp.wait_for(
            "document.getElementById('mobile-home').hidden === false"))
        tiles = cdp.eval("[...document.querySelectorAll('.mobile-app__label')].map(e=>e.textContent)")
        check("home screen lists apps", isinstance(tiles, list) and len(tiles) >= 9, str(tiles))
        check("no overlay open before capture", cdp.eval(
            "document.getElementById('launcher').hidden === true && "
            "!document.querySelector('.side-panel') && !document.querySelector('.recents-sheet')"),
              f"launcherHidden={cdp.eval('document.getElementById(\'launcher\').hidden')} "
              f"panel={cdp.eval('!!document.querySelector(\'.side-panel\')')}")
        check("mobile home screenshot captured", shot(cdp, "/scratch/work/shot_mobile.png"))

        # touch targets
        small = cdp.eval("""(() => {
            const bad = [];
            for (const b of document.querySelectorAll('.mobile-nav__btn')) {
                const r = b.getBoundingClientRect();
                if (r.height < 43 || r.width < 43) bad.push([b.innerText, r.width, r.height]);
            }
            return bad;
        })()""")
        check("bottom nav targets >= 44px", small == [], str(small))
        tile_small = cdp.eval("""(() => {
            const bad = [];
            for (const b of document.querySelectorAll('.mobile-app')) {
                const r = b.getBoundingClientRect();
                if (r.height < 44 || r.width < 44) bad.push([b.innerText, r.width, r.height]);
            }
            return bad;
        })()""")
        check("home screen targets >= 44px", tile_small == [], str(tile_small))

        # open an app from the home screen
        cdp.eval("""[...document.querySelectorAll('.mobile-app')]
            .find(b=>b.innerText.includes('Files')).click()""")
        check("app view opens full screen", cdp.wait_for(
            "!!document.querySelector('#app-layer .window.mobile-active')"))
        check("home hidden while app open",
              cdp.eval("document.getElementById('mobile-home').hidden === true"))
        geom = cdp.eval("""(() => {
            const w = document.querySelector('#app-layer .window.mobile-active');
            const r = w.getBoundingClientRect();
            const ws = document.querySelector('.workspace').getBoundingClientRect();
            return {w: Math.round(r.width), h: Math.round(r.height),
                    wsw: Math.round(ws.width), wsh: Math.round(ws.height),
                    back: !!w.querySelector('.titlebar__back'),
                    min: getComputedStyle(w.querySelector('.win-btn.min')).display,
                    handles: !!w.querySelector('.resize-handle') &&
                             getComputedStyle(w.querySelector('.resize-handle')).display !== 'none'};
        })()""")
        check("app view fills the workspace",
              geom and geom["w"] >= geom["wsw"] - 2 and geom["h"] >= geom["wsh"] - 2, str(geom))
        check("mobile app shows a back button", geom and geom["back"] is True, str(geom))
        check("minimise hidden on mobile", geom and geom["min"] == "none", str(geom))
        check("resize handles hidden on mobile", geom and geom["handles"] is False, str(geom))

        cdp.eval("document.querySelector('#app-layer .window.mobile-active .titlebar__back').click()")
        check("back returns to the home screen", cdp.wait_for(
            "document.getElementById('mobile-home').hidden === false"))

        # recents
        cdp.eval("""[...document.querySelectorAll('.mobile-nav__btn')]
            .find(b=>b.innerText.includes('Recents')).click()""")
        check("recents sheet opens", cdp.wait_for("!!document.querySelector('.recents-sheet')"))
        check("recents lists the running app",
              (cdp.eval("document.querySelectorAll('.recents-item').length") or 0) >= 1)
        cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
        check("Escape closes recents", cdp.wait_for("!document.querySelector('.recents-sheet')"))

        # ============ 5. persistence ============
        print("== 5. persistence across reload ==")
        cdp.viewport(1280, 800, False)
        cdp.eval("window.dispatchEvent(new Event('resize'))")
        time.sleep(0.5)
        marker = f"lume-persist-{int(time.time())}"
        note_name = f"persist-{int(time.time())}"
        cdp.eval("window.LumeOS.apps.open('notes')")
        check("notes opens", cdp.wait_for("!!document.querySelector('.notes__area')"))
        check("editor inert until a note exists",
              cdp.eval("document.querySelector('.notes__area').disabled === true"))

        # create a note through the real dialog (scoped to the Notes window,
        # since other open apps also have toolbar buttons)
        cdp.eval("""(() => {
            const w = [...document.querySelectorAll('.window')]
                .find(x => x.querySelector('.notes__area'));
            [...w.querySelectorAll('.app__toolbar button')]
                .find(b => b.innerText.trim().startsWith('New')).click();
        })()""")
        check("new-note dialog opens", cdp.wait_for("!!document.querySelector('.modal')"))
        cdp.eval(f"""(() => {{
            const m = document.querySelector('.modal');
            const i = m.querySelector('input');
            i.value = '{note_name}';
            [...m.querySelectorAll('button')].find(b => b.innerText.trim() === 'OK').click();
        }})()""")
        check("note created and editor enabled", cdp.wait_for(
            "document.querySelector('.notes__area') && "
            "document.querySelector('.notes__area').disabled === false", timeout=15))
        cdp.eval(f"""(() => {{
            const a = document.querySelector('.notes__area');
            a.value = '{marker}';
            a.dispatchEvent(new Event('input', {{bubbles:true}}));
        }})()""")
        time.sleep(1.8)  # autosave debounce
        cdp.eval("location.reload()")
        check("page reloads", cdp.wait_for(BOOTED, timeout=45))
        cdp.eval("window.LumeOS.apps.open('notes')")
        check("notes reopens after reload", cdp.wait_for("!!document.querySelector('.notes__area')"))
        found = cdp.wait_for(
            f"(document.querySelector('.notes__area')||{{}}).value === '{marker}'", timeout=20)
        check("note content persisted across reload", found,
              str(cdp.eval("(document.querySelector('.notes__area')||{}).value"))[:80])
        check("note appears in the note list", cdp.eval(
            f"[...document.querySelectorAll('.notes__item')].some(e=>e.innerText.includes('{note_name}'))"))
        check("note stored in the /notes folder", cdp.eval(
            f"window.LumeOS.fs.list('/notes').then(r=>r.some(f=>f.name.includes('{note_name}')))",
            await_promise=True))

        # ============ 6. breakpoint switching ============
        print("== 6. resize across the breakpoint ==")
        cdp.eval("window.LumeOS.apps.open('files')")
        check("app open on desktop", cdp.wait_for(
            "document.querySelectorAll('#window-layer .window').length >= 1"))
        desktop_windows = cdp.eval("document.querySelectorAll('#window-layer .window').length")

        cdp.viewport(390, 844, True)
        cdp.eval("window.dispatchEvent(new Event('resize'))")
        time.sleep(0.7)
        check("switched to mobile", cdp.eval("document.documentElement.getAttribute('data-shell')") == "mobile")
        check("window moved into the app layer",
              cdp.eval("document.querySelectorAll('#app-layer .window').length >= 1"))
        check("no windows left in the desktop layer",
              cdp.eval("document.querySelectorAll('#window-layer .window').length === 0"))

        cdp.viewport(1280, 800, False)
        cdp.eval("window.dispatchEvent(new Event('resize'))")
        time.sleep(0.7)
        check("switched back to desktop",
              cdp.eval("document.documentElement.getAttribute('data-shell')") == "desktop")
        check("window moved back to the desktop layer",
              cdp.eval(f"document.querySelectorAll('#window-layer .window').length === {desktop_windows}"),
              str(cdp.eval("document.querySelectorAll('#window-layer .window').length")))

        # ============ 7. console health ============
        print("== 7. console health ==")
        real = [e for e in console_errors
                if "favicon" not in e and "ERR_FAILED" not in e and "net::" not in e]
        check("no uncaught console errors", len(real) == 0, "; ".join(real[:2])[:300])

        # ============ 8. screenshots ============
        print("== 8. app screenshots ==")
        # one clean shot of an app open on the desktop
        cdp.viewport(1280, 800, False)
        cdp.eval("window.dispatchEvent(new Event('resize'))")
        time.sleep(0.6)
        cdp.eval("window.LumeOS.apps.open('files')")
        cdp.wait_for("!!document.querySelector('#window-layer .window')")
        time.sleep(0.8)
        check("app screenshot captured", shot(cdp, "/scratch/work/shot_app.png"))

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
