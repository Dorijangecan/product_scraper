import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";

/**
 * The generic HTML path used to decide "is this a spec?" with English-only tests that ran BEFORE the
 * multilingual ontology was consulted:
 *   - `isLikelySpecContainer` matched class/id/heading text against `spec|technical|tech|…`, so a
 *     `class="technische-daten"` grid failed `\btech\b` and was skipped whole.
 *   - `isUsefulSpecLabel` matched label text against another English list, so `Bemessungsstrom` and
 *     `Corrente nominale` were thrown away even though `matchProperty` resolves both.
 *
 * These tests pin the multilingual behaviour. They are deliberately end-to-end through
 * `parseGenericProductPage`, because the bug was in the ORDER of the checks, not in any one predicate.
 */
function page(html: string, url = "https://vendor.test/produkt/ABC-123"): FetchedText {
  return {
    requestedUrl: url,
    effectiveUrl: url,
    statusCode: 200,
    contentType: "text/html; charset=utf-8",
    text: html,
    fetchedAt: new Date(0).toISOString(),
    fromCache: true
  };
}

function attributeNames(html: string): string[] {
  const result = parseGenericProductPage("vendor", "ABC-123", page(html), "official");
  return result.attributes.map((attribute) => attribute.name);
}

describe("generic HTML parsing — non-English pages", () => {
  it("reads a German spec grid whose container is named technische-daten", () => {
    const html = `
      <html><body>
        <h1>Produkt ABC-123</h1>
        <div class="technische-daten">
          <div class="row"><span>Bemessungsstrom</span><span>16 A</span></div>
          <div class="row"><span>Bemessungsspannung</span><span>230 V</span></div>
          <div class="row"><span>Schutzart</span><span>IP65</span></div>
        </div>
      </body></html>`;
    const result = parseGenericProductPage("vendor", "ABC-123", page(html), "official");

    expect(result.normalized.voltage).toBeTruthy();
    expect(result.normalized.current).toBeTruthy();
    expect(result.normalized.protection).toContain("IP65");
  });

  it("reads an Italian spec table", () => {
    const html = `
      <html><body>
        <h2>Dati tecnici ABC-123</h2>
        <table>
          <tr><td>Corrente nominale</td><td>16 A</td></tr>
          <tr><td>Tensione nominale</td><td>400 V</td></tr>
          <tr><td>Grado di protezione</td><td>IP54</td></tr>
        </table>
      </body></html>`;
    const result = parseGenericProductPage("vendor", "ABC-123", page(html), "official");

    expect(result.normalized.current).toBeTruthy();
    expect(result.normalized.voltage).toBeTruthy();
    expect(result.normalized.protection).toContain("IP54");
  });

  it("keeps a German label the English keyword list would have dropped", () => {
    const html = `
      <html><body><p>ABC-123</p>
        <dl><dt>Bemessungsstrom</dt><dd>16 A</dd></dl>
      </body></html>`;
    expect(attributeNames(html)).toContain("Bemessungsstrom");
  });

  it("does not mine spec pairs out of marketing prose that merely contains spec words", () => {
    // Real ABB copy. The undelimited plain-text matcher used to end each value right before the NEXT
    // label word, which in prose is the head noun of the phrase — so it shipped `Mounting = "options,
    // offering expanded"` and `Voltage = "range (100-250 V 50/60 Hz and DC), managing large control"`.
    const html = `
      <html><body><h1>TA522</h1><p>ABC-123</p>
        <p>Flexible Mounting options, offering expanded Voltage range (100-250 V 50/60 Hz and DC),
           managing large control panels. Protection is built-in, offering a compact solution.</p>
      </body></html>`;
    const result = parseGenericProductPage("vendor", "ABC-123", page(html), "official");
    const prose = result.attributes.filter((attribute) => /^(?:Mounting|Voltage|Protection|Current)$/.test(attribute.name));
    expect(prose).toEqual([]);
  });

  it("does not turn a related-products table into specifications of this product", () => {
    // A vendor's "other products in this family" block renders as `| product name | brand |`, which the
    // plain-text reader cannot tell from `| label | value |`. On a real ABB page it produced 49 attributes
    // like `KLC-S key lock open N20007 E1.3 right = ABB`.
    const html = `
      <html><body><h1>ABC-123</h1>
        <script type="application/ld+json">
          {"@type":"Product","name":"ABC-123","brand":{"name":"ABB"}}
        </script>
        <pre>
| KLC-S key lock open N20007 E1.3 right | ABB |
| RRD Motor 110 - 220Vac/dc E1.3 | ABB |
| Manufacturer | ABB |
        </pre>
      </body></html>`;
    const result = parseGenericProductPage("vendor", "ABC-123", page(html), "official");
    const names = result.attributes.map((attribute) => attribute.name);

    expect(names).not.toContain("KLC-S key lock open N20007 E1.3 right");
    expect(names).not.toContain("RRD Motor 110 - 220Vac/dc E1.3");
    // A label that genuinely asks for the manufacturer keeps its answer.
    expect(names).toContain("Manufacturer");
  });

  it("does not infer current from the ABB key-count phrase in the recorded product description", () => {
    // Fixture abb-1SDA126404R1-page publishes `POSITION 2a KEY`: this describes the number/type of
    // keys for a lock, not an electrical rating. Keep the lowercase-a tolerance generally intact;
    // only the explicit noun immediately following the candidate disqualifies it.
    const html = `
      <html><body><h1>KLP-A Bl.Ins/Sez Castell E1.3 2aCh</h1>
        <p>1SDA126404R1</p>
        <meta name="description" content="KEY LOCK CASTELL IN CONNECTED-ISOLATED POSITION 2a KEY (PREDISPOSITION ONLY) E1.3" />
      </body></html>`;
    const result = parseGenericProductPage("abb", "1SDA126404R1", page(html), "official");

    expect(result.normalized.current).toBeUndefined();
    expect(result.attributes.some((attribute) => attribute.group === "Title/Description Inference" && attribute.name === "Current")).toBe(false);
  });

  it("keeps protection ratings out of certificates and de-duplicates standard-block ratings", async () => {
    // Recorded nVent A6R44HCR markup has the same Type 3R rating in two standard blocks and an
    // IEC 60529 IP32 protection rating. IP32 is a rating, not an approval/certificate.
    const html = await fs.readFile("fixtures/nvent-A6R44HCR-page/page.html", "utf8");
    const result = parseGenericProductPage(
      "nvent",
      "A6R44HCR",
      page(html, "https://www.nvent.com/en-us/hoffman/products/enca6r44hcr"),
      "official"
    );

    expect(result.normalized.certificates ?? "").not.toContain("IP32");
    expect(result.normalized.protection).toBe("Type3R; IP32");
  });

  it("still refuses to invent anything from a page without the catalog number", () => {
    // Widening admission must not turn an unrelated page into a product.
    const html = `<html><body><div class="technische-daten"><span>Bemessungsstrom</span><span>16 A</span></div></body></html>`;
    const result = parseGenericProductPage("vendor", "ZZZ-999", page(html), "official");
    expect(result.attributes).toHaveLength(0);
    expect(result.error).toBeTruthy();
  });
});
