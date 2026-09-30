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

# A project opened before is listed under Recent Design on the Start Page; click
# it there (no native file dialog). Otherwise use Open Project.
via=$("$here/node.sh" node -e '
import("./dev/live/cdp.mjs").then(async ({ Page }) => {
  const page = await Page.open();
  const [dir, file] = [process.argv[1].replace(/\/[^/]*$/, ""), process.argv[1].replace(/^.*\//, "").replace(/\.eprj2$/, "")];
  const hit = await page.eval(`(() => {
    const row = Array.from(document.querySelectorAll("tr")).find(r => r.offsetParent && r.innerText.includes(${JSON.stringify(dir)}) && r.innerText.includes(${JSON.stringify(file)}));
    const link = row && Array.from(row.querySelectorAll("*")).find(e => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(file)});
    if (!link) return false;
    link.click();
    return true;
  })()`);
  if (!hit) await page.eval("document.querySelector(\"[class*=client_start_project]\").click(); 1");
  console.log(hit ? "recent" : "dialog");
  page.close();
});' "$inside")

if [ "$via" = "dialog" ]; then

# GTK file chooser: focus it, open the location bar, type the path, confirm.
docker exec "$name" bash -c '
export DISPLAY=:${XVFB_DISPLAY:-77}
# --sync blocks until the dialog window exists
w=$(timeout 30 xdotool search --sync --onlyvisible --name "^Select File$" | head -1 || true)
[ -n "$w" ] || { echo "file dialog did not open" >&2; exit 3; }
# GTK needs a moment after mapping and after opening the location bar; shorter
# waits drop keystrokes (measured), so these stay.
xdotool windowfocus --sync "$w"; sleep 0.5
xdotool key ctrl+l; sleep 0.3; xdotool key ctrl+a
xdotool type --delay 20 "$1"; sleep 0.3; xdotool key Return' _ "$inside"
fi

"$here/node.sh" node -e '
import("./dev/live/cdp.mjs").then(async ({ Page }) => {
  const page = await Page.open();
  const name = await page.waitFor("(async () => { const i = await window._EXTAPI_ROOT_.dmt_Project.getCurrentProjectInfo(); return i && i.friendlyName; })()", 90000);
  // A fresh profile asks once about net-name dragging; keep the default. The
  // dialog follows the load within ~1 s when it appears at all.
  const confirm = "Array.from(document.querySelectorAll(\"button\")).filter(b => b.offsetParent && b.textContent.trim() == \"Confirm\")";
  const shown = await page.waitFor(confirm + ".length > 0", 1500).catch(() => false);
  if (shown) await page.eval(confirm + ".forEach(b => b.click()); 1");
  const info = await page.api("const p = await eda.dmt_Project.getCurrentProjectInfo(); return p.data.map(b => ({ board: b.name, pages: b.schematic.page.map(pg => pg.name + \"=\" + pg.uuid), pcb: b.pcb && (b.pcb.name + \"=\" + b.pcb.uuid) }));");
  console.log("opened", name, JSON.stringify(info));
  page.close();
});'
