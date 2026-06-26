import { describe, expect, it } from "vitest";
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
});
