import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSchematicSnapshot,
  findUnconnectedPins,
  getComponentPins,
  traceComponent,
  traceNet,
  validateSchematicArea,
  verifyConnections,
  type RawSchematicData
} from "./analysis.js";

function loadFixture(name: string): RawSchematicData {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as RawSchematicData;
}

describe("schematic analysis", () => {
  it("normalizes components, pins, wires, labels, and nets", () => {
    const snapshot = buildSchematicSnapshot({
      components: [
        component("U1", "$u1", "MCU"),
        netflag("GND", "$gnd1")
      ],
      pinsByComponent: {
        $u1: [
          pin("1", "VDD", "VCC_5V"),
          pin("2", "GND", "GND")
        ]
      },
      wires: [
        wire("VCC_5V"),
        wire("GND")
      ],
      includeRaw: false
    });

    expect(snapshot.counts).toMatchObject({
      components: 2,
      pins: 2,
      wires: 2,
      labels: 1,
      nets: 2
    });
    expect(snapshot.confidence).toBe("high");
    expect(snapshot.nets.map((net) => net.name)).toEqual(["GND", "VCC_5V"]);
  });

  it("gets pins for a component", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("USB1", "$usb1", "USB-C")],
      pinsByComponent: {
        $usb1: [
          pin("A4", "VBUS", "VCC_5V"),
          pin("A1", "GND", "GND")
        ]
      },
      wires: [wire("VCC_5V"), wire("GND")]
    });

    const result = getComponentPins(snapshot, "USB1");

    expect(result.component?.designator).toBe("USB1");
    expect(result.pins).toHaveLength(2);
    expect(result.confidence).toBe("high");
  });

  it("traces a net and flags a single node net", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("R1", "$r1", "10k")],
      pinsByComponent: {
        $r1: [pin("1", "1", "SENSE")]
      },
      wires: []
    });

    const result = traceNet(snapshot, "SENSE");

    expect(result.net?.name).toBe("SENSE");
    expect(result.findings[0]?.type).toBe("single_node_net");
  });

  it("finds unconnected pins", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("U2", "$u2", "Sensor")],
      pinsByComponent: {
        $u2: [
          pin("1", "VDD", "3V3"),
          pin("2", "INT", undefined)
        ]
      },
      wires: [wire("3V3")]
    });

    const result = findUnconnectedPins(snapshot);

    expect(result.pins.map((pin) => pin.pinName)).toEqual(["INT"]);
    expect(result.findings[0]?.message).toContain("U2#2");
  });

  it("validates area with common generic findings", () => {
    const snapshot = buildSchematicSnapshot({
      components: [
        component("U3", "$u3", "IC"),
        component("R1", "$r1", "10k"),
        netflag("+3V3", "$p1"),
        netflag("3V3", "$p2")
      ],
      pinsByComponent: {
        $u3: [
          pin("1", "VCC", "+3V3"),
          pin("2", "NC", undefined)
        ],
        $r1: [pin("1", "1", "SENSE")]
      },
      wires: [wire("+3V3"), wire("SENSE")]
    });

    const result = validateSchematicArea(snapshot);

    expect(result.findings.map((finding) => finding.type)).toContain("pin_without_connection");
    expect(result.findings.map((finding) => finding.type)).toContain("single_pin_net");
    expect(result.findings.map((finding) => finding.type)).toContain("similar_power_net_names");
  });

  it("traces component with per-pin net details", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("C1", "$c1", "100nF")],
      pinsByComponent: {
        $c1: [
          pin("1", "1", "3V3"),
          pin("2", "2", "GND")
        ]
      },
      wires: [wire("3V3"), wire("GND")]
    });

    const result = traceComponent(snapshot, "C1");

    expect(result.pins[0]?.netDetail?.name).toBe("3V3");
    expect(result.findings).toHaveLength(0);
  });

  it("infers a pin net when the pin touches a named wire endpoint", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("J1", "$j1", "CONN")],
      pinsByComponent: {
        $j1: [pinAt("1", "VBUS", undefined, 10, 0)]
      },
      wires: [wirePath("VBUS", [[10, 0, 40, 0]])],
      includeRaw: false
    });

    expect(snapshot.pins[0]?.net).toBe("VBUS");
    expect(snapshot.pins[0]?.netSource).toBe("wire_inferred");
    expect(snapshot.pins[0]?.connectivityEvidence?.confidence).toBe("high");
  });

  it("infers a pin net when the pin touches a horizontal or vertical wire segment", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("U1", "$u1", "IC")],
      pinsByComponent: {
        $u1: [
          pinAt("1", "SDA", undefined, 25, 0),
          pinAt("2", "SCL", undefined, 50, 25)
        ]
      },
      wires: [
        wirePath("I2C_SDA", [[10, 0, 40, 0]]),
        wirePath("I2C_SCL", [[50, 10, 50, 40]])
      ],
      includeRaw: false
    });

    expect(snapshot.pins.map((item) => item.net)).toEqual(["I2C_SDA", "I2C_SCL"]);
  });

  it("propagates a net across touching wire segments", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("U2", "$u2", "IC")],
      pinsByComponent: {
        $u2: [pinAt("1", "EN", undefined, 80, 0)]
      },
      wires: [
        wirePath("GPS_EN", [[0, 0, 40, 0]]),
        wirePath(undefined, [[40, 0, 80, 0]])
      ],
      includeRaw: false
    });

    expect(snapshot.pins[0]?.net).toBe("GPS_EN");
    expect(snapshot.nets.find((net) => net.name === "GPS_EN")?.wires).toHaveLength(2);
  });

  it("uses a netflag to name an otherwise unnamed wire group", () => {
    const snapshot = buildSchematicSnapshot({
      components: [
        component("U3", "$u3", "IC"),
        netflagAt("+3V3", "$pwr", 20, 0)
      ],
      pinsByComponent: {
        $u3: [pinAt("1", "VCC", undefined, 40, 0)]
      },
      wires: [wirePath(undefined, [[0, 0, 40, 0]])],
      includeRaw: false
    });

    expect(snapshot.pins[0]?.net).toBe("+3V3");
    expect(snapshot.pins[0]?.netSource).toBe("label_inferred");
  });

  it("does not treat decorative text as net labels", () => {
    const snapshot = buildSchematicSnapshot({
      components: [],
      texts: [
        { primitiveId: "$txt1", text: "Pull-up", x: 10, y: 10 },
        { primitiveId: "$txt2", text: "GPIO", x: 20, y: 20 }
      ],
      includeRaw: false
    });

    expect(snapshot.labels).toHaveLength(0);
    expect(snapshot.nets).toHaveLength(0);
  });

  it("resolves a USB-C sink fixture through geometry", () => {
    const snapshot = buildSchematicSnapshot({
      components: [
        component("USB1", "$usb1", "USB-C"),
        component("R1", "$r1", "5.1kΩ"),
        component("R2", "$r2", "5.1kΩ"),
        component("D1", "$d1", "USBLC6-2P6"),
        netflagAt("GND", "$gnd", 0, 20)
      ],
      pinsByComponent: {
        $usb1: [
          pinAt("A4", "VBUS", undefined, 10, 0),
          pinAt("A9", "VBUS", undefined, 20, 0),
          pinAt("B4", "VBUS", undefined, 30, 0),
          pinAt("B9", "VBUS", undefined, 40, 0),
          pinAt("A1", "GND", undefined, 10, 20),
          pinAt("A12", "GND", undefined, 20, 20),
          pinAt("B1", "GND", undefined, 30, 20),
          pinAt("B12", "GND", undefined, 40, 20),
          pinAt("1", "EH", undefined, 50, 20),
          pinAt("A5", "CC1", undefined, 10, 40),
          pinAt("B5", "CC2", undefined, 20, 50),
          pinAt("A6", "DP1", undefined, 10, 60),
          pinAt("B6", "DP2", undefined, 20, 60),
          pinAt("A7", "DN1", undefined, 10, 80),
          pinAt("B7", "DN2", undefined, 20, 80)
        ],
        $r1: [
          pinAt("1", "1", undefined, 60, 40),
          pinAt("2", "2", undefined, 60, 20)
        ],
        $r2: [
          pinAt("1", "1", undefined, 70, 50),
          pinAt("2", "2", undefined, 70, 20)
        ],
        $d1: [
          pinAt("1", "I/O1", undefined, 30, 60),
          pinAt("3", "I/O2", undefined, 30, 80),
          pinAt("6", "I/O1", undefined, 50, 60),
          pinAt("4", "I/O2", undefined, 50, 80)
        ]
      },
      wires: [
        wirePath("VBUS", [[10, 0, 40, 0]]),
        wirePath("GND", [[0, 20, 50, 20]]),
        wirePath("USB_IN_CC1", [[10, 40, 60, 40]]),
        wirePath("USB_IN_CC2", [[20, 50, 70, 50]]),
        wirePath("GND", [[60, 20, 70, 20]]),
        wirePath("USB_IN_D+", [[10, 60, 30, 60]]),
        wirePath("USB_IN_D+", [[20, 60, 30, 60]]),
        wirePath("USB_IN_D-", [[10, 80, 30, 80]]),
        wirePath("USB_IN_D-", [[20, 80, 30, 80]]),
        wirePath("USB_D+", [[50, 60, 70, 60]]),
        wirePath("USB_D-", [[50, 80, 70, 80]])
      ],
      includeRaw: false
    });

    const usbPins = getComponentPins(snapshot, "USB1").pins;
    expect(usbPins.filter((item) => item.pinName === "VBUS").map((item) => item.net)).toEqual(["VBUS", "VBUS", "VBUS", "VBUS"]);
    expect(usbPins.filter((item) => ["GND", "EH"].includes(item.pinName ?? "")).map((item) => item.net)).toEqual(["GND", "GND", "GND", "GND", "GND"]);
    expect(usbPins.find((item) => item.pinName === "CC1")?.net).toBe("USB_IN_CC1");
    expect(usbPins.find((item) => item.pinName === "CC2")?.net).toBe("USB_IN_CC2");
    expect(usbPins.find((item) => item.pinName === "DP1")?.net).toBe("USB_IN_D+");
    expect(usbPins.find((item) => item.pinName === "DP2")?.net).toBe("USB_IN_D+");
    expect(usbPins.find((item) => item.pinName === "DN1")?.net).toBe("USB_IN_D-");
    expect(usbPins.find((item) => item.pinName === "DN2")?.net).toBe("USB_IN_D-");
  });

  it("assigns node ids for unnamed local connections without flagging them as unconnected", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("U1", "$u1", "IC"), component("R1", "$r1", "10k")],
      pinsByComponent: {
        $u1: [pinAt("1", "PROG", undefined, 10, 0)],
        $r1: [pinAt("1", "1", undefined, 30, 0), pinAt("2", "2", undefined, 30, 20)]
      },
      wires: [wirePath(undefined, [[10, 0, 30, 0]])],
      includeRaw: false
    });

    const prog = snapshot.pins.find((item) => item.pinName === "PROG");
    const resistorPin = snapshot.pins.find((item) => item.componentDesignator === "R1" && item.pinNumber === "1");

    expect(prog?.nodeId).toBeDefined();
    expect(prog?.nodeId).toBe(resistorPin?.nodeId);
    expect(prog?.connected).toBe(true);
    expect(findUnconnectedPins(snapshot).pins.map((item) => item.pinName)).toEqual(["2"]);
  });

  it("verifies pin_on_net and same_node assertions", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("U1", "$u1", "IC"), component("J1", "$j1", "CONN")],
      pinsByComponent: {
        $u1: [pinAt("1", "VIN", undefined, 10, 0)],
        $j1: [pinAt("1", "1", undefined, 30, 0)]
      },
      wires: [wirePath("VBUS", [[10, 0, 30, 0]])],
      includeRaw: false
    });

    const result = verifyConnections(snapshot, [
      { id: "vin-vbus", type: "pin_on_net", component: "U1", pinName: "VIN", net: "VBUS" },
      { id: "vin-j1", type: "same_node", left: { component: "U1", pinName: "VIN" }, right: { component: "J1", pin: "1" } }
    ]);

    expect(result.summary.passed).toBe(2);
    expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass"]);
  });

  it("verifies pull_to_net through a resistor", () => {
    const snapshot = buildSchematicSnapshot({
      components: [component("U5", "$u5", "TP4057"), component("R7", "$r7", "2kΩ"), netflagAt("GND", "$gnd", 30, 40)],
      pinsByComponent: {
        $u5: [pinAt("6", "PROG", undefined, 10, 0)],
        $r7: [pinAt("1", "1", undefined, 30, 0), pinAt("2", "2", undefined, 30, 40)]
      },
      wires: [
        wirePath(undefined, [[10, 0, 30, 0]]),
        wirePath("GND", [[30, 40, 40, 40]])
      ],
      includeRaw: false
    });

    const result = verifyConnections(snapshot, [
      { type: "pull_to_net", signal: { component: "U5", pinName: "PROG" }, net: "GND", through: { kind: "resistor" } },
      { type: "pull_to_net", signal: { component: "U5", pinName: "PROG" }, net: "VBUS", through: { kind: "resistor" } }
    ]);

    expect(result.checks[0]?.status).toBe("pass");
    expect(result.checks[0]?.evidence.path?.[0]?.viaComponent?.designator).toBe("R7");
    expect(result.checks[1]?.status).toBe("unknown");
  });

  it("verifies decoupling capacitors and forbidden paths", () => {
    const snapshot = buildSchematicSnapshot({
      components: [
        component("U1", "$u1", "IC"),
        component("C1", "$c1", "100nF"),
        netflagAt("GND", "$gnd", 50, 20)
      ],
      pinsByComponent: {
        $u1: [pinAt("1", "VCC", undefined, 10, 0)],
        $c1: [pinAt("1", "1", undefined, 30, 0), pinAt("2", "2", undefined, 30, 20)]
      },
      wires: [
        wirePath("3V3", [[10, 0, 30, 0]]),
        wirePath("GND", [[30, 20, 50, 20]])
      ],
      includeRaw: false
    });

    const result = verifyConnections(snapshot, [
      { type: "decoupled_to_net", power: { component: "U1", pinName: "VCC" }, referenceNet: "GND" },
      { type: "path_absent", from: { net: "3V3" }, to: { net: "GND" }, through: { kind: "resistor" } }
    ]);

    expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass"]);
    expect(result.checks[0]?.evidence.path?.[0]?.viaComponent?.designator).toBe("C1");
  });

  it("supports generic checks inspired by the TP4057 charger area", () => {
    const snapshot = buildSchematicSnapshot({
      components: [
        component("U5", "$u5", "TP4057"),
        component("R7", "$r7", "2kΩ"),
        component("C4", "$c4", "4.7uF"),
        component("R5", "$r5", "1kΩ"),
        component("LED1", "$led1", "RED")
      ],
      pinsByComponent: {
        $u5: [
          pinAt("4", "VCC", undefined, 0, 0),
          pinAt("3", "BAT", undefined, 0, 10),
          pinAt("6", "PROG", undefined, 0, 20),
          pinAt("1", "CHRG", undefined, 0, 30)
        ],
        $r7: [pinAt("1", "1", undefined, 30, 20), pinAt("2", "2", undefined, 30, 40)],
        $c4: [pinAt("1", "1", undefined, 20, 0), pinAt("2", "2", undefined, 20, 40)],
        $r5: [pinAt("1", "1", undefined, 30, 30), pinAt("2", "2", undefined, 50, 30)],
        $led1: [pinAt("1", "K", undefined, 50, 30), pinAt("2", "A", undefined, 50, 0)]
      },
      wires: [
        wirePath("VBUS", [[0, 0, 20, 0], [20, 0, 50, 0]]),
        wirePath("VBAT_LIPO", [[0, 10, 30, 10]]),
        wirePath(undefined, [[0, 20, 30, 20]]),
        wirePath("GND", [[20, 40, 30, 40]]),
        wirePath(undefined, [[0, 30, 30, 30]]),
        wirePath(undefined, [[50, 30, 50, 30]])
      ],
      includeRaw: false
    });

    const result = verifyConnections(snapshot, [
      { type: "pin_on_net", component: "U5", pinName: "VCC", net: "VBUS" },
      { type: "pin_on_net", component: "U5", pinName: "BAT", net: "VBAT_LIPO" },
      { type: "pull_to_net", signal: { component: "U5", pinName: "PROG" }, net: "GND", through: { kind: "resistor" } },
      { type: "path_exists", from: { component: "U5", pinName: "CHRG" }, to: { net: "VBUS" }, through: { kind: "led" }, maxHops: 3 },
      { type: "decoupled_to_net", power: { component: "U5", pinName: "VCC" }, referenceNet: "GND" }
    ]);

    expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
  });

  describe("EasyEDA Pro 3.x flat wire geometry", () => {
    const GND_WIRE_NET = "TIDA-01095_Sheet1-altium-import_GND_POWER_GROUND";

    it("chunks a flat [x1,y1,x2,y2,...] line into segments and propagates the wire net to touching pins", () => {
      const snapshot = buildSchematicSnapshot({ ...loadFixture("pro3-flat-wire.json"), includeRaw: false });

      const pinNet = (designator: string, pinNumber: string) =>
        snapshot.pins.find((item) => item.componentDesignator === designator && item.pinNumber === pinNumber);
      expect(pinNet("U1", "10")?.net).toBe(GND_WIRE_NET);
      expect(pinNet("U1", "10")?.netSource).toBe("wire_inferred");
      expect(pinNet("C1", "2")?.net).toBe(GND_WIRE_NET);
      expect(pinNet("R1", "2")?.net).toBe(GND_WIRE_NET);
      expect(pinNet("U1", "1")?.net).toBe("TIDA-01095_Sheet1-altium-import_VIN");
      expect(pinNet("C1", "1")?.net).toBe("TIDA-01095_Sheet1-altium-import_VIN");

      const gndWire = snapshot.wires.find((item) => item.primitiveId === "ie3223");
      expect(gndWire?.endpoints).toEqual(expect.arrayContaining([{ x: 190, y: -220 }, { x: 290, y: -250 }, { x: 130, y: -220 }]));
      expect(gndWire?.endpoints).toHaveLength(3);

      const unconnected = findUnconnectedPins(snapshot);
      expect(unconnected.pins.map((item) => `${item.componentDesignator}#${item.pinNumber}`).sort()).toEqual(["R1#1", "U1#3"]);
    });

    it("resolves pin_on_net and traceNet by the wire net name", () => {
      const snapshot = buildSchematicSnapshot({ ...loadFixture("pro3-flat-wire.json"), includeRaw: false });

      const result = verifyConnections(snapshot, [
        { type: "pin_on_net", component: "U1", pin: "10", net: GND_WIRE_NET },
        { type: "same_node", left: { component: "U1", pin: "10" }, right: { component: "R1", pin: "2" } }
      ]);
      expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass"]);

      const traced = traceNet(snapshot, GND_WIRE_NET);
      expect(traced.net?.name).toBe(GND_WIRE_NET);
      expect(traced.net?.connectedPins.map((item) => item.primitiveId).sort())
        .toEqual(["e1p10", "e2p2", "e3p2", "e4p1"]);
      expect(traced.findings).toHaveLength(0);
    });

    it("treats a value-only netflag touching the wire group (via its pin) as an alias of the wire net", () => {
      const snapshot = buildSchematicSnapshot({ ...loadFixture("pro3-flat-wire.json"), includeRaw: false });

      const flag = snapshot.labels.find((item) => item.primitiveId === "e4");
      expect(flag?.net).toBe("GND");
      expect(flag?.nodeId).toBe(snapshot.pins.find((item) => item.primitiveId === "e1p10")?.nodeId);

      const result = verifyConnections(snapshot, [
        { type: "pin_on_net", component: "U1", pin: "10", net: "GND" },
        { type: "decoupled_to_net", power: { component: "U1", pin: "1" }, referenceNet: "GND" }
      ]);
      expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass"]);

      const traced = traceNet(snapshot, "GND");
      expect(traced.net?.name).toBe("GND");
      expect(traced.net?.connectedPins.map((item) => item.primitiveId).sort()).toEqual(["e1p10", "e2p2", "e3p2", "e4p1"]);
    });

    it("reads an even-but-not-multiple-of-4 flat line as a polyline of points", () => {
      const snapshot = buildSchematicSnapshot({
        components: [component("U9", "$u9", "IC")],
        pinsByComponent: { $u9: [pinAt("1", "A", undefined, 40, 20)] },
        wires: [wirePath("POLY", [0, 0, 40, 0, 40, 20])],
        includeRaw: false
      });

      expect(snapshot.pins[0]?.net).toBe("POLY");
      expect(snapshot.wires[0]?.endpoints).toEqual([{ x: 0, y: 0 }, { x: 40, y: 20 }]);
    });
  });

  describe("multi-page schematics", () => {
    const load = () => buildSchematicSnapshot({ ...loadFixture("two-page.json"), includeRaw: false });
    const pinKey = (item: { componentDesignator?: string; pinNumber?: string }) => `${item.componentDesignator}#${item.pinNumber}`;

    it("tags every primitive with its page and keeps raw primitiveIds", () => {
      const snapshot = load();

      expect(snapshot.counts).toMatchObject({ pages: 2, components: 6, pins: 10, wires: 4 });
      expect(snapshot.components.filter((item) => item.primitiveId === "e2").map((item) => [item.designator, item.page?.name]))
        .toEqual([["R1", "Power"], ["C1", "IO"]]);
      expect([...snapshot.pins, ...snapshot.wires, ...snapshot.labels].every((item) => item.page?.uuid)).toBe(true);
      expect(snapshot.warnings.some((warning) => warning.includes("on page IO"))).toBe(true);
    });

    it("does not mix pins of components that share a primitiveId on different pages", () => {
      const snapshot = load();

      expect(getComponentPins(snapshot, "R1").pins.map(pinKey)).toEqual(["R1#1", "R1#2"]);
      expect(getComponentPins(snapshot, "C1").pins.map(pinKey)).toEqual(["C1#1", "C1#2"]);
    });

    it("never connects geometry across pages", () => {
      const snapshot = load();

      // U1#5 sits at (0,0) on page IO, where page Power has wire w1.
      expect(findUnconnectedPins(snapshot).pins.map(pinKey)).toEqual(["U1#5"]);
      const u1p1 = snapshot.pins.find((item) => item.primitiveId === "e1p1");
      const c1p2 = snapshot.pins.find((item) => item.primitiveId === "e2p2" && item.page?.uuid === "page-io");
      expect(u1p1?.nodeId).toContain("page-power");
      expect(c1p2?.nodeId).toContain("page-io");
      const result = verifyConnections(snapshot, [
        { type: "same_node", left: { component: "U1", pin: "1" }, right: { component: "C1", pin: "2" } },
        { type: "same_node", left: { component: "U1", pin: "1" }, right: { component: "R1", pin: "1" } }
      ]);
      expect(result.checks.map((check) => check.status)).toEqual(["fail", "pass"]);
    });

    it("merges a named net (GND netflag) across pages and resolves multi-part components by designator", () => {
      const snapshot = load();

      const gnd = traceNet(snapshot, "GND").net;
      expect(snapshot.nets.map((net) => net.name)).toEqual(["GND"]);
      expect(gnd?.nodeIds).toEqual(["net:GND"]);
      expect(gnd?.connectedPins.filter((item) => item.componentDesignator).map(pinKey).sort()).toEqual(["C1#1", "R1#2", "U1#2", "U1#6"]);

      expect(getComponentPins(snapshot, "U1").pins.map(pinKey)).toEqual(["U1#1", "U1#2", "U1#5", "U1#6"]);
      expect(traceComponent(snapshot, "U1").findings.map((finding) => finding.evidence.pinNumber)).toEqual(["5"]);
      const result = verifyConnections(snapshot, [
        { type: "pin_on_net", component: "U1", pin: "6", net: "GND" },
        { type: "same_node", left: { component: "U1", pin: "2" }, right: { component: "U1", pin: "6" } }
      ]);
      expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass"]);
    });
  });

  describe("imported netflag naming (symbol-name net + otherProperty.Value)", () => {
    const load = () => buildSchematicSnapshot({ ...loadFixture("imported-netflag-names.json"), includeRaw: false });
    const netOf = (snapshot: ReturnType<typeof load>, primitiveId: string) => snapshot.pins.find((item) => item.primitiveId === primitiveId)?.net;

    it("names pins by the netflag Value instead of the symbol-name string on flags and wires", () => {
      const snapshot = load();

      expect(netOf(snapshot, "e1p10")).toBe("GND");
      expect(netOf(snapshot, "e1p17")).toBe("GND");
      expect(snapshot.wires.find((item) => item.primitiveId === "w1")).toMatchObject({ net: "GND", sourceNet: "Sheet1-import_GND_POWER_GROUND" });
      expect(snapshot.nets.map((net) => net.name)).not.toContain("Sheet1-import_GND_POWER_GROUND");
      const result = verifyConnections(snapshot, [
        { type: "pin_on_net", component: "U1", pin: "10", net: "GND" },
        { type: "pin_on_net", component: "U1", pin: "17", net: "GND" },
        { type: "pin_on_net", component: "U1", pin: "10", net: "Sheet1-import_GND_POWER_GROUND" }
      ]);
      expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass", "pass"]);
      expect(traceNet(snapshot, "GND").net?.connectedPins.map((item) => item.primitiveId).sort()).toEqual(["e1p10", "e1p17", "f1p"]);
    });

    it("merges groups joined through a repeated flag and keeps the explicit wire name", () => {
      const snapshot = load();

      expect(netOf(snapshot, "e1p3")).toBe("SENSE_A");
      expect(netOf(snapshot, "e2p1")).toBe("SENSE_A");
      const result = verifyConnections(snapshot, [
        { type: "same_node", left: { component: "U1", pin: "3" }, right: { component: "R1", pin: "1" } },
        { type: "pin_on_net", component: "U1", pin: "3", net: "IO7" }
      ]);
      expect(result.checks.map((check) => check.status)).toEqual(["pass", "pass"]);
    });

    it("keeps native-style netflag nets (no Value, or net not a symbol name)", () => {
      const snapshot = load();

      expect(netOf(snapshot, "e2p2")).toBe("VCC");
      expect(snapshot.labels.find((item) => item.primitiveId === "f5")?.net).toBe("3V3");
      expect(snapshot.nets.map((net) => net.name)).not.toContain("3.3V");
    });
  });
});

