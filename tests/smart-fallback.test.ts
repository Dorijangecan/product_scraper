import { describe, expect, it } from "vitest";
import { runSmartFallbackPipeline } from "../src/server/scrapers/smart-fallback.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import type { LearnedEndpointRecord, ManufacturerConfig, ProductResult } from "../src/shared/types.js";

describe("smart fallback", () => {
  it("prioritizes late product API network payloads over earlier browser noise", async () => {
    const learned: Array<Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">> = [];
    const manufacturer: ManufacturerConfig = {
      id: "networkco",
      canonicalName: "NetworkCo",
      shortName: "NET",
      rateLimitMs: 0,
      officialBaseUrls: ["https://networkco.test"],
      fallbackSources: [],
      scrapeRecipe: {
        fallbackPolicy: {
          readerOnQualityFailure: false,
          browserOnQualityFailure: true
        },
        qualityPolicy: {
          requiredNormalizedFields: ["material", "voltage", "current"]
        }
      }
    };
    const initial: ProductResult = {
      manufacturerId: "networkco",
      catalogNumber: "ABC-123",
      status: "partial",
      confidence: 0.55,
      productUrl: "https://networkco.test/products/ABC-123",
      normalized: {},
      attributes: [
        {
          group: "Identity",
          name: "Catalog Number",
          value: "ABC-123",
          sourceUrl: "https://networkco.test/products/ABC-123",
          sourceType: "official-fallback",
          parser: "fixture"
        }
      ],
      documents: [],
      sources: [
        {
          url: "https://networkco.test/products/ABC-123",
          sourceType: "official-fallback",
          parser: "fixture",
          fetchedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    };
    const noisyPayloads = Array.from({ length: 29 }, (_, index) =>
      fetchedJson(`https://networkco.test/api/noise/${index}`, {
        menu: ["home", "support", "downloads"],
        timestamp: index
      })
    );
    const productPayload = fetchedJson("https://networkco.test/api/products/ABC-123/specifications", {
      sku: "ABC-123",
      specifications: {
        ratedSupplyVoltage: "24 V DC",
        inputCurrent: "125 mA",
        housingMaterial: "Polycarbonate"
      },
      resources: [{ resourceName: "ABC-123 datasheet", pdfUrl: "/docs/ABC-123-datasheet.pdf", documentType: "Data Sheet" }]
    });

    const result = await runSmartFallbackPipeline(initial, "ABC-123", {
      manufacturer,
      http: {},
      browserRenderer: {
        renderProductPage: async () => ({
          fetched: html("https://networkco.test/products/ABC-123", "<h1>ABC-123</h1>"),
          networkTexts: [...noisyPayloads, productPayload],
          networkDiagnostics: [
            ...noisyPayloads.map((payload) => ({
              url: payload.effectiveUrl,
              statusCode: 200,
              contentType: "application/json",
              category: "other" as const
            })),
            {
              url: productPayload.effectiveUrl,
              statusCode: 200,
              contentType: "application/json",
              category: "product-api" as const
            }
          ]
        })
      },
      learnedEndpoints: {
        list: () => [],
        upsert: (endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">) => learned.push(endpoint)
      }
    } as never);

    expect(result.status).toBe("found");
    expect(result.normalized.voltage).toBe("24 V DC");
    expect(result.normalized.current).toBe("125 mA");
    expect(result.normalized.material).toBe("Polycarbonate");
    expect(result.documents.some((doc) => doc.type === "datasheet" && doc.url === "https://networkco.test/docs/ABC-123-datasheet.pdf")).toBe(true);
    expect(result.diagnostics?.notes).toContain("Ranked 30 browser network payloads and parsed top 24.");
    expect(learned.some((endpoint) => endpoint.urlTemplate === "https://networkco.test/api/products/{part}/specifications")).toBe(true);
  });
});

function fetchedJson(url: string, payload: unknown): FetchedText {
  return {
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType: "application/json",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    fromCache: false,
    text: JSON.stringify(payload)
  };
}

function html(url: string, body: string): FetchedText {
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
