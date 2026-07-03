import { describe, expect, it } from "vitest";
import { normalizeNumberSeparators } from "../src/server/text-util.js";
import { parseQuantities } from "../src/server/scrapers/quantity.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";
import { normalizePdtCellNumber } from "../src/server/pdt/unit-cleanup.js";

describe("normalizeNumberSeparators (thousands vs decimal)", () => {
  it("keeps US thousands separators (regression: 1,050.00 must not become 1.05)", () => {
    expect(normalizeNumberSeparators("1,050.00 lbs")).toBe("1050.00 lbs");
    expect(normalizeNumberSeparators("1,050 lbs")).toBe("1050 lbs");
    expect(normalizeNumberSeparators("12,345 A")).toBe("12345 A");
    expect(normalizeNumberSeparators("1,234,567")).toBe("1234567");
  });

  it("reads European comma decimals as decimals", () => {
    expect(normalizeNumberSeparators("1,5 kg")).toBe("1.5 kg");
    expect(normalizeNumberSeparators("0,25 kg")).toBe("0.25 kg");
    expect(normalizeNumberSeparators("230,4 V")).toBe("230.4 V");
  });

  it("reads European dot-thousands + comma-decimal", () => {
    expect(normalizeNumberSeparators("1.050,00 kg")).toBe("1050.00 kg");
    expect(normalizeNumberSeparators("1.234.567,89")).toBe("1234567.89");
  });

  it("leaves native dot decimals untouched", () => {
    expect(normalizeNumberSeparators("1.05")).toBe("1.05");
    expect(normalizeNumberSeparators("1050.00 lbs")).toBe("1050.00 lbs");
    expect(normalizeNumberSeparators("-40 to +80")).toBe("-40 to +80");
  });
});

describe("weight parsing regression (Saginaw SCE-90XM7818G: 1,050.00 lbs)", () => {
  it("normalizeFields keeps the 1,050 lb weight and converts it correctly", () => {
    const normalized = normalizeFields(
      [{ name: "Est. Ship Weight", value: "1,050.00 lbs" }],
      []
    );
    // Display keeps the source text; the converted kg is ~476, never 0.48.
    expect(normalized.weight).toContain("1,050.00 lbs");
    expect(normalized.weight).toContain("476");
    expect(normalized.weight).not.toContain("0.48");
  });

  it("parseQuantities reads 1,050 lb as mass 1050, not 1.05", () => {
    const [mass] = parseQuantities("1,050.00 lb", { kind: "mass" });
    expect(mass).toMatchObject({ kind: "mass", unit: "lb", value: 1050 });
  });

  it("PDT cell keeps 1,050 lb (in kg) rather than collapsing to ~0.48", () => {
    const kg = normalizePdtCellNumber("1,050.00 lbs", "kg");
    expect(Number(kg)).toBeCloseTo(476.27, 1);
  });
});
