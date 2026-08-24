import { describe, expect, it } from "vitest";
import { proposePdfLayoutReviews } from "../src/server/scrapers/llm-pdf-layout-proposals.js";

const entries = [{
  documentId: "catalog.pdf",
  catalogNumber: "ABC-123",
  pageCount: 4,
  pageTextSamples: ["Ordering code\nPosition 1", "ABC-123 24 V", "Table continues", "Footer"]
}];

describe("local LLM PDF layout proposals", () => {
  it("is disabled by default and never calls a local model", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await proposePdfLayoutReviews(entries);
      expect(result.status).toBe("disabled");
      expect(result.proposals).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns only bounded review hints for the supplied document and never a value or selector", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      response: JSON.stringify({
        proposals: [
          { documentId: "catalog.pdf", reader: "positioned-table", pageNumbers: [2, 3, 99, 2], rationale: "aligned variants" },
          { documentId: "other.pdf", reader: "ordering-code-legend", pageNumbers: [1] },
          { documentId: "catalog.pdf", reader: "invent-reader", pageNumbers: [1] },
          { documentId: "catalog.pdf", reader: "ocr-bbox", pageNumbers: ["2"], value: "24 V", selector: "td:nth-child(2)" }
        ]
      })
    }), { status: 200 })) as typeof fetch;
    try {
      const result = await proposePdfLayoutReviews(entries, { enabled: true, host: "http://ollama.test" });
      expect(result.status).toBe("reviewed");
      expect(result.proposals).toEqual([{
        documentId: "catalog.pdf",
        reader: "positioned-table",
        pageNumbers: [2, 3],
        rationale: "aligned variants"
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
