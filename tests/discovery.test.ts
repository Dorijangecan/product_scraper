import { describe, expect, it } from "vitest";
import { discoverOfficialProductCandidates, scoreDiscoveryCandidate } from "../src/server/scrapers/discovery.js";
import { discoverProductLinksWithDiagnostics } from "../src/server/scrapers/link-discovery.js";
import type { LearnedEndpointRecord, ManufacturerConfig } from "../src/shared/types.js";

const manufacturer: ManufacturerConfig = {
  id: "test",
  canonicalName: "Test",
  shortName: "TST",
  rateLimitMs: 100,
  officialBaseUrls: ["https://example.test/products"],
  fallbackSources: []
};

describe("official discovery scoring", () => {
  it("scores exact official product candidates above search and document URLs", () => {
    const product = scoreDiscoveryCandidate("https://example.test/products/ABC-123", "ABC-123", "direct-template", manufacturer);
    const search = scoreDiscoveryCandidate("https://example.test/search?q=ABC-123", "ABC-123", "url-variant", manufacturer);
    const pdf = scoreDiscoveryCandidate("https://example.test/products/ABC-123.pdf", "ABC-123", "sitemap", manufacturer);

    expect(product).toBeGreaterThan(search);
    expect(product).toBeGreaterThan(pdf);
  });

  it("rewards compact catalog matches in path segments", () => {
    const score = scoreDiscoveryCandidate("https://example.test/products/BPZ-VSG519K15-5", "BPZ:VSG519K15-5", "sitemap", manufacturer);

    expect(score).toBeGreaterThanOrEqual(80);
  });

  it("adds nVent RAYCHEM family pages for catalog numbers embedded inside Chemelex tables", async () => {
    const nvent: ManufacturerConfig = {
      id: "nvent",
      canonicalName: "nVent",
      shortName: "NVE",
      rateLimitMs: 100,
      officialBaseUrls: ["https://www.nvent.com", "https://www.chemelex.com"],
      fallbackSources: [],
      scrapeRecipe: {
        discoveryPolicy: {
          allowedOfficialDomains: ["nvent.com", "chemelex.com"],
          maxCandidates: 20
        }
      }
    };
    const cases = [
      ["10BTV1-CR", "https://www.chemelex.com/en-us/raychem/products/btv-self-regulating-heating-cable"],
      ["3XLE1-CR", "https://www.chemelex.com/en-us/raychem/products/xl-trace-edge-self-regulating-heating-cable"],
      ["GM-1X", "https://www.chemelex.com/en-us/raychem/products/icestop-self-regulating-heating-cable"],
      ["RayClic-S", "https://www.chemelex.com/en-us/raychem/products/rayclic-connection-kit"],
      ["Elexant 3500i-GF-P-A", "https://www.chemelex.com/en-us/raychem/products/elexant-3500i-electronic-thermostat"],
      ["NGC-40-IO", "https://www.chemelex.com/en-us/raychem/products/ngc-40-series-io-module"]
    ];

    for (const [catalogNumber, expectedUrl] of cases) {
      const discovery = await discoverOfficialProductCandidates(catalogNumber, {
        manufacturer: nvent,
        http: {
          fetchText: async () => {
            throw new Error("search should not be needed for family heuristic");
          }
        }
      } as never);

      expect(discovery.candidates.some((candidate) => candidate.url === expectedUrl)).toBe(true);
    }
  });

  it("probes generic official site-search URLs when no configured search template exists", async () => {
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: {
        id: "generic",
        canonicalName: "Generic Manufacturer",
        shortName: "GEN",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test/products/{part}", "https://example.test/en-us/products"],
        fallbackSources: [],
        scrapeRecipe: {
          discoveryPolicy: {
            maxCandidates: 1
          }
        }
      },
      http: {
        fetchText: async (url: string) => {
          searchedUrls.push(url);
          if (url === "https://example.test/en-us/search?keyword=ABC-123") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <article class="result">
                  <a href="/en-us/catalog/detail.aspx?ugly=true&id=ABC-123">ABC-123 product details</a>
                </article>
              </main>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test/en-us/search?keyword=ABC-123");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/en-us/catalog/detail.aspx?ugly=true&id=ABC-123")).toBe(true);
  });

  it("discovers ugly product links hidden in data attributes on search results", () => {
    const discovery = discoverProductLinksWithDiagnostics(
      `<article class="result" data-detail-url="/catalog/detail.aspx?ugly=true&id=ABC-123">
        <button title="View details">ABC-123 compact controller</button>
      </article>`,
      "https://example.test/search?q=ABC-123",
      "ABC-123"
    );

    expect(discovery.candidates.some((candidate) => candidate.url === "https://example.test/catalog/detail.aspx?ugly=true&id=ABC-123")).toBe(true);
  });

  it("uses surrounding inline context when the detail URL itself has no catalog number", () => {
    const discovery = discoverProductLinksWithDiagnostics(
      `<script>
        window.searchResults = [
          { sku: "ABC-123", title: "ABC-123 compact controller", detailUrl: "/catalog/detail.aspx?id=987" }
        ];
      </script>`,
      "https://example.test/search?q=ABC-123",
      "ABC-123"
    );

    expect(discovery.candidates.some((candidate) => candidate.url === "https://example.test/catalog/detail.aspx?id=987")).toBe(true);
  });

  it("discovers and uses the manufacturer's own search form", async () => {
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: {
        id: "generic",
        canonicalName: "Generic Manufacturer",
        shortName: "GEN",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test/catalog"],
        fallbackSources: []
      },
      http: {
        fetchText: async (url: string) => {
          searchedUrls.push(url);
          if (url === "https://example.test" || url === "https://example.test/") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<form id="site-search" action="/catalogsearch/result/" method="get">
                <input type="hidden" name="cat" value="all" />
                <input type="search" name="searchTerm" placeholder="Search products" />
              </form>`
            };
          }
          if (url === "https://example.test/catalogsearch/result/?cat=all&searchTerm=ABC-123") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<a href="/catalog/detail.aspx?id=987">ABC-123 details</a>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test/catalogsearch/result/?cat=all&searchTerm=ABC-123");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/catalog/detail.aspx?id=987")).toBe(true);
  });

  it("renders search pages with the browser when static search results are empty", async () => {
    const stored: Array<Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">> = [];
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: {
        id: "generic",
        canonicalName: "Generic Manufacturer",
        shortName: "GEN",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test/products"],
        fallbackSources: []
      },
      http: {
        fetchText: async (url: string) => ({
          requestedUrl: url,
          effectiveUrl: url,
          statusCode: 200,
          contentType: "text/html",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          fromCache: false,
          text: "<main>No server-rendered search results</main>"
        })
      },
      browserRenderer: {
        isUnavailable: () => false,
        renderProductPage: async (url: string) => ({
          fetched: {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "text/html; rendered=playwright",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: `<main>
              <article class="result">
                <a href="/products/detail.aspx?id=987">ABC-123 rendered product details</a>
              </article>
            </main>`
          },
          networkTexts: [
            {
              requestedUrl: "https://example.test/api/search?query=ABC-123",
              effectiveUrl: "https://example.test/api/search?query=ABC-123",
              statusCode: 200,
              contentType: "application/json",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: JSON.stringify({
                results: [{ sku: "ABC-123", url: "/products/detail.aspx?id=987", title: "ABC-123 rendered product details" }]
              })
            }
          ],
          networkDiagnostics: []
        })
      },
      learnedEndpoints: {
        list: () => [],
        upsert: (endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">) => stored.push(endpoint)
      }
    } as never);

    expect(discovered.diagnostics.attemptedUrls?.some((url) => url.startsWith("browser:https://example.test/search?q=ABC-123"))).toBe(true);
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/products/detail.aspx?id=987")).toBe(true);
    expect(stored.some((endpoint) => endpoint.urlTemplate === "https://example.test/api/search?query={part}")).toBe(true);
  });
});
