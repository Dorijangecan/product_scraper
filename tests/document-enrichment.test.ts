import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { ProductResult } from "../src/shared/types.js";
import { documentAttributesAreSubstantive, enrichResultFromDownloadedDocuments, enrichResultFromRemoteDocuments, extractDocumentTextAttributes, isCleanSingleSpecValue } from "../src/server/scrapers/document-enrichment.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";
import { normalizeTechnicalAttributes } from "../src/server/scrapers/technical-attributes.js";
import {
  applyCustomerDocumentOverride,
  extractCustomerDocumentAttributes,
  extractCustomerFamilyPdfAttributes,
  extractCustomerPdfTableAttributes
} from "../src/server/scrapers/customer-documents.js";
import { classifyDeviceType } from "../src/server/scrapers/device-type.js";

describe("isCleanSingleSpecValue", () => {
  it("accepts a single weight/dimension reading with its own unit conversion", () => {
    expect(isCleanSingleSpecValue("270 g (0.60 lb)")).toBe(true);
    expect(isCleanSingleSpecValue("32 x 124 x 102 mm (1.26 x 4.88 x 4.02 in.)")).toBe(true);
  });

  it("rejects several different weight/dimension readings joined with / or |", () => {
    expect(isCleanSingleSpecValue("930 g / 440 g")).toBe(false);
    expect(isCleanSingleSpecValue("90 x 106 x 70 mm | 120 x 90 x 60 mm")).toBe(false);
  });

  it("accepts a single, plausible electrical reading", () => {
    expect(isCleanSingleSpecValue("48V")).toBe(true);
    expect(isCleanSingleSpecValue("20 A")).toBe(true);
  });

  it("rejects a value that repeats its own label text (two rows concatenated into one string)", () => {
    // Real reported symptom: a merged-column table row misaligned by buildVariantColumnContext's
    // naive left-to-right cell counting glued two different rows' label+value pairs together.
    expect(isCleanSingleSpecValue("Current 20 A Current 480 watt")).toBe(false);
  });
});

describe("documentAttributesAreSubstantive", () => {
  const stub = { group: "PDF Document", name: "Parsed document", value: "datasheet.pdf" };
  const real = { name: "Operating voltage", value: "24 V DC" };

  it("treats a lone 'Parsed document' marker as non-substantive (parseStatus should be skipped)", () => {
    expect(documentAttributesAreSubstantive([stub])).toBe(false);
    expect(documentAttributesAreSubstantive([])).toBe(false);
  });

  it("treats even a single genuine attribute as substantive (the old length>1 proxy mislabelled this)", () => {
    expect(documentAttributesAreSubstantive([real])).toBe(true);
    expect(documentAttributesAreSubstantive([stub, real])).toBe(true);
  });
});

