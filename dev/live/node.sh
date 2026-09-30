#!/bin/bash
# Run a command in a Node sidecar that shares the EasyEDA Pro container's
# network namespace (CDP on 127.0.0.1:9222, bridge on 127.0.0.1:8765).
#   dev/live/node.sh node dev/live/run.mjs dev/live/calls/smoke.json
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
name=${EASYEDA_LIVE_CONTAINER:-easyeda-mcp-live}
tty=()
[ -t 0 ] && tty=(-t)
exec docker run --rm -i "${tty[@]}" --network "container:$name" \
    -u "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$repo":/repo -w /repo \
    node:22-slim "$@"
