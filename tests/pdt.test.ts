import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ManufacturerConfig, ProductResult, RunItemRecord } from "../src/shared/types.js";
import { targetSheets, deviceSheetsFor } from "../src/server/pdt/device-sheet-map.js";
import { knownDeviceTypes } from "../src/server/scrapers/device-type.js";
import { hasPropertyResolver, resolveProperty, type ResolveContext } from "../src/server/pdt/eclass-resolvers.js";
import { cellText, describeSheet } from "../src/server/pdt/sheet-descriptor.js";
import { encodeEnum, encodeEnumLabel, isEnumColumn } from "../src/server/pdt/enum-encode.js";
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

const NON_DEVICE_MASTER_TABS = new Set([
  "Material Master Data",
  "Additional Documents",
  "Connection Point Information",
  "Carbon Footprint (V2)",
  "Product Carbon Footprint PCF",
  "Carbon Footprint Transport TCF",
  "Critical environ. ingredient",
  "EMC electromag. compatibility",
  "connector.optical",
  "Product Accessory",
  "Help",
  "Sheet11",
  "Tabelle1",
  "Tabelle2",
  "subcircuit",
  "symbol",
  "symbol library",
  "symbol example",
  "PCB Footprint"
]);

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

  it("maps lower-confidence catch-all types to reviewable PDT tabs", () => {
    expect(deviceSheetsFor("Battery")).toEqual(["power supply devices"]);
    expect(deviceSheetsFor("Accessory")).toEqual(["cabinet.mechanical"]);
    expect(deviceSheetsFor("Cover / Door Accessory")).toEqual(["cabinet.mechanical"]);
    expect(deviceSheetsFor("Lock / Interlock")).toEqual(["Switch"]);
    expect(targetSheets(undefined)).toEqual(["Material Master Data", "Additional Documents"]);
  });

  it("maps every device type to a tab that exists in the Master PDT template", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.resolve("templates", "master_pdt.xlsx"));
    const available = new Set(wb.worksheets.map((ws) => ws.name.trim().toLowerCase()));

    for (const deviceType of knownDeviceTypes()) {
      const sheets = deviceSheetsFor(deviceType);
      expect(sheets.length).toBeGreaterThan(0);
      for (const sheet of sheets) {
        expect(available.has(sheet.trim().toLowerCase())).toBe(true);
      }
    }
  });

  it("maps every device-product tab in the Master PDT template from at least one known device type", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.resolve("templates", "master_pdt.xlsx"));
    const mappedTabs = new Set(knownDeviceTypes().flatMap((deviceType) => deviceSheetsFor(deviceType)));

    const uncovered = wb.worksheets
      .map((ws) => ws.name)
      .filter((tab) => !NON_DEVICE_MASTER_TABS.has(tab))
      .filter((tab) => !mappedTabs.has(tab));

    expect(uncovered).toEqual([]);
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

  it("has resolver coverage for every mapped device-product PDT tab", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.resolve("templates", "master_pdt.xlsx"));
    const mappedTabs = new Set(knownDeviceTypes().flatMap((deviceType) => deviceSheetsFor(deviceType)));
    const unresolved: Record<string, string[]> = {};

    for (const sheetName of mappedTabs) {
      const ws = wb.getWorksheet(sheetName);
      expect(ws, `Missing mapped sheet ${sheetName}`).toBeTruthy();
      const descriptor = describeSheet(ws!);
      expect(descriptor, `Sheet ${sheetName} is not a PDT property sheet`).toBeTruthy();
      const unmapped = descriptor!.columns
        .filter((column) => column.code !== "ECLASS property")
        .filter((column) => !isIgnoredDeviceTabColumn(column.code, column.propName))
        .filter((column) => !hasPropertyResolver(column.code, column.propName))
        .map((column) => `${column.code} / ${column.propName}`);
      if (unmapped.length > 0) unresolved[sheetName] = unmapped;
    }

    expect(unresolved).toEqual({});
  });
});

function isIgnoredDeviceTabColumn(code: string, propName: string): boolean {
  return code.trim() === "-" && propName.trim() === "-";
}

