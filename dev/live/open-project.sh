#!/bin/bash
# Open a local .eprj2 in the live Pro through Start Page > Open Project.
#   dev/live/open-project.sh dev/live/.work/MyBoard.eprj2
# The file must be inside dev/live/.work (mounted at /work in the Pro container).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=${EASYEDA_LIVE_CONTAINER:-easyeda-mcp-live}
file=$(realpath "$1")
case "$file" in "$here/.work/"*) ;; *) echo "put the project under $here/.work" >&2; exit 2 ;; esac
inside="/work/${file#"$here/.work/"}"

"$here/node.sh" node -e '
import("./dev/live/cdp.mjs").then(async ({ Page }) => {
  const page = await Page.open();
  await page.eval("document.querySelector(\"[class*=client_start_project]\").click(); 1");
  page.close();
});'

# GTK file chooser: focus it, open the location bar, type the path, confirm.
docker exec "$name" bash -c '
export DISPLAY=:${XVFB_DISPLAY:-77}
for _ in $(seq 1 30); do w=$(xdotool search --onlyvisible --name "^Select File$" | head -1); [ -n "$w" ] && break; sleep 1; done
[ -n "$w" ] || { echo "file dialog did not open" >&2; exit 3; }
xdotool windowfocus --sync "$w"; sleep 0.5
xdotool key ctrl+l; sleep 0.3; xdotool key ctrl+a
xdotool type --delay 20 "$1"; sleep 0.3; xdotool key Return' _ "$inside"

"$here/node.sh" node -e '
import("./dev/live/cdp.mjs").then(async ({ Page }) => {
  const page = await Page.open();
  const name = await page.waitFor("(async () => { const i = await window._EXTAPI_ROOT_.dmt_Project.getCurrentProjectInfo(); return i && i.friendlyName; })()", 90000);
  // A fresh profile asks once about net-name dragging; keep the default.
  await new Promise((r) => setTimeout(r, 3000));
  await page.eval("Array.from(document.querySelectorAll(\"button\")).filter(b => b.offsetParent && b.textContent.trim() == \"Confirm\").forEach(b => b.click()); 1");
  const info = await page.api("const p = await eda.dmt_Project.getCurrentProjectInfo(); return p.data.map(b => ({ board: b.name, pages: b.schematic.page.map(pg => pg.name + \"=\" + pg.uuid), pcb: b.pcb && (b.pcb.name + \"=\" + b.pcb.uuid) }));");
  console.log("opened", name, JSON.stringify(info));
  page.close();
});'
