import { describe, expect, it } from "vitest";
import { extractElectricalSpecAttributesFromText } from "../src/server/scrapers/electrical-spec-miner.js";
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
