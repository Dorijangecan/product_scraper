import { describe, expect, it } from "vitest";
import { coalesceImageDocuments } from "../src/server/run-manager.js";
import type { DocumentRecord } from "../src/shared/types.js";

describe("run manager document downloads", () => {
  it("coalesces multiple image candidates into one primary image with fallbacks", () => {
    const documents: DocumentRecord[] = [
      image("Product Thumbnail urls", "https://cdn.productimages.abb.com/9PAA00000348460_100x100.png"),
      image("Product image", "https://cdn.productimages.abb.com/9PAA00000348460_master.png"),
      image("Product image", "https://cdn.productimages.abb.com/9PAA00000348460_400x400.png"),
      { type: "other", label: "Terms", url: "https://example.test/terms.pdf" }
    ];

    const result = coalesceImageDocuments(documents);

    expect(result.filter((doc) => doc.type === "image")).toHaveLength(1);
    expect(result[0].url).toBe("https://cdn.productimages.abb.com/9PAA00000348460_400x400.png");
    expect(result[0].candidateUrls).toEqual([
      "https://cdn.productimages.abb.com/9PAA00000348460_master.png",
      "https://cdn.productimages.abb.com/9PAA00000348460_100x100.png"
    ]);
    expect(result.some((doc) => doc.type === "other")).toBe(true);
  });
});

function image(label: string, url: string): DocumentRecord {
  return { type: "image", label, url };
}
