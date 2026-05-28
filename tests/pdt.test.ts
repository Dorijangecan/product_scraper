import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ManufacturerConfig, ProductResult, RunItemRecord } from "../src/shared/types.js";
import { targetSheets, deviceSheetsFor } from "../src/server/pdt/device-sheet-map.js";
import { hasPropertyResolver, resolveProperty, type ResolveContext } from "../src/server/pdt/eclass-resolvers.js";
import { describeSheet } from "../src/server/pdt/sheet-descriptor.js";
import { encodeEnum, isEnumColumn } from "../src/server/pdt/enum-encode.js";
import { writeDocumentsSheet } from "../src/server/pdt/documents-sheet.js";
import { buildPdtRepairMap, buildPdtRepairResult } from "../src/server/pdt/ai-cleanup.js";
import { exportRunPdt } from "../src/server/pdt/exporter.js";
import { normalizePdtCellNumber } from "../src/server/pdt/unit-cleanup.js";

const manufacturer = {
  id: "test",
  canonicalName: "ACME Corp",
  shortName: "ACM",
  rateLimitMs: 0,
  officialBaseUrls: ["https://acme.test"],
  fallbackSources: []
} as unknown as ManufacturerConfig;

function ctx(overrides: Partial<ProductResult>, catalogNumber = "CAT-1", deviceType?: string): ResolveContext {
  const result: ProductResult = {
    manufacturerId: "test",
    catalogNumber,
    status: "found",
    confidence: 0.9,
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    ...overrides
  };
  const item: RunItemRecord = {
    id: 1,
    runId: "run-1",
    rowIndex: 1,
    catalogNumber,
    status: "found",
    result,
    updatedAt: new Date().toISOString()
  };
  return { result, item, manufacturer, deviceType };
}

describe("device sheet map", () => {
  it("maps enclosure to cabinet tabs plus constant tabs", () => {
    expect(deviceSheetsFor("Enclosure")).toEqual(["cabinet", "cabinet.mechanical"]);
    const sheets = targetSheets("Enclosure");
    expect(sheets).toContain("Material Master Data");
    expect(sheets).toContain("Additional Documents");
    expect(sheets).toContain("cabinet");
    expect(sheets).toContain("cabinet.mechanical");
  });

  it("maps contactor and cable to their tabs", () => {
    expect(deviceSheetsFor("Contactor")).toEqual(["contactor a. fuses"]);
    expect(deviceSheetsFor("Cable")).toEqual(["cable"]);
  });

  it("returns only constant tabs for unmapped device types", () => {
    expect(deviceSheetsFor("Battery")).toEqual([]);
    expect(targetSheets("Battery")).toEqual(["Material Master Data", "Additional Documents"]);
    expect(targetSheets(undefined)).toEqual(["Material Master Data", "Additional Documents"]);
  });

  it("maps every device type to a tab that exists in the Master PDT template", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.resolve("templates", "master_pdt.xlsx"));
    const available = new Set(wb.worksheets.map((ws) => ws.name.trim().toLowerCase()));

    const sampleTypes = [
      "Enclosure",
      "Subpanel",
      "Rack Cabinet",
      "Module Carrier",
      "Loadcenter",
      "Wireway",
      "Mounting Accessory",
      "Contactor",
      "Fuse",
      "Relay",
      "Safety Relay",
      "Circuit Breaker",
      "Molded Case Circuit Breaker",
      "Miniature Circuit Breaker",
      "Residual Current Device",
      "Motor Circuit Breaker",
      "Motor Starter",
      "Disconnect Switch",
      "Switch",
      "Surge Protective Device",
      "Power Supply",
      "UPS",
      "Transformer",
      "Generator",
      "Motor",
      "Variable Speed Drive",
      "Soft Starter",
      "Motion Controller",
      "Current Sensor",
      "Filter",
      "Cable",
      "Cable Gland",
      "Connector",
      "Optical Connector",
      "Busbar",
      "Terminal Block",
      "Photoelectric Sensor",
      "Vision Sensor",
      "Inductive Proximity Sensor",
      "Capacitive Sensor",
      "Ultrasonic Sensor",
      "Magnetic Field Sensor",
      "RFID Device",
      "Encoder",
      "Safety Sensor",
      "Sensor",
      "Pressure Sensor",
      "Temperature Sensor",
      "Flow Sensor",
      "Level Sensor",
      "Programmable Logic Controller",
      "I/O Module",
      "HMI",
      "Pushbutton / Operator",
      "Pilot Light",
      "Stack Light / Beacon",
      "Luminaire",
      "Thermal Management",
      "Communication Gateway",
      "PCB Connector",
      "PCB Terminal Block",
      "Terminal Accessory",
      "Wire Marker",
      "Pump",
      "Directional Control Valve",
      "Valve",
      "Hydraulic Actuator",
      "Pneumatic Device"
    ];

    for (const deviceType of sampleTypes) {
      const sheets = deviceSheetsFor(deviceType);
      expect(sheets.length).toBeGreaterThan(0);
      for (const sheet of sheets) {
        expect(available.has(sheet.trim().toLowerCase())).toBe(true);
      }
    }
  });
});

describe("Master PDT mapping coverage", () => {
  it("has resolver coverage for the priority PDT tabs", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.resolve("templates", "master_pdt.xlsx"));

    for (const sheetName of ["Material Master Data", "Additional Documents", "contactor a. fuses"]) {
      if (sheetName === "Additional Documents") {
        expect(wb.getWorksheet(sheetName)).toBeTruthy();
        continue;
      }
      const descriptor = describeSheet(wb.getWorksheet(sheetName)!);
      expect(descriptor).toBeTruthy();
      const unmapped = descriptor!.columns
        .filter((column) => column.code !== "ECLASS property")
        .filter((column) => !hasPropertyResolver(column.code, column.propName))
        .map((column) => `${column.code} / ${column.propName}`);
      expect(unmapped).toEqual([]);
    }
  });
});

