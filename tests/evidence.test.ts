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
    expect(result.evidence?.some((record) => record.kind === "source" && record.stage === "direct-template")).toBe(true);
  });
});
