import { describe, expect, it } from "vitest";
import { discoverOfficialProductCandidates, scoreDiscoveryCandidate } from "../src/server/scrapers/discovery.js";
import { scrapeDiscoveredFallback } from "../src/server/scrapers/discovery-fallback.js";
import { GenericFallbackScraper } from "../src/server/scrapers/generic.js";
import { getConnector } from "../src/server/scrapers/index.js";
import { discoverProductLinksWithDiagnostics } from "../src/server/scrapers/link-discovery.js";
import type { DocumentRecord, FallbackSourceConfig, LearnedEndpointRecord, ManufacturerConfig } from "../src/shared/types.js";

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

  it("uses official nVent/Chemelex search instead of hardcoded RAYCHEM family slug maps", async () => {
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
    const searchedUrls: string[] = [];
    const discovery = await discoverOfficialProductCandidates("10BTV1-CR", {
      manufacturer: nvent,
      http: {
        fetchText: async (url: string) => {
          searchedUrls.push(url);
          if (url === "https://www.chemelex.com/search?q=10BTV1-CR") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <article>
                  <h2>10BTV1-CR self-regulating heating cable</h2>
                  <a href="/en-us/raychem/products/btv-self-regulating-heating-cable">BTV product family</a>
                </article>
              </main>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://www.chemelex.com/search?q=10BTV1-CR");
    expect(discovery.candidates.some((candidate) => candidate.url === "https://www.chemelex.com/en-us/raychem/products/btv-self-regulating-heating-cable")).toBe(true);
    expect((discovery.diagnostics.discoveredCandidates ?? []).some((candidate) => /hardcoded|prefix/i.test(candidate.reason))).toBe(false);
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

  it("records rejected discovered links outside allowed official domains", async () => {
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: {
        id: "generic",
        canonicalName: "Generic Manufacturer",
        shortName: "GEN",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test/products"],
        fallbackSources: [],
        scrapeRecipe: {
          discoveryPolicy: {
            allowedOfficialDomains: ["example.test"],
            searchUrlTemplates: ["https://example.test/search?q={part}"],
            maxCandidates: 5
          }
        }
      },
      http: {
        fetchText: async (url: string) => ({
          requestedUrl: url,
          effectiveUrl: url,
          statusCode: 200,
          contentType: "text/html",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          fromCache: false,
          text: `<main>
            <a href="https://example.test/products/ABC-123">ABC-123 official product</a>
            <a href="https://distributor.test/products/ABC-123">ABC-123 distributor mirror</a>
          </main>`
        })
      }
    } as never);

    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/products/ABC-123")).toBe(true);
    expect(discovered.diagnostics.rejectedLinks?.some((link) =>
      link.url === "https://distributor.test/products/ABC-123" &&
      /outside allowed official domains/i.test(link.reason)
    )).toBe(true);
  });

  it("derives generic search URLs from direct product URL templates when the standard URL is wrong", async () => {
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: {
        id: "generic",
        canonicalName: "Generic Manufacturer",
        shortName: "GEN",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test/products/{part}"],
        fallbackSources: []
      },
      http: {
        fetchText: async (url: string) => {
          searchedUrls.push(url);
          if (url === "https://example.test/search?q=ABC-123") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <article class="result">
                  <strong>ABC-123 replacement details</strong>
                  <a href="/catalog/detail.aspx?id=987">View official product</a>
                </article>
              </main>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test/search?q=ABC-123");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/catalog/detail.aspx?id=987")).toBe(true);
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

  it("discovers JSON detail URLs that are relative paths without a leading slash", () => {
    const discovery = discoverProductLinksWithDiagnostics(
      `<script>
        window.__SEARCH__ = {
          results: [
            { sku: "ZX-CTRL-24", title: "ZX-CTRL-24 compact controller", detailUrl: "catalog/detail.aspx?id=987" }
          ]
        };
      </script>`,
      "https://example.test/search?q=ZX-CTRL-24",
      "ZX-CTRL-24"
    );

    expect(discovery.candidates.some((candidate) => candidate.url === "https://example.test/catalog/detail.aspx?id=987")).toBe(true);
  });

  it("discovers source PDF documents when official search has no product detail page", async () => {
    const pdfOnlyManufacturer: ManufacturerConfig = {
      id: "docmaker",
      canonicalName: "Doc Maker",
      shortName: "DOC",
      rateLimitMs: 0,
      officialBaseUrls: ["https://docs.example.test"],
      fallbackSources: [],
      scrapeRecipe: {
        searchUrlTemplates: ["https://docs.example.test/search?q={part}"]
      }
    };
    const http = {
      fetchText: async (url: string) => {
        if (url === "https://docs.example.test/search?q=CDVRL00001") {
          return {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "text/html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: `<main>
              <article class="result">
                <h2>Rapid Link 5X catalog</h2>
                <p>Includes CDVRL00001, CDVRL00002 and CDVRL00003 motor starters.</p>
                <a href="/content/dam/rapid-link-5x-catalog.pdf">CDVRL00001 technical catalog PDF</a>
              </article>
            </main>`
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      }
    };

    const discovery = await discoverOfficialProductCandidates("CDVRL00001", {
      manufacturer: pdfOnlyManufacturer,
      http,
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: DocumentRecord) => doc,
      fallback: {
        scrape: async () => undefined
      }
    } as never);

    expect(discovery.candidates.some((candidate) => candidate.url.endsWith(".pdf"))).toBe(false);
    expect(discovery.documentCandidates).toContainEqual(
      expect.objectContaining({
        type: "datasheet",
        stage: "search-document",
        url: "https://docs.example.test/content/dam/rapid-link-5x-catalog.pdf"
      })
    );
  });

  it("returns source documents as a fallback result when discovery finds no product page", async () => {
    const pdfOnlyManufacturer: ManufacturerConfig = {
      id: "docmaker",
      canonicalName: "Doc Maker",
      shortName: "DOC",
      rateLimitMs: 0,
      officialBaseUrls: ["https://docs.example.test"],
      fallbackSources: [],
      scrapeRecipe: {
        searchUrlTemplates: ["https://docs.example.test/search?q={part}"]
      }
    };
    const http = {
      fetchText: async (url: string) => {
        if (url === "https://docs.example.test/search?q=CDVRL00001") {
          return {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "application/json",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: JSON.stringify({
              results: [
                {
                  title: "Rapid Link 5X source catalog",
                  description: "CDVRL00001 CDVRL00002 CDVRL00003 technical specifications",
                  documentUrl: "https://docs.example.test/content/dam/rapid-link-5x-catalog.pdf"
                }
              ]
            })
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      }
    };

    const { result } = await scrapeDiscoveredFallback("CDVRL00001", {
      manufacturer: pdfOnlyManufacturer,
      http,
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: DocumentRecord) => doc,
      fallback: {
        scrape: async () => undefined
      }
    } as never);

    expect(result?.status).toBe("partial");
    expect(result?.documents).toContainEqual(
      expect.objectContaining({
        type: "datasheet",
        stage: "search-document",
        url: "https://docs.example.test/content/dam/rapid-link-5x-catalog.pdf"
      })
    );
    expect(result?.diagnostics?.fallbackStages).toContain("official-document-discovery");
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

  it("discovers the manufacturer's own search form from a placeholder-only official URL template", async () => {
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: {
        id: "generic",
        canonicalName: "Generic Manufacturer",
        shortName: "GEN",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test/en-us/products/{part}"],
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
              text: `<form id="product-search" action="/en-us/search/results" method="get">
                <input type="hidden" name="tab" value="products" />
                <input type="search" name="keyword" aria-label="Product search" />
              </form>`
            };
          }
          if (url === "https://example.test/en-us/search/results?tab=products&keyword=ABC-123") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<a href="/en-us/catalog/detail.aspx?id=987">ABC-123 details</a>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test");
    expect(searchedUrls).toContain("https://example.test/en-us/search/results?tab=products&keyword=ABC-123");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/en-us/catalog/detail.aspx?id=987")).toBe(true);
  });

  it("uses POST search forms as GET probes when product pages use nonstandard detail URLs", async () => {
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("ZX-CTRL-24", {
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
              text: `<form id="find-product" action="/catalog/find/item" method="post">
                <input type="hidden" name="scope" value="products" />
                <input name="term" aria-label="Product search" />
              </form>`
            };
          }
          if (url === "https://example.test/catalog/find/item?scope=products&term=ZX-CTRL-24") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<section class="result">
                <strong>ZX-CTRL-24 compact controller</strong>
                <a href="/catalog/detail.aspx?item=987">Open product page</a>
              </section>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test/catalog/find/item?scope=products&term=ZX-CTRL-24");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/catalog/detail.aspx?item=987")).toBe(true);
  });

  it("uses product lookup forms whose inputs are named by catalog semantics instead of search text", async () => {
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("PN-77X", {
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
              text: `<form id="lookup" action="/lookup/product" method="post">
                <input type="hidden" name="locale" value="en" />
                <input name="partNumber" placeholder="Enter catalog number" />
              </form>`
            };
          }
          if (url === "https://example.test/lookup/product?locale=en&partNumber=PN-77X") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<article>
                <strong>PN-77X industrial relay</strong>
                <a href="/products/nonstandard/details?record=4455">View details</a>
              </article>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test/lookup/product?locale=en&partNumber=PN-77X");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/products/nonstandard/details?record=4455")).toBe(true);
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

  it("uses official discovery before generic scraping for manufacturers without a custom adapter", async () => {
    const requestedUrls: string[] = [];
    const genericManufacturer: ManufacturerConfig = {
      id: "newco",
      canonicalName: "NewCo",
      shortName: "NEW",
      rateLimitMs: 0,
      officialBaseUrls: ["https://newco.test/products/{part}", "https://newco.test/en-us"],
      fallbackSources: [],
      scrapeRecipe: {
        searchUrlTemplates: ["https://newco.test/en-us/search?keyword={part}"],
        discoveryPolicy: { maxCandidates: 12 }
      }
    };
    const http = {
      fetchText: async (url: string) => {
        requestedUrls.push(url);
        if (url === "https://newco.test/en-us/search?keyword=ABC-123") {
          return {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "text/html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: `<main>
              <article class="result" data-detail-url="/catalog/detail.aspx?id=987">
                <strong>ABC-123 compact controller</strong>
              </article>
            </main>`
          };
        }
        if (url === "https://newco.test/catalog/detail.aspx?id=987") {
          return {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "text/html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: `<html><body>
              <h1>ABC-123 compact controller</h1>
              <table>
                <tr><th>Catalog Number</th><td>ABC-123</td></tr>
                <tr><th>Size</th><td>120 x 80 x 55 mm</td></tr>
                <tr><th>Housing</th><td>polycarbonate</td></tr>
              </table>
              <a href="/documents/ABC-123-datasheet.pdf">ABC-123 technical datasheet</a>
            </body></html>`
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      }
    };
    const fallback = new GenericFallbackScraper(genericManufacturer.id, http as never, genericManufacturer);
    const result = await getConnector(genericManufacturer.id).scrape("ABC-123", {
      manufacturer: genericManufacturer,
      http,
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: DocumentRecord) => doc,
      fallback: {
        scrape: (catalogNumber: string, sources: FallbackSourceConfig[]) => fallback.scrape(catalogNumber, sources)
      }
    } as never);

    expect(result.status).toBe("partial");
    expect(result.productUrl).toBe("https://newco.test/catalog/detail.aspx?id=987");
    expect(result.normalized.dimensions).toBe("120 x 80 x 55 mm");
    expect(result.normalized.material).toBe("polycarbonate");
    expect(result.documents.some((doc) => doc.type === "datasheet")).toBe(true);
    expect(requestedUrls).toContain("https://newco.test/en-us/search?keyword=ABC-123");
    expect(result.diagnostics?.attemptedUrls).toContain("https://newco.test/en-us/search?keyword=ABC-123");
    expect(result.diagnostics?.discoveredCandidates?.some((candidate) => candidate.url === "https://newco.test/catalog/detail.aspx?id=987")).toBe(true);
  });
});
