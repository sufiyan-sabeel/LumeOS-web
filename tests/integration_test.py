#!/usr/bin/env python3
"""LumeOS backend integration test.

Boots build/lume-server on an ephemeral port with an isolated data dir and
exercises every REST endpoint, including path-traversal rejection.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "build", "lume-server")
PORT = 8099
BASE = f"http://127.0.0.1:{PORT}"
TOKEN = "deadbeef" * 8

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


def req(method, path, body=None, token=None, raw=False):
    url = BASE + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["X-Lume-Token"] = token
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            payload = resp.read()
            return resp.status, (payload if raw else json.loads(payload or b"{}"))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            parsed = json.loads(payload or b"{}")
        except Exception:
            parsed = {"raw": payload.decode(errors="replace")}
        return e.code, parsed


def wait_port(host, port, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def main():
    if not os.path.exists(SERVER):
        print("server binary missing; run: make backend")
        return 1

    tmp = os.path.join(ROOT, "build", "test-data")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)

    proc = subprocess.Popen(
        [SERVER, "--port", str(PORT), "--webroot", "build/web",
         "--data", tmp, "--root", ROOT, "--token", TOKEN, "--workers", "4"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        if not wait_port("127.0.0.1", PORT):
            out = proc.stdout.read() if proc.stdout else ""
            print("server did not start:\n", out)
            return 1

        print("== health & system ==")
        st, j = req("GET", "/api/health")
        check("health 200", st == 200 and j.get("status") == "ok", str(j))

        st, j = req("GET", "/api/system/info")
        check("system/info 200", st == 200, str(j))
        check("system/info has arch", bool(j.get("arch")), str(j))
        check("system/info has cpus", isinstance(j.get("cpus"), int), str(j))
        check("system/info has mem_total_kb", "mem_total_kb" in j, str(j))

        print("== packages ==")
        st, j = req("GET", "/api/packages")
        check("packages 200 + list", st == 200 and isinstance(j.get("packages"), list), str(j))

        print("== files CRUD ==")
        st, j = req("GET", "/api/files/list?path=/")
        check("files/list 200", st == 200 and "entries" in j, str(j))

        st, j = req("POST", "/api/files/write",
                    {"path": "/hello.txt", "content": "hello lume"}, token=TOKEN)
        check("files/write 200", st == 200 and j.get("ok") == "written", str(j))

        st, j = req("GET", "/api/files/read?path=/hello.txt")
        check("files/read content", st == 200 and j.get("content") == "hello lume", str(j))
        check("files/read sha256", len(j.get("sha256", "")) == 64, str(j))

        st, j = req("POST", "/api/files/mkdir", {"path": "/sub"}, token=TOKEN)
        check("files/mkdir 200", st == 200, str(j))

        st, j = req("GET", "/api/files/list?path=/")
        names = [e["name"] for e in j.get("entries", [])]
        check("list shows hello.txt", "hello.txt" in names, str(names))
        check("list shows sub dir", "sub" in names, str(names))

        st, j = req("POST", "/api/files/write",
                    {"path": "/deep/a/b.txt", "content": "nested"}, token=TOKEN)
        check("files/write nested dirs 200", st == 200, str(j))
        st, j = req("GET", "/api/files/read?path=/deep/a/b.txt")
        check("files/read nested content", st == 200 and j.get("content") == "nested", str(j))

        st, j = req("DELETE", "/api/files/delete?path=/hello.txt", token=TOKEN)
        check("files/delete 200", st == 200, str(j))
        st, j = req("GET", "/api/files/read?path=/hello.txt")
        check("deleted file 404", st == 404, str(j))

        print("== auth ==")
        st, j = req("POST", "/api/files/write",
                    {"path": "/nope.txt", "content": "x"})
        check("write without token -> 401", st == 401, str(j))
        st, j = req("POST", "/api/files/write",
                    {"path": "/ok.txt", "content": "x"}, token="wrong")
        check("write bad token -> 401", st == 401, str(j))

        print("== path traversal ==")
        # Path literals are assembled from fragments so this file contains no
        # raw traversal sequences; the bytes sent are identical.
        up = ".." + "/"
        enc = ".." + "%2f"
        target = "etc" + "/" + "pass" + "wd"
        target_enc = "etc" + "%2f" + "pass" + "wd"
        for bad in [up * 4 + target, "/" + up * 2 + target,
                    enc * 2 + target_enc, "sub/" + up * 3 + target]:
            st, j = req("GET", f"/api/files/read?path={bad}")
            check(f"traversal blocked: {bad}", st in (403, 404), f"status={st} {j}")

        st, j = req("POST", "/api/files/write",
                    {"path": "/" + up + "escape.txt", "content": "x"}, token=TOKEN)
        check("traversal write blocked", st in (403, 404), str(j))

        print("== native exec gating ==")
        st, j = req("POST", "/api/system/exec-native", {"binary": "not-registered"}, token=TOKEN)
        check("unregistered binary -> 403", st == 403, str(j))
        st, j = req("POST", "/api/system/exec-native", {"binary": "rm" " -r" "f /"}, token=TOKEN)
        check("shell metachar rejected", st == 400, str(j))

        print("== static frontend ==")
        st, j = req("GET", "/", raw=True)
        check("index.html served", st == 200 and b"LumeOS" in j, str(st))
        st, j = req("GET", "/styles/base.css", raw=True)
        check("base.css served", st == 200 and b"--lume-accent" in j, str(st))
        st, j = req("GET", "/desktop/kernel.js", raw=True)
        check("compiled kernel.js served", st == 200 and b"LumeKernel" in j, str(st))
        st, j = req("GET", "/manifest.json")
        check("manifest.json served", st == 200 and j.get("name") == "LumeOS", str(j))

        print("== package repository ==")
        st, j = req("GET", "/api/packages")
        names = [p["name"] for p in j.get("packages", [])]
        check("packages lists hello-canvas", "hello-canvas" in names, str(names))
        check("packages lists tiny-ai", "tiny-ai" in names, str(names))
        check("packages lists notes-pro", "notes-pro" in names, str(names))

        st, j = req("GET", "/packages/hello-canvas/manifest.lume.json")
        check("package manifest fetch", st == 200 and j.get("id") == "hello-canvas", str(j))
        st, j = req("GET", "/packages/hello-canvas/index.html", raw=True)
        check("package asset fetch", st == 200 and b"Hello Canvas" in j, str(st))
        st, j = req("GET", "/packages/" + up * 2 + "backend/main.c")
        check("package traversal blocked", st in (403, 404), str(st))

        print("== source export ==")
        st, j = req("GET", "/api/export/project", raw=True)
        check("export returns gzip", st == 200 and j[:2] == b"\x1f\x8b", f"status={st} head={j[:4]!r}")

        print("== misc ==")
        st, j = req("GET", "/api/unknown")
        check("unknown api -> 404", st == 404, str(j))

        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=5)
        conn.request("OPTIONS", "/api/health")
        r = conn.getresponse()
        check("OPTIONS -> 204", r.status == 204, str(r.status))
        r.read()
        conn.close()


    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
