import { describe, expect, it } from "vitest";
import { applyFieldCandidateResolution } from "../src/server/scrapers/field-candidates.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";
import type { ProductResult } from "../src/shared/types.js";

describe("field candidate resolver", () => {
  it("does not promote ABB PDF prose into material or color fields", () => {
    const result = applyFieldCandidateResolution({
      manufacturerId: "abb",
      catalogNumber: "2CSG251151R4051",
      status: "found",
      confidence: 0.96,
      normalized: {},
      attributes: [
        { group: "PDF datasheet", name: "Graphic color", value: "display", sourceType: "generated", parser: "pdf-table-extractor" },
        { group: "PDF datasheet", name: "Material", value: "Copper", sourceType: "generated", parser: "pdf-table-extractor" }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.color).toBeUndefined();
    expect(result.normalized.material).toBeUndefined();
  });

  it("does not restore unsupported Eaton LED component ratings as device-level fields", () => {
    const exactPage = "https://www.eaton.com/us/en-us/skuPage.257064.html";
    const result = applyFieldCandidateResolution({
      manufacturerId: "eaton",
      catalogNumber: "257064",
      status: "partial",
      confidence: 0.7,
      normalized: { voltage: "24 V DC", current: "15 mA" },
      attributes: [
        { group: "General specifications", name: "Product Type", value: "Emergency stop pushbutton", sourceUrl: exactPage, sourceType: "official-fallback", parser: "eaton-product-page" },
        { group: "Included built-in LED", name: "LED voltage", value: "24 V DC", sourceUrl: exactPage, sourceType: "official-fallback", parser: "eaton-product-page" },
        { group: "Included built-in LED", name: "LED rated current", value: "15 mA", sourceUrl: exactPage, sourceType: "official-fallback", parser: "eaton-product-page" },
        { group: "Product specifications", name: "Accessories", value: "With built-in multiple LED, 24 V DC, Ie = 15 mA", sourceUrl: exactPage, sourceType: "official-fallback", parser: "eaton-product-page" }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.voltage).toBeUndefined();
    expect(result.normalized.current).toBeUndefined();
  });

  it("does not restore a light curtain's ambiguous operating-state current after normalization", () => {
    const result = applyFieldCandidateResolution({
      manufacturerId: "schneider",
      catalogNumber: "XUSL4E30H091N",
      status: "found",
      confidence: 0.9,
      normalized: { current: "42 mA no-load transmitter, 83 mA no-load receiver, 900 mA with maximum load receiver" },
      attributes: [
        { group: "Schneider Main", name: "Product or Component Type", value: "Safety light curtain type 4", sourceType: "official" },
        { group: "Schneider Complementary", name: "Current consumption", value: "42 mA no-load transmitter, 83 mA no-load receiver, 900 mA with maximum load receiver", sourceType: "official" },
        { group: "PDF datasheet", name: "[Ie] rated operational current", value: "2 A", sourceType: "generated", matchLevel: "exact" }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.current).toBeUndefined();
  });

  it("does not flatten safety-controller OSSD channel current into device current", () => {
    const attributes = [
      { group: "Schneider Main", name: "Product or Component Type", value: "Safety controller CPU", sourceType: "official" as const },
      { group: "PDF datasheet", name: "Discrete output current", value: "400 mA", sourceType: "official" as const, parser: "pdf-table-extractor" },
      { group: "PDF datasheet", name: "Feature", value: "2 OSSD pairs with 400 mA output current", sourceType: "official" as const, parser: "pdf-table-extractor" }
    ];
    const result = applyFieldCandidateResolution({
      manufacturerId: "schneider",
      catalogNumber: "XPSMCMCP0802",
      status: "found",
      confidence: 0.96,
      normalized: { current: "400 mA" },
      attributes,
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.current).toBeUndefined();
    expect(normalizeFields(attributes, [], "schneider").current).toBeUndefined();
  });

  it("leaves a bus-powered discrete input module's signal voltage out of device supply voltage", () => {
    const result = applyFieldCandidateResolution({
      manufacturerId: "schneider",
      catalogNumber: "TM3DI16K",
      status: "found",
      confidence: 0.96,
      normalized: { voltage: "24 V" },
      attributes: [
        { group: "Schneider Main", name: "Product or Component Type", value: "Discrete input module", sourceType: "official" },
        { group: "PDF datasheet", name: "Discrete input voltage", value: "24 V DC", sourceType: "official", parser: "pdf-table-extractor" },
        { group: "PDF datasheet", name: "Power supply type", value: "Electronic powered by internal bus", sourceType: "official", parser: "pdf-table-extractor" }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.voltage).toBeUndefined();
  });

  it("preserves both official input-voltage ranges for Lexium 32 servo drives", () => {
    const result = applyFieldCandidateResolution({
      manufacturerId: "schneider",
      catalogNumber: "LXM32AD18M2",
      status: "found",
      confidence: 0.96,
      normalized: { voltage: "100...120 V - 15...10 %" },
      attributes: [
        { group: "Schneider Main", name: "Range of Product", value: "Lexium 32", sourceType: "official" },
        { group: "Schneider Main", name: "Description", value: "The motion servo drive has a rated supply voltage of 100V to 120V, 200V to 240V (single phase).", sourceType: "official" }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.voltage).toBe("100...120 V AC; 200...240 V AC");
  });

  it("uses the exact Schneider product description to reject document-context ratings", () => {
    const productUrl = "https://www.se.com/us/en/product/XPSMCMCP0802/";
    const result = applyFieldCandidateResolution({
      manufacturerId: "schneider",
      catalogNumber: "XPSMCMCP0802",
      productUrl,
      status: "found",
      confidence: 0.96,
      normalized: { dimensions: "L 3 m", protection: "IP54" },
      attributes: [
        {
          group: "Schneider Product Info",
          name: "Description",
          value: "This safety controller CPU weighs 0.25kg. Its dimension are 22.5mm (Depth), 99mm (Height) and 114.5mm (Width). It is an IP20 rated product.",
          sourceUrl: productUrl,
          sourceType: "official",
          parser: "schneider-product-page"
        },
        { group: "PDF manual", name: "Feature", value: "cabinet with an IP54 degree of protection", sourceType: "generated", parser: "pdf-table-extractor" },
        { group: "PDF manual", name: "Length", value: "3 m", sourceType: "generated", parser: "pdf-table-extractor" }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.weight).toBe("0.25 kg");
    expect(result.normalized.dimensions).toBe("D 22.5 mm x H 99 mm x W 114.5 mm");
    expect(result.normalized.protection).toBe("IP20");
  });

  it("does not use a carbon-footprint quantity as device weight", () => {
    const result = applyFieldCandidateResolution({
      manufacturerId: "schneider",
      catalogNumber: "LXM32AD18M2",
      status: "found",
      confidence: 0.96,
      normalized: { weight: "3 kg CO2 eq." },
      attributes: [
        { group: "Schneider Sustainability", name: "Total lifecycle Carbon footprint", value: "3 kg CO2 eq.", sourceType: "official" }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.weight).toBeUndefined();
  });

  it("leaves product mass blank when Schneider's net and unit-package weights conflict", () => {
    const result = applyFieldCandidateResolution({
      manufacturerId: "schneider",
      catalogNumber: "TM3DI16K",
      productUrl: "https://www.se.com/us/en/product/TM3DI16K/",
      status: "found",
      confidence: 0.96,
      normalized: { weight: "0.65 kg" },
      attributes: [
        { group: "PDF datasheet", name: "Net Weight", value: "1.43 lb (0.65 kg)", sourceType: "generated", parser: "pdf-table-extractor" },
        { group: "PDF datasheet", name: "Package weight(Lbs)", value: "6.3 oz (179 g)", sourceType: "generated", parser: "pdf-table-extractor" }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.weight).toBeUndefined();
  });

  it("selects official/customer-backed values over distributor candidates and keeps conflicts", () => {
    const result = applyFieldCandidateResolution({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "partial",
      confidence: 0.72,
      normalized: {},
      attributes: [
        {
          group: "Distributor specs",
          name: "Rated voltage",
          value: "120 V AC",
          sourceUrl: "https://distributor.test/ABC-123",
          sourceType: "distributor",
          parser: "distributor",
          confidence: 0.45
        },
        {
          group: "Official datasheet",
          name: "Rated voltage",
          value: "24 V DC",
          sourceUrl: "https://example.test/ABC-123.pdf",
          sourceType: "official",
          parser: "pdf-document",
          stage: "downloaded-document-enrichment",
          confidence: 0.92
        }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    const voltage = result.diagnostics?.fieldResolutions?.find((record) => record.field === "voltage");
    expect(voltage?.selectedValue).toBe("24 V DC");
    expect(voltage?.conflictCount).toBe(1);
    expect(result.normalized.voltage).toBe("24 V DC");

    const selected = result.diagnostics?.fieldCandidates?.find((candidate) => candidate.field === "voltage" && candidate.selected);
    expect(selected?.value).toBe("24 V DC");
    expect(selected?.priorityReason).toContain("official parsed document priority");
    expect(result.confidence).toBe(0.7);
    expect(result.diagnostics?.confidencePenalty).toBe(0.02);

    // Re-running resolution in another pipeline stage must not charge the same conflict twice.
    expect(applyFieldCandidateResolution(result).confidence).toBe(0.7);
  });

  it("rejects a digit-bearing but non-quantity value from a numeric field (Phase C5)", () => {
    const base = {
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "partial" as const,
      confidence: 0.7,
      normalized: {},
      documents: [],
      sources: []
    };
    // "24 months" has a digit but is not a mass — must not become the product weight.
    const bad = applyFieldCandidateResolution({
      ...base,
      attributes: [
        { group: "Specs", name: "Weight", value: "24 months", sourceUrl: "https://example.test/x", sourceType: "official", parser: "p", confidence: 0.9 }
      ]
    } satisfies ProductResult);
    expect(bad.diagnostics?.fieldCandidates?.some((c) => c.field === "weight")).not.toBe(true);

    // A real mass value is still accepted.
    const good = applyFieldCandidateResolution({
      ...base,
      attributes: [
        { group: "Specs", name: "Weight", value: "1.2 kg", sourceUrl: "https://example.test/x", sourceType: "official", parser: "p", confidence: 0.9 }
      ]
    } satisfies ProductResult);
    expect(good.diagnostics?.fieldCandidates?.some((c) => c.field === "weight" && c.value === "1.2 kg")).toBe(true);
  });

  it("normalizes a selected raw field candidate before publishing it", () => {
    const result = applyFieldCandidateResolution({
      manufacturerId: "test",
      catalogNumber: "ABC-123",
      status: "partial",
      confidence: 0.72,
      normalized: {},
      attributes: [
        { group: "Specs", name: "Rated voltage", value: "24 VDC", sourceUrl: "https://example.test/x", sourceType: "official", parser: "generic", confidence: 0.9 }
      ],
      documents: [],
      sources: []
    } satisfies ProductResult);

    expect(result.normalized.voltage).toBe("24 V DC");
  });
});
