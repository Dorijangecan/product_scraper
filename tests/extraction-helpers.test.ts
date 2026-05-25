import { describe, expect, it } from "vitest";
import { discoverProductLinks } from "../src/server/scrapers/link-discovery.js";
import { extractMarkerData } from "../src/server/scrapers/marker-extractor.js";

describe("marker extraction", () => {
  it("extracts legacy start/end rules as attributes and document URLs", () => {
    const html = `
      <script>Catalog Description","values":[{"text":"Mini contactor"}],"isInternal":false</script>
      <img src="/images/SCE-30EL2412SSLPPL.png">
    `;
    const result = extractMarkerData(
      html,
      [
        { name: "Catalog Description", start: 'Catalog Description","values":[{"text":"', end: '"}],"isInternal' },
        { name: "Product image", start: "/images/", end: ".png", documentType: "image", urlPrefix: "https://example.test/images/", urlSuffix: ".png" }
      ],
      "https://example.test/product"
    );

    expect(result.attributes).toContainEqual({
      group: "Marker Rules",
      name: "Catalog Description",
      value: "Mini contactor",
      sourceUrl: "https://example.test/product"
    });
    expect(result.documents[0]?.url).toBe("https://example.test/images/SCE-30EL2412SSLPPL.png");
  });
});

describe("product link discovery", () => {
  it("scores exact product links above unrelated navigation", () => {
    const html = `
      <a href="/support">Support</a>
      <article class="result">
        <a href="/en/products/BCC039H">BCC039H product detail</a>
      </article>
      <a href="/downloads/BCC039H.pdf">PDF</a>
    `;

    expect(discoverProductLinks(html, "https://www.balluff.com/en-gb/search?query=BCC039H", "BCC039H")[0]?.url).toBe(
      "https://www.balluff.com/en/products/BCC039H"
    );
  });

  it("uses canonical product URLs and strips Balluff configurator parameters", () => {
    const html = `
      <html><head>
        <link rel="canonical" href="https://www.balluff.com/de-de/products/BCC039P?pm=S-BCC+DE+SCU&pf=G1103&attrs[cal_pm_connection_sel_1][0]=18421822" />
      </head><body>
        <h1>BCC039P</h1>
        <a href="/de-de/products/BCC039P?pm=S-BCC+DE+SCU&pf=G1103&attrs[cal_pm_connection_sel_1][0]=18421822">BCC039P</a>
      </body></html>
    `;

    expect(discoverProductLinks(html, "https://www.balluff.com/de-de/search", "BCC039P")[0]?.url).toBe(
      "https://www.balluff.com/de-de/products/BCC039P"
    );
  });

  it("rejects wrong-product result links when exact catalog identity is absent", () => {
    const html = `
      <article class="result">
        <a href="/en/products/BCC039H">BCC039H product detail</a>
      </article>
      <article class="result">
        <a href="/en/products/BCC03A7">BCC03A7 product detail</a>
      </article>
    `;

    const candidates = discoverProductLinks(html, "https://www.balluff.com/en-gb/search?query=BCC039P", "BCC039P");
    expect(candidates.map((candidate) => candidate.url)).not.toContain("https://www.balluff.com/en/products/BCC039H");
    expect(candidates).toHaveLength(0);
  });
});
