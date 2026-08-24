import { describe, expect, it } from "vitest";
import { auditResultEvidence } from "../src/server/scrapers/evidence-audit.js";
import type { ProductResult } from "../src/shared/types.js";

function resultWith(overrides: Partial<ProductResult> = {}): ProductResult {
  return {
    manufacturerId: "abb",
    catalogNumber: "TEST-1",
    status: "partial",
    confidence: 0.7,
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    ...overrides
  };
}

describe("evidence confidence audit", () => {
  it("assigns each connector attribute the shared tier, including provenance inherited from its source", () => {
    const audit = auditResultEvidence(resultWith({
      attributes: [
        { name: "Rated current", value: "6 A", sourceUrl: "https://example.test/product", confidence: 0.98 }
      ],
      documents: [
        {
          type: "datasheet",
          label: "Exact product datasheet",
          url: "https://example.test/datasheet.pdf",
          sourceUrl: "https://example.test/datasheet.pdf",
          sourceType: "official",
          parser: "pdf-table-extractor",
          confidence: 0.75
        }
      ],
      sources: [
        { url: "https://example.test/product", sourceType: "official", parser: "abb-api", fetchedAt: new Date(0).toISOString() }
      ]
    }));

    expect(audit.issues).toEqual([]);
    expect(audit.records.map((record) => record.tier)).toEqual([
      "official-page",
      "official-document",
      "official-page"
    ]);
    expect(audit.provenance.inferred).toBe(1);
    expect(audit.provenance.direct).toBe(2);
  });

  it("reports a connector fact with an unresolved source URL or invalid raw confidence", () => {
    const audit = auditResultEvidence(resultWith({
      attributes: [
        { name: "Rated current", value: "6 A", sourceUrl: "https://missing.test/product", confidence: 1.2 }
      ]
    }));

    expect(audit.issues.map((issue) => issue.kind)).toEqual([
      "unresolved-source-url",
      "raw-confidence-out-of-range"
    ]);
    expect(audit.records[0]).toMatchObject({ tier: "generated", score: expect.any(Number) });
  });

  it("uses a document's own URL when an older result preserved a different referrer as sourceUrl", () => {
    const audit = auditResultEvidence(resultWith({
      documents: [
        {
          type: "datasheet",
          label: "Exact product datasheet",
          url: "https://vendor.test/files/ABC-123.pdf",
          // Historical results sometimes retained the product-view referrer here even though the
          // downloaded document itself is the source record that proves provenance.
          sourceUrl: "https://vendor.test/product-view/ABC-123"
        }
      ],
      sources: [
        {
          url: "https://vendor.test/files/ABC-123.pdf",
          sourceType: "official",
          parser: "vendor-datasheet",
          fetchedAt: new Date(0).toISOString()
        }
      ]
    }));

    expect(audit.issues).toEqual([]);
    expect(audit.records[0]).toMatchObject({
      kind: "document",
      sourceType: "official",
      provenance: "inferred",
      tier: "official-document"
    });
  });
});
