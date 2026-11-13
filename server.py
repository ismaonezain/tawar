#!/usr/bin/env python3
"""TAWAR live server.

Serves the arena (web/) and session data (data/) statically, and exposes
the live-run endpoints the arena uses when it detects this backend:

  GET  /health  -> {"live": true}
  POST /run     -> validates a mandate, shells src/engine.py in the
                   background, and returns {"session_id", "file"} as soon
                   as the engine's session file appears under
                   data/sessions/ (the engine persists after every event,
                   so the arena can poll the file while it grows).
  POST /halt    -> writes data/HALT; the engine honors the flag between
                   rounds and closes the session as "halted".

Stdlib only. Run from the project root:  python3 server.py [port]
Then open http://localhost:8077/web/
"""
import json
import os
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
SESSIONS_DIR = os.path.join(ROOT, "data", "sessions")
HALT_PATH = os.path.join(ROOT, "data", "HALT")
ENGINE = os.path.join(ROOT, "src", "engine.py")

SELLERS = {"luluh", "keras", "kepepet"}
LANGS = {"en", "id"}
CURRENCIES = {"USD", "IDR"}

_state = {"proc": None}
_lock = threading.Lock()


def _session_files():
    try:
        return {f for f in os.listdir(SESSIONS_DIR)
                if f.endswith(".json") and f != "latest.json"}
    except FileNotFoundError:
        return set()


def _start_engine(payload):
    """Launch the engine in the background; return (session_id, filename).

    The engine names its own session file, so we snapshot the sessions
    directory and watch for the new file to appear.
    """
    before = _session_files()
    cmd = [sys.executable, ENGINE,
           "--seller", payload["seller"],
           "--lang", payload["lang"],
           "--currency", payload["currency"],
           "--list", str(payload["list"]),
           "--target", str(payload["target"]),
           "--ceiling", str(payload["ceiling"])]
    if payload.get("item"):
        cmd += ["--item", payload["item"]]
    # A stale HALT flag would instantly kill the new run; the owner
    # starting a fresh negotiation has implicitly lifted it.
    try:
        os.remove(HALT_PATH)
    except FileNotFoundError:
        pass
    proc = subprocess.Popen(cmd, cwd=ROOT,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    with _lock:
        _state["proc"] = proc
    deadline = time.time() + 20
    while time.time() < deadline:
        new = _session_files() - before
        if new:
            fname = sorted(new)[-1]
            return fname[:-5], fname
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    raise RuntimeError("engine exited before creating a session file")


def _validate(payload):
    if not isinstance(payload, dict):
        return "JSON object expected"
    try:
        lst = int(payload["list"])
        tgt = int(payload["target"])
        cei = int(payload["ceiling"])
    except (KeyError, TypeError, ValueError):
        return "list, target and ceiling must be integers"
    if tgt < 1:
        return "target must be positive"
    if cei < tgt:
        return "ceiling must be at or above target"
    if lst <= cei:
        return "list price must be above the ceiling"
    if payload.get("seller", "luluh") not in SELLERS:
        return "unknown seller persona"
    if payload.get("lang", "en") not in LANGS:
        return "unknown language"
    if payload.get("currency", "USD") not in CURRENCIES:
        return "unknown currency"
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[tawar] %s\n" % (fmt % args))

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send_json(200, {"live": True})
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/halt":
            with open(HALT_PATH, "w") as f:
                f.write(str(time.time()))
            self._send_json(200, {"halted": True})
            return
        if path == "/run":
            with _lock:
                proc = _state["proc"]
                if proc is not None and proc.poll() is None:
                    self._send_json(409, {"error": "a negotiation is already running"})
                    return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, TypeError):
                self._send_json(400, {"error": "invalid JSON body"})
                return
            payload.setdefault("seller", "luluh")
            payload.setdefault("lang", "en")
            payload.setdefault("currency", "USD")
            err = _validate(payload)
            if err:
                self._send_json(400, {"error": err})
                return
            try:
                sid, fname = _start_engine(payload)
            except RuntimeError as exc:
                self._send_json(500, {"error": str(exc)})
                return
            self._send_json(200, {"session_id": sid, "file": fname})
            return
        self._send_json(404, {"error": "not found"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8077
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"TAWAR live server on http://127.0.0.1:{port}/web/  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
