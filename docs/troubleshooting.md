# Troubleshooting

Start with the symptom you see.

## Extension Is Not Connected

You may see:

- `easyeda_live_status` returns `connected: false`
- `easyeda_doctor` says the extension is disconnected
- tool calls fail even though the MCP server starts

Fix:

1. make sure the MCP client is running
2. make sure EasyEDA Pro is open
3. open a schematic or PCB
4. confirm the extension is installed or loaded
5. enable external interaction permission ("Allow interactive with external"); it is off right after install
6. wait a few seconds: the extension retries every 5 s and connects as soon as the server and permission are available
7. run `easyeda_doctor` again

Restarting the MCP server or client does not need a manual reconnect. The extension notices a lost server within about 15 s and keeps retrying. `MCP Bridge -> Reconnect` is still available if you do not want to wait.

If `easyeda_doctor` reports a protocol mismatch, rebuild and reinstall both pieces with `npm run setup:local`. Server and extension must use the same bridge protocol (currently `0.2.0`).

## MCP Bridge Menu Is Missing

The header menu is off by default after install.

Fix:

1. open Extensions Manager
2. select the extension and open Config
3. enable "Show at header menu"

On narrow windows (about 1280 px) EasyEDA folds extension menus in editors into an overflow button.

## MCP Client Does Not Show Tools

You may see:

- the server is configured, but no `easyeda_*` tools appear
- new tools exist in code but not in the client

Fix:

1. run `npm run setup:local`
2. restart the MCP client
3. run `easyeda_doctor` once the extension reconnects on its own

Why: most MCP clients load the tool catalog when the session starts.

## `dist/index.js` Is Missing

Fix:

```bash
npm run setup:local
```

If you only need the server build:

```bash
npm run build
```

## WebSocket Bridge Does Not Connect

Default endpoint:

```text
ws://127.0.0.1:8765
```

Check:

1. the MCP server is running
2. the extension is targeting the same host and port
3. `EASYEDA_MCP_WS_HOST` was not changed unexpectedly
4. `EASYEDA_MCP_WS_PORT` was not changed unexpectedly
5. local security tooling is not blocking loopback WebSocket traffic

## Bridge Port Is Used by Another Process

You may see `easyeda_doctor` or other tools report the bridge as unavailable with a message like `Bridge port 127.0.0.1:8765 is used by another process ...`.

Only one MCP server can talk to the extension at a time. A second server (for example from a second MCP client) does not exit. It stays up, retries every 5 s, and takes the port once the first server stops.

Fix:

1. stop the other MCP server or client, or
2. use a different port for both sides: set `EASYEDA_MCP_WS_PORT` for the server, and point the extension at the same port

The extension has no settings UI for the port. Change the default in `extension/src/bridgeConfig.ts` and rebuild, or define `globalThis.__EASYEDA_MCP_BRIDGE_CONFIG__` (for example `{ port: 8766 }`) before the extension loads.

## EasyEDA Pro Rejects the Extension Package

Check:

1. `extension.json` is at the package root
2. the extension `name` uses lowercase-hyphen style
3. the `uuid` is exactly 32 lowercase alphanumeric characters
4. the bundle was built with `format=iife`
5. the global name is `edaEsbuildExportName`

Rebuild:

```bash
npm run setup:local
```

## Schematic Results Look Incomplete

You may see:

- missing pins
- sparse net traces
- low confidence
- warnings in `easyeda_schematic_snapshot`

What to do:

1. run `easyeda_schematic_snapshot`
2. inspect `warnings`
3. inspect `confidence`
4. run a narrower tool such as `easyeda_trace_component`
5. cross-check critical findings in EasyEDA Pro

Why: EasyEDA Pro may expose partial raw schematic primitives, so some connectivity is inferred.

If every pin shows as unconnected on a real design, update both server and extension: older builds could not parse EasyEDA Pro 3.x wire geometry.

With `allPages: true` (the default) the extension briefly switches through every schematic page and then reopens your document. That flicker is expected.

## Navigation Goes to the Wrong Place

Fix:

1. search first with `easyeda_find_component`
2. use a more exact designator, such as `USB1` instead of `USB`
3. run `easyeda_trace_component` to confirm the target
4. then call `easyeda_navigate_component`

## Export Tools Fail

Check:

1. the active document type supports that export (Gerber is PCB only)
2. the expected schematic or PCB is currently active, or `scope` is set
3. the extension is connected
4. the relevant EasyEDA manufacture API is available
5. the target file does not already exist, or pass `overwrite: true`

Exports do not open a save dialog. The server writes the file and returns its `path`.

If the netlist export fails with `export_unavailable`, EasyEDA Pro returned no schematic netlist for this project (common on imported projects). Open the PCB and export with `scope: "pcb"`.

Then run:

```text
Run easyeda_doctor.
```

## Confirmed Actions Are Blocked

Mutating actions require explicit confirmation. The error code is `confirmation_required` and the error includes `expectedConfirmation`.

After the user approves, send exactly `CONFIRM <action>` for the same action (case-insensitive):

```json
{
  "action": "save",
  "confirmation": "CONFIRM save"
}
```

Other errors:

- `unsupported_document`: `save` needs an open schematic page or PCB
- `missing_json`: `autoroute` and `autolayout` need `params.json` with the router's result JSON text

## Reliable Reset

When the state is confusing:

1. stop the MCP client
2. reopen EasyEDA Pro
3. start the MCP client again
4. open the target project
5. wait for the extension to reconnect (or run `MCP Bridge -> Reconnect`)
6. run `easyeda_doctor`
