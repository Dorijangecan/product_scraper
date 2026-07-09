import { describe, expect, it } from "vitest";
import {
  extractElectricalSpecAttributesFromText,
  extractInlineNameplateSpecAttributes,
  extractOntologySpecAttributesFromText
} from "../src/server/scrapers/electrical-spec-miner.js";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";
import { normalizeTechnicalAttributes } from "../src/server/scrapers/technical-attributes.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";

describe("electrical spec miner", () => {
  it("extracts electrical specs from dense prose without table markup", () => {
    const attributes = extractElectricalSpecAttributesFromText({
      sourceUrl: "https://example.test/datasheet",
      text: [
        "Electrical data Supply voltage range 18...30 V DC",
        "Load current 2 A",
        "Current draw @ 24 V DC 40 mA",
        "Module power dissipation 1.5 W",
        "Short Circuit Current Rating (SCCR) 10 kA"
      ].join(" ")
    });
    const technical = normalizeTechnicalAttributes("unknown-maker", attributes);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Supply voltage range", value: "18...30 V DC" }),
        expect.objectContaining({ name: "Current draw @ 24 V DC", value: "40 mA" })
      ])
    );
    expect(new Set(technical.map((item) => item.canonicalKey))).toEqual(
      new Set(["ratedVoltage", "ratedCurrent", "currentConsumption", "powerLoss", "breakingCapacity"])
    );
    expect(technical.find((item) => item.canonicalKey === "ratedVoltage")?.quantities?.[0]).toMatchObject({
      kind: "voltage",
      min: 18,
      max: 30
    });
    expect(technical.find((item) => item.canonicalKey === "currentConsumption")?.quantities?.[0]).toMatchObject({
      kind: "current",
      value: 40,
      unit: "mA"
    });
    expect(technical.find((item) => item.canonicalKey === "powerLoss")?.quantities?.[0]).toMatchObject({
      kind: "power",
      value: 1.5,
      unit: "W"
    });
  });

  it("keeps min/max ranges and voltage alternatives together", () => {
    const attributes = extractElectricalSpecAttributesFromText({
      sourceUrl: "https://example.test/datasheet",
      text: [
        "Electrical ratings Supply voltage min. 18 V max. 30 V DC;",
        "Auxiliary voltage 24 V DC / 120 V AC;",
        "Power loss per pole min. 1.2 W max. 1.8 W"
      ].join(" ")
    });

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Supply voltage", value: "18...30 V DC" }),
        expect.objectContaining({ name: "Auxiliary voltage", value: "24 V DC / 120 V AC" }),
        expect.objectContaining({ name: "Power loss per pole", value: "1.2...1.8 W" })
      ])
    );
  });

  it("feeds mined electrical specs through the generic page parser", () => {
    const result = parseGenericProductPage(
      "unknown-maker",
      "ABC-123",
      fetched(`
        <html>
          <head><title>ABC-123 compact controller</title></head>
          <body>
            <h1>ABC-123 compact controller</h1>
            <p>ABC-123</p>
            <section>
              Electrical specifications:
              module supply voltage 24 V DC; current consumption max. 55 mA;
              power loss [W] / maximum 2.3 W; output current rating 500 mA.
            </section>
          </body>
        </html>
      `),
      "official-fallback",
      "test-generic"
    );
    const technical = normalizeTechnicalAttributes("unknown-maker", result.attributes, result.sources);

    expect(technical.map((item) => item.canonicalKey)).toEqual(
      expect.arrayContaining(["ratedVoltage", "currentConsumption", "powerLoss", "ratedCurrent"])
    );
  });
});

