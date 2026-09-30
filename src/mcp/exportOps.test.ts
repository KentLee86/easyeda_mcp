import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { describeCatalog, detectExtension, EXPORT_CATALOG, getCatalogEntry, safeName } from "./exportCatalog.js";
import { collectPackage, exportKind, formatDesignCheck, resolvePackageKinds, runDesignCheck, writePackage } from "./exportOps.js";
import { crc32 } from "./zipWriter.js";
import { fakeEditor } from "./fakeEditor.testutil.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("export catalog", () => {
  it("detects extensions from magic bytes, name and mime", () => {
    expect(detectExtension(Buffer.from("PK\u0003\u0004..."))).toBe("zip");
    expect(detectExtension(Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(detectExtension(Buffer.from("ISO-10303-21;"), "board", "text/plain")).toBe("step");
    expect(detectExtension(Buffer.from("<!DOCTYPE html><html>"))).toBe("html");
    expect(detectExtension(Buffer.from("xyz"), "a.PcbDoc")).toBe("pcbdoc");
    expect(detectExtension(Buffer.from("xyz"), "noext", "text/plain")).toBe("txt");
    expect(detectExtension(Buffer.from("xyz"))).toBe("bin");
  });

  it("resolves kinds, aliases, scope and refuses the known-broken ones", () => {
    expect(getCatalogEntry("pdf").kind).toBe("pcb-pdf");
    expect(getCatalogEntry("pdf", { scope: "schematic" }).kind).toBe("sch-pdf");
    expect(getCatalogEntry("bom", { scope: "schematic" })).toMatchObject({ document: "schematic", path: "sch_ManufactureData.getBomFile" });
    expect(() => getCatalogEntry("ipc2581")).toThrow(/not supported: Never resolves/);
    expect(() => getCatalogEntry("nope")).toThrow(/Unknown export kind/);
    expect(new Set(EXPORT_CATALOG.map((entry) => entry.kind)).size).toBe(EXPORT_CATALOG.length);
    const described = describeCatalog();
    expect(described.unsupported.map((item) => item.kind)).toEqual(expect.arrayContaining(["ipc2581", "sch-dxf", "3d-shell"]));
    expect(described.supported.every((entry) => entry.path.includes("ManufactureData.get"))).toBe(true);
    expect(safeName("My Board/v2")).toBe("My_Board_v2");
  });

  it("computes crc32 like zlib", () => {
    expect(crc32(Buffer.from("123456789")).toString(16)).toBe("cbf43926");
  });
});

