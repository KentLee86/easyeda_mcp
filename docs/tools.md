# Tools Reference

Use this page when you know what you want to do and need the right MCP tool.

## Fast Picker

| Goal | Start with |
| --- | --- |
| Check whether the bridge works | `easyeda_doctor` |
| See what is open in EasyEDA Pro | `easyeda_get_context` |
| Find a part | `easyeda_find_component` |
| Find a net | `easyeda_find_net` |
| Inspect the whole schematic | `easyeda_schematic_snapshot` |
| List schematic parts | `easyeda_list_schematic_components` |
| Inspect one part's pins | `easyeda_get_component_pins` |
| Trace a signal or power rail | `easyeda_trace_net` |
| Trace everything around one part | `easyeda_trace_component` |
| Find likely wiring gaps | `easyeda_find_unconnected_pins` |
| Run generic schematic checks | `easyeda_validate_schematic_area` |
| Check exact connection rules | `easyeda_verify_connections` |
| Move the editor to a part | `easyeda_navigate_component` |
| Export manufacturing files | `easyeda_export_bom`, `easyeda_export_netlist`, `easyeda_export_gerber`, `easyeda_export_pdf` |
| Save/import/autoroute/autolayout | `easyeda_confirmed_action` |

## Recommended First Flow

Run these in order when starting a session:

1. `easyeda_doctor`
2. `easyeda_get_context`
3. `easyeda_schematic_snapshot`
4. `easyeda_trace_component` or `easyeda_trace_net`

## Tool Groups

- status and context
- search and inspection
- schematic analysis
- navigation and export
- explicitly confirmed actions

## Status and Context

### `easyeda_live_status`

Checks whether the EasyEDA Pro extension is connected and returns current bridge and editor status information.

Use this for a quick yes/no connection check.

### `easyeda_doctor`

Returns a structured diagnosis of the local MCP bridge, extension connection state, protocol compatibility, active document availability, and recommended next steps.

Use this first when anything feels broken.

### `easyeda_get_context`

Returns a broader summary of the current editor context, including active document details and some available counts for project data.

Document types follow EasyEDA Pro's editor document types: `schematic`, `pcb`, `symbol`, `footprint`, `panel`, `home`, or `unknown`.

Use this to confirm the AI is looking at the right EasyEDA Pro document.

## Search and Inspection

### `easyeda_find_component`

Searches the active project for components. An exact designator match wins, so `R1` returns `R1` and not `R10`. Otherwise it matches substrings of the designator, value, name, or footprint.

Good queries: `U1`, `USB1`, `TPS`, `regulator`, or a footprint name.

### `easyeda_find_net`

Searches nets by name and returns available net metadata and connections.

Good queries: `GND`, `VCC_5V`, `SDA`, `VBUS`, `D+`, or `CC1`.

## Schematic Analysis

Schematic tools take `allPages` (default `true`) and then read every schematic page of the board. Pins and wires are only readable on the open page, so the extension briefly opens each page and then reopens the document you had open.

With several pages:

- connectivity is computed per page
- named nets (net labels, net flags, wire net names) merge across pages
- a multi-part component (same designator on several pages) is merged for component and pin queries
- items carry `page: { uuid, name }` and `counts.pages` reports the page count

On imported designs where a net flag's net holds the symbol name, the flag's Value is used as the net name, matching EasyEDA Pro's netlist.

### `easyeda_schematic_snapshot`

Builds a structured, normalized snapshot of the active schematic, including components, pins, wires, labels, nets, counts, warnings, and confidence metadata.

This is the best starting point for schematic-level analysis.

### `easyeda_list_schematic_components`

Lists normalized schematic components with key fields such as designator, value, name, footprint, position, and selected properties.

Use it to inventory the schematic or filter for a family of parts.

### `easyeda_get_component_pins`

Returns the pins known for a component, including pin number, pin name, position, and net when available.

Use it before writing exact checks with `easyeda_verify_connections`.

### `easyeda_trace_net`

Traces a net and returns the pins, components, wires, labels, and related evidence associated with it.

Use it to inspect a signal, power rail, or named net.

### `easyeda_trace_component`

Traces a component's connections grouped by pin and net.

Use it to review how one device is wired.

### `easyeda_find_unconnected_pins`

Finds pins that do not have a confirmed net in the normalized schematic data.

Use it to find likely missing wires or symbol connectivity issues.

### `easyeda_validate_schematic_area`

Runs generic read-only schematic checks against selected components, selected nets, or the whole schematic.

The current validation layer may report findings such as:

