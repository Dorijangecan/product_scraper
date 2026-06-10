import { describe, expect, it } from "vitest";
import type { ManufacturerConfig, ProductResult } from "../src/shared/types.js";
import { matchesExpectedOfficialUrl } from "../scripts/benchmark-utils.js";

const manufacturer = {
  id: "test",
  canonicalName: "Test",
  shortName: "TST",
  rateLimitMs: 0,
  officialBaseUrls: ["https://manufacturer.example"],
  fallbackSources: []
} as unknown as ManufacturerConfig;

function result(overrides: Partial<ProductResult>): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "CAT-1",
    status: "found",
    confidence: 0.9,
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    ...overrides
  };
}

describe("benchmark utilities", () => {
  it("matches expected URL patterns against customer-document evidence URLs", () => {
    const r = result({
      productUrl: undefined,
      sources: [
        {
          url: "file:///D:/KATALOZI/SKRIPTE/product_scraper/benchmarks/customer-documents/rare-device-sheets.csv",
          sourceType: "official",
          parser: "customer-document",
          fetchedAt: "1970-01-01T00:00:00.000Z"
        }
      ]
    });

    expect(matchesExpectedOfficialUrl(r, manufacturer, { expectedOfficialUrlPatterns: ["file:.*/rare-device-sheets\\.csv"] })).toBe(true);
  });

  it("still accepts manufacturer official base URLs from the product URL", () => {
    const r = result({ productUrl: "https://www.manufacturer.example/products/CAT-1" });

    expect(matchesExpectedOfficialUrl(r, manufacturer, {})).toBe(true);
  });
});
