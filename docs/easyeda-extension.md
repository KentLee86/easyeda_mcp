# EasyEDA Pro Extension Setup

The extension is what gives the MCP server live access to EasyEDA Pro.

Without it, the MCP server can start, but tools cannot inspect the open editor session.

## Quick Path

From the repository root:

```bash
npm run setup:local
```

Then in EasyEDA Pro:

1. import or load the packaged extension
2. enable external interaction permission
3. optionally enable "Show at header menu" to get the `MCP Bridge` menu
4. open a schematic or PCB
5. run `easyeda_doctor` from your MCP client

The extension connects on its own; a short toast confirms the connection.

## What Gets Built

`npm run setup:local` creates:

```text
dist/index.js
extension/dist/index.js
```

It also packages the EasyEDA extension artifact for import workflows.

The extension manifest lives at:

```text
extension/extension.json
```

## Permission You Must Enable

EasyEDA Pro may disable external interaction for local extensions.

Enable it for this extension. The bridge needs it because the extension uses `SYS_WebSocket` to connect to:

```text
ws://127.0.0.1:8765
```

The permission ("Allow interactive with external") is off right after install, and EasyEDA Pro does not start an extension on install. Enabling the permission starts the extension and it connects within a few seconds; after that it also starts with EasyEDA Pro. If the permission is later found missing, the extension shows the hint once and keeps retrying.

If this permission is off, the MCP client may show tools, but live editor calls will fail.

## Versions

The server and extension must speak the same bridge protocol. Current versions:

- npm package: `1.1.0`
- extension: `0.3.0`
- bridge protocol: `0.2.0`

After updating, rebuild with `npm run setup:local`, reinstall the `.eext`, restart EasyEDA Pro and the MCP client.

## Updating the Extension

EasyEDA Pro 3.2 caches an installed extension by its uuid and version and does not stop code that is already running:

- **Always bump the version** in `extension/extension.json` (and `src/version.ts`) for a new build. Re-importing the same version keeps the old code, even after an uninstall and a restart.
- **Restart EasyEDA Pro after installing or updating.** Uninstalling or re-importing while the editor is open can leave the previous build running and connected; after a restart only the installed build runs and it connects on startup.
- If the old build keeps the connection until then, the MCP server still works with it; tools added in the new build report `unknown_method` until the restart.

## Verify

After EasyEDA Pro is open and the extension is loaded, ask your MCP client:

```text
Run easyeda_doctor.
```

Healthy output should show:

- `connected: true`
- compatible bridge protocol
- an active project or document

Then ask:

```text
Run easyeda_get_context.
```

## Connection Behavior

- the extension sends a heartbeat every 5 s and the server acks it
- if the server goes away, the extension notices within about 15 s
- it then retries every 5 s, indefinitely

Restarting the MCP server or client therefore needs no action in EasyEDA Pro.

## Extension Menu

The `MCP Bridge` header menu is off by default after install. Enable it in Extensions Manager -> the extension -> Config -> "Show at header menu".

Use these commands inside EasyEDA Pro when needed:

- `MCP Bridge -> Reconnect`
- `MCP Bridge -> Run Diagnostics`

`Reconnect` skips the retry wait. On narrow windows (about 1280 px) EasyEDA folds extension menus in editors into an overflow button.

## Packaging Rules

These details matter if you change the extension package:

- `extension.json` must be at the package root
- extension `name` must use lowercase-hyphen style
- `uuid` must be exactly 32 lowercase alphanumeric characters
- the browser bundle must use EasyEDA-compatible output

Current bundle settings:

- `esbuild`
- `format=iife`
- `globalName=edaEsbuildExportName`

## Related Files

- `extension/src/index.ts`
- `extension/src/bridgeConfig.ts`
- `extension/extension.json`
- `scripts/package-extension.mjs`
