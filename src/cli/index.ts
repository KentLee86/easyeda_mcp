#!/usr/bin/env node
import { runCli } from "./main.js";

runCli(process.argv.slice(2)).then((code) => {
  if (code !== undefined) {
    process.exit(code);
  }
});