describe("inline nameplate spec miner (extractInlineNameplateSpecAttributes)", () => {
  const sourceUrl = "file:///feedback.xlsx";

  it("extracts unlabeled comma-separated nameplate ratings from an English drive description", () => {
    const attributes = extractInlineNameplateSpecAttributes(
      "3AC 380VAC, 0.75KW, 3.0A, Panel,DI PNP，DO PNP，AI(4-20mA)，W/O EMC filter",
      sourceUrl
    );

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "3~ 380 V AC" }),
        expect.objectContaining({ name: "Rated power", value: "0.75 kW" }),
        expect.objectContaining({ name: "Rated current", value: "3.0 A" })
      ])
    );
    // "AI(4-20mA)" is an analog-input signal range, not a rating — must never leak in.
    expect(attributes.some((attr) => /mA/.test(attr.value))).toBe(false);
  });

  it("extracts ratings from a Chinese description with fullwidth separators", () => {
    const attributes = extractInlineNameplateSpecAttributes(
      "3AC 230V, 5.5kW, 20A, 无内置直流电抗器, 内置制动斩波器, Profibus DP",
      sourceUrl
    );

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "3~ 230 V" }),
        expect.objectContaining({ name: "Rated power", value: "5.5 kW" }),
        expect.objectContaining({ name: "Rated current", value: "20 A" })
      ])
    );
  });

  it("keeps decimal commas intact and accepts frequency segments", () => {
    const attributes = extractInlineNameplateSpecAttributes("1AC 230V, 2,2kW, 50/60Hz, 12A", sourceUrl);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "1~ 230 V" }),
        expect.objectContaining({ name: "Rated power", value: "2,2 kW" }),
        expect.objectContaining({ name: "Frequency", value: "50/60 Hz" }),
        expect.objectContaining({ name: "Rated current", value: "12 A" })
      ])
    );
  });

  it("reads the 3x/phase-word/multiplication notations with tolerance, HP and IP extras", () => {
    const attributes = extractInlineNameplateSpecAttributes("3x400V ±10%, 50/60Hz, 7.5HP, IP20", sourceUrl);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "3~ 400 V ±10%" }),
        expect.objectContaining({ name: "Frequency", value: "50/60 Hz" }),
        expect.objectContaining({ name: "Rated power", value: "7.5 HP" }),
        expect.objectContaining({ name: "Degree of protection", value: "IP20" })
      ])
    );
  });

  it("reads type-before-number DC notation", () => {
    const attributes = extractInlineNameplateSpecAttributes("DC 24V, 2.5A, 60W", sourceUrl);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "24 V DC" }),
        expect.objectContaining({ name: "Rated current", value: "2.5 A" }),
        expect.objectContaining({ name: "Rated power", value: "60 W" })
      ])
    );
  });

  it("reads Siemens-style ranges with the phase marker after the value", () => {
    const attributes = extractInlineNameplateSpecAttributes("380-480 V 3 AC, 50/60 Hz, 11 kW", sourceUrl);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "3~ 380...480 V" }),
        expect.objectContaining({ name: "Rated power", value: "11 kW" })
      ])
    );
  });

  it("reads unit-on-both-ends ranges, dual voltages and voltage+frequency pairs", () => {
    expect(extractInlineNameplateSpecAttributes("380V-480V, 18.5kW", sourceUrl)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Rated voltage", value: "380...480 V" })])
    );
    // voltage + frequency alone is a credible nameplate even without current/power
    expect(extractInlineNameplateSpecAttributes("230/400V, 50Hz", sourceUrl)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "230/400 V" }),
        expect.objectContaining({ name: "Frequency", value: "50 Hz" })
      ])
    );
  });

  it("reads Chinese phase words plus temperature-range and weight extras", () => {
    const attributes = extractInlineNameplateSpecAttributes(
      "三相 380V, 15kW, 32A, IP54, -10~+50℃, 12kg",
      sourceUrl
    );

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "3~ 380 V" }),
        expect.objectContaining({ name: "Rated power", value: "15 kW" }),
        expect.objectContaining({ name: "Rated current", value: "32 A" }),
        expect.objectContaining({ name: "Degree of protection", value: "IP54" }),
        expect.objectContaining({ name: "Operating temperature", value: "-10...+50 °C" }),
        expect.objectContaining({ name: "Weight", value: "12 kg" })
      ])
    );
  });

  it("reads pipe- and bullet-separated cells, as often used instead of commas in PDF tables", () => {
    expect(extractInlineNameplateSpecAttributes("3AC 400V | 15kW | 32A | IP54", sourceUrl)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "3~ 400 V" }),
        expect.objectContaining({ name: "Rated power", value: "15 kW" }),
        expect.objectContaining({ name: "Rated current", value: "32 A" }),
        expect.objectContaining({ name: "Degree of protection", value: "IP54" })
      ])
    );
    expect(extractInlineNameplateSpecAttributes("230V • 50Hz • 16A", sourceUrl)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "230 V" }),
        expect.objectContaining({ name: "Frequency", value: "50 Hz" }),
        expect.objectContaining({ name: "Rated current", value: "16 A" })
      ])
    );
  });

  it("reads apparent power and duty-class parenthetical qualifiers", () => {
    const attributes = extractInlineNameplateSpecAttributes("1AC 230V, 3kVA, 13A(HD)", sourceUrl);

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "1~ 230 V" }),
        expect.objectContaining({ name: "Rated apparent power", value: "3 kVA" }),
        expect.objectContaining({ name: "Rated current", value: "13 A" })
      ])
    );
  });

  it("requires at least two electrical ratings on the same line before emitting anything", () => {
    expect(extractInlineNameplateSpecAttributes("The device draws 20 A, and is very robust", sourceUrl)).toEqual([]);
    expect(extractInlineNameplateSpecAttributes("AI(4-20mA), AO(0-10V), Modbus RTU", sourceUrl)).toEqual([]);
    // Signal levels below 10 V are I/O ranges, not supply ratings.
    expect(extractInlineNameplateSpecAttributes("0-10V, 20A, relay output", sourceUrl)).toEqual([]);
  });

  it("ignores unit-like tokens glued inside catalog codes", () => {
    expect(extractInlineNameplateSpecAttributes("DV1-342D5PB-C20AL1, CDV00301, accessories", sourceUrl)).toEqual([]);
  });

  it("runs as part of extractElectricalSpecAttributesFromText for document text", () => {
    const attributes = extractElectricalSpecAttributesFromText({
      sourceUrl,
      text: "DF1-34020FB-C20 variable frequency drive\n3AC 230V, 5.5kW, 20A, Profibus DP\nSafety instructions apply."
    });

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Rated voltage", value: "3~ 230 V" }),
        expect.objectContaining({ name: "Rated current", value: "20 A" }),
        expect.objectContaining({ name: "Rated power", value: "5.5 kW" })
      ])
    );
  });
});

