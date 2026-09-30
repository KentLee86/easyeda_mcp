# Safety Model

The bridge is designed to be useful before it is powerful.

Default behavior is read-first. Anything that changes the EasyEDA Pro project must be explicit.

## Safe by Default

These workflows do not directly change project content:

- live status
- editor context
- component and net search
- schematic snapshots
- pin, net, and component tracing
- connection verification
- navigation
- exports

Use them freely during review and debugging.

Exports do not change the project, but they write a file on your machine (by default under `$EASYEDA_MCP_EXPORT_DIR` or `<os tmp>/easyeda-mcp-exports/`). They never overwrite an existing file unless `overwrite: true` is passed.

## Actions That Can Change the Project

Project-changing actions go through:

```text
easyeda_confirmed_action
```

Supported actions:

- `save`
- `importChanges`
- `autoroute`
- `autolayout`

The tool blocks the request unless `confirmation` is exactly `CONFIRM <action>` for the same action (case-insensitive, whitespace normalized):

- `CONFIRM save`
- `CONFIRM importChanges`
- `CONFIRM autoroute`
- `CONFIRM autolayout`

Anything else, including `I confirm`, `confirmed`, or a phrase for a different action, is rejected with `confirmation_required`. The error includes `expectedConfirmation`.

The MCP client should send the confirmation only after the user explicitly approves that action. It should not fill it in on its own.

### Editing Through the API

`easyeda_api_call` (non-read methods) and `easyeda_pcb_move_component` also change the project. They need `CONFIRM api <path>` and `CONFIRM move <designator>` respectively, unless the user starts the MCP server with `EASYEDA_MCP_ALLOW_MUTATIONS=1`. Only the `dmt_`, `pcb_`, `sch_`, `lib_` and `pnl_` API namespaces are reachable; file, network and storage APIs (`sys_*`) are not.

The local JSON API used by the CLI and the Python client (see [CLI](./cli.md)) has no confirmation step: it requires the token in the user's config directory, accepts only 127.0.0.1 and rejects browser requests.

## Why Confirmation Exists

AI-assisted exploration often involves guesses, retries, and partial context.

The confirmation gate keeps those exploratory reads separate from actions that can affect the open project.

## Confidence Levels

Schematic analysis may return a confidence value:

- `high`: data is strong enough for normal review
- `partial`: useful, but some raw EasyEDA data was missing or inferred
- `low`: treat as a hint and verify manually

Always read `warnings` when they appear.

## Practical Rule

For important electrical decisions:

1. use the MCP tools to find and explain the issue
2. check warnings and confidence
3. verify the critical area in EasyEDA Pro
4. use confirmed actions only when the intent is clear

## Not Implemented

This project does not implement:

- commercial/order operations
- unrestricted editor automation
- offline `.epro` parsing
