"""Stdlib-only Python client for the easyeda-mcp hub HTTP API.

The hub is served by whichever process owns the EasyEDA Pro bridge (an MCP
server started by your AI client, or `easyeda daemon`). It listens on
127.0.0.1 only and needs the bearer token stored in the config dir.

    from easyeda_bridge import Bridge
    eda = Bridge()
    print(eda.status()["connected"])
    for c in eda.pcb_snapshot(["components"])["components"]:
        print(c["designator"], c["x"], c["y"])
    eda.move("U1", dx=50)
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import urllib.error
import urllib.request
from typing import Any, Iterable, Optional, Sequence

DEFAULT_HTTP_PORT = 8766
_READ_FIELDS = ("primitiveId", "designator", "x", "y", "rotation", "layer", "locked")


class BridgeError(Exception):
    """Error answered by the hub (or raised when it cannot be reached)."""

    def __init__(self, code: str, message: str, details: Any = None, status: Optional[int] = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details
        self.status = status


def config_dir(env: Optional[dict] = None) -> pathlib.Path:
    """$EASYEDA_MCP_CONFIG_DIR, else $XDG_CONFIG_HOME/easyeda-mcp, else ~/.config/easyeda-mcp."""
    env = os.environ if env is None else env
    if env.get("EASYEDA_MCP_CONFIG_DIR"):
        return pathlib.Path(env["EASYEDA_MCP_CONFIG_DIR"]).resolve()
    base = env.get("XDG_CONFIG_HOME") or os.path.join(env.get("HOME") or str(pathlib.Path.home()), ".config")
    return pathlib.Path(base) / "easyeda-mcp"


def parse_layer(layer: Any) -> int:
    if isinstance(layer, int) and not isinstance(layer, bool):
        return layer
    text = str(layer).strip().lower()
    if text == "top":
        return 1
    if text == "bottom":
        return 2
    if text.isdigit():
        return int(text)
    raise BridgeError("invalid_argument", f'Invalid layer "{layer}". Use top, bottom, or a layer id.')


def find_component(components: Iterable[dict], designator: str) -> dict:
    wanted = designator.strip().upper()
    matches = [c for c in components if isinstance(c.get("designator"), str) and c["designator"].upper() == wanted]
    if not matches:
        raise BridgeError("component_not_found", f'No component with designator "{designator}" in the active document.')
    if len(matches) > 1:
        raise BridgeError("component_ambiguous", f'Designator "{designator}" matches {len(matches)} components.')
    return matches[0]


def move_properties(component: dict, x=None, y=None, dx=None, dy=None, rotation=None, layer=None) -> dict:
    if x is not None and dx is not None:
        raise BridgeError("invalid_argument", "Use either x or dx, not both.")
    if y is not None and dy is not None:
        raise BridgeError("invalid_argument", "Use either y or dy, not both.")
    props: dict = {}
    if x is not None:
        props["x"] = x
    if dx is not None:
        props["x"] = component["x"] + dx
    if y is not None:
        props["y"] = y
    if dy is not None:
        props["y"] = component["y"] + dy
    if rotation is not None:
        props["rotation"] = rotation
    if layer is not None:
        props["layer"] = parse_layer(layer)
    if not props:
        raise BridgeError("invalid_argument", "Nothing to change: give x, y, dx, dy, rotation, or layer.")
    return props


def _placement(value: Any) -> dict:
    if isinstance(value, list):
        value = value[0] if value else None
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in _READ_FIELDS if key in value}


class Bridge:
    """Client for the hub. Reads the token and hub.json from the config dir."""

    def __init__(self, config_dir_path: Optional[os.PathLike] = None, http_port: Optional[int] = None,
                 token: Optional[str] = None, host: str = "127.0.0.1", default_timeout_ms: int = 30_000):
        directory = pathlib.Path(config_dir_path) if config_dir_path else config_dir()
        self.config_dir = directory
        if token is None:
            token_file = directory / "token"
            try:
                token = token_file.read_text(encoding="utf-8").strip()
            except FileNotFoundError:
                raise BridgeError("hub_not_running", f"No token at {token_file}. Start a hub first (`easyeda daemon` or an MCP client).") from None
        self.token = token
        if http_port is None:
            env_port = os.environ.get("EASYEDA_MCP_HTTP_PORT")
            if env_port:
                http_port = int(env_port)
            else:
                try:
                    http_port = int(json.loads((directory / "hub.json").read_text(encoding="utf-8"))["httpPort"])
                except (FileNotFoundError, KeyError, ValueError):
                    http_port = DEFAULT_HTTP_PORT
        self.base_url = f"http://{host}:{http_port}"
        self.default_timeout_ms = default_timeout_ms

    # -- transport ---------------------------------------------------------

    def _request(self, verb: str, path: str, body: Any = None, timeout_s: float = 10.0) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": f"Bearer {self.token}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=data, method=verb, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except ValueError:
                raise BridgeError(f"http_{error.code}", f"Hub answered HTTP {error.code}.", status=error.code) from None
            wire = payload.get("error") or {}
            raise BridgeError(wire.get("code", f"http_{error.code}"), wire.get("message", ""), wire.get("details"), error.code) from None
        except (urllib.error.URLError, OSError) as error:
            raise BridgeError("hub_unreachable", f"Hub at {self.base_url} is not reachable: {error}") from None
        if isinstance(payload, dict) and payload.get("ok") is False:
            wire = payload.get("error") or {}
            raise BridgeError(wire.get("code", "error"), wire.get("message", ""), wire.get("details"))
        return payload

    # -- generic -----------------------------------------------------------

    def status(self) -> dict:
        return self._request("GET", "/v1/status")

    def hub(self) -> dict:
        return self._request("GET", "/v1/hub")

    def call(self, method: str, params: Any = None, timeout_ms: Optional[int] = None) -> Any:
        timeout_ms = timeout_ms or self.default_timeout_ms
        body = {"method": method, "timeoutMs": timeout_ms}
        if params is not None:
            body["params"] = params
        return self._request("POST", "/v1/call", body, timeout_s=timeout_ms / 1000 + 5)["result"]

    def api(self, path: str, *args: Any, timeout_ms: Optional[int] = None) -> Any:
        """Call one EasyEDA Pro API method, e.g. api("pcb_PrimitiveComponent.get", "e12")."""
        return self.call("apiCall", {"path": path, "args": list(args)}, timeout_ms)

    def batch(self, calls: Sequence[Any], stop_on_error: bool = True, timeout_ms: Optional[int] = None) -> list:
        """Run several API calls in one round trip. Items: {"path", "args"} dicts or (path, args) tuples."""
        normalized = [c if isinstance(c, dict) else {"path": c[0], "args": list(c[1]) if len(c) > 1 else []} for c in calls]
        result = self.call("apiBatch", {"calls": normalized, "stopOnError": stop_on_error}, timeout_ms or 60_000)
        return result["results"]

    def describe(self, namespace: Optional[str] = None) -> dict:
        return self.call("apiDescribe", {"namespace": namespace} if namespace else {})

    # -- PCB helpers -------------------------------------------------------

    def pcb_snapshot(self, include: Optional[Sequence[str]] = None, timeout_ms: Optional[int] = None) -> dict:
        return self.call("pcbSnapshot", {"include": list(include)} if include else {}, timeout_ms or 60_000)

    def move(self, designator: str, x=None, y=None, dx=None, dy=None, rotation=None, layer=None) -> dict:
        """Move/rotate/flip a PCB component by designator (mil). Returns before/after placement."""
        component = find_component(self.pcb_snapshot(["components"]).get("components", []), designator)
        props = move_properties(component, x=x, y=y, dx=dx, dy=dy, rotation=rotation, layer=layer)
        self.api("pcb_PrimitiveComponent.modify", component["primitiveId"], props)
        after = self.api("pcb_PrimitiveComponent.get", component["primitiveId"])
        return {
            "designator": component.get("designator", designator),
            "primitiveId": component["primitiveId"],
            "requested": props,
            "before": _placement(component),
            "after": _placement(after),
        }

    def drc(self, strict: bool = False, verbose: bool = False) -> dict:
        params = {}
        if strict:
            params["strict"] = True
        if verbose:
            params["verbose"] = True
        return self.call("pcbDrc", params, 120_000)

    def render(self, designator: Optional[str] = None, region: Optional[Sequence[float]] = None,
               out: Optional[os.PathLike] = None, margin: Optional[float] = None) -> Any:
        """PNG of the editor canvas fitted to a component or region (left, right, top, bottom).

        Changes the editor view (zoom). Returns the PNG bytes, or the written path when `out` is given.
        """
        params: dict = {}
        if margin is not None:
            params["margin"] = margin
        if region is not None:
            if isinstance(region, dict):
                params["region"] = region
            else:
                left, right, top, bottom = region
                params["region"] = {"left": left, "right": right, "top": top, "bottom": bottom}
        if designator:
            if self.status().get("activeDocumentType") == "schematic":
                components = self.call("schematicSnapshot", {"includeRaw": False, "allPages": False}, 60_000).get("components", [])
            else:
                components = self.pcb_snapshot(["components"]).get("components", [])
            params["primitiveIds"] = [find_component(components, designator)["primitiveId"]]
        image = self.call("renderImage", params)
        data = base64.b64decode(image["base64"])
        if out is None:
            return data
        target = pathlib.Path(out)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target
