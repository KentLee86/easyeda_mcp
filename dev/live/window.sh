#!/bin/bash
# Resize the Pro window to 1920x1080 (Electron has no CDP window API). Only needed
# when driving header menus, e.g. checking an installed .eext; at 1280px the
# editor folds extension menus into an overflow button.
set -euo pipefail
name=${EASYEDA_LIVE_CONTAINER:-easyeda-mcp-live}
docker exec "$name" bash -c 'export DISPLAY=:${XVFB_DISPLAY:-77}
w=$(xdotool search --onlyvisible --name "JLCEDA Pro|EasyEDA Pro" | head -1)
xdotool windowmove "$w" 0 0 windowsize "$w" 1920 1080'
