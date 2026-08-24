import { describe, expect, it } from "vitest";
import { evidenceConfidence, evidenceTier } from "../src/server/scrapers/evidence-score.js";

describe("evidence confidence", () => {
  it("orders official parsed documents above fallback and distributor evidence", () => {
    const officialPdf = evidenceConfidence({ sourceType: "official", parser: "pdf-parser", confidence: 0.8 });
    const fallback = evidenceConfidence({ sourceType: "official-fallback", confidence: 0.9 });
    const distributor = evidenceConfidence({ sourceType: "distributor", confidence: 1 });
    expect(officialPdf).toBeGreaterThan(fallback);
    expect(fallback).toBeGreaterThan(distributor);
  });

  it("uses explicit confidence as a bounded refinement, never an override of source trust", () => {
    expect(evidenceConfidence({ sourceType: "official", confidence: 0.4 })).toBeGreaterThan(
      evidenceConfidence({ sourceType: "distributor", confidence: 1 })
    );
  });

  it("names the provenance tier before applying connector-local confidence", () => {
    expect(evidenceTier({ sourceType: "official", parser: "pdf-table-extractor" })).toBe("official-document");
    expect(evidenceTier({ sourceType: "official", parser: "generic" })).toBe("official-page");
    expect(evidenceTier({ sourceType: "distributor" })).toBe("distributor");
  });
});
