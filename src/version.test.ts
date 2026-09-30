import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTENSION_VERSION, SERVER_VERSION } from "./version.js";

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("versions", () => {
  it("match the package and extension manifests", () => {
    expect(SERVER_VERSION).toBe(readJson("../package.json").version);
    expect(EXTENSION_VERSION).toBe(readJson("../extension/extension.json").version);
  });
});
