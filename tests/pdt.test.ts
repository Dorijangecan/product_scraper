import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ManufacturerConfig, ProductResult, RunItemRecord } from "../src/shared/types.js";
import { targetSheets, deviceSheetsFor } from "../src/server/pdt/device-sheet-map.js";
import {
  deviceSheetsFromProfile,
  eclassDefaultForDeviceType,
  electricalFieldsForDeviceType,
  finalCompletenessFieldsForDeviceType,
  isSignalDeviceType
} from "../src/server/pdt/device-type-profiles.js";
import { knownDeviceTypes } from "../src/server/scrapers/device-type.js";
import { hasPropertyResolver, resolveProperty, type ResolveContext } from "../src/server/pdt/eclass-resolvers.js";
import { cellText, describeSheet } from "../src/server/pdt/sheet-descriptor.js";
import { encodeEnum, encodeEnumLabel, isEnumColumn } from "../src/server/pdt/enum-encode.js";
import { writeDocumentsSheet } from "../src/server/pdt/documents-sheet.js";
import { buildPdtRepairMap, buildPdtRepairResult } from "../src/server/pdt/ai-cleanup.js";
import { exportRunPdt } from "../src/server/pdt/exporter.js";
import { CURATED_ACCESSORY_RULES } from "../src/server/pdt/product-accessory-sheet.js";
import { bestFact, buildPdtFactIndex, PDT_ONTOLOGY_FACT_KEYS, PDT_ONTOLOGY_QUANTITY_FACT_KEYS } from "../src/server/pdt/facts.js";
import { normalizePdtCellNumber } from "../src/server/pdt/unit-cleanup.js";
import { PDT_EXCEPTION_RULES, pdtExceptionRule } from "../src/server/pdt/pdt-exceptions.js";
import { repairFinalCompletenessFromEvidence } from "../src/server/scrapers/final-completeness.js";
import { localizedPdtDocumentUrlRules } from "../src/server/pdt/rules.js";

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

  it("uses the device-type profile registry as the sheet-routing source", () => {
    for (const deviceType of ["Pilot Light", "Stack Light / Beacon", "Terminal Block", "I/O Module", "Variable Speed Drive"]) {
      expect(deviceSheetsFor(deviceType)).toEqual(deviceSheetsFromProfile(deviceType));
    }
  });

  it("keeps semantic signal-device and ECLASS defaults in the device-type profile", () => {
    expect(isSignalDeviceType("Stack Light / Beacon")).toBe(true);
    expect(isSignalDeviceType("Terminal Block")).toBe(false);
    expect(eclassDefaultForDeviceType("Stack Light / Beacon", "command and alarm device")).toEqual({ code: "27143221", system: "13" });
    expect(eclassDefaultForDeviceType("Terminal Block", "terminal")).toEqual({ code: "27250101", system: "14" });
    expect(eclassDefaultForDeviceType("I/O Module", "PLC")).toEqual({ code: "27242604", system: "14" });
    expect(eclassDefaultForDeviceType("Variable Speed Drive", "motors")).toEqual({ code: "27023101", system: "14" });
  });

  it("declares electrical required-field behavior in the device-type profile for every known type", () => {
    for (const deviceType of knownDeviceTypes()) {
      expect(electricalFieldsForDeviceType(deviceType), deviceType).toBeDefined();
    }
    expect(electricalFieldsForDeviceType("Communication Gateway")).toEqual(["voltage"]);
    expect(electricalFieldsForDeviceType("Contactor")).toEqual(["voltage", "current"]);
    expect(electricalFieldsForDeviceType("Enclosure")).toEqual([]);
  });

  it("keeps enclosure protection in the device-type final-completeness profile", () => {
    expect(finalCompletenessFieldsForDeviceType("Enclosure")).toContain("protection");
  });

  it("keeps signal lamp color in signal-device final-completeness profiles", () => {
    for (const deviceType of ["Pushbutton / Operator", "Pilot Light", "Stack Light / Beacon"]) {
      expect(finalCompletenessFieldsForDeviceType(deviceType), deviceType).toContain("color");
    }
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

  it("uses the gb/en-gb skuPage without inventing an EP- prefix for Eaton product URLs", () => {
    const c = ctx({ manufacturerId: "eaton" }, "502419");
    c.manufacturer = { ...manufacturer, id: "eaton" } as ManufacturerConfig;
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe(
      "https://www.eaton.com/gb/en-gb/skuPage.502419.html"
    );
    // Already-prefixed inputs are preserved for legacy rows that really use an EP skuPage.
    const c2 = ctx({ manufacturerId: "eaton" }, "EP-502420");
    c2.manufacturer = { ...manufacturer, id: "eaton" } as ManufacturerConfig;
    expect(resolveProperty("AAQ326", "AAQ326", c2)).toBe(
      "https://www.eaton.com/gb/en-gb/skuPage.EP-502420.html"
    );
  });

  it("prefers the actual Eaton skuPage found by the scraper over catalog-based PDT fallbacks", () => {
    const c = ctx(
      {
        manufacturerId: "eaton",
        productUrl: "https://www.eaton.com/gb/en-gb/skuPage.284245.html"
      },
      "XSFH20"
    );
    c.manufacturer = { ...manufacturer, id: "eaton" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.eaton.com/gb/en-gb/skuPage.284245.html");
    expect(resolveProperty("AAY811", "AAY811", c)).toBe("https://www.eaton.com/gb/en-gb/skuPage.284245.html");
  });

  it("prefers the actual ABB product page found by the scraper over catalog-based PDT fallbacks", () => {
    const productUrl = "https://www.abb.com/global/en/products/1sap250500r0001";
    const c = ctx(
      {
        manufacturerId: "abb",
        productUrl
      },
      "AC522"
    );
    c.manufacturer = { ...manufacturer, id: "abb", canonicalName: "ABB" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe(productUrl);
    expect(resolveProperty("AAY811", "AAY811", c)).toBe(productUrl);
  });

  it("uses official ABB CP6610 CP600-Pro descriptions and abb.com family URL fallbacks", () => {
    const c = ctx(
      {
        manufacturerId: "abb",
        title: "CP600-Pro",
        description: "CP600-Pro panels feature multitouch glass displays and modern industrial design."
      },
      "CP6610"
    );
    c.manufacturer = { ...manufacturer, id: "abb", canonicalName: "ABB" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.abb.com/global/en/areas/motion/plc/control-panels/cp600-pro");
    expect(resolveProperty("AAY811", "AAY811", c)).toBe("https://www.abb.com/global/en/areas/motion/plc/control-panels/cp600-pro");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("Control Panel CP600-Pro");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe(
      "CP6610, control panel, TFT graphical display, multi-touch screen, 10.1\", 1280 x 800 pixel, for PB610 applications and visualization of AC500 V3 web server"
    );
  });

  it("uses partnumber_info/?n= for Saginaw product URLs (manual PDT format)", () => {
    const c = ctx({ manufacturerId: "sce" }, "SCE-12H2406LP");
    c.manufacturer = { ...manufacturer, id: "sce" } as ManufacturerConfig;
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe(
      "https://www.saginawcontrol.com/partnumber_info/?n=SCE-12H2406LP"
    );
  });

  it("uses Saginaw product-spec description for enclosure PDT descriptions", () => {
    const c = ctx(
      {
        manufacturerId: "sce",
        title: "SCE-724824FSDAD",
        description: "FSDAD Enclosure",
        attributes: [{ group: "Product Specifications", name: "Description", value: "FSDAD Enclosure", sourceType: "official" }]
      },
      "SCE-724824FSDAD",
      "Enclosure"
    );
    c.manufacturer = { ...manufacturer, id: "sce" } as ManufacturerConfig;

    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("FSDAD Enclosure");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("Enclosure");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", { ...c, language: "de" })).toBe("Gehaeuse");
  });

  it("uses exact Rockwell details URLs for unknown Rockwell families", () => {
    const c = ctx({ manufacturerId: "rockwell" }, "5094-IF8");
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.rockwellautomation.com/en-us/products/details.5094-IF8.html");
    expect(resolveProperty("AAY811", "AAY811", c)).toBe("https://www.rockwellautomation.com/en-us/products/details.5094-IF8.html");
  });

  it("fills IEC 81346 class identifiers only from the IEC identifiers table", () => {
    expect(resolveProperty("AAC314", "AAC314", ctx({}, "CAB-1", "Cable"))).toBe("W");
    expect(resolveProperty("AAC314", "AAC314", ctx({}, "BUS-1", "Busbar"))).toBe("U");
    expect(resolveProperty("00001C001", "00001C001", ctx({}, "CB-1", "Circuit Breaker"))).toBe("F");
    expect(resolveProperty("AAC314", "AAC314", ctx({}, "SUB-1", "Subpanel"))).toBe("M");

    // No raw device category or scraped arbitrary IEC value may leak into AAC314.
    expect(resolveProperty("AAC314", "AAC314", ctx({}, "CONTACTOR-1", "Contactor"))).toBeUndefined();
    const explicit = ctx(
      { attributes: [{ name: "IEC 81346-2 Class Level 1", value: "X", sourceType: "official" }] },
      "CAT-1",
      "Contactor"
    );
    expect(resolveProperty("AAC314", "AAC314", explicit)).toBeUndefined();
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

  it("uses a longer description attribute when scraped title and description are identical", () => {
    const c = ctx({
      title: "Short relay name",
      description: "Short relay name",
      attributes: [
        {
          group: "Product Specifications",
          name: "Long Description",
          value: "General purpose relay with test button, manual override and pilot light",
          sourceType: "official"
        }
      ]
    });

    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("Short relay name");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("General purpose relay with test button, manual override and pilot light");
  });

  it("prefers fact-index descriptions before local description fallbacks", () => {
    const c = ctx({
      title: "Raw title",
      description: "Raw long description"
    });
    const pdtFacts = {
      facts: [],
      byKey: new Map([
        ["shortDescription", [{ key: "shortDescription", value: "Fact short", sourceKind: "repair", confidence: 0.9, reason: "test fact" }]],
        ["longDescription", [{ key: "longDescription", value: "Fact long", sourceKind: "repair", confidence: 0.9, reason: "test fact" }]],
        ["localizedShortDescriptionDe", [{ key: "localizedShortDescriptionDe", value: "Fakt kurz", sourceKind: "repair", confidence: 0.9, reason: "test fact" }]],
        ["localizedLongDescriptionDe", [{ key: "localizedLongDescriptionDe", value: "Fakt lang", sourceKind: "repair", confidence: 0.9, reason: "test fact" }]]
      ])
    } as NonNullable<ResolveContext["pdtFacts"]>;
    const withFacts = { ...c, pdtFacts };

    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", withFacts)).toBe("Fact short");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", withFacts)).toBe("Fact long");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", { ...withFacts, language: "de" })).toBe("Fakt kurz");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", { ...withFacts, language: "de" })).toBe("Fakt lang");
  });

  it("compacts recognizable family prefixes in short descriptions without manufacturer IDs", () => {
    const c = ctx(
      {
        manufacturerId: "generic-maker",
        title: "Compact 5000 DC Input Module Hi-Density",
        description: "Compact 5000 DC Input Module Hi-Density"
      },
      "GEN-DCIN-1"
    );

    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("DC-Input Module Hi-Density");
  });

  it("derives safe manufacturer family/base/designation fields from generic structured type evidence", () => {
    const hyphenated = ctx(
      { manufacturerId: "generic-maker", attributes: [{ name: "Model Code", value: "PSN-DRS-MT-ASMTAB", sourceType: "official" }] },
      "502419"
    );
    expect(resolveProperty("AAU731", "AAU731", hyphenated)).toBe("PSN");
    expect(resolveProperty("AAU732", "AAU732", hyphenated)).toBe("PSN-DRS-MT");
    expect(resolveProperty("AAU733", "AAU733", hyphenated)).toBe("ASMTAB");
    expect(resolveProperty("AAW338", "AAW338", hyphenated)).toBe("PSN-DRS-MT");

    const alphaNumeric = ctx(
      { manufacturerId: "generic-maker", attributes: [{ name: "Extended Product Type", value: "AF40B-30-00RT-12", sourceType: "official" }] },
      "1SBL347060R1100"
    );
    expect(resolveProperty("AAU731", "AAU731", alphaNumeric)).toBe("AF");
    expect(resolveProperty("AAU732", "AAU732", alphaNumeric)).toBe("AF40B");

    const titlePrefixed = ctx({ manufacturerId: "generic-maker", title: "1492J Terminal Block" }, "1492-J4");
    expect(resolveProperty("AAU731", "AAU731", titlePrefixed)).toBe("1492J");
    expect(resolveProperty("AAW338", "AAW338", titlePrefixed)).toBe("Terminal Block");

    const sceLppl = ctx({ manufacturerId: "sce" }, "SCE-60EL4812LPPL");
    sceLppl.manufacturer = { ...manufacturer, id: "sce" } as ManufacturerConfig;
    expect(resolveProperty("AAU731", "AAU731", sceLppl)).toBeUndefined();
    expect(resolveProperty("AAU732", "AAU732", sceLppl)).toBeUndefined();
    expect(resolveProperty("AAW338", "AAW338", sceLppl)).toBeUndefined();
  });

  it("does not use Eaton skuPage metadata as the manufacturer product family", () => {
    const c = ctx(
      {
        manufacturerId: "eaton",
        attributes: [
          { group: "Page metadata", name: "Product Family", value: "sku page", sourceType: "official" },
          { group: "Page metadata", name: "Product Core Group", value: "Industrial controls", sourceType: "official" }
        ]
      },
      "142824"
    );
    c.manufacturer = { ...manufacturer, id: "eaton" } as ManufacturerConfig;

    expect(resolveProperty("AAU731", "AAU731", c)).toBe("Industrial controls");
  });

  it("does not use download placeholders for required Material Master family/base/designation fields", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "1756-L82E",
        description: "ControlLogix 5580 Controller with 5 MB User Memory, USB Port, 1 gigabit Ethernet port",
        attributes: [
          {
            group: "Accessories",
            name: "Material",
            value: "Ethylene Propylene Diene Monomer (EPDM). Do not order part number CP-USB-B, as it is made of silicone rubber.",
            sourceType: "official"
          },
          { group: "Physical", name: "Height", value: "auto } .thumbnail {", sourceType: "official" },
          { group: "Downloads", name: "Product Family", value: "Download(ZIP)", sourceType: "official" },
          { group: "Downloads", name: "Product Range", value: "Download", sourceType: "official" },
          { group: "Downloads", name: "Product Base", value: "ZIP", sourceType: "official" },
          { group: "Downloads", name: "Product Type", value: "Download(ZIP)", sourceType: "official" },
          { group: "Downloads", name: "Extended Product Type", value: "Download(ZIP)", sourceType: "official" }
        ]
      },
      "1756-L82E"
    );

    expect(resolveProperty("AAU731", "AAU731", c)).toBeUndefined();
    expect(resolveProperty("AAU732", "AAU732", c)).toBeUndefined();
    expect(resolveProperty("AAW338", "AAW338", c)).toBeUndefined();
    expect(resolveProperty("AAV774", "CNSTYPECODE", c)).toBe("1756-L82E");
    expect(resolveProperty("CNS_ELECTRO_MATERIAL", "CNS_ELECTRO_MATERIAL", c)).toBeUndefined();
    expect(resolveProperty("BAB577", "BAB577", c)).toBe("139.6");
    expect(resolveProperty("BAF016", "BAF016", c)).toBe("34.55");
    expect(resolveProperty("BAA020", "BAA020", c)).toBe("145.2");
  });

  it("normalizes Rockwell 1444-DYN04 PDT typecode, descriptions and dimensions", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: ".cls-1 { fill: #003e7e; } .cls-2 { fill: #6d6e71; } 2019_AB_Logo",
        description: ".cls-1 { fill: #003e7e; } .cls-2 { fill: #6d6e71; } 2019_AB_Logo",
        localizedDescriptions: {
          de: {
            title: ".cls-1 { fill: #003e7e; } .cls-2 { fill: #6d6e71; } 2019_AB_Logo",
            description: ".cls-1 { fill: #003e7e; } .cls-2 { fill: #6d6e71; } 2019_AB_Logo"
          }
        },
        attributes: [
          {
            group: "PDF introduction",
            name: "Type",
            value: "The 1444 series consists of the Models shown in the table below:",
            sourceType: "official-fallback"
          },
          {
            group: "Header asset",
            name: "Product Type",
            value: ".cls-1 { fill: #003e7e; } .cls-2 { fill: #6d6e71; } 2019_AB_Logo",
            sourceType: "official"
          },
          { group: "Physical", name: "Height", value: "auto } .thumbnail {", sourceType: "official" }
        ]
      },
      "1444-DYN04-01RA"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell", canonicalName: "Rockwell Automation" } as ManufacturerConfig;

    expect(resolveProperty("AAV774", "CNSTYPECODE", c)).toBe("1444-DYN04-01RA");
    expect(resolveProperty("ABA671", "ABA671", c)).toBe("1444-DYN04-01RA");
    expect(resolveProperty("AAU734", "AAU734", c)).toBe("Dynamic Measurement Module");
    expect(resolveProperty("AAW338", "AAW338", c)).toBeUndefined();
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("Dynamic Measurement Module");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("Dynamic Measurement Module");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", { ...c, language: "de" })).toBe("Dynamic Measurement Modul");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", { ...c, language: "de" })).toBe("Dynamic Measurement Modul");
    expect(resolveProperty("BAB577", "BAB577", c)).toBe("154");
    expect(resolveProperty("BAF016", "BAF016", c)).toBe("102");
    expect(resolveProperty("BAA020", "BAA020", c)).toBe("106");
  });

  it("does not write Rockwell SVG/CSS asset text into PDT description cells", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-rockwell-1444-desc-"));
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

    const noisy = ".cls-1 { fill: #003e7e; } .cls-2 { fill: #6d6e71; } 2019_AB_Logo";
    const item = ctx(
      {
        manufacturerId: "rockwell",
        title: noisy,
        description: noisy,
        localizedDescriptions: { de: { title: noisy, description: noisy } },
        attributes: [{ group: "Header asset", name: "Product Type", value: noisy, sourceType: "official" }]
      },
      "1444-DYN04-01RA"
    ).item;

    await exportRunPdt({
      manufacturer: { ...manufacturer, id: "rockwell", canonicalName: "Rockwell Automation" } as ManufacturerConfig,
      items: [item],
      templatePath,
      outputPath
    });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe("Dynamic Measurement Modul");
    expect(ws.getCell(11, 3).value).toBe("Dynamic Measurement Modul");
    expect(ws.getCell(11, 4).value).toBe("Dynamic Measurement Module");
    expect(ws.getCell(11, 5).value).toBe("Dynamic Measurement Module");

    const writtenText = (ws.getRow(11).values as ExcelJS.CellValue[]).map((value) => String(value ?? "")).join(" ");
    expect(writtenText).not.toMatch(/\.cls-\d+|fill\s*:\s*#|AB_Logo/i);
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

  it("writes Saginaw imperial weight to PDT (not skipped as unproven)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-sce-weight-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "AAF040";
    material.getCell(7, 2).value = "CNS_MASSEXACT";
    material.getCell(8, 2).value = "Weight /Mass (netto)";
    material.getCell(6, 3).value = "BAD875";
    material.getCell(7, 3).value = "BAD875";
    material.getCell(8, 3).value = "Net weight";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    // Mirror the SCE scrape: imperial attribute + dual-unit normalized string. Before the fix the
    // resolver derived "11.793" but inferCellProvenance couldn't substring-match that against the
    // "26.00 lbs (11.79 kg)" fact, so the cell was skipped as "unproven".
    const item = ctx({
      manufacturerId: "sce",
      normalized: { weight: "26.00 lbs (11.79 kg)" },
      attributes: [
        { group: "Product Specifications", name: "Weight", value: "26.00 lbs", sourceType: "official", parser: "sce-product-page" }
      ]
    }, "SCE-NBP6818").item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe(11.793);
    expect(ws.getCell(11, 3).value).toBe(11793);
  });

  it("converts imperial weight (lbs) to kg and grams via the normalizer's dual-unit string", () => {
    // Saginaw publishes shipping weight in pounds and the normalizer wraps it as
    // "26.00 lbs (11.79 kg)". The PDT weight resolvers must reach kg/g, not echo the
    // dual-unit display string.
    const c = ctx({ normalized: { weight: "26.00 lbs (11.79 kg)" } });
    expect(resolveProperty("CNS_MASSEXACT", "CNS_MASSEXACT", c)).toBe("11.793");
    expect(resolveProperty("AAF040", "AAF040", c)).toBe("11.793");
    expect(resolveProperty("BAD875", "BAD875", c)).toBe("11793");
  });

  it("does not repair product weight from unlabeled numeric text", () => {
    const c = ctx(
      {
        manufacturerId: "abb",
        normalized: {},
        attributes: [
          {
            group: "ABB Related Products",
            name: "Related Product",
            value: "1SDA124708R1 - Ekip family accessory, package example 14 kg",
            sourceType: "official"
          }
        ]
      },
      "1SDA124707R1"
    );
    const result = repairFinalCompletenessFromEvidence(
      c.result!,
      { ...manufacturer, id: "abb" } as ManufacturerConfig
    ).result;

    expect(result.normalized.weight).toBeUndefined();
    expect(result.attributes.some((attr) => attr.group === "Final Field Repair" && attr.name === "Weight")).toBe(false);
  });

  it("does not write ABB weight when product identity evidence belongs to another catalog", () => {
    const c = ctx(
      {
        manufacturerId: "abb",
        normalized: { weight: "14 kg" },
        attributes: [
          { name: "Product ID", value: "1SDA124708R1", sourceType: "official" },
          { name: "Product Net Weight", value: "14 kg", sourceType: "official" }
        ]
      },
      "1SDA124707R1"
    );
    c.manufacturer = { ...manufacturer, id: "abb" } as ManufacturerConfig;

    expect(resolveProperty("CNS_MASSEXACT", "CNS_MASSEXACT", c)).toBeUndefined();
    expect(resolveProperty("BAD875", "BAD875", c)).toBeUndefined();
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

  it("writes official Model Code into the combined typecode/product-type column for any manufacturer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-generic-typecode-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "AAV774/AAO057";
    material.getCell(7, 2).value = "CNSTYPECODE";
    material.getCell(8, 2).value = "Typecode";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        manufacturerId: "generic-maker",
        attributes: [
          { name: "Model Code", value: "XMC060602", sourceType: "official" },
          { name: "Product Type", value: "Cover / Door Accessory", sourceType: "official" }
        ]
      },
      "107987",
      "Cover / Door Accessory"
    ).item;
    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    expect(out.getWorksheet("Material Master Data")!.getCell(11, 2).value).toBe("XMC060602");
    const audit = JSON.parse(await fs.readFile(result.pdtAuditPath!, "utf8")) as { records: Array<{ code: string; value?: string; sourceKind?: string }> };
    expect(audit.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "AAV774/AAO057", value: "XMC060602", sourceKind: "attribute" })
      ])
    );
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
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", c)).toBe("ECLASS");
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

  it("fills ABB CP6610 HMI resolution, operating temperature and certificates from datasheet-style attributes", () => {
    const c = ctx(
      {
        manufacturerId: "abb",
        title: "Control Panel CP600-Pro",
        description: "CP6610, control panel, TFT graphical display, multi-touch screen, 10.1\", 1280 x 800 pixel, for PB610 applications and visualization of AC500 V3 web server",
        normalized: { certificates: "CE, cULus, DNV" },
        attributes: [
          { group: "ABB Datasheet", name: "Resolution", value: "1280 x 800 pixels", sourceType: "official" },
          { group: "ABB Datasheet", name: "Operating temperature", value: "-20...+60 °C", sourceType: "official" },
          { group: "ABB Datasheet", name: "Approvals and Certifications", value: "CE, cULus, DNV", sourceType: "official" }
        ]
      },
      "CP6610"
    );
    c.manufacturer = { ...manufacturer, id: "abb", canonicalName: "ABB" } as ManufacturerConfig;
    c.sheetName = "panel (HMI)";

    expect(resolveProperty("AAM494", "max. number of pixels, horizontal (integer)", c)).toBe("1280");
    expect(resolveProperty("AAM495", "max. number of pixels, vertical (integer)", c)).toBe("800");
    expect(resolveProperty("AAB906", "Max. operating temperature", c)).toBe("60");
    expect(resolveProperty("AAC022", "Min. operating temperature", c)).toBe("-20");
    expect(resolveProperty("BAC163", "Display type", c)).toBe("TFT");
    expect(resolveProperty("BAD443", "Touch screen present", c)).toBe("Yes");
    expect(resolveProperty("CERTIFICATION", "certificate/approval", c)).toBe("CE, cULus, DNV");
  });

  it("writes AC/DC voltage type only when it is explicitly written in the source", () => {
    const c = ctx({
      attributes: [{ name: "Rated Control Circuit Voltage", value: "24 V AC/DC" }]
    });
    c.sheetName = "contactor a. fuses";
    expect(resolveProperty("BAD915", "BAD915", c)).toBe("AC/DC");
  });

  it("does not hardcode Rockwell Micro PLC voltage type or power loss without source evidence", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "Micro820 20 Point Programmable Controller"
      },
      "2080-LC20-20AWB"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    c.sheetName = "PLC";

    expect(resolveProperty("BAD915", "BAD915", c)).toBeUndefined();
    expect(resolveProperty("AAS575", "AAS575", c)).toBeUndefined();
  });

  it("normalizes Rockwell Micro820 family PDT values when official family evidence is present", () => {
    const familyUrl = "https://www.rockwellautomation.com/en-us/products/hardware/allen-bradley/programmable-controllers/micro-controllers/micro800-family/micro820-controllers.html";
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "Micro820 Controller",
        description: "Micro820 Controller",
        localizedDescriptions: { de: { title: "Micro820-Steuerung", description: "Micro820-Steuerung" } },
        normalized: {
          weight: "0.38 kg",
          certificates: "UL, CE, RCM, KC, ABS, ODVA, BV, UKCA"
        },
        attributes: [
          { group: "Rockwell Family", name: "Product Family", value: "Micro820", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl },
          { group: "Rockwell Family", name: "Product Type", value: "Micro820 Controller", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl },
          { group: "Rockwell Family", name: "Product Net Weight", value: "0.38 kg", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl },
          { group: "Rockwell Family", name: "Power loss", value: "6 W", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl },
          { group: "Rockwell Family", name: "Current type", value: "DC", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl }
        ]
      },
      "2080-LC20-20AWB"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    c.sheetName = "PLC";

    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", c)).toBe("27242202");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", c)).toBe("14");
    expect(resolveProperty("AAF040", "AAF040", c)).toBe("0.38");
    expect(resolveProperty("AAS575", "AAS575", c)).toBe("6");
    expect(resolveProperty("BAB968", "BAB968", c)).toBe("DC");
    expect(resolveProperty("BAC065", "BAC065", c)).toBe("DC");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", { ...c, sheetName: "Material Master Data" })).toBe("Micro820 Controller");
    expect(localizedPdtDocumentUrlRules({ manufacturerId: "rockwell", catalogNumber: "2080-LC20-20AWB" }).map((rule) => rule.value)).toEqual([
      { url: familyUrl, language: "english", description: "Technical Datasheet (EN)", documentType: "pdf" }
    ]);
  });

  it("uses localized Eaton specification PDFs for Additional Documents", () => {
    const rules = localizedPdtDocumentUrlRules({ manufacturerId: "eaton", catalogNumber: "502419" }).map((rule) => rule.value);
    expect(rules).toEqual([
      {
        url: "https://www.eaton.com/gb/en-gb/skuPage.502419.pdf",
        language: "english",
        description: "Datasheet(EN)"
      },
      {
        url: "https://www.eaton.com/de/de-de/skuPage.502419.pdf",
        language: "german",
        description: "Datenblatt"
      }
    ]);
  });

  it("uses the Eaton E6 catalog PDF for CBE product and document URLs", () => {
    const c = ctx({ manufacturerId: "eaton" }, "CBE04417");
    c.manufacturer = { ...manufacturer, id: "eaton" } as ManufacturerConfig;
    const pdf = "https://www.eaton.com.cn/content/dam/eaton/products/electrical-circuit-protection/circuit-breakers/e6-series/eaton-e6-catalogue-en-cn.pdf";
    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe(pdf);
    expect(localizedPdtDocumentUrlRules({ manufacturerId: "eaton", catalogNumber: "CBE04417" }).map((rule) => rule.value)).toEqual([
      { url: pdf, language: "english", description: "Datasheet(EN)" },
      { url: pdf, language: "german", description: "Datenblatt" }
    ]);
  });

  it("fills quantity per packaging from Eaton PDF catalog unit data", () => {
    const c = ctx({ attributes: [{ name: "Unit per package", value: "12", sourceType: "official-fallback" }] });
    expect(resolveProperty("NOUPEROU", "NOUPEROU", c)).toBe("12");
  });

  it("fills Rockwell Compact 5000 I/O PLC import defaults without affecting unrelated PLCs", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "Compact 5000 DC Input Module Hi-Density",
        description: "Compact 5000 DC Input Module Hi-Density",
        normalized: { dimensions: "144.6 x 22 x 105.4 mm" },
        attributes: [
          { name: "Digital Inputs", value: "5069-IB32", sourceType: "official" },
          { name: "Product Net Width", value: "22 mm", sourceType: "official" }
        ]
      },
      "5069-IB32"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    c.sheetName = "PLC";

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.rockwellautomation.com/en-us/products/details.5069-IB32.html");
    expect(resolveProperty("AAY811", "AAY811", c)).toBe("https://www.rockwellautomation.com/en-us/products/details.5069-IB32.html");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", c)).toBe("27242604");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", c)).toBe("14");
    expect(resolveProperty("AAS575", "AAS575", c)).toBe("3.9");
    expect(resolveProperty("BAG975", "BAG975", c)).toBeUndefined();
    expect(resolveProperty("AAP508", "AAP508", c)).toBe("32");
    expect(resolveProperty("AAP610", "AAP610", c)).toBeUndefined();
    expect(resolveProperty("BAF016", "BAF016", { ...c, sheetName: "Material Master Data" })).toBeUndefined();
    expect(localizedPdtDocumentUrlRules({ manufacturerId: "rockwell", catalogNumber: "5069-IB32" }).map((rule) => rule.value)).toEqual([
      {
        url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5069-td001_-en-p.pdf",
        language: "english",
        description: "Technical Datasheet (EN)",
        documentType: "pdf"
      }
    ]);

    const output = ctx(
      {
        manufacturerId: "rockwell",
        attributes: [{ name: "Digital Outputs", value: "5069-OB32", sourceType: "official" }]
      },
      "5069-OB32",
      "Programmable Logic Controller"
    );
    output.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    output.sheetName = "PLC";
    expect(resolveProperty("AAP508", "AAP508", output)).toBeUndefined();
    expect(resolveProperty("AAP610", "AAP610", output)).toBe("32");

    const sparse = ctx({ manufacturerId: "rockwell" }, "5069-OB32", "Programmable Logic Controller");
    sparse.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    sparse.sheetName = "PLC";
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", sparse)).toBe("27242604");
  });

  it("derives Rockwell I/O point counts from catalog prefixes across families", () => {
    const samples = [
      ["5094-IB16", "AAP508", "16"],
      ["1756-OB16E", "AAP610", "16"],
      ["5094-IF8", "AAP341", "8"],
      ["1756-OF8", "AAP342", "8"]
    ] as const;

    for (const [catalogNumber, property, expected] of samples) {
      const c = ctx({ manufacturerId: "rockwell" }, catalogNumber, "I/O Module");
      c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
      c.sheetName = "PLC";
      expect(resolveProperty(property, property, c), catalogNumber).toBe(expected);
    }

    const analogInput = ctx({ manufacturerId: "rockwell" }, "5094-IF8", "I/O Module");
    analogInput.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    analogInput.sheetName = "PLC";
    expect(resolveProperty("AAP508", "AAP508", analogInput)).toBeUndefined();
  });

  it("writes compact Rockwell certification labels and trims Compact 5000 short descriptions", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "Compact 5000 DC Output Module Hi-Density",
        normalized: { certificates: "IECEx, UL, CE, UKCA, ATEX, CCC, RCM" },
        attributes: [
          { group: "Certifications", name: "Certification", value: "China CCC", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "MOROCCO DOC", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "UKCA DOC", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "IECEx Scheme", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "UL Listed", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "UK EX CERTIFICATE", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "ATEX", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "UL Listed Hazardous", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "Australian RCM", parser: "rockwell-product-page", sourceType: "official" },
          { group: "Certifications", name: "Certification", value: "CE", parser: "rockwell-product-page", sourceType: "official" }
        ]
      },
      "5069-OB32"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("CE, UL Listed, CCC, Morocco, UKCA, IECEx, ATEX, UL Listed Hazardous, RCM");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("DC-Output Module Hi-Density");
  });

  it("normalizes Rockwell 700-HB relay PDT descriptions, certificates, dimensions and operating temperatures", () => {
    const productUrl = "https://www.rockwellautomation.com/en-us/products/details.700-HB32A1-3-4.html";
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "120V 50/60Hz GP Tall Square Base Relay",
        description: "700-HB General Purpose Blade Base Relay, 15 Amp Contact, DPDT, 120V 50/60Hz, Push-To-Test & Manual Override function and Pilot Light",
        productUrl,
        localizedUrls: {
          en: productUrl,
          de: "https://www.rockwellautomation.com/de-de/products/details.700-HB32A1-3-4.html"
        },
        attributes: [
          { group: "Physical Characteristics", name: "Width", value: "38.2 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Physical Characteristics", name: "Height", value: "auto } .thumbnail {", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Physical Characteristics", name: "Depth", value: "35.8 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Compliance & Environment", name: "Operating temperature", value: "-40 °C", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Compliance & Environment", name: "Storage temperature", value: "-40 °C", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Certifications", name: "Certification", value: "CE", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Certifications", name: "Certification", value: "CSA Listed", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Certifications", name: "Certification", value: "Registro Italiano Navale", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Certifications", name: "Certification", value: "UL Listed", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Certifications", name: "Certification", value: "UL Recognized", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "700-HB32A1-3-4"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell", canonicalName: "Rockwell Automation" } as ManufacturerConfig;
    c.sheetName = "contactor a. fuses";

    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe(
      "700-HB General Purpose Blade Base Relay, 15 Amp Contact, DPDT, 120V 50/60Hz, Push-To-Test & Manual Override function and Pilot Light"
    );
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("120V 50/60Hz GP Tall Square Base Relay");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("CE, CSA Listed, RINA, UL Listed, UL Recognized");
    expect(resolveProperty("BAB577", "BAB577", c)).toBe("35.8");
    expect(resolveProperty("BAF016", "BAF016", c)).toBe("38.2");
    expect(resolveProperty("BAA020", "BAA020", c)).toBe("51.4");
    expect(resolveProperty("AAB906", "Max. operating temperature", c)).toBe("70");
    expect(resolveProperty("AAC022", "Min. operating temperature", c)).toBe("-40");
  });

  it("normalizes Rockwell ArmorKinetix DSM family PDT values", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "16 Amp Peak ArmorKinetix DSM",
        description: "16 Amp Peak ArmorKinetix DSM",
        normalized: {
          weight: "4.55 kg",
          certificates: "ODVA, UL Listed, Korean KC, Australian RCM, CE"
        },
        attributes: [
          { group: "Technical Data", name: "Product Net Weight", value: "4.55 kg", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "2198-DSM016-ERS2-A0751E-CJ12AA"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("16 Amp Peak ArmorKinetix DSM");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("16 Amp Peak ArmorKinetix DSM");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("ODVA, UL Listed, KC, RCM, CE");
    expect(resolveProperty("AAF040", "AAF040", c)).toBe("4.55");

    const sparse = ctx({ manufacturerId: "rockwell", title: "16 Amp Peak ArmorKinetix DSM" }, "2198-DSM016-ERS2-A0751E-CJ12AA");
    sparse.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("AAF040", "AAF040", sparse)).toBeUndefined();
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", sparse)).toBeUndefined();
  });

  it("normalizes Rockwell ArmorKinetix DSD family PDT values", async () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "ArmorKinetix Distributed Drive 16A ERS2",
        description: "ArmorKinetix Distributed Drive 16A ERS2",
        normalized: {
          weight: "2.05 kg",
          certificates: "CE, ODVA, UL Listed, Australian RCM, Safety, Korean KC"
        },
        attributes: [
          { group: "Technical Data", name: "Product Net Weight", value: "2.05 kg", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "2198-DSD016-ERS2"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe(
      "https://www.rockwellautomation.com/en-us/products/details.2198-DSD016-ERS2.html"
    );
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("ArmorKinetix Distributed Drive 16A ERS2");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("ArmorKinetix Distributed Drive 16A ERS2");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("CE, ODVA, UL Listed, RCM, Safety, KC");
    expect(resolveProperty("AAF040", "AAF040", c)).toBe("2.05");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...c, sheetName: "motors" })).toBe("27023101");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...c, sheetName: "motors" })).toBe("14");

    const sparse = ctx({ manufacturerId: "rockwell", title: "ArmorKinetix Distributed Drive 16A ERS2" }, "2198-DSD016-ERS2");
    sparse.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("AAF040", "AAF040", sparse)).toBeUndefined();
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", sparse)).toBeUndefined();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-rockwell-dsd-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "MANUFACTURER_URL";
    material.getCell(7, 2).value = "MANUFACTURER_URL";
    material.getCell(8, 2).value = "Manufacturer URL";
    material.getCell(6, 3).value = "AAF040";
    material.getCell(7, 3).value = "AAF040";
    material.getCell(8, 3).value = "Weight /Mass (netto)";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    await exportRunPdt({ manufacturer: c.manufacturer, items: [c.item], templatePath, outputPath });
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe("https://www.rockwellautomation.com/en-us.html");
    expect(ws.getCell(11, 3).value).toBe(2.05);
  });

  it("normalizes Rockwell ControlLogix L9 family PDT values", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "ControlLogix 5590 XT Controller",
        description: "ControlLogix 5590 XT Controller",
        normalized: {
          weight: "0.54 kg",
          certificates: "c-UL-us, FM, CE, RCM, ATEX, IECEx, UKCA, KC, CCC, TUV, Morocco"
        },
        attributes: [
          { group: "Technical Data", name: "Product Net Weight", value: "0.54 kg", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Power loss", value: "6.2 W", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "1756-L902TSXT"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.rockwellautomation.com/en-us/search.html?keyword=1756-L9&tab=all");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("ControlLogix 5590 XT Controller");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("ControlLogix 5590 XT Controller");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("c-UL-us, FM, CE, RCM, ATEX, IECEx, UKCA, KC, CCC, TÜV, Morocco");
    expect(resolveProperty("AAF040", "AAF040", c)).toBe("0.54");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...c, sheetName: "PLC" })).toBe("27242208");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...c, sheetName: "PLC" })).toBe("14");
    expect(resolveProperty("AAS575", "AAS575", { ...c, sheetName: "PLC" })).toBe("6.2");

    const sparse = ctx({ manufacturerId: "rockwell", title: "ControlLogix 5590 XT Controller" }, "1756-L902TSXT");
    sparse.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("AAF040", "AAF040", sparse)).toBeUndefined();
    expect(resolveProperty("AAS575", "AAS575", { ...sparse, sheetName: "PLC" })).toBeUndefined();
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", sparse)).toBeUndefined();
  });

  it("normalizes Rockwell 1492-PDE power distribution terminal block PDT values", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "200 A Enclosed Power Distribution Block",
        description: "200 A Enclosed Power Distribution Block",
        normalized: {
          weight: "0.148 kg",
          current: "200 A",
          certificates: "UL, Certificate Programs"
        },
        attributes: [
          { group: "Certifications", name: "Certification", value: "UL Listed", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Certifications", name: "Certification", value: "MOROCCO DOC", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Depth", value: "30.7 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Width", value: "68.9 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Height", value: "91.7 mm", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "1492-PDE1142"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.rockwellautomation.com/en-us/search.html?keyword=1492-PDE&tab=all");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("200 A Enclosed Power Distribution Block");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("200 A Enclosed Power Distribution Block");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("UL Listed, Morocco");
    expect(resolveProperty("BAB577", "BAB577", c)).toBe("30.7");
    expect(resolveProperty("BAF016", "BAF016", c)).toBe("68.9");
    expect(resolveProperty("BAA020", "BAA020", c)).toBe("91.7");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...c, sheetName: "terminal" })).toBe("27250101");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...c, sheetName: "terminal" })).toBe("14");

    const sparse = ctx({ manufacturerId: "rockwell", title: "200 A Enclosed Power Distribution Block" }, "1492-PDE1142");
    sparse.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("BAB577", "BAB577", sparse)).toBeUndefined();
    expect(resolveProperty("BAF016", "BAF016", sparse)).toBeUndefined();
    expect(resolveProperty("BAA020", "BAA020", sparse)).toBeUndefined();
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", sparse)).toBeUndefined();
  });

  it("normalizes Rockwell Stratix 2100 unmanaged switch PDT values", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "Stratix 2000 8T Port Unmanaged Switch",
        description: "Stratix 2000 8T Port Unmanaged Switch",
        normalized: {
          weight: "0.407 kg",
          dimensions: "114.50 x 45.60 x 77.20 mm",
          current: "0.51 A",
          voltage: "48 V DC",
          certificates: "c-UL-us, CE, Ex, RCM, IECEx, KC"
        },
        attributes: [
          { group: "Technical Data", name: "Product Net Weight", value: "0.407 kg", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Depth", value: "77.20 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Width", value: "45.60 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Height", value: "114.50 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Supply voltage", value: "48 V DC", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Rated current", value: "0.51 A", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Power loss", value: "4.04 W", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Voltage type", value: "AC/DC", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "1783-US8T"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.rockwellautomation.com/en-us/products/details.1783-US8T.html");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("Stratix 2000 8T Port Unmanaged Switch");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("Stratix 2000 8T Port Unmanaged Switch");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("c-UL-us, CE, Ex, RCM, IECEx, KC");
    expect(resolveProperty("AAF040", "AAF040", c)).toBe("0.407");
    expect(resolveProperty("BAB577", "BAB577", c)).toBe("77.20");
    expect(resolveProperty("BAF016", "BAF016", c)).toBe("45.60");
    expect(resolveProperty("BAA020", "BAA020", c)).toBe("114.50");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...c, sheetName: "PLC" })).toBe("27242201");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...c, sheetName: "PLC" })).toBe("13");
    expect(resolveProperty("AAB909", "AAB909", { ...c, sheetName: "PLC" })).toBe("48");
    expect(resolveProperty("AAF726", "AAF726", { ...c, sheetName: "PLC" })).toBe("0.51");
    expect(resolveProperty("AAS575", "AAS575", { ...c, sheetName: "PLC" })).toBe("4.04");
    expect(resolveProperty("BAC065", "BAC065", { ...c, sheetName: "PLC" })).toBe("AC/DC");
    expect(resolveProperty("BAG975", "BAG975", { ...c, sheetName: "PLC" })).toBeUndefined();

    const sparse = ctx({ manufacturerId: "rockwell", title: "Stratix 2000 8T Port Unmanaged Switch" }, "1783-US8T");
    sparse.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("AAF040", "AAF040", sparse)).toBeUndefined();
    expect(resolveProperty("BAB577", "BAB577", sparse)).toBeUndefined();
    expect(resolveProperty("BAF016", "BAF016", sparse)).toBeUndefined();
    expect(resolveProperty("BAA020", "BAA020", sparse)).toBeUndefined();
    expect(resolveProperty("AAB909", "AAB909", { ...sparse, sheetName: "PLC" })).toBeUndefined();
    expect(resolveProperty("AAF726", "AAF726", { ...sparse, sheetName: "PLC" })).toBeUndefined();
    expect(resolveProperty("AAS575", "AAS575", { ...sparse, sheetName: "PLC" })).toBeUndefined();
    expect(resolveProperty("BAC065", "BAC065", { ...sparse, sheetName: "PLC" })).toBeUndefined();
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", sparse)).toBeUndefined();
  });

  it("normalizes Rockwell PowerFlex 755TS drive PDT values", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "PowerFlex TS 755 AC Drive",
        description: "PowerFlex TS 755 AC Drive",
        normalized: {
          weight: "9.072 kg",
          voltage: "400 V AC 3PH",
          current: "11.5 A",
          certificates: "c-UL-us, CE, C-Tick, T\u00dcV"
        },
        attributes: [
          { name: "Product Net Weight", value: "9.072 kg" },
          { name: "Power loss, static, current-independent [Pls]", value: "178 W" }
        ]
      },
      "20G21FC011JA0NNNNN"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://literature.rockwellautomation.com/idc/groups/literature/documents/in/750-in119_-en-p.pdf");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("PowerFlex TS 755 AC Drive");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("PowerFlex TS 755 AC Drive");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("c-UL-us, CE, C-Tick, T\u00dcV");
    expect(resolveProperty("AAF040", "AAF040", c)).toBe("9.072");
    expect(resolveProperty("BAA303", "BAA303", { ...c, sheetName: "power supply devices" })).toBe("178");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...c, sheetName: "power supply devices" })).toBe("27023101");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...c, sheetName: "power supply devices" })).toBe("13");

    const sparse = ctx({ manufacturerId: "rockwell", title: "PowerFlex TS 755 AC Drive" }, "20G21FC037JA0NNNNN");
    sparse.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("AAF040", "AAF040", sparse)).toBeUndefined();
    expect(resolveProperty("BAA303", "BAA303", { ...sparse, sheetName: "power supply devices" })).toBeUndefined();
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", sparse)).toBeUndefined();
  });

  it("normalizes Rockwell 852C/852D LED indicator PDT values", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "3 Color 35mm LED Indicator with sound",
        description: "3 Color 35mm LED Indicator with sound",
        normalized: {
          voltage: "24 V DC",
          current: "0.032 A",
          material: "Polycarbonate",
          color: "red",
          certificates: "c-UL-us, CE Marked; UKCA, RCM, KCC"
        },
        attributes: [
          { group: "Technical Data", name: "Product Net Depth", value: "35.021 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Width", value: "35.021 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Height", value: "63.6 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Signal Diameter", value: "35 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Rated Voltage", value: "24 V DC", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Sound Pressure", value: "80 dB", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "852C-B24RGYPQD5"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.rockwellautomation.com/en-us/products/details.852C-B24RGYPQD5.html");
    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("3 Color 35mm LED Indicator with sound");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("3 Color 35mm LED Indicator with sound");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("c-UL-us, CE, UKCA, RCM, KCC");
    expect(resolveProperty("BAB577", "BAB577", c)).toBe("35.021");
    expect(resolveProperty("BAF016", "BAF016", c)).toBe("35.021");
    expect(resolveProperty("BAA020", "BAA020", c)).toBe("63.6");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...c, sheetName: "command and alarm device" })).toBe("27143221");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...c, sheetName: "command and alarm device" })).toBe("13");
    expect(resolveProperty("AAC895", "AAC895", { ...c, sheetName: "command and alarm device" })).toBe("35");
    expect(resolveProperty("AAG331", "AAG331", { ...c, sheetName: "command and alarm device" })).toBe("red");
    expect(resolveProperty("BAH005", "BAH005", { ...c, sheetName: "command and alarm device" })).toBe("24");
    expect(resolveProperty("AAI677", "AAI677", { ...c, sheetName: "command and alarm device" })).toBe("80");
    expect(resolveProperty("BAD915", "BAD915", { ...c, sheetName: "command and alarm device" })).toBe("DC");
    expect(resolveProperty("BAG975", "BAG975", { ...c, sheetName: "command and alarm device" })).toBeUndefined();

    const d = ctx(
      {
        manufacturerId: "rockwell",
        title: "3 Color 55mm LED Indicator with sound",
        description: "3 Color 55mm LED Indicator with sound",
        normalized: { voltage: "24 V DC", color: "red" },
        attributes: [
          { group: "Technical Data", name: "Product Net Depth", value: "55 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Height", value: "82.05 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Signal Diameter", value: "55 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Rated Voltage", value: "24 V DC", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Sound Pressure", value: "85 dB", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "852D-B24RGYPQD5"
    );
    d.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("BAB577", "BAB577", d)).toBe("55");
    expect(resolveProperty("BAA020", "BAA020", d)).toBe("82.05");
    expect(resolveProperty("AAC895", "AAC895", { ...d, sheetName: "command and alarm device" })).toBe("55");
    expect(resolveProperty("AAI677", "AAI677", { ...d, sheetName: "command and alarm device" })).toBe("85");

    const sparse = ctx({ manufacturerId: "rockwell", title: "3 Color 35mm LED Indicator with sound" }, "852C-B24RGYPQD5");
    sparse.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("BAB577", "BAB577", sparse)).toBeUndefined();
    expect(resolveProperty("BAF016", "BAF016", sparse)).toBeUndefined();
    expect(resolveProperty("BAA020", "BAA020", sparse)).toBeUndefined();
    expect(resolveProperty("AAC895", "AAC895", { ...sparse, sheetName: "command and alarm device" })).toBeUndefined();
    expect(resolveProperty("BAH005", "BAH005", { ...sparse, sheetName: "command and alarm device" })).toBeUndefined();
    expect(resolveProperty("AAI677", "AAI677", { ...sparse, sheetName: "command and alarm device" })).toBeUndefined();
    expect(resolveProperty("BAD915", "BAD915", { ...sparse, sheetName: "command and alarm device" })).toBeUndefined();
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", sparse)).toBeUndefined();
  });

  it("prefers official signal-device facts over Rockwell 852 family defaults", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "3 Color 35mm LED Indicator with sound",
        description: "3 Color 35mm LED Indicator with sound",
        normalized: {
          protection: "IP69K"
        },
        attributes: [
          { group: "Technical Data", name: "Rated Voltage", value: "12 V DC", sourceType: "official", confidence: 0.95 },
          { group: "Technical Data", name: "Depth", value: "12 mm", sourceType: "official", confidence: 0.95 },
          { group: "Technical Data", name: "Degree of protection", value: "IP69K", sourceType: "official", confidence: 0.95 },
          { group: "Technical Data", name: "Lens Color", value: "blue", sourceType: "official", confidence: 0.95 },
          { group: "Technical Data", name: "Signal Diameter", value: "40 mm", sourceType: "official", confidence: 0.95 },
          { group: "Technical Data", name: "Sound Pressure", value: "95 dB", sourceType: "official", confidence: 0.95 }
        ]
      },
      "852C-B24RGYPQD5",
      "Stack Light / Beacon"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    const facts = buildPdtFactIndex({ item: c.item, manufacturer: c.manufacturer, deviceType: c.deviceType });

    expect(bestFact(facts, "pdtRatedVoltage")?.value).toBe("12");
    expect(bestFact(facts, "pdtVoltageTypeText")?.value).toBe("DC");
    expect(bestFact(facts, "pdtLampColor")?.value).toBe("blue");
    expect(bestFact(facts, "pdtSignalDiameter")?.value).toBe("40");
    expect(bestFact(facts, "pdtSoundLevel")?.value).toBe("95");
    expect(bestFact(facts, "pdtDepthMm")?.value).toBe("12");
    expect(bestFact(facts, "protection")?.value).toBe("IP69K");
    expect(bestFact(facts, "pdtRatedVoltage")?.sourceType).toBe("official");
    expect(bestFact(facts, "pdtLampColor")?.sourceType).toBe("official");
    expect(resolveProperty("BAH005", "BAH005", { ...c, sheetName: "command and alarm device" })).toBe("12");
    expect(resolveProperty("BAD915", "BAD915", { ...c, sheetName: "command and alarm device" })).toBe("DC");
    expect(resolveProperty("BAG975", "BAG975", { ...c, sheetName: "command and alarm device" })).toBe("IP69K");
    expect(resolveProperty("BAB577", "BAB577", { ...c, sheetName: "Material Master Data" })).toBe("12");
  });

  it("uses device-type defaults for similar Rockwell signaling products", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "856T Stack Light",
        description: "Stack light beacon",
        productUrl: "https://www.rockwellautomation.com/en-us/products/details.856T-B24R.html",
        normalized: {
          voltage: "24 V DC",
          dimensions: "60 x 100 mm",
          color: "amber"
        },
        attributes: [
          { group: "Technical Data", name: "Lens Color", value: "amber", sourceType: "official" },
          { group: "Technical Data", name: "Diameter", value: "60 mm", sourceType: "official" },
          { group: "Technical Data", name: "Sound Pressure", value: "90 dB", sourceType: "official" }
        ]
      },
      "856T-B24R",
      "Stack Light / Beacon"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("AAQ326", "AAQ326", c)).toBe("https://www.rockwellautomation.com/en-us/products/details.856T-B24R.html");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...c, sheetName: "command and alarm device" })).toBe("27143221");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...c, sheetName: "command and alarm device" })).toBe("13");
    expect(resolveProperty("AAC895", "AAC895", { ...c, sheetName: "command and alarm device" })).toBe("60");
    expect(resolveProperty("AAG331", "AAG331", { ...c, sheetName: "command and alarm device" })).toBe("amber");
    expect(resolveProperty("BAH005", "BAH005", { ...c, sheetName: "command and alarm device" })).toBe("24");
    expect(resolveProperty("AAI677", "AAI677", { ...c, sheetName: "command and alarm device" })).toBe("90");
    expect(resolveProperty("BAD915", "BAD915", { ...c, sheetName: "command and alarm device" })).toBe("DC");
  });

  it("uses device-type ECLASS defaults when the scraper has no family rule", () => {
    const terminal = ctx({ title: "Feed-through terminal block", manufacturerId: "rockwell" }, "1492-J4", "Terminal Block");
    const io = ctx({ title: "Digital input module", manufacturerId: "rockwell" }, "5094-IB16", "I/O Module");
    const drive = ctx({ title: "AC Drive", manufacturerId: "rockwell" }, "25B-D010N104", "Variable Speed Drive");

    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...terminal, sheetName: "terminal" })).toBe("27250101");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...terminal, sheetName: "terminal" })).toBe("14");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...io, sheetName: "PLC" })).toBe("27242604");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...io, sheetName: "PLC" })).toBe("14");
    expect(resolveProperty("REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_GROUP_ID", { ...drive, sheetName: "motors" })).toBe("27023101");
    expect(resolveProperty("REFERENCE_FEATURE_SYSTEM_NAME", "REFERENCE_FEATURE_SYSTEM_NAME", { ...drive, sheetName: "motors" })).toBe("14");
  });

  it("does not use drive input voltage as motor reduced rated voltage", () => {
    const drive = ctx(
      {
        title: "Variable frequency drive",
        attributes: [{ group: "PDF Electrical Text", name: "Rated voltage", value: "380...480 V", sourceType: "generated" }]
      },
      "CDVRL00001",
      "Variable Speed Drive"
    );
    const driveWithMotorVoltage = ctx(
      {
        title: "Variable frequency drive",
        attributes: [
          { group: "PDF Electrical Text", name: "Rated voltage", value: "380...480 V", sourceType: "generated" },
          { group: "Motor Data", name: "Motor rated voltage", value: "400 V", sourceType: "official" }
        ]
      },
      "CDVRL00001",
      "Variable Speed Drive"
    );

    expect(resolveProperty("BAE081", "BAE081", { ...drive, sheetName: "motors" })).toBeUndefined();
    expect(resolveProperty("BAE081", "BAE081", { ...driveWithMotorVoltage, sheetName: "motors" })).toBe("400");
    expect(resolveProperty("BAE081", "BAE081", { ...drive, sheetName: "servo controller" })).toBe("480");
  });

  it("keeps manufacturer-specific ECLASS overrides in the documented exception registry", () => {
    expect(PDT_EXCEPTION_RULES.every((rule) => rule.name && rule.rationale)).toBe(true);
    expect(
      pdtExceptionRule({
        manufacturerId: "rockwell",
        catalogNumber: "5069-IB32",
        sheetName: "PLC"
      })?.eclassDefault
    ).toEqual({ code: "27242604", system: "14" });
    expect(
      pdtExceptionRule({
        manufacturerId: "rockwell",
        catalogNumber: "2198-DSM016-ERS2-A0751E-CJ12AA",
        sheetName: "motors"
      })?.eclassDefault
    ).toEqual({ code: "27022602", system: "14" });
    expect(pdtExceptionRule({ manufacturerId: "rockwell", catalogNumber: "856T-B24R", sheetName: "command and alarm device" })).toBeUndefined();
  });

  it("normalizes Rockwell PanelView 5510 family PDT values", () => {
    const c = ctx(
      {
        manufacturerId: "rockwell",
        title: "PanelView 5510 Graphic Terminal",
        description: "PanelView 5510 Graphic Terminal",
        normalized: {
          weight: "2.57 kg",
          dimensions: "286 x 183 mm",
          certificates: "c-UL-us, CE, UKCA, KC, Morocco, RCM, RoHS"
        },
        attributes: [
          { group: "Technical Data", name: "Product Net Weight", value: "2.57 kg", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Depth", value: "69.5 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Width", value: "212.0 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Product Net Height", value: "170 mm", sourceType: "official", parser: "rockwell-product-page" },
          { group: "Technical Data", name: "Power loss", value: "12 W", sourceType: "official", parser: "rockwell-product-page" }
        ]
      },
      "2715P-T7CD"
    );
    c.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;

    expect(resolveProperty("CNS_DESCRIPTION_SHORT", "CNS_DESCRIPTION_SHORT", c)).toBe("PanelView 5510 Graphic Terminal");
    expect(resolveProperty("CNS_DESCRIPTION_LONG", "CNS_DESCRIPTION_LONG", c)).toBe("PanelView 5510 Graphic Terminal");
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", c)).toBe("c-UL-us, CE, UKCA, KC, Morocco, RCM");
    expect(resolveProperty("AAF040", "AAF040", c)).toBe("2.57");
    expect(resolveProperty("BAB577", "BAB577", c)).toBe("69.5");
    expect(resolveProperty("BAF016", "BAF016", c)).toBe("212.0");
    expect(resolveProperty("BAA020", "BAA020", c)).toBe("170");
    expect(resolveProperty("AAS575", "AAS575", c)).toBe("12");

    const wide = ctx({ manufacturerId: "rockwell", title: "PanelView 5510 Graphic Terminal" }, "2715P-T7WD");
    wide.manufacturer = { ...manufacturer, id: "rockwell" } as ManufacturerConfig;
    expect(resolveProperty("AAF040", "AAF040", wide)).toBeUndefined();
    expect(resolveProperty("BAB577", "BAB577", wide)).toBeUndefined();
    expect(resolveProperty("BAF016", "BAF016", wide)).toBeUndefined();
    expect(resolveProperty("BAA020", "BAA020", wide)).toBeUndefined();
    expect(resolveProperty("AAS575", "AAS575", wide)).toBeUndefined();
    expect(resolveProperty("CERTIFICATION", "CERTIFICATION", wide)).toBeUndefined();
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

  it("keeps the minus sign from unicode temperature ranges", () => {
    const c = ctx({ attributes: [{ name: "Operating temperature", value: "\u20135 \u00b0C ... +40 \u00b0C" }] });
    expect(resolveProperty("AAC820", "AAC820", c)).toBe("-5");
    expect(resolveProperty("AAC821", "AAC821", c)).toBe("40");
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
    expect(resolveProperty("AAW361", "AAW361", multiNema)).toBe("NEMA Type 3R, 4, 12 and Type 13");
    expect(resolveProperty("AAZ486", "AAZ486", multiNema)).toBe("NEMA Type 3R, 4, 12 and Type 13");
    expect(
      resolveProperty("AAW361", "AAW361", ctx({ attributes: [{ name: "NEMA Rating", value: "NEMA Type 4X", sourceType: "official" }] }))
    ).toBe("NEMA Type 4X");

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

  it("converts imperial length and mass units (US manufacturers publish inches/pounds)", () => {
    expect(normalizePdtCellNumber("6 in", "mm")).toBe("152.4");
    expect(normalizePdtCellNumber("6 inches", "mm")).toBe("152.4");
    expect(normalizePdtCellNumber('6"', "mm")).toBe("152.4");
    expect(normalizePdtCellNumber("2 ft", "mm")).toBe("609.6");
    expect(normalizePdtCellNumber("3.6 lb", "kg")).toBe("1.632933");
    expect(normalizePdtCellNumber("3.6 pounds", "g")).toBe("1632.932532");
    expect(normalizePdtCellNumber("8 oz", "g")).toBe("226.796185");
  });

  it("normalizes torque values used by PDT mechanical columns", () => {
    expect(normalizePdtCellNumber("2.5 Nm", "Nm")).toBe("2.5");
  });
});

describe("PDT Qwen cleanup guardrails", () => {
  it("prefers documented Rockwell ECLASS overrides before scraped family defaults in cleanup", async () => {
    const compactIo = ctx(
      {
        manufacturerId: "rockwell",
        attributes: [{ name: "ECLASS", value: "27242202", sourceType: "official" }]
      },
      "5069-IB32",
      "Programmable Logic Controller"
    );
    const controlLogix = ctx(
      {
        manufacturerId: "rockwell",
        attributes: [{ name: "ECLASS", value: "27242202", sourceType: "official" }]
      },
      "1756-L902TSXT",
      "Programmable Logic Controller"
    );
    const dsm = ctx(
      {
        manufacturerId: "rockwell",
        attributes: [{ name: "ECLASS", value: "27023101", sourceType: "official" }]
      },
      "2198-DSM016-ERS2-A0751E-CJ12AA",
      "Variable Speed Drive"
    );
    compactIo.item.id = 101;
    controlLogix.item.id = 102;
    dsm.item.id = 103;
    const result = await buildPdtRepairResult(
      [compactIo.item, controlLogix.item, dsm.item],
      { ...manufacturer, id: "rockwell" } as ManufacturerConfig
    );

    expect(result.repairs.get(compactIo.item.id)?.eclassCode).toBe("27242604");
    expect(result.repairs.get(compactIo.item.id)?.eclassSystemVersion).toBe("14");
    expect(result.repairs.get(controlLogix.item.id)?.eclassCode).toBe("27242208");
    expect(result.repairs.get(dsm.item.id)?.eclassCode).toBe("27022602");
  });

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

  it("prefers source-backed negative temperature over stale normalized positive bounds", async () => {
    const c = ctx(
      {
        manufacturerId: "eaton",
        normalized: { operatingTemperatureMin: "5", operatingTemperatureMax: "40" },
        attributes: [
          { name: "Ambient operating temperature", value: "\u00e2\u20ac\u00935 ?C ... +40 ?C", sourceType: "official" }
        ]
      },
      "142824"
    );

    const result = await buildPdtRepairResult([c.item], { ...manufacturer, id: "eaton" } as ManufacturerConfig);
    const repair = result.repairs.get(c.item.id);
    expect(repair?.operatingTemperatureMin).toBe("-5");
    expect(repair?.operatingTemperatureMax).toBe("40");
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

    // Preserve the qualifier when the truncated legend doesn't have a matching specific entry —
    // collapsing "carbon steel" to bare "steel" lost information (the user explicitly asked for
    // the more specific label).
    expect(encodeEnum(material, "carbon steel")).toBeUndefined();
    expect(encodeEnumLabel(material, "carbon steel")).toBe("carbon steel");
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
    expect(ws.getCell(11, 3).value).toBe("1SBL347060R1100");
    expect(ws.getCell(11, 4).value).toBe("3471523024755");
    expect(ws.getCell(11, 5).value).toBe("3471523024755");
    expect(ws.getCell(11, 6).value).toBe("85364900");
    expect(result.cleanedInputPath).toBe(path.join(dir, "out_cleaned-input.xlsx"));
    await expect(fs.stat(result.cleanedInputPath!)).resolves.toBeTruthy();
    expect(result.pdtAuditPath).toBe(path.join(dir, "out_pdt-audit.json"));
    await expect(fs.stat(result.pdtAuditPath!)).resolves.toBeTruthy();
    const audit = JSON.parse(await fs.readFile(result.pdtAuditPath!, "utf8")) as { summary: { written: number }; records: Array<{ status: string; sourceKind?: string; code: string }> };
    expect(audit.summary.written).toBeGreaterThan(0);
    expect(audit.records.some((record) => record.status === "written" && record.sourceKind === "attribute" && record.code === "AAO663")).toBe(true);
    expect(audit.records.some((record) => record.status === "written" && record.sourceKind === "generated-rule" && record.code === "AAO676")).toBe(true);
    const cleaned = new ExcelJS.Workbook();
    await cleaned.xlsx.readFile(result.cleanedInputPath!);
    expect(cleaned.getWorksheet("Cleaned PDT Input")).toBeTruthy();
  });

  it("skips normalized product specs when no source-backed attribute supports the normalized value", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-normalized-provenance-"));
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
    material.getCell(6, 3).value = "CNS_ELECTRO_MATERIAL";
    material.getCell(7, 3).value = "CNS_ELECTRO_MATERIAL";
    material.getCell(8, 3).value = "Material";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        normalized: { material: "Steel" },
        attributes: [{ name: "Material", value: "Plastic", sourceType: "official" }]
      },
      "MAT-1"
    ).item;
    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe("MAT-1");
    expect(ws.getCell(11, 3).value).toBeNull();
    expect(result.cellAudit.records.some((record) =>
      record.catalogNumber === "MAT-1" &&
      record.code === "CNS_ELECTRO_MATERIAL" &&
      record.status === "skipped" &&
      record.sourceKind === "unproven" &&
      record.value === "Steel"
    )).toBe(true);
  });

  it("skips distributor-only product specs even when a resolver can find the attribute", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-distributor-provenance-"));
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
    material.getCell(6, 3).value = "CNS_ELECTRO_MATERIAL";
    material.getCell(7, 3).value = "CNS_ELECTRO_MATERIAL";
    material.getCell(8, 3).value = "Material";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        attributes: [{ name: "Material", value: "Steel", sourceType: "distributor" }]
      },
      "DST-1"
    ).item;
    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe("DST-1");
    expect(ws.getCell(11, 3).value).toBeNull();
    expect(result.cellAudit.records.some((record) =>
      record.catalogNumber === "DST-1" &&
      record.code === "CNS_ELECTRO_MATERIAL" &&
      record.status === "skipped" &&
      record.sourceType === "distributor" &&
      record.value === "Steel"
    )).toBe(true);
  });

  it("leaves Material Master dimension values blank without source-backed evidence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-material-dimension-provenance-"));
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
    material.getCell(6, 3).value = "BAB577";
    material.getCell(7, 3).value = "BAB577";
    material.getCell(8, 3).value = "Depth";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx({ normalized: { dimensions: "10 x 20 x 30 mm" } }, "DIM-1").item;
    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe("DIM-1");
    expect(ws.getCell(11, 3).value).toBeNull();
    expect(result.cellAudit.records.some((record) =>
      record.catalogNumber === "DIM-1" &&
      record.code === "BAB577" &&
      record.status === "blank" &&
      /No source-backed PDT value/.test(record.reason)
    )).toBe(true);
  });

  it("records declared generated URL rules in the PDT cell audit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-url-rule-audit-"));
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
    material.getCell(6, 3).value = "AAQ326";
    material.getCell(7, 3).value = "AAQ326";
    material.getCell(8, 3).value = "Product URL";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx({ manufacturerId: "abb" }, "ABB1SBL347060R1100").item;
    const result = await exportRunPdt({
      manufacturer: { ...manufacturer, id: "abb" } as ManufacturerConfig,
      items: [item],
      templatePath,
      outputPath
    });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    expect(out.getWorksheet("Material Master Data")!.getCell(11, 3).value).toEqual({
      text: "https://new.abb.com/products/1SBL347060R1100",
      hyperlink: "https://new.abb.com/products/1SBL347060R1100"
    });
    expect(result.cellAudit.records.some((record) =>
      record.catalogNumber === "ABB1SBL347060R1100" &&
      record.code === "AAQ326" &&
      record.status === "written" &&
      record.sourceKind === "generated-rule" &&
      record.ruleName === "abb-pdt-product-url"
    )).toBe(true);
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
    expect(out.getWorksheet("Material Master Data")!.getRow(11).values).toContain("UNK-001");
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
    expect(ws.getCell(11, 3).value).toBe(80);
    expect(ws.getCell(11, 4).value).toBe(3);
    expect(ws.getCell(11, 5).value).toBe(-40);
    expect(ws.getCell(11, 6).value).toBe(80);
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
    expect(ws.getCell(11, 2).value).toBe("Wandmontiertes Gehäuse");
    expect(ws.getCell(11, 3).value).toBe("Gehäuse");
    expect(ws.getCell(11, 4).value).toBe("Wall mounted enclosure");
    expect(ws.getCell(11, 5).value).toBe("Enclosure");
  });

  it("writes Saginaw enclosure descriptions from product specifications", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-sce-desc-"));
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
        manufacturerId: "sce",
        title: "SCE-724824FSDAD",
        description: "FSDAD Enclosure",
        attributes: [{ group: "Product Specifications", name: "Description", value: "FSDAD Enclosure", sourceType: "official" }]
      },
      "SCE-724824FSDAD",
      "Enclosure"
    ).item;
    await exportRunPdt({ manufacturer: { ...manufacturer, id: "sce" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 3).value).toBe("Gehaeuse");
    expect(ws.getCell(11, 4).value).toBe("FSDAD Enclosure");
    expect(ws.getCell(11, 5).value).toBe("Enclosure");
  });

  it("writes deterministic German PDT description fallbacks without DE evidence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-localized-fact-de-"));
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
        manufacturerId: "rockwell",
        title: "ControlLogix 5590 XT Controller",
        description: "ControlLogix 5590 XT Controller"
      },
      "1756-L902TSXT"
    ).item;
    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "rockwell" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    expect(result.cellAudit.records).not.toContainEqual(
      expect.objectContaining({
        sheetName: "Material Master Data",
        catalogNumber: "1756-L902TSXT",
        code: "CNS_DESCRIPTION_LONG / AAU734",
        ruleName: "rockwell-controllogix-l9-description-default"
      })
    );
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe("ControlLogix 5590 XT Steuerung");
    expect(ws.getCell(11, 3).value).toBe("ControlLogix 5590 XT Steuerung");
    expect(ws.getCell(11, 4).value).toBe("ControlLogix 5590 XT Controller");
    expect(ws.getCell(11, 5).value).toBe("ControlLogix 5590 XT Controller");
  });

  it("writes DE description fallbacks as literals when no localized DE text was scraped", async () => {
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
    // No localizedDescriptions.de on the result: write the fallback as a literal so Excel
    // does not require manual recalculation before downstream import.
    expect(ws.getCell(11, 2).value).toBe(
      "The AF40B-30-00RT-12 is a 3 pole - 690 V IEC oder 600 UL Schuetz with RT terminals, controlling motors up to 18.5 kW / 400 V AC (AC-3) oder 30 hp / 480 V UL."
    );
    // EN column still gets the scraped English description as a literal value.
    expect(ws.getCell(11, 3).value).toBe(description);
  });

  it("writes German ABB analog module description fallbacks as literals", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-abb-ac522-de-"));
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

    const title = "AC522 Analog input/output module";
    const description = "AC522 Analog input/output module. 4 channels: AI U, I, RTD, DI or AO U, I. 4 channels: AI U, I, RTD or AO U (AC522)";
    const item = ctx({ manufacturerId: "abb", title, description }, "AC522").item;
    await exportRunPdt({ manufacturer: { ...manufacturer, id: "abb" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe("AC522 Analogeingangs-/ausgangsmodul. 4 Kanaele: AI U, I, RTD, DI oder AO U, I. 4 Kanaele: AI U, I, RTD oder AO U (AC522)");
    expect(ws.getCell(11, 3).value).toBe("AC522 Analogeingangs-/ausgangsmodul");
    expect(ws.getCell(11, 4).value).toBe(description);
    expect(ws.getCell(11, 5).value).toBe(title);
  });

  it("writes German ABB CP6610 CP600-Pro description fallbacks as literals", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-abb-cp6610-de-"));
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
        manufacturerId: "abb",
        title: "CP600-Pro",
        description: "CP600-Pro panels feature multitouch glass displays and modern industrial design."
      },
      "CP6610"
    ).item;
    await exportRunPdt({ manufacturer: { ...manufacturer, id: "abb", canonicalName: "ABB" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toContain("Bedienpanel");
    expect(ws.getCell(11, 2).value).toContain("Grafikdisplay");
    expect(ws.getCell(11, 2).value).toContain("Multi-Touchscreen");
    expect(ws.getCell(11, 3).value).toBe("Bedienpanel CP600-Pro");
    expect(ws.getCell(11, 4).value).toBe(
      "CP6610, control panel, TFT graphical display, multi-touch screen, 10.1\", 1280 x 800 pixel, for PB610 applications and visualization of AC500 V3 web server"
    );
    expect(ws.getCell(11, 5).value).toBe("Control Panel CP600-Pro");
  });

  it("writes distinct English and German Rockwell 700-HB relay descriptions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-rockwell-700hb-desc-"));
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
        manufacturerId: "rockwell",
        title: "120V 50/60Hz GP Tall Square Base Relay",
        description: "700-HB General Purpose Blade Base Relay, 15 Amp Contact, DPDT, 120V 50/60Hz, Push-To-Test & Manual Override function and Pilot Light"
      },
      "700-HB32A1-3-4"
    ).item;
    await exportRunPdt({ manufacturer: { ...manufacturer, id: "rockwell", canonicalName: "Rockwell Automation" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toContain("Universal-Steckrelais");
    expect(ws.getCell(11, 2).value).toContain("Testtaster");
    expect(ws.getCell(11, 2).value).toContain("Handbetätigung");
    expect(ws.getCell(11, 3).value).toContain("quadratisches Steckrelais");
    expect(ws.getCell(11, 4).value).toBe(
      "700-HB General Purpose Blade Base Relay, 15 Amp Contact, DPDT, 120V 50/60Hz, Push-To-Test & Manual Override function and Pilot Light"
    );
    expect(ws.getCell(11, 5).value).toBe("120V 50/60Hz GP Tall Square Base Relay");
  });

  it("writes echoed DE description fallbacks as literals", async () => {
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
    expect(ws.getCell(11, 2).value).toBe("Wandgehaeuse");
    expect(ws.getCell(11, 3).value).toBe("Gehaeuse");
    expect(ws.getCell(11, 4).value).toBe("Wall mounted enclosure");
    expect(ws.getCell(11, 5).value).toBe("Enclosure");
  });

  it("writes Material Master DE description fallbacks with loose template variants", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-loose-translate-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const material = wb.addWorksheet("Material Master Data");
    material.getCell(2, 2).value = "DE";
    material.getCell(2, 3).value = "EN";
    material.getCell(6, 1).value = "ECLASS property";
    material.getCell(7, 1).value = "Variable name (CNS internal)";
    material.getCell(8, 1).value = "English variable description";
    material.getCell(9, 1).value = "Units";
    material.getCell(6, 2).value = "CNS_DESCRIPTION_LONG / AAU734";
    material.getCell(7, 2).value = "CNS_DESCRIPTION_LONG";
    material.getCell(8, 2).value = "Product description long";
    material.getCell(6, 3).value = "CNS_DESCRIPTION_LONG";
    material.getCell(7, 3).value = "CNS_DESCRIPTION_LONG";
    material.getCell(8, 3).value = "Product description long";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const description = "Compact safety relay with removable screw terminals.";
    const item = ctx({ description }, "SR-24").item;
    await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 2).value).toBe("kompakt Sicherheitsrelais with removable screw terminals.");
    expect(ws.getCell(11, 3).value).toBe(description);
  });

  it("writes deterministic German descriptions in the bundled Material Master template", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-bundled-de-"));
    const outputPath = path.join(dir, "out.xlsx");
    const item = ctx(
      {
        manufacturerId: "eaton",
        title: "CDVRL00001 - Eaton Rapid Link 5X RASP5X variable frequency drive",
        description: "Eaton Rapid Link 5X RASP5X distributed variable frequency drive from the official Eaton China product catalog."
      },
      "CDVRL00001"
    ).item;

    await exportRunPdt({
      manufacturer: { ...manufacturer, id: "eaton" } as ManufacturerConfig,
      items: [item],
      templatePath: path.resolve("templates", "master_pdt.xlsx"),
      outputPath
    });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell("Y11").value).toBe("Eaton Rapid Link 5X RASP5X dezentraler Frequenzumrichter aus dem offiziellen Eaton China Produktkatalog.");
    expect(ws.getCell("Z11").value).toBe("CDVRL00001 - Eaton Rapid Link 5X RASP5X Frequenzumrichter");
    expect(ws.getCell("AA11").value).toBe("Eaton Rapid Link 5X RASP5X distributed variable frequency drive from the official Eaton China product catalog.");
    expect(ws.getCell("AB11").value).toBe("CDVRL00001 - Eaton Rapid Link 5X RASP5X variable frequency drive");
  });

  it("does not echo English Eaton descriptions into bundled German description columns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-eaton-de-description-"));
    const outputPath = path.join(dir, "out.xlsx");
    const item = ctx(
      {
        manufacturerId: "eaton",
        title: "Eaton 142824 Main load disconnector Switch",
        description: "Eaton 142824 Main load disconnector Switch with isolation function, highly wear resistant contacts, 240V, 80 A, 1P"
      },
      "142824"
    ).item;

    await exportRunPdt({
      manufacturer: { ...manufacturer, id: "eaton" } as ManufacturerConfig,
      items: [item],
      templatePath: path.resolve("templates", "master_pdt.xlsx"),
      outputPath
    });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell("Y11").value).toBe("Eaton 142824 Hauptlasttrennschalter mit Isolierfunktion, hoch verschleissfeste Kontakte, 240V, 80 A, 1P");
    expect(ws.getCell("Z11").value).toBe("Eaton 142824 Hauptlasttrennschalter");
    expect(ws.getCell("AA11").value).toBe("Eaton 142824 Main load disconnector Switch with isolation function, highly wear resistant contacts, 240V, 80 A, 1P");
    expect(ws.getCell("AB11").value).toBe("Eaton 142824 Main load disconnector Switch");
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
    expect(ws.getCell(11, 2).value).toBe(240);
  });

  it("writes Material Master certificate columns from certificate documents", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-document-certificates-"));
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
    material.getCell(6, 3).value = "CERTIFICATION";
    material.getCell(7, 3).value = "CERTIFICATION";
    material.getCell(8, 3).value = "certificate/approval";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        manufacturerId: "eaton",
        attributes: [
          {
            group: "PDF certificate",
            name: "Certifications",
            value: "CE, UKCA",
            sourceUrl: "https://example.test/eaton-ce.pdf",
            sourceType: "generated",
            parser: "pdf-table-extractor",
            stage: "downloaded-document-enrichment",
            confidence: 0.86
          }
        ],
        documents: [
          {
            type: "certificate",
            label: "EU Declaration of Conformity - CE",
            url: "https://example.test/eaton-ce.pdf",
            sourceType: "official",
            parser: "test",
            stage: "download",
            confidence: 0.92
          }
        ]
      },
      "142824"
    ).item;
    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "eaton" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("Material Master Data")!;
    expect(ws.getCell(11, 3).value).toBe("CE, UKCA");
    expect(result.cellAudit.records.some((record) =>
      record.catalogNumber === "142824" &&
      record.code === "CERTIFICATION" &&
      record.status === "written" &&
      record.sourceKind === "document" &&
      record.value === "CE, UKCA"
    )).toBe(true);
  });

  it("fills profile-critical PDT fields from multilingual ontology-backed attributes when normalized fields are empty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-ontology-facts-"));
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
    material.getCell(6, 3).value = "BAB577";
    material.getCell(7, 3).value = "BAB577";
    material.getCell(8, 3).value = "Depth";
    material.getCell(9, 3).value = "mm";
    material.getCell(6, 3).value = "AAF040";
    material.getCell(7, 3).value = "AAF040";
    material.getCell(8, 3).value = "Weight";
    material.getCell(9, 3).value = "kg";
    material.getCell(6, 4).value = "CNS_ELECTRO_MATERIAL";
    material.getCell(7, 4).value = "CNS_ELECTRO_MATERIAL";
    material.getCell(8, 4).value = "Material";
    material.getCell(6, 5).value = "AAN521";
    material.getCell(7, 5).value = "AAN521";
    material.getCell(8, 5).value = "Color";

    const command = wb.addWorksheet("command and alarm device");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      command.getCell(row + 1, 1).value = label;
    }
    command.getCell(4, 2).value = "AAO676";
    command.getCell(5, 2).value = "AAO676";
    command.getCell(6, 2).value = "product article number of manufacturer";
    command.getCell(4, 3).value = "BAH005";
    command.getCell(5, 3).value = "BAH005";
    command.getCell(6, 3).value = "Rated voltage";
    command.getCell(7, 3).value = "V";
    command.getCell(4, 4).value = "BAD915";
    command.getCell(5, 4).value = "BAD915";
    command.getCell(6, 4).value = "Voltage type";
    command.getCell(4, 5).value = "AAG331";
    command.getCell(5, 5).value = "AAG331";
    command.getCell(6, 5).value = "Lamp color";
    command.getCell(4, 6).value = "AAC895";
    command.getCell(5, 6).value = "AAC895";
    command.getCell(6, 6).value = "Signal diameter";
    command.getCell(7, 6).value = "mm";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Stack light beacon",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "Stack Light / Beacon", sourceType: "official" },
          { group: "Dati tecnici", name: "Materiale custodia", value: "poliammide GF30", sourceType: "official" },
          { group: "Dati tecnici", name: "Colore custodia", value: "nero", sourceType: "official" },
          { group: "Donn\u00e9es techniques", name: "Tension nominale", value: "24 V DC", sourceType: "official" },
          { group: "Dati tecnici", name: "Peso", value: "0.25 kg", sourceType: "official" },
          { group: "Technical data", name: "Diameter", value: "60 mm", sourceType: "official" }
        ]
      },
      "STACK-WILD-1"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const materialOut = out.getWorksheet("Material Master Data")!;
    const commandOut = out.getWorksheet("command and alarm device")!;
    expect(materialOut.getCell(11, 3).value).toBe(0.25);
    expect(materialOut.getCell(11, 4).value).toBe("polyamide");
    expect(materialOut.getCell(11, 5).value).toBe("black");
    expect(commandOut.getCell(9, 2).value).toBe(24);
    expect(commandOut.getCell(9, 3).value).toBe("DC");
    expect(commandOut.getCell(9, 4).value).toBe("black");
    expect(commandOut.getCell(9, 5).value).toBe(60);
  });

  it("promotes manufacturer-agnostic quantity attributes into PDT facts", () => {
    const c = ctx(
      {
        title: "Centrifugal pump",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "Pump", sourceType: "official" },
          { group: "Technical data", name: "Standard nominal flow rate", value: "500", unit: "l/min", sourceType: "official" },
          { group: "Technical data", name: "Operating pressure", value: "0.6 MPa", sourceType: "official" },
          { group: "Technical data", name: "Short-circuit breaking capacity", value: "50 kA", sourceType: "official" },
          { group: "Technical data", name: "Rated insulation voltage", value: "690 V", sourceType: "official" },
          { group: "Technical data", name: "Rated impulse withstand voltage", value: "8 kV", sourceType: "official" },
          { group: "Technical data", name: "Voltage drop", value: "2.5 V", sourceType: "official" },
          { group: "Technical data", name: "Leakage current", value: "0.8 mA", sourceType: "official" },
          { group: "Technical data", name: "Operating temperature", value: "-25...+70 C", sourceType: "official" },
          { group: "Technical data", name: "Storage temperature", value: "-40...+85 C", sourceType: "official" },
          { group: "Technical data", name: "Material thickness", value: "1.5 mm", sourceType: "official" },
          { group: "Technical data", name: "Sensing distance", value: "4 mm", sourceType: "official" },
          { group: "Technical data", name: "Operating altitude", value: "200000", unit: "cm", sourceType: "official" },
          { group: "Technical data", name: "Stripping length", value: "12 mm", sourceType: "official" },
          { group: "Technical data", name: "Stroke length", value: "50 mm", sourceType: "official" },
          { group: "Technical data", name: "Bore size", value: "32 mm", sourceType: "official" },
          { group: "Technical data", name: "Orifice size", value: "2.5 mm", sourceType: "official" },
          { group: "Technical data", name: "Blind zone", value: "80 mm", sourceType: "official" },
          { group: "Technical data", name: "Rated power", value: "1.5 kW", sourceType: "official" },
          { group: "Technical data", name: "Power consumption", value: "250 W", sourceType: "official" },
          { group: "Technical data", name: "Cooling capacity", value: "500 W", sourceType: "official" },
          { group: "Technical data", name: "Heating capacity", value: "1.2 kW", sourceType: "official" },
          { group: "Technical data", name: "Nominal frequency", value: "50/60 Hz", sourceType: "official" },
          { group: "Technical data", name: "Switching frequency", value: "4", unit: "kHz", sourceType: "official" },
          { group: "Technical data", name: "Tightening torque", value: "2.5...3 Nm", sourceType: "official" }
        ]
      },
      "PUMP-FLOW-FACT-1",
      "Pump"
    );

    const facts = buildPdtFactIndex({ item: c.item, manufacturer, deviceType: "Pump" });

    expect(facts.byKey.get("flowRate")?.[0]).toEqual(
      expect.objectContaining({
        key: "flowRate",
        value: "500 l/min",
        sourceKind: "attribute",
        sourceType: "official"
      })
    );
    expect(facts.byKey.get("pressure")?.[0]).toEqual(expect.objectContaining({ key: "pressure", value: "0.6 MPa" }));
    expect(facts.byKey.get("breakingCapacity")?.[0]).toEqual(expect.objectContaining({ key: "breakingCapacity", value: "50 kA" }));
    expect(facts.byKey.get("insulationVoltage")?.[0]).toEqual(expect.objectContaining({ key: "insulationVoltage", value: "690 V" }));
    expect(facts.byKey.get("impulseVoltage")?.[0]).toEqual(expect.objectContaining({ key: "impulseVoltage", value: "8 kV" }));
    expect(facts.byKey.get("voltageDrop")?.[0]).toEqual(expect.objectContaining({ key: "voltageDrop", value: "2.5 V" }));
    expect(facts.byKey.get("leakageCurrent")?.[0]).toEqual(expect.objectContaining({ key: "leakageCurrent", value: "0.8 mA" }));
    expect(facts.byKey.get("operatingTemperature")?.[0]).toEqual(expect.objectContaining({ key: "operatingTemperature", value: "-25..70 C" }));
    expect(facts.byKey.get("operatingTemperatureMin")?.[0]).toEqual(expect.objectContaining({ key: "operatingTemperatureMin", value: "-25 C" }));
    expect(facts.byKey.get("operatingTemperatureMax")?.[0]).toEqual(expect.objectContaining({ key: "operatingTemperatureMax", value: "70 C" }));
    expect(facts.byKey.get("storageTemperature")?.[0]).toEqual(expect.objectContaining({ key: "storageTemperature", value: "-40..85 C" }));
    expect(facts.byKey.get("storageTemperatureMin")?.[0]).toEqual(expect.objectContaining({ key: "storageTemperatureMin", value: "-40 C" }));
    expect(facts.byKey.get("storageTemperatureMax")?.[0]).toEqual(expect.objectContaining({ key: "storageTemperatureMax", value: "85 C" }));
    expect(facts.byKey.get("wallThickness")?.[0]).toEqual(expect.objectContaining({ key: "wallThickness", value: "1.5 mm" }));
    expect(facts.byKey.get("sensingDistance")?.[0]).toEqual(expect.objectContaining({ key: "sensingDistance", value: "4 mm" }));
    expect(facts.byKey.get("altitude")?.[0]).toEqual(expect.objectContaining({ key: "altitude", value: "200000 cm" }));
    expect(facts.byKey.get("strippingLength")?.[0]).toEqual(expect.objectContaining({ key: "strippingLength", value: "12 mm" }));
    expect(facts.byKey.get("stroke")?.[0]).toEqual(expect.objectContaining({ key: "stroke", value: "50 mm" }));
    expect(facts.byKey.get("bore")?.[0]).toEqual(expect.objectContaining({ key: "bore", value: "32 mm" }));
    expect(facts.byKey.get("orificeSize")?.[0]).toEqual(expect.objectContaining({ key: "orificeSize", value: "2.5 mm" }));
    expect(facts.byKey.get("blindZone")?.[0]).toEqual(expect.objectContaining({ key: "blindZone", value: "80 mm" }));
    expect(facts.byKey.get("power")?.[0]).toEqual(expect.objectContaining({ key: "power", value: "1.5 kW" }));
    expect(facts.byKey.get("powerConsumption")?.[0]).toEqual(expect.objectContaining({ key: "powerConsumption", value: "250 W" }));
    expect(facts.byKey.get("coolingOutput")?.[0]).toEqual(expect.objectContaining({ key: "coolingOutput", value: "500 W" }));
    expect(facts.byKey.get("heatingCapacity")?.[0]).toEqual(expect.objectContaining({ key: "heatingCapacity", value: "1.2 kW" }));
    expect(facts.byKey.get("frequency")?.[0]).toEqual(expect.objectContaining({ key: "frequency", value: "50/60 Hz" }));
    expect(facts.byKey.get("switchingFrequency")?.[0]).toEqual(expect.objectContaining({ key: "switchingFrequency", value: "4 kHz" }));
    expect(facts.byKey.get("torque")?.[0]).toEqual(expect.objectContaining({ key: "torque", value: "3 Nm" }));
  });

  it("keeps ontology quantity promotions aligned with PDT fact labels", () => {
    for (const ontologyKey of [
      "flowRate",
      "pressure",
      "frequency",
      "switchingFrequency",
      "torque",
      "breakingCapacity",
      "insulationVoltage",
      "impulseVoltage",
      "voltageDrop",
      "leakageCurrent",
      "operatingTemperature",
      "storageTemperature",
      "wallThickness",
      "sensingDistance",
      "altitude",
      "strippingLength",
      "stroke",
      "bore",
      "orificeSize",
      "blindZone",
      "power",
      "powerLoss",
      "powerConsumption",
      "coilPower",
      "coolingOutput",
      "heatingCapacity"
    ]) {
      expect(PDT_ONTOLOGY_FACT_KEYS[ontologyKey], ontologyKey).toBeTruthy();
      expect(PDT_ONTOLOGY_QUANTITY_FACT_KEYS[ontologyKey], ontologyKey).toBeTruthy();
    }

    for (const [ontologyKey, factKey] of Object.entries(PDT_ONTOLOGY_QUANTITY_FACT_KEYS)) {
      expect(PDT_ONTOLOGY_FACT_KEYS[ontologyKey] ?? [], ontologyKey).toContain(factKey);
    }
  });

  it("prefers official datasheet attributes over distributor attributes for the same PDT fact", () => {
    const c = ctx(
      {
        title: "Power supply",
        normalized: {},
        attributes: [
          {
            group: "Distributor specs",
            name: "Power consumption",
            value: "300 W",
            sourceType: "distributor",
            parser: "distributor-page",
            confidence: 0.95
          },
          {
            group: "PDF Technical Data",
            name: "Power consumption",
            value: "250 W",
            sourceType: "official",
            parser: "pdf-table-extractor",
            sourceUrl: "https://acme.test/datasheet.pdf",
            confidence: 0.72
          }
        ]
      },
      "PSU-SOURCE-1",
      "Power Supply"
    );

    const facts = buildPdtFactIndex({ item: c.item, manufacturer, deviceType: "Power Supply" });

    expect(bestFact(facts, "powerConsumption")).toEqual(
      expect.objectContaining({
        key: "powerConsumption",
        value: "250 W",
        sourceType: "official",
        parser: "pdf-table-extractor",
        sourceUrl: "https://acme.test/datasheet.pdf"
      })
    );
    expect(facts.byKey.get("powerConsumption")?.map((fact) => fact.value)).not.toContain("300 W");
  });

  it("fills generic flow-rate PDT columns from ontology-backed attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-flow-rate-"));
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

    const pump = wb.addWorksheet("pump");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      pump.getCell(row + 1, 1).value = label;
    }
    pump.getCell(4, 2).value = "AAO676";
    pump.getCell(5, 2).value = "AAO676";
    pump.getCell(6, 2).value = "product article number of manufacturer";
    pump.getCell(4, 3).value = "AAC199";
    pump.getCell(5, 3).value = "AAC199";
    pump.getCell(6, 3).value = "Volume flow";
    pump.getCell(7, 3).value = "l/min";
    pump.getCell(4, 4).value = "AAA900";
    pump.getCell(5, 4).value = "AAA900";
    pump.getCell(6, 4).value = "Operating pressure";
    pump.getCell(7, 4).value = "bar";
    pump.getCell(4, 5).value = "BAC545";
    pump.getCell(5, 5).value = "BAC545";
    pump.getCell(6, 5).value = "Output power";
    pump.getCell(7, 5).value = "kW";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Centrifugal pump",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "Pump", sourceType: "official" },
          { group: "Technical data", name: "Standard nominal flow rate", value: "12 m\u00b3/h", sourceType: "official" },
          { group: "Technical data", name: "Operating pressure", value: "0.6 MPa", sourceType: "official" },
          { group: "Technical data", name: "Rated power", value: "1.5 kW", sourceType: "official" }
        ]
      },
      "PUMP-FLOW-1",
      "Pump"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const pumpOut = out.getWorksheet("pump")!;
    expect(pumpOut.getCell(9, 2).value).toBe(200);
    expect(pumpOut.getCell(9, 3).value).toBe(6);
    expect(pumpOut.getCell(9, 4).value).toBe(1.5);
  });

  it("fills generic frequency PDT columns from ontology-backed attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-frequency-"));
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

    const motors = wb.addWorksheet("motors");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      motors.getCell(row + 1, 1).value = label;
    }
    motors.getCell(4, 2).value = "AAO676";
    motors.getCell(5, 2).value = "AAO676";
    motors.getCell(6, 2).value = "product article number of manufacturer";
    motors.getCell(4, 3).value = "BAE130";
    motors.getCell(5, 3).value = "BAE130";
    motors.getCell(6, 3).value = "Power frequency";
    motors.getCell(7, 3).value = "Hz";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Three-phase motor",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "Motor", sourceType: "official" },
          { group: "Technical data", name: "Nominal frequency", value: "50/60 Hz", sourceType: "official" }
        ]
      },
      "MOTOR-FREQ-1",
      "Motor"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const motorsOut = out.getWorksheet("motors")!;
    expect(motorsOut.getCell(9, 2).value).toBe(60);
  });

  it("fills cooling and heating capacity PDT columns from ontology-backed attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-thermal-capacity-"));
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

    const thermal = wb.addWorksheet("cabinet.airconditioning");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      thermal.getCell(row + 1, 1).value = label;
    }
    thermal.getCell(4, 2).value = "AAO676";
    thermal.getCell(5, 2).value = "AAO676";
    thermal.getCell(6, 2).value = "product article number of manufacturer";
    thermal.getCell(4, 3).value = "AAC066";
    thermal.getCell(5, 3).value = "AAC066";
    thermal.getCell(6, 3).value = "Useful cooling capacity";
    thermal.getCell(7, 3).value = "W";
    thermal.getCell(4, 4).value = "CUSTOM_HEAT_CAPACITY";
    thermal.getCell(5, 4).value = "CUSTOM_HEAT_CAPACITY";
    thermal.getCell(6, 4).value = "Heating capacity";
    thermal.getCell(7, 4).value = "W";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Cabinet climate unit",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "Enclosure air conditioner", sourceType: "official" },
          { group: "Technical data", name: "Cooling capacity", value: "500 W", sourceType: "official" },
          { group: "Technical data", name: "Heating capacity", value: "1.2 kW", sourceType: "official" }
        ]
      },
      "THERMAL-CAP-1",
      "Thermal Management"
    ).item;

    const result = await exportRunPdt({
      manufacturer,
      items: [item],
      templatePath,
      outputPath,
      sheetOverrides: { [item.id]: ["cabinet.airconditioning"] }
    });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const thermalOut = out.getWorksheet("cabinet.airconditioning")!;
    expect(thermalOut.getCell(9, 2).value).toBe(500);
    expect(thermalOut.getCell(9, 3).value).toBe(1200);
  });

  it("fills generic breaking-capacity PDT columns from ontology-backed attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-breaking-capacity-"));
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
    contactor.getCell(4, 2).value = "AAO676";
    contactor.getCell(5, 2).value = "AAO676";
    contactor.getCell(6, 2).value = "product article number of manufacturer";
    contactor.getCell(4, 3).value = "AAB447";
    contactor.getCell(5, 3).value = "AAB447";
    contactor.getCell(6, 3).value = "Conditional rated short-circuit current Iq";
    contactor.getCell(7, 3).value = "kA";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Circuit breaker",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "Circuit breaker", sourceType: "official" },
          { group: "Technical data", name: "Rated conditional short-circuit current", value: "50 kA", sourceType: "official" }
        ]
      },
      "BREAKER-CAP-1",
      "Circuit Breaker"
    ).item;

    const result = await exportRunPdt({
      manufacturer,
      items: [item],
      templatePath,
      outputPath,
      sheetOverrides: { [item.id]: ["contactor a. fuses"] }
    });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const contactorOut = out.getWorksheet("contactor a. fuses")!;
    expect(contactorOut.getCell(9, 2).value).toBe(50);
  });

  it("fills specific voltage and leakage-current PDT columns from ontology-backed attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-specific-electrical-"));
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
    sensor.getCell(5, 2).value = "AAO676";
    sensor.getCell(6, 2).value = "product article number of manufacturer";
    sensor.getCell(4, 3).value = "AAB491";
    sensor.getCell(5, 3).value = "AAB491";
    sensor.getCell(6, 3).value = "Rated insulation voltage Ui";
    sensor.getCell(7, 3).value = "V";
    sensor.getCell(4, 4).value = "AAB814";
    sensor.getCell(5, 4).value = "AAB814";
    sensor.getCell(6, 4).value = "Rated impulse withstand voltage Uimp";
    sensor.getCell(7, 4).value = "V";
    sensor.getCell(4, 5).value = "CUSTOM_VOLTAGE_DROP";
    sensor.getCell(5, 5).value = "CUSTOM_VOLTAGE_DROP";
    sensor.getCell(6, 5).value = "Voltage drop";
    sensor.getCell(7, 5).value = "V";
    sensor.getCell(4, 6).value = "ABD348";
    sensor.getCell(5, 6).value = "ABD348";
    sensor.getCell(6, 6).value = "Leakage current";
    sensor.getCell(7, 6).value = "A";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Inductive sensor",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "Inductive sensor", sourceType: "official" },
          { group: "Technical data", name: "Rated insulation voltage", value: "690 V", sourceType: "official" },
          { group: "Technical data", name: "Rated impulse withstand voltage", value: "8 kV", sourceType: "official" },
          { group: "Technical data", name: "Voltage drop", value: "2.5 V", sourceType: "official" },
          { group: "Technical data", name: "Leakage current", value: "0.8 mA", sourceType: "official" }
        ]
      },
      "SENSOR-ELEC-1",
      "Inductive Proximity Sensor"
    ).item;

    const result = await exportRunPdt({
      manufacturer,
      items: [item],
      templatePath,
      outputPath,
      sheetOverrides: { [item.id]: ["electronic sensor"] }
    });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const sensorOut = out.getWorksheet("electronic sensor")!;
    expect(sensorOut.getCell(9, 2).value).toBe(690);
    expect(sensorOut.getCell(9, 3).value).toBe(8000);
    expect(sensorOut.getCell(9, 4).value).toBe(2.5);
    expect(sensorOut.getCell(9, 5).value).toBe(0.0008);
  });

  it("fills operating and storage temperature PDT min/max columns from ontology-backed attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-temperature-facts-"));
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

    const plc = wb.addWorksheet("PLC");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      plc.getCell(row + 1, 1).value = label;
    }
    plc.getCell(4, 2).value = "AAO676";
    plc.getCell(5, 2).value = "AAO676";
    plc.getCell(6, 2).value = "product article number of manufacturer";
    plc.getCell(4, 3).value = "BAA038";
    plc.getCell(5, 3).value = "BAA038";
    plc.getCell(6, 3).value = "Min ambient temperature";
    plc.getCell(7, 3).value = "C";
    plc.getCell(4, 4).value = "BAA039";
    plc.getCell(5, 4).value = "BAA039";
    plc.getCell(6, 4).value = "Max ambient temperature";
    plc.getCell(7, 4).value = "C";
    plc.getCell(4, 5).value = "AAQ342";
    plc.getCell(5, 5).value = "AAQ342";
    plc.getCell(6, 5).value = "Min storage temperature";
    plc.getCell(7, 5).value = "C";
    plc.getCell(4, 6).value = "AAQ341";
    plc.getCell(5, 6).value = "AAQ341";
    plc.getCell(6, 6).value = "Max storage temperature";
    plc.getCell(7, 6).value = "C";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "PLC module",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "PLC module", sourceType: "official" },
          { group: "Technical data", name: "Operating temperature", value: "-25...+70 C", sourceType: "official" },
          { group: "Technical data", name: "Storage temperature", value: "-40...+85 C", sourceType: "official" }
        ]
      },
      "PLC-TEMP-1",
      "Programmable Logic Controller"
    ).item;

    const result = await exportRunPdt({
      manufacturer,
      items: [item],
      templatePath,
      outputPath,
      sheetOverrides: { [item.id]: ["PLC"] }
    });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const plcOut = out.getWorksheet("PLC")!;
    expect(plcOut.getCell(9, 2).value).toBe(-25);
    expect(plcOut.getCell(9, 3).value).toBe(70);
    expect(plcOut.getCell(9, 4).value).toBe(-40);
    expect(plcOut.getCell(9, 5).value).toBe(85);
  });

  it("fills specific length PDT columns from ontology-backed attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-specific-lengths-"));
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
    sensor.getCell(5, 2).value = "AAO676";
    sensor.getCell(6, 2).value = "product article number of manufacturer";
    sensor.getCell(4, 3).value = "AAG011";
    sensor.getCell(5, 3).value = "AAG011";
    sensor.getCell(6, 3).value = "Material thickness";
    sensor.getCell(7, 3).value = "mm";
    sensor.getCell(4, 4).value = "BAD815";
    sensor.getCell(5, 4).value = "BAD815";
    sensor.getCell(6, 4).value = "Sensing distance";
    sensor.getCell(7, 4).value = "mm";
    sensor.getCell(4, 5).value = "ABD480";
    sensor.getCell(5, 5).value = "ABD480";
    sensor.getCell(6, 5).value = "Operating altitude";
    sensor.getCell(7, 5).value = "m";
    sensor.getCell(4, 6).value = "AAB202";
    sensor.getCell(5, 6).value = "AAB202";
    sensor.getCell(6, 6).value = "Stripping length";
    sensor.getCell(7, 6).value = "mm";
    sensor.getCell(4, 7).value = "AAZ930";
    sensor.getCell(5, 7).value = "AAZ930";
    sensor.getCell(6, 7).value = "Stroke";
    sensor.getCell(7, 7).value = "mm";
    sensor.getCell(4, 8).value = "AAZ420";
    sensor.getCell(5, 8).value = "AAZ420";
    sensor.getCell(6, 8).value = "Bore size";
    sensor.getCell(7, 8).value = "mm";
    sensor.getCell(4, 9).value = "CUSTOM_ORIFICE";
    sensor.getCell(5, 9).value = "CUSTOM_ORIFICE";
    sensor.getCell(6, 9).value = "Orifice size";
    sensor.getCell(7, 9).value = "mm";
    sensor.getCell(4, 10).value = "CUSTOM_BLIND";
    sensor.getCell(5, 10).value = "CUSTOM_BLIND";
    sensor.getCell(6, 10).value = "Blind zone";
    sensor.getCell(7, 10).value = "mm";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Multi-purpose sensor",
        normalized: {},
        attributes: [
          { name: "Product Type", value: "Sensor", sourceType: "official" },
          { group: "Technical data", name: "Material thickness", value: "1.5 mm", sourceType: "official" },
          { group: "Technical data", name: "Sensing distance", value: "4 mm", sourceType: "official" },
          { group: "Technical data", name: "Operating altitude", value: "200000", unit: "cm", sourceType: "official" },
          { group: "Technical data", name: "Stripping length", value: "12 mm", sourceType: "official" },
          { group: "Technical data", name: "Stroke length", value: "50 mm", sourceType: "official" },
          { group: "Technical data", name: "Bore size", value: "32 mm", sourceType: "official" },
          { group: "Technical data", name: "Orifice size", value: "2.5 mm", sourceType: "official" },
          { group: "Technical data", name: "Blind zone", value: "80 mm", sourceType: "official" }
        ]
      },
      "SENSOR-LENGTH-1",
      "Sensor"
    ).item;

    const result = await exportRunPdt({
      manufacturer,
      items: [item],
      templatePath,
      outputPath,
      sheetOverrides: { [item.id]: ["electronic sensor"] }
    });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const sensorOut = out.getWorksheet("electronic sensor")!;
    expect(sensorOut.getCell(9, 2).value).toBe(1.5);
    expect(sensorOut.getCell(9, 3).value).toBe(4);
    expect(sensorOut.getCell(9, 4).value).toBe(2000);
    expect(sensorOut.getCell(9, 5).value).toBe(12);
    expect(sensorOut.getCell(9, 6).value).toBe(50);
    expect(sensorOut.getCell(9, 7).value).toBe(32);
    expect(sensorOut.getCell(9, 8).value).toBe(2.5);
    expect(sensorOut.getCell(9, 9).value).toBe(80);
  });

  it("skips electrical PDT spec values that do not contain a measurement", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-invalid-electrical-spec-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const switchSheet = wb.addWorksheet("Switch");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      switchSheet.getCell(row + 1, 1).value = label;
    }
    switchSheet.getCell(4, 2).value = "AAO676";
    switchSheet.getCell(5, 2).value = "AAO676";
    switchSheet.getCell(6, 2).value = "product article number of manufacturer";
    switchSheet.getCell(4, 3).value = "AAB815";
    switchSheet.getCell(5, 3).value = "AAB815";
    switchSheet.getCell(6, 3).value = "max. rated operating voltage Ue";
    switchSheet.getCell(7, 3).value = "V";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Metal Plug-In Oiltight Limit Switch",
        attributes: [
          {
            group: "PDF Technical Data",
            name: "Voltage rating",
            value: "for this receptacle is",
            sourceType: "generated",
            parser: "pdf-table-extractor"
          }
        ]
      },
      "802T-KPE"
    ).item;
    const result = await exportRunPdt({
      manufacturer,
      items: [item],
      templatePath,
      outputPath,
      sheetOverrides: { [item.id]: ["Switch"] }
    });

    expect(result.cellAudit.records.some((record) =>
      record.catalogNumber === "802T-KPE" &&
      record.code === "AAB815" &&
      record.status === "skipped" &&
      record.value === "for this receptacle is" &&
      /semantically invalid product-spec value/i.test(record.reason)
    )).toBe(true);
    expect(result.cellAudit.records.some((record) =>
      record.catalogNumber === "802T-KPE" &&
      record.code === "AAB815" &&
      record.status === "written"
    )).toBe(false);
  });

  it("does not write Saginaw LPPL cabinet values without source evidence", async () => {
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
    // After removeTemplateLabelColumn shifts everything left by one: col 1 = AAO676 (article),
    // col 2 = REFERENCE_FEATURE_GROUP_ID. The cabinet/enclosure device type now triggers the
    // deterministic ECLASS 27-18-01-01 (version 13.0) fallback from the Enclosure device-type
    // profile, since Saginaw doesn't publish ECLASS codes. All other product-spec columns stay blank.
    expect(ws.getCell(9, 1).value).toBe("SCE-60EL4812LPPL");
    expect(ws.getCell(9, 2).value).toBe(27180101);
    expect(ws.getCell(9, 3).value).toBeNull();
    expect(ws.getCell(9, 4).value).toBeNull();
    expect(ws.getCell(9, 5).value).toBeNull();
    expect(ws.getCell(9, 6).value).toBeNull();
    expect(ws.getCell(9, 7).value).toBeNull();
  });

  it("writes Saginaw cabinet color from source-backed finish text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-sce-color-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const cabinet = wb.addWorksheet("cabinet");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      cabinet.getCell(row + 1, 1).value = label;
    }
    const columns = [
      ["AAO676", "Article number"],
      ["BAA351", "color 1 - Other 2 - cream white/electro white 3 - Stainless steel ..."],
      ["BAC295", "Color (string)"]
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
      {
        manufacturerId: "sce",
        title: "SCE-724824FSDAD",
        description: "FSDAD Enclosure",
        normalized: {
          color: "ANSI-61 gray (optional sub-panels white)",
          finish: "ANSI-61 gray finish inside and out. Optional sub-panels are powder coated white."
        },
        attributes: [
          {
            group: "Finish",
            name: "Finish",
            value: "ANSI-61 gray finish inside and out. Optional sub-panels are powder coated white.",
            sourceType: "official",
            parser: "sce-product-page",
            confidence: 0.9
          }
        ]
      },
      "SCE-724824FSDAD",
      "Enclosure"
    ).item;
    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "sce" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("cabinet")!;
    expect(ws.getCell(9, 1).value).toBe("SCE-724824FSDAD");
    expect(ws.getCell(9, 2).value).toBe("gray");
    expect(ws.getCell(9, 3).value).toBe("ANSI-61 gray (optional sub-panels white)");
    expect(result.cellAudit.records.some((record) => record.code === "BAA351" && record.status === "written")).toBe(true);
    expect(result.cellAudit.records.some((record) => record.code === "BAC295" && record.status === "written")).toBe(true);
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
    expect(ws.getCell(9, 1).value).toBe("AC/DC");
    expect(ws.getCell(9, 2).value).toBe(-40);
    expect(ws.getCell(9, 3).value).toBe(70);
  });

  it("uses operating temperature rather than storage temperature on contactor/fuses temperature columns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-contactor-operating-temp-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const contactor = wb.addWorksheet("contactor a. fuses");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      contactor.getCell(row + 1, 1).value = label;
    }
    contactor.getCell(4, 2).value = "AAQ342";
    contactor.getCell(5, 2).value = "AAQ342";
    contactor.getCell(6, 2).value = "Min storage temperature";
    contactor.getCell(7, 2).value = "C";
    contactor.getCell(4, 3).value = "AAQ341";
    contactor.getCell(5, 3).value = "AAQ341";
    contactor.getCell(6, 3).value = "Max storage temperature";
    contactor.getCell(7, 3).value = "C";
    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        manufacturerId: "eaton",
        title: "500FL Lighting Contactor",
        attributes: [
          { group: "Technical data", name: "Operating temperature", value: "-25...+60 C", sourceType: "official" },
          { group: "Technical data", name: "Storage temperature", value: "-40...+85 C", sourceType: "official" }
        ]
      },
      "500FL-FOD92"
    ).item;

    await exportRunPdt({
      manufacturer: { ...manufacturer, id: "eaton" } as ManufacturerConfig,
      items: [item],
      templatePath,
      outputPath,
      sheetOverrides: { [item.id]: ["contactor a. fuses"] }
    });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("contactor a. fuses")!;
    expect(ws.getCell(9, 1).value).toBe(-25);
    expect(ws.getCell(9, 2).value).toBe(60);
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
    expect(ws.getRow(9).values).toEqual([
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

  it("writes ABB 1SDA current fields on contactor/fuses instead of allowlist-blocking them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-abb-1sda-current-"));
    const templatePath = path.join(dir, "template.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const wb = new ExcelJS.Workbook();
    const contactor = wb.addWorksheet("contactor a. fuses");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      contactor.getCell(row + 1, 1).value = label;
    }
    const columns = [
      ["AAO676", "article number", "-"],
      ["BAH005", "rated voltage", "V"],
      ["AAF726", "rated current", "A"],
      ["AAB821", "Max. rated operating current", "A"],
      ["AAC824", "Nominal current", "-"],
      ["AAB460", "Rated operating current Ie", "A"],
      ["AAS574", "Rated current for power loss specification", "A"],
      ["AAB485", "rated permanent current Iu", "A"],
      ["AAN521", "color", "-"]
    ] as const;
    for (const [index, [code, description, unit]] of columns.entries()) {
      const col = index + 2;
      contactor.getCell(2, col).value = "Must field";
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
        title: "Emax 3 Ekip Aware LI 3p F IEC",
        normalized: { voltage: "24 V", current: "250 A", color: "RAL 9005" },
        attributes: [
          { group: "ABB Product Data", name: "Product ID", value: "1SDA124707R1", sourceType: "official" },
          { group: "ABB Technical", name: "Rated Current (In)", value: "250 A", sourceType: "official" }
        ]
      },
      "1SDA124707R1"
    ).item;
    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "abb" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const ws = out.getWorksheet("contactor a. fuses")!;
    expect(ws.getRow(9).values).toEqual([
      ,
      "1SDA124707R1",
      24,
      250,
      250,
      250,
      250,
      250,
      250
    ]);
    expect(ws.getCell(9, 10).value).toBeNull();
    expect(result.requiredFieldIssues).toEqual([]);
    expect(result.cellAudit.records.some((record) =>
      record.catalogNumber === "1SDA124707R1" &&
      record.code === "AAN521" &&
      record.status === "skipped" &&
      record.ruleName === "abb-1sda-contactor-fuses-column-allowlist"
    )).toBe(true);
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
    expect(ws.getCell(9, 1).value).toBe("CAB-ENUM-1");
    expect(ws.getCell(9, 2).value).toBeNull();
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

  it("fills signal device PDT fields from official facts for non-Rockwell manufacturers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-generic-signal-facts-"));
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
    material.getCell(6, 3).value = "BAB577";
    material.getCell(7, 3).value = "BAB577";
    material.getCell(8, 3).value = "Depth";
    material.getCell(9, 3).value = "mm";

    const command = wb.addWorksheet("command and alarm device");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      command.getCell(row + 1, 1).value = label;
    }
    command.getCell(4, 2).value = "AAO676";
    command.getCell(5, 2).value = "AAO676";
    command.getCell(6, 2).value = "product article number of manufacturer";
    command.getCell(4, 3).value = "BAH005";
    command.getCell(5, 3).value = "BAH005";
    command.getCell(6, 3).value = "Rated voltage";
    command.getCell(7, 3).value = "V";
    command.getCell(4, 4).value = "BAD915";
    command.getCell(5, 4).value = "BAD915";
    command.getCell(6, 4).value = "Voltage type";
    command.getCell(4, 5).value = "AAG331";
    command.getCell(5, 5).value = "AAG331";
    command.getCell(6, 5).value = "Lamp color";
    command.getCell(4, 6).value = "AAC895";
    command.getCell(5, 6).value = "AAC895";
    command.getCell(6, 6).value = "Signal diameter";
    command.getCell(7, 6).value = "mm";
    command.getCell(4, 7).value = "AAI677";
    command.getCell(5, 7).value = "AAI677";
    command.getCell(6, 7).value = "Sound level";
    command.getCell(7, 7).value = "dB";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        manufacturerId: "siemens",
        title: "Modular stack light",
        attributes: [
          { group: "Technical data", name: "Rated Voltage", value: "12 V DC", sourceType: "official", confidence: 0.96 },
          { group: "Mechanical data", name: "Depth", value: "12 mm", sourceType: "official", confidence: 0.96 },
          { group: "Technical data", name: "Lens Color", value: "blue", sourceType: "official", confidence: 0.96 },
          { group: "Technical data", name: "Signal Diameter", value: "40 mm", sourceType: "official", confidence: 0.96 },
          { group: "Technical data", name: "Sound Pressure", value: "95 dB", sourceType: "official", confidence: 0.96 }
        ]
      },
      "SIG-12-BLUE",
      "Stack Light / Beacon"
    ).item;

    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "siemens" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    expect(result.requiredFieldIssues).toEqual([]);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const materialOut = out.getWorksheet("Material Master Data")!;
    expect(materialOut.getCell(11, 2).value).toBe("SIG-12-BLUE");
    expect(materialOut.getCell(11, 3).value).toBe(12);
    const commandOut = out.getWorksheet("command and alarm device")!;
    expect(commandOut.getCell(9, 1).value).toBe("SIG-12-BLUE");
    expect(commandOut.getCell(9, 2).value).toBe(12);
    expect(commandOut.getCell(9, 3).value).toBe("DC");
    expect(commandOut.getCell(9, 4).value).toBe("blue");
    expect(commandOut.getCell(9, 5).value).toBe(40);
    expect(commandOut.getCell(9, 6).value).toBe(95);
    expect(result.cellAudit.records).toContainEqual(
      expect.objectContaining({
        sheetName: "Material Master Data",
        catalogNumber: "SIG-12-BLUE",
        code: "BAB577",
        sourceKind: "attribute",
        reason: 'Physical attribute "Depth" promoted to PDT pdtDepthMm.'
      })
    );
  });

  it("marks missing profile-critical device fields red even when the template does not flag them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-profile-critical-"));
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
    material.getCell(6, 3).value = "AAF040";
    material.getCell(7, 3).value = "AAF040";
    material.getCell(8, 3).value = "Weight";
    material.getCell(9, 3).value = "kg";

    const command = wb.addWorksheet("command and alarm device");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      command.getCell(row + 1, 1).value = label;
    }
    command.getCell(4, 2).value = "AAO676";
    command.getCell(5, 2).value = "AAO676";
    command.getCell(6, 2).value = "product article number of manufacturer";
    command.getCell(4, 3).value = "BAH005";
    command.getCell(5, 3).value = "BAH005";
    command.getCell(6, 3).value = "Rated voltage";
    command.getCell(7, 3).value = "V";
    command.getCell(4, 4).value = "AAG331";
    command.getCell(5, 4).value = "AAG331";
    command.getCell(6, 4).value = "Lamp color";
    command.getCell(4, 5).value = "AAC895";
    command.getCell(5, 5).value = "AAC895";
    command.getCell(6, 5).value = "Signal diameter";
    command.getCell(7, 5).value = "mm";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Stack beacon",
        attributes: [{ name: "Product Type", value: "Stack Light / Beacon", sourceType: "official" }]
      },
      "STACK-EMPTY-1",
      "Stack Light / Beacon"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.requiredFieldIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheetName: "Material Master Data", catalogNumber: "STACK-EMPTY-1", code: "AAF040", priority: "profile-critical" }),
        expect.objectContaining({ sheetName: "command and alarm device", catalogNumber: "STACK-EMPTY-1", code: "BAH005", priority: "profile-critical" }),
        expect.objectContaining({ sheetName: "command and alarm device", catalogNumber: "STACK-EMPTY-1", code: "AAG331", priority: "profile-critical" }),
        expect.objectContaining({ sheetName: "command and alarm device", catalogNumber: "STACK-EMPTY-1", code: "AAC895", priority: "profile-critical" })
      ])
    );

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const materialOut = out.getWorksheet("Material Master Data")!;
    const commandOut = out.getWorksheet("command and alarm device")!;
    expect((materialOut.getCell(11, 3).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFC7CE");
    expect((commandOut.getCell(9, 2).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFC7CE");
    expect((commandOut.getCell(9, 3).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFC7CE");
    expect((commandOut.getCell(9, 4).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFC7CE");
  });

  it("only marks voltage red for voltage-only device profiles", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-voltage-only-critical-"));
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

    const plc = wb.addWorksheet("PLC");
    for (const [row, label] of ["ClassId", "Priority", "Type", "PropertyId", "PropertyName", "Description", "Unit", "Body"].entries()) {
      plc.getCell(row + 1, 1).value = label;
    }
    plc.getCell(4, 2).value = "AAO676";
    plc.getCell(5, 2).value = "AAO676";
    plc.getCell(6, 2).value = "product article number of manufacturer";
    plc.getCell(4, 3).value = "BAH005";
    plc.getCell(5, 3).value = "BAH005";
    plc.getCell(6, 3).value = "Rated voltage";
    plc.getCell(7, 3).value = "V";
    plc.getCell(4, 4).value = "AAF726";
    plc.getCell(5, 4).value = "AAF726";
    plc.getCell(6, 4).value = "Rated current";
    plc.getCell(7, 4).value = "A";

    wb.addWorksheet("Additional Documents");
    await wb.xlsx.writeFile(templatePath);

    const item = ctx(
      {
        title: "Industrial communication gateway",
        attributes: [{ name: "Product Type", value: "Communication Gateway", sourceType: "official" }]
      },
      "GATEWAY-EMPTY-1",
      "Communication Gateway"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.requiredFieldIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheetName: "PLC", catalogNumber: "GATEWAY-EMPTY-1", code: "BAH005", priority: "profile-critical" })
      ])
    );
    expect(result.requiredFieldIssues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheetName: "PLC", catalogNumber: "GATEWAY-EMPTY-1", code: "AAF726" })
      ])
    );

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const plcOut = out.getWorksheet("PLC")!;
    expect((plcOut.getCell(9, 2).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFC7CE");
    expect((plcOut.getCell(9, 3).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb).toBeUndefined();
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
    expect(ws.getCell(9, 1).value).toBe("SENSOR-NO-IP");
    expect(ws.getCell(9, 2).value).toBeNull();
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
    expect(ws.getCell(9, 1).value).toBe("SW-META-1");
    expect(ws.getCell(9, 2).value).toBe(2.5);
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
      expect(outContactor.getCell(9, 1).value).toBe("24-60");
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
    expect(out.getWorksheet("switch")!.getCell(9, 1).value).toBe("SW-001");
  });

  it("routes a mixed batch of devices to the correct combination of tabs", async () => {
    // Simulate a typical real run: one Contactor, one Enclosure and one sensor in the same batch.
    // Expected behaviour:
    //   - Material Master Data + Additional Documents include ALL three products (constant tabs).
    //   - contactor a. fuses contains ONLY the contactor.
    //   - cabinet contains ONLY the enclosure.
    //   - cabinet.mechanical is kept (tab present) but intentionally left empty (ECADPORT fills it).
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
    expect(result.filledSheets["cabinet.mechanical"]).toBe(0);
    expect(result.filledSheets["electronic sensor"]).toBe(1);

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);

    // Material Master Data lists all three article numbers after one blank spacer row.
    const materialOut = out.getWorksheet("Material Master Data")!;
    expect(materialOut.getCell(10, 2).value ?? null).toBeNull();
    expect([
      materialOut.getCell(11, 2).value,
      materialOut.getCell(12, 2).value,
      materialOut.getCell(13, 2).value
    ]).toEqual(["CTR-001", "ENC-001", "SNS-001"]);

    // Each populated device-specific tab has one blank spacer row, then exactly its own product.
    expect(out.getWorksheet("contactor a. fuses")!.getCell(8, 1).value ?? null).toBeNull();
    expect(out.getWorksheet("contactor a. fuses")!.getCell(9, 1).value).toBe("CTR-001");
    expect(out.getWorksheet("contactor a. fuses")!.getCell(10, 1).value ?? null).toBeNull();

    expect(out.getWorksheet("cabinet")!.getCell(8, 1).value ?? null).toBeNull();
    expect(out.getWorksheet("cabinet")!.getCell(9, 1).value).toBe("ENC-001");
    expect(out.getWorksheet("cabinet")!.getCell(10, 1).value ?? null).toBeNull();

    expect(out.getWorksheet("cabinet.mechanical")!.getCell(8, 1).value ?? null).toBeNull();
    expect(out.getWorksheet("cabinet.mechanical")!.getCell(9, 1).value ?? null).toBeNull();

    expect(out.getWorksheet("electronic sensor")!.getCell(8, 1).value ?? null).toBeNull();
    expect(out.getWorksheet("electronic sensor")!.getCell(9, 1).value).toBe("SNS-001");
    expect(out.getWorksheet("electronic sensor")!.getCell(10, 1).value ?? null).toBeNull();

    // No cross-contamination: the contactor tab does not contain the sensor or enclosure, etc.
    const contactorRow1Values = [
      out.getWorksheet("contactor a. fuses")!.getCell(9, 1).value,
      out.getWorksheet("contactor a. fuses")!.getCell(10, 1).value
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

  it("does not fill Rockwell connection point rows from family rules without source evidence", async () => {
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

    expect(result.filledSheets["Connection Point Information"]).toBe(0);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const values = valuesInWorksheet(out.getWorksheet("Connection Point Information")!);
    expect(values).not.toContain("2080-LC20-20AWB");
    expect(values).not.toContain("+DC10");
    expect(values).not.toContain("I-00");
    expect(values).not.toContain("O-00");
    expect(values).not.toContain("DIN rail mounting");
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

  it("does not synthesize Rockwell accessory catalog numbers from uncurated shorthand evidence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-product-accessory-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const item = ctx(
      {
        manufacturerId: "rockwell",
        title: "ControlLogix Processor",
        attributes: [
          { group: "PDF datasheet - Technical Data", name: "Accessories", value: "Vertical Mounting Brackets", sourceType: "official" },
          { group: "PDF datasheet - Technical Data", name: "AVM", value: "Vertical bracket", sourceType: "official" }
        ]
      },
      "1756-L902TSXT"
    ).item;

    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "rockwell" } as ManufacturerConfig, items: [item], templatePath, outputPath });

    expect(result.filledSheets["Product Accessory"]).toBeUndefined();
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const values = valuesInWorksheet(out.getWorksheet("Product Accessory")!);
    expect(values).not.toContain("852C-ABVM");
    expect(values).not.toContain("accessory");
  });

  it("fills generic Product Accessory rows from explicit official accessory attributes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-product-accessory-generic-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const item = ctx(
      {
        manufacturerId: "generic-maker",
        title: "ABC modular controller",
        attributes: [
          { group: "Accessories", name: "Recommended accessories", value: "ABC-2000 mounting kit", sourceType: "official" }
        ]
      },
      "ABC-1000"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.filledSheets["Product Accessory"]).toBe(1);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const values = valuesInWorksheet(out.getWorksheet("Product Accessory")!);
    expect(values).toContain("ABC-1000");
    expect(values).toContain("ABC-2000");
    expect(values).toContain("accessory");
  });

  it("does not infer generic Product Accessory rows from sibling catalog mentions in ordinary text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-product-accessory-generic-negative-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const item = ctx(
      {
        manufacturerId: "generic-maker",
        title: "ABC modular controller, same family as ABC-2000",
        description: "Use the ABC-1000 where a compact controller is required; ABC-2000 is a larger sibling.",
        attributes: [
          { group: "Product data", name: "Description", value: "Family page also lists ABC-2000.", sourceType: "official" }
        ]
      },
      "ABC-1000"
    ).item;

    const result = await exportRunPdt({ manufacturer, items: [item], templatePath, outputPath });

    expect(result.filledSheets["Product Accessory"]).toBeUndefined();
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const values = valuesInWorksheet(out.getWorksheet("Product Accessory")!);
    expect(values).not.toContain("ABC-2000");
    expect(values).not.toContain("accessory");
  });

  it("adds curated Rockwell 852C/852D vertical mounting accessories", async () => {
    expect(CURATED_ACCESSORY_RULES.every((rule) => rule.name && rule.manufacturerId && rule.rationale)).toBe(true);
    expect(CURATED_ACCESSORY_RULES.every((rule) => /\b(?:Manual Rockwell PDT|curated)\b/i.test(rule.rationale))).toBe(true);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-product-accessory-curated-"));
    const templatePath = path.resolve("templates", "master_pdt.xlsx");
    const outputPath = path.join(dir, "out.xlsx");
    const items = [
      ctx({ manufacturerId: "rockwell", title: "3 Color 35mm LED Indicator with sound" }, "852C-B24RGYPQD5").item,
      ctx({ manufacturerId: "rockwell", title: "3 Color 35mm LED Indicator" }, "852C-B24RGYQD5").item,
      ctx({ manufacturerId: "rockwell", title: "7 Color 35mm LED Indicator with sound" }, "852C-B30MCPQD5").item,
      ctx({ manufacturerId: "rockwell", title: "7 Color 35mm LED Indicator" }, "852C-B30MCQD5").item,
      ctx({ manufacturerId: "rockwell", title: "3 Color 55mm LED Indicator with sound" }, "852D-B24RGYPQD5").item
    ];

    const result = await exportRunPdt({ manufacturer: { ...manufacturer, id: "rockwell" } as ManufacturerConfig, items, templatePath, outputPath });

    expect(result.filledSheets["Product Accessory"]).toBe(5);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const values = valuesInWorksheet(out.getWorksheet("Product Accessory")!);
    expect(values).toContain("852C-ABVM");
    expect(values).toContain("852C-B30MCQD5");
    expect(values).toContain("852D-ABVM");
    expect(values).toContain("852D-B24RGYPQD5");
    expect(values.filter((value) => value === "852C-ABVM")).toHaveLength(4);
    expect(values.filter((value) => value === "accessory")).toHaveLength(5);
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
        if (sheetName === "cabinet.mechanical") continue;
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
    expect(out.getWorksheet("Material Master Data")!.getCell(11, 2).value).toBe("TYPE-001");
    expect(out.getWorksheet("Material Master Data")!.getCell(10 + items.length, 2).value).toBe(
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
        if (sheetName === "cabinet.mechanical") continue;
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
      "cabinet.mechanical",
      ...expectedCounts.keys()
    ]);
    expect(new Set(result.keptSheets)).toEqual(expectedKeptSheets);
    expect(result.keptSheets).not.toContain("connector.optical");

    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outputPath);
    const materialOut = out.getWorksheet("Material Master Data")!;
    expect(materialOut.getRow(11).values).toContain("REAL-001");
    expect(materialOut.getRow(10 + items.length).values).toContain(`REAL-${String(items.length).padStart(3, "0")}`);

    const allCatalogs = items.map((item) => item.catalogNumber);
    for (const [sheetName, expectedCatalogs] of expectedCatalogsBySheet) {
      const ws = out.getWorksheet(sheetName)!;
      const actualCatalogs = [...new Set(valuesInWorksheet(ws).filter((value) => allCatalogs.includes(value)))];
      expect(actualCatalogs.sort(), sheetName).toEqual([...expectedCatalogs].sort());
    }
  }, 15000);

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
          manufacturerId: "abb",
          title: "EKIP BUSBARS SUPPLY E1.3...E6.3",
          description: "Emax 3 Ekip Busbars Supply accessory for busbar voltage measurement.",
          attributes: [{ group: "ABB Product Data", name: "Product Type", value: "Busbar", sourceType: "official" }]
        },
        "1SDA126493R1"
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
      // ABB 1SDA accessory-like articles are forced to "contactor a. fuses"; explicit product
      // types like Busbar keep their semantic PDT tab.
      ["contactor a. fuses", ["1SDA124715R1", "1SDA126387R1", "1140-E"]],
      ["Busbar", ["1SDA126493R1"]],
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
        minValues: 5,
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
        minValues: 9,
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
    expect(ws.getCell(8, 1).value).toBe("1SBL347060R1100");
    expect(ws.getCell(8, 2).value).toBe(1);
    expect(ws.getCell(8, 4).value).toEqual({
      text: "https://new.abb.com/products/1SBL347060R1100",
      hyperlink: "https://new.abb.com/products/1SBL347060R1100"
    });
    expect(ws.getCell(9, 4).value).toEqual({
      text: "https://new.abb.com/products/de/1SBL347060R1100",
      hyperlink: "https://new.abb.com/products/de/1SBL347060R1100"
    });
    expect(ws.getCell(9, 5).value).toBe("german");
    expect(ws.getCell(10, 1).value).toBeNull();
    expect(ws.getCell(11, 1).value).toBe("1SBL347060R1200");
  });

  it("uses scraped ABB product URLs in Additional Documents when the scraper found the specific page", () => {
    const ws = addDocumentsWorksheet();
    const productUrl = "https://www.abb.com/global/en/products/1sap250500r0001";
    const germanUrl = "https://www.abb.com/global/de/products/1sap250500r0001";
    const item = ctx(
      {
        manufacturerId: "abb",
        productUrl,
        localizedUrls: {
          en: "https://new.abb.com/smartlinks/en?ProductId=AC522",
          de: germanUrl
        }
      },
      "AC522"
    ).item;

    expect(writeDocumentsSheet(ws, [item])).toBe(2);
    expect(ws.getCell(8, 1).value).toBe("AC522");
    expect(ws.getCell(8, 4).value).toEqual({ text: productUrl, hyperlink: productUrl });
    expect(ws.getCell(8, 5).value).toBe("english");
    expect(ws.getCell(9, 4).value).toEqual({ text: germanUrl, hyperlink: germanUrl });
    expect(ws.getCell(9, 5).value).toBe("german");
  });

  it("uses official ABB CP6610 datasheet and family page in Additional Documents", () => {
    const ws = addDocumentsWorksheet();
    const item = ctx(
      {
        manufacturerId: "abb",
        productUrl: "https://www.abb.com/global/en/areas/motion/plc/control-panels/cp600-pro"
      },
      "CP6610"
    ).item;

    expect(writeDocumentsSheet(ws, [item])).toBe(2);
    const urls = [ws.getCell(8, 4).value, ws.getCell(9, 4).value].map((value) =>
      typeof value === "object" && value && "hyperlink" in value ? value.hyperlink : String(value)
    );
    expect(urls).toEqual([
      "https://library.e.abb.com/public/0df8d53c4774407a8cfc66bd9cbd9112/CP6610_Data_Sheet_3ADR010234%2C%202%2C%20en_US_RevB.pdf",
      "https://www.abb.com/global/en/areas/motion/plc/control-panels/cp600-pro"
    ]);
    expect(urls.some((url) => /new\.abb\.com\/products/i.test(url))).toBe(false);
  });

  it("adds German Rockwell product-page row when a direct English PDF was scraped", () => {
    const ws = addDocumentsWorksheet();
    const deUrl = "https://www.rockwellautomation.com/de-de/products/details.700-HB32A1-3-4.html";
    const pdfUrl = "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/700-td552_-en-p.pdf";
    const item = ctx(
      {
        manufacturerId: "rockwell",
        localizedUrls: {
          en: "https://www.rockwellautomation.com/en-us/products/details.700-HB32A1-3-4.html",
          de: deUrl
        },
        documents: [
          {
            type: "datasheet",
            label: "700-td552_-en-p",
            url: pdfUrl,
            sourceType: "official",
            parser: "rockwell-product-page",
            confidence: 0.95
          }
        ]
      },
      "700-HB32A1-3-4"
    ).item;

    expect(writeDocumentsSheet(ws, [item])).toBe(2);
    expect(ws.getCell(8, 4).value).toEqual({ text: pdfUrl, hyperlink: pdfUrl });
    expect(ws.getCell(8, 5).value).toBe("english");
    expect(ws.getCell(9, 4).value).toEqual({ text: deUrl, hyperlink: deUrl });
    expect(ws.getCell(9, 5).value).toBe("german");
    expect(ws.getCell(9, 7).value).toBe("Datenblatt");
  });

  it("writes English and German Rockwell product-page rows for 1444-DYN04", () => {
    const ws = addDocumentsWorksheet();
    const enUrl = "https://www.rockwellautomation.com/en-us/products/details.1444-dyn04-01ra.html";
    const deUrl = "https://www.rockwellautomation.com/de-de/products/details.1444-dyn04-01ra.html";
    const item = ctx(
      {
        manufacturerId: "rockwell",
        productUrl: enUrl,
        localizedUrls: {
          en: enUrl,
          de: deUrl
        }
      },
      "1444-DYN04-01RA"
    ).item;

    expect(writeDocumentsSheet(ws, [item])).toBe(2);
    expect(ws.getCell(8, 4).value).toEqual({ text: enUrl, hyperlink: enUrl });
    expect(ws.getCell(8, 5).value).toBe("english");
    expect(ws.getCell(9, 4).value).toEqual({ text: deUrl, hyperlink: deUrl });
    expect(ws.getCell(9, 5).value).toBe("german");
    expect(ws.getCell(9, 7).value).toBe("Datenblatt");
  });

  it("uses scraped localized official URLs for manufacturers without PDT document rules", () => {
    const ws = addDocumentsWorksheet();
    const item = ctx(
      {
        manufacturerId: "generic-maker",
        productUrl: "https://example.test/products/GEN-1",
        localizedUrls: {
          en: "https://example.test/en/products/GEN-1",
          de: "https://example.test/de/produkte/GEN-1"
        }
      },
      "GEN-1"
    ).item;

    expect(writeDocumentsSheet(ws, [item])).toBe(2);
    expect(ws.getCell(8, 1).value).toBe("GEN-1");
    expect(ws.getCell(8, 4).value).toEqual({
      text: "https://example.test/en/products/GEN-1",
      hyperlink: "https://example.test/en/products/GEN-1"
    });
    expect(ws.getCell(8, 5).value).toBe("english");
    expect(ws.getCell(9, 4).value).toEqual({
      text: "https://example.test/de/produkte/GEN-1",
      hyperlink: "https://example.test/de/produkte/GEN-1"
    });
    expect(ws.getCell(9, 5).value).toBe("german");
  });

  it("adds the missing German Eaton document row when only an English direct PDF was scraped", () => {
    const ws = addDocumentsWorksheet();
    const item = ctx(
      {
        manufacturerId: "eaton",
        documents: [
          {
            type: "datasheet",
            label: "Eaton 142824 datasheet",
            url: "https://www.eaton.com/gb/en-gb/skuPage.142824.pdf",
            sourceType: "official",
            parser: "test",
            stage: "download",
            confidence: 0.95
          }
        ]
      },
      "142824"
    ).item;

    expect(writeDocumentsSheet(ws, [item])).toBe(2);
    expect(ws.getCell(8, 4).value).toEqual({
      text: "https://www.eaton.com/gb/en-gb/skuPage.142824.pdf",
      hyperlink: "https://www.eaton.com/gb/en-gb/skuPage.142824.pdf"
    });
    expect(ws.getCell(8, 5).value).toBe("english");
    expect(ws.getCell(9, 4).value).toEqual({
      text: "https://www.eaton.com/de/de-de/skuPage.142824.pdf",
      hyperlink: "https://www.eaton.com/de/de-de/skuPage.142824.pdf"
    });
    expect(ws.getCell(9, 5).value).toBe("german");
    expect(ws.getCell(9, 7).value).toBe("Datenblatt");
  });

  it("prefers direct Rockwell literature PDFs over product pages for unknown families", () => {
    const ws = addDocumentsWorksheet();
    const item = ctx(
      {
        manufacturerId: "rockwell",
        productUrl: "https://www.rockwellautomation.com/en-us/products/details.5094-IF8.html",
        localizedUrls: {
          en: "https://www.rockwellautomation.com/en-us/products/details.5094-IF8.html",
          de: "https://www.rockwellautomation.com/de-de/products/details.5094-IF8.html"
        },
        documents: [
          {
            type: "datasheet",
            label: "Technical Detail",
            url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5094-td001_-en-p.pdf",
            sourceType: "official",
            confidence: 0.9
          },
          {
            type: "manual",
            label: "Installation Instructions",
            url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/in/5094-in001_-en-p.pdf",
            sourceType: "official",
            confidence: 0.8
          }
        ]
      },
      "5094-IF8"
    ).item;

    expect(writeDocumentsSheet(ws, [item])).toBe(2);
    expect(ws.getCell(8, 1).value).toBe("5094-IF8");
    expect(ws.getCell(8, 3).value).toBe("pdf");
    expect(ws.getCell(8, 4).value).toEqual({
      text: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5094-td001_-en-p.pdf",
      hyperlink: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5094-td001_-en-p.pdf"
    });
    expect(ws.getCell(8, 5).value).toBe("english");
    expect(ws.getCell(8, 7).value).toBe("Technical Datasheet (EN)");
    expect(ws.getCell(9, 4).value).toEqual({
      text: "https://www.rockwellautomation.com/de-de/products/details.5094-IF8.html",
      hyperlink: "https://www.rockwellautomation.com/de-de/products/details.5094-IF8.html"
    });
    expect(ws.getCell(9, 5).value).toBe("german");
    expect(ws.getCell(9, 7).value).toBe("Datenblatt");
  });

  it("uses direct Eaton skuPage PDFs from scraper documents without adding EP to the path", () => {
    const ws = addDocumentsWorksheet();
    const item = ctx(
      {
        manufacturerId: "eaton",
        productUrl: "https://www.eaton.com/gb/en-gb/skuPage.284245.html",
        documents: [
          {
            type: "datasheet",
            label: "Eaton Specification Sheet - 284245",
            url: "https://www.eaton.com/gb/en-gb/skuPage.284245.pdf",
            sourceType: "official-fallback",
            confidence: 0.9
          }
        ]
      },
      "XSFH20"
    ).item;

    expect(writeDocumentsSheet(ws, [item])).toBe(2);
    expect(ws.getCell(8, 1).value).toBe("XSFH20");
    expect(ws.getCell(8, 3).value).toBe("pdf");
    expect(ws.getCell(8, 4).value).toEqual({
      text: "https://www.eaton.com/gb/en-gb/skuPage.284245.pdf",
      hyperlink: "https://www.eaton.com/gb/en-gb/skuPage.284245.pdf"
    });
    expect(String((ws.getCell(8, 4).value as { text: string }).text)).not.toContain("EP-284245");
    expect(ws.getCell(8, 5).value).toBe("english");
    expect(ws.getCell(8, 7).value).toBe("Datasheet(EN)");
    expect(ws.getCell(9, 4).value).toEqual({
      text: "https://www.eaton.com/de/de-de/skuPage.284245.pdf",
      hyperlink: "https://www.eaton.com/de/de-de/skuPage.284245.pdf"
    });
    expect(ws.getCell(9, 5).value).toBe("german");
    expect(ws.getCell(9, 7).value).toBe("Datenblatt");
  });
});

