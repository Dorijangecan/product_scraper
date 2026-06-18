import { describe, expect, it } from "vitest";
import { runDeterministicScrapePipeline } from "../src/server/scrapers/deterministic-pipeline.js";
import type { ManufacturerConfig, ProductResult } from "../src/shared/types.js";

describe("deterministic scrape pipeline", () => {
  it("repairs a passed result whose product URL is still an official search page", async () => {
    const fetchedUrls: string[] = [];
    const manufacturer: ManufacturerConfig = {
      id: "generic",
      canonicalName: "Generic Manufacturer",
      shortName: "GEN",
      rateLimitMs: 100,
      officialBaseUrls: ["https://example.test/products"],
      fallbackSources: []
    };
    const initial: ProductResult = {
      manufacturerId: "generic",
      catalogNumber: "ABC-123",
      status: "partial",
      confidence: 0.82,
      productUrl: "https://example.test/search?q=ABC-123",
      title: "ABC-123 mounting plate",
      normalized: {},
      attributes: [
        {
          group: "Product",
          name: "Catalog Number",
          value: "ABC-123",
          sourceUrl: "https://example.test/search?q=ABC-123",
          sourceType: "official-fallback",
          parser: "generic"
        }
      ],
      documents: [],
      sources: [
        {
          url: "https://example.test/search?q=ABC-123",
          sourceType: "official-fallback",
          parser: "generic",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          statusCode: 200
        }
      ]
    };

    const repaired = await runDeterministicScrapePipeline(initial, "ABC-123", {
      manufacturer,
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === "https://example.test/search?q=ABC-123") {
            return html(url, `<a href="/catalog/detail.aspx?ugly=true&id=ABC-123">ABC-123 details</a>`);
          }
          if (url === "https://example.test/catalog/detail.aspx?ugly=true&id=ABC-123") {
            return html(url, `
              <h1>ABC-123 mounting plate</h1>
              <div><span class="spec-label">Catalog Number</span>ABC-123</div>
              <div><span class="spec-label">Material</span>steel</div>
            `);
          }
          throw new Error(`not found: ${url}`);
        }
      }
    } as never);

    expect(fetchedUrls).toContain("https://example.test/search?q=ABC-123");
    expect(repaired.productUrl).toBe("https://example.test/catalog/detail.aspx?ugly=true&id=ABC-123");
    expect(repaired.qualityGate?.passed).toBe(true);
  });
});

function html(url: string, body: string) {
  return {
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType: "text/html",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    fromCache: false,
    text: `<html><body>${body}</body></html>`
  };
}
