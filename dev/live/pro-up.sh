#!/bin/bash
# Build (once) and start EasyEDA Pro for live development.
#   EASYEDA_PRO_ACTIVATION_FILE=/path/to/activation.txt dev/live/pro-up.sh
# The activation file is mounted read-only and never copied. Activation and
# settings persist in the Docker volume easyeda-mcp-live-home.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
image=${EASYEDA_LIVE_IMAGE:-easyeda-mcp-live:3.2.149}
name=${EASYEDA_LIVE_CONTAINER:-easyeda-mcp-live}
activation=${EASYEDA_PRO_ACTIVATION_FILE:?set EASYEDA_PRO_ACTIVATION_FILE to your EasyEDA Pro activation file}

docker image inspect "$image" >/dev/null 2>&1 || docker build -t "$image" "$here"
docker rm -f "$name" >/dev/null 2>&1 || true
mkdir -p "$here/.work"
docker run -d --name "$name" --shm-size=2g \
    -u "$(id -u):$(id -g)" \
    -v easyeda-mcp-live-home:/home/eda \
    -v "$(realpath "$activation")":/run/secrets/easyeda-pro-activation:ro \
    -v "$repo":/repo:ro \
    -v "$here/.work":/work \
    "$image" >/dev/null
echo "started $name; next: dev/live/node.sh node dev/live/setup.mjs"
