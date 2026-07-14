import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  coalesceImageDocuments,
  documentDownloadCandidateUrls,
  documentDownloadProfile,
  documentExtension,
  imageFileName,
  isDownloadablePdfDocument,
  RunManager,
  shouldShortCircuitCustomerFirst,
  shouldDownloadDocumentsForRun,
  withRemoteDocumentProbeSkippedDiagnostics
} from "../src/server/run-manager.js";
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
    expect(documentDownloadProfile(balluff!, result, { saveDocuments: true })).toBe("full");
    expect(documentDownloadProfile({ id: "balluff" }, result)).toBe("full");
  });

  it("keeps quality-profile documents for Excel enrichment even when document saving is off", () => {
    expect(shouldDownloadDocumentsForRun({ id: "balluff" }, { downloadDocuments: false, generateExcel: true })).toBe(true);
    expect(shouldDownloadDocumentsForRun({ id: "abb" }, { downloadDocuments: false, generateExcel: true })).toBe(true);
    expect(documentDownloadProfile({ id: "abb" }, { documents: [] } as unknown as ProductResult, { saveDocuments: false })).toBe("quality");
    expect(shouldDownloadDocumentsForRun({ id: "balluff" }, { downloadDocuments: false, generateExcel: false })).toBe(false);
  });

  it("allows complete customer documents to short-circuit official lookup for unseen manufacturers", () => {
    const result = customerOnlyResult({
      manufacturerId: "unseen-maker",
      productUrl: "https://unseen-maker.example/products/ABC-123",
      normalized: { weight: "1.2 kg", dimensions: "120 x 80 x 40 mm", material: "steel", voltage: "24 V DC" },
      qualityGate: { passed: true, identityConfirmed: true, score: 94, missing: [], reason: "customer complete", attempts: [] }
    });

    expect(
      shouldShortCircuitCustomerFirst(result, {
        attributes: [
          { name: "Part Number" },
          { name: "Description" },
          { name: "Weight" },
          { name: "Dimensions" },
          { name: "Material" },
          { name: "Voltage" }
        ],
        documents: [{ type: "datasheet", label: "Customer datasheet", url: "file:///customer/ABC-123.pdf" }]
      })
    ).toBe(true);
  });

  it("does NOT short-circuit an otherwise-complete customer document that has no product link or certificates", () => {
    // Real bug: several Rockwell 1606-XL catalogs (e.g. 1606-XLBRED20, 1606-XLPRED) short-
    // circuited on customer-doc data alone, permanently leaving productUrl empty and
    // certificates missing — even though the manufacturer's own website has both and was never
    // even tried. The old criteria only checked weight/dimensions/voltage/description, none of
    // which cover "Required Data Coverage"'s Link/Certificates fields.
    const result = customerOnlyResult({
      manufacturerId: "unseen-maker",
      normalized: { weight: "1.2 kg", dimensions: "120 x 80 x 40 mm", material: "steel", voltage: "24 V DC" },
      qualityGate: { passed: true, identityConfirmed: true, score: 94, missing: [], reason: "customer complete", attempts: [] }
    });

    expect(
      shouldShortCircuitCustomerFirst(result, {
        attributes: [
          { name: "Part Number" },
          { name: "Description" },
          { name: "Weight" },
          { name: "Dimensions" },
          { name: "Material" },
          { name: "Voltage" }
        ],
        documents: [{ type: "datasheet", label: "Customer datasheet", url: "file:///customer/ABC-123.pdf" }]
      })
    ).toBe(false);
  });

  it("still short-circuits when the customer document itself supplied a certifications attribute", () => {
    const result = customerOnlyResult({
      manufacturerId: "unseen-maker",
      normalized: { weight: "1.2 kg", dimensions: "120 x 80 x 40 mm", material: "steel", voltage: "24 V DC" },
      qualityGate: { passed: true, identityConfirmed: true, score: 94, missing: [], reason: "customer complete", attempts: [] }
    });

    expect(
      shouldShortCircuitCustomerFirst(result, {
        attributes: [
          { name: "Part Number" },
          { name: "Description" },
          { name: "Weight" },
          { name: "Dimensions" },
          { name: "Material" },
          { name: "Voltage" },
          { name: "Certifications" }
        ],
        documents: [{ type: "datasheet", label: "Customer datasheet", url: "file:///customer/ABC-123.pdf" }]
      })
    ).toBe(true);
  });

  it("keeps weak customer documents in the merge path instead of short-circuiting", () => {
    const result = customerOnlyResult({
      manufacturerId: "unseen-maker",
      normalized: { material: "steel" },
      qualityGate: { passed: false, identityConfirmed: true, score: 52, missing: ["normalized:voltage"], reason: "missing", attempts: [] }
    });

    expect(
      shouldShortCircuitCustomerFirst(result, {
        attributes: [{ name: "Part Number" }, { name: "Material" }, { name: "Description" }],
        documents: [{ type: "datasheet", label: "Customer datasheet", url: "file:///customer/ABC-123.pdf" }]
      })
    ).toBe(false);
  });

  it("records why remote document enrichment skipped non-probeable documents", () => {
    const result = withRemoteDocumentProbeSkippedDiagnostics(
      customerOnlyResult({
        status: "partial",
        documents: [
          { type: "image", label: "Product image", url: "https://example.test/ABC-123.png" },
          { type: "other", label: "Warranty terms", url: "https://example.test/warranty" }
        ]
      }),
      ["normalized:voltage", "normalized:material"]
    );

    expect(result.diagnostics?.documentProcessing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://example.test/ABC-123.png",
        action: "skipped",
        stage: "remote-document-enrichment",
        reason: expect.stringContaining("document type 'image'")
      }),
      expect.objectContaining({
        url: "https://example.test/warranty",
        action: "skipped",
        stage: "remote-document-enrichment",
        reason: expect.stringContaining("does not look like a datasheet")
      })
    ]));
    expect(result.diagnostics?.notes?.some((note) => note.includes("Remote document enrichment skipped"))).toBe(true);
  });

  it("records when remote document enrichment has no document candidates at all", () => {
    const result = withRemoteDocumentProbeSkippedDiagnostics(
      customerOnlyResult({ status: "partial", documents: [] }),
      ["document:datasheet"]
    );

    expect(result.diagnostics?.documentProcessing).toBeUndefined();
    expect(result.diagnostics?.notes?.some((note) => note.includes("product has no document candidates"))).toBe(true);
  });

  it("keeps PDF-like query documents in the quality profile for enrichment", () => {
    const result = {
      documents: [
        {
          type: "other",
          label: "ABC-123 technical datasheet",
          url: "https://example.test/files?p_Doc_Ref=ABC123_TECHDATA&p_enDocType=Data+Sheet"
        }
      ]
    } as ProductResult;

    expect(documentDownloadProfile({ id: "generic" }, result, { saveDocuments: false })).toBe("quality");
  });

  it("does not treat Rockwell configurator cutsheets as downloadable PDFs", () => {
    expect(isDownloadablePdfDocument({ url: "https://configurator.rockwellautomation.com/api/Product/800F-X10/cutsheet" })).toBe(false);
    expect(isDownloadablePdfDocument({ url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/800-td008_-en-p.pdf" })).toBe(true);
    expect(isDownloadablePdfDocument({ url: "https://www.se.com/us/en/product/download-pdf/GV2ME08" })).toBe(true);
    expect(isDownloadablePdfDocument({ url: "https://example.test/files?p_Doc_Ref=ABC123_TECHDATA&p_enDocType=Data+Sheet" })).toBe(true);
  });

  it("names PDF-like query downloads as PDFs even when the document type is generic", () => {
    expect(documentExtension("https://example.test/files?p_Doc_Ref=ABC123_TECHDATA&p_enDocType=Data+Sheet", "other")).toBe(".pdf");
    expect(documentExtension("https://example.test/download?documentId=ABC123&format=pdf", "other")).toBe(".pdf");
    expect(documentExtension("/assets/download?filename=ABC-123_datasheet.pdf&token=abc", "other")).toBe(".pdf");
  });

  it("keeps parseable document candidate URLs for fallback download attempts", () => {
    const urls = documentDownloadCandidateUrls({
      type: "datasheet",
      label: "ABC-123 datasheet",
      url: "https://example.test/broken-download",
      candidateUrls: [
        "https://example.test/files?p_Doc_Ref=ABC123_TECHDATA&p_enDocType=Data+Sheet",
        "https://example.test/about"
      ]
    });

    expect(urls).toEqual([
      "https://example.test/files?p_Doc_Ref=ABC123_TECHDATA&p_enDocType=Data+Sheet"
    ]);
  });

  it("keeps relevant datasheet endpoints without PDF suffixes as download candidates", () => {
    const urls = documentDownloadCandidateUrls({
      type: "datasheet",
      label: "ABC-123 technical datasheet PDF",
      url: "https://example.test/resources/ABC123_TECHDATA",
      sourceUrl: "https://example.test/products/ABC-123"
    });

    expect(urls).toEqual(["https://example.test/resources/ABC123_TECHDATA"]);
    expect(documentExtension(urls[0], "datasheet")).toBe(".pdf");
  });

  it("keeps relative PDF-like document links as download candidates", () => {
    const urls = documentDownloadCandidateUrls({
      type: "datasheet",
      label: "ABC-123 technical datasheet",
      url: "/downloads/files?filename=ABC-123_datasheet.pdf&token=abc",
      sourceUrl: "https://example.test/products/ABC-123"
    });

    expect(urls).toEqual(["/downloads/files?filename=ABC-123_datasheet.pdf&token=abc"]);
  });

  it("falls back to parseable candidate URLs when the primary document download fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-doc-candidates-"));
    const attempts: string[] = [];
    const http = {
      downloadFile: async (url: string, targetDir: string, suggestedName: string) => {
        attempts.push(url);
        if (attempts.length === 1) throw new Error("primary URL failed");
        await fs.mkdir(targetDir, { recursive: true });
        const output = path.join(targetDir, suggestedName);
        await fs.writeFile(output, "%PDF-1.4\n% fake test pdf\n", "utf8");
        return output;
      }
    };
    const manager = new RunManager({} as never, {} as never);

    const downloaded = await (manager as unknown as {
      downloadDocument: (
        http: { downloadFile: (url: string, targetDir: string, suggestedName: string) => Promise<string> },
        documentsDir: string,
        cadDir: string,
        imagesDir: string,
        manufacturerShortName: string,
        catalogNumber: string,
        doc: DocumentRecord,
        selection: { images: boolean; pdfs: boolean; cad: boolean }
      ) => Promise<DocumentRecord>;
    }).downloadDocument(
      http,
      dir,
      dir,
      dir,
      "TST",
      "ABC-123",
      {
        type: "datasheet",
        label: "ABC-123 datasheet",
        url: "https://example.test/primary.pdf",
        candidateUrls: ["https://example.test/download?documentId=ABC123&format=pdf"]
      },
      { images: false, pdfs: true, cad: false }
    );

    expect(attempts).toEqual([
      "https://example.test/primary.pdf",
      "https://example.test/download?documentId=ABC123&format=pdf"
    ]);
    expect(downloaded.downloadStatus).toBe("downloaded");
    expect(downloaded.url).toBe("https://example.test/download?documentId=ABC123&format=pdf");
    expect(downloaded.localPath).toMatch(/ABC-123-datasheet/i);
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

function customerOnlyResult(overrides: Partial<ProductResult>): ProductResult {
  return {
    manufacturerId: "unseen-maker",
    catalogNumber: "ABC-123",
    status: "found",
    confidence: 0.9,
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    ...overrides
  };
}
