import { describe, expect, it } from "vitest";
import { summarizeRunItem } from "../src/server/run-item-summary.js";
import type { RunItemRecord } from "../src/shared/types.js";

describe("run item summaries", () => {
  it("strips heavy result payload while preserving coverage signals", () => {
    const summary = summarizeRunItem({
      id: 1,
      runId: "run-1",
      rowIndex: 1,
      catalogNumber: "ABC-123",
      status: "partial",
      updatedAt: "2026-05-24T00:00:00.000Z",
      result: {
        manufacturerId: "test",
        catalogNumber: "ABC-123",
        status: "partial",
        confidence: 0.6,
        productUrl: "https://example.test/products/ABC-123",
        normalized: { weight: "1 kg", dimensions: "10 x 20 x 30 mm", material: "steel" },
        attributes: [{ name: "Material", value: "steel" }],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/ABC-123.png", downloadStatus: "failed" }],
        sources: [{ url: "https://example.test/products/ABC-123", sourceType: "official", parser: "fixture", fetchedAt: "2026-05-24T00:00:00.000Z" }],
        qualityGate: {
          passed: false,
          identityConfirmed: true,
          score: 65,
          missing: ["document:datasheet"],
          reason: "Missing datasheet.",
          attempts: []
        }
      }
    } satisfies RunItemRecord);

    expect(summary.result).toBeUndefined();
    expect(summary.coverage?.fields.image).toBe("missing");
    expect(summary.coverage?.fields.weight).toBe("present");
    expect(summary.coverage?.criticalMissing).toContain("image");
    expect(summary.coverage?.reason).toContain("Images");
  });
});
