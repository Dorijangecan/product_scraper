import { describe, expect, it } from "vitest";
import { minePage } from "../src/server/scrapers/page-mining.js";
import { mergeFetchedPageMining, runAdaptivePageIntelligence } from "../src/server/scrapers/page-intelligence.js";
import type { ProductResult } from "../src/shared/types.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";

describe("adaptive page mining", () => {
  it("skips stale non-replayable learned records before the host recipe limit", async () => {
    const stalePatterns = [
      "embedded-json",
      "catalog-neighborhood",
      "text-pairs",
      "data-attributes",
      "lazy-images",
      "text-urls",
      "key-value-table",
      "hidden-dom"
    ];
    const records = [...stalePatterns, "css:table-row:tr.persisted-spec"].map((pattern, index) => ({
      id: index + 1,
      manufacturerId: "test",
      host: "example.test",
      kind: "dom-pattern" as const,
      pattern,
      sourceUrl: "https://example.test/products/ABC-123",
      parserKind: "adaptive-static-page-mining",
      successCount: 10 - index,
      lastSuccessAt: "2026-01-01T00:00:00.000Z"
    }));
    let requestedLimit = 0;
    const result: ProductResult = {
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "partial",
      confidence: 0.5,
      productUrl: "https://example.test/products/ABC-123",
      normalized: {},
      attributes: [],
      documents: [],
      sources: [],
      qualityGate: { passed: false, identityConfirmed: true, score: 40, missing: ["current"], reason: "Missing current", attempts: [] }
    };
    const context = {
      manufacturer: { id: "test", canonicalName: "Test", shortName: "TST", rateLimitMs: 0, officialBaseUrls: ["https://example.test"], fallbackSources: [] },
      learnedExtractors: {
        list: (_manufacturerId: string, _host: string, limit = 20) => {
          requestedLimit = limit;
          return records.slice(0, limit);
        }
      },
      http: {
        fetchText: async () => ({
          requestedUrl: "https://example.test/products/ABC-123",
          effectiveUrl: "https://example.test/products/ABC-123",
          statusCode: 200,
          contentType: "text/html",
          fetchedAt: "2026-01-01T00:00:00.000Z",
          fromCache: true,
          text: "<table><tr class=\"persisted-spec\"><th>Rated current</th><td>16 A</td></tr></table>"
        })
      },
      downloadDocument: async (document: unknown) => document,
      fallback: { scrape: async () => undefined }
    } as unknown as ScrapeContext;

    const mined = await runAdaptivePageIntelligence(result, "ABC-123", context);

    expect(requestedLimit).toBeGreaterThan(8);
    expect(mined.diagnostics?.pageMining?.at(-1)?.signals).toContain("replayed:css:table-row:tr.persisted-spec");
    expect(mined.diagnostics?.pageIntelligence?.some((entry) => entry.stage === "learned-extractor-replay" && entry.reason?.includes("1 learned extractor"))).toBe(true);
  });

  it("offers learned recipes to a wizard review sink instead of persisting them", () => {
    const proposed: string[] = [];
    const persisted: string[] = [];
    const result: ProductResult = {
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "partial",
      confidence: 0.5,
      normalized: {},
      attributes: [],
      documents: [],
      sources: []
    };
    const context = {
      manufacturer: { id: "test", canonicalName: "Test", shortName: "TST", rateLimitMs: 0, officialBaseUrls: ["https://example.test"], fallbackSources: [] },
      learnedExtractors: {
        list: () => [],
        upsert: (extractor: { pattern: string }) => persisted.push(extractor.pattern),
        propose: (extractor: { pattern: string }) => proposed.push(extractor.pattern)
      }
    } as unknown as ScrapeContext;

    mergeFetchedPageMining(result, {
      requestedUrl: "https://example.test/products/ABC-123",
      effectiveUrl: "https://example.test/products/ABC-123",
      statusCode: 200,
      contentType: "text/html",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      fromCache: false,
      text: `<table><tr class="spec-row"><th>Rated current</th><td>16 A</td></tr></table>
        <table id="product-specs"><tr><th>Catalog Number</th><th>Rated voltage [V]</th></tr>
        <tr><td>ABC-123</td><td>24 DC</td></tr></table>`
    }, "ABC-123", context, { stage: "wizard-test", method: "static-html" });

    expect(proposed).toEqual(expect.arrayContaining(["css:table-row:tr.spec-row"]));
    expect(proposed).toEqual(expect.arrayContaining(["html-table:header-column:table#product-specs:Catalog%20Number"]));
    expect(proposed).not.toEqual(expect.arrayContaining(["key-value-table"]));
    expect(persisted).toEqual([]);
  });

  it("extracts hidden DOM, data attributes, lazy images and srcset candidates", () => {
    const mined = minePage(
      {
        requestedUrl: "https://example.test/products/ABC-123",
        effectiveUrl: "https://example.test/products/ABC-123",
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: false,
        text: `
          <html><body>
            <h1>ABC-123 controller</h1>
            <section hidden>
              Rated current: 16 A
              Protection rating: IP67
              <a href="/downloads/ABC-123-datasheet.pdf">Technical datasheet</a>
            </section>
            <button data-manual-url="/downloads/ABC-123-manual.pdf">Manual</button>
            <img alt="ABC-123 product image" data-src="/media/ABC-123-main.webp" srcset="/media/ABC-123-small.webp 400w, /media/ABC-123-large.webp 1200w">
          </body></html>
        `
      },
      {
        manufacturerId: "test",
        catalogNumber: "ABC-123",
        stage: "test-page-mining",
        method: "static-html",
        sourceType: "official-fallback"
      }
    );

    expect(mined.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated current", value: "16 A" }),
        expect.objectContaining({ name: "Protection rating", value: "IP67" })
      ])
    );
    expect(mined.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "datasheet", url: "https://example.test/downloads/ABC-123-datasheet.pdf" }),
        expect.objectContaining({ type: "manual", url: "https://example.test/downloads/ABC-123-manual.pdf" }),
        expect.objectContaining({ type: "image", url: "https://example.test/media/ABC-123-large.webp" })
      ])
    );
    expect(mined.record.signals).toEqual(expect.arrayContaining(["hidden-dom", "data-attributes", "lazy-images"]));
  });

  it("extracts product-like embedded JSON and catalog-near context", () => {
    const mined = minePage(
      {
        requestedUrl: "https://example.test/products/ABC-123",
        effectiveUrl: "https://example.test/products/ABC-123",
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: false,
        text: `
          <html><body>
            <div>
              ABC-123
              Product details
              Material: polycarbonate
              Dimensions: 120 x 80 x 55 mm
            </div>
            <script id="__NEXT_DATA__" type="application/json">
              {
                "props": {
                  "pageProps": {
                    "product": {
                      "catalogNumber": "ABC-123",
                      "technicalData": [
                        { "name": "Rated voltage", "value": "24 V DC" },
                        { "name": "Weight", "value": "0.42 kg" }
                      ],
                      "downloads": [{ "label": "Datasheet", "url": "/api/download/ABC-123.pdf" }]
                    }
                  }
                }
              }
            </script>
          </body></html>
        `
      },
      {
        manufacturerId: "test",
        catalogNumber: "ABC-123",
        stage: "test-page-mining",
        method: "static-html",
        sourceType: "official-fallback"
      }
    );

    expect(mined.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "24 V DC" }),
        expect.objectContaining({ value: "0.42 kg" }),
        expect.objectContaining({ name: "Material", value: "polycarbonate" })
      ])
    );
    expect(mined.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "datasheet", url: "https://example.test/api/download/ABC-123.pdf" })
      ])
    );
    expect(mined.record.signals).toEqual(expect.arrayContaining([
      "embedded-json",
      "json:script:#__NEXT_DATA__",
      "catalog-neighborhood"
    ]));
  });

  it("extracts escaped JSON from data attributes and JSON.parse strings", () => {
    const mined = minePage(
      {
        requestedUrl: "https://example.test/products/ABC-123",
        effectiveUrl: "https://example.test/products/ABC-123",
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: false,
        text: `
          <html><body>
            <div
              data-product-props='{"catalogNumber":"ABC-123","specifications":[{"name":"Protection rating","value":"IP69K"}],"assets":[{"label":"CAD STEP","url":"/cad/ABC-123.step"}]}'>
            </div>
            <script>
              window.__PRODUCT_STATE__ = JSON.parse("{\\"product\\":{\\"sku\\":\\"ABC-123\\",\\"technical\\":[{\\"label\\":\\"Rated current\\",\\"value\\":\\"8 A\\"}],\\"downloads\\":[{\\"label\\":\\"Manual\\",\\"url\\":\\"/manuals/ABC-123.pdf\\"}]}}");
            </script>
          </body></html>
        `
      },
      {
        manufacturerId: "test",
        catalogNumber: "ABC-123",
        stage: "test-page-mining",
        method: "static-html",
        sourceType: "official-fallback"
      }
    );

    expect(mined.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Protection rating", value: "IP69K" }),
        expect.objectContaining({ name: "Rated current", value: "8 A" })
      ])
    );
    expect(mined.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "cad", url: "https://example.test/cad/ABC-123.step" }),
        expect.objectContaining({ type: "manual", url: "https://example.test/manuals/ABC-123.pdf" })
      ])
    );
    expect(mined.record.signals).toContain("embedded-json");
  });

  it("mines the spec block around a later catalog-number occurrence, not just the first", () => {
    const mined = minePage(
      {
        requestedUrl: "https://example.test/products/ABC-123",
        effectiveUrl: "https://example.test/products/ABC-123",
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: false,
        // First occurrence is a breadcrumb with no specs; the real spec block sits next to a
        // second occurrence far enough away to fall outside the first window. Padding ensures
        // the two occurrences land in separate mining windows.
        text: `
          <html><body>
            <nav>Home / Catalog / ABC-123</nav>
            <div>${"Unrelated marketing copy. ".repeat(220)}</div>
            <div>
              Product ABC-123 technical data
              Rated voltage: 400 V AC
              Weight: 1.8 kg
            </div>
          </body></html>
        `
      },
      {
        manufacturerId: "test",
        catalogNumber: "ABC-123",
        stage: "test-page-mining",
        method: "static-html",
        sourceType: "official-fallback"
      }
    );

    expect(mined.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "400 V AC" }),
        expect.objectContaining({ name: "Weight", value: "1.8 kg" })
      ])
    );
    expect(mined.record.signals).toContain("catalog-neighborhood");
  });

  it("segments multilingual inline specifications through ontology labels", () => {
    const mined = minePage(
      {
        requestedUrl: "https://example.test/products/ABC-123",
        effectiveUrl: "https://example.test/products/ABC-123",
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: false,
        text: "<html><body>ABC-123 Bemessungsstrom: 16 A Bemessungsspannung: 230 V Werkstoff: Edelstahl Schutzart: IP67</body></html>"
      },
      { manufacturerId: "test", catalogNumber: "ABC-123", stage: "test-page-mining", method: "static-html" }
    );

    expect(mined.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Bemessungsstrom", value: "16 A" }),
      expect.objectContaining({ name: "Bemessungsspannung", value: "230 V" }),
      expect.objectContaining({ name: "Werkstoff", value: "Edelstahl" }),
      expect.objectContaining({ name: "Schutzart", value: "IP67" })
    ]));
  });

  it("raises a method's element cap when a learned 'capped:' signal is supplied (Phase C1)", () => {
    // 260 hidden pairs exceed the base hidden-dom cap of 250.
    const hidden = Array.from({ length: 260 }, (_, i) => `<div hidden>Weight: ${i} kg</div>`).join("\n");
    const fetched = {
      requestedUrl: "https://example.test/p/X",
      effectiveUrl: "https://example.test/p/X",
      statusCode: 200,
      contentType: "text/html",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      fromCache: false,
      text: `<html><body>${hidden}</body></html>`
    };
    const base = { manufacturerId: "test", catalogNumber: "X", stage: "t", method: "static-html" as const };

    // Without the learned hint, the page is truncated at the base cap and flags "capped:hidden-dom".
    expect(minePage(fetched, base).record.signals).toContain("capped:hidden-dom");
    // With a previously-learned "capped:hidden-dom" signal, the cap is raised and truncation stops.
    expect(minePage(fetched, { ...base, learnedPatterns: ["capped:hidden-dom"] }).record.signals).not.toContain(
      "capped:hidden-dom"
    );
  });

  it("replays a learned stable table-row selector before the generic sweep", () => {
    const fetched = {
      requestedUrl: "https://example.test/p/X",
      effectiveUrl: "https://example.test/p/X",
      statusCode: 200,
      contentType: "text/html",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      fromCache: false,
      text: "<table><tr class='product-spec-row'><th>Rated voltage</th><td>24 V DC</td></tr></table>"
    };
    const mined = minePage(fetched, {
      manufacturerId: "test",
      catalogNumber: "X",
      stage: "learned-replay",
      method: "learned-extractor",
      learnedPatterns: ["css:table-row:tr.product-spec-row"]
    });

    expect(mined.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "Learned Table", name: "Rated voltage", value: "24 V DC" })
    ]));
    expect(mined.record.signals).toContain("replayed:css:table-row:tr.product-spec-row");
  });

  it("replays a learned comparison-table header column without leaking a sibling variant", () => {
    const fetched = {
      requestedUrl: "https://example.test/p/SKU-B",
      effectiveUrl: "https://example.test/p/SKU-B",
      statusCode: 200,
      contentType: "text/html",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      fromCache: false,
      text: `<table id="product-specs"><thead><tr><th>Property</th><th>SKU-A</th><th>SKU-B</th></tr></thead>
        <tbody><tr><th>Rated voltage [V]</th><td>24 DC</td><td>230 AC</td></tr></tbody></table>`
    };
    const mined = minePage(fetched, {
      manufacturerId: "test",
      catalogNumber: "SKU-B",
      stage: "learned-replay",
      method: "learned-extractor",
      learnedPatterns: ["html-table:header-column:table#product-specs:SKU-B"]
    });

    expect(mined.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "Learned HTML Table", name: "Rated voltage [V]", value: "230 V AC" })
    ]));
    expect(mined.attributes.some((attribute) => /24 DC/.test(attribute.value))).toBe(false);
    expect(mined.record.signals).toContain("replayed:html-table:header-column:table#product-specs:SKU-B");
  });

  it("replays a learned stable JSON script id through the same deterministic reader", () => {
    const fetched = {
      requestedUrl: "https://example.test/p/X",
      effectiveUrl: "https://example.test/p/X",
      statusCode: 200,
      contentType: "text/html",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      fromCache: false,
      text: `<script id="product-payload" type="application/json">
        {"product":{"sku":"X","technicalData":[{"name":"Rated current","value":"6 A"}]}}
      </script>`
    };
    const mined = minePage(fetched, {
      manufacturerId: "test",
      catalogNumber: "X",
      stage: "learned-replay",
      method: "learned-extractor",
      learnedPatterns: ["json:script:#product-payload"]
    });

    expect(mined.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "Learned JSON", name: "Rated current", value: "6 A" })
    ]));
    expect(mined.record.signals).toContain("replayed:json:script:#product-payload");
    expect(minePage(fetched, {
      manufacturerId: "test",
      catalogNumber: "X",
      stage: "unsafe-replay",
      method: "learned-extractor",
      learnedPatterns: ["json:script:script[data-anything]"]
    }).record.signals).not.toContain("replayed:json:script:script[data-anything]");
  });
});
