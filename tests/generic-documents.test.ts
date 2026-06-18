import { describe, expect, it } from "vitest";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";

describe("generic document discovery", () => {
  it("extracts datasheets and manuals hidden in data attributes and embedded JSON", () => {
    const result = parseGenericProductPage(
      "generic",
      "ABC-123",
      {
        requestedUrl: "https://example.test/products/ABC-123",
        effectiveUrl: "https://example.test/products/ABC-123",
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: false,
        text: `
          <html>
            <body>
              <h1>ABC-123 compact controller</h1>
              <section class="downloads">
                <button data-datasheet-url="/api/document?documentId=spec123&format=pdf">Technical datasheet ABC-123</button>
              </section>
              <script>
                window.__PRODUCT_DATA__ = {
                  "catalogNumber": "ABC-123",
                  "manualUrl": "/downloads/install?id=ABC-123&format=pdf",
                  "manualLabel": "Installation manual"
                };
              </script>
            </body>
          </html>
        `
      },
      "official-fallback",
      "generic-test"
    );

    expect(result.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "datasheet",
          url: "https://example.test/api/document?documentId=spec123&format=pdf"
        }),
        expect.objectContaining({
          type: "manual",
          url: "https://example.test/downloads/install?id=ABC-123&format=pdf"
        })
      ])
    );
  });

  it("extracts important specs from semantic DOM attributes and JSON value/unit objects", () => {
    const result = parseGenericProductPage(
      "generic",
      "ABC-123",
      {
        requestedUrl: "https://example.test/products/ABC-123",
        effectiveUrl: "https://example.test/products/ABC-123",
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: false,
        text: `
          <html>
            <body>
              <h1>ABC-123 power module</h1>
              <section id="technical-data">
                <h2>Technical data</h2>
                <div data-spec-name="Rated voltage" data-spec-value="24 V DC"></div>
                <div data-label="Enclosure material" data-value="polycarbonate"></div>
                <span itemprop="weight" content="1.2 kg"></span>
              </section>
              <script type="application/json">
                {
                  "catalogNumber": "ABC-123",
                  "specifications": [
                    { "name": "Rated current", "value": "2.5", "unit": "A" },
                    { "title": "Datasheet", "documentType": "Technical datasheet", "url": "/docs/abc-123?documentId=abc123&format=pdf" }
                  ]
                }
              </script>
            </body>
          </html>
        `
      },
      "official-fallback",
      "generic-test"
    );

    expect(result.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "24 V DC" }),
        expect.objectContaining({ name: "Enclosure material", value: "polycarbonate" }),
        expect.objectContaining({ name: "Weight", value: "1.2 kg" }),
        expect.objectContaining({ name: "Rated current", value: "2.5 A" })
      ])
    );
    expect(result.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "datasheet",
          label: expect.stringContaining("Datasheet"),
          url: "https://example.test/docs/abc-123?documentId=abc123&format=pdf"
        })
      ])
    );
    expect(result.normalized.voltage).toBe("24 V DC");
    expect(result.normalized.current).toBe("2.5 A");
    expect(result.normalized.material).toBe("polycarbonate");
  });
});