describe("ontology spec miner (extractOntologySpecAttributesFromText)", () => {
  it("mines non-electrical quantities directly from prose using the property ontology", () => {
    const attributes = extractOntologySpecAttributesFromText({
      sourceUrl: "https://example.test/datasheet",
      text: [
        "Mechanical data Weight 5 kg",
        "Tightening torque 2.5 Nm",
        "Operating temperature -25...70 °C"
      ].join(" ")
    });

    expect(attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Weight", value: "5 kg" }),
        expect.objectContaining({ name: "Tightening torque", value: "2.5 Nm" }),
        expect.objectContaining({ name: "Operating temperature", value: "-25...70 °C" })
      ])
    );
  });

  it("does not duplicate properties already covered by the hand-tuned electrical definitions", () => {
    // ratedVoltage/ratedCurrent/powerLoss etc. are mined by extractElectricalSpecAttributesFromText
    // already — the ontology pass must skip them to avoid conflicting/duplicate facts.
    const attributes = extractOntologySpecAttributesFromText({
      sourceUrl: "https://example.test/datasheet",
      text: "Rated voltage 24 V DC. Rated current 2 A. Power loss 1.2 W."
    });

    expect(attributes.some((attr) => /voltage/i.test(attr.name))).toBe(false);
    expect(attributes.some((attr) => /^rated current$/i.test(attr.name))).toBe(false);
    expect(attributes.some((attr) => /power loss/i.test(attr.name))).toBe(false);
  });

  it("stops an electrical value at the boundary of an ontology-only label and vice versa", () => {
    const text = "Rated voltage 24 V DC Weight 5 kg Tightening torque 2.5 Nm";
    const electrical = extractElectricalSpecAttributesFromText({ sourceUrl: "https://example.test/datasheet", text });
    const ontology = extractOntologySpecAttributesFromText({ sourceUrl: "https://example.test/datasheet", text });

    expect(electrical).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Rated voltage", value: "24 V DC" })]));
    expect(ontology).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Weight", value: "5 kg" }),
        expect.objectContaining({ name: "Tightening torque", value: "2.5 Nm" })
      ])
    );
    // None of the values should have bled into a neighbouring label's text.
    for (const attr of [...electrical, ...ontology]) {
      expect(attr.value).not.toMatch(/Weight|Torque|Rated voltage/i);
    }
  });
});

function fetched(text: string): FetchedText {
  return {
    requestedUrl: "https://example.test/product/ABC-123",
    effectiveUrl: "https://example.test/product/ABC-123",
    text,
    contentType: "text/html",
    statusCode: 200,
    fetchedAt: "2026-06-23T00:00:00.000Z",
    fromCache: false
  };
}
