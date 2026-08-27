import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { discoverOfficialProductCandidates, learnedEndpointRecencyPenalty, scoreDiscoveryCandidate, scoreFetchedDiscoveryEvidence } from "../src/server/scrapers/discovery.js";
import { scrapeDiscoveredFallback } from "../src/server/scrapers/discovery-fallback.js";
import { GenericFallbackScraper } from "../src/server/scrapers/generic.js";
import { getConnector } from "../src/server/scrapers/index.js";
import { discoverProductLinksWithDiagnostics } from "../src/server/scrapers/link-discovery.js";
import { findTurckProductUrl } from "../src/server/scrapers/turck.js";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import type { DocumentRecord, FallbackSourceConfig, LearnedEndpointRecord, ManufacturerConfig, ProductResult } from "../src/shared/types.js";

const manufacturer: ManufacturerConfig = {
  id: "test",
  canonicalName: "Test",
  shortName: "TST",
  rateLimitMs: 100,
  officialBaseUrls: ["https://example.test/products"],
  fallbackSources: []
};

describe("official discovery scoring", () => {
  it("shares one discovery result across separate stages of the same catalog item", async () => {
    const discoveryMemo = new Map();
    let fetchCount = 0;
    const memoManufacturer: ManufacturerConfig = {
      id: "memo-vendor",
      canonicalName: "Memo Vendor",
      shortName: "MEM",
      rateLimitMs: 100,
      officialBaseUrls: ["https://memo.test"],
      fallbackSources: [],
      scrapeRecipe: { discoveryPolicy: { maxCandidates: 2, enableRobotsSitemaps: false } }
    };
    const http = {
      fetchText: async (url: string) => {
        fetchCount += 1;
        return {
          requestedUrl: url,
          effectiveUrl: url,
          statusCode: 200,
          contentType: "text/html",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          fromCache: false,
          text: '<a href="/products/MEM-42">MEM-42 product</a>'
        };
      }
    };
    const first = await discoverOfficialProductCandidates("MEM-42", { manufacturer: memoManufacturer, http, discoveryMemo } as never);
    const afterFirstStage = fetchCount;
    const second = await discoverOfficialProductCandidates("MEM-42", { manufacturer: memoManufacturer, http, discoveryMemo } as never);

    expect(afterFirstStage).toBeGreaterThan(0);
    expect(fetchCount).toBe(afterFirstStage);
    expect(second).toBe(first);
  });

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

  it("requires catalog evidence from the fetched page, not merely a product-shaped candidate URL", async () => {
    // Recorded Balluff PDP fixture: its own title and Product JSON-LD name/sku confirm BIC007H.
    const productHtml = await fs.readFile(new URL("../fixtures/balluff-BIC007H-page/page.html", import.meta.url), "utf8");
    const product = scoreFetchedDiscoveryEvidence(
      { effectiveUrl: "https://www.balluff.com/en-us/products/BIC007H", statusCode: 200, contentType: "text/html", text: productHtml } as never,
      "BIC007H"
    );
    const search = scoreFetchedDiscoveryEvidence(
      {
        effectiveUrl: "https://www.balluff.com/en-us/search?q=BIC007H",
        statusCode: 200,
        contentType: "text/html",
        text: "<html><title>Search results for BIC007H</title><body>Products matching BIC007H</body></html>"
      } as never,
      "BIC007H"
    );

    expect(product.catalogConfirmed).toBe(true);
    expect(product.score).toBeGreaterThan(search.score);
    expect(search.catalogConfirmed).toBe(false);
  });

  it("never turns closing HTML tags into catalog-confirmed inline product URLs", async () => {
    // Recorded Ganter PDP: broad inline context contains the target catalog near many `</a>` and
    // `</div>` tags. Before the guard those became bogus /a and /div search-result candidates.
    const html = await fs.readFile(new URL("../fixtures/gan-GN-3310-19-LK-K2-page/page.html", import.meta.url), "utf8");
    const discovered = discoverProductLinksWithDiagnostics(html, "https://www.ganternorm.com/en/home", "GN 3310-19-LK-K2");

    expect(discovered.candidates.some((candidate) => /\/(?:a|div|span|article|button|label|h2)$/i.test(candidate.url))).toBe(false);
  });

  it("does not promote a PDP footer service link from nearby hidden variant text", async () => {
    // The recorded Ganter PDP places all selectable SKU variants in a hidden span immediately
    // after its "special requests" footer link. Raw HTML URL scanning used that broad nearby text
    // as identity evidence and ranked the generic service page above the real product page.
    const html = await fs.readFile(new URL("../fixtures/gan-GN-3310-19-LK-K2-page/page.html", import.meta.url), "utf8");
    const discovered = discoverProductLinksWithDiagnostics(html, "https://www.ganternorm.com/en/home", "GN 3310-19-LK-K2");

    expect(discovered.candidates.some((candidate) => candidate.url === "https://www.ganternorm.com/en/productpages/special-requests")).toBe(false);
  });

  it("accepts a catalog-confirmed official product JSON response for learned API replay", () => {
    const evidence = scoreFetchedDiscoveryEvidence(
      {
        effectiveUrl: "https://example.test/api/products?sku=ABC-123",
        statusCode: 200,
        contentType: "application/json",
        text: JSON.stringify({ sku: "ABC-123", name: "ABC-123 compact controller", material: "Steel", specifications: { weight: "1 kg" } })
      } as never,
      "ABC-123"
    );

    expect(evidence.catalogConfirmed).toBe(true);
    expect(evidence.reasons).toContain("catalog in Product JSON response");
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

  it("keeps an exact official PDP URL when a catalog search redirects there without HTML result links", async () => {
    const catalogNumber = "6SAME4J316B.4000";
    const searchUrl = `https://example.test/en/search?search=${catalogNumber}`;
    const productUrl = `https://example.test/en/Main-Power-Cable-GST18i3-for-Module-F-Line/${catalogNumber}`;
    const discovered = await discoverOfficialProductCandidates(catalogNumber, {
      manufacturer: {
        id: "redirect-search",
        canonicalName: "Redirect Search",
        shortName: "RDS",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test"],
        localizedUrlTemplates: [{ locale: "en", urlTemplate: "https://example.test/en/search?search={part}" }],
        fallbackSources: [],
        scrapeRecipe: { discoveryPolicy: { maxCandidates: 12 } }
      },
      http: {
        fetchText: async (url: string) => {
          if (url !== searchUrl) throw new Error("unexpected discovery request");
          return {
            requestedUrl: url,
            effectiveUrl: productUrl,
            statusCode: 200,
            contentType: "text/html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: "<main>Redirected product response without result anchors</main>"
          };
        }
      }
    } as never);

    expect(discovered.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: productUrl,
        stage: "search-result",
        reason: expect.stringMatching(/redirected/i)
      })
    ]));
    expect(discovered.candidates.some((candidate) => candidate.url === searchUrl)).toBe(false);
  });

  it("keeps a slug-only official redirect when the returned PDP itself proves the exact SKU", async () => {
    const catalogNumber = "ABC-123";
    const searchUrl = `https://example.test/en/search?search=${catalogNumber}`;
    const productUrl = "https://example.test/en/products/compact-controller";
    const discovered = await discoverOfficialProductCandidates(catalogNumber, {
      manufacturer: {
        id: "slug-redirect",
        canonicalName: "Slug Redirect",
        shortName: "SLG",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test"],
        localizedUrlTemplates: [{ locale: "en", urlTemplate: "https://example.test/en/search?search={part}" }],
        fallbackSources: [],
        scrapeRecipe: { discoveryPolicy: { maxCandidates: 12 } }
      },
      http: {
        fetchText: async (url: string) => {
          if (url !== searchUrl) throw new Error("unexpected discovery request");
          return {
            requestedUrl: url,
            effectiveUrl: productUrl,
            statusCode: 200,
            contentType: "text/html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: '<script type="application/ld+json">{"@type":"Product","sku":"ABC-123","name":"Compact controller"}</script>'
          };
        }
      }
    } as never);

    expect(discovered.candidates).toContainEqual(expect.objectContaining({ url: productUrl, stage: "search-result" }));
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

  it("uses the configured localized homepage as a discovery base when official product URLs are bare", async () => {
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: {
        id: "localized-home",
        canonicalName: "Localized Home",
        shortName: "LHM",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test"],
        homepageUrl: "https://example.test/en-us/",
        fallbackSources: []
      },
      http: {
        fetchText: async (url: string) => {
          searchedUrls.push(url);
          if (url === "https://example.test/en-us/search?q=ABC-123") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<a href="/en-us/products/nonstandard?id=987">ABC-123 details</a>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test/en-us/search?q=ABC-123");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/en-us/products/nonstandard?id=987")).toBe(true);
  });

  it("follows an official homepage hreflang alternate to discover its localized search form", async () => {
    const searchedUrls: string[] = [];
    const postBodies: string[] = [];
    const discovered = await discoverOfficialProductCandidates("ALT-42", {
      manufacturer: {
        id: "hreflang-home",
        canonicalName: "Hreflang Home",
        shortName: "HLH",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test"],
        homepageUrl: "https://example.test/en/",
        fallbackSources: []
      },
      http: {
        fetchText: async (url: string, options?: { method?: string; body?: URLSearchParams | string }) => {
          searchedUrls.push(url);
          if (url === "https://example.test/en/" || url === "https://example.test/en") {
            return {
              requestedUrl: url,
              effectiveUrl: "https://example.test/en/",
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<link rel="alternate" hreflang="de" href="/de/">`
            };
          }
          if (url === "https://example.test/de/" || url === "https://example.test/de") {
            return {
              requestedUrl: url,
              effectiveUrl: "https://example.test/de/",
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<form action="/de/catalog-search" method="post">
                <input type="hidden" name="locale" value="de" />
                <input name="article" aria-label="Product search" />
              </form>`
            };
          }
          if (url === "https://example.test/de/catalog-search" && options?.method === "POST") {
            postBodies.push(String(options.body));
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<a href="/de/products/nonstandard?id=42">ALT-42 product</a>`
            };
          }
          throw new Error("empty search page");
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test/de/");
    expect(postBodies).toContain("locale=de&article=ALT-42");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/de/products/nonstandard?id=42")).toBe(true);
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

  it("follows a BreadcrumbList leaf to the canonical product page (Phase B3)", () => {
    const discovery = discoverProductLinksWithDiagnostics(
      `<script type="application/ld+json">
        {"@type":"BreadcrumbList","itemListElement":[
          {"@type":"ListItem","position":1,"name":"Home","item":"https://example.test/"},
          {"@type":"ListItem","position":2,"name":"Controllers","item":"https://example.test/controllers"},
          {"@type":"ListItem","position":3,"name":"ABC-123 compact controller","item":"https://example.test/products/ABC-123"}
        ]}
      </script>`,
      "https://example.test/controllers",
      "ABC-123"
    );
    expect(discovery.candidates.some((candidate) => candidate.url === "https://example.test/products/ABC-123")).toBe(true);
  });

  it("uses hreflang alternates as localized product-page candidates (Phase B3)", () => {
    const discovery = discoverProductLinksWithDiagnostics(
      `<h1>ABC-123 compact controller</h1>
       <link rel="alternate" hreflang="de-de" href="https://example.test/de/produkte/ABC-123">`,
      "https://example.test/en/products/ABC-123",
      "ABC-123"
    );
    expect(discovery.candidates.some((candidate) => candidate.url === "https://example.test/de/produkte/ABC-123")).toBe(true);
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

  it("submits POST search forms with their successful controls when product pages use nonstandard detail URLs", async () => {
    const searchedUrls: string[] = [];
    const postBodies: string[] = [];
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
        fetchText: async (url: string, options?: { method?: string; body?: URLSearchParams | string }) => {
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
          if (url === "https://example.test/catalog/find/item" && options?.method === "POST") {
            postBodies.push(String(options.body));
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

    expect(searchedUrls).toContain("https://example.test/catalog/find/item");
    expect(postBodies).toContain("scope=products&term=ZX-CTRL-24");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/catalog/detail.aspx?item=987")).toBe(true);
  });

  it("uses product lookup forms whose inputs are named by catalog semantics instead of search text", async () => {
    const searchedUrls: string[] = [];
    const postBodies: string[] = [];
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
        fetchText: async (url: string, options?: { method?: string; body?: URLSearchParams | string }) => {
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
          if (url === "https://example.test/lookup/product" && options?.method === "POST") {
            postBodies.push(String(options.body));
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

    expect(searchedUrls).toContain("https://example.test/lookup/product");
    expect(postBodies).toContain("locale=en&partNumber=PN-77X");
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

  it("discovers Turck shop product URLs from catalog-name search results", async () => {
    const turck = getManufacturerConfig("turck")!;
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("NI12U-EG18SK-VP4X", {
      manufacturer: turck,
      http: {
        fetchText: async (url: string) => {
          searchedUrls.push(url);
          if (url === "https://www.turck.com/de/en/shop/search?q=NI12U-EG18SK-VP4X") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <article data-testid="product-list-item">
                  <a href="/de/en/shop/sensors/inductive-sensors/1581801">
                    <h3>NI12U-EG18SK-VP4X</h3>
                    <span>Order ID no. 1581801</span>
                    <span>Inductive Sensor</span>
                  </a>
                </article>
              </main>`
            };
          }
          return {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "text/html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: "<main>No matching Turck products</main>"
          };
        }
      }
    } as never);

    expect(turck.shortName).toBe("TUR");
    expect(searchedUrls).toContain("https://www.turck.com/de/en/shop/search?q=NI12U-EG18SK-VP4X");
    expect(discovered.candidates.some((candidate) =>
      candidate.url === "https://www.turck.com/de/en/shop/sensors/inductive-sensors/1581801" &&
      candidate.stage === "search-result"
    )).toBe(true);
  });

  it("scrapes Turck catalog names through the dedicated shop connector", async () => {
    const turck = getManufacturerConfig("turck")!;
    const requestedUrls: string[] = [];
    const result = await getConnector("turck").scrape("NI12U-EG18SK-VP4X", {
      manufacturer: turck,
      http: {
        fetchText: async (url: string) => {
          requestedUrls.push(url);
          if (url === "https://www.turck.com/de/en/shop/search?q=NI12U-EG18SK-VP4X") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<main>
                <article>
                  <a href="/de/en/shop/sensors/inductive-sensors/1581801">
                    <h3>NI12U-EG18SK-VP4X</h3>
                    <span>Order ID no. 1581801</span>
                  </a>
                </article>
              </main>`
            };
          }
          if (url === "https://www.turck.com/de/en/shop/sensors/inductive-sensors/1581801") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<html><head>
                <title>NI12U-EG18SK-VP4X | TURCK - Your Global Automation Partner</title>
                <meta property="og:title" content="NI12U-EG18SK-VP4X | TURCK - Your Global Automation Partner" />
                <meta property="og:image" content="https://hansturck.azureedge.net/highres/79852_v0_highres.png" />
                <meta name="keywords" content="Inductive Sensor, " />
              </head><body>
                <h1>NI12U-EG18SK-VP4X</h1>
                <p>Inductive Sensor NI12U-EG18SK-VP4X Order ID no. 1581801</p>
                <table>
                  <tr><th>Housing material</th><td>Stainless steel</td></tr>
                  <tr><th>Protection class</th><td>IP68</td></tr>
                </table>
                <a href="https://hansturck.azureedge.net/edb/en_US_HQ/EDB_1581801_gbr_en.pdf">Datasheet</a>
              </body></html>`
            };
          }
          if (url === "https://certificates.digital.aws.turck.com/documents/1581801") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<table>
                <thead><tr><th>Type</th><th>Certificate #</th><th>Filename</th></tr></thead>
                <tbody>
                  <tr><td>CE/UKCA Decl. of Conformity</td><td>5447M</td><td>5447-3M.pdf</td></tr>
                  <tr><td>CCC Certification Scheme China</td><td>2024010305706455</td><td>ccc.pdf</td></tr>
                </tbody>
              </table>`
            };
          }
          if (url === "https://www.turck.pl/pl/product/1581801") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<html><body>
                <h3>Dane ogolne</h3>
                <table>
                  <tr><td>EAN</td><td>4047101126112</td></tr>
                  <tr><td>Kod eCl@ss (V5.1.4):</td><td>27270101 -/- Czujnik indukcyjny</td></tr>
                  <tr><td>Numer taryfy celnej</td><td>85365080000</td></tr>
                  <tr><td>Kraj pochodzenia</td><td>DE</td></tr>
                  <tr><td>Waga</td><td>70 g</td></tr>
                </table>
                <h3>Dane techniczne</h3>
                <table>
                  <tr><td>Wymiary konstrukcji</td><td>M18 x 1</td></tr>
                  <tr><td>Napiecie zasilania</td><td>10&#8230;65 V DC</td></tr>
                  <tr><td>Temperatura pracy</td><td>-30&#8230;+85 &deg;C</td></tr>
                  <tr><td>Stopien ochrony</td><td>IP68</td></tr>
                </table>
              </body></html>`
            };
          }
          if (url === "https://www.turck.com/de/de/shop/p/1581801") {
            // The German order-id short link redirects to the real, natively-localized URL —
            // translated category slugs included — unlike a naive /en/ -> /de/ substitution.
            return {
              requestedUrl: url,
              effectiveUrl: "https://www.turck.com/de/de/shop/sensortechnik/induktive-sensoren/1581801",
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<html><body><p>Order ID no. 1581801</p></body></html>`
            };
          }
          throw new Error(`Unexpected URL ${url}`);
        }
      },
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: DocumentRecord) => doc,
      fallback: {
        scrape: async () => undefined
      }
    } as never);

    expect(requestedUrls).toEqual([
      "https://www.turck.com/de/en/shop/search?q=NI12U-EG18SK-VP4X",
      "https://www.turck.com/de/en/shop/sensors/inductive-sensors/1581801",
      "https://certificates.digital.aws.turck.com/documents/1581801",
      "https://www.turck.pl/pl/product/1581801",
      "https://www.turck.com/de/de/shop/p/1581801"
    ]);
    expect(result.productUrl).toBe("https://www.turck.com/de/en/shop/sensors/inductive-sensors/1581801");
    expect(result.title).toBe("NI12U-EG18SK-VP4X");
    // The shop <title> is just the SKU; the descriptive family is promoted to the description so the
    // PDT description columns carry "Inductive Sensor" instead of the article number.
    expect(result.description).toBe("Inductive Sensor");
    // The German URL comes from actually resolving the order-id short link, not from rewriting the
    // English URL — the real German category slugs differ from the English ones.
    expect(result.localizedUrls?.en).toBe("https://www.turck.com/de/en/shop/sensors/inductive-sensors/1581801");
    expect(result.localizedUrls?.de).toBe("https://www.turck.com/de/de/shop/sensortechnik/induktive-sensoren/1581801");
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Type Code", value: "NI12U-EG18SK-VP4X" }));
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Order ID", value: "1581801" }));
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "EAN", value: "4047101126112" }));
    // The legacy page's eCl@ss v5.1.4 code is retained for reference but named so it never starts
    // with "ECLASS" — it must never be mistaken by the PDT eclass resolver for a current, usable
    // classification (that code no longer exists in the ECLASS versions the sheets are filled against).
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Legacy eCl@ss (v5.1.4, superseded)", value: "27270101" }));
    expect(result.attributes.some((attribute) => /^eclass\b/i.test(attribute.name))).toBe(false);
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Customs Tariff Number", value: "85365080000" }));
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Country of Origin", value: "DE" }));
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Weight", value: "70 g" }));
    expect(result.documents.some((doc) => doc.type === "image")).toBe(true);
    expect(result.normalized.weight).toBe("70 g (0.07 kg)");
    expect(result.normalized.voltage).toBe("10...65 V DC");
    expect(result.normalized.material).toBe("Stainless steel");
    // Certificates are read from the document-management table and canonicalised.
    expect(result.normalized.certificates).toBe("CE, UKCA, CCC");
  });

  it("rejects a Turck search result whose numeric order id is merely a prefix of the catalog number's page", async () => {
    // "15758" is a numeric prefix of the unrelated order id "1575807" — a page that mentions
    // "15758" nearby (breadcrumbs, related-products widgets) must never be picked over requiring
    // the candidate URL's own order id to match exactly.
    const url = findTurckProductUrl(
      `<main>
        <article>
          <a href="/de/en/shop/others/1575807">
            <h3>BI25-G47SR-VN4X2-H1141</h3>
            <span>Order ID no. 1575807</span>
            <span>Related to 15758 series</span>
          </a>
        </article>
      </main>`,
      "https://www.turck.com/de/en/shop/search?q=15758",
      "15758"
    );

    expect(url).toBeUndefined();
  });

  it("does not assume a fixed Turck product category path", async () => {
    const turck = getManufacturerConfig("turck")!;
    const result = await getConnector("turck").scrape("TBEN-L4-8DIP-8DOP", {
      manufacturer: turck,
      http: {
        fetchText: async (url: string) => {
          if (url === "https://www.turck.com/de/en/shop/search?q=TBEN-L4-8DIP-8DOP") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<article>
                <a href="/de/en/shop/automation-technology/i-o-systems/1000001">
                  <h3>TBEN-L4-8DIP-8DOP</h3>
                  <span>Order ID no. 1000001</span>
                </a>
              </article>`
            };
          }
          if (url === "https://www.turck.com/de/en/shop/automation-technology/i-o-systems/1000001") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<html><head>
                <title>TBEN-L4-8DIP-8DOP | TURCK - Your Global Automation Partner</title>
                <meta property="og:image" content="https://hansturck.azureedge.net/highres/1000001_v0_highres.png" />
                <meta name="keywords" content="I/O module, " />
              </head><body>
                <h1>TBEN-L4-8DIP-8DOP</h1>
                <p>I/O module TBEN-L4-8DIP-8DOP Order ID no. 1000001</p>
                <table>
                  <tr><th>Operating voltage</th><td>24 V DC</td></tr>
                  <tr><th>Protection class</th><td>IP67</td></tr>
                </table>
              </body></html>`
            };
          }
          throw new Error(`Unexpected URL ${url}`);
        }
      },
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: DocumentRecord) => doc,
      fallback: {
        scrape: async () => undefined
      }
    } as never);

    expect(result.productUrl).toBe("https://www.turck.com/de/en/shop/automation-technology/i-o-systems/1000001");
    expect(result.title).toBe("TBEN-L4-8DIP-8DOP");
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Product Type", value: "I/O module" }));
    expect(result.normalized.voltage).toBe("24 V DC");
  });

  it("finds Turck product URLs embedded in JSON search payloads", () => {
    const url = findTurckProductUrl(
      JSON.stringify({
        results: [
          {
            sku: "TBEN-L4-8DIP-8DOP",
            title: "TBEN-L4-8DIP-8DOP block I/O module",
            detailUrl: "/de/en/shop/automation-technology/i-o-systems/1000001"
          }
        ]
      }),
      "https://www.turck.com/de/en/shop/search?q=TBEN-L4-8DIP-8DOP",
      "TBEN-L4-8DIP-8DOP"
    );

    expect(url).toBe("https://www.turck.com/de/en/shop/automation-technology/i-o-systems/1000001");
  });

  it("uses all configured Turck shop search templates before failing", async () => {
    const turck = getManufacturerConfig("turck")!;
    const requestedUrls: string[] = [];
    const result = await getConnector("turck").scrape("TX-REMOTE-24", {
      manufacturer: turck,
      http: {
        fetchText: async (url: string) => {
          requestedUrls.push(url);
          if (url === "https://www.turck.com/de/en/shop/search?q=TX-REMOTE-24") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: "<main>No English result</main>"
            };
          }
          if (url === "https://www.turck.com/de/de/shop/search?q=TX-REMOTE-24") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "application/json",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `{"results":[{"sku":"TX-REMOTE-24","url":"/de/de/shop/automation-technology/fieldbus-technology/1001001"}]}`
            };
          }
          if (url === "https://www.turck.com/de/de/shop/automation-technology/fieldbus-technology/1001001") {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<html><head>
                <title>TX-REMOTE-24 | TURCK - Your Global Automation Partner</title>
                <meta name="keywords" content="Fieldbus module, " />
              </head><body>
                <h1>TX-REMOTE-24</h1>
                <p>TX-REMOTE-24 Order ID no. 1001001</p>
                <table><tr><th>Operating voltage</th><td>24 V DC</td></tr></table>
              </body></html>`
            };
          }
          throw new Error(`Unexpected URL ${url}`);
        }
      },
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: DocumentRecord) => doc,
      fallback: {
        scrape: async () => undefined
      }
    } as never);

    expect(requestedUrls).toContain("https://www.turck.com/de/en/shop/search?q=TX-REMOTE-24");
    expect(requestedUrls).toContain("https://www.turck.com/de/de/shop/search?q=TX-REMOTE-24");
    expect(result.productUrl).toBe("https://www.turck.com/de/de/shop/automation-technology/fieldbus-technology/1001001");
    expect(result.localizedUrls?.en).toBe("https://www.turck.com/de/en/shop/automation-technology/fieldbus-technology/1001001");
    expect(result.localizedUrls?.de).toBe("https://www.turck.com/de/de/shop/automation-technology/fieldbus-technology/1001001");
  });

  it("falls back to the shared official discovery/search net when Turck bespoke search misses", async () => {
    const turck = getManufacturerConfig("turck")!;
    const attemptedFallback: string[] = [];
    const fallbackResult: ProductResult = {
      manufacturerId: "turck",
      catalogNumber: "NI-DOES-NOT-EXIST-XYZ",
      status: "partial",
      confidence: 0.6,
      productUrl: "https://www.turck.com/de/en/shop/sensors/inductive-sensors/2002002",
      title: "Recovered via shared discovery",
      normalized: {},
      attributes: [],
      documents: [],
      sources: []
    };
    const result = await getConnector("turck").scrape("NI-DOES-NOT-EXIST-XYZ", {
      manufacturer: turck,
      http: {
        // Every bespoke/discovery fetch returns "no match" so the connector must reach the
        // shared discovery fallback rather than giving up (which is what it did before).
        fetchText: async (url: string) => ({
          requestedUrl: url,
          effectiveUrl: url,
          statusCode: 200,
          contentType: "text/html",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          fromCache: false,
          text: "<main>No matching Turck products</main>"
        })
      },
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: DocumentRecord) => doc,
      fallback: {
        scrape: async (catalogNumber: string) => {
          attemptedFallback.push(catalogNumber);
          return fallbackResult;
        }
      }
    } as never);

    expect(attemptedFallback).toContain("NI-DOES-NOT-EXIST-XYZ");
    expect(result.status).toBe("partial");
    expect(result.productUrl).toBe("https://www.turck.com/de/en/shop/sensors/inductive-sensors/2002002");
  });

  it("auto-discovers the site's search form even when a configured search template returns nothing", async () => {
    const searchedUrls: string[] = [];
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: {
        id: "generic",
        canonicalName: "Generic Manufacturer",
        shortName: "GEN",
        rateLimitMs: 100,
        officialBaseUrls: ["https://example.test/catalog"],
        fallbackSources: [],
        scrapeRecipe: {
          // A configured search endpoint that has since gone stale / returns no results.
          searchUrlTemplates: ["https://example.test/legacy-search?q={part}"]
        }
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
              text: `<form id="site-search" action="/search/results" method="get">
                <input type="search" name="q" aria-label="Search products" />
              </form>`
            };
          }
          if (url === "https://example.test/search/results?q=ABC-123") {
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
          // The configured legacy endpoint (and everything else) yields no product.
          return {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "text/html",
            fetchedAt: "2026-01-01T00:00:00.000Z",
            fromCache: false,
            text: "<main>No results</main>"
          };
        }
      }
    } as never);

    expect(searchedUrls).toContain("https://example.test/legacy-search?q=ABC-123");
    expect(searchedUrls).toContain("https://example.test/search/results?q=ABC-123");
    expect(discovered.candidates.some((candidate) => candidate.url === "https://example.test/catalog/detail.aspx?id=987")).toBe(true);
  });

  it("rejects a Turck numeric fallback page when the order id does not match", async () => {
    const turck = getManufacturerConfig("turck")!;
    const result = await getConnector("turck").scrape("1234567", {
      manufacturer: turck,
      http: {
        fetchText: async (url: string) => {
          if (url.includes("/shop/search?")) {
            return {
              requestedUrl: url,
              effectiveUrl: url,
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: "<main>No matching Turck products</main>"
            };
          }
          if (url === "https://www.turck.com/de/en/shop/p/1234567") {
            return {
              requestedUrl: url,
              effectiveUrl: "https://www.turck.com/de/en/shop/sensors/inductive-sensors/7654321",
              statusCode: 200,
              contentType: "text/html",
              fetchedAt: "2026-01-01T00:00:00.000Z",
              fromCache: false,
              text: `<html><head><title>OTHER-TURCK-PART | TURCK</title></head><body>
                <h1>OTHER-TURCK-PART</h1>
                <p>Order ID no. 7654321</p>
              </body></html>`
            };
          }
          throw new Error(`Unexpected URL ${url}`);
        }
      },
      runDir: "",
      documentsDir: "",
      downloadDocument: async (doc: DocumentRecord) => doc,
      fallback: {
        scrape: async () => undefined
      }
    } as never);

    expect(result.status).toBe("failed");
    expect(result.productUrl).toBeUndefined();
  });
});