function component(designator: string, primitiveId: string, value: string): Record<string, unknown> {
  return {
    primitiveType: "Component",
    componentType: "part",
    primitiveId,
    designator,
    value,
    x: 10,
    y: 20
  };
}

function netflag(net: string, primitiveId: string): Record<string, unknown> {
  return netflagAt(net, primitiveId, 0, 0);
}

function netflagAt(net: string, primitiveId: string, x: number, y: number): Record<string, unknown> {
  return {
    primitiveType: "Component",
    componentType: "netflag",
    primitiveId,
    net,
    x,
    y
  };
}

function pin(pinNumber: string, pinName: string, net: string | undefined): Record<string, unknown> {
  return pinAt(pinNumber, pinName, net, 30, 40);
}

function pinAt(pinNumber: string, pinName: string, net: string | undefined, x: number, y: number): Record<string, unknown> {
  return {
    primitiveId: `$pin-${pinNumber}`,
    pinNumber,
    pinName,
    net,
    x,
    y
  };
}

function wire(net: string): Record<string, unknown> {
  return wirePath(net, [[0, 0], [10, 10]]);
}

function wirePath(net: string | undefined, line: unknown[]): Record<string, unknown> {
  return {
    primitiveId: `$wire-${net}`,
    net,
    line
  };
}
