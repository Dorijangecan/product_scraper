import { describe, expect, it } from "vitest";
import { coalesceImageDocuments, documentDownloadProfile, imageFileName, isDownloadablePdfDocument, shouldDownloadDocumentsForRun } from "../src/server/run-manager.js";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
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

  it("promotes higher quality candidate URLs before downloading an image", () => {
    const documents: DocumentRecord[] = [
      {
        type: "image",
        label: "Product image",
        url: "https://assets.example.test/ABC-123_thumb_100x100.jpg",
        candidateUrls: [
          "https://assets.example.test/ABC-123_1000x1000.jpg",
          "https://assets.example.test/ABC-123_400x400.jpg"
        ]
      }
    ];

    const result = coalesceImageDocuments(documents);

    expect(result.filter((doc) => doc.type === "image")).toHaveLength(1);
    expect(result[0].url).toBe("https://assets.example.test/ABC-123_1000x1000.jpg");
    expect(result[0].candidateUrls).toEqual([
      "https://assets.example.test/ABC-123_400x400.jpg",
      "https://assets.example.test/ABC-123_thumb_100x100.jpg"
    ]);
  });

  it("keeps schematic and drawing image candidates behind real product photos", () => {
    const documents: DocumentRecord[] = [
      image("Wiring diagram", "https://assets.example.test/ABC-123-wiring-diagram_1000x1000.png"),
      image("Product image", "https://assets.example.test/ABC-123-product_400x400.png"),
      image("Dimension drawing", "https://assets.example.test/ABC-123-dimension-drawing_1000x1000.png")
    ];

    const result = coalesceImageDocuments(documents);

    expect(result[0].url).toBe("https://assets.example.test/ABC-123-product_400x400.png");
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

    const balluff = getManufacturerConfig("balluff");
    expect(balluff?.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile).toBe("quality");
    expect(documentDownloadProfile(balluff!, result)).toBe("quality");
    expect(documentDownloadProfile({ id: "balluff" }, result)).toBe("full");
  });

  it("keeps quality-profile documents for Excel enrichment even when document saving is off", () => {
    expect(shouldDownloadDocumentsForRun({ id: "balluff" }, { downloadDocuments: false, generateExcel: true })).toBe(true);
    expect(shouldDownloadDocumentsForRun({ id: "abb" }, { downloadDocuments: false, generateExcel: true })).toBe(true);
    expect(documentDownloadProfile({ id: "abb" }, { documents: [] } as unknown as ProductResult, { saveDocuments: false })).toBe("quality");
    expect(shouldDownloadDocumentsForRun({ id: "balluff" }, { downloadDocuments: false, generateExcel: false })).toBe(false);
  });

  it("does not treat Rockwell configurator cutsheets as downloadable PDFs", () => {
    expect(isDownloadablePdfDocument({ url: "https://configurator.rockwellautomation.com/api/Product/800F-X10/cutsheet" })).toBe(false);
    expect(isDownloadablePdfDocument({ url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/800-td008_-en-p.pdf" })).toBe(true);
    expect(isDownloadablePdfDocument({ url: "https://www.se.com/us/en/product/download-pdf/GV2ME08" })).toBe(true);
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
