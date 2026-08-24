import { describe, expect, it } from "vitest";
import { INCH_TO_MILLIMETER, OUNCE_TO_GRAM, OUNCE_TO_KILOGRAM, POUND_TO_GRAM, POUND_TO_KILOGRAM } from "../src/server/unit-conversion.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";

describe("imperial conversion factors", () => {
  it("are the exact definitions, not truncations", () => {
    // Three modules used to carry truncated copies (0.453592 / 453.592 / 0.0283495), so the same
    // Saginaw weight converted differently depending on which one answered.
    expect(POUND_TO_KILOGRAM).toBe(0.45359237);
    expect(POUND_TO_GRAM).toBe(453.59237);
    expect(OUNCE_TO_KILOGRAM).toBe(0.028349523125);
    expect(OUNCE_TO_GRAM).toBe(28.349523125);
    expect(INCH_TO_MILLIMETER).toBe(25.4);
    expect(POUND_TO_GRAM).toBeCloseTo(POUND_TO_KILOGRAM * 1000, 10);
    expect(OUNCE_TO_KILOGRAM * 16).toBeCloseTo(POUND_TO_KILOGRAM, 12);
  });

  it("converts a Saginaw pound weight through the normalizer without drift", () => {
    const normalized = normalizeFields(
      [{ group: "Product Specifications", name: "Est. Ship Weight", value: "28.00 lbs" }],
      []
    );
    // 28 x 0.45359237 = 12.70058636 kg exactly.
    expect(normalized.weight).toBe("28.00 lbs (12.70 kg)");
  });
});
