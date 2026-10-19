import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  coalesceImageDocuments,
  cohortAnomalyPatchesForRun,
  documentDownloadCandidateUrls,
  documentDownloadProfile,
  documentExtension,
  imageFileName,
  isDownloadablePdfDocument,
  notApplicableFieldsFromHiddenCoverage,
  RunManager,
  shouldSkipNetworkFallback,
  shouldShortCircuitCustomerFirst,
  shouldDownloadDocumentsForRun,
  withRemoteDocumentProbeSkippedDiagnostics
} from "../src/server/run-manager.js";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import type { DocumentRecord, ProductResult, RunItemRecord } from "../src/shared/types.js";

describe("hidden coverage tiles become a not-applicable policy", () => {
  it("maps the switched-off built-in tiles to field requirements", () => {
    expect(notApplicableFieldsFromHiddenCoverage(["current", "voltage"])).toEqual(["voltage", "current"]);
  });

  it("ignores link tiles and custom tiles, which carry no field requirement", () => {
    expect(notApplicableFieldsFromHiddenCoverage(["enUrl", "deUrl", "custom:pressure"])).toEqual([]);
  });

  it("returns nothing when the user hid no tile", () => {
    expect(notApplicableFieldsFromHiddenCoverage(undefined)).toEqual([]);
    expect(notApplicableFieldsFromHiddenCoverage([])).toEqual([]);
  });
});

describe("authoritative terminal connector results", () => {
  it("skips expensive network fallback after an official catalog-not-found response", () => {
    expect(
      shouldSkipNetworkFallback({
        manufacturerId: "abb",
        catalogNumber: "1SBL131005R5501",
        status: "failed",
        confidence: 0,
        normalized: {},
        attributes: [],
        documents: [],
        sources: [],
        diagnostics: { terminal: { reason: "official-catalog-not-found", skipNetworkFallback: true } }
      })
    ).toBe(true);
  });

  it("does not suppress ordinary failed products that still need discovery", () => {
    expect(
      shouldSkipNetworkFallback({
        manufacturerId: "abb",
        catalogNumber: "1SBL131001R5501",
        status: "failed",
        confidence: 0,
        normalized: {},
        attributes: [],
        documents: [],
        sources: []
      })
    ).toBe(false);
  });
});