describe("colour property name fallback", () => {
  it("resolves a colour column whose ECLASS code has no dedicated resolver from the scraped colour", () => {
    const c = ctx({
      normalized: { color: "ANSI-61 gray (optional sub-panels white)" }
    });
    // Unmapped ECLASS code, but the property name denotes a colour → resolves from normalized.color.
    expect(resolveProperty("ZZ999999", "Colour", c)).toBe("gray");
    expect(resolveProperty("ZZ999999", "Colour of housing", c)).toBe("gray");
    expect(resolveProperty("ZZ999999", "Farbe", c)).toBe("gray");
  });

  it("derives the colour from the finish text when normalized.color is absent", () => {
    const c = ctx({
      normalized: { finish: "ANSI-61 gray powder coat inside and out." }
    });
    expect(resolveProperty("ZZ999999", "Colour", c)).toBe("gray");
  });

  it("never mis-fills colour look-alike columns", () => {
    const c = ctx({ normalized: { color: "gray" } });
    expect(resolveProperty("ZZ999999", "Number of colours", c)).toBeUndefined();
    expect(resolveProperty("ZZ999999", "Colour temperature", c)).toBeUndefined();
    expect(resolveProperty("ZZ999999", "Colour rendering index", c)).toBeUndefined();
  });

  it("leaves the colour column empty when nothing colour-like was scraped", () => {
    const c = ctx({ normalized: {} });
    expect(resolveProperty("ZZ999999", "Colour", c)).toBeUndefined();
  });
});
