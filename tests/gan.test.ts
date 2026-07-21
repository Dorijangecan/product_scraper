import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { ganterDocuments, parseGanterProductPage } from "../src/server/scrapers/gan.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";

// Trimmed but structurally faithful excerpt of a real Ganter product page
// (e.g. .../GN-6284-Cabinet-U-Handles-Plastic-...-with-Cable). Includes the two quirks the parser
// has to survive: (1) every PDF <a class="cta--pdf"> nests an inline SVG icon whose own <style> tag
// leaks CSS text into cheerio's .text(); (2) the "Specification" block ends with a <br>-less
// self-labeled paragraph ("Operating temperature ...") that must NOT be read as the product Material.
const GAN_PRODUCT_FIXTURE = `
<html><body>
<nav class="breadcrumbs"><span itemprop="name">Handles</span><span itemprop="name">Cabinet U-Handles</span><span itemprop="name">GN 6284</span></nav>
<h1><span class="product-name__id">GN 6284</span> <span class="product-name__label">Cabinet U-Handles</span></h1>

<div class="product-description__content" itemprop="description">
  <p>Cabinet U-handles GN 6284 have a button and RGB LED lighting.</p>
  <h3>Specification</h3>
  <p><strong>Handle</strong><br>Plastic, Polyamide (PA)</p>
  <p>Operating temperature -20 &deg;C to +50 &deg;C</p>
  <div></div>
  <p>RoHS</p>
</div>

<div id="zusatz-info">
  <details><summary>Weight: 0,410 kg</summary></details>
  <details><summary>RoHS: Yes</summary></details>
  <details><summary>Customs tariff number:</summary><div class="toggle__unit">85365007</div></details>
</div>

<a class="cta--pdf" href="https://live-katalog.ganternorm.com/pdf/ganter/en/6284.pdf?dispositiontype=attachment"><svg><style>.cls-1{fill:#4e4e4d;}</style></svg>Standard sheet GN 6284</a>
<a class="cta--pdf" href="https://live-katalog.ganternorm.com/pdf/ganter/en/bt-6284.pdf?dispositiontype=attachment"><svg><style>.cls-2{fill:#000;}</style></svg>Operating instruction GN 6284</a>
<a class="cta--pdf" href="https://live-katalog.ganternorm.com/pdf/ganter/en/kunststoffe.pdf?dispositiontype=attachment"><svg><style>.cls-3{fill:#fff;}</style></svg>Plastic Characteristics</a>

<h3 class="icon-globe">Language</h3>
<ul>
  <li><a class="lang-selector" href="https://www.ganternorm.com/de/produkte/1.2-Bedienen/Buegelgriffe/GN-6284-Buegelgriffe-Kunststoff-mit-Kabel">Deutsch</a></li>
  <li><a class="lang-selector" href="https://www.ganternorm.com/fr/produits/1.2-Actionnement/GN-6284">Fran&ccedil;ais</a></li>
  <li><a class="lang-selector" href="https://www.elesa-ganter.at">&Ouml;sterreich</a></li>
</ul>
</body></html>
`;

function fetched(text: string, url = "https://www.ganternorm.com/en/products/x/GN-6284"): FetchedText {
  return { text, effectiveUrl: url, fetchedAt: "2026-07-21T00:00:00.000Z", statusCode: 200, fromCache: false } as FetchedText;
}

