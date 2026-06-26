import { describe, expect, it } from "vitest";
import { minePage } from "../src/server/scrapers/page-mining.js";

describe("adaptive page mining", () => {
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
    expect(mined.record.signals).toEqual(expect.arrayContaining(["embedded-json", "catalog-neighborhood"]));
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
});
