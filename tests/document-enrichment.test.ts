import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProductResult } from "../src/shared/types.js";
import { enrichResultFromDownloadedDocuments, enrichResultFromRemoteDocuments, extractDocumentTextAttributes } from "../src/server/scrapers/document-enrichment.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";
import { normalizeTechnicalAttributes } from "../src/server/scrapers/technical-attributes.js";
import { applyCustomerDocumentOverride, extractCustomerDocumentAttributes } from "../src/server/scrapers/customer-documents.js";
import { classifyDeviceType } from "../src/server/scrapers/device-type.js";

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
    expect(normalized.dimensions).toContain("DN 15");
    expect(normalized.weight).toBe("4.5 kg");
    expect(normalized.material).toBe("Valve body Spheroidal cast iron GJS-400-15");
    expect(normalized.certificates).toContain("CE");
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
