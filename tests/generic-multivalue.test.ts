import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";

describe("generic multi-value HTML leaves", () => {
  it("keeps independently rendered Schmersal protection and humidity values delimited", async () => {
    const url = "https://products.schmersal.com/en_GB/azm190-1101rk-230vac-131029963";
    const text = await readFile("fixtures/schmersal-131029963-page/page.html", "utf8");
    const result = parseGenericProductPage(
      "schmersal",
      "131029963",
      {
        requestedUrl: url,
        effectiveUrl: url,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: true,
        text
      },
      "official"
    );

    expect(result.normalized.protection).toBe("IP67; IP65");
    expect(result.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "IP Degree of protection", value: "IP67; IP65" }),
        expect.objectContaining({ name: "Note (Relative humidity)", value: "non-condensing; non-icing" })
      ])
    );
    expect(result.attributes.map((attribute) => String(attribute.value))).not.toEqual(
      expect.arrayContaining(["IP65IP67", "non-condensingnon-icing"])
    );
  }, 15_000);

  it("does not turn adjacent Schmersal responsive rows into one cross-row attribute", async () => {
    const url = "https://products.schmersal.com/en_GB/azm-161sk-1212rk-024-101164207";
    const text = await readFile("fixtures/schmersal-101164207-page/page.html", "utf8");
    const result = parseGenericProductPage(
      "schmersal",
      "101164207",
      {
        requestedUrl: url,
        effectiveUrl: url,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: true,
        text
      },
      "official"
    );

    expect(result.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated insulation voltage Ui", value: "250 VAC" }),
        expect.objectContaining({ name: "Rated impulse withstand voltage Uimp", value: "4 kV" }),
        expect.objectContaining({ name: "Certificates", value: expect.stringContaining("CCC") })
      ])
    );
    expect(result.attributes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Rated insulation voltage Ui250 VAC",
          value: "Rated impulse withstand voltage Uimp; 4kV"
        })
      ])
    );
    expect(result.attributes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Approvals - Standards", value: "CertificatesCCCcULusIFA" })
      ])
    );
  }, 15_000);

  it("does not export sibling catalog codes as HTML property labels", async () => {
    const url = "https://www.fath24.com/en/Main-Power-Cable-GST18i3-for-Module-F-Line/6SAME4J316B.4000";
    const text = await readFile("fixtures/fath-6SAME4J316B-4000-page/page.html", "utf8");
    const result = parseGenericProductPage(
      "fath",
      "6SAME4J316B.4000",
      {
        requestedUrl: url,
        effectiveUrl: url,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: true,
        text
      },
      "official"
    );

    expect(result.attributes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "6SAMB1J313B.2000" }),
        expect.objectContaining({ name: "6SAME4J316B.2000" })
      ])
    );
    // The proof that OUR row (not the sibling's) was selected used to be a crude attribute NAMED
    // literally after the catalog code itself (a naive `<a>`-link-text fallback firing because the
    // page's "Part #" comparison table wasn't recognized as one). Now that catalog-table-vocabulary's
    // isCatalogIdHeaderCell recognizes "Part #" (needed for real Saginaw/SCE PDF ordering tables —
    // see fixtures/sce-fk0618-floor-stand-manual), html-table-reader's structured comparison-column
    // reader owns this table instead and correctly emits our own code as a properly labeled VALUE
    // ("Sku"/"Part #" = 6SAME4J316B.4000, never the sibling's .2000) rather than as a bare name.
    expect(result.attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Sku", value: "6SAME4J316B.4000" })])
    );
  }, 20_000);

  it("does not export upload file size as a product Size spec", async () => {
    const url = "https://www.rockwellautomation.com/en-us/products/details.1606-XLS120E.html";
    const text = await readFile("fixtures/rockwell-1606-XLS120E-page/page.html", "utf8");
    const result = parseGenericProductPage(
      "rockwell",
      "1606-XLS120E",
      {
        requestedUrl: url,
        effectiveUrl: url,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: true,
        text
      },
      "official"
    );

  expect(result.attributes).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "Size", value: "5 MB" })])
  );
  expect(result.attributes).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "Items Per Page", value: "15 30 45 60" })])
  );
  expect(result.attributes).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "page", value: "pageViewData" })])
  );
  expect(result.attributes).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "Weight", value: "620 g" })])
  );
  expect(result.documents.map((document) => document.url)).not.toEqual(
    expect.arrayContaining([
      "https://www.rockwellautomation.com/table",
      "https://www.rockwellautomation.com/zip",
      "https://www.rockwellautomation.com/x-zip",
      "https://www.rockwellautomation.com/x-zip-compressed"
    ])
  );
}, 20_000);

  it("does not glue two <br>-separated caption lines into one attribute", async () => {
    // Real Ganter (ganternorm.com) product-image gallery caption:
    // `<div class="product-image__caption">Contact type: LK - ...(no switching function)<br />
    // Connection type: K2 - Cable, end open, 2 m</div>`. cheerio's `.text()` drops the `<br>` with
    // no separator, so the old text-only splitNameValue fallback glued the second line's whole
    // "Label: value" onto the first line's value.
    const url = "https://www.ganternorm.com/en/products/1.2-Operating-by-using-machine-anddevicehandles/Cabinet-U-handles/GN-3310-Switches-Indicator-Lights-Stainless-Steel-with-without-LED-Lightning";
    const text = await readFile("fixtures/gan-GN-3310-19-LK-K2-glued-value-page/page.html", "utf8");
    const result = parseGenericProductPage(
      "gan",
      "GN 3310-19-LK-K2",
      {
        requestedUrl: url,
        effectiveUrl: url,
        statusCode: 200,
        contentType: "text/html",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        fromCache: true,
        text
      },
      "official"
    );

    expect(result.attributes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: expect.stringContaining("no switching function)Connection type") })
      ])
    );
    expect(result.attributes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Contact type", value: expect.stringContaining("LK - Indicator light LED") })])
    );
  }, 15_000);
});
