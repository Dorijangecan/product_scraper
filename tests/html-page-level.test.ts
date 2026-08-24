import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { classifyHtmlPageLevel } from "../src/server/scrapers/html-page-level.js";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";

describe("classifyHtmlPageLevel", () => {
  it("marks a selectable product page as family when the target is listed with sibling models", () => {
    const $ = cheerio.load(`
      <main><input name="partNumber" value="ACME-100" />
        <div hidden>ACME-100 ACME-200 ACME-300</div>
      </main>
    `);
    expect(classifyHtmlPageLevel($, "ACME-100")).toEqual({
      pageLevel: "family",
      siblingCatalogNumbers: ["ACME-200", "ACME-300"]
    });
  });

  it("does not mistake a related-products rail for product family evidence", () => {
    const $ = cheerio.load(`
      <main>ACME-100</main>
      <aside class="related-products">ACME-200 ACME-300</aside>
    `);
    expect(classifyHtmlPageLevel($, "ACME-100")).toEqual({ pageLevel: "product", siblingCatalogNumbers: [] });
  });
});

describe("generic family-page gate", () => {
  it("keeps a variant-scoped table value but refuses an unscoped family weight", () => {
    const result = parseGenericProductPage(
      "acme",
      "ACME-100",
      {
        requestedUrl: "https://example.test/ACME-family",
        effectiveUrl: "https://example.test/ACME-family",
        text: `<main>
          <h1>ACME-100</h1><div hidden>ACME-100 ACME-200</div>
          <table><tr><th>Catalog Number</th><th>Weight</th></tr><tr><td>ACME-100</td><td>1 kg</td></tr><tr><td>ACME-200</td><td>2 kg</td></tr></table>
          <section><span class="spec-label">Weight</span><span>2 kg</span></section>
        </main>`,
        fetchedAt: "2026-08-17T00:00:00.000Z",
        statusCode: 200,
        contentType: "text/html",
        fromCache: true
      },
      "official"
    );

    expect(result.pageLevel).toBe("family");
    expect(result.confidence).toBe(0.45);
    expect(result.normalized.weight).toBe("1 kg");
    expect(result.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Weight", value: "1 kg", scope: "variant" })
    ]));
    expect(result.attributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Weight", value: "2 kg" })
    ]));
  });

  it("selects one ordering-code option from a non-table configurator", () => {
    const result = parseGenericProductPage(
      "acme",
      "ACME-100-SR",
      {
        requestedUrl: "https://example.test/ACME-family",
        effectiveUrl: "https://example.test/ACME-family",
        text: `<main><h1>ACME-100-SR</h1><div hidden>ACME-100-SR ACME-100-SW</div>
          <fieldset><legend>Finish</legend><label>SR - Silver, RAL 9006</label><label>SW - Black, RAL 9005</label></fieldset>
        </main>`,
        fetchedAt: "2026-08-17T00:00:00.000Z",
        statusCode: 200,
        contentType: "text/html",
        fromCache: true
      },
      "official"
    );

    expect(result.pageLevel).toBe("family");
    expect(result.normalized.finish).toContain("RAL 9006");
    expect(result.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: "Catalog variant option", name: "Finish", value: "RAL 9006", scope: "variant-option" })
    ]));
  });
});