describe("eclass resolvers", () => {
  it("resolves manufacturer, article number and product url", () => {
    const c = ctx({ productUrl: "https://acme.test/p/CAT-1" });
    expect(resolveProperty("AAO677", "AAO677", c)).toBe("ACME Corp");
    expect(resolveProperty("AAO676", "CNSORDERNO", c)).toBe("CAT-1");
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://acme.test/p/CAT-1");
    expect(resolveProperty("MANUFACTURER_URL", "MANUFACTURER_URL", c)).toBe("https://acme.test");
  });

  it("fills both GTIN and EAN from the same barcode attribute", () => {
    const c = ctx({ attributes: [{ name: "EAN", value: "3471523024755", sourceType: "official" }] });
    expect(resolveProperty("AAO663", "AAO663", c)).toBe("3471523024755");
    expect(resolveProperty("AAN743", "CNS_EAN", c)).toBe("3471523024755");
  });

  it("fills URI, designation and descriptions from the product", () => {
    const c = ctx({
      productUrl: "https://acme.test/p/CAT-1",
      title: "Widget 9000",
      description: "A long product description.",
      attributes: [{ name: "Extended Product Type", value: "WDG-9000", sourceType: "official" }]
    });
    expect(resolveProperty("AAY811", "AAY811", c)).toBe("https://acme.test/p/CAT-1");
    expect(resolveProperty("AAW338", "AAW338", c)).toBe("WDG-9000");
    expect(resolveProperty("AAU734", "AAU734", c)).toBe("A long product description.");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("Widget 9000");
  });

  it("uses net dimensions and ignores packaging dimensions", () => {
    const c = ctx({
      attributes: [
        { name: "Product Net Width", value: "25 mm", sourceType: "official" },
        { name: "Package Level1 Width", value: "100 mm", sourceType: "official" },
        { name: "Product Net Height", value: "50 mm", sourceType: "official" },
        { name: "Product Net Depth / Length", value: "8 mm", sourceType: "official" }
      ]
    });
    expect(resolveProperty("BAF016", "BAF016", c)).toBe("25");
    expect(resolveProperty("BAA020", "BAA020", c)).toBe("50");
    expect(resolveProperty("BAB577", "BAB577", c)).toBe("8");
  });

  it("uses the manufacturer homepage for MANUFACTURER_URL, falling back to the base origin", () => {
    const withHome = ctx({});
    withHome.manufacturer = { ...manufacturer, homepageUrl: "https://global.acme.test/en" } as ManufacturerConfig;
    expect(resolveProperty("MANUFACTURER_URL", "MANUFACTURER_URL", withHome)).toBe("https://global.acme.test/en");
    // Without a homepage, fall back to the origin of the first official base URL.
    expect(resolveProperty("MANUFACTURER_URL", "MANUFACTURER_URL", ctx({}))).toBe("https://acme.test");
  });

  it("converts weight to kg and grams", () => {
    const c = ctx({ normalized: { weight: "2.5 kg" } });
    expect(resolveProperty("CNS_MASSEXACT", "CNS_MASSEXACT", c)).toBe("2.5");
    expect(resolveProperty("BAD875", "BAD875", c)).toBe("2500");
  });

  it("resolves device-tab values from normalized fields and attributes", () => {
    const c = ctx({
      normalized: { voltage: "230 V", color: "RAL 7035" },
      attributes: [{ name: "Customs tariff number", value: "85371098" }]
    });
    expect(resolveProperty("BAH005", "BAH005", c)).toBe("230 V");
    expect(resolveProperty("AAN521", "AAN521", c)).toBe("RAL 7035");
    expect(resolveProperty("CNS_CTN", "CNS_CTN", c)).toBe("85371098");
  });

  it("resolves the ABB-style Cn8 attribute as customs tariff and a distinct typecode", () => {
    const c = ctx({
      attributes: [
        { name: "Cn8", value: "85444290", sourceType: "official" },
        { name: "Extended Product Type", value: "TA522", sourceType: "official" },
        { name: "Product Type", value: "Accessory", sourceType: "official" }
      ]
    });
    expect(resolveProperty("CNS_CTN", "CNS_CTN", c)).toBe("85444290");
    // Typecode is the type designation, never the device category or the article number.
    expect(resolveProperty("CNSTYPECODE", "CNSTYPECODE", c)).toBe("TA522");
  });

  it("does not put the device category into the typecode column", () => {
    // Regression: a "Product Type" attribute holds the device category, which must NOT leak into
    // the typecode. Typecode falls back to the catalog number; the device category goes to AAO057.
    const c = ctx({ attributes: [{ name: "Product Type", value: "Enclosure", sourceType: "official" }] }, "CAT-1", "Enclosure");
    expect(resolveProperty("CNSTYPECODE", "CNSTYPECODE", c)).toBe("CAT-1");
    // Combined cell still resolves to the typecode because AAV774 is tried before AAO057.
    expect(resolveProperty("AAV774/AAO057", "CNSTYPECODE", c)).toBe("CAT-1");
    // Standalone ECLASS product-type column gets the classified device category.
    expect(resolveProperty("AAO057", "AAO057", c)).toBe("Enclosure");
  });

  it("fills ECLASS classification from the scraped ECLASS attribute", () => {
    const c = ctx({ attributes: [{ name: "ECLASS 11.0", value: "27-18-01-01", sourceType: "official" }] });
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", c)).toBe("27-18-01-01");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", c)).toBe("ECLASS-11.0");
  });

  it("uses the manual ABB contactor values on the contactor/fuses PDT tab", () => {
    const c = ctx(
      {
        manufacturerId: "abb",
        normalized: {
          voltage: "Main Circuit 690 V",
          current: "(415 V) 60 °C 40 A; (690 V) 60 °C 25 A"
        },
        attributes: [
          { name: "eClass", value: "V11.0 : 27371003", sourceType: "official" },
          { name: "Rated Control Circuit Voltage", value: "50 Hz 24 ... 60 V; 60 Hz 24 ... 60 V; DC Operation 20 ... 60 V" },
          { name: "Rated Operational Current AC-1", value: "(690 V) 40 °C 70 A; (690 V) 60 °C 60 A" },
          { name: "Number of Poles", value: "3P" }
        ]
      },
      "1SBL347060R1100"
    );
    c.sheetName = "contactor a. fuses";
    c.manufacturer = { ...manufacturer, id: "abb" } as ManufacturerConfig;

    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", c)).toBe("27371003");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", c)).toBe("14");
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://new.abb.com/products/ABB1SBL347060R1100");
    expect(resolveProperty("BAH005", "BAH005", c)).toBe("24-60");
    expect(resolveProperty("AAF726", "AAF726", c)).toBe("70");
    expect(resolveProperty("BAD915", "BAD915", c)).toBeUndefined();
    expect(resolveProperty("AAT080", "AAT080", c)).toBe("3");
  });

  it("writes AC/DC voltage type only when it is explicitly written in the source", () => {
    const c = ctx({
      attributes: [{ name: "Rated Control Circuit Voltage", value: "24 V AC/DC" }]
    });
    c.sheetName = "contactor a. fuses";
    expect(resolveProperty("BAD915", "BAD915", c)).toBe("AC/DC");
  });

  it("uses PDT repair values for descriptions and clean temperature fields", () => {
    const c = ctx(
      {
        title: "Raw title",
        description: "Raw long description",
        attributes: [{ name: "Rated Operational Current AC-1", value: "(690 V) 40 °C 70 A; (690 V) 60 °C 60 A" }]
      },
      "CAT-1"
    );
    c.repair = {
      catalogNumber: "CAT-1",
      shortDescription: "Clean short description",
      longDescription: "Clean long description",
      operatingTemperatureMin: "-25",
      operatingTemperatureMax: "60",
      controlVoltage: "24-60",
      ratedCurrent: "70",
      powerLossPerPole: "3",
      voltageType: "AC/DC"
    };

    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("Clean short description");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("Clean long description");
    expect(resolveProperty("AAC820", "AAC820", c)).toBe("-25");
    expect(resolveProperty("AAC821", "AAC821", c)).toBe("60");
  });

  it("splits temperature ranges written with celsius next to both numbers", () => {
    const c = ctx({ attributes: [{ name: "Operating temperature", value: "-40C do 80C" }] });
    expect(resolveProperty("AAC820", "AAC820", c)).toBe("-40");
    expect(resolveProperty("AAC821", "AAC821", c)).toBe("80");
  });

  it("uses ABB Amb Air Tem operating range before storage range", () => {
    const c = ctx({
      attributes: [
        {
          group: "ABB Environmental",
          name: "Amb Air Tem",
          value:
            "Close to Contactor Fitted with Thermal O/L Relay -40 ... 70 °C; Close to Contactor without Thermal O/L Relay -40 ... 70 °C; Close to Contactor for Storage -60 ... +80 °C",
          sourceType: "official"
        }
      ]
    });
    expect(resolveProperty("AAC820", "AAC820", c)).toBe("-40");
    expect(resolveProperty("AAC821", "AAC821", c)).toBe("70");
  });

  it("resolves broader ABB contactor/fuses properties when source data exists", () => {
    const c = ctx({
      attributes: [
        { group: "ABB Technical", name: "Rated Operational Voltage", value: "Main Circuit 690 V", sourceType: "official" },
        { group: "ABB Technical", name: "Rated Operational Current AC-1", value: "(690 V) 40 °C 70 A; (690 V) 60 °C 60 A", sourceType: "official" },
        { group: "ABB Technical", name: "Rated Operational Current AC-3", value: "(380 / 400 V) 60 °C 40 A; (220 / 230 / 240 V) 60 °C 40 A", sourceType: "official" },
        { group: "ABB Technical", name: "Rated Operational Power AC-3 (P e )", value: "(400 V) 18.5 kW; (220 / 230 / 240 V) 11 kW", sourceType: "official" },
        { group: "ABB Technical UL/CSA", name: "Horse Power Rating Nema", value: "(460 V AC) Three Phase 25 Hp; (575 V AC) Three Phase 25 Hp", sourceType: "official" },
        { group: "ABB Technical", name: "Degree of Protection", value: "Coil Terminals IP20; Main Terminals IP10", sourceType: "official" },
        { group: "ABB Technical", name: "Mounting on DIN Rail", value: "TH35-7.5 (35 x 7.5 mm Mounting Rail)", sourceType: "official" },
        { group: "ABB Technical", name: "Terminal Type", value: "Ring-Tongue Terminals", sourceType: "official" },
        { group: "ABB Technical", name: "Coil Consumption", value: "Average Holding Value 50 / 60 Hz 4 V·A; Average Holding Value DC 2 W", sourceType: "official" },
        { group: "ABB Technical", name: "Rated Control Circuit Voltage", value: "50 Hz 48 ... 130 V; 60 Hz 48 ... 130 V; DC Operation 48 ... 130 V", sourceType: "official" },
        { group: "ABB Material Compliance", name: "RoHS Declaration", value: "2CMT2021-006277", sourceType: "official" },
        { group: "ABB Technical", name: "Standards", value: "IEC/EN 60947-1, IEC/EN 60947-4-1", sourceType: "official" }
      ]
    });
    c.sheetName = "contactor a. fuses";

    expect(resolveProperty("AAB821", "AAB821", c)).toBe("70");
    expect(resolveProperty("AAC824", "AAC824", c)).toBe("70");
    expect(resolveProperty("AAF583", "AAF583", c)).toBe("690");
    expect(resolveProperty("BAG975", "BAG975", c)).toBe("IP20");
    expect(resolveProperty("AAB456", "AAB456", c)).toBe("18.5");
    expect(resolveProperty("AAB460", "AAB460", c)).toBe("70");
    expect(resolveProperty("AAB667", "AAB667", c)).toBe("Yes");
    expect(resolveProperty("BAC378", "BAC378", c)).toBe("Ring cable connection");
    expect(resolveProperty("BAA303", "BAA303", c)).toBe("2");
    expect(resolveProperty("AAB958", "AAB958", c)).toBe("48");
    expect(resolveProperty("AAB959", "AAB959", c)).toBe("48");
    expect(resolveProperty("BAC050", "BAC050", c)).toBe("AC/DC");
    expect(resolveProperty("AAN354", "AAN354", c)).toBe("Yes");
    expect(resolveProperty("AAB476", "AAB476", c)).toBe("40");
    expect(resolveProperty("AAS566", "AAS566", c)).toBe("18.64");
    expect(resolveProperty("AAS567", "AAS567", c)).toBe("18.64");
    expect(resolveProperty("AAB455", "AAB455", c)).toBe("11");
    expect(resolveProperty("AAP798", "AAP798", c)).toContain("IEC/EN 60947-1");
  });

  it("fills safe numeric device fields (power loss, poles, standards)", () => {
    const c = ctx({
      attributes: [
        { name: "Power Loss", value: "at Rated Operating Conditions per Pole 19 W", sourceType: "official" },
        { name: "Number of Poles", value: "3P", sourceType: "official" },
        { name: "Standards", value: "IEC 60947-3", sourceType: "official" }
      ]
    });
    expect(resolveProperty("AAS575", "AAS575", c)).toBe("19");
    expect(resolveProperty("AAT080", "AAT080", c)).toBe("3");
    expect(resolveProperty("AAP798", "AAP798", c)).toBe("IEC 60947-3");
  });

  it("maps short-time withstand current (Icw) and rated operational voltage", () => {
    const c = ctx({
      attributes: [
        { name: "Rated Short-time Withstand Current", value: "for 1 s 50 kA", sourceType: "official" },
        { name: "Rated Operational Voltage", value: "Main Circuit 60-80 V", sourceType: "official" }
      ]
    });
    expect(resolveProperty("AAB492", "AAB492", c)).toBe("50");
    expect(resolveProperty("AAB815", "AAB815", c)).toBe("80");
  });

  it("normalizes mixed current units to amperes", () => {
    const c = ctx({
      attributes: [{ name: "Rated Current", value: "Control output 500 mA; Main output 2 A; peak 0.003 kA", sourceType: "official" }]
    });
    expect(resolveProperty("AAF726", "AAF726", c)).toBe("3");
  });

  it("splits an operating temperature range into min and max", () => {
    const c = ctx({ attributes: [{ name: "Operating temperature", value: "-25...+60 °C" }] });
    expect(resolveProperty("AAC820", "AAC820", c)).toBe("-25");
    expect(resolveProperty("AAC821", "AAC821", c)).toBe("60");
  });
});

