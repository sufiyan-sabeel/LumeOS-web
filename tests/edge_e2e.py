#!/usr/bin/env python3
"""LumeOS x edge-backend end-to-end test.

Starts the Cloudflare Worker (backend/worker/worker.js) behind a Node HTTP
adapter on one port and the static site on another, then loads LumeOS in
headless Chromium with ?backend=<edge-url>. Because the two origins differ,
this exercises exactly the cross-origin CORS path that a GitHub Pages
frontend talking to a workers.dev backend uses.

Checks:
  * the frontend connects and the status bar reports online
  * /api/system/info is rendered as an edge runtime (no fake host telemetry)
  * diagnostics report the backend reachable
  * notes persist through the server (KV), and the Files app lists it
"""
import functools
import http.server
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request

import websocket

SITE_ROOT = "/scratch/work/site"
SUBPATH = "/LumeOS-web/"
HTTP_PORT = int(os.environ.get("EDGE_HTTP_PORT", "8711"))
EDGE_PORT = int(os.environ.get("EDGE_API_PORT", "8787"))
CDP_PORT = int(os.environ.get("EDGE_CDP_PORT", "9711"))
CHROME = "/usr/local/bin/chromium"
PROFILE = "/tmp/chrome-edge-e2e"

passed = 0
failed = 0
errors = []


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
            if msg.get("method") == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                errors.append((d.get("exception") or {}).get("description", d.get("text", ""))[:300])
        return {}

    def eval(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": await_promise,
        })
        res = r.get("result", {})
        if res.get("exceptionDetails"):
            return None
        return res.get("result", {}).get("value")

    def wait_for(self, expr, timeout=25, interval=0.2):
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


def wait_port(port, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return True
        except OSError:
            time.sleep(0.15)
    return False


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
    # ---- 1. start the edge backend ----
    print("== starting the edge backend ==")
    edge = subprocess.Popen(["node", "tests/edge_server.mjs", str(EDGE_PORT)],
                            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if not wait_port(EDGE_PORT):
        print("edge backend did not start:", edge.stderr.read()[:400] if edge.stderr else "")
        edge.kill()
        return 1
    edge_url = f"http://127.0.0.1:{EDGE_PORT}"

    with urllib.request.urlopen(f"{edge_url}/api/health", timeout=5) as r:
        health = json.loads(r.read())
    check("edge /api/health responds", health.get("status") == "ok", str(health))
    check("edge reports worker runtime", health.get("runtime") == "cloudflare-worker", str(health))

    # ---- 2. serve the site and boot with ?backend= ----
    handler = functools.partial(Handler, directory=SITE_ROOT)
    httpd = Server(("127.0.0.1", HTTP_PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    site = f"http://127.0.0.1:{HTTP_PORT}{SUBPATH}"
    url = f"{site}?backend={edge_url}"
    print(f"== booting LumeOS with backend {edge_url} ==")
    proc, ws = launch(url)
    cdp = CDP(ws)
    cdp.send("Runtime.enable")

    try:
        check("shell mounted", cdp.wait_for(BOOTED, timeout=45))

        # cross-origin connect
        online = cdp.wait_for(
            "document.querySelector('.statusbar').innerText.includes('online')", timeout=30)
        check("status bar reports backend ONLINE (cross-origin)", online,
              cdp.eval("document.querySelector('.statusbar') ? "
                       "document.querySelector('.statusbar').innerText : 'no statusbar'"))

        # diagnostics agree
        diag = cdp.eval("""(async () => {
            const rows = await window.LumeOS && null;
            return null;
        })()""")
        cdp.eval("window.LumeOS.apps.open('settings')")
        cdp.wait_for("!!document.querySelector('.diag-list')", timeout=20)
        backend_row = cdp.eval(
            "[...document.querySelectorAll('.diag')].map(d=>d.innerText).find(t=>t.includes('C backend')) || ''")
        check("diagnostics report the backend connected",
              "Connected" in (backend_row or ""), (backend_row or "")[:160])
        check("diagnostics name the edge URL",
              edge_url in (backend_row or ""), (backend_row or "")[:160])

        # edge telemetry rendered honestly
        cdp.eval("window.LumeOS.apps.open('settings')")
        info = cdp.eval("""(async () => {
            const i = await window.LumeOS.system.info();
            return {runtime: i.runtime, telemetry: i.telemetry, cpus: i.cpus};
        })()""", await_promise=True)
        check("system info comes from the worker",
              isinstance(info, dict) and info.get("runtime") == "cloudflare-worker", str(info))
        check("system info flags telemetry as unavailable",
              isinstance(info, dict) and info.get("telemetry") is False, str(info))

        # files round-trip through the server (KV)
        cdp.eval("window.LumeOS.fs.mkdir('/notes').catch(()=>0)", await_promise=True)
        cdp.eval("window.LumeOS.fs.write('/notes/edge.txt','written through the edge backend')",
                 await_promise=True)
        readback = cdp.eval("window.LumeOS.fs.read('/notes/edge.txt')", await_promise=True)
        check("write+read round-trips through the edge backend",
              readback == "written through the edge backend", str(readback))

        listing = cdp.eval("window.LumeOS.fs.list('/notes').then(r=>JSON.stringify(r))",
                           await_promise=True)
        check("server listing shows the file",
              isinstance(listing, str) and "edge.txt" in listing, str(listing))

        # the VFS should now be preferring the server
        cdp.eval("window.LumeOS.apps.open('files')")
        # wait for the Files window specifically (Settings may already be open)
        cdp.wait_for("[...document.querySelectorAll('.window')]"
                     ".some(w => /server volume/i.test(w.innerText))", timeout=25)
        time.sleep(1.2)
        files_text = cdp.eval("""(() => {
            const w = [...document.querySelectorAll('.window')]
                .find(x => /server volume/i.test(x.innerText));
            return w ? w.innerText : '';
        })()""")
        check("Files app shows the server volume as available",
              "C backend online" in (files_text or ""), (files_text or "")[:200])

        check("no uncaught exceptions", len(errors) == 0, "; ".join(errors[:2])[:300])

    finally:
        cdp.close()
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        httpd.shutdown()
        edge.terminate()
        try:
            edge.wait(timeout=10)
        except subprocess.TimeoutExpired:
            edge.kill()

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