describe("exportKind", () => {
  it("switches to the kind's document, exports, and restores the original", async () => {
    const editor = fakeEditor();
    const file = await exportKind(editor.bridge, "step");
    expect(file).toMatchObject({ kind: "step", fileName: "My_Board_v2-step.step", document: "pcb", restored: true });
    expect(editor.log).toEqual(["use:pcb", "export:pcb_ManufactureData.get3DFile", "use:sch1"]);
    expect(editor.current.uuid).toBe("sch1");
  });

  it("converts the BOM and restores even when the export fails", async () => {
    const editor = fakeEditor({ failPaths: ["pcb_ManufactureData.getDxfFile"] });
    const bom = await exportKind(editor.bridge, "bom", { format: "json" });
    expect(bom.fileName).toBe("My_Board_v2-bom.json");
    expect(JSON.parse(bom.data.toString())).toEqual([{ Designator: "R1", Value: "10k" }]);
    await expect(exportKind(editor.bridge, "dxf")).rejects.toMatchObject({ code: "export_empty" });
    expect(editor.current.uuid).toBe("sch1");
    await expect(exportKind(editor.bridge, "gerber", { format: "csv" })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("package", () => {
  it("groups kinds into one switch per document, records failures, runs DRC, restores, and writes manifest + zip", async () => {
    const editor = fakeEditor({ failPaths: ["pcb_ManufactureData.getOpenDatabaseDoublePlusFile"], drcErrors: 2 });
    const collected = await collectPackage(editor.bridge, { kinds: ["sch-pdf", "gerber", "odb", "sch-svg", "pnp"], now: new Date("2026-09-30T12:00:00Z") });

    expect(editor.log.filter((line) => line.startsWith("use:"))).toEqual(["use:pcb", "use:schematic"]);
    expect(editor.log.indexOf("drc")).toBeGreaterThan(editor.log.indexOf("use:pcb"));
    const { manifest } = collected;
    expect(manifest).toMatchObject({ project: "My_Board_v2", board: "Board", extensionVersion: "1.2.0", drc: { ok: false, errorCount: 2 }, counts: { components: 2 } });
    expect(manifest.files.map((file) => file.path)).toEqual(["My_Board_v2-gerber.zip", "My_Board_v2-pnp.csv", "My_Board_v2-sch-pdf.pdf", "My_Board_v2-sch-svg.zip"]);
    expect(manifest.failures).toEqual([{ kind: "odb", error: { code: "export_empty", message: "no file from pcb_ManufactureData.getOpenDatabaseDoublePlusFile" } }]);
    expect(manifest.documents.restored).toBe(false); // last group was the schematic we started on
    expect(manifest.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    const cwd = await mkdtemp(path.join(os.tmpdir(), "easyeda-pkg-"));
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const written = await writePackage(collected, { zip: true, cwd });
    expect(path.basename(written.dir)).toBe("easyeda-package-My_Board_v2-20260930-120000");
    expect(JSON.parse(await readFile(written.manifestPath, "utf8")).files).toHaveLength(4);
    const zip = await JSZip.loadAsync(await readFile(written.zipPath!));
    const names = Object.keys(zip.files).sort();
    expect(names).toContain("easyeda-package-My_Board_v2-20260930-120000/manifest.json");
    expect(await zip.file("easyeda-package-My_Board_v2-20260930-120000/My_Board_v2-gerber.zip")!.async("string")).toBe("PK\u0003\u0004fakezip");
  });

  it("restores the original document when it was not the last one used", async () => {
    const editor = fakeEditor();
    await collectPackage(editor.bridge, { kinds: ["sch-pdf"], drc: true });
    // pcb (for DRC) -> schematic -> nothing to restore (we started on the schematic)
    expect(editor.log.filter((line) => line.startsWith("use:"))).toEqual(["use:pcb", "use:schematic"]);
    const pcbOnly = fakeEditor();
    const result = await collectPackage(pcbOnly.bridge, { preset: "fab" });
    expect(pcbOnly.log.filter((line) => line.startsWith("use:"))).toEqual(["use:pcb", "use:sch1"]);
    expect(result.manifest.documents.restored).toBe(true);
    expect(result.manifest.files.map((file) => file.kind)).toEqual(["gerber", "pcb-pdf", "netlist", "ipc356", "odb"]);
  });

  it("resolves presets", () => {
    expect(resolvePackageKinds({ preset: "assembly" }).map((entry) => entry.kind)).toEqual(["bom", "pnp", "step", "ibom"]);
    expect(resolvePackageKinds({ preset: "all" })).toHaveLength(EXPORT_CATALOG.length);
    expect(() => resolvePackageKinds({ preset: "x" })).toThrow(/Unknown preset/);
  });
});

describe("design check", () => {
  const page = { uuid: "p" };
  const schematic = {
    components: [{ primitiveId: "r1", page, componentType: "part", designator: "R1" }, { primitiveId: "u1", page, componentType: "part", designator: "U1" }],
    pins: [
      { page, componentPrimitiveId: "r1", componentDesignator: "R1", pinNumber: "1", nodeId: "a", net: "VCC", connected: true },
      { page, componentPrimitiveId: "u1", componentDesignator: "U1", pinNumber: "1", nodeId: "b", net: "VCC", connected: true },
      { page, componentPrimitiveId: "u1", componentDesignator: "U1", pinNumber: "2", connected: false }
    ],
    counts: { components: 2 }
  };
  const enet = { components: { a: { props: { Designator: "R1" }, pinInfoMap: { 1: { number: "1", net: "VCC" } } }, b: { props: { Designator: "U1" }, pinInfoMap: { 1: { number: "1", net: "VCC" }, 2: { number: "2", net: "" } } } } };

  it("reports DRC, split nets and unconnected pins, then restores", async () => {
    const editor = fakeEditor({ enet, schematic, drcErrors: 1 });
    const report = await runDesignCheck(editor.bridge);
    expect(report.ok).toBe(false);
    expect(report.drc.errorCount).toBe(1);
    expect(report.connectivity?.counters.split).toBe(1);
    expect(report.unconnectedPins).toEqual({ count: 1, pins: ["U1.2"] });
    expect(report.findings).toBe(2);
    expect(editor.log.filter((line) => line.startsWith("use:"))).toEqual(["use:pcb", "use:schematic"]);
    expect(formatDesignCheck(report)).toContain("split 1");
  });

  it("is clean when everything matches", async () => {
    const clean = { ...schematic, pins: schematic.pins.map((pin) => (pin.nodeId ? { ...pin, nodeId: "a" } : pin)) };
    const report = await runDesignCheck(fakeEditor({ enet, schematic: clean }).bridge);
    expect(report).toMatchObject({ ok: true, findings: 0 });
  });
});