describe("learned endpoint recency decay (Phase B6)", () => {
  const now = Date.parse("2026-07-24T00:00:00.000Z");
  it("does not penalize a recently-successful endpoint", () => {
    expect(learnedEndpointRecencyPenalty("2026-07-20T00:00:00.000Z", now)).toBe(0);
  });
  it("mildly penalizes an endpoint stale for 30-90 days", () => {
    expect(learnedEndpointRecencyPenalty("2026-06-01T00:00:00.000Z", now)).toBe(8);
  });
  it("heavily penalizes an endpoint stale for over 90 days", () => {
    expect(learnedEndpointRecencyPenalty("2026-01-01T00:00:00.000Z", now)).toBe(20);
  });
  it("returns 0 for a missing or invalid timestamp", () => {
    expect(learnedEndpointRecencyPenalty(undefined, now)).toBe(0);
    expect(learnedEndpointRecencyPenalty("not-a-date", now)).toBe(0);
  });
});

/**
 * Sitemap discovery used to sit AFTER url-variant guessing and was gated on a candidate COUNT
 * (`candidates.size < max(4, maxCandidates/2)`). Guessing inserts ~15 candidates, so the gate was
 * always already exceeded and sitemap discovery effectively never ran — for exactly the site it helps
 * most: a new vendor with no templates, no learned endpoints and an unusable site search.
 */
