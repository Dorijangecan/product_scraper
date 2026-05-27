import { describe, expect, it } from "vitest";
import { coalesceImageDocuments, documentDownloadProfile, imageFileName, shouldDownloadDocumentsForRun } from "../src/server/run-manager.js";
import type { DocumentRecord, ProductResult } from "../src/shared/types.js";

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

  it("keeps Balluff datasheets in the download/enrichment path after quality passes", () => {
    const result = {
      manufacturerId: "balluff",
      catalogNumber: "BNI00JF",
      status: "found",
      confidence: 0.92,
      normalized: {},
      attributes: [],
      documents: [
        { type: "image", label: "Product image", url: "https://assets.balluff.com/product.png" },
        { type: "datasheet", label: "Datasheet", url: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=BNI00JF&con=en" }
      ],
      sources: [],
      qualityGate: { passed: true, identityConfirmed: true, score: 100, missing: [], reason: "Complete", attempts: [] }
    } as ProductResult;

    expect(documentDownloadProfile({ id: "balluff" }, result)).toBe("quality");
  });

  it("downloads Balluff datasheets for Excel enrichment even when document saving is off", () => {
    expect(shouldDownloadDocumentsForRun({ id: "balluff" }, { downloadDocuments: false, generateExcel: true })).toBe(true);
    expect(shouldDownloadDocumentsForRun({ id: "abb" }, { downloadDocuments: false, generateExcel: true })).toBe(false);
    expect(shouldDownloadDocumentsForRun({ id: "balluff" }, { downloadDocuments: false, generateExcel: false })).toBe(false);
  });

  it("names SCE images from the requested catalog number with the preview suffix", () => {
    expect(imageFileName("SCE", "SCE-12P10GALV")).toBe("SCE.SCE-12P10GALV_preview.png");
    expect(imageFileName("SCE", "SCE-12P10GALV", 1)).toBe("SCE.SCE-12P10GALV_preview_2.png");
    expect(imageFileName("BAL", "BCC039H")).toBe("BAL.BCC039H.png");
  });
});

function image(label: string, url: string): DocumentRecord {
  return { type: "image", label, url };
}
