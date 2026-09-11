import { describe, expect, it } from "vitest";
import { detectCohortAnomalies } from "../src/server/scrapers/cohort-anomaly.js";
import type { ProductResult } from "../src/shared/types.js";

function product(
  catalogNumber: string,
  normalized: ProductResult["normalized"],
  deviceType = "Contactor",
  overrides: Partial<ProductResult> = {}
): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber,
    status: "found",
    confidence: 0.9,
    title: `Test ${catalogNumber}`,
    normalized,
    attributes: [{ group: "General", name: "Product Type", value: deviceType, sourceType: "official" }],
    documents: [],
    sources: [],
    ...overrides
  };
}

function contactorCohort(weights: number[]): ProductResult[] {
  return weights.map((kg, index) => product(`CAT-${index}`, { weight: `${kg} kg` }));
}

describe("detectCohortAnomalies", () => {
  it("flags a weight that is far from its device-type cohort's MAD-based median (N >= 8)", () => {
    const weights = [1.2, 1.3, 1.25, 1.28, 1.22, 1.31, 1.27, 1.24, 120];
    const flags = detectCohortAnomalies(contactorCohort(weights));

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ catalogNumber: "CAT-8", field: "weight", value: 120, unit: "kg", deviceType: "Contactor" });
    expect(Math.abs(flags[0].robustZScore)).toBeGreaterThanOrEqual(3.5);
  });

  it("does not flag normal variation within a tight but plausible range", () => {
    const weights = [1.2, 1.3, 1.25, 1.28, 1.22, 1.31, 1.27, 1.24, 1.35, 1.18];
    expect(detectCohortAnomalies(contactorCohort(weights))).toEqual([]);
  });

  it("falls back to an order-of-magnitude check for small cohorts (< 8 items)", () => {
    const weights = [1.2, 1.3, 1.25, 65];
    const flags = detectCohortAnomalies(contactorCohort(weights));
    expect(flags).toHaveLength(1);
    expect(flags[0].catalogNumber).toBe("CAT-3");
  });

  it("does not flag a small cohort's mild variation via the order-of-magnitude fallback", () => {
    const weights = [1.2, 1.3, 1.8];
    expect(detectCohortAnomalies(contactorCohort(weights))).toEqual([]);
  });

  it("handles a zero-MAD cohort (mostly identical values) via the order-of-magnitude fallback", () => {
    const weights = [1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 45];
    const flags = detectCohortAnomalies(contactorCohort(weights));
    expect(flags).toHaveLength(1);
    expect(flags[0].catalogNumber).toBe("CAT-8");
  });

  it("does not cross-contaminate cohorts across different device types", () => {
    const contactors = contactorCohort([1.2, 1.3, 1.25, 1.28, 1.22, 1.31, 1.27, 1.24]);
    const sensors = [0.05, 0.06, 0.055, 0.052].map((kg, index) => product(`SEN-${index}`, { weight: `${kg} kg` }, "Sensor"));
    expect(detectCohortAnomalies([...contactors, ...sensors])).toEqual([]);
  });

  it("never flags a strictly-positive field's small cohort as a false negative gate — skips below 3 valid entries", () => {
    const cohort = [product("A", { weight: "1.2 kg" }), product("B", { weight: "900 kg" })];
    expect(detectCohortAnomalies(cohort)).toEqual([]);
  });

  it("uses MAD z-scoring (not the ratio fallback) for temperature fields, so negative values compare correctly", () => {
    const results = [-40, -39, -41, -38, -40, -42, -39, -41, 25].map((min, index) =>
      product(`T-${index}`, { operatingTemperatureMin: `${min} °C` })
    );
    const flags = detectCohortAnomalies(results);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ catalogNumber: "T-8", field: "operatingTemperatureMin", value: 25 });
  });

  it("does not apply the ratio fallback to a small temperature cohort (ratios are meaningless around/below zero)", () => {
    const results = [-40, -39, -38].map((min, index) => product(`T-${index}`, { operatingTemperatureMin: `${min} °C` }));
    expect(detectCohortAnomalies(results)).toEqual([]);
  });

  it("ignores unparsable or missing values without crashing", () => {
    const cohort = [
      product("A", { weight: "1.2 kg" }),
      product("B", {}),
      product("C", { weight: "see datasheet" }),
      product("D", { weight: "1.3 kg" })
    ];
    expect(() => detectCohortAnomalies(cohort)).not.toThrow();
    expect(detectCohortAnomalies(cohort)).toEqual([]);
  });

  it("normalizes mixed units (lb vs kg) onto the same scale before comparing", () => {
    const cohort = [
      product("A", { weight: "1.2 kg" }),
      product("B", { weight: "1.3 kg" }),
      product("C", { weight: "1.25 kg" }),
      product("D", { weight: "2.6455 lb" }) // ~1.2 kg — should NOT be flagged once converted
    ];
    expect(detectCohortAnomalies(cohort)).toEqual([]);
  });
});