describe("sitemap discovery gating", () => {
  const bareVendor: ManufacturerConfig = {
    id: "bare",
    canonicalName: "Bare Vendor",
    shortName: "BAR",
    rateLimitMs: 0,
    officialBaseUrls: ["https://bare.test"],
    fallbackSources: []
  };

  const emptyPage = (url: string) => ({
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType: "text/html",
    text: "<html><body>nothing here</body></html>",
    fetchedAt: new Date(0).toISOString(),
    fromCache: false
  });

  const sitemapXml = (url: string, body: string) => ({
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType: "application/xml",
    text: body,
    fetchedAt: new Date(0).toISOString(),
    fromCache: false
  });

  it("runs when nothing but guesses have been collected, and finds the PDP in the vendor's own index", async () => {
    const fetched: string[] = [];
    const discovery = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: bareVendor,
      http: {
        fetchText: async (url: string) => {
          fetched.push(url);
          if (url === "https://bare.test/sitemap.xml") {
            return sitemapXml(
              url,
              `<urlset><url><loc>https://bare.test/en/catalogue/abc-123</loc></url>
               <url><loc>https://bare.test/en/catalogue/zzz-999</loc></url></urlset>`
            );
          }
          return emptyPage(url);
        }
      }
    } as never);

    expect(fetched).toContain("https://bare.test/sitemap.xml");
    const sitemapHit = discovery.candidates.find((candidate) => candidate.stage === "sitemap");
    expect(sitemapHit?.url).toBe("https://bare.test/en/catalogue/abc-123");
    // The other product in the index must not be picked up.
    expect(discovery.candidates.map((candidate) => candidate.url).join(" ")).not.toContain("zzz-999");
  });

  it("is skipped once a real search result exists, so a working search is not paid for twice", async () => {
    const fetched: string[] = [];
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: bareVendor,
      http: {
        fetchText: async (url: string) => {
          fetched.push(url);
          if (url.includes("q=ABC-123")) {
            return {
              ...emptyPage(url),
              text: `<html><body><a href="https://bare.test/products/ABC-123">ABC-123 product</a></body></html>`
            };
          }
          return emptyPage(url);
        }
      }
    } as never);

    expect(fetched).not.toContain("https://bare.test/sitemap.xml");
  });
});

