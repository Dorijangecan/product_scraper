import { describe, expect, it } from "vitest";
import {
  deriveEatonCbeRecord,
  dedupeEatonLocalizedSkuPdfs,
  extractEatonSearchDocuments,
  parseEatonCbeCatalogRecords,
  parseEatonProductPage
} from "../src/server/scrapers/eaton.js";

// One representative row per E6-catalog family, tab-delimited exactly as pdf-parse emits them.
const CATALOG = [
  "Rated current\tPart number\tCatalog Number\tUnit", // header: no CBE token, must be skipped
  "40\t1\tEIS-40/1\tCBE04417\t12",
  "40\t3\tEIS-40/3\tCBE04419\t4",
  "1\tE6-1/1/B\tCBE03319\t12",
  "1/0.03\tELD6-1/1N/C/003\tCBE03637\t6",
  "6/0.03\tED6-6/1N/C/003\tCBE03553\t6",
  "E6,ED6,ELD6/1NO1NC\tZ-AHK\tCBE04437\t12"
].join("\n");

describe("Eaton E6 catalog parser", () => {
  it("captures every family, not just EIS/ED6", () => {
    const records = parseEatonCbeCatalogRecords(CATALOG);
    expect(records.size).toBe(6);
  });

  it("derives structured fields from the source row and model code", () => {
    const records = parseEatonCbeCatalogRecords(CATALOG);
    expect(records.get("CBE04417")).toMatchObject({ partNumber: "EIS-40/1", ratedCurrent: "40", poles: "1" });
    expect(records.get("CBE03319")).toMatchObject({
      partNumber: "E6-1/1/B",
      ratedCurrent: "1",
      poles: "1",
      releaseCharacteristic: "B"
    });
    expect(records.get("CBE03637")).toMatchObject({
      partNumber: "ELD6-1/1N/C/003",
      poles: "2",
      residualCurrent: "0.03",
      releaseCharacteristic: "C"
    });
    expect(records.get("CBE03553")).toMatchObject({ partNumber: "ED6-6/1N/C/003", residualCurrent: "0.03" });
    expect(records.get("CBE04437")).toMatchObject({ partNumber: "Z-AHK", productName: "E6,ED6,ELD6/1NO1NC" });
  });

  it("does not invent family-level technical values that are not in the catalog row", () => {
    const eis = deriveEatonCbeRecord("CBE04417", "EIS-40/1", ["40", "1"], "12");
    expect(eis).toMatchObject({
      articleNumber: "CBE04417",
      partNumber: "EIS-40/1",
      ratedCurrent: "40",
      poles: "1",
      unitPerPackage: "12"
    });
    expect(eis).not.toHaveProperty("productFamily");
    expect(eis).not.toHaveProperty("productBase");
    expect(eis).not.toHaveProperty("eclassCode");
    expect(eis).not.toHaveProperty("ratedVoltage");
    expect(eis).not.toHaveProperty("ratedInsulationVoltage");
    expect(eis).not.toHaveProperty("weightKg");
    expect(eis).not.toHaveProperty("depthMm");
    expect(eis).not.toHaveProperty("widthMm");
    expect(eis).not.toHaveProperty("heightMm");
    expect(eis).not.toHaveProperty("operatingTemperature");
    expect(eis).not.toHaveProperty("degreeOfProtection");
    expect(eis).not.toHaveProperty("connectionType");

    const ed6 = deriveEatonCbeRecord("CBE03553", "ED6-6/1N/C/003", ["6/0.03"], "6");
    expect(ed6).toMatchObject({
      articleNumber: "CBE03553",
      partNumber: "ED6-6/1N/C/003",
      ratedCurrent: "6",
      poles: "2",
      releaseCharacteristic: "C",
      residualCurrent: "0.03",
      unitPerPackage: "6"
    });
    expect(ed6).not.toHaveProperty("productFamily");
    expect(ed6).not.toHaveProperty("productBase");
    expect(ed6).not.toHaveProperty("eclassCode");
    expect(ed6).not.toHaveProperty("ratedVoltage");
    expect(ed6).not.toHaveProperty("weightKg");
    expect(ed6).not.toHaveProperty("degreeOfProtection");
  });
});

