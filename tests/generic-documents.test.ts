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

  it("keeps document download links that rely on labels instead of .pdf extensions", () => {
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
          <html><body>
            <h1>ABC-123 safety relay</h1>
            <a href="/global/en/download/dam/ABC123_TECHDATA">ABC-123 technical datasheet PDF</a>
            <a href="/files?p_Doc_Ref=ABC123_INSTALL&p_enDocType=Instruction+Sheet">ABC-123 installation manual</a>
          </body></html>
        `
      },
      "official-fallback",
      "generic-test"
    );

    expect(result.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "datasheet",
          url: "https://example.test/global/en/download/dam/ABC123_TECHDATA"
        }),
        expect.objectContaining({
          type: "manual",
          url: "https://example.test/files?p_Doc_Ref=ABC123_INSTALL&p_enDocType=Instruction+Sheet"
        })
      ])
    );
  });

  it("deduplicates equivalent PDF links with tracking parameters or reordered query strings", () => {
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
          <html><body>
            <h1>ABC-123 controller</h1>
            <a href="/download?documentId=spec123&format=pdf&utm_source=search">ABC-123 datasheet</a>
            <a href="/download?format=pdf&documentId=spec123">ABC-123 technical datasheet</a>
          </body></html>
        `
      },
      "official-fallback",
      "generic-test"
    );

    expect(result.documents.filter((doc) => /spec123/.test(doc.url))).toHaveLength(1);
  });

  it("records document discovery decisions for accepted and rejected anchor links", () => {
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
          <html><body>
            <h1>ABC-123 controller</h1>
            <a href="../docs/ABC-123-datasheet.pdf">ABC-123 datasheet</a>
            <a href="/legal/privacy.pdf">Privacy policy</a>
            <a href="/about">About us</a>
          </body></html>
        `
      },
      "official-fallback",
      "generic-test"
    );

    expect(result.diagnostics?.documentCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://example.test/docs/ABC-123-datasheet.pdf",
          status: "accepted",
          reason: "Recognized product document link."
        }),
        expect.objectContaining({
          url: "https://example.test/legal/privacy.pdf",
          status: "rejected",
          reason: "Rejected unrelated policy/legal document."
        }),
        expect.objectContaining({
          url: "https://example.test/about",
          status: "rejected",
          reason: "Link did not look like a product document."
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