/**
 * Blind search is bounded by TIME, and a contact form is not a search form.
 *
 * Both measured on the real Ganter corpus, where one catalog number cost 29 requests at 3000 ms of
 * enforced spacing each — 87 s of pure waiting. A flat cap of 28 requests meant 8,4 s for `eaton` and
 * 84 s for `gan`: same count, 10x the price.
 */
describe("discovery search budget and form quality", () => {
  const slowVendor: ManufacturerConfig = {
    id: "slow",
    canonicalName: "Slow Vendor",
    shortName: "SLW",
    // 3000 / 1 = 3000 ms per request, exactly Ganter's configured politeness.
    rateLimitMs: 3000,
    concurrency: 1,
    officialBaseUrls: ["https://slow.test"],
    fallbackSources: [],
    scrapeRecipe: { discoveryPolicy: { enableRobotsSitemaps: false } }
  };

  const html = (body: string) => (url: string) => ({
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType: "text/html",
    text: `<html><body>${body}</body></html>`,
    fetchedAt: new Date(0).toISOString(),
    fromCache: false
  });

  it("spends at most a time budget on blind search shapes, and says so in the diagnostics", async () => {
    const searchFetches: string[] = [];
    const discovery = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: slowVendor,
      http: {
        fetchText: async (url: string) => {
          if (/\/search/.test(url)) searchFetches.push(url);
          return html("no results")(url);
        }
      }
    } as never);

    // 6000 ms budget / 3000 ms per request = 2 shapes, not 18.
    expect(searchFetches).toHaveLength(2);
    expect(discovery.diagnostics.notes?.some((note) => note.startsWith("budget-exhausted:search"))).toBe(true);
  });

  it("does not treat a hidden plumbing field in a 'find your dealer' form as the search box", async () => {
    const submitted: string[] = [];
    // Ganter's real shape: the form text says "find", every field is contact plumbing.
    const dealerForm = `
      <form action="/en/company/contact" method="get">
        <p>Find your sales partner</p>
        <input type="hidden" name="salespartner[__referrer][@extension]" value="">
        <input type="hidden" name="salespartner[__trustedProperties]" value="x">
        <input type="text" name="salespartner[zip]">
        <select name="salespartner[country]"><option value="54">DE</option></select>
      </form>
      <form action="/en/products/quick-finder" method="get">
        <input type="search" name="q" placeholder="Search products">
      </form>`;
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: slowVendor,
      http: {
        fetchText: async (url: string) => {
          if (url.includes("contact") || url.includes("quick-finder")) submitted.push(url);
          return html(dealerForm)(url);
        }
      }
    } as never);

    expect(submitted.some((url) => url.includes("quick-finder"))).toBe(true);
    // Submitting a catalog number into a vendor's contact form is wrong twice over: it wastes the
    // budget and it sends junk to an endpoint that was never a search.
    expect(submitted.some((url) => url.includes("contact"))).toBe(false);
  });

  it("stops probing homepage locale variants once one of them yielded the search form", async () => {
    const multiLocale: ManufacturerConfig = {
      ...slowVendor,
      id: "multi",
      rateLimitMs: 1500,
      concurrency: 3,
      officialBaseUrls: ["https://multi.test/en", "https://multi.test/de"]
    };
    const homepageFetches: string[] = [];
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: multiLocale,
      http: {
        fetchText: async (url: string) => {
          if (!/\/search|\?/.test(url)) homepageFetches.push(url);
          return html('<form action="/find" method="get"><input type="search" name="q"></form>')(url);
        }
      }
    } as never);

    expect(homepageFetches.length).toBeLessThanOrEqual(2);
  });
});

