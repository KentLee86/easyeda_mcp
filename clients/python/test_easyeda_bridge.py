"""Hermetic tests: a fake hub on an ephemeral port, no EasyEDA needed.

    python3 -m unittest discover -s clients/python -p 'test_*.py'
"""

import base64
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from easyeda_bridge import Bridge, BridgeError, config_dir, move_properties  # noqa: E402

TOKEN = "python-test-token"


class FakeHub(BaseHTTPRequestHandler):
    components = {}
    calls = []

    def log_message(self, *args):  # silence
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if self.headers.get("Origin") is not None:
            self._send(403, {"ok": False, "error": {"code": "origin_rejected", "message": "no"}})
            return False
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self._send(401, {"ok": False, "error": {"code": "unauthorized", "message": "bad token"}})
            return False
        return True

    def do_GET(self):
        if not self._authorized():
            return
        if self.path == "/v1/status":
            self._send(200, {"connected": True, "activeDocumentType": "pcb", "updatedAt": ""})
        else:
            self._send(404, {"ok": False, "error": {"code": "not_found", "message": self.path}})

    def do_POST(self):
        if not self._authorized():
            return
        if self.headers.get("Content-Type") != "application/json":
            self._send(415, {"ok": False, "error": {"code": "unsupported_media_type", "message": ""}})
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        method, params = body["method"], body.get("params") or {}
        FakeHub.calls.append((method, params))
        comps = FakeHub.components
        if method == "pcbSnapshot":
            result = {"components": list(comps.values())}
        elif method == "apiCall" and params["path"] == "pcb_PrimitiveComponent.modify":
            primitive_id, props = params["args"]
            comps[primitive_id].update(props)
            result = comps[primitive_id]
        elif method == "apiCall" and params["path"] == "pcb_PrimitiveComponent.get":
            result = comps[params["args"][0]]
        elif method == "apiCall" and params["path"].startswith("sys_"):
            self._send(502, {"ok": False, "error": {"code": "api_forbidden", "message": "namespace not allowed"}})
            return
        elif method == "apiBatch":
            result = {"results": [{"ok": True, "value": c["path"]} for c in params["calls"]]}
        elif method == "renderImage":
            result = {"mimeType": "image/png", "base64": base64.b64encode(b"PNG!").decode(), "size": 4}
        else:
            result = {"method": method, "params": params}
        self._send(200, {"ok": True, "result": result})


class BridgeClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeHub)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = pathlib.Path(cls.tmp.name)
        (cls.dir / "token").write_text(TOKEN + "\n")
        (cls.dir / "hub.json").write_text(json.dumps({"pid": 1, "httpPort": cls.server.server_address[1], "wsPort": 8765}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        FakeHub.components = {"e12": {"primitiveId": "e12", "designator": "U1", "x": 100, "y": 200, "rotation": 0, "layer": 1}}
        FakeHub.calls = []
        os.environ.pop("EASYEDA_MCP_HTTP_PORT", None)
        self.eda = Bridge(self.dir)

    def test_discovers_port_from_hub_json_and_reads_status(self):
        self.assertTrue(self.eda.base_url.endswith(f":{self.server.server_address[1]}"))
        self.assertTrue(self.eda.status()["connected"])

    def test_wrong_token_raises_unauthorized(self):
        with self.assertRaises(BridgeError) as ctx:
            Bridge(self.dir, token="nope").status()
        self.assertEqual(ctx.exception.code, "unauthorized")
        self.assertEqual(ctx.exception.status, 401)

    def test_api_and_errors(self):
        self.assertEqual(self.eda.api("pcb_Foo.getAll", 1, "a"), {"method": "apiCall", "params": {"path": "pcb_Foo.getAll", "args": [1, "a"]}})
        with self.assertRaises(BridgeError) as ctx:
            self.eda.api("sys_Window.open")
        self.assertEqual(ctx.exception.code, "api_forbidden")

    def test_batch_normalizes_tuples(self):
        results = self.eda.batch([("pcb_A.getAll",), {"path": "pcb_B.get", "args": ["x"]}])
        self.assertEqual([r["value"] for r in results], ["pcb_A.getAll", "pcb_B.get"])
        self.assertEqual(FakeHub.calls[-1][1]["calls"][0], {"path": "pcb_A.getAll", "args": []})

    def test_move_resolves_designator_and_reads_back(self):
        moved = self.eda.move("u1", dx=-50, layer="bottom")
        self.assertEqual(moved["before"]["x"], 100)
        self.assertEqual(moved["after"], {"primitiveId": "e12", "designator": "U1", "x": 50, "y": 200, "rotation": 0, "layer": 2})
        self.assertIn(("apiCall", {"path": "pcb_PrimitiveComponent.modify", "args": ["e12", {"x": 50, "layer": 2}]}), FakeHub.calls)
        with self.assertRaises(BridgeError) as ctx:
            self.eda.move("U9", x=0)
        self.assertEqual(ctx.exception.code, "component_not_found")

    def test_move_properties_validation(self):
        with self.assertRaises(BridgeError):
            move_properties({"x": 0, "y": 0})
        with self.assertRaises(BridgeError):
            move_properties({"x": 0, "y": 0}, x=1, dx=1)

    def test_render_writes_png(self):
        out = self.dir / "view.png"
        self.assertEqual(self.eda.render(designator="U1", out=out), out)
        self.assertEqual(out.read_bytes(), b"PNG!")
        self.assertEqual(FakeHub.calls[-1], ("renderImage", {"primitiveIds": ["e12"]}))
        self.assertEqual(self.eda.render(region=(0, 10, 0, 5)), b"PNG!")

    def test_config_dir_resolution(self):
        self.assertEqual(config_dir({"EASYEDA_MCP_CONFIG_DIR": "/x/y"}), pathlib.Path("/x/y"))
        self.assertEqual(config_dir({"XDG_CONFIG_HOME": "/xdg"}), pathlib.Path("/xdg/easyeda-mcp"))
        self.assertEqual(config_dir({"HOME": "/tmp"}), pathlib.Path("/tmp/.config/easyeda-mcp"))


if __name__ == "__main__":
    unittest.main()
