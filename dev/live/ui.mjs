// Click through EasyEDA Pro UI by visible text (trusted CDP mouse events).
//   dev/live/node.sh node dev/live/ui.mjs "Advanced" "Extensions Manager(E)..." shot:dev/live/.work/x.png
// --optional makes the next label a no-op when it does not appear within 3s.
import { Page, sleep } from "./cdp.mjs";

const page = await Page.open();
let optional = false;
for (const step of process.argv.slice(2)) {
  if (step === "--optional") {
    optional = true;
    continue;
  }
  if (step.startsWith("shot:")) {
    await page.screenshot(step.slice(5));
  } else {
    try {
      await page.clickText(step, optional ? 3000 : 15_000);
    } catch (error) {
      if (!optional) throw error;
    }
    await sleep(1200);
  }
  optional = false;
}
page.close();
