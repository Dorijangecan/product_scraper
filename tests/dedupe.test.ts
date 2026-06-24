import { describe, expect, it } from "vitest";
import type { DocumentRecord } from "../src/shared/types.js";
import { dedupeDocuments } from "../src/server/scrapers/dedupe.js";

describe("document dedupe", () => {
  it("deduplicates equivalent document URLs with reordered query strings and tracking params", () => {
    const documents = dedupeDocuments([
      doc("datasheet", "ABC-123 datasheet", "https://example.test/download?documentId=abc&format=pdf&utm_source=search"),
      doc("datasheet", "ABC-123 technical datasheet", "https://example.test/download?format=pdf&documentId=abc")
    ]);

    expect(documents).toHaveLength(1);
    expect(documents[0]?.label).toBe("ABC-123 technical datasheet");
  });

  it("allows adapter-specific buckets while retaining shared document selection", () => {
    const documents = dedupeDocuments(
      [
        doc("image", "Left view", "https://dynamicmedia.example.test/is/image/acme/ABC_L"),
        doc("image", "Center product image", "https://dynamicmedia.example.test/is/image/acme/ABC_C")
      ],
      {
        bucketKey: (document) => document.url.replace(/_[LC](?=[?#]|$)/i, ""),
        compare: (candidate, existing) => imageRank(candidate.url) - imageRank(existing.url)
      }
    );

    expect(documents).toHaveLength(1);
    expect(documents[0]?.label).toBe("Center product image");
  });
});

function doc(type: DocumentRecord["type"], label: string, url: string): DocumentRecord {
  return { type, label, url, sourceType: "official" };
}

function imageRank(url: string): number {
  if (/_C(?=[?#]|$)/i.test(url)) return 2;
  if (/_L(?=[?#]|$)/i.test(url)) return 1;
  return 0;
}
