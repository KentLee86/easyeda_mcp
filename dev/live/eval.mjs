// Run a snippet in the live editor page with `eda` bound, print the JSON result.
//   dev/live/node.sh node dev/live/eval.mjs 'return (await eda.dmt_SelectControl.getCurrentDocumentInfo())'
//   dev/live/node.sh node dev/live/eval.mjs 'await eda.dmt_EditorControl.openDocument("<uuid>")'
import { Page } from "./cdp.mjs";

const page = await Page.open();
console.log(JSON.stringify(await page.api(process.argv[2] ?? "return null"), null, 1));
page.close();