describe("eclass resolvers", () => {
  it("resolves manufacturer, article number and product url", () => {
    const c = ctx({ productUrl: "https://acme.test/p/CAT-1" });
    expect(resolveProperty("AAO677", "AAO677", c)).toBe("ACME Corp");
    expect(resolveProperty("AAO676", "CNSORDERNO", c)).toBe("CAT-1");
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://acme.test/p/CAT-1");
    expect(resolveProperty("MANUFACTURER_URL", "MANUFACTURER_URL", c)).toBe("https://acme.test");
  });

  it("uses the gb/en-gb skuPage with EP- prefix for Eaton product URLs (manual PDT format)", () => {
    const c = ctx({ manufacturerId: "eaton" }, "502419");
    c.manufacturer = { ...manufacturer, id: "eaton" } as ManufacturerConfig;
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe(
      "https://www.eaton.com/gb/en-gb/skuPage.EP-502419.html"
    );
    // Already-prefixed inputs aren't double-prefixed.
    const c2 = ctx({ manufacturerId: "eaton" }, "EP-502420");
    c2.manufacturer = { ...manufacturer, id: "eaton" } as ManufacturerConfig;
    expect(resolveProperty("AAQ326", "AAQ326", c2)).toBe(
      "https://www.eaton.com/gb/en-gb/skuPage.EP-502420.html"
    );
  });

  it("uses partnumber_info/?n= for Saginaw product URLs (manual PDT format)", () => {
    const c = ctx({ manufacturerId: "sce" }, "SCE-12H2406LP");
    c.manufacturer = { ...manufacturer, id: "sce" } as ManufacturerConfig;
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe(
      "https://www.saginawcontrol.com/partnumber_info/?n=SCE-12H2406LP"
    );
  });

  it("maps deviceType to a single-letter IEC 81346 class code for AAC314", () => {
    // Subpanel / mounting → U (matches manual Eaton PDT for PSN-FP/PSN-PIP accessories)
    const subpanel = ctx({}, "EP-502327", "Subpanel");
    expect(resolveProperty("AAC314", "AAC314", subpanel)).toBe("U");
    // Contactor → Q
    const contactor = ctx({}, "1SBL", "Contactor");
    expect(resolveProperty("AAC314", "AAC314", contactor)).toBe("Q");
    // PLC → B
    const plc = ctx({}, "1769-L33ER", "PLC");
    expect(resolveProperty("AAC314", "AAC314", plc)).toBe("B");
    // Generic Accessory → U (most often a mounting/support part in our catalogs)
    const accessory = ctx({}, "1SDA126395R1", "Accessory");
    expect(resolveProperty("AAC314", "AAC314", accessory)).toBe("U");
    // Explicit IEC 81346 attribute still wins over the deviceType-based default.
    const explicit = ctx(
      { attributes: [{ name: "IEC 81346-2 Class Level 1", value: "X", sourceType: "official" }] },
      "CAT-1",
      "Connector"
    );
    expect(resolveProperty("AAC314", "AAC314", explicit)).toBe("X");
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

  it("derives safe manufacturer family/base/designation fields from structured type evidence", () => {
    const eaton = ctx(
      { manufacturerId: "eaton", attributes: [{ name: "Model Code", value: "PSN-DRS-MT-ASMTAB", sourceType: "official" }] },
      "502419"
    );
    eaton.manufacturer = { ...manufacturer, id: "eaton" } as ManufacturerConfig;
    expect(resolveProperty("AAU731", "AAU731", eaton)).toBe("PSN");
    expect(resolveProperty("AAU732", "AAU732", eaton)).toBe("PSN-DRS-MT");
    expect(resolveProperty("AAU733", "AAU733", eaton)).toBe("ASMTAB");
    expect(resolveProperty("AAW338", "AAW338", eaton)).toBe("PSN-DRS-MT");

    const abb = ctx(
      { manufacturerId: "abb", attributes: [{ name: "Extended Product Type", value: "AF40B-30-00RT-12", sourceType: "official" }] },
      "1SBL347060R1100"
    );
    abb.manufacturer = { ...manufacturer, id: "abb" } as ManufacturerConfig;
    expect(resolveProperty("AAU731", "AAU731", abb)).toBe("AF");
    expect(resolveProperty("AAU732", "AAU732", abb)).toBe("AF40B");

    const sceLppl = ctx({ manufacturerId: "sce" }, "SCE-60EL4812LPPL");
    sceLppl.manufacturer = { ...manufacturer, id: "sce" } as ManufacturerConfig;
    expect(resolveProperty("AAU731", "AAU731", sceLppl)).toBe("EL_LPPL");
    expect(resolveProperty("AAU732", "AAU732", sceLppl)).toBe("EL LPPL Enclosure");
    expect(resolveProperty("AAW338", "AAW338", sceLppl)).toBe("Wall mounted enclosure");
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
    // ABB device-sheet ECLASS version matches the manual PDT (v13) instead of the generic v14 default.
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", c)).toBe("13");
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://new.abb.com/products/1SBL347060R1100");
    expect(resolveProperty("BAH005", "BAH005", c)).toBe("24-60");
    expect(resolveProperty("AAF726", "AAF726", c)).toBe("70");
    // When the source publishes both AC (50/60 Hz) and DC segments, treat the contactor
    // as dual-mode rather than ambiguous — slash-vs-no-slash isn't a meaningful distinction.
    expect(resolveProperty("BAD915", "BAD915", c)).toBe("AC/DC");
    expect(resolveProperty("AAT080", "AAT080", c)).toBe("3");
  });

  it("fills ABB contactor/fuses voltage ranges from product text when no voltage attribute exists", () => {
    const c = ctx({
      manufacturerId: "abb",
      title: "SACE Emax 3 EKIP SUPPLY LITE 24-240VAC/DC E1.3..E6.3",
      description: "EKIP SUPPLY POWER SUPPLY MODULE 24...240V AC-DC E1.3...E6.3",
      attributes: [
        { name: "Catalog Description", value: "SACE Emax 3 EKIP SUPPLY LITE 24-240VAC/DC E1.3..E6.3", sourceType: "official" },
        { name: "Extended Product Type", value: "UVD E1.3..E6.3 110..125Va.c./d.c.", sourceType: "official" },
        { name: "Current Type", value: "AC/DC", sourceType: "official" }
      ]
    });
    c.sheetName = "contactor a. fuses";

    expect(resolveProperty("BAH005", "BAH005", c)).toBe("24-240");
    expect(resolveProperty("BAD915", "BAD915", c)).toBe("AC/DC");
  });

  it("fills ABB contactor current from common thermal/current aliases", () => {
    const c = ctx({
      manufacturerId: "abb",
      attributes: [
        { name: "Conventional Free-air Thermal Current", value: "acc. to IEC 60947-4-1, open contactors 70 A", sourceType: "official" },
        { name: "Rated Current", value: "Main Circuit 60 A", sourceType: "official" }
      ]
    });
    c.sheetName = "contactor a. fuses";

    expect(resolveProperty("AAF726", "AAF726", c)).toBe("70");
    expect(resolveProperty("AAB821", "AAB821", c)).toBe("70");
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

  it("resolves common master fields shared outside the contactor/fuses tab", () => {
    const c = ctx({
      normalized: { color: "RAL 7035", material: "polycarbonate", protection: "IP66" },
      attributes: [
        { name: "REACH Registration", value: "Yes", sourceType: "official" },
        { name: "SVHC Weight Percentage", value: "0.1 %", sourceType: "official" },
        { name: "RoHS Declaration", value: "https://acme.test/rohs.pdf", sourceType: "official" },
        { name: "Rated Operational Voltage", value: "230 V AC; 24 V DC", sourceType: "official" },
        { name: "Operating ambient temperature", value: "-25...+70 C", sourceType: "official" },
        { name: "Storage temperature", value: "-40...+85 C", sourceType: "official" },
        { name: "Protection Class", value: "II", sourceType: "official" },
        { name: "Material of housing", value: "PA66", sourceType: "official" },
        { name: "Design", value: "compact", sourceType: "official" },
        { name: "Country of Origin", value: "Germany", sourceType: "official" },
        { name: "Reference test standard", value: "IEC 61000-6-2", sourceType: "official" },
        { name: "Test severity level", value: "Level 3", sourceType: "official" },
        { name: "Special Characteristics", value: "short-circuit protected", sourceType: "official" },
        { name: "Explosion protection gases", value: "No", sourceType: "official" },
        { name: "Design of control output", value: "PNP", sourceType: "official" },
        { name: "Switching element function", value: "normally open", sourceType: "official" },
        { name: "Thread Size", value: "M12", sourceType: "official" },
        { name: "Connector Type", value: "M12 connector", sourceType: "official" },
        { name: "Coding", value: "A-coded", sourceType: "official" },
        { name: "Operating Pressure", value: "0.6 MPa", sourceType: "official" }
      ],
      documents: [{ type: "certificate", label: "REACH Declaration", url: "https://acme.test/reach.pdf" }]
    });

    expect(resolveProperty("AAF507", "AAF507", c)).toBe("Yes");
    expect(resolveProperty("AAO188", "AAO188", c)).toBe("0.1");
    expect(resolveProperty("AAO189", "AAO189", c)).toBe("https://acme.test/reach.pdf");
    expect(resolveProperty("AAO191", "AAO191", c)).toBe("Yes");
    expect(resolveProperty("AAB459", "AAB459", c)).toBe("230");
    expect(resolveProperty("AAB840", "AAB840", c)).toBe("24");
    expect(resolveProperty("AAZ952", "AAZ952", c)).toBe("-25");
    expect(resolveProperty("AAQ341", "AAQ341", c)).toBe("85");
    expect(resolveProperty("AAQ342", "AAQ342", c)).toBe("-40");
    expect(resolveProperty("AAC108", "AAC108", c)).toBe("IP66");
    expect(resolveProperty("BAA205", "BAA205", c)).toBe("Protection class 2");
    expect(resolveProperty("AAT099", "AAT099", c)).toBe("7035");
    expect(resolveProperty("BAD947", "BAD947", c)).toBe("PA66");
    expect(resolveProperty("BAB888", "BAB888", c)).toBe("compact");
    expect(resolveProperty("BAB894", "BAB894", c)).toBe("compact");
    expect(resolveProperty("AAO263", "AAO263", c)).toBe("Germany");
    expect(resolveProperty("AAZ088", "AAZ088", c)).toBe("IEC 61000-6-2");
    expect(resolveProperty("AAZ135", "AAZ135", c)).toBe("Level 3");
    expect(resolveProperty("BAD816", "BAD816", c)).toBe("short-circuit protected");
    expect(resolveProperty("BAD833", "BAD833", c)).toBe("No");
    expect(resolveProperty("BAD898", "BAD898", c)).toBe("PNP");
    expect(resolveProperty("BAD899", "BAD899", c)).toBe("Normally open contact");
    expect(resolveProperty("ABC265", "ABC265", c)).toBe("M12");
    expect(resolveProperty("ABC266", "ABC266", c)).toBe("Circular connector");
    expect(resolveProperty("ABC338", "ABC338", c)).toBe("A-coded");
    expect(resolveProperty("AAZ943", "AAZ943", c)).toBe("6");
  });

  it("normalizes only review-safe enum-oriented source values", () => {
    expect(
      resolveProperty(
        "AAO336",
        "CNS_MOUNTING_ORIENTATION",
        ctx({ attributes: [{ name: "Mounting Position", value: "1 ... 5", sourceType: "official" }] })
      )
    ).toBeUndefined();
    expect(
      resolveProperty(
        "AAO336",
        "CNS_MOUNTING_ORIENTATION",
        ctx({ attributes: [{ name: "Mounting Orientation", value: "Vertical up", sourceType: "official" }] })
      )
    ).toBe("vertical up");

    expect(
      resolveProperty("BAC000", "BAC000", ctx({ attributes: [{ name: "Construction", value: "0.075 In. carbon steel.", sourceType: "official" }] }))
    ).toBeUndefined();
    expect(resolveProperty("BAC000", "BAC000", ctx({ attributes: [{ name: "Construction form", value: "Wall assembly", sourceType: "official" }] }))).toBe(
      "Wall assembly"
    );

    expect(resolveProperty("BAF785", "BAF785", ctx({ attributes: [{ name: "Finish", value: "Finish", sourceType: "official" }] }))).toBeUndefined();
    expect(resolveProperty("BAF785", "BAF785", ctx({ attributes: [{ name: "Surface finish", value: "#4 brushed finish", sourceType: "official" }] }))).toBe(
      "brushed"
    );

    const multiNema = ctx({ attributes: [{ name: "NEMA Rating", value: "NEMA Type 3R, 4, 12 and Type 13", sourceType: "official" }] });
    expect(resolveProperty("AAW361", "AAW361", multiNema)).toBeUndefined();
    expect(resolveProperty("AAZ486", "AAZ486", multiNema)).toBe("NEMA Type 3R, 4, 12 and Type 13");
    expect(
      resolveProperty("AAW361", "AAW361", ctx({ attributes: [{ name: "NEMA Rating", value: "NEMA Type 4X", sourceType: "official" }] }))
    ).toBe("NEMA 4X");

    const materialComplianceDoc = ctx({
      attributes: [{ group: "ABB Material Compliance", name: "Conflict Minerals Reporting Template (CMRT)", value: "9AKK108467A5658", sourceType: "official" }]
    });
    expect(resolveProperty("BAB664", "BAB664", materialComplianceDoc)).toBeUndefined();
    expect(resolveProperty("BAF634", "BAF634", materialComplianceDoc)).toBeUndefined();
    expect(resolveProperty("BAB664", "BAB664", ctx({ normalized: { material: "9AKK108467A5658" } }))).toBeUndefined();
    expect(resolveProperty("BAB664", "BAB664", ctx({ normalized: { material: "carbon steel" } }))).toBe("carbon steel");

    expect(
      resolveProperty(
        "AAO263",
        "AAO263",
        ctx({ attributes: [{ group: "Plain Text", name: 'var desired = country === "SA"', value: "originalText;", sourceType: "official" }] })
      )
    ).toBeUndefined();
    expect(resolveProperty("AAO263", "AAO263", ctx({ attributes: [{ name: "Country of Origin", value: "Germany", sourceType: "official" }] }))).toBe(
      "Germany"
    );
    expect(resolveProperty("BAA097", "BAA097", ctx({ normalized: { color: "#262626;\">' + k + ' '" } }))).toBeUndefined();

    expect(resolveProperty("AAQ323", "AAQ323", ctx({ normalized: { certificates: "CE; cULus; WEEE" } }))).toBeUndefined();
    expect(resolveProperty("BAB392", "BAB392", ctx({ normalized: { certificates: "CE; cULus; WEEE" } }))).toBeUndefined();
    expect(resolveProperty("BAB392", "BAB392", ctx({ normalized: { certificates: "Blue Angel (RAL-UZ 14)" } }))).toBe("Blue Angel (RAL-UZ 14)");
    expect(resolveProperty("BAA558", "BAA558", ctx({ attributes: [{ name: "cULus Certificate", value: "cULus61010-1_E174460" }] }))).toBeUndefined();
    expect(resolveProperty("BAA558", "BAA558", ctx({ attributes: [{ name: "Test certificate", value: "2.2 Test certificate" }] }))).toBe(
      "2.2, Test certificate"
    );

    expect(resolveProperty("ABC264", "ABC264", ctx({ attributes: [{ name: "Connection type", value: "1. Switch position: Screw terminal" }] }))).toBeUndefined();
    expect(resolveProperty("ABC264", "ABC264", ctx({ attributes: [{ name: "Connection", value: "Connector, M12x1-Male, 4-pin" }] }))).toBe(
      "Plug-in connection"
    );
    expect(resolveProperty("ABC265", "ABC265", ctx({ attributes: [{ name: "Thread Size", value: "M12x1" }] }))).toBe("M12");
    expect(resolveProperty("ABC266", "ABC266", ctx({ attributes: [{ name: "Connection type", value: "1. Switch position: Screw terminal" }] }))).toBeUndefined();
    expect(resolveProperty("AAQ824", "AAQ824", ctx({ attributes: [{ name: "Switching output", value: "PNP normally closed (NC)" }] }))).toBe(
      "Binary electronic output"
    );
    expect(resolveProperty("BAD830", "BAD830", ctx({ attributes: [{ name: "Setting", value: "Sensitivity (Sn)" }] }))).toBeUndefined();
    expect(resolveProperty("BAD830", "BAD830", ctx({ attributes: [{ name: "Setting", value: "Teach-In" }] }))).toBe("Teach-In");
    expect(resolveProperty("BAD859", "BAD859", ctx({ attributes: [{ name: "Light type", value: "Red light" }] }))).toBeUndefined();
    expect(resolveProperty("BAD859", "BAD859", ctx({ attributes: [{ name: "Light type", value: "Infrared" }] }))).toBe("Infrared light");
    expect(resolveProperty("BAD899", "BAD899", ctx({ attributes: [{ name: "Switching function, optical", value: "Light-on" }] }))).toBeUndefined();
    expect(resolveProperty("BAD899", "BAD899", ctx({ attributes: [{ name: "Switching element function", value: "normally closed" }] }))).toBe(
      "Normally close contact"
    );
    expect(resolveProperty("AAK286", "AAK286", ctx({ attributes: [{ name: "Principle of operation", value: "Photoelectric sensor" }] }))).toBeUndefined();
    expect(resolveProperty("ABC338", "ABC338", ctx({ attributes: [{ name: "Coding", value: "Write cycles" }] }))).toBeUndefined();
    expect(resolveProperty("AAB396", "AAB396", ctx({ attributes: [{ name: "Housing surface", value: "PBTP" }] }))).toBeUndefined();
    expect(resolveProperty("AAB396", "AAB396", ctx({ attributes: [{ name: "Housing surface", value: "nickel-plated" }] }))).toBe("nickel-plated");
    expect(resolveProperty("AAK395", "AAK395", ctx({ attributes: [{ name: "Screen", value: "Aluminum foil and copper braid" }] }))).toBe("Film + fabric");
    expect(resolveProperty("AAZ485", "AAZ485", ctx({ attributes: [{ name: "Suitable for", value: "E1.3, E2.3, E4.3" }] }))).toBeUndefined();
    expect(resolveProperty("ABD914", "ABD914", ctx({ attributes: [{ name: "IO-Link Revision", value: "1.1" }] }))).toBe("V1.1");
    expect(resolveProperty("BAD866", "BAD866", ctx({ attributes: [{ name: "Mechanical installation conditions", value: "– Flush mount" }] }))).toBe("flush");
    expect(resolveProperty("AAC073", "AAC073", ctx({ attributes: [{ name: "EN ISO 13849-1", value: "2023 and SN29500, T = 40 C" }] }))).toBeUndefined();
    expect(resolveProperty("AAC073", "AAC073", ctx({ attributes: [{ name: "Performance level", value: "PL d" }] }))).toBe("PL d");
    expect(resolveProperty("BAA205", "BAA205", ctx({ attributes: [{ name: "Protection type", value: "IP 67" }] }))).toBeUndefined();
    expect(resolveProperty("AAO382", "AAO382", ctx({ attributes: [{ name: "Safety integrity level (SIL)", value: "None" }] }))).toBe("without");
    expect(resolveProperty("AAF607", "AAF607", ctx({ attributes: [{ name: "Design", value: "built-in-device" }] }))).toBe("built-in-device");
    expect(resolveProperty("AAF607", "AAF607", ctx({ attributes: [{ name: "Design", value: "Design of electrical connection: Screw connection" }] }))).toBeUndefined();
    expect(resolveProperty("AAB400", "AAB400", ctx({ attributes: [{ name: "Interface design", value: "0.2 A" }] }))).toBeUndefined();
    expect(resolveProperty("AAB400", "AAB400", ctx({ attributes: [{ name: "Interface design", value: "EtherNet/IP" }] }))).toBe("EtherNet/IP");
    expect(resolveProperty("AAK359", "AAK359", ctx({ attributes: [{ name: "Measurement principle", value: "MEMS" }] }))).toBeUndefined();
    expect(resolveProperty("ABD888", "ABD888", ctx({ attributes: [{ name: "Light source", value: "infrared 640 nm" }] }))).toBeUndefined();
    expect(resolveProperty("BAC461", "BAC461", ctx({ attributes: [{ name: "Housing material", value: "PA 12" }] }))).toBeUndefined();
    expect(resolveProperty("BAC461", "BAC461", ctx({ attributes: [{ name: "Housing material", value: "PBTP" }] }))).toBe("Plastic (PBT)");
    expect(resolveProperty("BAA136", "BAA136", ctx({ attributes: [{ name: "Medium", value: "text-accent transition-colors\"" }] }))).toBeUndefined();
  });

  it("resolves deeper power-supply, sensor, PCB and fluid fields", () => {
    const c = ctx({
      attributes: [
        { name: "Output voltage adjustable", value: "Yes", sourceType: "official" },
        { name: "Max 1. output voltage", value: "24 V", sourceType: "official" },
        { name: "Nominal value output current 1", value: "5 A", sourceType: "official" },
        { name: "Max. rated supply voltage with AC 50 Hz", value: "264 V AC", sourceType: "official" },
        { name: "Supply voltage", value: "18...30 V DC", sourceType: "official" },
        { name: "Ethernet communication interface", value: "EtherNet/IP", sourceType: "official" },
        { name: "Width of sensor", value: "12 mm", sourceType: "official" },
        { name: "IO-Link transmission rate", value: "COM3", sourceType: "official" },
        { name: "Grid dimension of the connections", value: "5.08 mm", sourceType: "official" },
        { name: "Rated surge voltage", value: "4 kV", sourceType: "official" },
        { name: "Pressure medium temperature", value: "-10...+60 C", sourceType: "official" },
        { name: "Number of pneumatic output connections", value: "2", sourceType: "official" },
        { name: "Integrated protective circuitry", value: "Yes", sourceType: "official" },
        { name: "Max. ambient temperature during operation", value: "-25...+70 C", sourceType: "official" },
        { name: "Material thickness", value: "1.5 mm", sourceType: "official" },
        { name: "Suitability for application", value: "Control", sourceType: "official" },
        { name: "Color of housing", value: "black", sourceType: "official" },
        { name: "Supply voltage type", value: "AC/DC", sourceType: "official" },
        { name: "Max. core cross section", value: "1.5 mm", sourceType: "official" },
        { name: "Suitable for cable guide chain", value: "Yes", sourceType: "official" },
        { name: "Type of actuation", value: "DC", sourceType: "official" },
        { name: "Design of interface for security oriented communications", value: "PROFIsafe", sourceType: "official" },
        { name: "Cascadable", value: "Yes", sourceType: "official" },
        { name: "Number of HW interfaces USB", value: "2", sourceType: "official" },
        { name: "Touch screen present", value: "Yes", sourceType: "official" },
        { name: "Frequency measurement possible", value: "Yes", sourceType: "official" },
        { name: "Max. voltage measuring range", value: "600 V", sourceType: "official" },
        { name: "VDE tested", value: "Yes", sourceType: "official" },
        { name: "Filter present", value: "Yes", sourceType: "official" },
        { name: "Useful cooling capacity", value: "500 W", sourceType: "official" },
        { name: "Busbar width", value: "12 mm", sourceType: "official" }
      ]
    });

    expect(resolveProperty("AAB429", "AAB429", c)).toBe("Yes");
    expect(resolveProperty("AAB773", "AAB773", c)).toBe("24");
    expect(resolveProperty("AAS343", "AAS343", c)).toBe("5");
    expect(resolveProperty("AAB832", "AAB832", c)).toBe("264");
    expect(resolveProperty("AAC962", "AAC962", c)).toBe("18");
    expect(resolveProperty("AAC965", "AAC965", c)).toBe("264");
    expect(resolveProperty("AAB745", "AAB745", c)).toBe("Yes");
    expect(resolveProperty("BAD823", "BAD823", c)).toBe("12");
    expect(resolveProperty("ABD912", "ABD912", c)).toBe("COM3");
    expect(resolveProperty("AAC082", "AAC082", c)).toBe("5.08");
    expect(resolveProperty("AAB499", "AAB499", c)).toBe("4000");
    expect(resolveProperty("AAZ941", "AAZ941", c)).toBe("60");
    expect(resolveProperty("AAZ951", "AAZ951", c)).toBe("-10");
    expect(resolveProperty("AAZ898", "AAZ898", c)).toBe("2");
    expect(resolveProperty("BAD371", "BAD371", c)).toBe("Yes");
    expect(resolveProperty("AAB906", "AAB906", c)).toBe("70");
    expect(resolveProperty("AAG011", "AAG011", c)).toBe("1.5");
    expect(resolveProperty("AAZ485", "AAZ485", c)).toBe("Control");
    expect(resolveProperty("BAA097", "BAA097", c)).toBe("black");
    expect(resolveProperty("BAC078", "BAC078", c)).toBe("AC/DC");
    expect(resolveProperty("AAJ003", "AAJ003", c)).toBe("1.5");
    expect(resolveProperty("AAM076", "AAM076", c)).toBe("Yes");
    expect(resolveProperty("BAD803", "BAD803", c)).toBe("DC");
    expect(resolveProperty("BAD804", "BAD804", c)).toBe("PROFIsafe");
    expect(resolveProperty("BAD853", "BAD853", c)).toBe("Yes");
    expect(resolveProperty("AAO504", "AAO504", c)).toBe("2");
    expect(resolveProperty("BAD443", "BAD443", c)).toBe("Yes");
    expect(resolveProperty("AAB604", "AAB604", c)).toBe("Yes");
    expect(resolveProperty("AAB898", "AAB898", c)).toBe("600");
    expect(resolveProperty("AAG615", "AAG615", c)).toBe("Yes");
    expect(resolveProperty("AAC042", "AAC042", c)).toBe("Yes");
    expect(resolveProperty("AAC066", "AAC066", c)).toBe("500");
    expect(resolveProperty("AAC100", "AAC100", c)).toBe("12");
  });

  it("resolves late-pass device-tab fields across cable, safety, busbar and terminal families", () => {
    const c = ctx({
      normalized: { color: "black", material: "PVC" },
      attributes: [
        { name: "Cable outer diameter", value: "7.3 mm", sourceType: "official" },
        { name: "Number of wires", value: "4", sourceType: "official" },
        { name: "Cable length", value: "2 m", sourceType: "official" },
        { name: "Halogen free", value: "Yes", sourceType: "official" },
        { name: "Current input", value: "20 mA", sourceType: "official" },
        { name: "Seal present", value: "Yes", sourceType: "official" },
        { name: "Max. line cross section, rigid", value: "2.5 mm2", sourceType: "official" },
        { name: "Rated operating current AC-15", value: "(125 V) 2 A; (230 V) 1 A; (24 V) 3 A", sourceType: "official" },
        { name: "Max. operating pressure", value: "0.6 MPa", sourceType: "official" },
        { name: "Number of phases", value: "3", sourceType: "official" },
        { name: "Cross section", value: "10 mm2", sourceType: "official" },
        { name: "Terminal width", value: "6.2 mm", sourceType: "official" },
        { name: "Wire material", value: "Copper", sourceType: "official" },
        { name: "Front door present", value: "Yes", sourceType: "official" },
        { name: "Rated output voltage", value: "230 V", sourceType: "official" }
      ]
    });

    expect(resolveProperty("BAD974", "00003D001", c)).toBe("7.3");
    expect(resolveProperty("AAP775", "\"00003E001\"", c)).toBe("4");
    expect(resolveProperty("BAI969", "BAI969", c)).toBe("2");
    expect(resolveProperty("AAL680", "AAL680", c)).toBe("Yes");
    expect(resolveProperty("AAC134", "AAC134", c)).toBe("0.02");
    expect(resolveProperty("AAB515", "AAB515", c)).toBe("Yes");
    expect(resolveProperty("BAC677", "BAC677", c)).toBe("2.5");
    expect(resolveProperty("AAB465", "AAB465", c)).toBe("1");
    expect(resolveProperty("AAA900", "AAA900", c)).toBe("6");
    expect(resolveProperty("AAP621", "AAP621", c)).toBe("3");
    expect(resolveProperty("BAC892", "BAC892", c)).toBe("10");
    expect(resolveProperty("AAB507", "AAB507", c)).toBe("6.2");
    expect(resolveProperty("AAN530", "CNS_CORE_MATERIAL", c)).toBe("Copper");
    expect(resolveProperty("AAC268", "AAC268", c)).toBe("Yes");
    expect(resolveProperty("BAE107", "BAE107", c)).toBe("230");
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

  it("normalizes torque values used by PDT mechanical columns", () => {
    expect(normalizePdtCellNumber("2.5 Nm", "Nm")).toBe("2.5");
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

  it("parses multiline legends whose last visible option is followed by an ellipsis", () => {
    const ip = [
      "degree of protection",
      "1 - IP65/IP67",
      "2 - IP00",
      "3 - IP20",
      "..."
    ].join("\n");

    expect(encodeEnum(ip, "IP20")).toBe("3");
  });

  it("allows standard IP labels when the Master PDT enum legend is truncated", () => {
    const ip = "degree of protection 1 - without 2 - IPX8 3 - IPX6 4 - IPX4D 5 - IPX2 6 - IP68/IPX9K ...";
    const mountedIp = "Degree of protection (IP), mounted 1 - NEMA 2 - IP00 3 - IP20 ...";

    expect(encodeEnum(ip, "IP20")).toBeUndefined();
    expect(encodeEnumLabel(ip, "IP20")).toBe("IP20");
    expect(encodeEnumLabel(mountedIp, "IP67")).toBe("IP67");
    expect(encodeEnumLabel(ip, "as per IEC 60529")).toBeUndefined();
  });

  it("allows standard material labels when the Master PDT enum legend is truncated", () => {
    const material = "material 1 - Real glas 2 - Thermoplast 3 - Polyvinylalkohol (PVA) ...";

    expect(encodeEnum(material, "carbon steel")).toBeUndefined();
    expect(encodeEnumLabel(material, "carbon steel")).toBe("steel");
    expect(encodeEnumLabel(material, "stainless steel")).toBe("stainless steel");
    expect(encodeEnumLabel("material of housing 1 - Plastic (PBT) 2 - Plastic (ABS) ...", "PBTP")).toBe("Plastic (PBT)");
    expect(encodeEnumLabel("material of housing 1 - Plastic (PBT) 2 - Plastic (ABS) 3 - Plastic ...", "ABS")).toBe("Plastic (ABS)");
    expect(encodeEnumLabel("material 1 - Real glas 2 - Thermoplast 3 - Polyvinylalkohol (PVA) ...", "Thermoplast, GF")).toBe("Thermoplast");
    expect(encodeEnumLabel("material 1 - Real glas 2 - Thermoplast 3 - Polyvinylalkohol (PVA) ...", "Polycarbonate")).toBe("Thermoplast");
    expect(encodeEnumLabel(material, "9AKK108466A1425")).toBeUndefined();
  });

  it("allows standard color labels when the Master PDT enum legend is truncated", () => {
    const color = "color 1 - Other 2 - cream white/electro white 3 - Stainless steel ...";

    expect(encodeEnum(color, "ANSI-61 gray (optional sub-panels white)")).toBeUndefined();
    expect(encodeEnumLabel(color, "ANSI-61 gray (optional sub-panels white)")).toBe("gray");
    expect(encodeEnumLabel(color, "white")).toBe("white");
  });

  it("maps source enum codes to labels when the value is already coded", () => {
    const protectionClass = "Protection class 1 - I 2 - II 3 - III";

    expect(encodeEnum(protectionClass, "3")).toBe("3");
    expect(encodeEnumLabel(protectionClass, "3")).toBe("III");
  });

  it("maps standard protection-class and switching labels when legends use ECLASS wording", () => {
    const protectionClass = "Operating resource protection class 1 - B 2 - C 3 - Protection class 1 4 - Protection class 2";
    const switching = "switching element function 1 - antivalent 2 - Automatic opener 3 - monostable ...";

    expect(encodeEnumLabel(protectionClass, "II")).toBe("Protection class 2");
    expect(encodeEnumLabel(protectionClass, "Protection class 1")).toBe("Protection class 1");
    expect(encodeEnumLabel(switching, "normally open")).toBe("Normally open contact");
    expect(encodeEnumLabel(switching, "Light-on")).toBeUndefined();
  });

  it("maps standard IK impact strength labels when the PDT legend is truncated", () => {
    const impact = "impact strength 1 - >IK10 2 - Miscellaneous 3 - IK00 4 - IK01 ...";

    expect(encodeEnumLabel(impact, "IK10 IEC 62262")).toBe("IK10");
  });

  it("maps standard metric thread labels when the PDT legend is truncated", () => {
    const thread = "Size of connection thread 1 - M63 2 - M54 3 - M32 4 - M25 5 - M8 ...";

    expect(encodeEnumLabel(thread, "M18")).toBe("M18");
    expect(encodeEnumLabel(thread, "M12x1")).toBe("M12");
  });

  it("maps combined NEMA ratings to the closest Master PDT combined legend", () => {
    const combinedNema = [
      "Degree of protection (NEMA)",
      "1 - NEMA 3, 4, 7, 9",
      "2 - NEMA 3, 4, 12",
      "3 - NEMA 7, 9",
      "4 - NEMA 1, 2, 3R, 12, 13",
      "5 - NEMA 1, 4X, 12K, Indoor use only, 13",
      "6 - NEMA 1, 2, 3, 3R, 4, 4X, 12K, 13",
      "7 - NEMA 1, 2, 3, 3R, 4, 4X, 12, 13"
    ].join("\n");
    const singleNema = "protection type (NEMA) 1 - NEMA 1 2 - NEMA 2 3 - NEMA 3 4 - NEMA 3R 5 - NEMA 3S 6 - NEMA 3X";

    expect(encodeEnumLabel(combinedNema, "NEMA Type 3R, 4, 12 and Type 13")).toBe("NEMA 1, 2, 3, 3R, 4, 4X, 12, 13");
    expect(encodeEnumLabel(singleNema, "NEMA Type 3R, 4, 12 and Type 13")).toBeUndefined();
  });

  it("maps standard display and approval labels only when the legend supports them", () => {
    const display = "Design of the display* 1 - Bar display 2 - Digital 3 - LED";
    const cableApproval = "Certificate approval 1 - BG-PRUFZERT 2 - CE 3 - CSA 4 - VDE mark of conformity";
    const sensorApproval = "Approval 1 - measuring instruments directive 2 - domestic 3 - DIN EN 1373";

    expect(encodeEnumLabel(display, "Output function- LED yellow")).toBe("LED");
    expect(encodeEnumLabel(cableApproval, "CE; cULus; WEEE; UKCA")).toBe("CE");
    expect(encodeEnumLabel(sensorApproval, "CE; cULus; WEEE; UKCA")).toBeUndefined();
    expect(encodeEnumLabel(cableApproval, "cULus61010-1_E174460")).toBeUndefined();
  });

  it("matches voltage enum ranges when the source gives a numeric voltage", () => {
    const voltage = "Supply voltage 1 - <220 V 2 - 230 V 3 - 400 V alternating current 4 - 440 V up to 480 V alternating current";

    expect(encodeEnum(voltage, "24 V DC")).toBe("1");
    expect(encodeEnum(voltage, "230 V AC")).toBe("2");
    expect(encodeEnum(voltage, "460 V AC")).toBe("4");

    const motorVoltage = "Rated voltage (reduced) 1 - 100-310 V 2 - 400/420 V 3 - 460/470 V 4 - up to 100 V";
    expect(encodeEnum(motorVoltage, "24")).toBe("4");
    expect(encodeEnum(motorVoltage, "420")).toBe("2");
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
    ws.getCell(6, 1).value = "English variable  description";
    ws.getCell(6, 2).value = "Article number";
    ws.getCell(6, 3).value = "Rated voltage";
    ws.getCell(7, 1).value = "Unit";
    ws.getCell(8, 1).value = "Body";
    ws.getCell(4, 4).value = "PropertyId";
    ws.getCell(5, 4).value = "PropertyName";
    ws.getCell(6, 4).value = "Description";
    ws.getCell(7, 4).value = "Unit";

    const descriptor = describeSheet(ws);
    expect(descriptor).toBeDefined();
    expect(descriptor!.propertyRow).toBe(4);
    expect(descriptor!.propertyNameRow).toBe(5);
    expect(descriptor!.firstBodyRow).toBe(8);
    expect(descriptor!.columns.map((col) => col.code)).toEqual(["AAO676", "BAH005"]);
    expect(descriptor!.columns.map((col) => col.description)).toEqual(["Article number", "Rated voltage"]);
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

  it("reports unclassified catalog numbers while still writing common PDT tabs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-unclassified-"));
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

    const docs = wb.addWorksheet("Additional Documents");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Body"].entries()) {
      docs.getCell(row + 1, 1).value = label;
    }
    docs.getCell(4, 2).value = "Articlenumber";
    docs.getCell(4, 3).value = "Document ID";
    docs.getCell(4, 4).value = "Document path";

    wb.addWorksheet("Connection Point Information");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "ZZZ unexplained catalog record",
        productUrl: "https://acme.test/products/UNK-001"
      },
      "UNK-001"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.missingSheets).toEqual([]);
    expect(result.unmappedDeviceTypes).toEqual([]);
    expect(result.unclassifiedCatalogNumbers).toEqual(["UNK-001"]);
    expect(result.filledSheets["Material Master Data"]).toBe(1);
    expect(result.filledSheets["Additional Documents"]).toBe(1);
    expect(new Set(result.keptSheets)).toEqual(
      new Set(["Material Master Data", "Additional Documents", "Connection Point Information"])
    );

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    expect(out.getWorksheet("Material Master Data")!.getRow(10).values).toContain("UNK-001");
    expect(valuesInWorksheet(out.getWorksheet("Additional Documents")!)).toContain("UNK-001");
    expect(out.getWorksheet("Connection Point Information")).toBeTruthy();
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
        description: "Wall mounted enclosure",
        localizedDescriptions: { de: { title: "Gehäuse", description: "Wandmontiertes Gehäuse" } }
      },
      "DESC-1"
    ).item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    // DE columns are populated from result.localizedDescriptions.de — never echoed from EN.
    expect(ws.getCell(10, 2).value).toBe("Wandmontiertes Gehäuse");
    expect(ws.getCell(10, 3).value).toBe("Gehäuse");
    expect(ws.getCell(10, 4).value).toBe("Wall mounted enclosure");
    expect(ws.getCell(10, 5).value).toBe("Enclosure");
  });

  it("leaves DE description columns blank when no localized DE text was scraped", async () => {
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
      "The AF40B-30-00RT-12 is a 3 pole - 690 V IEC or 600 UL contactor with RT terminals, controlling motors up to 18.5 kW / 400 V AC (AC-3) or 30 hp / 480 V UL.";
    const item = ctx({ description }, "AF40B-30-00RT-12").item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    // No localizedDescriptions.de on the result → DE column must stay blank rather than echo EN.
    expect(ws.getCell(10, 2).value).toBeNull();
    // EN column still gets the scraped English description.
    expect(ws.getCell(10, 3).value).toBe(description);
  });

  it("leaves DE description columns blank when localized text only echoes English", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-de-echo-"));
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
        description: "Wall mounted enclosure",
        localizedDescriptions: { de: { title: "Enclosure", description: "Wall mounted enclosure" } }
      },
      "DESC-2"
    ).item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(10, 2).value).toBeNull();
    expect(ws.getCell(10, 3).value).toBeNull();
    expect(ws.getCell(10, 4).value).toBe("Wall mounted enclosure");
    expect(ws.getCell(10, 5).value).toBe("Enclosure");
  });

  it("fills PDT columns from semantically equivalent scraped attribute labels", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-fuzzy-label-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "UNKNOWN_RATED_VOLTAGE";
    material.getCell(7, 2).value = "UNKNOWN_RATED_VOLTAGE";
    material.getCell(8, 2).value = "Rated voltage";
    material.getCell(9, 2).value = "V";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        attributes: [{ group: "PDF Technical Data", name: "Voltage rating", value: "240 V", sourceType: "generated" }]
      },
      "BR120"
    ).item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(10, 2).value).toBe(240);
  });

  it("writes Saginaw LPPL cabinet defaults into the final PDT", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-sce-lppl-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const cabinet = wb.addWorksheet("cabinet");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      cabinet.getCell(row + 1, 1).value = label;
    }
    const columns = [
      ["AAO676", "Article number"],
      ["REFERENCE_FEATURE_GROUP_ID", "ECLASS group"],
      ["BAB664", "Material"],
      ["BAC295", "Color"],
      ["BAF785", "Surface"],
      ["BAG975", "Degree of protection"],
      ["AAW361", "NEMA rating"]
    ] as const;
    for (const [index, [code, description]] of columns.entries()) {
      const col = index + 2;
      cabinet.getCell(4, col).value = code;
      cabinet.getCell(5, col).value = code;
      cabinet.getCell(6, col).value = description;
    }
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      { manufacturerId: "sce", attributes: [{ name: "Product Type", value: "Enclosure", sourceType: "generated" }] },
      "SCE-60EL4812LPPL",
      "Enclosure"
    ).item;
    await exportRunPdt({ manufacturer: { ...manufacturer, id: "sce" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("cabinet")!;
    expect(ws.getRow(8).values).toEqual([
      ,
      "SCE-60EL4812LPPL",
      27180101,
      "Carbon steel",
      "ANSI-61 gray",
      "Powder coating",
      "IP66",
      "NEMA Type 3R, 4, 12 and Type 13"
    ]);
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

  it("reports enum values that cannot be matched to the PDT legend", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-enum-issue-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const cabinet = wb.addWorksheet("cabinet");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      cabinet.getCell(row + 1, 1).value = label;
    }
    cabinet.getCell(4, 2).value = "AAO676";
    cabinet.getCell(5, 2).value = "CNSORDERNO";
    cabinet.getCell(6, 2).value = "Articlenumber";
    cabinet.getCell(4, 3).value = "AAB451";
    cabinet.getCell(5, 3).value = "AAB451";
    cabinet.getCell(6, 3).value = "Type of mounting 1 - Wall mounting 2 - Floor standing";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Wall enclosure",
        attributes: [
          { name: "Product Type", value: "Enclosure", sourceType: "official" },
          { name: "Type of mounting", value: "Ceiling", sourceType: "official" }
        ]
      },
      "CAB-ENUM-1"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.writeIssues).toEqual([
      expect.objectContaining({
        sheetName: "cabinet",
        catalogNumber: "CAB-ENUM-1",
        code: "AAB451",
        propName: "AAB451",
        value: "Ceiling",
        reason: "enum-unmatched"
      })
    ]);

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("cabinet")!;
    expect(ws.getCell(8, 1).value).toBe("CAB-ENUM-1");
    expect(ws.getCell(8, 2).value).toBeNull();
  });

  it("reports missing minimum Master PDT fields separately from enum issues", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-required-issue-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();

    const material = wb.addWorksheet("Material Master Data");
    material.getCell(4, 1).value = "Priority";
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(4, 2).value = "Must field";
    material.getCell(6, 2).value = "AAO676";
    material.getCell(7, 2).value = "CNSORDERNO";
    material.getCell(8, 2).value = "Articlenumber";

    const contactor = wb.addWorksheet("contactor a. fuses");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      contactor.getCell(row + 1, 1).value = label;
    }
    contactor.getCell(2, 2).value = "Must field";
    contactor.getCell(4, 2).value = "AAO676";
    contactor.getCell(5, 2).value = "AAO676";
    contactor.getCell(6, 2).value = "product article number of manufacturer";
    contactor.getCell(2, 3).value = "Must field";
    contactor.getCell(4, 3).value = "AAS575";
    contactor.getCell(5, 3).value = "AAS575";
    contactor.getCell(6, 3).value = "Power loss per pole";
    contactor.getCell(7, 3).value = "W";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "AF contactor",
        attributes: [{ name: "Product Type", value: "Contactor", sourceType: "official" }]
      },
      "CONTACTOR-1",
      "Contactor"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.writeIssues).toEqual([]);
    expect(result.requiredFieldIssues).toEqual([
      expect.objectContaining({
        sheetName: "contactor a. fuses",
        catalogNumber: "CONTACTOR-1",
        code: "AAS575",
        propName: "AAS575",
        reason: "required-missing"
      })
    ]);
  });

  it("does not use generic metadata fallback for enum labels covered by resolvers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-enum-metadata-"));
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

    const sensor = wb.addWorksheet("electronic sensor");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      sensor.getCell(row + 1, 1).value = label;
    }
    sensor.getCell(4, 2).value = "AAO676";
    sensor.getCell(5, 2).value = "CNSORDERNO";
    sensor.getCell(6, 2).value = "Articlenumber";
    sensor.getCell(4, 3).value = "BAG975";
    sensor.getCell(5, 3).value = "BAG975";
    sensor.getCell(6, 3).value = "degree of protection 1 - without 2 - IP20";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Inductive proximity sensor",
        attributes: [
          { name: "Product Type", value: "Inductive Proximity Sensor", sourceType: "official" },
          { name: "Degree of protection", value: "as per IEC 60529", sourceType: "official" }
        ]
      },
      "SENSOR-NO-IP"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.writeIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("electronic sensor")!;
    expect(ws.getCell(8, 1).value).toBe("SENSOR-NO-IP");
    expect(ws.getCell(8, 2).value).toBeNull();
  });

  it("uses exact PDT column metadata as a fallback when no specific resolver exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-column-metadata-fallback-"));
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

    const switchSheet = wb.addWorksheet("Switch");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      switchSheet.getCell(row + 1, 1).value = label;
    }
    switchSheet.getCell(4, 2).value = "AAO676";
    switchSheet.getCell(5, 2).value = "CNSORDERNO";
    switchSheet.getCell(6, 2).value = "Articlenumber";
    switchSheet.getCell(4, 3).value = "CUSTOM_TORQUE";
    switchSheet.getCell(5, 3).value = "CUSTOM_TORQUE";
    switchSheet.getCell(6, 3).value = "Maximum tightening torque [Nm]";
    switchSheet.getCell(7, 3).value = "Nm";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Selector switch",
        attributes: [
          { name: "Product Type", value: "Switch", sourceType: "official" },
          { name: "Max. tightening torque", value: "2.5 Nm", sourceType: "official" }
        ]
      },
      "SW-META-1"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.missingSheets).toEqual([]);
    expect(result.writeIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Switch")!;
    expect(ws.getCell(8, 1).value).toBe("SW-META-1");
    expect(ws.getCell(8, 2).value).toBe(2.5);
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

  it("fills Rockwell connection point rows from PDT-example-backed family rules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-connection-points-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const item = ctx(
      {
        manufacturerId: "rockwell",
        title: "Micro PLC controller",
        attributes: [
          { group: "General", name: "Product Type", value: "Programmable Logic Controller", sourceType: "official" },
          { group: "Electrical", name: "Supply voltage", value: "24 V DC", sourceType: "official" },
          { group: "I/O", name: "Digital inputs", value: "4", sourceType: "official" },
          { group: "I/O", name: "Digital outputs", value: "2", sourceType: "official" },
          { group: "Mechanical", name: "Mounting type", value: "DIN rail", sourceType: "official" }
        ]
      },
      "2080-LC20-20AWB"
    ).item;

    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "rockwell" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    expect(result.filledSheets["Connection Point Information"]).toBeGreaterThanOrEqual(9);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const values = valuesInWorksheet(out.getWorksheet("Connection Point Information")!);
    expect(values).toContain("2080-LC20-20AWB");
    expect(values).toContain("+DC10");
    expect(values).toContain("I-00");
    expect(values).toContain("O-00");
    expect(values).toContain("DIN rail mounting");
  });

  it("adds Rockwell PowerFlex drives to the power supply tab like the manual PDT example", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-rockwell-powerflex-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const item = ctx(
      {
        manufacturerId: "rockwell",
        title: "PowerFlex 755 AC Drive",
        attributes: [
          { name: "Product Type", value: "Variable Speed Drive", sourceType: "official" },
          { name: "Input Voltage", value: "400 V AC", sourceType: "official" },
          { name: "Rated output current", value: "3 A", sourceType: "official" }
        ]
      },
      "20G1ANC302JA0NNNNN"
    ).item;

    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "rockwell" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    expect(result.filledSheets["servo controller"]).toBe(1);
    expect(result.filledSheets["motors"]).toBe(1);
    expect(result.filledSheets["power supply devices"]).toBe(1);
  });

  it("fills product accessory rows from Rockwell signaling accessory evidence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-product-accessory-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const item = ctx(
      {
        manufacturerId: "rockwell",
        title: "3 Color 35mm LED Indicator",
        attributes: [
          { group: "Table", name: "Type", value: "Light Indicator", sourceType: "official" },
          { group: "PDF datasheet - Technical Data", name: "Accessories", value: "Vertical Mounting Brackets", sourceType: "official" },
          { group: "PDF datasheet - Technical Data", name: "AVM", value: "Vertical bracket", sourceType: "official" }
        ]
      },
      "852C-B24RGYQD5"
    ).item;

    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "rockwell" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    expect(result.filledSheets["Product Accessory"]).toBe(1);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const values = valuesInWorksheet(out.getWorksheet("Product Accessory")!);
    expect(values).toContain("852C-B24RGYQD5");
    expect(values).toContain("852C-ABVM");
    expect(values).toContain("accessory");
  });

  it("routes every known device type through common tabs and its mapped device tab", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-all-types-"));
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

    const docs = wb.addWorksheet("Additional Documents");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Body"].entries()) {
      docs.getCell(row + 1, 1).value = label;
    }
    docs.getCell(4, 2).value = "Articlenumber";
    docs.getCell(4, 3).value = "Document ID";
    docs.getCell(4, 4).value = "Document path";

    const addDeviceSheet = (sheetName: string) => {
      const sheet = wb.addWorksheet(sheetName);
      for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
        sheet.getCell(row + 1, 1).value = label;
      }
      sheet.getCell(4, 2).value = "AAO676";
      sheet.getCell(5, 2).value = "CNSORDERNO";
      sheet.getCell(6, 2).value = "Articlenumber";
    };

    const expectedCounts = new Map<string, number>();
    for (const sheetName of new Set(knownDeviceTypes().flatMap((deviceType) => deviceSheetsFor(deviceType)))) {
      addDeviceSheet(sheetName);
    }

    const items = knownDeviceTypes().map((deviceType, index) => {
      for (const sheetName of deviceSheetsFor(deviceType)) {
        expectedCounts.set(sheetName, (expectedCounts.get(sheetName) ?? 0) + 1);
      }
      const catalogNumber = `TYPE-${String(index + 1).padStart(3, "0")}`;
      return ctx(
        {
          title: deviceType,
          productUrl: `https://acme.test/products/${catalogNumber}`,
          attributes: [{ group: "General", name: "Product Type", value: deviceType, sourceType: "official" }]
        },
        catalogNumber
      ).item;
    });

    await wb.xlsx.writeFile(templatePath);
    const result = await exportRunPdt({ manufacturer, items, templatePath, outputPath });

    expect(result.missingSheets).toEqual([]);
    expect(result.unmappedDeviceTypes).toEqual([]);
    expect(result.unclassifiedCatalogNumbers).toEqual([]);
    expect(result.filledSheets["Material Master Data"]).toBe(items.length);
    expect(result.filledSheets["Additional Documents"]).toBeGreaterThanOrEqual(items.length);
    for (const [sheetName, count] of expectedCounts) {
      expect(result.filledSheets[sheetName]).toBe(count);
    }

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    expect(out.getWorksheet("Material Master Data")!.getCell(10, 2).value).toBe("TYPE-001");
    expect(out.getWorksheet("Material Master Data")!.getCell(9 + items.length, 2).value).toBe(
      `TYPE-${String(items.length).padStart(3, "0")}`
    );
  });

  it("exports every known device type against the real Master PDT template", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-real-master-all-types-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const expectedCounts = new Map<string, number>();
    const expectedCatalogsBySheet = new Map<string, string[]>();

    const items = knownDeviceTypes().map((deviceType, index) => {
      const catalogNumber = `REAL-${String(index + 1).padStart(3, "0")}`;
      for (const sheetName of deviceSheetsFor(deviceType)) {
        expectedCounts.set(sheetName, (expectedCounts.get(sheetName) ?? 0) + 1);
        const catalogs = expectedCatalogsBySheet.get(sheetName) ?? [];
        catalogs.push(catalogNumber);
        expectedCatalogsBySheet.set(sheetName, catalogs);
      }
      return ctx(
        {
          title: deviceType,
          productUrl: `https://acme.test/products/${catalogNumber}`,
          attributes: [{ group: "General", name: "Product Type", value: deviceType, sourceType: "official" }]
        },
        catalogNumber
      ).item;
    });

    const result = await exportRunPdt({ manufacturer, items, templatePath, outputPath });

    expect(result.missingSheets).toEqual([]);
    expect(result.unmappedDeviceTypes).toEqual([]);
    expect(result.unclassifiedCatalogNumbers).toEqual([]);
    expect(result.filledSheets["Material Master Data"]).toBe(items.length);
    expect(result.filledSheets["Additional Documents"]).toBeGreaterThanOrEqual(items.length);
    for (const [sheetName, count] of expectedCounts) {
      expect(result.filledSheets[sheetName]).toBe(count);
    }

    const expectedKeptSheets = new Set([
      "Material Master Data",
      "Additional Documents",
      "Connection Point Information",
      "Product Accessory",
      ...expectedCounts.keys()
    ]);
    expect(new Set(result.keptSheets)).toEqual(expectedKeptSheets);
    expect(result.keptSheets).not.toContain("connector.optical");

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const materialOut = out.getWorksheet("Material Master Data")!;
    expect(materialOut.getRow(10).values).toContain("REAL-001");
    expect(materialOut.getRow(9 + items.length).values).toContain(`REAL-${String(items.length).padStart(3, "0")}`);

    const allCatalogs = items.map((item) => item.catalogNumber);
    for (const [sheetName, expectedCatalogs] of expectedCatalogsBySheet) {
      const ws = out.getWorksheet(sheetName)!;
      const actualCatalogs = [...new Set(valuesInWorksheet(ws).filter((value) => allCatalogs.includes(value)))];
      expect(actualCatalogs.sort(), sheetName).toEqual([...expectedCatalogs].sort());
    }
  });

  it("exports locally observed mixed-device regressions into their real Master PDT tabs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-real-observed-mixed-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");

    const itemFor = (overrides: Partial<ProductResult>, catalogNumber: string) =>
      ctx(
        {
          productUrl: `https://example.test/products/${encodeURIComponent(catalogNumber)}`,
          ...overrides
        },
        catalogNumber
      ).item;

    const items = [
      itemFor(
        {
          manufacturerId: "balluff",
          title: "BDG FB058-BCR6-DSRB2-1417-0000-S8R1 (BDG - FXX58-BC Series - SSI) Absolute encoders"
        },
        "BDG FB058-BCR6-DSRB2-1417-0000-S8R1"
      ),
      itemFor(
        {
          manufacturerId: "abb",
          title: "1st PLC E2.3..E6.3 Padlocks o.p. left",
          attributes: [
            { group: "ABB Product Data", name: "Extended Product Type", value: "1st PLC E2.3..E6.3 Padlocks o.p. left", sourceType: "official" },
            { group: "ABB Product Data", name: "Product Name", value: "Accessory", sourceType: "official" },
            { group: "ABB Product Data", name: "ETIM 10", value: "EC002051 - Padlock barrier for switch", sourceType: "official" },
            { group: "ABB Product Data", name: "eClass", value: "V13.0 : 27371307", sourceType: "official" },
            { group: "ABB Product Data", name: "UNSPSC", value: "46171501", sourceType: "official" }
          ]
        },
        "1SDA126387R1"
      ),
      itemFor(
        {
          manufacturerId: "rockwell",
          title: "CompactLogix DC 4A/2A Power Supply"
        },
        "1769-PB4"
      ),
      itemFor(
        {
          manufacturerId: "sce",
          title: "SCE-AC3400B120V",
          attributes: [{ group: "SCE Product Data", name: "Product Type", value: "Conditioner, Air - 3400 BTU/Hr. 120 Volt", sourceType: "official" }]
        },
        "SCE-AC3400B120V"
      ),
      itemFor(
        {
          manufacturerId: "sce",
          title: "P-P11R2-K3RF0-U450",
          attributes: [{ group: "SCE Product Data", name: "Product Type", value: "Port, Programming", sourceType: "official" }]
        },
        "P-P11R2-K3RF0-U450"
      ),
      itemFor(
        {
          manufacturerId: "sce",
          title: "SCE-SSCLEAN",
          attributes: [{ group: "SCE Product Data", name: "Product Type", value: "Stainless Steel Cleaner", sourceType: "official" }]
        },
        "SCE-SSCLEAN"
      ),
      itemFor(
        {
          manufacturerId: "abb",
          title: "E1.3 - ABB Low Voltage & Systems",
          description: "ABB Low Voltage & Systems > Low Voltage Products & Systems > Circuit Breakers > Air Circuit Breakers > Emax 3 > E1.3 3D CAD models"
        },
        "1SDA124715R1"
      ),
      itemFor(
        {
          manufacturerId: "eta",
          title: "Type 1140-E",
          description: "Thermal Overcurrent Circuit Breakers engineered for resettable protection against overloads and short circuits."
        },
        "1140-E"
      ),
      itemFor(
        {
          manufacturerId: "siemens",
          title: "VSG519K15-5 - Siemens Field Control Equipment",
          description: "SIEMENS branded, VSG519K15-5 diff.press.regulator, VSG519K15-5"
        },
        "BPZ:VSG519K15-5"
      )
    ];

    const expectedCatalogsBySheet = new Map<string, string[]>([
      ["electronic sensor", ["BDG FB058-BCR6-DSRB2-1417-0000-S8R1"]],
      ["power supply devices", ["1769-PB4"]],
      ["cabinet.airconditioning", ["SCE-AC3400B120V"]],
      ["connector", ["P-P11R2-K3RF0-U450"]],
      ["cabinet.mechanical", ["SCE-SSCLEAN"]],
      // ABB 1SDA articles are forced to "contactor a. fuses" only — mirrors the manual PDT layout.
      ["contactor a. fuses", ["1SDA124715R1", "1SDA126387R1", "1140-E"]],
      ["ventil", ["BPZ:VSG519K15-5"]]
    ]);

    const result = await exportRunPdt({ manufacturer, items, templatePath, outputPath });

    expect(result.missingSheets).toEqual([]);
    expect(result.unmappedDeviceTypes).toEqual([]);
    expect(result.unclassifiedCatalogNumbers).toEqual([]);
    expect(result.filledSheets["Material Master Data"]).toBe(items.length);
    expect(result.filledSheets["Additional Documents"]).toBeGreaterThanOrEqual(items.length);
    for (const [sheetName, catalogs] of expectedCatalogsBySheet) {
      expect(result.filledSheets[sheetName]).toBe(catalogs.length);
    }
    expect(result.keptSheets).not.toContain("PLC");

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const allCatalogs = items.map((item) => item.catalogNumber);
    const materialCatalogs = [...new Set(valuesInWorksheet(out.getWorksheet("Material Master Data")!).filter((value) => allCatalogs.includes(value)))];
    expect(materialCatalogs.sort()).toEqual([...allCatalogs].sort());
    const documentCatalogs = [...new Set(valuesInWorksheet(out.getWorksheet("Additional Documents")!).filter((value) => allCatalogs.includes(value)))];
    expect(documentCatalogs.sort()).toEqual([...allCatalogs].sort());

    for (const [sheetName, expectedCatalogs] of expectedCatalogsBySheet) {
      const ws = out.getWorksheet(sheetName)!;
      const actualCatalogs = [...new Set(valuesInWorksheet(ws).filter((value) => allCatalogs.includes(value)))];
      expect(actualCatalogs.sort(), sheetName).toEqual([...expectedCatalogs].sort());
    }
  });

  it("fills focused lower-coverage device tabs from matching source attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-focused-low-coverage-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const attribute = (name: string, value: string, group = "Technical") => ({
      group,
      name,
      value,
      sourceType: "official" as const
    });
    const itemFor = (
      catalogNumber: string,
      title: string,
      attributes: ProductResult["attributes"],
      normalized: ProductResult["normalized"] = {}
    ) =>
      ctx(
        {
          title,
          productUrl: `https://acme.test/products/${encodeURIComponent(catalogNumber)}`,
          normalized,
          attributes
        },
        catalogNumber
      ).item;

    const cases = [
      {
        sheet: "cable ducts mounting rails",
        catalog: "LOW-WIREWAY",
        minValues: 9,
        expectedValues: ["LOW-WIREWAY", "DIN EN 60715", "25", "galvanized", "Yes", "1.5", "50"],
        item: itemFor(
          "LOW-WIREWAY",
          "Steel wireway cable duct mounting rail",
          [
            attribute("Product Type", "Wireway"),
            attribute("Rail version according to standard", "DIN EN 60715"),
            attribute("Bore holes distance", "25 mm"),
            attribute("Surface treatment", "galvanized"),
            attribute("Suitable for circuit integrity", "Yes"),
            attribute("Thickness of material", "1.5 mm"),
            attribute("Width of the tray", "50 mm"),
            attribute("Material", "Steel")
          ],
          { material: "Steel" }
        )
      },
      {
        sheet: "el. mesurement devices",
        catalog: "LOW-MEAS",
        minValues: 8,
        expectedValues: ["LOW-MEAS", "Yes", "600", "10", "2"],
        item: itemFor("LOW-MEAS", "Digital current sensor electrical measurement device", [
          attribute("Product Type", "Current Sensor"),
          attribute("Frequency measurement possible", "Yes"),
          attribute("Max voltage measuring range", "600 V"),
          attribute("Max current measurement value at DC", "10 A"),
          attribute("Number of voltage input channels", "2"),
          attribute("VDE tested", "Yes"),
          attribute("Degree of protection", "IP20")
        ])
      },
      {
        sheet: "module carrier frame",
        catalog: "LOW-CARRIER",
        minValues: 6,
        expectedValues: ["LOW-CARRIER", "6 modules", "6", "500", "IEC 60603"],
        item: itemFor(
          "LOW-CARRIER",
          "Contact module carrier frame",
          [
            attribute("Product Type", "Module Carrier"),
            attribute("Material of the contact carrier frame", "Polycarbonate"),
            attribute("Size", "6 modules"),
            attribute("Number of module positions", "6"),
            attribute("Insertion cycles min", "500"),
            attribute("Application standards", "IEC 60603")
          ],
          { material: "Polycarbonate" }
        )
      },
      {
        sheet: "Wire ID Information",
        catalog: "LOW-MARKER",
        minValues: 12,
        expectedValues: [
          "LOW-MARKER",
          "W1",
          "2.5",
          "14",
          "roundly",
          "conductor",
          "fine wire",
          "Copper",
          "screw terminal",
          "electrical connection",
          "3.2",
          "blue"
        ],
        item: itemFor(
          "LOW-MARKER",
          "Wire marker cable element identifier",
          [
            attribute("Product Type", "Wire Marker"),
            attribute("Wire ID", "W1"),
            attribute("Cross section", "2.5 mm2"),
            attribute("AWG", "14"),
            attribute("Design of wire", "roundly"),
            attribute("Function of wire", "conductor"),
            attribute("Construction of wire", "fine wire"),
            attribute("Material of wire", "Copper"),
            attribute("Connection description", "screw terminal"),
            attribute("Type of connection", "electrical connection"),
            attribute("Outer diameter of wire", "3.2 mm"),
            attribute("Colour of wire", "blue")
          ],
          { material: "Copper", color: "blue" }
        )
      },
      {
        sheet: "filters",
        catalog: "LOW-FILTER",
        minValues: 7,
        expectedValues: ["LOW-FILTER", "5", "2.5", "3", "10", "50"],
        item: itemFor("LOW-FILTER", "EMI line filter choke", [
          attribute("Product Type", "Filter"),
          attribute("Choking factor", "5 %"),
          attribute("Cross section multi wire", "2.5 mm2"),
          attribute("Power dissipation", "3 W"),
          attribute("Number of poles primary side", "3"),
          attribute("Filterbank capacity", "10 var"),
          attribute("Rated operating frequency", "50 Hz")
        ])
      },
      {
        sheet: "panel (HMI)",
        catalog: "LOW-HMI",
        minValues: 10,
        expectedValues: ["LOW-HMI", "Yes", "230", "4", "7", "800", "2"],
        item: itemFor("LOW-HMI", "HMI operator panel touch screen", [
          attribute("Product Type", "HMI"),
          attribute("IO-Link master", "Yes"),
          attribute("Supply voltage AC", "230 V"),
          attribute("Number of buttons with LED", "4"),
          attribute("Monitor diagonal", "7 inch"),
          attribute("Horizontal pixels", "800"),
          attribute("USB interfaces", "2"),
          attribute("Touch screen", "Yes"),
          attribute("Degree of protection", "IP65")
        ])
      },
      {
        sheet: "servo controller",
        catalog: "LOW-SERVO",
        minValues: 10,
        expectedValues: ["LOW-SERVO", "encoder", "12", "560", "1500", "230", "3", "400"],
        item: itemFor("LOW-SERVO", "Variable speed drive inverter servo drive", [
          attribute("Product Type", "Variable Speed Drive"),
          attribute("Design of the connectable sensor", "encoder"),
          attribute("Overload current", "12 A"),
          attribute("DC link voltage", "560 V"),
          attribute("Rated power", "1.5 kW"),
          attribute("Rated output voltage", "230 V"),
          attribute("Rated output current", "3 A"),
          attribute("Output phases", "3"),
          attribute("Output frequency", "400 Hz")
        ])
      },
      {
        sheet: "terminal endbracket",
        catalog: "LOW-END",
        minValues: 6,
        expectedValues: ["LOW-END", "screwable", "5", "gray", "10"],
        item: itemFor(
          "LOW-END",
          "Terminal end bracket accessory",
          [
            attribute("Product Type", "Terminal Accessory"),
            attribute("Type of locking", "screwable"),
            attribute("Width of spacing", "5 mm"),
            attribute("Height at lowest possible mounting", "10 mm"),
            attribute("Material", "Polyamide"),
            attribute("Color", "gray"),
            attribute("Mounting type", "DIN rail")
          ],
          { material: "Polyamide", color: "gray" }
        )
      }
    ];

    const result = await exportRunPdt({
      manufacturer,
      items: cases.map((testCase) => testCase.item),
      templatePath,
      outputPath
    });

    expect(result.missingSheets).toEqual([]);
    expect(result.unmappedDeviceTypes).toEqual([]);
    expect(result.unclassifiedCatalogNumbers).toEqual([]);
    for (const testCase of cases) {
      expect(result.filledSheets[testCase.sheet], testCase.sheet).toBe(1);
    }

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    for (const testCase of cases) {
      const row = rowValuesContaining(out.getWorksheet(testCase.sheet)!, testCase.catalog);
      expect(row.length, `${testCase.sheet} row ${testCase.catalog}`).toBeGreaterThanOrEqual(testCase.minValues);
      for (const expectedValue of testCase.expectedValues) {
        expect(row, `${testCase.sheet} row ${testCase.catalog}`).toContain(expectedValue);
      }
    }
  });
});

function valuesInWorksheet(ws: ExcelJS.Worksheet): string[] {
  const values: string[] = [];
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      const value = cellText(cell.value);
      if (value) values.push(value);
    });
  });
  return values;
}

function rowValuesContaining(ws: ExcelJS.Worksheet, value: string): string[] {
  let values: string[] = [];
  ws.eachRow((row) => {
    const rowValues: string[] = [];
    row.eachCell((cell) => {
      const text = cellText(cell.value);
      if (text) rowValues.push(text);
    });
    if (rowValues.includes(value)) values = rowValues;
  });
  return values;
}

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
      text: "https://new.abb.com/products/1SBL347060R1100",
      hyperlink: "https://new.abb.com/products/1SBL347060R1100"
    });
    expect(ws.getCell(8, 4).value).toEqual({
      text: "https://new.abb.com/products/de/1SBL347060R1100",
      hyperlink: "https://new.abb.com/products/de/1SBL347060R1100"
    });
    expect(ws.getCell(8, 5).value).toBe("german");
    expect(ws.getCell(9, 1).value).toBeNull();
    expect(ws.getCell(10, 1).value).toBe("1SBL347060R1200");
  });
});