describe("Eaton MCCB recovery", () => {
  it("recovers rated current from an official Power Defense description when the table omits it", () => {
    const sourceUrl = "https://www.eaton.com/us/en-us/skuPage.PDG12C0030TFFS.html";
    const result = parseEatonProductPage(
      "PDG12C0030TFFS",
      {
        requestedUrl: sourceUrl,
        effectiveUrl: sourceUrl,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: new Date().toISOString(),
        fromCache: false,
        text: `
          <html>
            <head>
              <title>PDG12C0030TFFS | Eaton Power Defense molded case circuit breaker</title>
              <meta name="description" content="PDG1, 2P, 30A, 18kA/480V, T-M">
            </head>
            <body>
              <section class="product-specification-item">
                <h2>General specifications</h2>
                <table>
                  <tr class="specification-row"><td class="specification-title"><strong>Catalog Number</strong></td><td class="specification-value">PDG12C0030TFFS</td></tr>
                  <tr class="specification-row"><td class="specification-title"><strong>Product Name</strong></td><td class="specification-value">Eaton Power Defense molded case circuit breaker</td></tr>
                  <tr class="specification-row"><td class="specification-title"><strong>Product Type</strong></td><td class="specification-value">Molded case circuit breaker</td></tr>
                  <tr class="specification-row"><td class="specification-title"><strong>Product Weight</strong></td><td class="specification-value">907 g</td></tr>
                  <tr class="specification-row"><td class="specification-title"><strong>Product Length/Depth</strong></td><td class="specification-value">90 mm</td></tr>
                  <tr class="specification-row"><td class="specification-title"><strong>Product Height</strong></td><td class="specification-value">150 mm</td></tr>
                  <tr class="specification-row"><td class="specification-title"><strong>Product Width</strong></td><td class="specification-value">65 mm</td></tr>
                  <tr class="specification-row"><td class="specification-title"><strong>Certifications</strong></td><td class="specification-value">IEC 60947-2</td></tr>
                </table>
              </section>
            </body>
          </html>
        `
      },
      sourceUrl
    );

    expect(result.status).toBe("found");
    expect(result.normalized.current).toBe("30 A");
    expect(result.normalized.weight).toContain("907 g");
    expect(result.normalized.dimensions).toBe("150 x 65 x 90 mm");
  });

  it("keeps the exact SKU image and generated specification sheet from Eaton search JSON", () => {
    const searchUrl = "https://www.eaton.com/content/eaton/us/en-us/site-search/results.json";
    const documents = extractEatonSearchDocuments(
      JSON.stringify({
        siteSearchResults: [{
          title: "PDG13C0125TFFJ",
          description: "Eaton Power Defense molded case circuit breaker",
          contentType: "sku",
          completeUrl: "https://www.eaton.com/us/en-us/skuPage.PDG13C0125TFFJ.html",
          image: "https://www.eaton.com/mdmfiles/PDM72253818/PDG13K0125TFFN_C/110x110_96dpi",
          desktopRendition: "https://www.eaton.com/mdmfiles/PDM72253818/PDG13K0125TFFN_C/110x110_96dpi"
        }]
      }),
      searchUrl,
      "PDG13C0125TFFJ"
    );

    const image = documents.find((document) => document.type === "image");
    expect(image).toMatchObject({
      url: "https://dynamicmedia.eaton.com/is/image/eaton/PDG13K0125TFFN_C?wid=500&hei=500",
      sourceUrl: "https://www.eaton.com/us/en-us/skuPage.PDG13C0125TFFJ.html",
      stage: "search-document"
    });
    expect(image?.candidateUrls).toContain("https://www.eaton.com/mdmfiles/PDM72253818/PDG13K0125TFFN_C/110x110_96dpi");
    expect(documents.some((document) => document.type === "datasheet" && /PDG13C0125TFFJ\.pdf$/i.test(document.url))).toBe(true);
  });

  it("reads physical measurements from JSON-LD QuantitativeValue objects", () => {
    const sourceUrl = "https://www.eaton.com/us/en-us/skuPage.PDG13C0125TFFN.html";
    const result = parseEatonProductPage(
      "PDG13C0125TFFN",
      {
        requestedUrl: sourceUrl,
        effectiveUrl: sourceUrl,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: new Date().toISOString(),
        fromCache: false,
        text: `<html><head><script type="application/ld+json">${JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Product",
          sku: "PDG13C0125TFFN",
          name: "Eaton Power Defense molded case circuit breaker",
          weight: { "@type": "QuantitativeValue", value: 1.36, unitCode: "KGM" },
          height: { "@type": "QuantitativeValue", value: 139.7, unitCode: "MMT" },
          width: { "@type": "QuantitativeValue", value: 76.2, unitCode: "MMT" },
          depth: { "@type": "QuantitativeValue", value: 76, unitCode: "MMT" }
        })}</script></head><body><h1>PDG13C0125TFFN</h1></body></html>`
      },
      sourceUrl
    );

    expect(result.status).toBe("found");
    expect(result.normalized.weight).toBe("1.36 kg");
    expect(result.normalized.dimensions).toBe("139.7 x 76.2 x 76 mm");
  });

  it("rejects lazy-loaded Eaton image assets that belong to a different catalog number", () => {
    const sourceUrl = "https://www.eaton.com/us/en-us/skuPage.PDG13C0125TFFJ.html";
    const result = parseEatonProductPage(
      "PDG13C0125TFFJ",
      {
        requestedUrl: sourceUrl,
        effectiveUrl: sourceUrl,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: new Date().toISOString(),
        fromCache: false,
        text: `<html><head><meta name="description" content="PDG13C0125TFFJ, 3P, 125A, 600V"><script type="application/ld+json">${JSON.stringify({
          "@type": "Product",
          sku: "PDG13C0125TFFJ",
          name: "Eaton Power Defense molded case circuit breaker"
        })}</script></head><body><img class="product-hero" alt="PDG13C0125TFFJ product" src="https://www.eaton.com/mdmfiles/placeholder/No_Image_Available/110x110_96dpi" data-src="https://www.eaton.com/mdmfiles/PDM72253818/PDG13K0125TFFN_C/110x110_96dpi"></body></html>`
      },
      sourceUrl
    );

    expect(result.documents.some((document) => document.type === "image" && /PDG13K0125TFFN_C/i.test(document.url))).toBe(false);
  });
});

