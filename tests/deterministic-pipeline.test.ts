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

  it("recovers a failed custom-adapter result through generic official search discovery", async () => {
    const fetchedUrls: string[] = [];
    const manufacturer: ManufacturerConfig = {
      id: "customco",
      canonicalName: "CustomCo",
      shortName: "CUS",
      rateLimitMs: 100,
      officialBaseUrls: ["https://customco.test"],
      fallbackSources: [],
      scrapeRecipe: {
        searchUrlTemplates: ["https://customco.test/search?keyword={part}"],
        discoveryPolicy: { maxCandidates: 8 }
      }
    };
    const initial: ProductResult = {
      manufacturerId: "customco",
      catalogNumber: "ABC-123",
      status: "failed",
      confidence: 0,
      normalized: {},
      attributes: [],
      documents: [],
      sources: [],
      error: "Custom adapter did not find the product."
    };

    const repaired = await runDeterministicScrapePipeline(initial, "ABC-123", {
      manufacturer,
      http: {
        fetchText: async (url: string) => {
          fetchedUrls.push(url);
          if (url === "https://customco.test/search?keyword=ABC-123") {
            return html(url, `<article class="result" data-detail-url="/catalog/detail?id=987">
              <strong>ABC-123 compact controller</strong>
            </article>`);
          }
          if (url === "https://customco.test/catalog/detail?id=987") {
            return html(url, `
              <h1>ABC-123 compact controller</h1>
              <table>
                <tr><th>Catalog Number</th><td>ABC-123</td></tr>
                <tr><th>Material</th><td>polycarbonate</td></tr>
                <tr><th>Size</th><td>120 x 80 x 55 mm</td></tr>
                <tr><th>IP rating</th><td>IP66</td></tr>
                <tr><th>Rated voltage</th><td>24 V DC</td></tr>
                <tr><th>Rated current</th><td>2 A</td></tr>
              </table>
              <a href="/docs/ABC-123-datasheet.pdf">ABC-123 datasheet</a>
            `);
          }
          throw new Error(`not found: ${url}`);
        }
      }
    } as never);

    expect(fetchedUrls).toContain("https://customco.test/search?keyword=ABC-123");
    expect(repaired.status).toBe("found");
    expect(repaired.productUrl).toBe("https://customco.test/catalog/detail?id=987");
    expect(repaired.normalized.material).toBe("polycarbonate");
    expect(repaired.normalized.dimensions).toBe("120 x 80 x 55 mm");
    expect(repaired.normalized.voltage).toBe("24 V DC");
    expect(repaired.normalized.current).toBe("2 A");
    expect(repaired.documents.some((doc) => doc.type === "datasheet")).toBe(true);
    expect(repaired.diagnostics?.fallbackStages).toContain("discovery");
    expect(repaired.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === "https://customco.test/catalog/detail?id=987")).toBe(true);
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