/**
 * The path-style search shape must be reachable even for a vendor with several URL bases.
 *
 * Corpus evidence (tmp/analyze-query-keys.ts over page_cache): `/search/{part}` answered 182 of 184
 * times — the best-performing shape of all — and it was UNREACHABLE for any vendor with two or more
 * bases, because it sat after all 11 query keys and the list is cut at 18 entries. Which shapes a
 * vendor got to try depended on how many bases it happened to have, not on what works.
 */
describe("generic search shape reachability", () => {
  it("tries the path-style search shape even when the vendor has two URL bases", async () => {
    const twoBaseVendor: ManufacturerConfig = {
      id: "twobase",
      canonicalName: "Two Base Vendor",
      shortName: "2BV",
      rateLimitMs: 0,
      officialBaseUrls: ["https://two.test/en-us/products", "https://shop.two.test"],
      fallbackSources: [],
      scrapeRecipe: { discoveryPolicy: { enableRobotsSitemaps: false } }
    };
    const fetched: string[] = [];
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: twoBaseVendor,
      http: {
        fetchText: async (url: string) => {
          fetched.push(url);
          return {
            requestedUrl: url,
            effectiveUrl: url,
            statusCode: 200,
            contentType: "text/html",
            text: "<html><body>no results</body></html>",
            fetchedAt: new Date(0).toISOString(),
            fromCache: false
          };
        }
      }
    } as never);

    expect(fetched.some((url) => /\/search\/ABC-123$/.test(url))).toBe(true);
  });
});

