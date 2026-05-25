import { describe, expect, it } from "vitest";
import { discoverOfficialProductCandidates, scoreDiscoveryCandidate } from "../src/server/scrapers/discovery.js";
import type { ManufacturerConfig } from "../src/shared/types.js";

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
});
