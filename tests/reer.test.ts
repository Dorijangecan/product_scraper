import { describe, expect, it } from "vitest";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ReerConnector, reerProductPageMatches, selectExactReerApiItem } from "../src/server/scrapers/reer.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";

const CATALOG_NUMBERS = [
  "1310000", "1310002", "1310011", "1310013", "1134603", "1134605", "1390650", "1390651",
  "1390800", "1390952", "1250911", "1070007", "1100000", "1100172", "1291012", "1295016", "1100103"
];

describe("ReeR connector", () => {
  it("is registered with the requested manufacturer identity", () => {
    expect(getManufacturerConfig("reer")).toMatchObject({
      id: "reer",
      canonicalName: "ReeR Safety",
      shortName: "REER",
      homepageUrl: "https://www.reersafety.com/en/"
    });
  });

  it("selects exact REST results for every supplied test catalog number", () => {
    for (const catalogNumber of CATALOG_NUMBERS) {
      const result = selectExactReerApiItem(JSON.stringify([
        { link: `https://www.reersafety.com/en/product/example-${catalogNumber}/`, slug: `example-${catalogNumber}`, title: { rendered: "Example" } },
        { link: `https://www.reersafety.com/en/product/related-${catalogNumber}0/`, slug: `related-${catalogNumber}0`, title: { rendered: "Related" } }
      ]), catalogNumber);
      expect(result?.link).toContain(`-${catalogNumber}/`);
    }
  });

  it("rejects a sibling product page even when the sibling page mentions the requested number", () => {
    expect(reerProductPageMatches({
      effectiveUrl: "https://www.reersafety.com/en/product/eos4-151-a-1310000/",
      text: "This page also references 1310002 in a related product list."
    }, "1310002")).toBe(false);
  });

  it("marks an authoritative REST miss as terminal so fallback crawling is skipped", async () => {
    const manufacturer = getManufacturerConfig("reer")!;
    const result = await new ReerConnector().scrape("does-not-exist", {
      manufacturer,
      runDir: "",
      documentsDir: "",
      http: { fetchText: async (url: string) => ({ requestedUrl: url, effectiveUrl: url, statusCode: 200, contentType: "application/json", text: "[]", fetchedAt: new Date().toISOString(), fromCache: false }) } as never,
      downloadDocument: async (document) => document,
      fallback: { scrape: async () => undefined }
    } as ScrapeContext);

    expect(result.status).toBe("failed");
    expect(result.diagnostics?.terminal).toEqual({ reason: "official-catalog-not-found", skipNetworkFallback: true });
  });

  it("resolves the canonical page through the REST endpoint and parses official HTML", async () => {
    const catalogNumber = "1310000";
    const apiUrl = "https://www.reersafety.com/wp-json/wp/v2/product?search=1310000&per_page=20&_fields=link,slug,title,content";
    const productUrl = "https://www.reersafety.com/en/product/eos4-151-a-1310000/";
    const html = `<!doctype html><html><head><title>EOS4 151 A | ReeR</title><meta name="description" content="Visit ReeR Safety website and contact us"><meta property="og:image" content="https://www.reersafety.com/reer-assets/eos4-151-a-1310000.jpg"></head><body>
      <div class="product-short-description"><p>Finger Detection Safety Light Curtain with Automatic Restart</p></div>
      <h1>EOS4 151 A</h1><p>Finger Detection Safety Light Curtain with Automatic Restart</p><table>
      <tr><th>Catalog number</th><td>1310000</td></tr><tr><th>Safety level</th><td>Type 4 - PL e</td></tr>
      <tr><th>Protected height (mm)</th><td>160</td></tr><tr><th>Resolution (mm)</th><td>14</td></tr>
      <tr><th>Max. range (m)</th><td>6</td></tr></table><img src="https://www.reersafety.com/reer-assets/eos4-151-a-1310000-schematic.png" alt="wiring schematic"><img src="https://www.reersafety.com/reer-assets/eos4-151-a-1310000-product.png" alt="device product"><a href="https://www.reersafety.com/reer-assets/eos4-151-a-1310000.pdf">Download PDF datasheet</a>
    </body></html>`;
    const fetchText = async (url: string) => ({
      requestedUrl: url, effectiveUrl: url, statusCode: 200, contentType: url === apiUrl ? "application/json" : "text/html",
      text: url === apiUrl ? JSON.stringify([{ link: productUrl, slug: "eos4-151-a-1310000", title: { rendered: "EOS4 151 A" } }]) : html,
      fetchedAt: new Date().toISOString(), fromCache: false
    });
    const manufacturer = getManufacturerConfig("reer")!;
    const result = await new ReerConnector().scrape(catalogNumber, {
      manufacturer, runDir: "", documentsDir: "", http: { fetchText } as never,
      downloadDocument: async (document) => document, fallback: { scrape: async () => undefined }
    } as ScrapeContext);

    expect(result.productUrl).toBe(productUrl);
    expect(result.description).toBe("Finger Detection Safety Light Curtain with Automatic Restart");
    expect(result.attributes.some((attribute) => attribute.value === catalogNumber)).toBe(true);
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "Description long", value: "Finger Detection Safety Light Curtain with Automatic Restart", sourceType: "official" }));
    expect(result.documents.some((document) => document.type === "image")).toBe(true);
    expect(result.documents.filter((document) => document.type === "image")).toHaveLength(1);
    expect(result.documents.some((document) => document.type === "image" && /schematic/i.test(document.url))).toBe(false);
    expect(result.documents.find((document) => document.type === "image")?.url).toContain("1310000-product.png");
    expect(result.diagnostics?.attemptedUrls).toEqual([apiUrl, productUrl]);
  });
});