describe("PDT unit cleanup", () => {
  it("converts derived electrical units into the target PDT unit", () => {
    expect(normalizePdtCellNumber("0.08 kV", "V")).toBe("80");
    expect(normalizePdtCellNumber("500 mA; 2 A; 0.003 kA", "A")).toBe("3");
    expect(normalizePdtCellNumber("0.05 kA", "A")).toBe("50");
  });

  it("converts length and mass units into the target PDT unit", () => {
    expect(normalizePdtCellNumber("1.2 m", "mm")).toBe("1200");
    expect(normalizePdtCellNumber("2.5 kg", "g")).toBe("2500");
  });
});

describe("PDT Qwen cleanup guardrails", () => {
  it("normalizes ABB short descriptions and records why temperature stayed blank", async () => {
    const c = ctx(
      {
        manufacturerId: "abb",
        title: "AF40B-30-00RT-13",
        description: "Long text",
        attributes: [
          { name: "Catalog Description", value: "AF40B-30-00RT-13 100RT-250V50/60HZ-DC Contactor", sourceType: "official" },
          { name: "Rated Operational Current AC-1", value: "(690 V) 40 °C 70 A; (690 V) 60 °C 60 A", sourceType: "official" }
        ]
      },
      "1SBL347060R1300"
    );

    const result = await buildPdtRepairResult([c.item], { ...manufacturer, id: "abb" } as ManufacturerConfig);
    const repair = result.repairs.get(c.item.id);
    expect(repair?.shortDescription).toBe("AF40B-30-00RT-13 100-250 V 50/60 Hz DC Contactor");
    expect(repair?.operatingTemperatureMin).toBeUndefined();
    expect(result.audit.products[0].notes.join(" ")).toContain("Temperature left blank");
  });

  it("prepares max voltage, max current, and temperature bounds for the scraped Excel sheet", async () => {
    const c = ctx(
      {
        manufacturerId: "abb",
        title: "AF40B contactor",
        description: "Vendor long description",
        normalized: { voltage: "60-80V", current: "6-10 A" },
        attributes: [
          { name: "Operating temperature", value: "40 to 120 C", sourceType: "official" },
          { name: "Rated current", value: "6-10 A", sourceType: "official" },
          { name: "Catalog Description", value: "AF40B contactor 60-80V", sourceType: "official" }
        ]
      },
      "CAT-1"
    );

    const result = await buildPdtRepairResult([c.item], { ...manufacturer, id: "abb" } as ManufacturerConfig);
    const repair = result.repairs.get(c.item.id);
    expect(repair?.voltageMax).toBe("80");
    expect(repair?.currentMax).toBe("10");
    expect(repair?.operatingTemperatureMin).toBe("40");
    expect(repair?.operatingTemperatureMax).toBe("120");
    expect(repair?.shortDescription).toBe("AF40B contactor 60-80V");
    expect(repair?.longDescription).toBe("Vendor long description");
  });

  it("does not treat duration text as a temperature maximum", async () => {
    const c = ctx(
      {
        manufacturerId: "balluff",
        title: "LF RFID tag",
        description: "Storage temperature temporary: 120 °C 1x700 h; Ambient temperature: -30...70 °C",
        attributes: [
          { name: "Storage temperature temporary", value: "120 °C 1x700 h", sourceType: "official" },
          { name: "Ambient temperature", value: "-30...70 °C", sourceType: "official" }
        ]
      },
      "BIS0004"
    );

    const result = await buildPdtRepairResult([c.item], manufacturer);
    const repair = result.repairs.get(c.item.id);
    expect(repair?.operatingTemperatureMin).toBe("-30");
    expect(repair?.operatingTemperatureMax).toBe("70");
  });

  it("does not accept generated lifetime values as current max", async () => {
    const c = ctx(
      {
        manufacturerId: "balluff",
        title: "Absolute encoder",
        normalized: { current: "1000 A" },
        attributes: [
          {
            group: "Final Field Repair",
            name: "Current",
            value: "1000 a",
            sourceType: "generated",
            parser: "final-field-repair"
          },
          { group: "PDF datasheet - Electrical data", name: "Operating voltage Ub", value: "4,75 ... 32 VDC", sourceType: "generated" }
        ]
      },
      "BDG FB058-BCR6-DSRB2-1417-0000-S8R1"
    );

    const result = await buildPdtRepairResult([c.item], manufacturer);
    const repair = result.repairs.get(c.item.id);
    expect(repair?.currentMax).toBeUndefined();
    expect(repair?.voltageMax).toBe("32");
  });

  it("rejects plausible-looking AI values that are not supported by the scraped evidence", async () => {
    const originalFetch = globalThis.fetch;
    const originalAiCleanup = process.env.PDT_AI_CLEANUP;
    const originalOllamaHost = process.env.OLLAMA_HOST;
    process.env.PDT_AI_CLEANUP = "1";
    process.env.OLLAMA_HOST = "http://ollama.test";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen3:4b" }] }), { status: 200 });
      }
      if (url.endsWith("/api/generate")) {
        return new Response(
          JSON.stringify({
            response: JSON.stringify({
              products: [
                {
                  catalogNumber: "1SBL347060R1100",
                  controlVoltage: "40-60",
                  ratedCurrent: "999",
                  powerLossPerPole: "99",
                  operatingTemperatureMin: "40",
                  operatingTemperatureMax: "60",
                  shortDescription: "Imaginary contactor with invented features",
                  longDescription: "This product has invented features not present in the source."
                }
              ]
            })
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    try {
      const c = ctx(
        {
          manufacturerId: "abb",
          title: "AF40B-30-00RT-11",
          description: "Vendor long description with a wide control voltage range (24-60 V 50/60 Hz and 20-60 V DC).",
          attributes: [
            { name: "eClass", value: "V11.0 : 27371003", sourceType: "official" },
            { name: "Catalog Description", value: "AF40B-30-00RT-11 24-60V50/60HZ 20-60VDC Contactor", sourceType: "official" },
            { name: "Rated Control Circuit Voltage", value: "50 Hz 24 ... 60 V; DC Operation 20 ... 60 V", sourceType: "official" },
            { name: "Rated Operational Current AC-1", value: "(690 V) 40 °C 70 A; (690 V) 60 °C 60 A", sourceType: "official" },
            { name: "Power Loss", value: "at Rated Operating Conditions AC-1 per Pole 3 W", sourceType: "official" }
          ]
        },
        "1SBL347060R1100"
      );
      const repairs = await buildPdtRepairMap([c.item], { ...manufacturer, id: "abb" } as ManufacturerConfig);
      const repair = repairs.get(c.item.id);

      expect(repair?.controlVoltage).toBe("24-60");
      expect(repair?.ratedCurrent).toBe("70");
      expect(repair?.powerLossPerPole).toBe("3");
      expect(repair?.operatingTemperatureMin).toBeUndefined();
      expect(repair?.operatingTemperatureMax).toBeUndefined();
      expect(repair?.shortDescription).toBe("AF40B-30-00RT-11 24-60 V 50/60 Hz 20-60 V DC Contactor");
      expect(repair?.longDescription).toBe("Vendor long description with a wide control voltage range (24-60 V 50/60 Hz and 20-60 V DC).");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAiCleanup === undefined) delete process.env.PDT_AI_CLEANUP;
      else process.env.PDT_AI_CLEANUP = originalAiCleanup;
      if (originalOllamaHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = originalOllamaHost;
    }
  });

  it("accepts AI cleanup values when they are backed by explicit evidence", async () => {
    const originalFetch = globalThis.fetch;
    const originalAiCleanup = process.env.PDT_AI_CLEANUP;
    const originalOllamaHost = process.env.OLLAMA_HOST;
    process.env.PDT_AI_CLEANUP = "1";
    process.env.OLLAMA_HOST = "http://ollama.test";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen3:4b" }] }), { status: 200 });
      }
      if (url.endsWith("/api/generate")) {
        return new Response(
          JSON.stringify({
            response: JSON.stringify({
              products: [
                {
                  catalogNumber: "1SBL347060R1100",
                  controlVoltage: "24-60",
                  ratedCurrent: "70",
                  powerLossPerPole: "3",
                  operatingTemperatureMin: "-25",
                  operatingTemperatureMax: "60",
                  shortDescription: "AF40B-30-00RT-11 contactor",
                  longDescription: "AF40B-30-00RT-11 contactor for motor control"
                }
              ]
            })
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    try {
      const c = ctx(
        {
          manufacturerId: "abb",
          title: "AF40B-30-00RT-11 contactor",
          description: "AF40B-30-00RT-11 contactor for motor control",
          attributes: [
            { name: "eClass", value: "V11.0 : 27371003", sourceType: "official" },
            { name: "Rated Control Circuit Voltage", value: "50 Hz 24 ... 60 V; DC Operation 20 ... 60 V", sourceType: "official" },
            { name: "Rated Operational Current AC-1", value: "(690 V) 40 °C 70 A; (690 V) 60 °C 60 A", sourceType: "official" },
            { name: "Power Loss", value: "at Rated Operating Conditions AC-1 per Pole 3 W", sourceType: "official" },
            { name: "Operating temperature", value: "-25 ... +60 °C", sourceType: "official" }
          ]
        },
        "1SBL347060R1100"
      );
      const repairs = await buildPdtRepairMap([c.item], { ...manufacturer, id: "abb" } as ManufacturerConfig);
      const repair = repairs.get(c.item.id);

      expect(repair?.controlVoltage).toBe("24-60");
      expect(repair?.ratedCurrent).toBe("70");
      expect(repair?.powerLossPerPole).toBe("3");
      expect(repair?.operatingTemperatureMin).toBe("-25");
      expect(repair?.operatingTemperatureMax).toBe("60");
      expect(repair?.shortDescription).toBe("AF40B-30-00RT-11 contactor");
      expect(repair?.longDescription).toBe("AF40B-30-00RT-11 contactor for motor control");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAiCleanup === undefined) delete process.env.PDT_AI_CLEANUP;
      else process.env.PDT_AI_CLEANUP = originalAiCleanup;
      if (originalOllamaHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = originalOllamaHost;
    }
  });
});

describe("enum encoding", () => {
  const voltageType = "Voltage type 1 - AC 2 - AC, alternating current 3 - AC/DC 4 - DC 5 - DC, direct current";

  it("encodes a scraped value to its enum code", () => {
    expect(encodeEnum(voltageType, "AC")).toBe("1");
    expect(encodeEnum(voltageType, "DC")).toBe("4");
    expect(isEnumColumn(voltageType)).toBe(true);
  });

  it("returns undefined when no enum option matches (so the cell stays blank)", () => {
    const ip = "degree of protection 1 - IP65/IP67 2 - IP54 3 - IP20";
    expect(encodeEnum(ip, "Front IP00")).toBeUndefined();
  });

  it("treats free-text columns (insert number or name) as non-enum", () => {
    const material = "Material (insert number or the name of the material) 1 - Plastic 2 - GRP 3 - PVC";
    expect(isEnumColumn(material)).toBe(false);
    expect(encodeEnum(material, "Steel")).toBeUndefined();
  });
});

describe("sheet descriptor", () => {
  it("detects property/body rows and columns in a device-tab layout", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("cabinet");
    ws.getCell(1, 1).value = "ClassId";
    ws.getCell(2, 1).value = "Priority";
    ws.getCell(3, 1).value = "Type";
    ws.getCell(4, 1).value = "PropertyId";
    ws.getCell(4, 2).value = "AAO676";
    ws.getCell(4, 3).value = "BAH005";
    ws.getCell(5, 1).value = "PropertyName";
    ws.getCell(5, 2).value = "AAO676";
    ws.getCell(5, 3).value = "BAH005";
    ws.getCell(6, 1).value = "Description";
    ws.getCell(7, 1).value = "Unit";
    ws.getCell(8, 1).value = "Body";

    const descriptor = describeSheet(ws);
    expect(descriptor).toBeDefined();
    expect(descriptor!.propertyRow).toBe(4);
    expect(descriptor!.propertyNameRow).toBe(5);
    expect(descriptor!.firstBodyRow).toBe(8);
    expect(descriptor!.columns.map((col) => col.code)).toEqual(["AAO676", "BAH005"]);
  });

  it("detects Material Master Data layout where body follows the units row", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Material Master Data");
    ws.getCell(6, 1).value = "ECLASS property";
    ws.getCell(6, 2).value = "AAO677";
    ws.getCell(7, 1).value = "Variable name (CNS internal)";
    ws.getCell(7, 2).value = "Only Classification";
    ws.getCell(8, 1).value = "English variable description";
    ws.getCell(9, 1).value = "Units";

    const descriptor = describeSheet(ws);
    expect(descriptor).toBeDefined();
    expect(descriptor!.propertyRow).toBe(6);
    expect(descriptor!.propertyNameRow).toBe(7);
    expect(descriptor!.firstBodyRow).toBe(10);
  });
});

describe("PDT exporter", () => {
  it("writes EAN and GTIN barcode columns as text values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "AAO677";
    material.getCell(7, 2).value = "Only Classification";
    material.getCell(8, 2).value = "Manufacturer name";
    material.getCell(6, 3).value = "AAO676";
    material.getCell(7, 3).value = "CNSORDERNO";
    material.getCell(8, 3).value = "Articlenumber";
    material.getCell(6, 4).value = "AAO663";
    material.getCell(7, 4).value = "AAO663";
    material.getCell(8, 4).value = "GTIN";
    material.getCell(6, 5).value = "AAN743";
    material.getCell(7, 5).value = "CNS_EAN";
    material.getCell(8, 5).value = "EAN";
    material.getCell(6, 6).value = "AAD931";
    material.getCell(7, 6).value = "CNS_CTN";
    material.getCell(8, 6).value = "Customs tariff number";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx({
      attributes: [
        { name: "EAN", value: "3471523024755", sourceType: "official" },
        { name: "Customs tariff number", value: "85364900", sourceType: "official" }
      ]
    }, "1SBL347060R1100").item;
    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(10, 3).value).toBe("1SBL347060R1100");
    expect(ws.getCell(10, 4).value).toBe("3471523024755");
    expect(ws.getCell(10, 5).value).toBe("3471523024755");
    expect(ws.getCell(10, 6).value).toBe("85364900");
    expect(result.cleanedInputPath).toBe(path.join(dir, "out_cleaned-input.xlsx"));
    await expect(fs.stat(result.cleanedInputPath!)).resolves.toBeTruthy();
    const cleaned = new ExcelJS.Workbook();
    await cleaned.xlsx.readFile(result.cleanedInputPath!);
    expect(cleaned.getWorksheet("Cleaned PDT Input")).toBeTruthy();
  });

  it("surfaces device type, confidence, tabs and evidence in the Cleaned PDT Input audit sheet", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-audit-classification-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "AAO676";
    material.getCell(7, 2).value = "CNSORDERNO";
    material.getCell(8, 2).value = "Articlenumber";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "AF40B Contactor",
        attributes: [{ group: "General", name: "Product Type", value: "Contactor", sourceType: "official" }]
      },
      "1SBL347060R1100"
    ).item;
    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const cleaned = new ExcelJS.Workbook();
    await cleaned.xlsx.readFile(result.cleanedInputPath!);
    const auditSheet = cleaned.getWorksheet("Cleaned PDT Input")!;

    // Find the header row (skip the meta block) and locate the new columns.
    let headerRow = -1;
    for (let r = 1; r <= 30; r += 1) {
      if (String(auditSheet.getCell(r, 1).value ?? "").trim() === "Catalog number") {
        headerRow = r;
        break;
      }
    }
    expect(headerRow).toBeGreaterThan(0);
    const headers = (auditSheet.getRow(headerRow).values as unknown[]).map((value) => String(value ?? ""));
    const deviceCol = headers.indexOf("Device type");
    const confCol = headers.indexOf("Device type confidence");
    const tabsCol = headers.indexOf("Device tab(s)");
    const evidenceCol = headers.indexOf("Device type evidence");
    expect(deviceCol).toBeGreaterThan(0);
    expect(confCol).toBeGreaterThan(0);
    expect(tabsCol).toBeGreaterThan(0);
    expect(evidenceCol).toBeGreaterThan(0);

    const dataRow = auditSheet.getRow(headerRow + 1);
    expect(dataRow.getCell(deviceCol).value).toBe("Contactor");
    expect(Number(dataRow.getCell(confCol).value)).toBeGreaterThanOrEqual(0.78);
    expect(String(dataRow.getCell(tabsCol).value)).toContain("contactor a. fuses");
    expect(String(dataRow.getCell(evidenceCol).value)).toMatch(/Product Type:/);
  });

  it("writes numeric PDT cells in the sheet unit and leaves the unit in the header row", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-units-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "AAO676";
    material.getCell(7, 2).value = "CNSORDERNO";
    material.getCell(6, 3).value = "AAB815";
    material.getCell(7, 3).value = "AAB815";
    material.getCell(9, 3).value = "V";
    material.getCell(6, 4).value = "AAF726";
    material.getCell(7, 4).value = "AAF726";
    material.getCell(9, 4).value = "A";
    material.getCell(6, 5).value = "AAC820";
    material.getCell(7, 5).value = "AAC820";
    material.getCell(9, 5).value = "C";
    material.getCell(6, 6).value = "AAC821";
    material.getCell(7, 6).value = "AAC821";
    material.getCell(9, 6).value = "C";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        attributes: [
          { name: "Rated Operational Voltage", value: "60-80 V", sourceType: "official" },
          { name: "Rated Current", value: "500 mA; 2 A; 0.003 kA", sourceType: "official" },
          { name: "Operating temperature", value: "-40C do 80C", sourceType: "official" }
        ]
      },
      "UNIT-1"
    ).item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(9, 3).value).toBe("V");
    expect(ws.getCell(10, 3).value).toBe(80);
    expect(ws.getCell(10, 4).value).toBe(3);
    expect(ws.getCell(10, 5).value).toBe(-40);
    expect(ws.getCell(10, 6).value).toBe(80);
  });

  it("writes German descriptions without relying on Excel TRANSLATE formulas", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-translate-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(2, 2).value = "Description DE";
    material.getCell(2, 3).value = "Description DE";
    material.getCell(2, 4).value = "Description EN";
    material.getCell(2, 5).value = "Description EN";
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "CNS_DESCRIPTION_LONG / AAU734";
    material.getCell(7, 2).value = "CNS_DESCRIPTION_LONG";
    material.getCell(8, 2).value = "Product description long";
    material.getCell(6, 3).value = "CNS_DESCRIPTION_SHORT";
    material.getCell(7, 3).value = "CNS_DESCRIPTION_SHORT";
    material.getCell(8, 3).value = "Product description short";
    material.getCell(6, 4).value = "CNS_DESCRIPTION_LONG / AAU734";
    material.getCell(7, 4).value = "CNS_DESCRIPTION_LONG";
    material.getCell(8, 4).value = "Product description long";
    material.getCell(6, 5).value = "CNS_DESCRIPTION_SHORT";
    material.getCell(7, 5).value = "CNS_DESCRIPTION_SHORT";
    material.getCell(8, 5).value = "Product description short";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Enclosure",
        description: "Wall mounted enclosure"
      },
      "DESC-1"
    ).item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(10, 2).value).toBe("Wandmontiertes Gehäuse");
    expect(ws.getCell(10, 3).value).toBe("Gehäuse");
    expect(ws.getCell(10, 4).value).toBe("Wall mounted enclosure");
    expect(ws.getCell(10, 5).value).toBe("Enclosure");
  });

  it("translates ABB AF contactor descriptions as full German technical text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-abb-de-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(2, 2).value = "Description DE";
    material.getCell(2, 3).value = "Description EN";
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "CNS_DESCRIPTION_LONG / AAU734";
    material.getCell(7, 2).value = "CNS_DESCRIPTION_LONG";
    material.getCell(8, 2).value = "Product description long";
    material.getCell(6, 3).value = "CNS_DESCRIPTION_LONG / AAU734";
    material.getCell(7, 3).value = "CNS_DESCRIPTION_LONG";
    material.getCell(8, 3).value = "Product description long";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const description =
      "The AF40B-30-00RT-12 is a 3 pole - 690 V IEC or 600 UL contactor with RT terminals, controlling motors up to 18.5 kW / 400 V AC (AC-3) or 30 hp / 480 V UL and switching power circuits up to 70 A (AC-1) or 60 A UL general use. Thanks to the AF technology, the contactor has a wide control voltage range (48-130 V 50/60 Hz and DC), managing large control voltage variations, reducing panel energy consumptions and ensuring distinct operations in unstable networks. Furthermore, surge protection is built-in, offering a compact solution. AF contactors have a block type design, can be easily extended with add-on auxiliary contact blocks and an additional wide range of accessories.";
    const item = ctx({ description }, "AF40B-30-00RT-12").item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    const german = String(ws.getCell(10, 2).value);
    expect(german).toContain("Der AF40B-30-00RT-12 ist ein 3-poliger Schütz");
    expect(german).toContain("RT-Anschlüssen");
    expect(german).toContain("Dank AF-Technologie");
    expect(german).toContain("AF-Schütze sind in Blockbauweise ausgeführt");
    expect(german).not.toMatch(/\b(controlling motors|with RT terminals|Thanks to|switching power circuits|wide control voltage range)\b/i);
    expect(ws.getCell(10, 3).value).toBe(description);
  });

  it("fills contactor voltage type and operating temperature columns found by description", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-desc-fallback-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const contactor = wb.addWorksheet("contactor a. fuses");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      contactor.getCell(row + 1, 1).value = label;
    }
    contactor.getCell(4, 2).value = "UNKNOWN_VOLTAGE_TYPE";
    contactor.getCell(5, 2).value = "UNKNOWN_VOLTAGE_TYPE";
    contactor.getCell(6, 2).value = "Voltage type 1 - AC 2 - AC, alternating current 3 - AC/DC 4 - DC";
    contactor.getCell(4, 3).value = "UNKNOWN_TEMP_MIN";
    contactor.getCell(5, 3).value = "UNKNOWN_TEMP_MIN";
    contactor.getCell(6, 3).value = "Min operating temperature";
    contactor.getCell(7, 3).value = "C";
    contactor.getCell(4, 4).value = "UNKNOWN_TEMP_MAX";
    contactor.getCell(5, 4).value = "UNKNOWN_TEMP_MAX";
    contactor.getCell(6, 4).value = "Max operating temperature";
    contactor.getCell(7, 4).value = "C";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        manufacturerId: "abb",
        title: "AF40B Contactor",
        attributes: [
          { name: "Rated Control Circuit Voltage", value: "AC/DC 24-60 V", sourceType: "official" },
          {
            group: "ABB Environmental",
            name: "Amb Air Tem",
            value:
              "Close to Contactor Fitted with Thermal O/L Relay -40 ... 70 °C; Close to Contactor without Thermal O/L Relay -40 ... 70 °C; Close to Contactor for Storage -60 ... +80 °C",
            sourceType: "official"
          }
        ]
      },
      "1SBL347060R1100"
    ).item;
    await exportRunPdt({ manufacturer: { ...manufacturer, id: "abb" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("contactor a. fuses")!;
    expect(ws.getCell(8, 1).value).toBe("AC/DC");
    expect(ws.getCell(8, 2).value).toBe(-40);
    expect(ws.getCell(8, 3).value).toBe(70);
  });

  it("writes broader contactor/fuses fields when ABB source data is available", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-contactor-wide-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const contactor = wb.addWorksheet("contactor a. fuses");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      contactor.getCell(row + 1, 1).value = label;
    }
    const columns = [
      ["AAB821", "Max. rated operating current", "A"],
      ["AAC824", "Nominal current", "-"],
      ["AAF583", "Nominal voltage", "-"],
      ["BAG975", "degree of protection 1 - IP10 2 - IP20", "-"],
      ["AAB456", "Rated operating power with AC-3, 400V", "kW"],
      ["AAT080", "Pole number", "-"],
      ["AAB667", "suitable for mounting onto standard rails 1 - No 2 - Yes", "-"],
      ["BAC378", "Connection type 12 - Ring cable connection 13 - Screw connection", "-"],
      ["BAA303", "Power loss, static, current-independent [Pls]", "W"],
      ["AAB958", "min. rated control voltage Us with AC 50 Hz", "V"],
      ["BAC050", "Type of actuation 1 - AC 2 - AC/DC 3 - DC", "-"],
      ["AAN354", "material declaration 1 - No 2 - Yes", "-"],
      ["AAB476", "Rated operating current Ie with AC-3, 400 V", "A"],
      ["AAS566", "Rated power, 460 V, 60 Hz, 3-phase", "kW"],
      ["AAS567", "Rated power, 575 V, 60 Hz, 3-phase", "kW"],
      ["AAB455", "Rated operating power with AC-3, 230 V", "kW"]
    ] as const;
    for (const [index, [code, description, unit]] of columns.entries()) {
      const col = index + 2;
      contactor.getCell(4, col).value = code;
      contactor.getCell(5, col).value = code;
      contactor.getCell(6, col).value = description;
      contactor.getCell(7, col).value = unit;
    }
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        manufacturerId: "abb",
        title: "AF40B Contactor",
        attributes: [
          { group: "ABB Technical", name: "Rated Operational Voltage", value: "Main Circuit 690 V", sourceType: "official" },
          { group: "ABB Technical", name: "Rated Operational Current AC-1", value: "(690 V) 40 °C 70 A; (690 V) 60 °C 60 A", sourceType: "official" },
          { group: "ABB Technical", name: "Rated Operational Current AC-3", value: "(380 / 400 V) 60 °C 40 A; (220 / 230 / 240 V) 60 °C 40 A", sourceType: "official" },
          { group: "ABB Technical", name: "Rated Operational Power AC-3 (P e )", value: "(400 V) 18.5 kW; (220 / 230 / 240 V) 11 kW", sourceType: "official" },
          { group: "ABB Technical UL/CSA", name: "Horse Power Rating Nema", value: "(460 V AC) Three Phase 25 Hp; (575 V AC) Three Phase 25 Hp", sourceType: "official" },
          { group: "ABB Technical", name: "Number of Poles", value: "3P", sourceType: "official" },
          { group: "ABB Technical", name: "Degree of Protection", value: "Coil Terminals IP20; Main Terminals IP10", sourceType: "official" },
          { group: "ABB Technical", name: "Mounting on DIN Rail", value: "TH35-7.5 (35 x 7.5 mm Mounting Rail)", sourceType: "official" },
          { group: "ABB Technical", name: "Terminal Type", value: "Ring-Tongue Terminals", sourceType: "official" },
          { group: "ABB Technical", name: "Coil Consumption", value: "Average Holding Value 50 / 60 Hz 4 V·A; Average Holding Value DC 2 W", sourceType: "official" },
          { group: "ABB Technical", name: "Rated Control Circuit Voltage", value: "50 Hz 48 ... 130 V; 60 Hz 48 ... 130 V; DC Operation 48 ... 130 V", sourceType: "official" },
          { group: "ABB Material Compliance", name: "RoHS Declaration", value: "2CMT2021-006277", sourceType: "official" }
        ]
      },
      "1SBL347060R1200"
    ).item;
    await exportRunPdt({ manufacturer: { ...manufacturer, id: "abb" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("contactor a. fuses")!;
    expect(ws.getRow(8).values).toEqual([
      ,
      70,
      70,
      690,
      "IP20",
      18.5,
      3,
      "Yes",
      "Ring cable connection",
      2,
      48,
      "AC/DC",
      "Yes",
      40,
      18.64,
      18.64,
      11
    ]);
  });

  it("keeps Qwen suggestions out of the final PDT workbook", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-no-ai-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "AAO676";
    material.getCell(7, 2).value = "CNSORDERNO";
    material.getCell(8, 2).value = "Articlenumber";

    const contactor = wb.addWorksheet("contactor a. fuses");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      contactor.getCell(row + 1, 1).value = label;
    }
    contactor.getCell(4, 2).value = "BAH005";
    contactor.getCell(5, 2).value = "BAH005";
    contactor.getCell(6, 2).value = "Rated control circuit voltage";

    const docs = wb.addWorksheet("Additional Documents");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Body"].entries()) {
      docs.getCell(row + 1, 1).value = label;
    }
    docs.getCell(4, 2).value = "Articlenumber";
    docs.getCell(4, 3).value = "Document ID";
    docs.getCell(4, 4).value = "Document path";
    await wb.xlsx.writeFile(templatePath);

    const originalFetch = globalThis.fetch;
    const originalAiCleanup = process.env.PDT_AI_CLEANUP;
    const originalOllamaHost = process.env.OLLAMA_HOST;
    let fetchCalls = 0;
    process.env.PDT_AI_CLEANUP = "1";
    process.env.OLLAMA_HOST = "http://ollama.test";
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          response: JSON.stringify({ products: [{ catalogNumber: "1SBL347060R1100", controlVoltage: "20-60" }] })
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      const item = ctx(
        {
          manufacturerId: "abb",
          title: "AF40B Contactor",
          attributes: [
            { name: "Catalog Description", value: "AF40B-30-00RT-11 24-60V50/60HZ 20-60VDC Contactor", sourceType: "official" },
            { name: "Rated Control Circuit Voltage", value: "50 Hz 24 ... 60 V; DC Operation 20 ... 60 V", sourceType: "official" }
          ]
        },
        "1SBL347060R1100"
      ).item;

      await exportRunPdt({ manufacturer: { ...manufacturer, id: "abb" } as ManufacturerConfig, items: [item], templatePath, outputPath });

      const out = new ExcelJS.Workbook();
      await out.xlsx.readFile(outputPath);
      const outContactor = out.getWorksheet("contactor a. fuses")!;
      expect(fetchCalls).toBe(0);
      expect(outContactor.getCell(8, 1).value).toBe("24-60");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAiCleanup === undefined) delete process.env.PDT_AI_CLEANUP;
      else process.env.PDT_AI_CLEANUP = originalAiCleanup;
      if (originalOllamaHost === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = originalOllamaHost;
    }
  });
});