describe("Ganter Norm documents", () => {
  const $ = cheerio.load(GAN_PRODUCT_FIXTURE);
  const docs = ganterDocuments($, "https://www.ganternorm.com/en/products/x/GN-6284");

  it("classifies the standard sheet as a datasheet, operating instruction as a manual, characteristics as other", () => {
    const byUrlType = Object.fromEntries(docs.filter((d) => d.type !== "image").map((d) => [d.url.replace(/\?.*$/, ""), d.type]));
    expect(byUrlType["https://live-katalog.ganternorm.com/pdf/ganter/en/6284.pdf"]).toBe("datasheet");
    expect(byUrlType["https://live-katalog.ganternorm.com/pdf/ganter/en/bt-6284.pdf"]).toBe("manual");
    expect(byUrlType["https://live-katalog.ganternorm.com/pdf/ganter/en/kunststoffe.pdf"]).toBe("other");
  });

  it("strips the inline SVG <style> CSS from the link label", () => {
    const datasheet = docs.find((d) => d.type === "datasheet");
    expect(datasheet?.label).toBe("Standard sheet GN 6284");
    expect(datasheet?.label).not.toContain("fill");
  });

  it("marks every PDF non-enrichable so the multi-variant/multi-language catalog is never mined for attributes", () => {
    // The link is kept and downloadable; only attribute extraction is disabled. Ganter's PDFs are
    // family-wide print catalogs whose extraction corrupts the clean web-page facts.
    for (const doc of docs.filter((d) => /\.pdf/i.test(d.url))) {
      expect(doc.enrichable).toBe(false);
    }
  });
});

describe("Ganter Norm specification parsing", () => {
  const result = parseGanterProductPage("GN 6284-180-T-1-KU-5", fetched(GAN_PRODUCT_FIXTURE), cheerio.load(GAN_PRODUCT_FIXTURE));

  it("reads the br-less operating-temperature paragraph as its own fact, not as the product Material", () => {
    const temp = result.attributes.find((a) => /operating temperature/i.test(a.name));
    expect(temp?.value).toMatch(/-20\s*°C\s*to\s*\+50\s*°C/);
    const materialWithTemp = result.attributes.find((a) => a.name === "Material" && /temperature/i.test(a.value));
    expect(materialWithTemp).toBeUndefined();
    // The genuine material line is still captured.
    expect(result.attributes.some((a) => a.name === "Handle" && /Polyamide/.test(a.value))).toBe(true);
  });

  it("normalizes the operating temperature range from the self-labeled paragraph", () => {
    expect(result.normalized.operatingTemperatureMin).toBe("-20");
    expect(result.normalized.operatingTemperatureMax).toBe("50");
  });

  it("reads the German product URL from the page language switcher (slug is fully localized, not derivable)", () => {
    expect(result.localizedUrls?.en).toBe("https://www.ganternorm.com/en/products/x/GN-6284");
    expect(result.localizedUrls?.de).toBe(
      "https://www.ganternorm.com/de/produkte/1.2-Bedienen/Buegelgriffe/GN-6284-Buegelgriffe-Kunststoff-mit-Kabel"
    );
  });

  it("ignores non-German and partner-domain language-switcher links", () => {
    const de = result.localizedUrls?.de ?? "";
    expect(de).not.toMatch(/\/fr\//);
    expect(de).not.toMatch(/elesa-ganter/);
  });
});

describe("Ganter Norm dimension synthesis", () => {
  // A single-variant "Article options / Table" (Ganter Geometry) grid with classic drawing-symbol
  // columns plus a configuration column that must be excluded from normalized dimensions.
  const FIXTURE = `
<html><body>
<h1><span class="product-name__id">GN 422</span> <span class="product-name__label">Cabinet U-Handles</span></h1>
<div id="product-table">
  <table class="priority-table">
    <thead><tr><th>b</th><th>d</th><th>h</th><th>l1</th><th>Connection type</th></tr></thead>
    <tbody>
      <tr class="priority-table__filters"><td><select></select></td><td></td><td></td><td></td><td></td></tr>
      <tr><td>33</td><td>M 6</td><td>44</td><td>117</td><td>K2</td></tr>
    </tbody>
  </table>
</div>
</body></html>`;

  it("fills normalized.dimensions from the resolved single row, keeping drawing symbols and dropping config columns", () => {
    const $ = cheerio.load(FIXTURE);
    const r = parseGanterProductPage("GN 422-33-TK-LK-K2-SW", fetched(FIXTURE), $);
    expect(r.normalized.dimensions).toBe("b 33, d M 6, h 44, l1 117");
    expect(r.normalized.dimensions).not.toContain("Connection type");
    expect(r.normalized.dimensions).not.toContain("K2");
  });
});
