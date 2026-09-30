#!/bin/bash
# Install the packaged extension into the live Pro through Extensions Manager,
# the same way a user does (release check; day-to-day work uses inject.mjs).
#   npm run setup:local && dev/live/install-eext.sh [--replace] [--allow-external]
# --replace uninstalls an installed copy first. --allow-external also ticks "Allow interactive with external" and
# "Show at header menu" in the extension's Config tab.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
name=${EASYEDA_LIVE_CONTAINER:-easyeda-mcp-live}
eext=/repo/build/dist/easyeda_mcp_bridge.eext
[ -f "$repo/build/dist/easyeda_mcp_bridge.eext" ] || { echo "run npm run setup:local first" >&2; exit 2; }

ui() { "$here/node.sh" node dev/live/ui.mjs "$@"; }

"$here/window.sh"
replace=false; allow=false
for arg in "$@"; do
  case "$arg" in
    --replace) replace=true ;;
    --allow-external) allow=true ;;
  esac
done
if $replace; then
  # Remove an installed copy first (the uninstall dialog wants a confirmation tick).
  ui "Advanced" "Extensions Manager(E)..." "Installed" --optional "Uninstall" --optional "I got it, continue to operate." --optional "Confirm" "Close"
fi
ui "Advanced" "Extensions Manager(E)..." "Import"
docker exec "$name" bash -c '
export DISPLAY=:${XVFB_DISPLAY:-77}
# --sync blocks until the dialog window exists
w=$(timeout 30 xdotool search --sync --onlyvisible --name "^Open Files$" | head -1 || true)
[ -n "$w" ] || { echo "file dialog did not open" >&2; exit 3; }
# GTK needs a moment after mapping and after opening the location bar; shorter
# waits drop keystrokes (measured), so these stay.
xdotool windowfocus --sync "$w"; sleep 0.5
xdotool key ctrl+l; sleep 0.3; xdotool key ctrl+a
xdotool type --delay 20 "$1"; sleep 0.3; xdotool key Return' _ "$eext"
# "Safety Tips": external interaction is disabled by default for new extensions.
ui --optional "Confirm"
# That Confirm sometimes closes the Extensions Manager too; reopen it if so.
open=$("$here/node.sh" node dev/live/eval.mjs 'return !!Array.from(document.querySelectorAll("[class*=modal_dialog_]")).find(e => e.offsetParent && e.innerText.startsWith("Extensions Manager"))')
[ "$open" = "true" ] || ui "Advanced" "Extensions Manager(E)..."
ui "Installed" "EasyEDA MCP Bridge" "Config"
if $allow; then
  ui "Allow interactive with external" "Show at header menu"
fi
ui "shot:dev/live/.work/install-eext.png" "Close"
echo "installed $eext"