describe("PDT exporter sheet lookup", () => {
  it("resolves the device tab case-insensitively (template 'switch' matches mapping 'Switch')", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-case-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "AAO676";
    material.getCell(7, 2).value = "CNSORDERNO";
    material.getCell(8, 2).value = "Articlenumber";

    // Intentionally use lowercase casing different from the device-sheet map's "Switch".
    const sw = wb.addWorksheet("switch");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      sw.getCell(row + 1, 1).value = label;
    }
    sw.getCell(4, 2).value = "AAO676";
    sw.getCell(5, 2).value = "CNSORDERNO";
    sw.getCell(6, 2).value = "Articlenumber";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Selector switch 2-position",
        attributes: [{ name: "Product Type", value: "Selector switch", sourceType: "official" }]
      },
      "SW-001"
    ).item;
    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.filledSheets["switch"]).toBe(1);
    expect(result.missingSheets).not.toContain("Switch");
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    // The exporter strips the leading label column after writing, so the body value lands in
    // column 1 of the written sheet.
    expect(out.getWorksheet("switch")!.getCell(8, 1).value).toBe("SW-001");
  });

  it("routes a mixed batch of devices to the correct combination of tabs", async () => {
    // Simulate a typical real run: one Contactor, one Enclosure and one sensor in the same batch.
    // Expected behaviour:
    //   - Material Master Data + Additional Documents include ALL three products (constant tabs).
    //   - contactor a. fuses contains ONLY the contactor.
    //   - cabinet + cabinet.mechanical contain ONLY the enclosure.
    //   - electronic sensor contains ONLY the sensor.
    //   - No product is leaked into an unrelated tab.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-multi-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();

    const labelHeader = (sheet: ExcelJS.Worksheet) => {
      for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
        sheet.getCell(row + 1, 1).value = label;
      }
    };
    const articleColumn = (sheet: ExcelJS.Worksheet) => {
      sheet.getCell(4, 2).value = "AAO676";
      sheet.getCell(5, 2).value = "CNSORDERNO";
      sheet.getCell(6, 2).value = "Articlenumber";
    };

    // Material Master Data layout (different from device tabs — body row follows the units row).
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "AAO676";
    material.getCell(7, 2).value = "CNSORDERNO";
    material.getCell(8, 2).value = "Articlenumber";
    wb.addWorksheet("Additional Documents");

    const contactor = wb.addWorksheet("contactor a. fuses");
    labelHeader(contactor);
    articleColumn(contactor);

    const cabinet = wb.addWorksheet("cabinet");
    labelHeader(cabinet);
    articleColumn(cabinet);

    const cabinetMech = wb.addWorksheet("cabinet.mechanical");
    labelHeader(cabinetMech);
    articleColumn(cabinetMech);

    const electronicSensor = wb.addWorksheet("electronic sensor");
    labelHeader(electronicSensor);
    articleColumn(electronicSensor);

    await wb.xlsx.writeFile(templatePath);

    const items: RunItemRecord[] = [
      ctx(
        {
          title: "AF40B Contactor",
          attributes: [
            { group: "General", name: "Product Type", value: "Contactor", sourceType: "official" },
            { group: "Technical", name: "Number of poles", value: "3P", sourceType: "official" },
            { group: "Technical", name: "Rated operational current AC-1", value: "70 A", sourceType: "official" }
          ]
        },
        "CTR-001"
      ).item,
      ctx(
        {
          title: "Wall-mounted steel enclosure 600x400x250",
          attributes: [
            { group: "General", name: "Product Type", value: "Enclosure", sourceType: "official" },
            { group: "Mechanical", name: "Width", value: "600 mm", sourceType: "official" },
            { group: "Mechanical", name: "Material", value: "Steel", sourceType: "official" },
            { group: "Protection", name: "Degree of protection", value: "IP66", sourceType: "official" }
          ]
        },
        "ENC-001"
      ).item,
      ctx(
        {
          title: "Inductive proximity sensor M12 PNP",
          attributes: [
            { group: "General", name: "Product Type", value: "Inductive proximity sensor", sourceType: "official" },
            { group: "Sensing", name: "Switching distance", value: "4 mm", sourceType: "official" },
            { group: "Output", name: "Output type", value: "PNP NO", sourceType: "official" }
          ]
        },
        "SNS-001"
      ).item
    ];

    const result = await exportRunPdt({ manufacturer, items, templatePath, outputPath });
    expect(result.missingSheets).toEqual([]);

    // Per-tab item counts in the result summary.
    expect(result.filledSheets["Material Master Data"]).toBe(3);
    expect(result.filledSheets["contactor a. fuses"]).toBe(1);
    expect(result.filledSheets["cabinet"]).toBe(1);
    expect(result.filledSheets["cabinet.mechanical"]).toBe(1);
    expect(result.filledSheets["electronic sensor"]).toBe(1);

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);

    // Material Master Data lists all three article numbers (body starts at row 10 in this layout).
    const materialOut = out.getWorksheet("Material Master Data")!;
    expect([
      materialOut.getCell(10, 2).value,
      materialOut.getCell(11, 2).value,
      materialOut.getCell(12, 2).value
    ]).toEqual(["CTR-001", "ENC-001", "SNS-001"]);

    // Each device-specific tab has exactly its own product, in the first body row (row 8 in the
    // tab layout, column 1 after the helper label column is stripped).
    expect(out.getWorksheet("contactor a. fuses")!.getCell(8, 1).value).toBe("CTR-001");
    expect(out.getWorksheet("contactor a. fuses")!.getCell(9, 1).value ?? null).toBeNull();

    expect(out.getWorksheet("cabinet")!.getCell(8, 1).value).toBe("ENC-001");
    expect(out.getWorksheet("cabinet")!.getCell(9, 1).value ?? null).toBeNull();

    expect(out.getWorksheet("cabinet.mechanical")!.getCell(8, 1).value).toBe("ENC-001");
    expect(out.getWorksheet("cabinet.mechanical")!.getCell(9, 1).value ?? null).toBeNull();

    expect(out.getWorksheet("electronic sensor")!.getCell(8, 1).value).toBe("SNS-001");
    expect(out.getWorksheet("electronic sensor")!.getCell(9, 1).value ?? null).toBeNull();

    // No cross-contamination: the contactor tab does not contain the sensor or enclosure, etc.
    const contactorRow1Values = [
      out.getWorksheet("contactor a. fuses")!.getCell(8, 1).value,
      out.getWorksheet("contactor a. fuses")!.getCell(9, 1).value
    ];
    expect(contactorRow1Values).not.toContain("ENC-001");
    expect(contactorRow1Values).not.toContain("SNS-001");

    // Sanity-check the result.keptSheets list — every used tab is still there.
    expect(result.keptSheets).toContain("Material Master Data");
    expect(result.keptSheets).toContain("Additional Documents");
    expect(result.keptSheets).toContain("contactor a. fuses");
    expect(result.keptSheets).toContain("cabinet");
    expect(result.keptSheets).toContain("cabinet.mechanical");
    expect(result.keptSheets).toContain("electronic sensor");
  });
});