describe("cohortAnomalyPatchesForRun", () => {
  function runItem(id: number, catalogNumber: string, weight: string | undefined): RunItemRecord {
    return {
      id,
      runId: "run-1",
      rowIndex: id,
      catalogNumber,
      status: "found",
      result: {
        manufacturerId: "test",
        catalogNumber,
        status: "found",
        confidence: 0.9,
        normalized: { weight },
        attributes: [{ group: "General", name: "Product Type", value: "Contactor", sourceType: "official" }],
        documents: [],
        sources: []
      },
      updatedAt: new Date().toISOString()
    };
  }

  it("returns a patch only for the outlier item, carrying its cohort context", () => {
    const weights = [1.2, 1.3, 1.25, 1.28, 1.22, 1.31, 1.27, 1.24, 120];
    const items = weights.map((kg, index) => runItem(index, `CAT-${index}`, `${kg} kg`));

    const patches = cohortAnomalyPatchesForRun(items);

    expect(patches).toHaveLength(1);
    expect(patches[0].item.catalogNumber).toBe("CAT-8");
    expect(patches[0].cohortAnomalies).toHaveLength(1);
    expect(patches[0].cohortAnomalies[0]).toMatchObject({ field: "weight", value: 120, deviceType: "Contactor" });
  });

  it("skips runs with fewer than 3 resulted items entirely", () => {
    const items = [runItem(0, "CAT-0", "1.2 kg"), runItem(1, "CAT-1", "900 kg")];
    expect(cohortAnomalyPatchesForRun(items)).toEqual([]);
  });

  it("produces no patches when nothing is anomalous", () => {
    const weights = [1.2, 1.3, 1.25, 1.28, 1.22, 1.31, 1.27, 1.24];
    const items = weights.map((kg, index) => runItem(index, `CAT-${index}`, `${kg} kg`));
    expect(cohortAnomalyPatchesForRun(items)).toEqual([]);
  });

  it("ignores items with no result", () => {
    const items = [runItem(0, "CAT-0", "1.2 kg"), runItem(1, "CAT-1", "1.3 kg"), { ...runItem(2, "CAT-2", undefined), result: undefined }];
    expect(cohortAnomalyPatchesForRun(items)).toEqual([]);
  });
});

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

  it("ranks Schneider photo renditions ahead of tiny gallery thumbnails", () => {
    const result = coalesceImageDocuments([
      image("ATV320U07M2C Product picture", "https://download.schneider-electric.com/files?p_Doc_Ref=ATV320U0xM2C_rear&p_File_Type=rendition_64_gif"),
      image("ATV320U07M2C Product picture", "https://download.schneider-electric.com/files?p_Doc_Ref=ATV320U0xM2C_front&p_File_Type=rendition_369_jpg")
    ]);

    expect(result.filter((doc) => doc.type === "image")).toHaveLength(1);
    expect(result[0].url).toContain("rendition_369_jpg");
    expect(result[0].candidateUrls?.[0]).toContain("rendition_64_gif");
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

  it("does not promote an ABB master logo over the real product image", () => {
    const result = coalesceImageDocuments([
      {
        type: "image",
        label: "Product image 400x400",
        url: "https://cdn.productimages.abb.com/1SBC101560V0014_400x400.png",
        candidateUrls: [
          "https://cdn.productimages.abb.com/9PAA00000125069_400x400.jpg",
          "https://cdn.productimages.abb.com/9PAA00000125069_master.jpg",
          "https://cdn.productimages.abb.com/9PAA00000125069_100x100.jpg"
        ]
      }
    ]);

    expect(result[0].url).toBe("https://cdn.productimages.abb.com/1SBC101560V0014_400x400.png");
    expect(result[0].candidateUrls).toEqual([
      "https://cdn.productimages.abb.com/9PAA00000125069_400x400.jpg",
      "https://cdn.productimages.abb.com/9PAA00000125069_master.jpg",
      "https://cdn.productimages.abb.com/9PAA00000125069_100x100.jpg"
    ]);
  });

  it("does not reject a valid primary image because a fallback is a placeholder", () => {
    const document = {
      type: "image" as const,
      label: "Product image",
      url: "https://assets.example.test/ABC-123-product_400x400.png",
      candidateUrls: ["https://assets.example.test/placeholder/no-image-available.png"]
    };
    const result = coalesceImageDocuments([document]);

    expect(result.filter((doc) => doc.type === "image")).toHaveLength(1);
    expect(result[0].url).toBe("https://assets.example.test/ABC-123-product_400x400.png");
    expect(documentDownloadCandidateUrls(document)).toEqual([document.url]);
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

  it("rejects a lone drawing or no-image placeholder instead of exporting it as a product photo", () => {
    const result = coalesceImageDocuments([
      image("Dimension drawing", "https://assets.example.test/ABC-123-dimension-drawing_1000x1000.png"),
      image("No image available", "https://assets.example.test/no-image-available.png")
    ]);

    expect(result.filter((doc) => doc.type === "image")).toHaveLength(0);
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

  it("skips ABB PDF downloads after an exact official page supplies its required electrical fields", () => {
    const result = {
      manufacturerId: "abb",
      catalogNumber: "3AXD50000038968",
      status: "found",
      confidence: 0.96,
      title: "ACS580-01 General Purpose Drive",
      productUrl: "https://new.abb.com/products/3AXD50000038968",
      normalized: { voltage: "380...480 V", current: "7.2 A" },
      attributes: Array.from({ length: 24 }, (_, index) => ({
        name: `Field ${index}`,
        value: `Value ${index}`,
        sourceType: "official",
        parser: "abb-product-model"
      })),
      documents: [{ type: "datasheet", label: "Data sheet", url: "https://search.abb.com/library/datasheet.pdf" }],
      sources: [{ url: "https://new.abb.com/products/3AXD50000038968", sourceType: "official", parser: "abb-product-page", fetchedAt: new Date(0).toISOString() }],
      qualityGate: { passed: true, identityConfirmed: true, score: 100, missing: [], reason: "Complete", attempts: [] }
    } as ProductResult;

    expect(documentDownloadProfile({ id: "abb" }, result, { saveDocuments: false })).toBe("images-only");
    expect(documentDownloadProfile({ id: "abb" }, result, { saveDocuments: true })).toBe("full");
    expect(documentDownloadProfile({ id: "abb" }, { ...result, normalized: { voltage: "380...480 V" } }, { saveDocuments: false })).toBe("quality");
    expect(documentDownloadProfile({ id: "abb" }, { ...result, qualityGate: { ...result.qualityGate!, passed: false } }, { saveDocuments: false })).toBe("quality");

    const hmiResult = {
      ...result,
      catalogNumber: "1SAP520100R0001",
      title: "CP620 Control Panel 4.3 inch HMI",
      normalized: { voltage: "18...30 V DC" },
      attributes: [
        ...result.attributes,
        { name: "Extended Product Type", value: "CP620", sourceType: "official", parser: "abb-product-model" }
      ]
    } as ProductResult;
    expect(documentDownloadProfile({ id: "abb" }, hmiResult, { saveDocuments: false })).toBe("images-only");

    const plcResult = {
      ...hmiResult,
      catalogNumber: "1SAP123400R0172",
      title: "PM5032-T-ETH programmable logic controller",
      normalized: { voltage: "20.4...28.8 V DC" },
      attributes: [
        ...hmiResult.attributes,
        { name: "Extended Product Type", value: "PM5032-T-ETH", sourceType: "official", parser: "abb-product-model" }
      ]
    } as ProductResult;
    expect(documentDownloadProfile({ id: "abb" }, plcResult, { saveDocuments: false })).toBe("quality");
    expect(documentDownloadProfile({ id: "abb" }, { ...plcResult, normalized: { voltage: "20.4...28.8 V DC", current: "0.2...0.9 A" } }, { saveDocuments: false })).toBe("images-only");
  });

  it("skips SCE manuals in quality mode after the exact product page meets its quality gate", () => {
    const result = {
      manufacturerId: "sce",
      catalogNumber: "SCE-N12FA66-24VDC",
      status: "found",
      confidence: 0.96,
      productUrl: "https://www.saginawcontrol.com/partnumber_info/?n=SCE-N12FA66-24VDC",
      normalized: { voltage: "24 V DC", current: "0.71 A", dimensions: "9.84 x 9.84 x 4.40 in" },
      attributes: [],
      documents: [
        { type: "image", label: "Product image", url: "https://www.saginawcontrol.com/images/sce-n12fa66-24vdc.png" },
        { type: "manual", label: "Type 12 Fan / Filter Package", url: "https://www.saginawcontrol.com/instman/type-12-fan-filter-package.pdf" }
      ],
      sources: [{ url: "https://www.saginawcontrol.com/partnumber_info/?n=SCE-N12FA66-24VDC", sourceType: "official", parser: "sce-product-page", fetchedAt: new Date(0).toISOString() }],
      qualityGate: { passed: true, identityConfirmed: true, score: 100, missing: [], reason: "Complete", attempts: [] }
    } as ProductResult;

    expect(documentDownloadProfile({ id: "sce" }, result, { saveDocuments: false })).toBe("images-only");
    expect(documentDownloadProfile({ id: "sce" }, result, { saveDocuments: true })).toBe("full");
    expect(documentDownloadProfile({ id: "sce" }, { ...result, qualityGate: { ...result.qualityGate!, passed: false } }, { saveDocuments: false })).toBe("quality");
  });

  it("skips nVent PDFs only for exact passive product pages with complete type-specific fields", () => {
    const pageUrl = "https://www.nvent.com/en-us/caddy/products/efspcs2";
    const base = {
      manufacturerId: "nvent",
      catalogNumber: "PCS2",
      status: "found",
      confidence: 0.96,
      title: "Cable support clip, steel",
      productUrl: pageUrl,
      normalized: { material: "Steel" },
      attributes: [
        ...Array.from({ length: 10 }, (_, index) => ({ name: `Field ${index}`, value: `Value ${index}`, sourceUrl: pageUrl, sourceType: "official", parser: "nvent-direct" })),
        { name: "Catalog Number", value: "PCS2", sourceUrl: pageUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Material", value: "Steel", sourceUrl: pageUrl, sourceType: "official", parser: "nvent-direct" }
      ],
      documents: [{ type: "image", label: "Product image", url: `${pageUrl}/image`, sourceType: "official" }],
      sources: [{ url: pageUrl, sourceType: "official", parser: "nvent-direct", fetchedAt: new Date(0).toISOString() }],
      qualityGate: { passed: true, identityConfirmed: true, score: 100, missing: [], reason: "Complete", attempts: [] }
    } as ProductResult;

    expect(documentDownloadProfile({ id: "nvent" }, base, { saveDocuments: false })).toBe("images-only");
    expect(documentDownloadProfile({ id: "nvent" }, base, { saveDocuments: true })).toBe("full");
    expect(documentDownloadProfile({ id: "nvent" }, { ...base, normalized: {} }, { saveDocuments: false })).toBe("quality");
    expect(documentDownloadProfile({ id: "nvent" }, { ...base, catalogNumber: "PCS3" }, { saveDocuments: false })).toBe("quality");
    expect(documentDownloadProfile({ id: "nvent" }, { ...base, qualityGate: { ...base.qualityGate!, passed: false } }, { saveDocuments: false })).toBe("quality");

    const fanUrl = "https://www.nvent.com/en-us/hoffman/products/enchf0516514";
    const fan = {
      ...base,
      catalogNumber: "HF0516514",
      title: "Filter Fan 115V 0.16A",
      productUrl: fanUrl,
      normalized: { dimensions: "6.15 x 6.16 x 3.98 in", voltage: "115 V", current: "0.16 A" },
      attributes: [
        ...Array.from({ length: 8 }, (_, index) => ({ name: `Field ${index}`, value: `Value ${index}`, sourceUrl: fanUrl, sourceType: "official", parser: "nvent-direct" })),
        { name: "Catalog Number", value: "HF0516514", sourceUrl: fanUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Nominal Voltage", value: "115V", sourceUrl: fanUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Max Current", value: "0.16A", sourceUrl: fanUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Height", value: "6.15in", sourceUrl: fanUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Width", value: "6.16in", sourceUrl: fanUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Depth", value: "3.98in", sourceUrl: fanUrl, sourceType: "official", parser: "nvent-direct" }
      ],
      documents: [{ type: "image", label: "Product image", url: `${fanUrl}/image`, sourceType: "official" }],
      sources: [{ url: fanUrl, sourceType: "official", parser: "nvent-direct", fetchedAt: new Date(0).toISOString() }]
    } as ProductResult;
    expect(documentDownloadProfile({ id: "nvent" }, fan, { saveDocuments: false })).toBe("images-only");
    expect(documentDownloadProfile({ id: "nvent" }, { ...fan, attributes: fan.attributes.filter((attribute) => attribute.name !== "Max Current") }, { saveDocuments: false })).toBe("quality");

    const psuUrl = "https://www.nvent.com/en-us/schroff/products/enc13100-176";
    const psu = {
      ...base,
      catalogNumber: "13100-176",
      title: "PSU 19 inch AC/DC Slimpower 31 W",
      productUrl: psuUrl,
      normalized: { dimensions: "W 15.24 mm x D 171.93 mm", voltage: "85...253 V AC", current: "6.2 A" },
      attributes: [
        ...Array.from({ length: 8 }, (_, index) => ({ name: `Field ${index}`, value: `Value ${index}`, sourceUrl: psuUrl, sourceType: "official", parser: "nvent-direct" })),
        { name: "Catalog Number", value: "13100-176", sourceUrl: psuUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Input Voltage AC", value: "85 – 253V", sourceUrl: psuUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Voltage 1", value: "5V", sourceUrl: psuUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Current 1", value: "6.2A", sourceUrl: psuUrl, sourceType: "official", parser: "nvent-direct" }
      ],
      documents: [{ type: "image", label: "Product image", url: `${psuUrl}/image`, sourceType: "official" }],
      sources: [{ url: psuUrl, sourceType: "official", parser: "nvent-direct", fetchedAt: new Date(0).toISOString() }]
    } as ProductResult;
    expect(documentDownloadProfile({ id: "nvent" }, psu, { saveDocuments: false })).toBe("images-only");

    const spdUrl = "https://www.nvent.com/en-us/erico/products/efsedt230031r";
    const spd = {
      ...base,
      catalogNumber: "EDT230031R",
      title: "EDT2 Enhanced DIN Rail Surge Protection Device",
      productUrl: spdUrl,
      normalized: { dimensions: "89 x 72 x 69 mm", material: "Thermoplastic", voltage: "240 V", protection: "IP 20" },
      attributes: [
        ...Array.from({ length: 8 }, (_, index) => ({ name: `Field ${index}`, value: `Value ${index}`, sourceUrl: spdUrl, sourceType: "official", parser: "nvent-direct" })),
        { name: "Catalog Number", value: "EDT230031R", sourceUrl: spdUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Nominal System Voltage (Un)", value: "240 V", sourceUrl: spdUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Max Continuous Operating Voltage (Uc)", value: "300 V", sourceUrl: spdUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Nominal Discharge Current (In)", value: "20kA", sourceUrl: spdUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Max Discharge Current (Imax)", value: "50kA", sourceUrl: spdUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Voltage Protection Level (Up)", value: "1650V", sourceUrl: spdUrl, sourceType: "official", parser: "nvent-direct" }
      ],
      documents: [{ type: "image", label: "Product image", url: `${spdUrl}/image`, sourceType: "official" }],
      sources: [{ url: spdUrl, sourceType: "official", parser: "nvent-direct", fetchedAt: new Date(0).toISOString() }]
    } as ProductResult;
    expect(documentDownloadProfile({ id: "nvent" }, spd, { saveDocuments: false })).toBe("images-only");

    const enclosureUrl = "https://www.nvent.com/en-us/hoffman/products/enca48sa3812lppl";
    const enclosure = {
      ...base,
      catalogNumber: "A48SA3812LPPL",
      title: "Disconnect Wall-Mount Enclosure Type 12",
      productUrl: enclosureUrl,
      normalized: { dimensions: "48 x 37.38 x 12 in", material: "Mild Steel", protection: "Type 12; NEMA Type 4" },
      attributes: [
        ...Array.from({ length: 8 }, (_, index) => ({ name: `Field ${index}`, value: `Value ${index}`, sourceUrl: enclosureUrl, sourceType: "official", parser: "nvent-direct" })),
        { name: "Catalog Number", value: "A48SA3812LPPL", sourceUrl: enclosureUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Height", value: "48in", sourceUrl: enclosureUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Width", value: "37.38in", sourceUrl: enclosureUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Depth", value: "12in", sourceUrl: enclosureUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Material", value: "Mild Steel", sourceUrl: enclosureUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Protection Rating", value: "NEMA Type 4; NEMA Type 3R", sourceUrl: enclosureUrl, sourceType: "official", parser: "nvent-direct" }
      ],
      documents: [{ type: "image", label: "Product image", url: `${enclosureUrl}/image`, sourceType: "official" }],
      sources: [{ url: enclosureUrl, sourceType: "official", parser: "nvent-direct", fetchedAt: new Date(0).toISOString() }]
    } as ProductResult;
    expect(documentDownloadProfile({ id: "nvent" }, enclosure, { saveDocuments: false })).toBe("images-only");

    const coolerUrl = "https://www.nvent.com/en-us/hoffman/products/encva151604x";
    const cooler = {
      ...base,
      catalogNumber: "VA151604X",
      title: "Quiet Vortex Cooler Type 4X",
      productUrl: coolerUrl,
      normalized: { dimensions: "8 x 4.75 x 5.38 in", material: "Polycarbonate" },
      attributes: [
        ...Array.from({ length: 8 }, (_, index) => ({ name: `Field ${index}`, value: `Value ${index}`, sourceUrl: coolerUrl, sourceType: "official", parser: "nvent-direct" })),
        { name: "Catalog Number", value: "VA151604X", sourceUrl: coolerUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Height", value: "8in", sourceUrl: coolerUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Width", value: "4.75in", sourceUrl: coolerUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Depth", value: "5.38in", sourceUrl: coolerUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Material", value: "Polycarbonate", sourceUrl: coolerUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Nominal Capacity Btu/h", value: "1500Btu/h", sourceUrl: coolerUrl, sourceType: "official", parser: "nvent-direct" },
        { name: "Nominal Capacity Watts", value: "440W", sourceUrl: coolerUrl, sourceType: "official", parser: "nvent-direct" }
      ],
      documents: [{ type: "image", label: "Product image", url: `${coolerUrl}/image`, sourceType: "official" }],
      sources: [{ url: coolerUrl, sourceType: "official", parser: "nvent-direct", fetchedAt: new Date(0).toISOString() }]
    } as ProductResult;
    expect(documentDownloadProfile({ id: "nvent" }, cooler, { saveDocuments: false })).toBe("images-only");
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

  it("names images from the requested catalog number with the preview suffix", () => {
    expect(imageFileName("SCE", "SCE-12P10GALV")).toBe("SCE.SCE-12P10GALV_preview.png");
    expect(imageFileName("SCE", "SCE-12P10GALV", 1)).toBe("SCE.SCE-12P10GALV_preview_2.png");
    expect(imageFileName("BAL", "BCC039H")).toBe("BAL.BCC039H_preview.png");
    expect(imageFileName("ETN", "XTCE009B10")).toBe("ETN.XTCE009B10_preview.png");
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
