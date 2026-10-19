import { describe, expect, it, vi } from "vitest";
import { FathConnector } from "../src/server/scrapers/fath.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";

const productUrl = "https://www.fath24.com/en/Adjustable-Leveling-Foot/098H501008";
const exactProductHtml = `<!doctype html>
<html><head>
  <link rel="canonical" href="${productUrl}">
  <meta property="og:title" content="Adjustable Leveling Foot | 098H501008">
</head><body>
  <h1>Adjustable Leveling Foot</h1>
  <div class="fath-product-description-main">To adjust the height of machine frames</div>
  <div class="fath-product-description-text"><b>Material:</b><br>Housing: Plastic PA<br><b>Color:</b><br>Black</div>
  <table><tbody>
    <tr class="properties-row"><th class="properties-label">Weight (g):</th><td class="properties-value">83.0</td></tr>
  </tbody></table>
  <table><thead><tr><th>Part #</th><th>H (mm)</th><th>M</th></tr></thead><tbody>
    <tr><td><a href="https://www.fath24.com/en/Adjustable-Leveling-Foot/098H501006">098H501006</a></td><td>35-55</td><td>M6</td></tr>
    <tr><td><a href="${productUrl}">098H501008</a><span>New</span></td><td>45-65</td><td>M8</td></tr>
  </tbody></table>
  <img src="https://www.fath24.com/media/69/5b/bf/1792371783/098h300606_p_3d.jpg">
</body></html>`;

describe("FATH Shopware connector", () => {
  it("parses the exact variant from direct HTML, keeps its label unit, and rejects a sibling image", async () => {
    const page: FetchedText = {
      requestedUrl: "https://www.fath24.com/en/search?search=098H501008",
      effectiveUrl: productUrl,
      statusCode: 200,
      contentType: "text/html",
      text: exactProductHtml,
      fetchedAt: new Date(0).toISOString(),
      fromCache: false
    };
    const fetchText = vi.fn(async () => page);
    const context = {
      http: { fetchText },
      manufacturer: { localizedUrlTemplates: [] }
    } as unknown as ScrapeContext;

    const result = await new FathConnector().scrape("098H501008", context);

    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(result.productUrl).toBe(productUrl);
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "M", value: "M8" }));
    expect(result.attributes).toContainEqual(expect.objectContaining({ name: "H (mm)", value: "45-65" }));
    expect(result.attributes.some((attribute) => attribute.value === "M6")).toBe(false);
    expect(result.normalized.weight).toContain("0.083 kg");
    expect(result.normalized.material).toContain("Plastic");
    expect(result.documents.some((document) => document.type === "image")).toBe(false);
  });

  it("reads Shopware strong field labels for workstation accessory materials", async () => {
    const url = "https://www.fath24.com/en/Tool-Tray-PARABOL-FX/6TM840NV12591S01";
    const page: FetchedText = {
      requestedUrl: "https://www.fath24.com/en/search?search=6TM840NV12591S01",
      effectiveUrl: url,
      statusCode: 200,
      contentType: "text/html",
      text: `<!doctype html><html><head><link rel="canonical" href="${url}"><meta property="og:title" content="Tool Tray PARABOL FX | 6TM840NV12591S01"></head><body>
        <h1>Tool Tray PARABOL FX</h1>
        <div class="fath-product-description-main">Tilt-adjustable in 5 ways</div>
        <div class="fath-product-description-text"><strong>Material:</strong><br>Tool tray: Plastic PA, glass ball reinforced<br><strong>Surface:</strong><br>Screw: Zinc plated</div>
        <div class="properties-row"><span class="properties-label">Weight (g):</span><span class="properties-value">226.0</span></div>
        <img src="https://www.fath24.com/media/6tm840nv12591s01_p_3d.jpg"></body></html>`,
      fetchedAt: new Date(0).toISOString(),
      fromCache: false
    };
    const context = {
      http: { fetchText: vi.fn(async () => page) },
      manufacturer: { localizedUrlTemplates: [] }
    } as unknown as ScrapeContext;

    const result = await new FathConnector().scrape("6TM840NV12591S01", context);

    expect(result.attributes).toContainEqual(expect.objectContaining({
      group: "FATH specifications",
      name: "Material",
      value: "Tool tray: Plastic PA, glass ball reinforced"
    }));
    expect(result.normalized.material).toContain("Plastic PA");
    expect(result.normalized.weight).toContain("0.226 kg");
  });

  it("keeps long multi-component material specifications instead of dropping them", async () => {
    const url = "https://www.fath24.com/en/Tool-Tray-PARABOL-FX/6TM840NV12591S01";
    const material = "Tool tray standard version: Plastic PA, glass ball reinforced Tool tray ESD electrostatical discharging version: Plastic PA, glass ball reinforced with carbon Tray inserts standard version: Plastic TPE, approximately 70 Shore A Tray inlay ESD electrostatical discharging version: Plastic TPE, approximately 80 Shore A, with carbon Spring: Spring steel SS313 Washer: Steel Screw: Steel Nut: Steel Centering piece: Plastic PA, glass fiber reinforced";
    const page: FetchedText = {
      requestedUrl: "https://www.fath24.com/en/search?search=6TM840NV12591S01",
      effectiveUrl: url,
      statusCode: 200,
      contentType: "text/html",
      text: `<!doctype html><html><head><link rel="canonical" href="${url}"><meta property="og:title" content="Tool Tray PARABOL FX | 6TM840NV12591S01"></head><body>
        <h1>Tool Tray PARABOL FX</h1><div class="fath-product-description-main">Tilt-adjustable in 5 ways</div>
        <div class="fath-product-description-text"><b>Material:</b><br>${material}</div>
        <div class="properties-row"><span class="properties-label">Weight (g):</span><span class="properties-value">226.0</span></div>
        <img src="https://www.fath24.com/media/6tm840nv12591s01_p_3d.jpg"></body></html>`,
      fetchedAt: new Date(0).toISOString(),
      fromCache: false
    };
    const context = {
      http: { fetchText: vi.fn(async () => page) },
      manufacturer: { localizedUrlTemplates: [] }
    } as unknown as ScrapeContext;

    const result = await new FathConnector().scrape("6TM840NV12591S01", context);

    expect(material.length).toBeGreaterThan(240);
    expect(result.normalized.material).toContain("Tray inserts standard version: Plastic TPE");
    expect(result.attributes.find((attribute) => attribute.name === "Material")?.value.length).toBeGreaterThan(240);
  });
});
