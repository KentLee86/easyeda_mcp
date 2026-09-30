# CLI, HTTP hub, and Python client

Control EasyEDA Pro from code instead of screenshots and clicks. The EasyEDA API
itself is fast (moving a component takes a few ms, DRC well under a second), so
the goal here is a fast programmatic channel: the `easyeda` shell command, a
small JSON-over-HTTP API, and a stdlib-only Python client.

## How it fits together

```text
EasyEDA Pro extension ──WebSocket 127.0.0.1:8765──► bridge owner ◄──HTTP 127.0.0.1:8766── easyeda CLI / Python / other MCP servers
```

Exactly one process owns the WebSocket port the extension connects to. That
process is the **bridge owner** and also serves the **hub** HTTP API. The owner
is whichever starts first:

- an MCP stdio server (`easyeda-pro-mcp`, started by your AI client), or
- a daemon (`easyeda-pro-mcp daemon` or `easyeda daemon`), which runs only the
  bridge and hub, without MCP.

Other processes do not fight over the port:

| Situation when a process starts | What it does |
| --- | --- |
| Port free | Becomes the owner: binds the port, serves the hub, writes `hub.json`. |
| Port held by a hub that accepts our token | **Proxy mode**: MCP tool calls are forwarded to that hub over HTTP. The extension does not need to reconnect. |
| Port held by something else | Waits and retries (the extension is reported as not connected). |

Every 2 s a non-owner tries to bind the port again. When the owner exits it
sends the extension `{"kind":"bye"}`, so the extension reconnects right away
instead of waiting for its 15 s watchdog; one of the remaining processes binds
the port and becomes the new owner. A proxied call that finds the owner gone
fails with `bridge_unavailable` and triggers an immediate takeover attempt;
retry it after a few seconds.

A daemon started while another hub already owns the port exits (nothing to do).

## The `easyeda` command

Installed as a second bin of the npm package (`easyeda`), or run from a checkout
with `node dist/cli/index.js`.

```bash
easyeda status
easyeda call pcb_PrimitiveComponent.getAll
easyeda call pcb_PrimitiveComponent.modify '"e12"' '{"x":100}'
easyeda batch calls.json            # or: ... | easyeda batch -
easyeda describe pcb_PrimitiveComponent
easyeda pcb snapshot --include components,tracks --out board.json
easyeda pcb move U1 --dx 50 --rotation 90
easyeda pcb move U1 --x 1000 --y 500 --layer bottom
easyeda pcb drc
easyeda sch snapshot --out sch.json
easyeda export bom --format csv --out ./out/
easyeda export gerber --out ./out/gerber.zip --overwrite
easyeda render --designator U1 --out u1.png
easyeda render --region 0,2000,0,1500 --margin 0.2 --out area.png
easyeda daemon                      # foreground bridge + hub
easyeda stop                        # stop a daemon
```

- Output is JSON on stdout (`--pretty` to indent). Errors are JSON on stderr
  (`{"ok":false,"error":{"code","message"}}`) with exit code 1 (2 for usage errors).
- `call` parses each argument as JSON; if that fails it is passed as a string
  (`e12` and `'"e12"'` both work). Put arguments starting with `-` after `--`.
- `batch` takes `[{"path": "...", "args": [...]}, ...]` and runs them in one
  round trip. It stops at the first error unless `--continue-on-error`; the exit
  code is 1 when any call failed.
- `pcb move` resolves the designator through `pcbSnapshot`, calls
  `pcb_PrimitiveComponent.modify`, reads the component back with
  `pcb_PrimitiveComponent.get`, and prints `before`/`after`. Units are mil;
  `--layer` is `top` (1), `bottom` (2), or a layer id. `--x`/`--y` are absolute,
  `--dx`/`--dy` relative.
- `render` returns a PNG of the canvas fitted to a component or region. It does
  not modify the design but it changes the editor view (zoom/pan).
- `export` reuses the MCP export code, including the UTF-16 TSV → CSV BOM fix.
- `--timeout <ms>` sets the per-call timeout.

**Auto-start.** When no hub is reachable, commands that talk to EasyEDA start a
daemon in the background (`--start`, default for those commands; `--no-start`
disables it). The daemon logs to `daemon.log` in the config dir. The CLI then
waits up to 20 s for the extension to connect. `status` and `stop` never start a
daemon unless `--start` is given.

## HTTP API

Served by the bridge owner on `127.0.0.1:${EASYEDA_MCP_HTTP_PORT:-8766}`.
Every request needs `Authorization: Bearer <token>`.