describe("Eaton family-source evidence", () => {
  it("attaches the SP series publication only after an exact SP1 product page confirms the family", () => {
    const sourceUrl = "https://www.eaton.com/us/en-us/skuPage.SP1-240S.html";
    const result = parseEatonProductPage(
      "SP1-240S",
      {
        requestedUrl: sourceUrl,
        effectiveUrl: sourceUrl,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: new Date().toISOString(),
        fromCache: false,
        text: `<html><head><title>SP1-240S | Eaton SP1 surge protective device</title><meta name="description" content="Eaton SP1 surge protective device, 120/240V"><script type="application/ld+json">${JSON.stringify({ "@type": "Product", sku: "SP1-240S", name: "Eaton SP1 surge protective device" })}</script></head><body><section class="product-specification-item"><h2>General specifications</h2><table><tr class="specification-row"><td class="specification-title"><strong>Catalog Number</strong></td><td class="specification-value">SP1-240S</td></tr><tr class="specification-row"><td class="specification-title"><strong>Product Type</strong></td><td class="specification-value">Surge protective device</td></tr><tr class="specification-row"><td class="specification-title"><strong>Product Name</strong></td><td class="specification-value">Eaton SP1 surge protective device</td></tr><tr class="specification-row"><td class="specification-title"><strong>Product Family</strong></td><td class="specification-value">SP1 series</td></tr></table></section></body></html>`
      },
      sourceUrl
    );

    expect(result.documents.some((document) => document.type === "datasheet" && /eaton-sp-series-brochure-pa01005006e\.pdf/.test(document.url))).toBe(true);
  });

  it("recognizes an exact DS7 model code on its official Eaton catalog-number alias PDP", () => {
    const sourceUrl = "https://www.eaton.com/us/en-us/skuPage.134847.html";
    const result = parseEatonProductPage(
      "DS7-340SX004N0-N",
      {
        requestedUrl: sourceUrl,
        effectiveUrl: sourceUrl,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: new Date().toISOString(),
        fromCache: false,
        text: `<html><head><title>134847 | Eaton DS7 Soft starter</title><meta name="description" content="Eaton DS7 soft starter, DS7-340SX004N0-N, 4 A, 200 - 480 V AC, Us=24 V AC/DC"></head><body><section class="product-specification-item"><h2>General specifications</h2><table><tr class="specification-row"><td class="specification-title"><strong>Catalog Number</strong></td><td class="specification-value">134847</td></tr><tr class="specification-row"><td class="specification-title"><strong>Model Code</strong></td><td class="specification-value">DS7-340SX004N0-N</td></tr><tr class="specification-row"><td class="specification-title"><strong>Product Name</strong></td><td class="specification-value">Eaton DS7 Soft starter</td></tr><tr class="specification-row"><td class="specification-title"><strong>Product Type</strong></td><td class="specification-value">Soft starter</td></tr></table></section></body></html>`
      },
      sourceUrl
    );

    expect(result.status).toBe("found");
    expect(result.description).toContain("DS7-340SX004N0-N");
    expect(result.normalized.voltage).toContain("200...480 V");
  });

  it("deduplicates equivalent English Eaton SKU PDFs while preserving translated sources", () => {
    const documents = [
      { type: "datasheet" as const, label: "Eaton Specification Sheet", url: "https://www.eaton.com/de/de-de/skuPage.SP1-240S.pdf" },
      { type: "datasheet" as const, label: "Eaton Specification Sheet", url: "https://www.eaton.com/gb/en-gb/skuPage.SP1-240S.pdf" },
      { type: "datasheet" as const, label: "Eaton Specification Sheet", url: "https://www.eaton.com/us/en-us/skuPage.SP1-240S.pdf" },
      { type: "datasheet" as const, label: "Eaton SP1 series technical data brochure", url: "https://www.eaton.com/content/dam/eaton/products/eaton-sp-series-brochure.pdf" }
    ];

    expect(dedupeEatonLocalizedSkuPdfs(documents, "SP1-240S").map((document) => document.url)).toEqual([
      "https://www.eaton.com/de/de-de/skuPage.SP1-240S.pdf",
      "https://www.eaton.com/us/en-us/skuPage.SP1-240S.pdf",
      "https://www.eaton.com/content/dam/eaton/products/eaton-sp-series-brochure.pdf"
    ]);
  });
});
