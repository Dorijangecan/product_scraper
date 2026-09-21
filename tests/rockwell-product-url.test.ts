import { describe, expect, it } from "vitest";
import { finalizeRockwellResult } from "../src/server/scrapers/rockwell.js";
import type { ProductResult } from "../src/shared/types.js";

function result(overrides: Partial<ProductResult> = {}): ProductResult {
  return {
    manufacturerId: "rockwell",
    catalogNumber: "2198-DSM016-ERS2-A0751E-CJ12AS",
    status: "partial",
    confidence: 0.7,
    productUrl: "https://www.rockwellautomation.com/en-us/products/details.2198-DSM016-ERS2-A0751E-CJ12AS.html",
    title: "ArmorKinetix Distributed Drive 16A ERS2",
    normalized: {},
    attributes: [{ group: "Technical Data", name: "Rated current", value: "16 A" }],
    documents: [],
    sources: [{
      url: "https://www.rockwellautomation.com/en-us/products/details.2198-DSM016-ERS2-A0751E-CJ12AS.html",
      sourceType: "official-fallback",
      parser: "rockwell-discovered",
      stage: "discovery-search-result",
      fetchedAt: "2026-09-21T00:00:00.000Z"
    }],
    ...overrides
  };
}

describe("Rockwell product URL identity gate", () => {
  it("does not publish a synthetic details URL without exact product identity evidence", () => {
    const finalized = finalizeRockwellResult(result());
    expect(finalized.productUrl).toBeUndefined();
    expect(finalized.localizedUrls).toBeUndefined();
  });

  it("keeps a real product-page URL when the trusted parser proved the page", () => {
    const finalized = finalizeRockwellResult(result({
      title: "ArmorKinetix DSM 2198-DSM016-ERS2-A0751E-CJ12AS",
      sources: [{
        url: "https://www.rockwellautomation.com/en-us/products/details.2198-DSM016-ERS2-A0751E-CJ12AS.html",
        sourceType: "official",
        parser: "rockwell-product-page",
        stage: "rockwell-product-page",
        fetchedAt: "2026-09-21T00:00:00.000Z"
      }]
    }));
    expect(finalized.productUrl).toContain("details.2198-DSM016-ERS2-A0751E-CJ12AS.html");
  });
});
