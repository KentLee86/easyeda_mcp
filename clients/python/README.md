# easyeda_bridge (Python)

Stdlib-only client for the easyeda-mcp hub HTTP API. Copy `easyeda_bridge.py`
next to your script; no install step.

A hub must be running: an MCP client with easyeda-pro-mcp configured, or
`easyeda daemon` (the `easyeda` CLI also starts one on demand). The client reads
the token and `hub.json` from `$EASYEDA_MCP_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/easyeda-mcp`, else `~/.config/easyeda-mcp`.

```python
from easyeda_bridge import Bridge

eda = Bridge()
eda.status()                                   # extension/document status
eda.api("pcb_PrimitiveComponent.getAll")       # any dmt_/pcb_/sch_/lib_/pnl_ method
eda.batch([("pcb_PrimitiveComponent.get", ["e12"]), {"path": "pcb_Net.getAllNetsName"}])
snap = eda.pcb_snapshot(["components", "tracks"])
eda.move("U1", dx=50, rotation=90)             # mil; returns before/after
eda.drc()
eda.render(designator="U1", out="u1.png")      # PNG of the canvas (changes the view)
```

Errors raise `BridgeError` with `.code` (`bridge_unavailable`, `api_forbidden`,
`component_not_found`, `unauthorized`, `hub_unreachable`, ...).

- `example_move.py U1 --dx 50 --drc` — nudge a part and run DRC.
- Tests (fake hub, no EasyEDA needed): `python3 -m unittest discover -s clients/python -p 'test_*.py'`
  or `npm run test:python`.

See `docs/cli.md` for the HTTP API and the security model.
