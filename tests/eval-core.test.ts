import { describe, expect, it } from "vitest";
import type { ProductResult } from "../src/shared/types.js";
import {
  collectEmittedValues,
  evalExitCode,
  evaluateCase,
  findContamination,
  leadingNumber,
  matchesExpectedValue,
  summarizeEval
} from "../scripts/eval-core.js";

function resultWith(overrides: Partial<ProductResult>): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "ABC-123",
    status: "found",
    confidence: 0.8,
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    ...overrides
  };
}

const CASE = { id: "case-1", note: "guards something" };

describe("leadingNumber", () => {
  it("reads plain and European decimals", () => {
    expect(leadingNumber("1.5 kg")).toBe(1.5);
    expect(leadingNumber("1,5 kg")).toBe(1.5);
    expect(leadingNumber("0.22 kg")).toBe(0.22);
    expect(leadingNumber("-25 °C")).toBe(-25);
  });

  it("does not turn a thousands separator into a decimal", () => {
    // The number-separator trap this repo has hit before: "1,050.00 lbs" must not become 1.05.
    expect(leadingNumber("1,050.00 lbs")).toBe(1050);
    expect(leadingNumber("1,200 mm")).toBe(1200);
  });

  it("returns undefined when there is no number", () => {
    expect(leadingNumber("stainless steel")).toBeUndefined();
  });
});

describe("matchesExpectedValue", () => {
  it("compares exact values ignoring case and spacing", () => {
    expect(matchesExpectedValue("IP 20", "ip20").matched).toBe(false);
    expect(matchesExpectedValue(" IP20 ", "ip20").matched).toBe(true);
  });

  it("supports contains and numeric tolerance", () => {
    expect(matchesExpectedValue("230/400 V", { contains: "230" }).matched).toBe(true);
    expect(matchesExpectedValue("1,5 kg", { number: 1.5, unit: "kg" }).matched).toBe(true);
    expect(matchesExpectedValue("1500 kg", { number: 1.5, unit: "kg" }).matched).toBe(false);
  });

  it("rejects a numeric match whose unit is wrong", () => {
    expect(matchesExpectedValue("1.5 lbs", { number: 1.5, unit: "kg" }).matched).toBe(false);
  });

  it("treats absent as a first-class assertion", () => {
    // The deterministic principle: "unknown stays empty" has to be testable.
    expect(matchesExpectedValue(undefined, { absent: true }).matched).toBe(true);
    expect(matchesExpectedValue("   ", { absent: true }).matched).toBe(true);
    expect(matchesExpectedValue("and", { absent: true }).matched).toBe(false);
  });

  it("reports a missing value distinctly from a wrong one", () => {
    expect(matchesExpectedValue(undefined, "1.5 kg").detail).toBe("no value extracted");
    expect(matchesExpectedValue("2.0 kg", "1.5 kg").detail).toBe("exact value differs");
  });
});

describe("collectEmittedValues", () => {
  it("includes raw attributes, not just normalized fields", () => {
    // Contamination that never reaches `normalized` still ships to the Attributes sheet and PDT.
    const values = collectEmittedValues(
      resultWith({
        title: "Widget",
        normalized: { weight: "1.5 kg" },
        attributes: [{ name: "Sibling", value: "CBE03320" }]
      })
    );
    expect(values.map((value) => value.origin)).toEqual(["title", "normalized", "attribute"]);
  });

  it("skips empty values", () => {
    const values = collectEmittedValues(resultWith({ normalized: { weight: "  " }, attributes: [{ name: "x", value: "" }] }));
    expect(values).toHaveLength(0);
  });
});

describe("findContamination", () => {
  it("flags a sibling catalog number in any emitted value", () => {
    const values = collectEmittedValues(resultWith({ attributes: [{ name: "Row", value: "2 E6-2/1/B CBE03320 12" }] }));
    const findings = findContamination(values, ["CBE03320"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "contaminated", field: "attribute:Row" });
  });

  it("matches across separator differences", () => {
    const values = collectEmittedValues(resultWith({ attributes: [{ name: "Row", value: "cbe 03320" }] }));
    expect(findContamination(values, ["CBE03320"])).toHaveLength(1);
  });

  it("does not flag a short token by its compacted form", () => {
    // Compact matching is only safe for tokens long enough not to collide with ordinary text.
    const values = collectEmittedValues(resultWith({ attributes: [{ name: "Material", value: "A B C" }] }));
    expect(findContamination(values, ["abc"])).toHaveLength(0);
  });

  it("reports each token once", () => {
    const values = collectEmittedValues(
      resultWith({ attributes: [{ name: "A", value: "CBE03320" }, { name: "B", value: "CBE03320" }] })
    );
    expect(findContamination(values, ["CBE03320"])).toHaveLength(1);
  });
});