describe("document enrichment", () => {
  it("extracts PDF table specs for datasheets", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "BCC039H",
      document: {
        type: "datasheet",
        label: "Datasheet",
        url: "https://example.test/bcc039h.pdf"
      },
      text: `
Basic features
Approval/Conformity \tCE
cULus
WEEE
Electrical data
Operating voltage Ub \t250 VDC / 250 VAC
Rated current (40 °C) \t4.0 A
Material
Cable jacket, material \tPUR
Mechanical data
Cable length L \t0.30 m
      `
    });
    const normalized = normalizeFields(attributes, []);
    expect(attributes.some((attr) => attr.name === "Operating voltage Ub" && attr.value === "250 VDC / 250 VAC")).toBe(true);
    expect(normalized.voltage).toBe("250 V DC / 250 V AC");
    expect(normalized.current).toBe("4.0 A");
    expect(normalized.material).toBe("PUR");
  });

  it("extracts voltage, current, power dissipation and certificates from a Turck sensor datasheet", () => {
    // Labels exactly as they appear in the Turck NI12U-EG18SK-VP4X datasheet PDF (user report).
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "NI12U-EG18SK-VP4X",
      document: {
        type: "datasheet",
        label: "Datasheet",
        url: "https://pdb2.turck.com/datasheet/1581801.pdf"
      },
      text: `
NI12U-EG18SK-VP4X  Inductive Sensor
Operating voltage U B \t10…65 VDC
Supply voltage \t24 VDC
Power dissipation, typical \t<= 3.5 W
Operating current \tMax. 145 mA
Approvals and certificates \tCE
UL Certificate \tcULus LISTED 21 W2, Encl.type 1 IND.CONT.EQ.
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(normalized.voltage).toBeTruthy();
    expect(normalized.current).toBe("Max. 145 mA");
    expect(normalized.certificates).toMatch(/CE/);
    expect(normalized.certificates).toMatch(/cULus/);
    expect(attributes.some((attr) => /power dissipation/i.test(attr.name) && /3\.5\s*W/.test(attr.value))).toBe(true);
  });

  it("extracts Turck real PDF current labels with DC prefix", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "NI12U-EG18SK-VP4X",
      document: {
        type: "datasheet",
        label: "Datasheet",
        url: "https://hansturck.azureedge.net/edb/en_US_HQ/EDB_1581801_gbr_en.pdf"
      },
      text: `
Technical data
Type NI12U-EG18SK-VP4X
Electrical data
Operating voltage UB 10...65 VDC
DC rated operating current Ie <= 200 mA
No-load current <= 15 mA
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "PDF datasheet - Electrical data", name: "DC rated operating current Ie", value: "<= 200 mA" })
      ])
    );
    expect(normalized.voltage).toBe("10...65 V DC");
    expect(normalized.current).toBe("200 mA");
  });

  it("extracts common Eaton, Rockwell and enclosure PDF labels used by PDT resolvers", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "BR120",
      document: {
        type: "datasheet",
        label: "Technical datasheet",
        url: "https://example.test/br120.pdf"
      },
      text: `
General specifications
Voltage rating 120/240 V
Interrupt rating 10 kAIC
Number of poles 1
Frame size BR
Trip Type Thermal magnetic
NEMA rating NEMA Type 4X
Surface finishing Powder coating
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes.some((attr) => attr.name === "Voltage rating" && attr.value === "120/240 V")).toBe(true);
    expect(attributes.some((attr) => attr.name === "Interrupt rating" && attr.value === "10 kAIC")).toBe(true);
    expect(attributes.some((attr) => attr.name === "NEMA rating" && attr.value === "NEMA Type 4X")).toBe(true);
    expect(normalized.voltage).toBe("120/240 V");
    expect(normalized.finish).toBe("Powder coating");
  });

  it("reads wrapped German Eaton SKU-datasheet fields", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "143417",
      document: { type: "datasheet", label: "Eaton Specification Sheet - 143417", url: "https://www.eaton.com/de/de-de/skuPage.143417.pdf" },
      text: ["Produkthöhe", "15 mm", "Produktbreite", "760 mm", "Produkt Länge/Tiefe", "1910 mm", "Produktgewicht", "26 kg"].join("\n")
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Produkthöhe", value: "15 mm" }),
      expect.objectContaining({ name: "Produktgewicht", value: "26 kg" })
    ]));
    expect(normalized.dimensions).toBe("15 x 760 x 1910 mm");
    expect(normalized.weight).toBe("26 kg");
  });

  it("splits multiple known PDF label/value pairs from one extracted line", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ABC-123",
      document: {
        type: "datasheet",
        label: "Packed technical datasheet",
        url: "https://example.test/abc-123.pdf"
      },
      text: "Voltage rating 120 V Current ratings 5 A NEMA rating NEMA Type 4X Surface finishing Powder coating"
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Voltage rating", value: "120 V" }),
        expect.objectContaining({ name: "Current ratings", value: "5 A" }),
        expect.objectContaining({ name: "NEMA rating", value: "NEMA Type 4X" }),
        expect.objectContaining({ name: "Surface finishing", value: "Powder coating" })
      ])
    );
    expect(normalized.voltage).toBe("120 V");
    expect(normalized.current).toBe("5 A");
    expect(normalized.finish).toBe("Powder coating");
  });

  it("uses central field registry document labels when extracting PDF specs", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ABC-123",
      document: {
        type: "datasheet",
        label: "Registry-label datasheet",
        url: "https://example.test/abc-123.pdf"
      },
      text: `
General data
Enclosure protection
IP65
Materiale
ottone
Electrical data
Power input 24 V DC
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Enclosure protection", value: "IP65" }),
      expect.objectContaining({ name: "Materiale", value: "ottone" }),
      expect.objectContaining({ name: "Power input", value: "24 V DC" })
    ]));
    expect(normalized.protection).toBe("IP65");
    expect(normalized.material).toBe("brass");
    expect(normalized.voltage).toBe("24 V DC");
  });

  it("extracts inline PDF specs from registry aliases even when labels are unseen", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ABC-123",
      document: {
        type: "datasheet",
        label: "Alias-only datasheet",
        url: "https://example.test/abc-123-alias.pdf"
      },
      text: `
General data
Case material Stainless steel
Ingress protection IP67
Nominal voltage 48 V DC
Surface finish RAL 7035 powder coating
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Case material", value: "Stainless steel" }),
      expect.objectContaining({ name: "Ingress protection", value: "IP67" }),
      expect.objectContaining({ name: "Nominal voltage", value: "48 V DC" }),
      expect.objectContaining({ name: "Surface finish", value: "RAL 7035 powder coating" })
    ]));
    expect(normalized.material).toBe("Stainless steel");
    expect(normalized.protection).toBe("IP67");
    expect(normalized.voltage).toBe("48 V DC");
    expect(normalized.finish).toBe("RAL 7035 powder coating");
  });

  it("rejoins PDF table units that were extracted as separate cells before the value", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ABC-123",
      document: {
        type: "datasheet",
        label: "Unit table datasheet",
        url: "https://example.test/abc-123.pdf"
      },
      text: `
Electrical data
Rated voltage \t[V]\t24
Current ratings    [A]    2.5
Weight    [kg]    1.2
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "24 V" }),
        expect.objectContaining({ name: "Current ratings", value: "2.5 A" }),
        expect.objectContaining({ name: "Weight", value: "1.2 kg" })
      ])
    );
    expect(normalized.voltage).toBe("24 V");
    expect(normalized.current).toBe("2.5 A");
    expect(normalized.weight).toBe("1.2 kg");
  });

  it("rejoins PDF label/unit/value blocks split across separate lines", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ABC-123",
      document: {
        type: "datasheet",
        label: "Stacked unit datasheet",
        url: "https://example.test/abc-123.pdf"
      },
      text: `
Electrical data
Rated supply voltage
V DC
24
Rated operating current
A
2.5
Net weight
kg
1.2
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated supply voltage", value: "24 V DC" }),
        expect.objectContaining({ name: "Rated operating current", value: "2.5 A" }),
        expect.objectContaining({ name: "Net weight", value: "1.2 kg" })
      ])
    );
    expect(normalized.voltage).toBe("24 V DC");
    expect(normalized.current).toBe("2.5 A");
    expect(normalized.weight).toBe("1.2 kg");
  });

  it("extracts and normalizes electrical aliases from PDF label/value layouts", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "MMP-25",
      document: {
        type: "datasheet",
        label: "Electrical datasheet",
        url: "https://example.test/mmp-25.pdf"
      },
      text: `
Electrical ratings
SCCR
100 kA
Short Circuit Current Rating (SCCR)
65 kA
Power dissipation per pole
5 W
Dissipation power
3.2 W
Static heat dissipation, non-current-dependent Pvs
1 W
Rated conditional short-circuit current Iq
50 kA
Input voltage
24 V DC
Output current
2.5 A
Utilization category
AC-3
      `
    });
    const normalized = normalizeFields(attributes, []);
    const technical = normalizeTechnicalAttributes("any-new-manufacturer", attributes);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "PDF datasheet - Electrical ratings", name: "SCCR", value: "100 kA" }),
        expect.objectContaining({ group: "PDF datasheet - Electrical ratings", name: "Short Circuit Current Rating (SCCR)", value: "65 kA" }),
        expect.objectContaining({ group: "PDF datasheet - Electrical ratings", name: "Power dissipation per pole", value: "5 W" }),
        expect.objectContaining({ group: "PDF datasheet - Electrical ratings", name: "Dissipation power", value: "3.2 W" }),
        expect.objectContaining({ group: "PDF datasheet - Electrical ratings", name: "Static heat dissipation, non-current-dependent Pvs", value: "1 W" }),
        expect.objectContaining({ group: "PDF datasheet - Electrical ratings", name: "Rated conditional short-circuit current Iq", value: "50 kA" }),
        expect.objectContaining({ group: "PDF datasheet - Electrical ratings", name: "Input voltage", value: "24 V DC" }),
        expect.objectContaining({ group: "PDF datasheet - Electrical ratings", name: "Output current", value: "2.5 A" })
      ])
    );
    expect(normalized.voltage).toBe("24 V DC");
    expect(normalized.current).toBe("2.5 A");
    expect([...new Set(technical.map((item) => item.canonicalKey))]).toEqual(
      expect.arrayContaining(["breakingCapacity", "powerLoss", "ratedVoltage", "ratedCurrent"])
    );
  });

  it("extracts Rockwell I/O datasheet labels into canonical technical attributes", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "5094-IF8",
      document: {
        type: "datasheet",
        label: "Rockwell I/O technical data",
        url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5094-td001_-en-p.pdf"
      },
      text: `
Technical specifications
Field Power Voltage Range
18...32 V DC
Current Draw @ 24V DC
180 mA
Output Current Rating
2 A per channel
Isolation Voltage
250 V continuous
On-state Voltage Drop
0.2 V max
Off-state Leakage Current
0.1 mA
      `
    });
    const technical = normalizeTechnicalAttributes("rockwell", attributes);

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Field Power Voltage Range", value: "18...32 V DC" }),
      expect.objectContaining({ name: "Current Draw @ 24V DC", value: "180 mA" }),
      expect.objectContaining({ name: "Output Current Rating", value: "2 A per channel" }),
      expect.objectContaining({ name: "Isolation Voltage", value: "250 V continuous" }),
      expect.objectContaining({ name: "On-state Voltage Drop", value: "0.2 V max" }),
      expect.objectContaining({ name: "Off-state Leakage Current", value: "0.1 mA" })
    ]));
    expect([...new Set(technical.map((item) => item.canonicalKey))]).toEqual(
      expect.arrayContaining(["ratedVoltage", "ratedCurrent", "insulationVoltage", "voltageDrop", "leakageCurrent"])
    );
  });

  it("extracts source-backed contact rating voltage/current pairs from PDF tables", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "802T-KPE",
      document: {
        type: "datasheet",
        label: "Rockwell limit switch datasheet",
        url: "https://example.test/limit-td001.pdf"
      },
      text: `
Oiltight Limit Switches
802T Plug-in Style NEMA Oiltight Limit Switches
Table 22 - DC Contact Rating (Max per Pole)
Circuits \tVoltage Range \tCurrent Range
2
115…125
230…250
550…600
0.4 A
0.2 A
0.1 A
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes.some((attr) => attr.group === "PDF Contact Rating" && attr.name === "Voltage rating" && attr.value.includes("115...125 V DC"))).toBe(true);
    expect(attributes.some((attr) => attr.group === "PDF Contact Rating" && attr.name === "Current rating" && attr.value.includes("0.4 A"))).toBe(true);
    expect(normalized.voltage).toContain("115...125 V DC");
    expect(normalized.current).toContain("0.4 A");
  });

  it("extracts Siemens VSG dimensions and weight from dimension tables", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "BPZ:VSG519K15-5",
      document: {
        type: "datasheet",
        label: "VSG519K15-5 datasheet",
        url: "https://example.test/vsg519k15-5.pdf"
      },
      text: `
Material Valve body Spheroidal cast iron GJS-400-15
Standards, directives and approvals
EU conformity (CE) DN 50 A5W00023883
Dimensions
DN D
[Inches]
B
[mm]
L1
[mm]
L3
[mm]
H
[mm]
W
[kg]
15 G 1 9 100 254 100 4.5
      `
    });
    const normalized = normalizeFields(attributes, []);
    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Dimension Table Row", name: "Dimensions", value: expect.stringContaining("DN 15") }),
      expect.objectContaining({ group: "PDF Dimension Table Row", name: "Weight", value: "4.5 kg" })
    ]));
    expect(normalized.dimensions).toContain("DN 15");
    expect(normalized.weight).toBe("4.5 kg");
    expect(normalized.material).toBe("Valve body Spheroidal cast iron GJS-400-15");
    expect(normalized.certificates).toContain("CE");
  });

  it("extracts source-backed fields from generic catalog table rows for unseen products", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ZX-CTRL-24",
      document: {
        type: "datasheet",
        label: "ZX-CTRL-24 technical data",
        url: "https://example.test/zx-ctrl-24.pdf"
      },
      text: [
        "Technical data",
        "Catalog Number\tDescription\tProduct Type\tMaterial\tWidth [mm]\tHeight [mm]\tDepth [mm]\tWeight [kg]\tSupply voltage\tRated current",
        "ZX-CTRL-24\tCompact industrial controller\tProgrammable logic controller\tPolycarbonate\t120\t80\t55\t0.7\t24 V DC\t500 mA"
      ].join("\n")
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Table Row", name: "Catalog Number", value: "ZX-CTRL-24" }),
      expect.objectContaining({ group: "PDF Catalog Table Row", name: "Product Type", value: "Programmable logic controller" }),
      expect.objectContaining({ group: "PDF Catalog Table Row", name: "Dimensions", value: "W 120 mm x H 80 mm x D 55 mm" }),
      expect.objectContaining({ group: "PDF Catalog Table Row", name: "Weight", value: "0.7 kg" }),
      expect.objectContaining({ group: "PDF Catalog Table Row", name: "Voltage rating", value: "24 V DC" }),
      expect.objectContaining({ group: "PDF Catalog Table Row", name: "Current rating", value: "500 mA" })
    ]));
    expect(normalized.material).toBe("Polycarbonate");
    expect(normalized.dimensions).toBe("W 120 mm x H 80 mm x D 55 mm");
    expect(normalized.weight).toBe("0.7 kg");
    expect(normalized.voltage).toBe("24 V DC");
    expect(normalized.current).toBe("500 mA");
  });

  it("maps Eaton-style PDF ordering tables and localized technical pages without catalog hardcoding", () => {
    const document = {
      type: "datasheet" as const,
      label: "Rapid Link catalog",
      url: "https://example.test/rapid-link-cn.pdf"
    };
    const text = [
        "5G = \u901a\u7528\u7248\uff0cIP54",
        "5A = \u9ad8\u7ea7\u7248\uff0cIP65",
        "412 = HAN Q4/2, lower entrance",
        "512 = HAN Q5, lower entrance",
        "Rapid Link \u5206\u5e03\u5f0f\u53d8\u9891\u5668",
        "\u901a\u7528\u7248\uff0cIP54",
        "\u989d\u5b9a",
        "\u7535\u6d41",
        "(A)",
        "\u989d\u5b9a",
        "\u529f\u7387",
        "(kW)",
        "\u62b1\u95f8",
        "\u63a7\u5236",
        "\u7535\u538b",
        "\u65e0\u7ef4\u4fee\u5f00\u5173 \t\u5e26\u7ef4\u4fee\u5f00\u5173",
        "4DI/2DO 3 \t0.75 \t- \tRASP5G-0420A31-4120000S1-000 \tRASP5G-0420A31-412R000S1-000 \tRASP5G-0420A31-4120100S1-000 \tRASP5G-0420A31-412R100S1-000",
        "CDVRL00073 \tCDVRL00001 \tCDVRL00097 \tCDVRL00025",
        "DC180V \tRASP5G-0421A31-4120000S1-000 \tRASP5G-0421A31-412R000S1-000 \tRASP5G-0421A31-4120100S1-000 \tRASP5G-0421A31-412R100S1-000",
        "CDVRL00079 \tCDVRL00007 \tCDVRL00103 \tCDVRL00031",
        "\u9ad8\u7ea7\u7248\uff0cIP65",
        "4DI/2DO 3 \t0.75 \t- \tRASP5A-0420A31-4120010S1-000 \tRASP5A-0420A31-412R010S1-000 \tRASP5A-0420A31-4120110S1-000 \tRASP5A-0420A31-412R110S1-000",
        "CDVRL10073 \tCDVRL10001 \tCDVRL10097 \tCDVRL10025",
        "PROFINET",
        "\u901a\u7528\u7248\uff0cIP54",
        "4DI/2DO 3 \t0.75 \t- \tRASP5G-0420PNT-4120000S1-000 \tRASP5G-0420PNT-412R000S1-000 \tRASP5G-0420PNT-4120100S1-000 \tRASP5G-0420PNT-412R100S1-000",
        "CDVRL00361 \tCDVRL00289 \tCDVRL00385 \tCDVRL00313",
        "\u6280\u672f\u53c2\u6570\u548c\u89c4\u683c",
        "\u5c5e\u6027 \t\u4ea7\u54c1\u63cf\u8ff0 \t\u89c4\u683c",
        "\u989d\u5b9a\u8f93\u5165 \t\u8f93\u5165\u7535\u538b/\u9891\u7387 \t3 \u76f8 380 - 480V\uff0c-15% ~ +10 %\uff0c50/60 Hz",
        "\u9632\u62a4\u7b49\u7ea7 \tIP65\uff08RASP5A...\uff09\u3001IP54\uff08RASP5G...\uff09",
        "\u73af\u5883\u6761\u4ef6 \t\u5de5\u4f5c\u6e29\u5ea6 \t-25~45\u2103 \u65e0\u964d\u5bb9",
        "\u5c3a\u5bf8 (W x H x D, mm)",
        "\u529f\u7387 (kW) \t\u7c7b\u578b \tW \tH \tD \t\u8bf4\u660e",
        "0.75/1.5/2.2 \tRASP5X-...-xxx0xx0xx-\u2026 \t220 \t270 \t182 \t\u65e0\u7ef4\u4fee\u5f00\u5173\uff0c\u65e0\u98ce\u6247",
        "0.75/1.5/2.2 \tRASP5X-...-xxxRxx0xx-\u2026 \t220 \t290 \t182 \t\u6709\u7ef4\u4fee\u5f00\u5173\uff0c\u65e0\u98ce\u6247",
        "\u91cd\u91cf ( kg )",
        "\u529f\u7387 (kW) \t\u7c7b\u578b \t\u91cd\u91cf \t\u8bf4\u660e",
        "0.75/1.5/2.2 \tRASP5X-...-xxxR0x0xx-\u2026 \t3.76 \t\u6709\u7ef4\u4fee\u5f00\u5173\uff0c\u65e0\u5236\u52a8\u7535\u963b\uff0c\u65e0\u98ce\u6247",
        "0.75/1.5/2.2 \tRASP5X-...-xxxR1x0xx-\u2026 \t3.83 \t\u6709\u7ef4\u4fee\u5f00\u5173\uff0c\u6709\u5236\u52a8\u7535\u963b\uff0c\u65e0\u98ce\u6247"
    ].join("\n");
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "CDVRL00001",
      document,
      text
    });
    const normalized = normalizeFields(attributes, []);
    const technical = normalizeTechnicalAttributes("eaton", attributes);

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Catalog Number", value: "CDVRL00001" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Model Code", value: "RASP5G-0420A31-412R000S1-000" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Rated current", value: "3 A" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Rated power", value: "0.75 kW" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Degree of protection", value: "IP54" }),
      expect.objectContaining({ group: "PDF Model Pattern Table", name: "Dimensions", value: "220 x 290 x 182 mm" }),
      expect.objectContaining({ group: "PDF Model Pattern Table", name: "Weight", value: "3.76 kg" }),
      expect.objectContaining({ group: "PDF Localized Technical Data", name: "Product Type", value: "Variable frequency drive" }),
      expect.objectContaining({ group: "PDF Localized Technical Data", name: "Input voltage", value: "380...480 V" }),
      expect.objectContaining({ group: "PDF Localized Technical Data", name: "Degree of protection", value: "IP65; IP54" })
    ]));
    expect(normalized.current).toBe("3 A");
    expect(normalized.dimensions).toBe("220 x 290 x 182 mm");
    expect(normalized.weight).toBe("3.76 kg");
    expect(normalized.voltage).toBe("380...480 V");
    expect(normalized.protection).toBe("IP54; IP65");
    expect([...new Set(technical.map((item) => item.canonicalKey))]).toEqual(
      expect.arrayContaining(["ratedCurrent", "ratedVoltage", "power", "protection"])
    );

    const brakeVoltageAttributes = extractDocumentTextAttributes({
      catalogNumber: "CDVRL00007",
      document,
      text
    });
    expect(brakeVoltageAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Catalog Number", value: "CDVRL00007" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Model Code", value: "RASP5G-0421A31-412R000S1-000" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Rated current", value: "3 A" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Rated power", value: "0.75 kW" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table", name: "Control voltage", value: "180 V DC" })
    ]));

    const inferredHanQ5Attributes = extractDocumentTextAttributes({
      catalogNumber: "CDVRL00055",
      document,
      text
    });
    const inferredHanQ5Normalized = normalizeFields(inferredHanQ5Attributes, []);
    expect(inferredHanQ5Attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Catalog Number", value: "CDVRL00055" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Model Code", value: "RASP5G-0421A31-512R000S1-000" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Rated current", value: "3 A" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Control voltage", value: "180 V DC" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Inference basis", value: expect.stringContaining("512 = HAN Q5") }),
      expect.objectContaining({ group: "PDF Model Pattern Table", name: "Dimensions", value: "220 x 290 x 182 mm" }),
      expect.objectContaining({ group: "PDF Model Pattern Table", name: "Weight", value: "3.76 kg" })
    ]));
    expect(inferredHanQ5Normalized.current).toBe("3 A");
    expect(inferredHanQ5Normalized.dimensions).toBe("220 x 290 x 182 mm");
    expect(inferredHanQ5Normalized.weight).toBe("3.76 kg");

    const inferredAdvancedProfinetAttributes = extractDocumentTextAttributes({
      catalogNumber: "CDVRL10337",
      document,
      text
    });
    const inferredAdvancedProfinetNormalized = normalizeFields(inferredAdvancedProfinetAttributes, []);
    expect(inferredAdvancedProfinetAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Catalog Number", value: "CDVRL10337" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Model Code", value: "RASP5A-0420PNT-512R000S1-000" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Rated current", value: "3 A" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Degree of protection", value: "IP65" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Inference basis", value: expect.stringContaining("5A = advanced IP65") })
    ]));
    expect(inferredAdvancedProfinetNormalized.current).toBe("3 A");
    expect(inferredAdvancedProfinetNormalized.protection).toBe("IP65; IP54");
    expect(inferredAdvancedProfinetNormalized.dimensions).toBe("220 x 290 x 182 mm");
    expect(inferredAdvancedProfinetNormalized.weight).toBe("3.76 kg");

    const inferredC2AsiAttributes = extractDocumentTextAttributes({
      catalogNumber: "CDVRL20001",
      document,
      text
    });
    expect(inferredC2AsiAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Catalog Number", value: "CDVRL20001" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Model Code", value: "RASP5A-0420A31-412R020S1-000" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Inference basis", value: expect.stringContaining("EMC option 2") })
    ]));

    const inferredC2HanQ5Attributes = extractDocumentTextAttributes({
      catalogNumber: "CDVRL20169",
      document,
      text
    });
    const inferredC2HanQ5Normalized = normalizeFields(inferredC2HanQ5Attributes, []);
    expect(inferredC2HanQ5Attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Catalog Number", value: "CDVRL20169" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Model Code", value: "RASP5A-0420A31-512R020S1-000" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Inference basis", value: expect.stringContaining("512 = HAN Q5") })
    ]));
    expect(inferredC2HanQ5Normalized.current).toBe("3 A");
    expect(inferredC2HanQ5Normalized.dimensions).toBe("220 x 290 x 182 mm");
    expect(inferredC2HanQ5Normalized.weight).toBe("3.76 kg");

    const inferredC2HanQ5SubBlockAttributes = extractDocumentTextAttributes({
      catalogNumber: "CDVRL20217",
      document,
      text
    });
    expect(inferredC2HanQ5SubBlockAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Catalog Number", value: "CDVRL20217" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Model Code", value: "RASP5A-0420A31-5120020S1-000" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Inference basis", value: expect.stringContaining("512 = HAN Q5") })
    ]));

    const inferredC2ProfinetAttributes = extractDocumentTextAttributes({
      catalogNumber: "CDVRL20289",
      document,
      text
    });
    const inferredC2ProfinetNormalized = normalizeFields(inferredC2ProfinetAttributes, []);
    expect(inferredC2ProfinetAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Catalog Number", value: "CDVRL20289" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Model Code", value: "RASP5A-0420PNT-412R020S1-000" }),
      expect.objectContaining({ group: "PDF Catalog Ordering Table Inferred", name: "Rated current", value: "3 A" })
    ]));
    expect(inferredC2ProfinetNormalized.current).toBe("3 A");
    expect(inferredC2ProfinetNormalized.dimensions).toBe("220 x 290 x 182 mm");
    expect(inferredC2ProfinetNormalized.weight).toBe("3.76 kg");
  });

  it("extracts inline drawing dimensions from document text without product-family hardcoding", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "NX-DRAW-01",
      document: {
        type: "datasheet",
        label: "NX-DRAW-01 dimensional drawing",
        url: "https://example.test/nx-draw-01.pdf"
      },
      text: `
Mechanical data
Dimensional drawing
Overall dimensions approx. 34.5 mm x 27.5 mm x 19 mm
Material glass-filled polyamide
      `
    });
    const normalized = normalizeFields(attributes, []);

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        group: "PDF Dimension Text",
        name: "Dimensions",
        value: "34.5 mm x 27.5 mm x 19 mm"
      })
    ]));
    expect(normalized.dimensions).toBe("34.5 mm x 27.5 mm x 19 mm");
    expect(normalized.material).toBe("glass-filled polyamide");
  });

  it("uses customer CSV datasheets as source-backed Siemens evidence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-customer-docs-"));
    const storedPath = path.join(dir, "siemens-vsg519k15-5-datasheet.csv");
    await fs.writeFile(
      storedPath,
      [
        "MLFB,Product Short Text,Description,Product Type,Material,Dimensions,Weight,Certificates",
        "BPZ:VSG519K15-5,VSG519K15-5 differential pressure regulator,Siemens VSG519K15-5 differential pressure regulator valve DN 15,Differential pressure regulator valve,Valve body spheroidal cast iron GJS-400-15,\"DN 15; D G 1; B 9 mm; L1 100 mm; L3 254 mm; H 100 mm\",4.5 kg,CE"
      ].join("\n"),
      "utf8"
    );

    const extraction = await extractCustomerDocumentAttributes("BPZ:VSG519K15-5", [
      {
        id: "customer-doc-1",
        originalName: path.basename(storedPath),
        storedPath,
        mimeType: "text/csv",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const enriched = applyCustomerDocumentOverride(product({ manufacturerId: "siemens", catalogNumber: "BPZ:VSG519K15-5", status: "failed" }), extraction);

    expect(extraction.documents[0].type).toBe("datasheet");
    expect(extraction.sources[0].parser).toBe("customer-document");
    expect(enriched.status).toBe("found");
    expect(enriched.normalized.weight).toBe("4.5 kg");
    expect(enriched.normalized.dimensions).toContain("DN 15");
    expect(enriched.normalized.material).toBe("Valve body spheroidal cast iron GJS-400-15");
    expect(extraction.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "parsed",
        stage: "customer-document-enrichment",
        reason: expect.stringContaining("Parsed")
      })
    ]));
    expect(enriched.diagnostics?.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "parsed",
        stage: "customer-document-enrichment",
        label: `Customer document: ${path.basename(storedPath)}`
      })
    ]));
    expect(classifyDeviceType(enriched).type).toBe("Valve");
  });

  it("keeps quoted semicolon dimensions in customer CSV datasheets for Eaton hydraulic products", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-eaton-customer-docs-"));
    const storedPath = path.join(dir, "rare-device-sheets.csv");
    await fs.writeFile(
      storedPath,
      [
        "Catalog Number,Product Short Text,Description,Product Type,Material,Dimensions,Weight,Voltage,Current,Flow rate,Pressure,Power,Certificates",
        'HC-50-100,Hydraulic cylinder,Double acting hydraulic cylinder actuator with 50 mm bore and 100 mm stroke,Hydraulic cylinder,steel,"50 mm bore; 100 mm stroke",3.2 kg,,,,160 bar,,CE'
      ].join("\n"),
      "utf8"
    );

    const extraction = await extractCustomerDocumentAttributes("HC-50-100", [
      {
        id: "customer-doc-1",
        originalName: path.basename(storedPath),
        storedPath,
        mimeType: "text/csv",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const enriched = applyCustomerDocumentOverride(product({ manufacturerId: "eaton", catalogNumber: "HC-50-100", status: "failed" }), extraction);

    expect(extraction.documents[0].type).toBe("datasheet");
    expect(enriched.normalized.dimensions).toBe("Bore 50 mm; stroke 100 mm");
    expect(enriched.normalized.weight).toBe("3.2 kg");
    expect(enriched.attributes.some((attr) => attr.name === "Pressure" && attr.value === "160 bar")).toBe(true);
    expect(classifyDeviceType(enriched).type).toBe("Hydraulic Actuator");
  });

  it("attaches a customer spreadsheet's header unit to bare numeric cells so they normalize", async () => {
    // Customer feedback sheets routinely put the unit in the column header ("Weight (kg)",
    // "Maximum Power Loss (W)") and leave the cell as a bare number. Without reattaching the
    // unit, normalizeWeightValue/normalizePowerLoss silently drop the bare number and the
    // customer's cleanest, most structured column is discarded entirely.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-customer-header-unit-"));
    const storedPath = path.join(dir, "eaton-feedback.csv");
    await fs.writeFile(
      storedPath,
      [
        "Product Model,Order Number,Certification Information,Weight (kg),Maximum Power Loss (W)",
        "DV1-342D5PB-C20AL1,CDV00301,CE,0.89,12.5"
      ].join("\n"),
      "utf8"
    );

    const extraction = await extractCustomerDocumentAttributes("DV1-342D5PB-C20AL1", [
      {
        id: "customer-doc-1",
        originalName: path.basename(storedPath),
        storedPath,
        mimeType: "text/csv",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const normalized = normalizeFields(extraction.attributes, extraction.documents);

    expect(extraction.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Weight (kg)", value: "0.89 kg" })
    ]));
    expect(normalized.weight).toBe("0.89 kg");
    expect(normalized.certificates).toBe("CE");
  });

  it("uses free-text customer documents as source-backed datasheets", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-customer-text-docs-"));
    const storedPath = path.join(dir, "ABC-123-technical-datasheet.txt");
    await fs.writeFile(
      storedPath,
      [
        "ABC-123 compact controller",
        "Technical summary",
        "Housing material",
        "Polycarbonate",
        "Dimensions",
        "120 x 80 x 55 mm",
        "Weight",
        "0.7 kg",
        "Power input",
        "24 V DC"
      ].join("\n"),
      "utf8"
    );

    const extraction = await extractCustomerDocumentAttributes("ABC-123", [
      {
        id: "customer-doc-1",
        originalName: path.basename(storedPath),
        storedPath,
        mimeType: "text/plain",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const enriched = applyCustomerDocumentOverride(product({ catalogNumber: "ABC-123", status: "failed" }), extraction);

    expect(extraction.documents[0].type).toBe("datasheet");
    expect(extraction.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Housing material", value: "Polycarbonate", parser: "customer-document" }),
      expect.objectContaining({ name: "Power input", value: "24 V DC", parser: "customer-document" })
    ]));
    expect(enriched.normalized.material).toBe("Polycarbonate");
    expect(enriched.normalized.dimensions).toBe("120 x 80 x 55 mm");
    expect(enriched.normalized.weight).toBe("0.7 kg");
    expect(enriched.normalized.voltage).toBe("24 V DC");
    expect(enriched.diagnostics?.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "parsed",
        stage: "customer-document-enrichment",
        label: `Customer document: ${path.basename(storedPath)}`
      })
    ]));
  });

  it("uses DOCX customer documents as source-backed datasheets", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-customer-docx-docs-"));
    const storedPath = path.join(dir, "ZX-CTRL-24-technical-datasheet.docx");
    await writeMinimalDocx(storedPath, `
      <w:p><w:r><w:t>ZX-CTRL-24 compact controller</w:t></w:r></w:p>
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>Housing material</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Polycarbonate</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>Dimensions</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>120 x 80 x 55 mm</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>Weight</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>0.7 kg</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>Power input</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>24 V DC</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `);

    const extraction = await extractCustomerDocumentAttributes("ZX-CTRL-24", [
      {
        id: "customer-doc-1",
        originalName: path.basename(storedPath),
        storedPath,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const enriched = applyCustomerDocumentOverride(product({ catalogNumber: "ZX-CTRL-24", status: "failed" }), extraction);

    expect(extraction.documents[0].type).toBe("datasheet");
    expect(extraction.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Housing material", value: "Polycarbonate", parser: "customer-document" }),
      expect.objectContaining({ name: "Power input", value: "24 V DC", parser: "customer-document" })
    ]));
    expect(enriched.normalized.material).toBe("Polycarbonate");
    expect(enriched.normalized.dimensions).toBe("120 x 80 x 55 mm");
    expect(enriched.normalized.weight).toBe("0.7 kg");
    expect(enriched.normalized.voltage).toBe("24 V DC");
  });

  it("uses the central field registry to decide which normalized fields customer documents override", () => {
    const base = product({
      normalized: {
        finish: "black oxide",
        material: "steel"
      }
    });

    const enriched = applyCustomerDocumentOverride(base, {
      attributes: [
        {
          group: "Customer datasheet",
          name: "Surface treatment",
          value: "RAL 7035 powder coating",
          sourceUrl: "file:///customer/spec.csv",
          sourceType: "official",
          parser: "customer-document",
          stage: "customer-override",
          confidence: 0.97
        }
      ],
      sources: [],
      documents: [],
      parseFailures: [],
      documentProcessing: []
    });

    expect(enriched.normalized.finish).toBe("RAL 7035 powder coating");
    expect(enriched.normalized.material).toBe("steel");
  });

  it("classifies unseen customer spec tables as datasheets using the field registry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-customer-registry-docs-"));
    const storedPath = path.join(dir, "unseen-device-export.csv");
    await fs.writeFile(
      storedPath,
      [
        "MLFB,Product Short Text,Surface treatment,Enclosure protection,Power input,Working temperature",
        "ZX-77,Unseen control box,RAL 7035 powder coating,IP66,24 V DC,-20...60 °C"
      ].join("\n"),
      "utf8"
    );

    const extraction = await extractCustomerDocumentAttributes("ZX-77", [
      {
        id: "customer-doc-1",
        originalName: path.basename(storedPath),
        storedPath,
        mimeType: "text/csv",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const enriched = applyCustomerDocumentOverride(product({ catalogNumber: "ZX-77", status: "failed" }), extraction);

    expect(extraction.documents[0].type).toBe("datasheet");
    expect(enriched.status).toBe("found");
    expect(extraction.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Surface treatment", value: "RAL 7035 powder coating" }),
      expect.objectContaining({ name: "Enclosure protection", value: "IP66" }),
      expect.objectContaining({ name: "Power input", value: "24 V DC" }),
      expect.objectContaining({ name: "Working temperature", value: "-20...60 °C" })
    ]));
    expect(enriched.normalized.finish).toBe("RAL 7035 powder coating");
    expect(enriched.normalized.protection).toBe("IP66");
    expect(enriched.normalized.voltage).toBe("24 V DC");
  });

  it("extracts customer PDF specs even when the catalog number is not printed in the PDF text", async () => {
    const storedPath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const extraction = await extractCustomerDocumentAttributes("NO-MATCH", [
      {
        id: "customer-doc-1",
        originalName: "spec-00583.pdf",
        storedPath,
        mimeType: "application/pdf",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const enriched = applyCustomerDocumentOverride(product({ manufacturerId: "nvent", catalogNumber: "NO-MATCH", status: "failed" }), extraction);

    expect(extraction.documents[0].parseStatus).toBe("parsed");
    expect(extraction.attributes.some((attr) => attr.parser === "customer-unmatched-pdf-fallback" && attr.name === "Supply Voltage")).toBe(true);
    expect(extraction.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "parsed",
        attributeCount: expect.any(Number),
        normalizedFields: expect.arrayContaining(["protection", "voltage"]),
        pageCount: expect.any(Number)
      })
    ]));
    expect(enriched.normalized.protection).toBe("IP20");
  });

  it("does not let unmatched customer PDF fallback overwrite existing official normalized values", async () => {
    const storedPath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const extraction = await extractCustomerDocumentAttributes("NO-MATCH", [
      {
        id: "customer-doc-1",
        originalName: "spec-00583.pdf",
        storedPath,
        mimeType: "application/pdf",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const enriched = applyCustomerDocumentOverride(product({
      manufacturerId: "nvent",
      catalogNumber: "NO-MATCH",
      normalized: { voltage: "24 V DC", protection: "IP67" },
      attributes: [
        { group: "Official", name: "Rated voltage", value: "24 V DC", sourceType: "official" },
        { group: "Official", name: "Protection", value: "IP67", sourceType: "official" }
      ]
    }), extraction);

    expect(extraction.attributes.some((attr) => attr.confidence === 0.72)).toBe(true);
    expect(enriched.normalized.voltage).toBe("24 V DC");
    expect(enriched.normalized.protection).toBe("IP67");
  });

  it("keeps customer document no-match attempts visible in diagnostics", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-customer-docs-no-match-"));
    const storedPath = path.join(dir, "customer-sheets.csv");
    await fs.writeFile(
      storedPath,
      [
        "Catalog Number,Material,Weight",
        "OTHER-1,steel,1 kg"
      ].join("\n"),
      "utf8"
    );

    const extraction = await extractCustomerDocumentAttributes("ABC-123", [
      {
        id: "customer-doc-1",
        originalName: path.basename(storedPath),
        storedPath,
        mimeType: "text/csv",
        uploadedAt: "2026-06-02T00:00:00.000Z"
      }
    ]);
    const enriched = applyCustomerDocumentOverride(product({ catalogNumber: "ABC-123" }), extraction);

    expect(extraction.attributes).toEqual([]);
    expect(enriched.diagnostics?.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "skipped",
        stage: "customer-document-enrichment",
        reason: expect.stringContaining("no usable attributes for catalog ABC-123")
      })
    ]));
  });

  it("uses customer PDFs as family evidence when only the catalog family is printed", () => {
    const attributes = extractCustomerFamilyPdfAttributes(
      "5034-L9020TSXT",
      "02.-CompactLogix-5390-Controller.pdf",
      "file:///customer/02.-CompactLogix-5390-Controller.pdf",
      `
CompactLogix 5390 Controller
5034 Local I/O support
Support up to 32 IO modules
Operating Temperature
-25 to +60 Degree C
Operating Temperature XT
-40 to +70 Degree C
CIP Security
IEC-62443-4-2
Catalogs planned for release
5034-L9020TS CompactLogix 2MB Controller
      `
    );

    // No "Requested catalog number" attribute: this function's first argument can be an alias
    // sourced from a sibling document rather than the customer's actually-requested catalog
    // number, so echoing it back under a strong-identity label would make
    // structuredIdentityConflict treat it as a second, conflicting product identity (see
    // extractByAliasCatalogNumber / stripAliasIdentityEcho in customer-documents.ts).
    expect(attributes.some((attr) => attr.name === "Requested catalog number")).toBe(false);
    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Matched catalog family",
        value: expect.stringMatching(/^5034L9/),
        sourceType: "generated",
        parser: "customer-family-pdf-inference",
        confidence: 0.58
      })
    ]));
    expect(attributes.some((attr) => attr.name === "Product Family")).toBe(false);
  });

  it("extracts clean per-column attributes from a tab-delimited catalog table in a customer PDF", () => {
    // pdf-parse preserves the original column tabs for real PDF tables (as opposed to
    // prose, which never contains embedded tabs). A manufacturer "quick start" manual's
    // catalog-number selection table — header row + one data row per catalog number —
    // should parse the same way a customer Excel/CSV sheet does, instead of falling
    // through to the noisy line-by-line prose extractor.
    const text = [
      "Product number \tRated power (kW) \tRated current (A)",
      "DV1-341D5NB-C20CX1 \t0.4 \t1.5",
      "DV1-343D0NB-C20CX1 \t0.75 \t3"
    ].join("\n");

    const attributes = extractCustomerPdfTableAttributes(
      "DV1-341D5NB-C20CX1",
      "DV1X1 Quick Start Manual EN.pdf",
      "file:///customer/DV1X1-manual.pdf",
      text
    );

    expect(attributes).toEqual([
      expect.objectContaining({ name: "Rated power (kW)", value: "0.4 kW" }),
      expect.objectContaining({ name: "Rated current (A)", value: "1.5 A" })
    ]);
    expect(normalizeFields(attributes, []).current).toBe("1.5 A");
  });

  it("extracts generic catalog-row descriptions and memory from PDF text", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "5034-L9010TNSXT",
      document: {
        type: "datasheet",
        label: "CompactLogix controller flyer",
        url: "file:///customer/compactlogix.pdf"
      },
      text: `
Catalogs planned for release
5034 -L9004TS CompactLogix 400KB Controller
5034 -L9010TNSXT CompactLogix 1MB XT NSE Controller
      `
    });

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Catalog Number", value: "5034-L9010TNSXT" }),
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Description", value: "CompactLogix 1MB XT NSE Controller" }),
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Memory", value: "1 MB" }),
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Variant", value: "XT, NSE" })
    ]));
  });

  it("extracts description facts from unseen catalog rows without manufacturer-specific rules", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ZX-CTRL-24",
      document: {
        type: "datasheet",
        label: "Generic controller selector",
        url: "https://example.test/generic-controller-selector.pdf"
      },
      text: `
Selector table
ZX - CTRL - 12 Modular controller 256KB Standard 12 V DC
ZX - CTRL - 24 Modular controller 512KB Safety CPU 24 V DC
ZX - CTRL - 48 Modular controller 1MB High power 48 V DC
      `
    });

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Catalog Number", value: "ZX-CTRL-24" }),
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Description", value: "Modular controller 512KB Safety CPU 24 V DC" }),
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Memory", value: "512 KB" }),
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Voltage rating", value: "24 V DC" }),
      expect.objectContaining({ group: "PDF Catalog Description Row", name: "Variant", value: "Safety" })
    ]));
  });

  it("keeps qualified PDF temperature labels from becoming bogus inline values", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ABC-123",
      document: {
        type: "datasheet",
        label: "Controller PDF",
        url: "https://example.test/controller.pdf"
      },
      text: `
Operating Temperature
-25 to +60 Degree C
Operating Temperature XT
-40 to +70 Degree C
      `
    });

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Operating Temperature", value: "-25 to +60 Degree C" }),
      expect.objectContaining({ name: "Operating temperature XT", value: "-40 to +70 Degree C" })
    ]));
    expect(attributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Operating temperature", value: "XT" }),
      expect.objectContaining({ name: "Feature", value: "Operating Temperature XT" })
    ]));
  });

  it("maps getTable() vector-grid rows to catalog attributes (pdf-parse's own table detection, not the whitespace heuristics)", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ZX-200",
      document: {
        type: "datasheet",
        label: "Ordering table PDF",
        url: "https://example.test/zx-relay.pdf"
      },
      text: "See ordering table for details.",
      tables: [
        [
          ["Catalog Number", "Description", "Weight [kg]", "Voltage"],
          ["ZX-100", "Modular relay", "0.5", "24 V DC"],
          ["ZX-200", "Modular relay XL", "0.8", "48 V DC"]
        ]
      ]
    });

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Table (Grid)", name: "Catalog Number", value: "ZX-200" }),
      expect.objectContaining({ group: "PDF Table (Grid)", name: "Description", value: "Modular relay XL" }),
      expect.objectContaining({ group: "PDF Table (Grid)", name: "Weight", value: "0.8 kg" }),
      expect.objectContaining({ group: "PDF Table (Grid)", name: "Voltage rating", value: "48 V DC" })
    ]));
    // The non-matching row (ZX-100) must not leak its own values onto the ZX-200 result.
    expect(attributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Table (Grid)", name: "Weight", value: "0.5 kg" })
    ]));
  });

  it("ignores getTable() tables with no recognizable header row", () => {
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "ZX-200",
      document: {
        type: "datasheet",
        label: "Unrelated PDF",
        url: "https://example.test/unrelated.pdf"
      },
      text: "No structured data here.",
      tables: [[["Feature", "Notes"], ["Snap-action contact", "IP20"]]]
    });

    expect(attributes.some((attr) => attr.group === "PDF Table (Grid)")).toBe(false);
  });

  it("does not inherit a sibling row's dimensions when that row's OWN description merely cross-references our catalog (text-based table)", () => {
    // Real bug (Rockwell 1606-td002 "Battery Modules for DC-UPS" table): 1606-XLSBAT1's own row
    // reads "...battery replacement for 1606-XLSBATASSY1, -XLSBATASSY1W, and -XLSBATASSY3" in its
    // OWN description column, before its OWN dimensions/catalog-number cells. A row-level text
    // match on the whole row (not just the catalog-number cell) let a query for the cross-
    // referenced sibling "1606-XLSBATASSY1" match THIS row and inherit 1606-XLSBAT1's dimensions.
    const text = [
      "Description \tDimensions \tCatalog Number",
      "12V, 7 Ah battery replacement for 1606-XLSBATASSY1, -XLSBATASSY1W, and -XLSBATASSY3 \t151 x 98 x 65 mm (5.94 x 3.85 x 2.56 in.) \t1606-XLSBAT1",
      "12V, 7 Ah battery module for 1606-XLS2408-UPS_ \t155 x 124 x 112 mm (6.10 x 4.88 x 4.41 in.) \t1606-XLSBATASSY1"
    ].join("\n");

    const attributes = extractDocumentTextAttributes({
      catalogNumber: "1606-XLSBATASSY1",
      document: { type: "datasheet", label: "1606-td002", url: "https://example.test/1606-td002.pdf" },
      text
    });

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Table Row", name: "Dimensions", value: "155 x 124 x 112 mm (6.10 x 4.88 x 4.41 in.)" })
    ]));
    expect(attributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Catalog Table Row", value: expect.stringContaining("151 x 98 x 65") })
    ]));
  });

  it("does not inherit a sibling row's dimensions when that row's OWN description merely cross-references our catalog (getTable() grid)", () => {
    // Same bug as above, in extractGetTableCatalogRows (the vector-grid twin of the text-based
    // table parser) — confirms both code paths were fixed, not just one.
    const attributes = extractDocumentTextAttributes({
      catalogNumber: "1606-XLSBATASSY1",
      document: { type: "datasheet", label: "1606-td002", url: "https://example.test/1606-td002.pdf" },
      text: "See table for details.",
      tables: [
        [
          ["Description", "Dimensions", "Catalog Number"],
          ["12V, 7 Ah battery replacement for 1606-XLSBATASSY1, -XLSBATASSY1W, and -XLSBATASSY3", "151 x 98 x 65 mm", "1606-XLSBAT1"],
          ["12V, 7 Ah battery module for 1606-XLS2408-UPS_", "155 x 124 x 112 mm", "1606-XLSBATASSY1"]
        ]
      ]
    });

    expect(attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Table (Grid)", name: "Dimensions", value: "155 x 124 x 112 mm" })
    ]));
    expect(attributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "PDF Table (Grid)", value: expect.stringContaining("151 x 98 x 65") })
    ]));
  });

  it("records PDF parse failures without adding them as product attributes", async () => {
    const result = await enrichResultFromDownloadedDocuments(product({
      documents: [
        {
          type: "datasheet",
          label: "Broken datasheet",
          url: "https://example.test/broken.pdf",
          localPath: "D:/does-not-exist/broken.pdf",
          downloadStatus: "downloaded"
        }
      ]
    }));

    expect(result.documents[0].parseStatus).toBe("failed");
    expect(result.diagnostics?.documentParseFailures?.[0]).toContain("Broken datasheet");
    expect(result.diagnostics?.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://example.test/broken.pdf",
        action: "failed",
        stage: "downloaded-document-enrichment",
        reason: "Downloaded PDF parse failed."
      })
    ]));
    expect(result.attributes).toEqual([]);
  });

  it("reads remote datasheet PDFs for missing values without retaining a local file path", async () => {
    const fixturePath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const result = await enrichResultFromRemoteDocuments(
      product({
        catalogNumber: "NO-MATCH",
        documents: [
          {
            type: "datasheet",
            label: "Thermostat controller spec sheet",
            url: "https://example.test/spec-00583.pdf",
            downloadStatus: "skipped",
            downloadError: "PDF downloads disabled for this run."
          }
        ]
      }),
      async () => ({ localPath: fixturePath })
    );

    expect(result.documents[0].parseStatus).toBe("parsed");
    expect(result.documents[0].localPath).toBeUndefined();
    expect(result.attributes.some((attr) => attr.name === "Supply Voltage" && /115V/.test(attr.value))).toBe(true);
    expect(result.normalized.protection).toBe("IP20");
    expect(result.sources.some((source) => source.stage === "probe-remote-documents")).toBe(true);
    expect(result.diagnostics?.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://example.test/spec-00583.pdf",
        action: "parsed",
        stage: "remote-document-enrichment"
      })
    ]));
  });

  it("lets a freshly recomputed normalized field override a stale, wrong pre-enrichment value", async () => {
    // Confirmed live on Rockwell's 1606-XLSBAT5: result.normalized was already populated (wrongly)
    // BEFORE document enrichment ran (the digital product passport's Height/Width/Length read like
    // packaging-box dimensions), and this merge used to spread that stale value LAST, letting it
    // unconditionally win over the freshly recomputed value even though normalizeFields — given the
    // FULL attribute union including the new document evidence — had already picked the better one.
    const fixturePath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const result = await enrichResultFromRemoteDocuments(
      product({
        catalogNumber: "NO-MATCH",
        normalized: { protection: "IP-STALE-WRONG-VALUE" },
        documents: [
          {
            type: "datasheet",
            label: "Thermostat controller spec sheet",
            url: "https://example.test/spec-00583.pdf",
            downloadStatus: "skipped",
            downloadError: "PDF downloads disabled for this run."
          }
        ]
      }),
      async () => ({ localPath: fixturePath })
    );

    expect(result.normalized.protection).toBe("IP20");
  });

  it("reads remote PDF-like query endpoints even when the URL has no .pdf suffix", async () => {
    const fixturePath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const result = await enrichResultFromRemoteDocuments(
      product({
        catalogNumber: "NO-MATCH",
        documents: [
          {
            type: "other",
            label: "Thermostat technical datasheet",
            url: "https://example.test/files?p_Doc_Ref=SPEC00583&p_enDocType=Data+Sheet",
            downloadStatus: "skipped",
            downloadError: "Skipped non-essential local download; URL retained in workbook."
          }
        ]
      }),
      async () => ({ localPath: fixturePath })
    );

    expect(result.documents[0].parseStatus).toBe("parsed");
    expect(result.attributes.some((attr) => attr.name === "Supply Voltage" && /115V/.test(attr.value))).toBe(true);
    expect(result.diagnostics?.fallbackStages).toContain("remote-document-enrichment");
  });

  it("reads remote PDF candidate URLs when the primary document link is only a product-page anchor", async () => {
    const fixturePath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const requestedUrls: string[] = [];
    const result = await enrichResultFromRemoteDocuments(
      product({
        catalogNumber: "NO-MATCH",
        documents: [
          {
            type: "datasheet",
            label: "Thermostat technical datasheet",
            url: "https://example.test/products/NO-MATCH#downloads",
            candidateUrls: ["https://example.test/downloads/spec-00583.pdf?download=1"]
          }
        ]
      }),
      async (document) => {
        requestedUrls.push(document.url);
        return { localPath: fixturePath, url: document.url };
      }
    );

    expect(requestedUrls).toEqual(["https://example.test/downloads/spec-00583.pdf?download=1"]);
    expect(result.documents[0].url).toBe("https://example.test/downloads/spec-00583.pdf?download=1");
    expect(result.sources.some((source) => source.url === "https://example.test/downloads/spec-00583.pdf?download=1")).toBe(true);
    expect(result.attributes.some((attr) => attr.sourceUrl === "https://example.test/downloads/spec-00583.pdf?download=1")).toBe(true);
  });

  it("parses downloaded PDF-like query documents even when the local file has no PDF suffix", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-downloaded-query-pdf-"));
    const fixturePath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const localPath = path.join(dir, "downloaded-query-document");
    await fs.copyFile(fixturePath, localPath);

    const result = await enrichResultFromDownloadedDocuments(product({
      catalogNumber: "NO-MATCH",
      documents: [
        {
          type: "other",
          label: "Thermostat technical datasheet",
          url: "https://example.test/files?p_Doc_Ref=SPEC00583&p_enDocType=Data+Sheet",
          localPath,
          downloadStatus: "downloaded"
        }
      ]
    }));

    expect(result.documents[0].parseStatus).toBe("parsed");
    expect(result.attributes.some((attr) => attr.name === "Supply Voltage" && /115V/.test(attr.value))).toBe(true);
    expect(result.diagnostics?.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://example.test/files?p_Doc_Ref=SPEC00583&p_enDocType=Data+Sheet",
        action: "parsed",
        stage: "downloaded-document-enrichment"
      })
    ]));
  });

  it("records remote document skip reasons when a candidate is not parseable", async () => {
    const result = await enrichResultFromRemoteDocuments(
      product({
        documents: [
          {
            type: "certificate",
            label: "EU declaration",
            url: "https://example.test/ABC-123-ce.pdf"
          }
        ]
      }),
      async () => {
        throw new Error("certificate should not be fetched for remote datasheet/manual enrichment");
      }
    );

    expect(result.diagnostics?.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://example.test/ABC-123-ce.pdf",
        action: "skipped",
        stage: "remote-document-enrichment",
        reason: "Skipped because document type 'certificate' is not a remote PDF enrichment candidate."
      })
    ]));
  });
});

function product(overrides: Partial<ProductResult>): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "ABC-123",
    status: "found",
    confidence: 0.9,
    productUrl: "https://example.test/products/ABC-123",
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    ...overrides
  };
}

async function writeMinimalDocx(filePath: string, bodyXml: string): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`);
  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}
