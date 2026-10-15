import { describe, expect, it } from "vitest";
import { applyFieldCandidateResolution } from "../src/server/scrapers/field-candidates.js";
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