describe("evaluateCase", () => {
  it("passes when values match and nothing is contaminated", () => {
    const report = evaluateCase(
      CASE,
      { normalized: { weight: { number: 0.22, unit: "kg" } }, mustNotContain: ["CBE03320"] },
      resultWith({ normalized: { weight: "0.22 kg" } })
    );
    expect(report.passed).toBe(true);
    expect(report.checks).toBe(2);
  });

  it("separates a missing value from a wrong value", () => {
    const report = evaluateCase(
      CASE,
      { normalized: { weight: "1.5 kg", current: "1 A" } },
      resultWith({ normalized: { weight: "2.5 kg" } })
    );
    expect(report.findings.map((finding) => finding.kind).sort()).toEqual(["mismatch", "missing"]);
  });

  it("does not fail for allowMissing fields, but still reports them", () => {
    const report = evaluateCase(CASE, { normalized: { weight: "1.5 kg" }, allowMissing: ["weight"] }, resultWith({}));
    expect(report.passed).toBe(true);
    expect(report.informational[0]).toContain("allowMissing");
  });

  it("still fails an allowMissing field that holds a WRONG value", () => {
    // allowMissing forgives silence, never a wrong answer.
    const report = evaluateCase(
      CASE,
      { normalized: { weight: "1.5 kg" }, allowMissing: ["weight"] },
      resultWith({ normalized: { weight: "1500 kg" } })
    );
    expect(report.passed).toBe(false);
  });

  it("flags an unexpected value where the field had to stay empty", () => {
    const report = evaluateCase(CASE, { normalized: { finish: { absent: true } } }, resultWith({ normalized: { finish: "and" } }));
    expect(report.findings[0]).toMatchObject({ kind: "unexpected-value", field: "normalized:finish" });
  });

  it("checks attributesInclude by name and value", () => {
    const report = evaluateCase(
      CASE,
      { attributesInclude: [{ name: "Matched product row", valueContains: "E6-1/1/B" }] },
      resultWith({ attributes: [{ name: "Matched product row", value: "1 E6-1/1/B CBE03319 12" }] })
    );
    expect(report.passed).toBe(true);
  });

  it("suppresses knownGaps but keeps them visible", () => {
    const report = evaluateCase(
      CASE,
      { normalized: { voltage: { contains: "230" } }, knownGaps: ["normalized:voltage"] },
      resultWith({})
    );
    expect(report.passed).toBe(true);
    expect(report.knownGapFindings).toHaveLength(1);
    expect(report.closedGaps).toEqual([]);
  });

  it("announces a knownGap that started passing", () => {
    const report = evaluateCase(
      CASE,
      { normalized: { voltage: { contains: "230" } }, knownGaps: ["normalized:voltage"] },
      resultWith({ normalized: { voltage: "230/400 V" } })
    );
    expect(report.closedGaps).toEqual(["normalized:voltage"]);
    expect(report.knownGapFindings).toHaveLength(0);
  });

  it("never lets knownGaps mask contamination of a different field", () => {
    const report = evaluateCase(
      CASE,
      { mustNotContain: ["CBE03320"], knownGaps: ["normalized:voltage"] },
      resultWith({ attributes: [{ name: "Row", value: "CBE03320" }] })
    );
    expect(report.passed).toBe(false);
  });
});

describe("summarizeEval / evalExitCode", () => {
  const failing = evaluateCase(CASE, { normalized: { weight: "1.5 kg" } }, resultWith({}));
  const passing = evaluateCase({ id: "case-2" }, { normalized: { weight: "1.5 kg" } }, resultWith({ normalized: { weight: "1.5 kg" } }));
  const empty = evaluateCase({ id: "case-3" }, {}, resultWith({}));

  it("counts cases, checks and contamination", () => {
    const summary = summarizeEval([failing, passing]);
    expect(summary).toMatchObject({ cases: 2, passed: 1, failed: 1, checks: 2 });
  });

  it("fails the run when a case asserts nothing", () => {
    // A green harness that checks nothing is worse than a red one.
    expect(evalExitCode([passing])).toBe(0);
    expect(evalExitCode([passing, empty])).toBe(1);
    expect(summarizeEval([passing, empty]).emptyCases).toEqual(["case-3"]);
  });

  it("fails the run on a hard finding", () => {
    expect(evalExitCode([failing])).toBe(1);
  });
});
