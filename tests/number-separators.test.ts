import { describe, expect, it } from "vitest";
import { normalizeNumberSeparators, stripHtmlMarkup } from "../src/server/text-util.js";
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

/**
 * The dimension paths in normalizer.ts used a bare `Number(token.replace(",", "."))`, so a
 * thousands-separated dimension was silently divided by a thousand — a 1200 mm enclosure width read as
 * "1.2 mm". Weight had already adopted normalizeNumberSeparators; dimensions never did.
 */
describe("dimension parsing regression (thousands separator must not divide by 1000)", () => {
  it("keeps a labeled width of 1,200 mm as 1200, not 1.2", () => {
    const normalized = normalizeFields([{ name: "Dimensions", value: "H 2,000 mm W 1,200 mm D 400 mm" }], []);
    expect(normalized.dimensions).toBeTruthy();
    expect(normalized.dimensions).not.toMatch(/\b1\.2\b/);
    expect(normalized.dimensions).not.toMatch(/\b2\b\s*mm/);
    expect(normalized.dimensions).toMatch(/1200|1,200/);
  });

  it("still reads a European comma DECIMAL as a decimal", () => {
    // "12,5" is 12.5 — the fix must not turn every comma into a thousands separator.
    const normalized = normalizeFields([{ name: "Dimensions", value: "H 12,5 mm W 30 mm D 40 mm" }], []);
    expect(normalized.dimensions ?? "").toMatch(/12\.5|12,5/);
  });

  it("converts a 1,200 cm dimension chain without losing the magnitude", () => {
    const normalized = normalizeFields([{ name: "Dimensions", value: "1,200 x 800 x 300 cm" }], []);
    expect(normalized.dimensions ?? "").not.toMatch(/\b12\b\s*mm/);
  });
});

/**
 * Specs increasingly arrive as strings inside an embedded JSON blob rather than as DOM nodes, so
 * cheerio's text extraction never cleans them: a real Schmersal page produced the attribute NAME
 * `Rated impulse withstand voltage U<sub>imp</sub>`, markup and all, which would have shipped to Excel
 * verbatim. See fixtures/schmersal-101195901-page.
 */
describe("stripHtmlMarkup", () => {
  it("removes tags that leaked in from embedded JSON", () => {
    expect(stripHtmlMarkup("Rated impulse withstand voltage U<sub>imp</sub>")).toBe("Rated impulse withstand voltage Uimp");
    expect(stripHtmlMarkup("Rated insulation voltage U<sub>i</sub>")).toBe("Rated insulation voltage Ui");
    expect(stripHtmlMarkup("<b>Weight</b>")).toBe("Weight");
    // A <br> is a structural break, so it becomes a space — unlike <sub>, which sits inside a token.
    expect(stripHtmlMarkup("24 V<br/>DC")).toBe("24 V DC");
    expect(stripHtmlMarkup("<td>Weight</td><td>1.5 kg</td>")).toBe("Weight 1.5 kg");
  });

  it("decodes the entities that appear in spec text", () => {
    expect(stripHtmlMarkup("Temperature &deg;C")).toBe("Temperature °C");
    expect(stripHtmlMarkup("Cross-section 2.5 mm&sup2;")).toBe("Cross-section 2.5 mm²");
    expect(stripHtmlMarkup("Voltage &plusmn;10%")).toBe("Voltage ±10%");
    expect(stripHtmlMarkup("Contacts &amp; terminals")).toBe("Contacts & terminals");
    expect(stripHtmlMarkup("-25&#176;C")).toBe("-25°C");
    expect(stripHtmlMarkup("-25&#x00B0;C")).toBe("-25°C");
  });

  it("never eats a threshold qualifier", () => {
    // The tag pattern requires a LETTER after "<", so comparison operators survive. Losing one of these
    // would be a worse bug than the markup it is cleaning up.
    expect(stripHtmlMarkup("< 5 mA")).toBe("< 5 mA");
    expect(stripHtmlMarkup("<= 10 ms")).toBe("<= 10 ms");
    expect(stripHtmlMarkup("> 1 MΩ")).toBe("> 1 MΩ");
    expect(stripHtmlMarkup("<0.5 W")).toBe("<0.5 W");
  });

  it("leaves ordinary text untouched", () => {
    expect(stripHtmlMarkup("Rated current")).toBe("Rated current");
    expect(stripHtmlMarkup("")).toBe("");
  });
});
