import { describe, expect, it } from "vitest";
import { classifyDeviceType } from "../src/server/scrapers/device-type.js";
import type { ProductResult } from "../src/shared/types.js";

function product(attributes: ProductResult["attributes"], title = "Test product"): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "TEST-1",
    status: "found",
    confidence: 0.9,
    title,
    normalized: {},
    attributes,
    documents: [],
    sources: []
  };
}

describe("device type classifier", () => {
  it("uses explicit manufacturer product type before weaker text", () => {
    const result = product(
      [
        { group: "General specifications", name: "Product Type", value: "Contactor", sourceType: "official" },
        { group: "Product specifications", name: "Connector type", value: "Screw terminals", sourceType: "official" }
      ],
      "IEC control device with screw terminals"
    );

    expect(classifyDeviceType(result)).toMatchObject({
      type: "Contactor",
      evidence: "Product Type: Contactor"
    });
  });

  it("classifies common automation and sensor terms from precise attributes", () => {
    expect(
      classifyDeviceType(
        product([{ group: "Main", name: "Product or Component Type", value: "Programmable logic controller", sourceType: "official" }])
      ).type
    ).toBe("Programmable Logic Controller");

    expect(
      classifyDeviceType(
        product([{ group: "Balluff Key features", name: "Principle of operation", value: "Photoelectric sensor", sourceType: "official" }])
      ).type
    ).toBe("Photoelectric Sensor");
  });

  it("leaves type empty when evidence is only a model code", () => {
    expect(
      classifyDeviceType(product([{ group: "Structured Data", name: "alternateName", value: "BOS 18M-PA-IE21-S4", sourceType: "official" }])).type
    ).toBeUndefined();
  });
});
