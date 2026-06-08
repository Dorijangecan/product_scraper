import { describe, expect, it } from "vitest";
import { comparePdtValues, valuesEquivalent } from "../src/server/pdt/pdt-compare.js";

describe("PDT value comparison (eval precision)", () => {
  it("treats numeric and range-format differences as equal", () => {
    expect(valuesEquivalent("0.1", "0.10")).toBe(true);
    expect(valuesEquivalent("0.10 kg", "0.1 kg")).toBe(true);
    expect(valuesEquivalent("24-60", "24...60")).toBe(true);
    expect(valuesEquivalent("AC/DC", "ac/dc")).toBe(true);
  });

  it("flags genuinely different values", () => {
    expect(valuesEquivalent("24-60", "24-90")).toBe(false);
    expect(valuesEquivalent("IP20", "IP40")).toBe(false);
    expect(valuesEquivalent("0.1", "0.2")).toBe(false);
  });

  it("computes precision, coverage and actionable diffs", () => {
    const manual = [
      { article: "CBE04417", sheet: "contactor a. fuses", column: "AAC820", value: "-25" },
      { article: "CBE04417", sheet: "contactor a. fuses", column: "AAF726", value: "40" },
      { article: "CBE04417", sheet: "Material Master Data", column: "AAF040", value: "0.08" }
    ];
    const generated = [
      { article: "CBE04417", sheet: "contactor a. fuses", column: "AAC820", value: "-25" }, // match
      { article: "CBE04417", sheet: "contactor a. fuses", column: "AAF726", value: "63" }, // mismatch
      { article: "CBE04417", sheet: "Material Master Data", column: "BAB577", value: "71.9" } // generated-only
      // AAF040 is manual-only (we missed it)
    ];
    const summary = comparePdtValues(manual, generated);
    expect(summary.match).toBe(1);
    expect(summary.mismatch).toBe(1);
    expect(summary.generatedOnly).toBe(1);
    expect(summary.manualOnly).toBe(1);
    expect(summary.precision).toBe(0.5);
    expect(summary.diffs.some((diff) => diff.status === "mismatch" && diff.column === "AAF726")).toBe(true);
    expect(summary.diffs.some((diff) => diff.status === "manual-only" && diff.column === "AAF040")).toBe(true);
  });
});
