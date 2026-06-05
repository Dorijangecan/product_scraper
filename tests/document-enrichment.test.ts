import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProductResult } from "../src/shared/types.js";
import { enrichResultFromDownloadedDocuments, extractDocumentTextAttributes } from "../src/server/scrapers/document-enrichment.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";
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
