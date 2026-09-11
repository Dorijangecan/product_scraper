/**
 * COLD-START-PLAN §6.2, P4.6 – P4.12: finding the product when the vendor's links have no logic.
 *
 * The common thread in every test here: these features change WHAT WE MAY LOOK AT, never what may be
 * published. Anything fetched still has to pass `scoreFetchedDiscoveryEvidence`, which demands an
 * exact catalog match on a product identity surface.
 */
import { describe, expect, it } from "vitest";
import { searchQueryVariants } from "../src/server/scrapers/catalog-number.js";
import { discoverUnverifiedResultLinks, fuzzyCatalogAffinity } from "../src/server/scrapers/link-discovery.js";
import { aliasSearchTerms, harvestProductAliases } from "../src/server/scrapers/product-aliases.js";
import { externalSearchEnabled, externalSearchUrl, parseExternalSearchResults } from "../src/server/scrapers/external-search.js";
import { discoverOfficialProductCandidates } from "../src/server/scrapers/discovery.js";
import type { ManufacturerConfig, ProductAliasRecord, ProductResult } from "../src/shared/types.js";

describe("searchQueryVariants (P4.6)", () => {
  it("asks the way a person retries: as printed, then without separators, then the family", () => {
    const variants = searchQueryVariants("CT-MFD.21");
    expect(variants.map((variant) => variant.term)).toEqual(["CT-MFD.21", "ctmfd21", "ct-mfd-21", "CT-MFD"]);
    expect(variants.at(-1)).toMatchObject({ level: "family", reason: "family prefix" });
    expect(variants.slice(0, -1).every((variant) => variant.level === "exact")).toBe(true);
  });

  it("never emits the same query twice, whatever the casing", () => {
    const terms = searchQueryVariants("abc123").map((variant) => variant.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("takes the part after a prefix separator when there is one", () => {
    expect(searchQueryVariants("SIE:3RV2011-1AA10").map((variant) => variant.term)).toContain("3RV2011-1AA10");
  });
});

describe("fuzzyCatalogAffinity (P4.10)", () => {
  it("scores by how many of the catalog's token runs the text prints", () => {
    expect(fuzzyCatalogAffinity("CT-MFD.21 monitoring relay", "CT-MFD.21")).toBe(1);
    expect(fuzzyCatalogAffinity("CT-MFD.22 monitoring relay", "CT-MFD.21")).toBeCloseTo(2 / 3);
    expect(fuzzyCatalogAffinity("Pressure switch", "CT-MFD.21")).toBe(0);
  });

  it("ignores single-character runs, which match everything and rank nothing", () => {
    // Tokens are MFD and 21; the lone "A" must not count towards the score.
    expect(fuzzyCatalogAffinity("MFD 21", "A-MFD-21")).toBe(1);
  });
});

describe("discoverUnverifiedResultLinks (P4.7)", () => {
  const resultsPage = `
    <nav><a href="/en/about-us">About</a></nav>
    <ul class="search-results">
      <li class="product-card"><a href="/en/p/1348271">Monitoring relay, multifunction</a></li>
      <li class="product-card"><a href="/en/p/1348272">CT-MFD monitoring relay 21</a></li>
      <li class="product-card"><a href="/en/p/1348273">Pressure switch</a></li>
      <li class="product-card"><a href="/media/datasheet.pdf">Datasheet</a></li>
    </ul>`;

  it("returns product-shaped results even though no card carries the catalog number", () => {
    const links = discoverUnverifiedResultLinks(resultsPage, "https://vendor.test/en/search?q=CT-MFD.21", "CT-MFD.21", 3);
    expect(links).toHaveLength(3);
    // The card that prints two of the three token runs is the one a person would click first.
    expect(links[0].url).toBe("https://vendor.test/en/p/1348272");
  });

  it("does not offer navigation or a document as a product result", () => {
    const urls = discoverUnverifiedResultLinks(resultsPage, "https://vendor.test/en/search", "CT-MFD.21", 10).map((link) => link.url);
    expect(urls).not.toContain("https://vendor.test/en/about-us");
    expect(urls.some((url) => url.endsWith(".pdf"))).toBe(false);
  });

  it("respects the limit — this is three clicks, not a crawl", () => {
    expect(discoverUnverifiedResultLinks(resultsPage, "https://vendor.test/en/search", "CT-MFD.21", 1)).toHaveLength(1);
  });
});

describe("product aliases (P4.8 / P4.9)", () => {
  const result = (attributes: Array<{ name: string; value: string }>): ProductResult =>
    ({ attributes, documents: [], sources: [] }) as unknown as ProductResult;

  it("keeps a type designation as family-level and an order code as exact", () => {
    const aliases = harvestProductAliases(
      result([
        { name: "Type designation", value: "CT-MFD.21" },
        { name: "Order code", value: "1SVR405611R1000" }
      ]),
      "abb",
      "1SVR405611R1000",
      "https://abb.test/p/1"
    );
    // The requested number restated under another label teaches nothing and is dropped.
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({ aliasKind: "type-designation", aliasValue: "CT-MFD.21", identityLevel: "family" });
  });

  it("accepts a GTIN only at a length GS1 actually issues", () => {
    const good = harvestProductAliases(result([{ name: "EAN", value: "4013614017674" }]), "v", "X-1", "https://v.test/p");
    expect(good[0]).toMatchObject({ aliasKind: "gtin", aliasValue: "4013614017674", identityLevel: "exact" });
    expect(harvestProductAliases(result([{ name: "EAN", value: "40136140" + "1767" }]), "v", "X-1", "https://v.test/p")).toHaveLength(1);
    expect(harvestProductAliases(result([{ name: "EAN", value: "12345" }]), "v", "X-1", "https://v.test/p")).toHaveLength(0);
  });

  it("refuses a multi-value cell, which is a family listing and not this product's second name", () => {
    expect(harvestProductAliases(result([{ name: "Order code", value: "A-1; A-2; A-3" }]), "v", "X-1", "https://v.test/p")).toHaveLength(0);
  });

  it("asks with the most precise alias first and the family-level one last", () => {
    const aliases: ProductAliasRecord[] = [
      { manufacturerId: "v", catalogNumber: "X-1", aliasKind: "type-designation", aliasValue: "CT-MFD", identityLevel: "family", provenanceUrl: "u", confirmedAt: "t" },
      { manufacturerId: "v", catalogNumber: "X-1", aliasKind: "gtin", aliasValue: "4013614017674", identityLevel: "exact", provenanceUrl: "u", confirmedAt: "t" }
    ];
    expect(aliasSearchTerms(aliases).map((alias) => alias.term)).toEqual(["4013614017674", "CT-MFD"]);
  });
});

describe("external search bridge (P4.12)", () => {
  it("is off unless the operator switched it on", () => {
    expect(externalSearchEnabled({})).toBe(false);
    expect(externalSearchEnabled({ PRODUCT_SCRAPER_ALLOW_EXTERNAL_SEARCH: "0" })).toBe(false);
    expect(externalSearchEnabled({ PRODUCT_SCRAPER_ALLOW_EXTERNAL_SEARCH: "1" })).toBe(true);
  });

  it("asks only about the vendor's own hosts", () => {
    const url = externalSearchUrl(["www.vendor.test", "shop.vendor.test"], "CT-MFD.21");
    expect(url).toContain(encodeURIComponent("site:vendor.test OR site:shop.vendor.test"));
    expect(url).toContain(encodeURIComponent('"CT-MFD.21"'));
    expect(externalSearchUrl([], "CT-MFD.21")).toBeUndefined();
  });

  // Without unwrapping, every candidate would be on duckduckgo.com and the official-domain guard
  // would correctly reject all of them — the bridge would look broken rather than blocked.
  it("unwraps the engine's redirect to the real target and drops its own pages", () => {
    const html = `
      <a href="/l/?uddg=https%3A%2F%2Fwww.vendor.test%2Fen%2Fp%2F1348272">Result</a>
      <a href="https://duckduckgo.com/settings">Settings</a>
      <a href="/l/?uddg=https%3A%2F%2Fwww.vendor.test%2Fen%2Fp%2F1348272">Duplicate</a>`;
    expect(parseExternalSearchResults({ text: html })).toEqual(["https://www.vendor.test/en/p/1348272"]);
  });
});

describe("discovery end to end (P4.6 / P4.7 / P4.11)", () => {
  const vendor: ManufacturerConfig = {
    id: "reask-vendor",
    canonicalName: "Reask Vendor",
    shortName: "RSK",
    rateLimitMs: 100,
    homepageUrl: "https://reask.test/",
    officialBaseUrls: ["https://reask.test"],
    fallbackSources: [],
    scrapeRecipe: {
      discoveryPolicy: {
        maxCandidates: 8,
        enableRobotsSitemaps: false,
        searchUrlTemplates: ["https://reask.test/find?q={part}"]
      }
    }
  };

  const html = (body: string, url: string, statusCode = 200) => ({
    requestedUrl: url,
    effectiveUrl: url,
    statusCode,
    contentType: "text/html",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    fromCache: false,
    text: body
  });

  it("re-asks a zero-result endpoint with the separator-free form (P4.6)", async () => {
    const requested: string[] = [];
    const discovery = await discoverOfficialProductCandidates("CT-MFD.21", {
      manufacturer: vendor,
      http: {
        fetchText: async (url: string) => {
          requested.push(url);
          if (url === "https://reask.test/find?q=CT-MFD.21") return html("<p>No results found.</p>", url);
          if (url === "https://reask.test/find?q=ctmfd21") {
            return html(`<a href="/en/p/9001">CT-MFD.21 monitoring relay</a>`, url);
          }
          return html("", url, 404);
        }
      }
    } as never);

    expect(requested).toContain("https://reask.test/find?q=ctmfd21");
    const reasked = discovery.candidates.find((candidate) => candidate.url === "https://reask.test/en/p/9001");
    expect(reasked).toBeDefined();
    // A result obtained by asking a DIFFERENT question is not evidence about the one we asked. Live,
    // Ganter's quick-finder answered the compact form with unrelated handwheels that "confirmed"
    // themselves off the page's echoed query — so a re-asked result enters unverified and is decided by
    // the post-fetch gate, never by having outranked everything else.
    expect(reasked!.stage).toBe("search-result-unverified");
    expect(reasked!.reason).toContain("query variant");
  });

  // `learnSearchTemplate` derives the template by locating the catalog number in the URL, so learning
  // from a re-ask would teach `?q={partCompact}` — a shape that answered a question we never asked, and
  // would then be tried FIRST for every later catalog number of the run.
  it("never learns a search template from a re-asked query", async () => {
    const learned: string[] = [];
    await discoverOfficialProductCandidates("CT-MFD.21", {
      manufacturer: vendor,
      learnedEndpoints: {
        list: () => [],
        upsert: (endpoint: { urlTemplate: string }) => learned.push(endpoint.urlTemplate),
        recordFailure: () => undefined
      },
      http: {
        fetchText: async (url: string) => {
          if (url === "https://reask.test/find?q=CT-MFD.21") return html("<p>No results found.</p>", url);
          if (url === "https://reask.test/find?q=ctmfd21") return html(`<a href="/en/p/9001">CT-MFD.21 relay</a>`, url);
          return html("", url, 404);
        }
      }
    } as never);

    expect(learned.some((template) => template.includes("partCompact"))).toBe(false);
  });

  it("opens an unidentified result and ranks it below every evidence-backed stage (P4.7)", async () => {
    const discovery = await discoverOfficialProductCandidates("CT-MFD.21", {
      manufacturer: vendor,
      http: {
        fetchText: async (url: string) => {
          if (url.startsWith("https://reask.test/find?q=")) {
            return html(
              `<div class="toolbar">2 results</div>
               <ul><li class="product-card"><a href="/en/p/1348272">Monitoring relay, multifunction</a></li></ul>`,
              url
            );
          }
          return html("", url, 404);
        }
      }
    } as never);

    const unverified = discovery.candidates.find((candidate) => candidate.stage === "search-result-unverified");
    expect(unverified?.url).toBe("https://reask.test/en/p/1348272");
    // It is a maybe, so it must never outrank something the vendor actually told us about.
    const evidenceBacked = discovery.candidates.filter((candidate) => candidate.stage === "search-result");
    for (const candidate of evidenceBacked) expect(candidate.score).toBeGreaterThan(unverified!.score);
  });

  // Past the soft target the pipeline stops spending on maybes — the same rule url-variant follows.
  it("does not open unidentified results once the soft target has passed", async () => {
    const discovery = await discoverOfficialProductCandidates("CT-MFD.21", {
      manufacturer: vendor,
      deadline: { remainingMs: () => 90_000, softTargetPassed: () => true, elapsedMs: () => 45_000 },
      http: {
        fetchText: async (url: string) =>
          url.startsWith("https://reask.test/find?q=")
            ? html(`<div>2 results</div><ul><li class="product-card"><a href="/en/p/1348272">Relay</a></li></ul>`, url)
            : html("", url, 404)
      }
    } as never);

    expect(discovery.candidates.some((candidate) => candidate.stage === "search-result-unverified")).toBe(false);
  });

  // The bug this guards: `hasEvidenceBackedCandidate` gated sitemap discovery on "any stage that is
  // not url-variant", so the moment P4.7 added ONE unidentified link the vendor's own sitemap index
  // stopped being read — and a sitemap entry is strictly better evidence than a link nothing
  // identified. Neither offline audit could catch it, because the corpus never triggers both stages.
  it("an unidentified result never counts as evidence, so sitemaps are still consulted (P4.7)", async () => {
    const sitemapVendor: ManufacturerConfig = {
      ...vendor,
      id: "both-stages-vendor",
      scrapeRecipe: {
        discoveryPolicy: {
          maxCandidates: 8,
          enableRobotsSitemaps: true,
          sitemapUrls: ["https://reask.test/sitemap.xml"],
          searchUrlTemplates: ["https://reask.test/find?q={part}"]
        }
      }
    };
    const discovery = await discoverOfficialProductCandidates("CT-MFD.21", {
      manufacturer: sitemapVendor,
      http: {
        fetchText: async (url: string) => {
          if (url.startsWith("https://reask.test/find?q=")) {
            return html(
              `<div>2 results</div><ul><li class="product-card"><a href="/en/p/1348272">Relay</a></li></ul>`,
              url
            );
          }
          if (url === "https://reask.test/sitemap.xml") {
            return html("<urlset><url><loc>https://reask.test/en/p/ct-mfd-21</loc></url></urlset>", url);
          }
          return html("", url, 404);
        }
      }
    } as never);

    const stages = discovery.candidates.map((candidate) => candidate.stage);
    expect(stages).toContain("search-result-unverified");
    expect(stages).toContain("sitemap");
    // And the vendor's own index outranks the link nobody identified.
    const sitemapCandidate = discovery.candidates.find((candidate) => candidate.stage === "sitemap")!;
    const unverified = discovery.candidates.find((candidate) => candidate.stage === "search-result-unverified")!;
    expect(sitemapCandidate.score).toBeGreaterThan(unverified.score);
  });

  it("reads a fresh sitemap index locally instead of re-walking sitemaps (P4.11)", async () => {
    const sitemapVendor: ManufacturerConfig = {
      ...vendor,
      id: "sitemap-vendor",
      scrapeRecipe: {
        discoveryPolicy: {
          maxCandidates: 8,
          enableRobotsSitemaps: true,
          sitemapUrls: ["https://reask.test/sitemap.xml"]
        }
      }
    };
    const requested: string[] = [];
    const discovery = await discoverOfficialProductCandidates("CT-MFD.21", {
      manufacturer: sitemapVendor,
      sitemapIndex: {
        status: () => ({ count: 1200, indexedAt: new Date().toISOString() }),
        lookup: () => ["https://reask.test/en/p/ct-mfd-21"],
        replace: () => undefined
      },
      http: {
        fetchText: async (url: string) => {
          requested.push(url);
          return html("", url, 404);
        }
      }
    } as never);

    expect(requested).not.toContain("https://reask.test/sitemap.xml");
    expect(discovery.candidates.map((candidate) => candidate.url)).toContain("https://reask.test/en/p/ct-mfd-21");
  });
});