/**
 * Learn the vendor's working search key once, not on every catalog number.
 *
 * The generic search stage fires up to 18 query-key shapes, of which at most one is the vendor's real
 * endpoint — and the other ~17 were re-paid per catalog number, per run, forever. Measured with
 * scripts/audit-discovery.ts (which now replays with an in-memory learned_endpoints store, so
 * learning across items is visible at all): median requests per catalog 11 -> 3, `schmersal` 11 -> 1.
 */
describe("learned search templates (D4)", () => {
  const searchVendor: ManufacturerConfig = {
    id: "learn",
    canonicalName: "Learn Vendor",
    shortName: "LRN",
    rateLimitMs: 0,
    officialBaseUrls: ["https://learn.test"],
    fallbackSources: [],
    scrapeRecipe: { discoveryPolicy: { enableRobotsSitemaps: false } }
  };

  /** Only `?keyword=` answers — every other query-key shape returns an empty page. */
  const onlyKeywordWorks = (url: string) => ({
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType: "text/html",
    text: /[?&]keyword=/i.test(url)
      ? `<html><body><a href="https://learn.test/products/${new URL(url).searchParams.get("keyword")}">match</a></body></html>`
      : "<html><body>no results</body></html>",
    fetchedAt: new Date(0).toISOString(),
    fromCache: false
  });

  function memoryStore() {
    const records: LearnedEndpointRecord[] = [];
    return {
      records,
      list: () => [...records].sort((left, right) => right.successCount - left.successCount),
      upsert: (endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">) => {
        const existing = records.find((record) => record.urlTemplate === endpoint.urlTemplate && record.method === endpoint.method);
        if (existing) {
          existing.successCount += 1;
          existing.failureCount = 0;
          return;
        }
        records.push({ ...endpoint, successCount: 1, lastSuccessAt: new Date(1).toISOString(), failureCount: 0 });
      },
      recordFailure: (_manufacturerId: string, _method: "GET" | "POST", urlTemplate: string) => {
        const existing = records.find((record) => record.urlTemplate === urlTemplate);
        if (existing) existing.failureCount = (existing.failureCount ?? 0) + 1;
      }
    };
  }

  it("remembers the one query key that answered, and the next catalog number tries only that", async () => {
    const store = memoryStore();
    const firstFetches: string[] = [];
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: searchVendor,
      http: {
        fetchText: async (url: string) => {
          firstFetches.push(url);
          return onlyKeywordWorks(url);
        }
      },
      learnedEndpoints: store
    } as never);

    const learned = store.records.filter((record) => record.parserKind === "official-search-template");
    expect(learned).toHaveLength(1);
    expect(learned[0].urlTemplate).toContain("keyword=");

    const secondFetches: string[] = [];
    const second = await discoverOfficialProductCandidates("XYZ-999", {
      manufacturer: searchVendor,
      http: {
        fetchText: async (url: string) => {
          secondFetches.push(url);
          return onlyKeywordWorks(url);
        }
      },
      learnedEndpoints: store
    } as never);

    // The whole point: the working key is first AND ends the stage, so the ~17 misses are not re-paid.
    expect(secondFetches).toHaveLength(1);
    expect(secondFetches[0]).toContain("keyword=XYZ-999");
    expect(firstFetches.length).toBeGreaterThan(secondFetches.length);
    expect(second.candidates.map((candidate) => candidate.url)).toContain("https://learn.test/products/XYZ-999");
  });

  it("never puts a learned search endpoint on the product-candidate list", async () => {
    const store = memoryStore();
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: searchVendor,
      http: { fetchText: async (url: string) => onlyKeywordWorks(url) },
      learnedEndpoints: store
    } as never);

    const second = await discoverOfficialProductCandidates("XYZ-999", {
      manufacturer: searchVendor,
      http: { fetchText: async (url: string) => onlyKeywordWorks(url) },
      learnedEndpoints: store
    } as never);

    expect(second.candidates.some((candidate) => candidate.url.includes("keyword="))).toBe(false);
    expect(second.candidates.some((candidate) => candidate.stage === "learned-endpoint")).toBe(false);
  });

  it("takes a failure when a learned endpoint stops answering, so a renamed one is not a permanent tax", async () => {
    const store = memoryStore();
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: searchVendor,
      http: { fetchText: async (url: string) => onlyKeywordWorks(url) },
      learnedEndpoints: store
    } as never);

    const dead = (url: string) => ({ ...onlyKeywordWorks(url), text: "<html><body>no results</body></html>" });
    await discoverOfficialProductCandidates("XYZ-999", {
      manufacturer: searchVendor,
      http: { fetchText: async (url: string) => dead(url) },
      learnedEndpoints: store
    } as never);

    const learned = store.records.find((record) => record.parserKind === "official-search-template");
    expect(learned?.failureCount).toBe(1);
  });
});

