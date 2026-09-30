import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeText, tsvToCsv, writeExport } from "./exportFiles.js";

const utf16Bom = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

describe("export files", () => {
  it("decodes UTF-16LE text with a byte order mark", () => {
    expect(decodeText(utf16Bom("Designator\tValue\nC1\t2.2µF"))).toBe("Designator\tValue\nC1\t2.2µF");
  });

  it("converts EasyEDA's tab-separated BOM to CSV with quoting", () => {
    expect(tsvToCsv("Name\tComment\nR1\t10k, 1%\nC1\tsays \"hi\"")).toBe("Name,Comment\nR1,\"10k, 1%\"\nC1,\"says \"\"hi\"\"\"");
  });

  it("writes a csv BOM as UTF-8 CSV and returns its text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-export-"));
    const written = await writeExport(
      { fileName: "board.csv", base64: utf16Bom("Designator\tQuantity\nR1,R2\t2").toString("base64") },
      { kind: "bom", format: "csv", outputPath: `${dir}/` }
    );

    expect(written.path).toBe(path.join(dir, "board.csv"));
    expect(written.text).toBe("Designator,Quantity\n\"R1,R2\",2");
    expect(await readFile(written.path, "utf8")).toBe(written.text);
  });

  it("writes a json BOM as an array of row objects", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-export-"));
    const written = await writeExport(
      { fileName: "board.csv", base64: utf16Bom("Designator\tQuantity\nR1,R2\t2\n").toString("base64") },
      { kind: "bom", format: "json", outputPath: `${dir}/` }
    );

    expect(written.fileName).toBe("board.json");
    expect(JSON.parse(written.text ?? "")).toEqual([{ Designator: "R1,R2", Quantity: "2" }]);
  });

  it("keeps binary exports byte-for-byte and does not inline them", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-export-"));
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const written = await writeExport({ fileName: "a.pdf", base64: bytes.toString("base64") }, { kind: "pdf", outputPath: path.join(dir, "out.pdf") });

    expect(written.text).toBeUndefined();
    expect(Buffer.compare(await readFile(written.path), bytes)).toBe(0);
  });

  it("refuses to overwrite an existing file unless asked", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "easyeda-export-"));
    const target = path.join(dir, "n.enet");
    await writeFile(target, "old");
    const file = { fileName: "n.enet", base64: Buffer.from("{}").toString("base64") };

    await expect(writeExport(file, { kind: "netlist", outputPath: target })).rejects.toThrow(/EEXIST/);
    await expect(writeExport(file, { kind: "netlist", outputPath: target, overwrite: true })).resolves.toMatchObject({ text: "{}" });
  });
});