describe("Additional Documents PDT sheet", () => {
  function addDocumentsWorksheet(): ExcelJS.Worksheet {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Additional Documents");
    ws.getCell(1, 1).value = "ClassId";
    ws.getCell(2, 1).value = "Priority";
    ws.getCell(3, 1).value = "Type";
    ws.getCell(4, 1).value = "PropertyId";
    ws.getCell(5, 1).value = "PropertyName";
    ws.getCell(6, 1).value = "Description";
    ws.getCell(7, 1).value = "Body";
    ws.getCell(4, 2).value = "Articlenumber";
    ws.getCell(4, 3).value = "Document ID";
    ws.getCell(4, 4).value = "Document type";
    ws.getCell(4, 5).value = "Document path";
    ws.getCell(4, 6).value = "Document";
    ws.getCell(4, 7).value = "Document index";
    ws.getCell(4, 8).value = "Description";
    ws.getCell(4, 9).value = "Parent Entity";
    return ws;
  }

  it("matches the manual ABB layout with EN/DE product links and no helper label column", () => {
    const ws = addDocumentsWorksheet();
    const first = ctx({ manufacturerId: "abb", localizedUrls: { en: "https://new.abb.com/smartlinks/en?ProductId=1SBL347060R1100" } }, "1SBL347060R1100").item;
    const second = ctx({ manufacturerId: "abb" }, "1SBL347060R1200").item;

    expect(writeDocumentsSheet(ws, [first, second])).toBe(4);
    expect(ws.getCell(1, 1).value).toBeNull();
    expect(ws.getCell(4, 1).value).toBe("Articlenumber");
    expect(ws.getCell(7, 1).value).toBe("1SBL347060R1100");
    expect(ws.getCell(7, 2).value).toBe(1);
    expect(ws.getCell(7, 4).value).toEqual({
      text: "https://new.abb.com/products/ABB1SBL347060R1100",
      hyperlink: "https://new.abb.com/products/ABB1SBL347060R1100"
    });
    expect(ws.getCell(8, 4).value).toEqual({
      text: "https://new.abb.com/products/de/ABB1SBL347060R1100",
      hyperlink: "https://new.abb.com/products/de/ABB1SBL347060R1100"
    });
    expect(ws.getCell(8, 5).value).toBe("german");
    expect(ws.getCell(9, 1).value).toBeNull();
    expect(ws.getCell(10, 1).value).toBe("1SBL347060R1200");
  });
});