/**
 * Three URL classes that are categorically not product pages.
 *
 * All three were only PENALISED before, and a penalty loses to a URL that otherwise looks perfect.
 * Measured on real cached pages: Siemens' own search URL ranked #1 for 6/6 catalog numbers (it
 * carries the exact catalog in `searchTerm=`), and once that was rejected a Shibboleth SSO login and
 * a Turck product photo took its place at #1.
 */
describe("candidates that can never be a product page", () => {
  const vendor: ManufacturerConfig = {
    id: "junk",
    canonicalName: "Junk Vendor",
    shortName: "JNK",
    rateLimitMs: 0,
    officialBaseUrls: ["https://junk.test"],
    fallbackSources: [],
    scrapeRecipe: { discoveryPolicy: { enableRobotsSitemaps: false } }
  };

  const resultPage = (links: string[]) => (url: string) => ({
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType: "text/html",
    text: `<html><body>${links.map((href) => `<a href="${href}">ABC-123</a>`).join("")}</body></html>`,
    fetchedAt: new Date(0).toISOString(),
    fromCache: false
  });

  it("rejects a search page, an image asset, a login wall and the homepage, and keeps the real product link", async () => {
    const page = resultPage([
      "https://junk.test/Catalog/Search?searchTerm=ABC-123&tab=Product",
      "https://junk.test/media/ABC-123_640x640.png/",
      "https://junk.test/Shibboleth.sso/Login?target=https%3a%2f%2fjunk.test%2fABC-123",
      "https://junk.test/",
      "https://junk.test/products/ABC-123"
    ]);
    const discovery = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: vendor,
      http: { fetchText: async (url: string) => page(url) }
    } as never);

    const urls = discovery.candidates.map((candidate) => candidate.url);
    expect(urls).toContain("https://junk.test/products/ABC-123");
    expect(urls.some((url) => url.includes("searchTerm="))).toBe(false);
    // The trailing slash is the point: the asset penalty's pattern required the extension to end the URL.
    expect(urls.some((url) => url.includes(".png"))).toBe(false);
    expect(urls.some((url) => /sso|login/i.test(url))).toBe(false);
    // The homepage ranked #1 for 8/8 measured nVent catalog numbers, ahead of the real PDP.
    expect(urls).not.toContain("https://junk.test/");
    expect(urls).not.toContain("https://junk.test");
  });
});

/**
 * Confirm the cheap candidate before paying for search.
 *
 * Measured by scripts/audit-discovery.ts over 160 known-good catalog numbers: 79 % of hits came from
 * template/learned stages that cost zero requests, while the search stage ran first and
 * unconditionally at a median of 22 requests per catalog number. Probing the top template first cut
 * that to 11 with the hit-rate unchanged (69.4 %) and better ranking (top-3 52.5 % -> 57.5 %).
 */
describe("template confirmation before search escalation", () => {
  const templateVendor: ManufacturerConfig = {
    id: "tpl",
    canonicalName: "Template Vendor",
    shortName: "TPL",
    rateLimitMs: 0,
    officialBaseUrls: ["https://tpl.test/products/{part}"],
    fallbackSources: [],
    scrapeRecipe: { discoveryPolicy: { enableRobotsSitemaps: false } }
  };

  const page = (url: string, text: string, statusCode = 200) => ({
    requestedUrl: url,
    effectiveUrl: url,
    statusCode,
    contentType: "text/html",
    text,
    fetchedAt: new Date(0).toISOString(),
    fromCache: false
  });

  it("skips the whole search stage when the template page identifies the exact catalog number", async () => {
    const fetched: string[] = [];
    const discovery = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: templateVendor,
      http: {
        fetchText: async (url: string) => {
          fetched.push(url);
          if (url === "https://tpl.test/products/ABC-123") return page(url, "<html><head><title>ABC-123</title></head><body><h1>ABC-123</h1></body></html>");
          return page(url, "<html><body>nothing</body></html>");
        }
      }
    } as never);

    expect(fetched).toEqual(["https://tpl.test/products/ABC-123"]);
    expect(fetched.some((url) => /[?&](?:q|query|search)=/i.test(url))).toBe(false);
    expect(discovery.candidates[0]?.url).toBe("https://tpl.test/products/ABC-123");
    expect(discovery.candidates[0]?.reason).toContain("confirmed by fetch");
  });

  it("still escalates to search when the template page does not identify the catalog number", async () => {
    const fetched: string[] = [];
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: templateVendor,
      http: {
        fetchText: async (url: string) => {
          fetched.push(url);
          return page(url, "<html><head><title>Page not found</title></head><body>nothing</body></html>", url.includes("/products/ABC-123") ? 404 : 200);
        }
      }
    } as never);

    expect(fetched).toContain("https://tpl.test/products/ABC-123");
    expect(fetched.some((url) => /[?&](?:q|query|search)=/i.test(url))).toBe(true);
  });

  it("never spends a probe on a bare URL guess, because a guess is not evidence", async () => {
    const guessVendor: ManufacturerConfig = {
      id: "guess",
      canonicalName: "Guess Vendor",
      shortName: "GSS",
      rateLimitMs: 0,
      // No {part} placeholder: nothing here is a direct template, so everything is a url-variant guess.
      officialBaseUrls: ["https://guess.test"],
      fallbackSources: [],
      scrapeRecipe: { discoveryPolicy: { enableRobotsSitemaps: false } }
    };
    const fetched: string[] = [];
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: guessVendor,
      http: {
        fetchText: async (url: string) => {
          fetched.push(url);
          return page(url, "<html><body>nothing</body></html>");
        }
      }
    } as never);

    // Search must still have run: a guess can never gate it.
    expect(fetched.some((url) => /[?&](?:q|query|search)=/i.test(url))).toBe(true);
  });
});

