"""Nudge a component, print where it went, and run DRC.

    python3 example_move.py U1 --dx 50
"""

import argparse
import json

from easyeda_bridge import Bridge


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("designator")
    for name in ("x", "y", "dx", "dy", "rotation"):
        parser.add_argument(f"--{name}", type=float)
    parser.add_argument("--layer", help="top, bottom, or a layer id")
    parser.add_argument("--drc", action="store_true", help="run DRC after the move")
    options = parser.parse_args()

    eda = Bridge()
    status = eda.status()
    if not status.get("connected"):
        raise SystemExit(f"EasyEDA Pro is not connected: {status.get('message')}")

    moved = eda.move(options.designator, x=options.x, y=options.y, dx=options.dx, dy=options.dy,
                     rotation=options.rotation, layer=options.layer)
    print(json.dumps(moved, indent=2))
    if options.drc:
        report = eda.drc()
        print(f"DRC ok={report.get('ok')} errors={report.get('errorCount')}")


if __name__ == "__main__":
    main()
