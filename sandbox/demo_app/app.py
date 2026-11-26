"""Inventory API demo service (stdlib only)."""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import inventory

BASE = Path(__file__).resolve().parent


def load_config() -> dict:
    with open(BASE / "config.json", encoding="utf-8") as f:
        cfg = json.load(f)
    for key, typ in (("service_name", str), ("port", int), ("data_file", str), ("max_items", int)):
        if not isinstance(cfg.get(key), typ):
            raise ValueError(f"config error: '{key}' must be {typ.__name__}, got {cfg.get(key)!r}")
    return cfg


def build_state(cfg: dict) -> dict:
    items = inventory.load_items(BASE / cfg["data_file"], cfg["max_items"])
    return {"items": items, "total_value": inventory.total_value(items)}


class Handler(BaseHTTPRequestHandler):
    cfg: dict = {}

    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        try:
            state = build_state(self.cfg)
        except Exception as e:  # surface real errors in logs and response
            print(f"ERROR handling {self.path}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            self._send(500, {"status": "error", "error": f"{type(e).__name__}: {e}"})
            return
        if self.path == "/health":
            self._send(200, {"status": "ok", "service": self.cfg["service_name"], "items": len(state["items"])})
        elif self.path == "/api/items":
            self._send(200, state)
        else:
            self._send(404, {"status": "not_found"})

    def log_message(self, fmt, *args) -> None:
        print(f"{self.address_string()} {fmt % args}", file=sys.stderr, flush=True)


def main() -> None:
    cfg = load_config()
    build_state(cfg)  # fail fast on bad data/code
    port = int(os.environ.get("PORT", cfg["port"]))
    Handler.cfg = cfg
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"{cfg['service_name']} listening on 127.0.0.1:{port}", file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