/**
 * A synthesised URL guess must never outrank evidence.
 *
 * `scoreDiscoveryCandidate`'s bonuses are all about URL SHAPE, and a guess is CONSTRUCTED to have the
 * ideal shape — so "{origin}/products/{part}" scored 40+30+35+15+10 = 130, clamped to 100, above every
 * evidence-backed stage. Two consequences, both measured by scripts/audit-discovery.ts replaying real
 * cached pages: guesses took rank #1, and they pushed genuine hits out of the maxCandidates slice
 * entirely. Capping guesses lifted "known PDP ranked #1" from 7.5% to 20% and "found at all" from
 * 22.5% to 40% over 40 real catalog numbers.
 */
describe("url-variant guesses rank below evidence", () => {
  it("caps a perfectly-shaped guess below a search-result hit", () => {
    const guess = scoreDiscoveryCandidate("https://example.test/products/ABC-123", "ABC-123", "url-variant", manufacturer);
    const searchHit = scoreDiscoveryCandidate("https://example.test/products/ABC-123", "ABC-123", "search-result", manufacturer);
    const template = scoreDiscoveryCandidate("https://example.test/products/ABC-123", "ABC-123", "direct-template", manufacturer);
    const sitemapHit = scoreDiscoveryCandidate("https://example.test/products/ABC-123", "ABC-123", "sitemap", manufacturer);

    expect(guess).toBeLessThan(searchHit);
    expect(guess).toBeLessThan(template);
    // A sitemap URL comes out of the vendor's own index, so it exists — better evidence than a guess.
    expect(guess).toBeLessThan(sitemapHit);
  });

  it("still ranks a plausible guess above an obviously bad one", () => {
    const plausible = scoreDiscoveryCandidate("https://example.test/products/ABC-123", "ABC-123", "url-variant", manufacturer);
    const asset = scoreDiscoveryCandidate("https://example.test/files/ABC-123.pdf", "ABC-123", "url-variant", manufacturer);
    const unrelated = scoreDiscoveryCandidate("https://example.test/support/contact", "ABC-123", "url-variant", manufacturer);

    expect(plausible).toBeGreaterThan(asset);
    expect(plausible).toBeGreaterThan(unrelated);
  });

  it("never guesses a direct product URL on homepageUrl's origin when it differs from officialBaseUrls", async () => {
    // Real FATH config: officialBaseUrls is fath24.com (the actual catalog), but homepageUrl is the
    // DIFFERENT apex domain fath.com (the corporate site). A real `npm run audit:discovery` replay
    // found the guessed `https://www.fath.com/en/{variant}` (homepageUrl's own origin + a slugified
    // catalog number) outranking the real fath24.com product URL — a guess on a domain nobody
    // declared hosts product pages can never be correct.
    const offDomainHome: ManufacturerConfig = {
      id: "off-domain-home",
      canonicalName: "Off Domain Home",
      shortName: "ODH",
      rateLimitMs: 100,
      officialBaseUrls: ["https://catalog.example"],
      homepageUrl: "https://corporate.example/en/",
      fallbackSources: []
    };
    const discovered = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: offDomainHome,
      http: {
        fetchText: async () => {
          throw new Error("no network in this test");
        }
      }
    } as never);

    const homepageOriginGuess = discovered.candidates.some((candidate) => new URL(candidate.url).origin === "https://corporate.example");
    const officialOriginGuess = discovered.candidates.some((candidate) => new URL(candidate.url).origin === "https://catalog.example" && candidate.url.includes("abc123"));
    expect(homepageOriginGuess).toBe(false);
    expect(officialOriginGuess).toBe(true);
  });
});

/**
 * Gzipped sitemap, end to end. Proves discovery routes a `.gz` URL to the binary-capable fetch — the
 * decoder itself is covered by tests/gzip-text.test.ts. The stub deliberately makes `fetchText` return
 * mojibake for the archive, exactly as a real client would, so a regression that stops using
 * `fetchMaybeCompressedText` fails here instead of silently finding zero URLs.
 */
describe("gzipped sitemap discovery", () => {
  const bareVendor: ManufacturerConfig = {
    id: "gzvendor",
    canonicalName: "Gz Vendor",
    shortName: "GZV",
    rateLimitMs: 0,
    officialBaseUrls: ["https://gz.test"],
    fallbackSources: []
  };

  const SITEMAP_XML =
    "<urlset><url><loc>https://gz.test/en/catalogue/abc-123</loc></url>" +
    "<url><loc>https://gz.test/en/catalogue/zzz-999</loc></url></urlset>";

  const reply = (url: string, text: string, contentType = "text/html") => ({
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType,
    text,
    fetchedAt: new Date(0).toISOString(),
    fromCache: false
  });

  it("finds the PDP inside a sitemap.xml.gz advertised by robots.txt", async () => {
    const compressedFetches: string[] = [];
    const discovery = await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: bareVendor,
      http: {
        fetchText: async (url: string) => {
          if (url === "https://gz.test/robots.txt") {
            return reply(url, "User-agent: *\nSitemap: https://gz.test/sitemap.xml.gz\n", "text/plain");
          }
          // A real client cannot decode the archive here — this is the mojibake that used to make
          // extractSitemapLocs return nothing at all.
          if (url.endsWith(".gz")) return reply(url, "\u001f\u008b\u0008\u0000garbled", "application/gzip");
          return reply(url, "<html><body>nothing</body></html>");
        },
        fetchMaybeCompressedText: async (url: string) => {
          compressedFetches.push(url);
          return reply(url, SITEMAP_XML, "application/xml");
        }
      }
    } as never);

    expect(compressedFetches).toContain("https://gz.test/sitemap.xml.gz");
    const sitemapHit = discovery.candidates.find((candidate) => candidate.stage === "sitemap");
    expect(sitemapHit?.url).toBe("https://gz.test/en/catalogue/abc-123");
  });

  it("does not use the binary path for a plain sitemap.xml", async () => {
    const compressedFetches: string[] = [];
    await discoverOfficialProductCandidates("ABC-123", {
      manufacturer: bareVendor,
      http: {
        fetchText: async (url: string) =>
          url === "https://gz.test/sitemap.xml" ? reply(url, SITEMAP_XML, "application/xml") : reply(url, "<html></html>"),
        fetchMaybeCompressedText: async (url: string) => {
          compressedFetches.push(url);
          return reply(url, "");
        }
      }
    } as never);

    expect(compressedFetches).toHaveLength(0);
  });
});
