import { describe, expect, it } from "vitest";
import { endpointTemplateFromUrl, learnEndpointFromNetworkFetch, learnedEndpointUrls } from "../src/server/scrapers/learned-endpoints.js";
import type { LearnedEndpointRecord, ManufacturerConfig } from "../src/shared/types.js";

const manufacturer: ManufacturerConfig = {
  id: "test",
  canonicalName: "Test",
  shortName: "TST",
  rateLimitMs: 100,
  officialBaseUrls: ["https://example.test/products"],
  fallbackSources: []
};

describe("learned endpoints", () => {
  it("templates catalog-number API URLs", () => {
    expect(endpointTemplateFromUrl("https://example.test/api/product?sku=ABC-123", "ABC-123")).toBe(
      "https://example.test/api/product?sku={part}"
    );
  });

  it("keeps placeholders readable when templating product page paths", () => {
    expect(endpointTemplateFromUrl("https://example.test/products/ABC-123/details", "ABC-123")).toBe(
      "https://example.test/products/{part}/details"
    );
  });

  it("promotes only official catalog-confirmed network responses", () => {
    const stored: Array<Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">> = [];
    const learned = learnEndpointFromNetworkFetch({
      manufacturer,
      catalogNumber: "ABC-123",
      discoveredFromUrl: "https://example.test/products/ABC-123",
      parserKind: "browser-network",
      fetched: {
        requestedUrl: "https://example.test/api/product?sku=ABC-123",
        effectiveUrl: "https://example.test/api/product?sku=ABC-123",
        statusCode: 200,
        contentType: "application/json",
        text: JSON.stringify({ sku: "ABC-123", material: "Steel", description: "Catalog confirmed test endpoint" }),
        fetchedAt: "2026-05-20T00:00:00.000Z",
        fromCache: false
      },
      store: {
        list: () => [],
        upsert: (endpoint) => stored.push(endpoint)
      }
    });

    expect(learned).toBe(true);
    expect(stored[0].urlTemplate).toContain("{part}");
  });

  it("replays learned endpoints through catalog templates", () => {
    const urls = learnedEndpointUrls(
      manufacturer,
      "ABC-123",
      {
        list: () => [
          {
            manufacturerId: "test",
            host: "example.test",
            method: "GET",
            urlTemplate: "https://example.test/api/product?sku={part}",
            discoveredFromUrl: "https://example.test/products/ABC-123",
            parserKind: "browser-network",
            successCount: 3,
            lastSuccessAt: "2026-05-20T00:00:00.000Z"
          }
        ],
        upsert: () => undefined
      }
    );

    expect(urls[0].url).toBe("https://example.test/api/product?sku=ABC-123");
  });
});