| Request | Response |
| --- | --- |
| `GET /v1/status` | The bridge status (`connected`, `connectionState`, `documentName`, `capabilities`, ...). |
| `GET /v1/hub` | `{ok, role: "mcp"\|"daemon", pid, wsPort, httpPort, startedAt, version}` |
| `POST /v1/call` `{method, params?, timeoutMs?}` | `{ok: true, result}` or `{ok: false, error: {code, message, details?}}` |
| `POST /v1/shutdown` `{}` | Stops a daemon hub. An MCP server's hub answers 409 `not_daemon`. |

`method` is any bridge method the extension implements: `apiCall`
(`{path, args}`), `apiBatch` (`{calls, stopOnError}`), `apiDescribe`,
`pcbSnapshot`, `pcbDrc`, `renderImage`, `schematicSnapshot`, `getContext`,
`exportBom`, ... `timeoutMs` defaults to 10 s and is capped at 600 s.

Status codes: 200 success; 400 bad body; 401 missing/wrong token; 403 `Origin`
header or non-loopback `Host`; 404/405 unknown route; 413 body over 16 MB; 415
POST without `Content-Type: application/json`; 502 the extension answered with an
error (e.g. `api_forbidden`, `api_unavailable`); 503 `bridge_unavailable`
(extension not connected); 504 `bridge_timeout`; 409 `bridge_protocol_mismatch`.

```bash
TOKEN=$(cat ~/.config/easyeda-mcp/token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8766/v1/status
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"method":"apiCall","params":{"path":"pcb_PrimitiveComponent.getAllPrimitiveId"}}' \
  http://127.0.0.1:8766/v1/call
```

## Python client

`clients/python/easyeda_bridge.py` uses only the standard library; copy it next
to your script.

```python
from easyeda_bridge import Bridge

eda = Bridge()                                   # reads token + hub.json
eda.api("pcb_PrimitiveComponent.getAll")
eda.batch([("pcb_PrimitiveComponent.get", ["e12"])])
eda.pcb_snapshot(["components"])
eda.move("U1", dx=50)                            # before/after
eda.drc()
eda.render(designator="U1", out="u1.png")
```

See `clients/python/README.md` and `clients/python/example_move.py`. Tests run
against a fake hub: `npm run test:python`.

## MCP tools for the same features

| Tool | Kind |
| --- | --- |
| `easyeda_pcb_snapshot` | read-only; `include` selects sections |
| `easyeda_pcb_drc` | read-only |
| `easyeda_api_describe` | read-only |
| `easyeda_render_view` | read-only (changes the view); returns MCP image content |
| `easyeda_api_call` | read-only for methods starting with `get`/`is`/`has`/`check`/`calculate`/`convert`/`discretize`/`describe`; everything else is mutating and gated |
| `easyeda_pcb_move_component` | mutating, gated; returns before/after |

Gated tools need `confirmation` exactly `CONFIRM api <path>` (for example
`CONFIRM api pcb_PrimitiveComponent.modify`) or `CONFIRM move <designator>`
(case-insensitive), sent only after the user approved the change. Setting
`EASYEDA_MCP_ALLOW_MUTATIONS=1` in the MCP server's environment is an explicit
user opt-in that skips the phrase for these two tools. It does not affect
`easyeda_confirmed_action` (save, autoroute, ...). The CLI, the HTTP API, and the
Python client are not gated: they are driven by you (or your scripts), not by a
model.

## Security

- **Localhost only.** The WebSocket bridge and the hub bind `127.0.0.1`.
- **Token.** A random 256-bit token lives in `<config dir>/token` (directory
  0700, file 0600), created on first use and reused afterwards. The config dir is
  `$EASYEDA_MCP_CONFIG_DIR`, else `$XDG_CONFIG_HOME/easyeda-mcp`, else
  `~/.config/easyeda-mcp`. Anyone who can read it can drive your editor; delete it
  to rotate (restart the hub afterwards).
- **Browsers are refused.** Requests carrying an `Origin` header are rejected
  (403), as are `Host` headers other than `127.0.0.1`/`localhost` (DNS
  rebinding), and POST bodies that are not `application/json` (no CORS-simple
  requests).
- **API allow-list.** The extension only exposes `dmt_`, `pcb_`, `sch_`, `lib_`,
  and `pnl_` namespaces through `apiCall`; others fail with `api_forbidden`.
- **`hub.json`** (`{pid, role, wsPort, httpPort, startedAt}`) is written next to
  the token for discovery and removed on clean shutdown. It holds no secrets.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `EASYEDA_MCP_WS_PORT` | `8765` | WebSocket port the extension connects to |
| `EASYEDA_MCP_HTTP_PORT` | `8766` | Hub HTTP port (clients otherwise read it from `hub.json`) |
| `EASYEDA_MCP_CONFIG_DIR` | see above | Where `token`, `hub.json`, and `daemon.log` live |
| `EASYEDA_MCP_ALLOW_MUTATIONS` | unset | `1` lets MCP clients use `easyeda_api_call`/`easyeda_pcb_move_component` without the confirmation phrase |
