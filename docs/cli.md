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

Non-owners watch the config dir: the owner deletes `hub.json` just before it
releases the port, and that triggers a short burst of bind attempts, so takeover
takes a few milliseconds (an interval re-check every 2 s is the fallback). The
owner also sends the extension `{"kind":"bye"}`, so the extension reconnects right
away instead of waiting for its 15 s watchdog. A proxied call that finds the owner gone
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
easyeda export --list                # catalog, incl. unsupported kinds and why
easyeda export gerber --out ./out/
easyeda export step
easyeda export bom --format json --out bom.json --overwrite
easyeda package --preset fab --zip --drc-gate
easyeda package --kinds gerber,pnp,bom,step --out ./release
easyeda check                        # exit 0 clean, 1 findings, 2 error
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
- `export <kind>` writes `<project>-<kind>.<ext>` into the current directory
  (or `--out` file/dir, never overwriting without `--overwrite`). See
  [Exports and packages](#exports-and-packages).
- `--timeout <ms>` sets the per-call timeout.

**Auto-start.** When no hub is reachable, commands that talk to EasyEDA start a
daemon in the background (`--start`, default for those commands; `--no-start`
disables it). The daemon logs to `daemon.log` in the config dir. The CLI then
waits up to 20 s for the extension to connect (it watches the config dir for
`hub.json`, then long-polls `/v1/status?waitFor=connected`, so it continues the
moment the extension says hello). `status` and `stop` never start a
daemon unless `--start` is given.

## Exports and packages

All exports go through one catalog (`src/mcp/exportCatalog.ts`), used by the CLI,
the MCP tools (`easyeda_export`, `easyeda_package`), and the Python client (via the
hub). Each kind is one `*_ManufactureData.get*` call made by the extension's
`exportFile` method. The editor must show the right document, so the CLI calls
`useDocument` for the kind's document (PCB or schematic) first and reopens the
previous document afterwards. Timings are EasyEDA times on a 79-part 2-layer board.

| kind | file | ms | notes |
| --- | --- | --- | --- |
| `gerber` | `.zip` | 300 | drill files inside |
| `step` | `.step` | 475 | 3D |
| `obj` | `.zip` | 243 | 3D |
| `pnp` | `.csv` | 12 | pick and place / CPL, mm |
| `bom` | `.csv`/`.json`/`.xlsx` | 30–360 | `--format`; TSV/UTF-16 converted |
| `netlist` | `.enet` | 317 | from the PCB (`--scope schematic` for the schematic one, often empty) |
| `dxf` | `.dxf` | 521 | ~2 MB |
| `pcb-pdf` (`pdf`) | `.pdf` | 399 | `pdf --scope schematic` = `sch-pdf` |
| `sch-pdf` | `.pdf` | 368 | all pages |
| `sch-svg` / `sch-png` | `.zip` | 239 / 443 | |
| `ipc356` | `.356a` | 21 | IPC-D-356A |
| `odb` | `.zip` | 301 | ODB++ |
| `ibom` | `.html` | 1500 | interactive BOM, ~9 MB |
| `dsn` | `.dsn` | 157 | Specctra |
| `flying-probe`, `pcb-info` | `.txt` | 14, 7 | |
| `altium`, `pads` | detected | 620, 540 | extension from the file's magic bytes / name |
| `testpoint` | `.csv` | 5 | `export_empty` when the board has no test points |

Not offered (broken in EasyEDA Pro 3.2.149): `ipc2581` (never resolves),
`sch-dxf` (error dialog, never resolves), `3d-shell` (returns nothing and leaves a
warning dialog without 3D shell objects), `autoroute-json` and `spice` (return
nothing).

**`easyeda package`** exports a preset or `--kinds` list into
`./easyeda-package-<project>-<timestamp>/` (or `--out`), files named
`<project>-<kind>.<ext>`, plus `manifest.json`:

```json
{ "project": "...", "board": "...", "generatedAt": "...", "extensionVersion": "...",
  "files": [{ "kind": "gerber", "path": "P-gerber.zip", "bytes": 1234, "sha256": "...", "ms": 300 }],
  "failures": [{ "kind": "testpoint", "error": { "code": "export_empty", "message": "..." } }],
  "drc": { "ok": true, "errorCount": 0, "categories": [] }, "counts": { ... },
  "documents": { "switches": [...], "restored": true } }
```

Presets: `fab` = gerber (with drill), pcb-pdf, netlist, ipc356, odb;
`assembly` = bom (csv), pnp, step, ibom; `docs` = sch-pdf, pcb-pdf, sch-svg, step;
`all` = every supported kind. Kinds are grouped by document: one switch to the PCB
(where DRC also runs), one to the schematic, then back to the original document.
A failing file is recorded under `failures` and the rest continue. `--zip` also
writes `<folder>.zip`. Exit code 1 when any file failed, or with `--drc-gate` when
DRC reports errors (files are still written).

**`easyeda check`** is a design check for CI: DRC, then the schematic (all pages)
compared with the PCB netlist export as a pin partition over
(designator, pin): split nets, merged nets, net-name mismatches (auto `Net…`
names excluded), pins/parts missing on either side, and the number of unconnected
schematic pins. PCB-only parts whose pads are all unconnected (mounting holes,
fiducials) are informational. Text by default, `--json` for the full report,
`--strict` to also count those pads. Exit code 0 = clean, 1 = findings, 2 = error.
The comparison lives in `src/schematic/compareNetlist.ts`, which
`dev/live/compare-netlist.mjs` also uses.

## HTTP API

Served by the bridge owner on `127.0.0.1:${EASYEDA_MCP_HTTP_PORT:-8766}`.
Every request needs `Authorization: Bearer <token>`.

| Request | Response |
| --- | --- |
| `GET /v1/status` | The bridge status (`connected`, `connectionState`, `documentName`, `capabilities`, ...). |
| `GET /v1/hub` | `{ok, role: "mcp"\|"daemon", pid, wsPort, httpPort, startedAt, version}` |
| `POST /v1/call` `{method, params?, timeoutMs?}` | `{ok: true, result}` or `{ok: false, error: {code, message, details?}}` |
| `POST /v1/shutdown` `{}` | Stops a daemon hub. An MCP server's hub answers 409 `not_daemon`. |
| `GET /v1/status?waitFor=connected&timeoutMs=N` | Long-poll: answers as soon as the extension says hello, or with the current status after N ms (max 60000). |
| `GET /v1/exports` | The export catalog (`supported`, `unsupported` with reasons). |
| `POST /v1/ops/export` `{kind, format?, scope?}` | `{kind, fileName, mimeType, size, ms, base64, ...}`; the hub switches documents and back. |
| `POST /v1/ops/package` `{kinds?, preset?}` | `{manifest, files: [{kind, fileName, size, base64}]}`; the client writes the folder/zip. |
| `POST /v1/ops/check` `{strict?}` | The design check report (`ok`, `findings`, `drc`, `connectivity`, `unconnectedPins`, ...). |

`method` is any bridge method the extension implements: `apiCall`
(`{path, args}`), `apiBatch` (`{calls, stopOnError}`), `apiDescribe`,
`pcbSnapshot`, `pcbDrc`, `renderImage`, `schematicSnapshot`, `getContext`,
`exportBom`, ... `timeoutMs` defaults to 10 s and is capped at 600 s.

Status codes: 200 success; 400 bad body or invalid argument (`invalid_argument`, `export_unsupported`, `component_not_found`); 401 missing/wrong token; 403 `Origin`
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
eda.export("step", out="out/")                  # any catalog kind
eda.package(preset="fab", zip=True)             # folder + manifest.json (+ zip)
report = eda.check()                             # report["ok"], report["findings"]
```

`export`, `package`, and `check` run in the hub (same catalog and logic as the
CLI); files come back base64 and the client writes them. See `clients/python/README.md` and `clients/python/example_move.py`. Tests run
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
| `easyeda_export` | writes a file, switches documents (and back) |
| `easyeda_package` | writes a folder (+ zip), switches documents (and back) |
| `easyeda_design_check` | does not change the design; switches documents (and back) |

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
