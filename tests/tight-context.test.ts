import { describe, expect, it } from "vitest";
import { buildVariantColumnContext } from "../src/server/scrapers/tight-context.js";

const VARIANT_TABLE = [
  "Technical data",
  "Catalog Number    EIS-40/1    EIS-40/2    EIS-40/3",
  "Poles    1    2    3",
  "Weight (kg)    0.08    0.16    0.24",
  "Rated current AC-1    40    40    40",
  "Operating temperature    -25 to 60 C    -25 to 60 C    -25 to 60 C"
].join("\n");

describe("multi-variant datasheet column selection", () => {
  it("picks the column that matches the target variant", () => {
    const out = buildVariantColumnContext(VARIANT_TABLE, "EIS-40/2");
    expect(out).toBeDefined();
    expect(out).toContain("Weight (kg): 0.16");
    expect(out).toContain("Poles: 2");
    expect(out).not.toContain("0.08");
    expect(out).not.toContain("0.24");
  });

  it("picks a different column for a different variant", () => {
    const out = buildVariantColumnContext(VARIANT_TABLE, "EIS-40/1");
    expect(out).toContain("Weight (kg): 0.08");
    expect(out).not.toContain("0.16");
  });

  it("returns undefined when the table has no header listing the target variant", () => {
    expect(buildVariantColumnContext(VARIANT_TABLE, "EIS-99/9")).toBeUndefined();
  });

  it("returns undefined for non-tabular single-product text", () => {
    const single = "Weight 0.08 kg\nRated current 40 A\nOperating temperature -25 to 60 C";
    expect(buildVariantColumnContext(single, "EIS-40/1")).toBeUndefined();
  });
});
