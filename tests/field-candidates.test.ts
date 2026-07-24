import { describe, expect, it } from "vitest";
import { applyFieldCandidateResolution } from "../src/server/scrapers/field-candidates.js";
import type { ProductResult } from "../src/shared/types.js";

describe("field candidate resolver", () => {
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
});
