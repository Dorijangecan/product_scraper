import { describe, expect, it } from "vitest";
import { extractElectricalSpecAttributesFromText, extractOntologySpecAttributesFromText } from "../src/server/scrapers/electrical-spec-miner.js";
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
