import { describe, expect, it } from "vitest";
import { attachEvidence } from "../src/server/scrapers/evidence.js";
import type { ProductResult } from "../src/shared/types.js";

describe("evidence model", () => {
  it("builds evidence records from attributes, documents, normalized fields, and sources", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.91,
      normalized: { weight: "1.2 kg" },
      attributes: [{ group: "Specs", name: "Weight", value: "1.2 kg", sourceUrl: "https://example.test/products/ABC-123" }],
      documents: [{ type: "datasheet", label: "Datasheet", url: "https://example.test/ABC-123.pdf", sourceUrl: "https://example.test/products/ABC-123" }],
      sources: [
        {
          url: "https://example.test/products/ABC-123",
          sourceType: "official-fallback",
          parser: "discovery-direct-template",
          stage: "direct-template",
          fetchedAt: "2026-05-20T00:00:00.000Z",
          statusCode: 200
        }
      ]
    } satisfies ProductResult);

    expect(result.evidence?.some((record) => record.kind === "attribute" && record.name === "Weight")).toBe(true);
    expect(result.evidence?.some((record) => record.kind === "document" && record.url?.endsWith("ABC-123.pdf"))).toBe(true);
    expect(result.evidence?.some((record) => record.kind === "normalized" && record.name === "weight")).toBe(true);
    expect(result.technicalAttributes?.some((record) => record.canonicalKey === "weight" && record.originalName === "Weight")).toBe(true);
    expect(result.evidence?.some((record) => record.kind === "technical-attribute" && record.name === "weight")).toBe(true);
    expect(result.evidence?.some((record) => record.kind === "source" && record.stage === "direct-template")).toBe(true);
    expect(result.diagnostics?.fieldHealth?.some((record) => record.field === "weight" && record.status === "found")).toBe(true);
  });

  it("reports datasheet, manual and certificate URLs as central field-health schema fields", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.91,
      normalized: {},
      attributes: [],
      documents: [
        { type: "datasheet", label: "Technical datasheet", url: "https://example.test/ABC-123-ds.pdf", sourceType: "official-fallback", confidence: 0.82 },
        { type: "datasheet", label: "Specification sheet", url: "https://example.test/ABC-123-spec.pdf", sourceType: "official-fallback", confidence: 0.8 },
        { type: "manual", label: "Installation manual", url: "https://example.test/ABC-123-manual.pdf", sourceType: "official-fallback", confidence: 0.81 },
        { type: "certificate", label: "EU Declaration of Conformity", url: "https://example.test/ABC-123-ce.pdf", sourceType: "official-fallback", confidence: 0.77 }
      ],
      sources: []
    } satisfies ProductResult);

    const datasheet = result.diagnostics?.fieldHealth?.find((record) => record.field === "datasheetUrl");
    const manual = result.diagnostics?.fieldHealth?.find((record) => record.field === "manualUrl");
    const certificate = result.diagnostics?.fieldHealth?.find((record) => record.field === "certificateUrl");

    expect(datasheet?.status).toBe("found");
    expect(datasheet?.value).toBe("https://example.test/ABC-123-ds.pdf");
    expect(datasheet?.sourceUrls).toEqual(expect.arrayContaining(["https://example.test/ABC-123-ds.pdf", "https://example.test/ABC-123-spec.pdf"]));
    expect(datasheet?.conflicts).toBeUndefined();
    expect(manual?.status).toBe("found");
    expect(certificate?.status).toBe("found");
  });

  it("selects the highest-priority document URL for document field health", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.91,
      normalized: {},
      attributes: [],
      documents: [
        {
          type: "datasheet",
          label: "Distributor datasheet",
          url: "https://distributor.test/ABC-123.pdf",
          sourceType: "distributor",
          parser: "fallback-distributor",
          confidence: 0.45
        },
        {
          type: "datasheet",
          label: "Customer supplied datasheet",
          url: "file:///customer/ABC-123.pdf",
          localPath: "C:/runs/customer/ABC-123.pdf",
          sourceType: "official",
          parser: "customer-document",
          stage: "customer-override",
          confidence: 0.97
        }
      ],
      sources: []
    } satisfies ProductResult);

    const datasheet = result.diagnostics?.fieldHealth?.find((record) => record.field === "datasheetUrl");
    expect(datasheet?.status).toBe("found");
    expect(datasheet?.value).toBe("file:///customer/ABC-123.pdf");
    expect(datasheet?.value).not.toBe("C:/runs/customer/ABC-123.pdf");
    expect(datasheet?.sourceUrls).toEqual(expect.arrayContaining([
      "https://distributor.test/ABC-123.pdf",
      "file:///customer/ABC-123.pdf"
    ]));
    expect(datasheet?.reason).toContain("customer-provided document priority");
  });

  it("uses the central field registry aliases when attaching normalized source evidence", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.89,
      normalized: { finish: "powder coated" },
      attributes: [
        {
          group: "Mechanical data",
          name: "Surface treatment",
          value: "Polyester powder coating, RAL 7035",
          sourceUrl: "https://example.test/products/ABC-123",
          sourceType: "official",
          confidence: 0.86
        }
      ],
      documents: [],
      sources: [
        {
          url: "https://example.test/products/ABC-123",
          sourceType: "official",
          parser: "generic",
          stage: "product-page",
          fetchedAt: "2026-05-20T00:00:00.000Z"
        }
      ]
    } satisfies ProductResult);

    const normalizedFinish = result.evidence?.find((record) => record.kind === "normalized" && record.name === "finish");
    const finishHealth = result.diagnostics?.fieldHealth?.find((record) => record.field === "finish");
    expect(normalizedFinish?.sourceUrl).toBe("https://example.test/products/ABC-123");
    expect(normalizedFinish?.sourceType).toBe("official");
    expect(finishHealth?.status).toBe("conflicting");
    expect(finishHealth?.sourceUrls).toContain("https://example.test/products/ABC-123");
  });

  it("keeps parser, stage and confidence from the source attribute on normalized evidence", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.7,
      normalized: { voltage: "24 V DC" },
      attributes: [
        {
          group: "Customer PDF",
          name: "Power input",
          value: "24 V DC",
          sourceUrl: "file:///customer/spec.pdf",
          sourceType: "official",
          parser: "customer-document",
          stage: "customer-override",
          confidence: 0.97
        }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    const normalizedVoltage = result.evidence?.find((record) => record.kind === "normalized" && record.name === "voltage");
    expect(normalizedVoltage).toMatchObject({
      value: "24 V DC",
      sourceUrl: "file:///customer/spec.pdf",
      sourceType: "official",
      parser: "customer-document",
      stage: "customer-override",
      confidence: 0.97
    });
  });

  it("uses the attribute group when finding normalized source evidence", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.7,
      normalized: { voltage: "24 V DC" },
      attributes: [
        {
          group: "Marketing",
          name: "Feature",
          value: "24 V DC compatible",
          sourceUrl: "https://example.test/product-page",
          sourceType: "official",
          parser: "generic",
          stage: "product-page",
          confidence: 0.62
        },
        {
          group: "Input voltage",
          name: "Range",
          value: "24 V DC",
          sourceUrl: "https://example.test/spec.pdf",
          sourceType: "official",
          parser: "pdf-table-extractor",
          stage: "downloaded-document-enrichment",
          confidence: 0.83
        }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    const normalizedVoltage = result.evidence?.find((record) => record.kind === "normalized" && record.name === "voltage");
    const voltageHealth = result.diagnostics?.fieldHealth?.find((record) => record.field === "voltage");
    expect(normalizedVoltage).toMatchObject({
      sourceUrl: "https://example.test/spec.pdf",
      parser: "pdf-table-extractor",
      stage: "downloaded-document-enrichment",
      confidence: 0.83
    });
    expect(voltageHealth?.sourceUrls).toContain("https://example.test/spec.pdf");
  });

  it("prefers field-labelled attributes over unrelated exact value matches", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.7,
      normalized: { voltage: "24 V DC" },
      attributes: [
        {
          group: "Marketing",
          name: "Feature",
          value: "24 V DC",
          sourceUrl: "https://example.test/feature",
          sourceType: "official",
          parser: "generic",
          stage: "product-page",
          confidence: 0.61
        },
        {
          group: "Electrical data",
          name: "Supply voltage",
          value: "24 V DC",
          sourceUrl: "https://example.test/electrical.pdf",
          sourceType: "official",
          parser: "pdf-table-extractor",
          stage: "downloaded-document-enrichment",
          confidence: 0.88
        }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    const normalizedVoltage = result.evidence?.find((record) => record.kind === "normalized" && record.name === "voltage");
    const voltageHealth = result.diagnostics?.fieldHealth?.find((record) => record.field === "voltage");
    expect(normalizedVoltage?.sourceUrl).toBe("https://example.test/electrical.pdf");
    expect(normalizedVoltage?.confidence).toBe(0.88);
    expect(voltageHealth?.sourceUrls).toContain("https://example.test/electrical.pdf");
    expect(voltageHealth?.sourceUrls).not.toContain("https://example.test/feature");
  });

  it("keeps source metadata on field health when normalized evidence falls back to an exact value match", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "partial",
      confidence: 0.42,
      normalized: { voltage: "24 V DC" },
      attributes: [
        {
          group: "OCR output",
          name: "Extracted line",
          value: "24 V DC",
          sourceUrl: "https://example.test/scanned-datasheet.pdf",
          sourceType: "official",
          parser: "pdf-ocr",
          stage: "downloaded-document-enrichment",
          confidence: 0.91
        }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    const voltageHealth = result.diagnostics?.fieldHealth?.find((record) => record.field === "voltage");
    expect(voltageHealth?.status).toBe("found");
    expect(voltageHealth?.confidence).toBe(0.91);
    expect(voltageHealth?.sourceUrls).toContain("https://example.test/scanned-datasheet.pdf");
  });

  it("uses group and name together when only the combined label identifies the field", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.7,
      normalized: { voltage: "24 V DC" },
      attributes: [
        {
          group: "Power",
          name: "Input",
          value: "24 V DC",
          sourceUrl: "https://example.test/electrical.pdf",
          sourceType: "official",
          parser: "pdf-table-extractor",
          stage: "downloaded-document-enrichment",
          confidence: 0.88
        }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    const normalizedVoltage = result.evidence?.find((record) => record.kind === "normalized" && record.name === "voltage");
    const voltageHealth = result.diagnostics?.fieldHealth?.find((record) => record.field === "voltage");
    expect(normalizedVoltage?.sourceUrl).toBe("https://example.test/electrical.pdf");
    expect(normalizedVoltage?.confidence).toBe(0.88);
    expect(voltageHealth?.sourceUrls).toContain("https://example.test/electrical.pdf");
  });

  it("reports conflicting source-backed field values for human review", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.91,
      normalized: { material: "steel" },
      attributes: [
        { group: "Web specs", name: "Material", value: "steel", sourceUrl: "https://example.test/products/ABC-123", sourceType: "official", confidence: 0.92 },
        { group: "PDF datasheet", name: "Material", value: "polycarbonate", sourceUrl: "https://example.test/ABC-123.pdf", sourceType: "generated", confidence: 0.78 }
      ],
      documents: [],
      sources: [
        {
          url: "https://example.test/products/ABC-123",
          sourceType: "official",
          parser: "generic",
          fetchedAt: "2026-05-20T00:00:00.000Z"
        },
        {
          url: "https://example.test/ABC-123.pdf",
          sourceType: "generated",
          parser: "pdf-table-extractor",
          fetchedAt: "2026-05-20T00:00:00.000Z"
        }
      ]
    } satisfies ProductResult);

    const material = result.diagnostics?.fieldHealth?.find((record) => record.field === "material");
    expect(material?.status).toBe("conflicting");
    expect(material?.conflicts?.map((entry) => entry.value)).toEqual(expect.arrayContaining(["steel", "polycarbonate"]));
    expect(material?.conflicts?.every((entry) => typeof entry.priority === "number" && entry.priorityReason)).toBe(true);
    expect(material?.resolution).toContain("Confidence");
  });

  it("marks the selected customer-document value while retaining conflicting web values", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.97,
      normalized: { material: "polycarbonate" },
      attributes: [
        {
          group: "Customer PDF",
          name: "Material",
          value: "polycarbonate",
          sourceUrl: "file:///customer/spec.pdf",
          sourceType: "official",
          parser: "customer-document",
          stage: "customer-override",
          confidence: 0.97
        },
        {
          group: "Web specs",
          name: "Material",
          value: "steel",
          sourceUrl: "https://example.test/products/ABC-123",
          sourceType: "official",
          parser: "generic",
          stage: "product-page",
          confidence: 0.9
        }
      ],
      documents: [],
      sources: [
        {
          url: "file:///customer/spec.pdf",
          sourceType: "official",
          parser: "customer-document",
          stage: "customer-override",
          fetchedAt: "2026-05-20T00:00:00.000Z"
        },
        {
          url: "https://example.test/products/ABC-123",
          sourceType: "official",
          parser: "generic",
          stage: "product-page",
          fetchedAt: "2026-05-20T00:00:00.000Z"
        }
      ]
    } satisfies ProductResult);

    const material = result.diagnostics?.fieldHealth?.find((record) => record.field === "material");
    const selected = material?.conflicts?.find((entry) => entry.selected);
    expect(material?.status).toBe("conflicting");
    expect(selected?.value).toBe("polycarbonate");
    expect(selected?.parsers).toContain("customer-document");
    expect(selected?.priorityReason).toBe("customer-provided document priority");
    expect(material?.conflicts?.some((entry) => entry.value === "steel" && entry.sourceUrls.includes("https://example.test/products/ABC-123"))).toBe(true);
    expect(material?.resolution).toContain("customer document");
    expect(material?.resolution).toContain("customer-provided document priority");
  });

  it("surfaces source priority when official and distributor values conflict", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "found",
      confidence: 0.88,
      normalized: { voltage: "24 V DC" },
      attributes: [
        {
          group: "Official Specs",
          name: "Supply voltage",
          value: "24 V DC",
          sourceUrl: "https://example.test/products/ABC-123",
          sourceType: "official",
          parser: "generic",
          stage: "product-page",
          confidence: 0.88
        },
        {
          group: "Distributor Specs",
          name: "Voltage",
          value: "120 V AC",
          sourceUrl: "https://distributor.test/ABC-123",
          sourceType: "distributor",
          parser: "fallback-distributor",
          stage: "distributor-fallback",
          confidence: 0.45
        }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    const voltage = result.diagnostics?.fieldHealth?.find((record) => record.field === "voltage");
    const selected = voltage?.conflicts?.find((entry) => entry.selected);
    const distributor = voltage?.conflicts?.find((entry) => entry.value === "120 V AC");
    expect(voltage?.status).toBe("conflicting");
    expect(selected?.value).toBe("24 V DC");
    expect(selected?.priorityReason).toBe("official product source priority");
    expect((selected?.priority ?? 0) > (distributor?.priority ?? 0)).toBe(true);
    expect(voltage?.resolution).toContain("official source");
  });

  it("selects the highest-priority conflict value when no normalized value exists", () => {
    const result = attachEvidence({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "partial",
      confidence: 0.7,
      normalized: {},
      attributes: [
        {
          group: "Distributor Specs",
          name: "Material",
          value: "plastic",
          sourceUrl: "https://distributor.test/ABC-123",
          sourceType: "distributor",
          parser: "fallback-distributor",
          confidence: 0.45
        },
        {
          group: "Official PDF datasheet",
          name: "Material",
          value: "polycarbonate",
          sourceUrl: "https://example.test/ABC-123-datasheet.pdf",
          sourceType: "official",
          parser: "pdf-datasheet",
          confidence: 0.88
        }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    const material = result.diagnostics?.fieldHealth?.find((record) => record.field === "material");
    const selected = material?.conflicts?.find((entry) => entry.selected);
    expect(material?.status).toBe("conflicting");
    expect(material?.value).toBe("polycarbonate");
    expect(selected?.value).toBe("polycarbonate");
    expect(selected?.priorityReason).toBe("official parsed document priority");
    expect(material?.resolution).toContain("Preferred value");
    expect(material?.resolution).toContain("all conflicting source values are retained");
  });
});
