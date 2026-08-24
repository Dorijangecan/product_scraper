import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";

function page(body: string, statusCode = 200): FetchedText {
  return {
    requestedUrl: "https://vendor.test/products/ABC-123",
    effectiveUrl: "https://vendor.test/products/ABC-123",
    statusCode,
    contentType: "text/html",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    fromCache: false,
    text: `<html><head><title>Product</title></head><body>${body}</body></html>`
  };
}

describe("bot-wall detection", () => {
  it("treats an anti-automation challenge page (HTTP 200) as a failed parse so the pipeline escalates", () => {
    const result = parseGenericProductPage(
      "vendor",
      "ABC-123",
      page("<h2>Please complete the security check to continue. Verify you are human.</h2>"),
      "official"
    );
    expect(result.status).toBe("failed");
  });

  it("still parses a genuine product page that merely mentions the word human", () => {
    const result = parseGenericProductPage(
      "vendor",
      "ABC-123",
      page("<h1>ABC-123</h1><table><tr><th>Rated voltage</th><td>24 V DC</td></tr></table>"),
      "official"
    );
    expect(result.status).not.toBe("failed");
  });

  it("refuses an ABB PartCommunity third-party-cookie wall before its UI tables are mined", () => {
    const result = parseGenericProductPage(
      "abb",
      "1SDA126426R1",
      {
        ...page(
          "<h1>DLP Door Lock - ABB Low Voltage &amp; Systems</h1><h2>No Third-party Cookies supported</h2>" +
          "<p>Please enable cookies in your browser for PARTcommunity to work</p>" +
          "<table><tr><td class='editable-part-header'>Product Class</td><td class='editable-part-input-column'>Accessory</td></tr>" +
          "<tr><th>UI setting</th><td>not a product fact</td></tr></table>"
        ),
        requestedUrl: "https://abb-control-products.partcommunity.com/3d-cad-models/?catalog=abb_ww&part=1SDA126426R1",
        effectiveUrl: "https://abb-control-products.partcommunity.com/3d-cad-models/?catalog=abb_ww&part=1SDA126426R1"
      },
      "official"
    );
    expect(result.attributes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ group: "HTML Table", name: "UI setting" })])
    );
  });

  it("keeps the recorded ABB cookie-wall page bounded when the offline audit uses its hostname as manufacturer id", async () => {
    const text = await readFile("fixtures/abb-1SDA126426R1-page/page.html", "utf8");
    const url = "https://abb-control-products.partcommunity.com/3d-cad-models/?catalog=abb_ww&part=1SDA126426R1";
    const result = parseGenericProductPage(
      "abb-control-products.partcommunity.com",
      "1SDA126426R1",
      {
        ...page(text),
        requestedUrl: url,
        effectiveUrl: url
      },
      "official"
    );

    expect(result.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Order Number", value: "1SDA126426R1" }),
        expect.objectContaining({ name: "Product Class", value: "Accessory" })
      ])
    );
  }, 3_000);

  it("refuses a recorded ABBlvp search-result page before the generic product sweep", async () => {
    const text = await readFile("fixtures/abb-1SDA126474R1-page/page.html", "utf8");
    const url = "https://abblvp.no/?s=1SDA126474R1";
    const result = parseGenericProductPage(
      "abb",
      "1SDA126474R1",
      {
        ...page(text),
        requestedUrl: url,
        effectiveUrl: url
      },
      "official"
    );

    expect(result.status).toBe("failed");
    expect(result.attributes).toEqual([]);
  }, 3_000);
});
