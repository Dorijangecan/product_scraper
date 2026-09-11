import { describe, expect, it } from "vitest";
import { buildFieldCoverageMatrixRow, detectFieldCoverageDrift, fieldCoverageSnapshot } from "../src/server/scrapers/field-coverage-drift.js";
import type { ProductResult } from "../src/shared/types.js";

function result(overrides: Partial<ProductResult["normalized"]> = {}, withImage = true): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "CAT-1",
    status: "found",
    confidence: 0.9,
    normalized: { weight: "1.2 kg", voltage: "24 V", ...overrides },
    attributes: [],
    documents: withImage ? [{ type: "image", label: "Product image", url: "https://example.com/img.png" }] : [],
    sources: []
  };
}

function healthyRun(size: number): ReturnType<typeof fieldCoverageSnapshot> {
  return fieldCoverageSnapshot(Array.from({ length: size }, () => result()));
}

describe("fieldCoverageSnapshot", () => {
  it("computes fill rate per tracked field", () => {
    const results = [result({ weight: "1 kg" }), result({ weight: undefined }), result({ weight: "2 kg" })];
    const snapshot = fieldCoverageSnapshot(results);
    expect(snapshot.sampleSize).toBe(3);
    expect(snapshot.fillRate.weight).toBeCloseTo(2 / 3);
    expect(snapshot.fillRate.voltage).toBe(1);
  });

  it("returns all-zero rates for an empty result set without dividing by zero", () => {
    const snapshot = fieldCoverageSnapshot([]);
    expect(snapshot.sampleSize).toBe(0);
    expect(snapshot.fillRate.weight).toBe(0);
  });

  it("treats a document-array image as the image field, not normalized.image", () => {
    const withImage = fieldCoverageSnapshot([result({}, true)]);
    const withoutImage = fieldCoverageSnapshot([result({}, false)]);
    expect(withImage.fillRate.image).toBe(1);
    expect(withoutImage.fillRate.image).toBe(0);
  });
});

describe("detectFieldCoverageDrift", () => {
  it("flags a field whose coverage collapsed relative to this manufacturer's recent baseline", () => {
    const historical = [healthyRun(20), healthyRun(18), healthyRun(22)];
    const current = fieldCoverageSnapshot(Array.from({ length: 15 }, () => result({ weight: undefined })));

    const flags = detectFieldCoverageDrift(current, historical);

    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ field: "weight", currentFillRate: 0, baselineRunCount: 3 });
    expect(flags[0].reason).toContain("weight");
  });

  it("does not flag normal run-to-run variation", () => {
    const historical = [healthyRun(20), healthyRun(18)];
    const current = healthyRun(20);
    expect(detectFieldCoverageDrift(current, historical)).toEqual([]);
  });

  it("does not flag a field that was already sparse in the baseline", () => {
    const historical = [fieldCoverageSnapshot(Array.from({ length: 20 }, () => result({ certificates: undefined }))), fieldCoverageSnapshot(Array.from({ length: 20 }, () => result({ certificates: undefined })))];
    const current = fieldCoverageSnapshot(Array.from({ length: 20 }, () => result({ certificates: undefined })));
    expect(detectFieldCoverageDrift(current, historical)).toEqual([]);
  });

  it("requires at least 2 usable historical runs before flagging anything", () => {
    const historical = [healthyRun(20)];
    const current = fieldCoverageSnapshot(Array.from({ length: 15 }, () => result({ weight: undefined })));
    expect(detectFieldCoverageDrift(current, historical)).toEqual([]);
  });

  it("ignores historical runs too small to trust as baseline samples", () => {
    const historical = [healthyRun(20), healthyRun(2), healthyRun(1)];
    const current = healthyRun(20);
    // Only the first run is usable (n>=3), so there aren't enough usable baseline runs (< 2) — no flags.
    expect(detectFieldCoverageDrift(current, historical)).toEqual([]);
  });

  it("does not flag a run that is itself too small to trust", () => {
    const historical = [healthyRun(20), healthyRun(18)];
    const current = fieldCoverageSnapshot([result({ weight: undefined }), result({ weight: undefined })]);
    expect(detectFieldCoverageDrift(current, historical)).toEqual([]);
  });
});

describe("buildFieldCoverageMatrixRow", () => {
  it("carries current/baseline fill rates for every tracked field and lists only the drifted ones", () => {
    const historical = [healthyRun(20), healthyRun(18)];
    const current = fieldCoverageSnapshot(Array.from({ length: 15 }, () => result({ weight: undefined })));

    const row = buildFieldCoverageMatrixRow("abb", "ABB", "run-42", "2026-09-10T00:00:00.000Z", current, historical);

    expect(row).toMatchObject({ manufacturerId: "abb", canonicalName: "ABB", lastRunId: "run-42", baselineRunCount: 2 });
    expect(row.driftFields).toEqual(["weight"]);
    expect(row.fillRate.weight).toBe(0);
    expect(row.baselineFillRate.weight).toBe(1);
    // Fields the caller isn't worried about still carry real numbers, not just the flagged one.
    expect(row.fillRate.voltage).toBe(1);
    expect(row.baselineFillRate.voltage).toBe(1);
  });

  it("reports zero baseline runs and zero baseline rates when there is no usable history yet", () => {
    const row = buildFieldCoverageMatrixRow("abb", "ABB", "run-1", "2026-09-10T00:00:00.000Z", healthyRun(10), []);
    expect(row.baselineRunCount).toBe(0);
    expect(row.baselineFillRate.weight).toBe(0);
    expect(row.driftFields).toEqual([]);
  });
});