- `pin_without_net`
- `single_pin_net`
- `single_node_net`
- `similar_power_net_names`
- `power_net_without_detected_capacitor`

### `easyeda_verify_connections`

Runs structured connection assertions against the active schematic.

Use this when you want targeted checks such as:

- whether a pin is connected at all
- whether a pin is on a specific net
- whether two endpoints resolve to the same node
- whether a path exists or does not exist
- whether a signal is pulled to a reference net through a resistor or other passive component
- whether a power node appears decoupled to a reference net

Supported assertion types include:

- `pin_connected`
- `pin_on_net`
- `same_node`
- `path_exists`
- `path_absent`
- `pull_to_net`
- `decoupled_to_net`

Example shape:

```json
{
  "checks": [
    {
      "type": "pin_on_net",
      "component": "USB1",
      "pinName": "GND",
      "net": "GND"
    },
    {
      "type": "path_exists",
      "from": { "component": "USB1", "pinName": "CC1" },
      "to": { "net": "GND" },
      "through": { "kind": "resistor", "value": "5.1k" }
    }
  ]
}
```

## Navigation and Export

### `easyeda_navigate_component`

Requests navigation to a component in the EasyEDA Pro editor.

Use it after search or trace when you want to inspect the part visually.

### `easyeda_navigate_region`

Navigates to coordinates or a rectangular region in the active document.

Use it when:

- you already know the coordinate target
- you want to zoom into a specific area

### `easyeda_zoom_board`

Zooms the active PCB editor to the board outline.

### Export tools

Export tools do not open an EasyEDA save dialog. The extension returns the file contents and the MCP server writes the file.

Shared inputs:

- `outputPath`: a file path, or a directory ending in `/`. Default: `$EASYEDA_MCP_EXPORT_DIR`, else `<os tmp>/easyeda-mcp-exports/`
- `overwrite`: default `false`; an existing file is an error
- `maxInlineChars`: default `20000`; how much text to return inline
- `scope` (BOM, netlist, PDF): `auto` (default) follows the active document, schematic or PCB

Result shape:

```json
{ "path": "...", "fileName": "...", "bytes": 1234, "mimeType": "text/csv", "text": "...", "truncated": false, "note": "..." }
```

`text` is returned for BOM `csv`/`json` and for netlists. `truncated` and `note` appear only when relevant.

These tools write files, so they are not annotated read-only.

### `easyeda_export_bom`

Exports a BOM from the active project.

Supported formats:

- `csv`: UTF-8 CSV (EasyEDA's tab-separated UTF-16 output is converted)
- `xlsx`: binary
- `json`: an array of row objects

### `easyeda_export_netlist`

Exports a netlist from the active schematic or PCB context.

Some projects (for example imported ones) return no schematic netlist. The tool then fails with `export_unavailable`; open the PCB and export with `scope: "pcb"`.

### `easyeda_export_gerber`

Exports Gerber fabrication data (zip) from the active PCB. PCB only.

### `easyeda_export_pdf`

Exports a PDF from the active schematic or PCB document.

## Explicitly Confirmed Actions

### `easyeda_confirmed_action`

Runs a mutating EasyEDA Pro action only when `confirmation` is exactly `CONFIRM <action>` for the same action. Matching is case-insensitive and whitespace is normalized.

| Action | Confirmation | Notes |
| --- | --- | --- |
| `save` | `CONFIRM save` | saves the active schematic page or PCB; other documents fail with `unsupported_document` |
| `importChanges` | `CONFIRM importChanges` | |
| `autoroute` | `CONFIRM autoroute` | requires `params.json` |
| `autolayout` | `CONFIRM autolayout` | requires `params.json` |

Anything else, including free-form phrases like `I confirm` or `confirmed`, is rejected with `confirmation_required`. The error includes `expectedConfirmation`.

The client should send the confirmation only after the user explicitly approves the action.

For `autoroute` and `autolayout`, `params.json` is the router's result JSON text. Without it the tool fails with `missing_json`.

Example shape:

```json
{
  "action": "save",
  "confirmation": "CONFIRM save"
}
```

```json
{
  "action": "autoroute",
  "confirmation": "CONFIRM autoroute",
  "params": { "json": "<router result JSON text>" }
}
```

## Practical Usage Pattern

A useful workflow is often:

1. `easyeda_live_status`
2. `easyeda_doctor`
3. `easyeda_get_context`
4. `easyeda_schematic_snapshot`
5. `easyeda_trace_component` or `easyeda_trace_net`
6. `easyeda_verify_connections` for targeted assertions
7. `easyeda_navigate_component` if you need to inspect the area visually
