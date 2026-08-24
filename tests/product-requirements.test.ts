import { describe, expect, it } from "vitest";
import type { AttributeRecord, ProductResult } from "../src/shared/types.js";
import { requiredElectricalFields } from "../src/shared/product-requirements.js";

function product(overrides: Partial<ProductResult>): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "ABC-123",
    status: "found",
    confidence: 0.9,
    productUrl: "https://example.test/products/ABC-123",
    normalized: {},
    attributes: [],
    documents: [],
    sources: [
      {
        url: "https://example.test/products/ABC-123",
        sourceType: "official",
        parser: "fixture",
        fetchedAt: "2026-07-29T00:00:00.000Z",
        statusCode: 200
      }
    ],
    ...overrides
  };
}

describe("required electrical fields", () => {
  it("keeps a plain enclosure passive even when its page links an HMI manual and lists lit accessories", () => {
    // Real Saginaw shape: a steel box whose page links "HMI Enclosure Reinforcement Installation",
    // mines washdown-pressure prose out of a shared manual PDF, and lists lights/fans as optional
    // accessories. None of that is the product, yet each token used to promote it to a voltage
    // device — permanently failing the gate and buying a discovery round per row.
    const attributes: AttributeRecord[] = [
      { group: "Product Specifications", name: "Description", value: "EL Enclosure" },
      { group: "Installation Information", name: "Manual", value: "HMI Enclosure Reinforcement Installation" },
      { group: "PDF manual - Enclosure", name: "Feature", value: "ventilation to equalize pressure as required" },
      { group: "PDF Ontology Spec Miner", name: "Pressure", value: "0.18 psi" },
      { group: "Optional Accessories", name: "Optional Accessory", value: "SCE-LF1 - LED Light Fixture" },
      { group: "Optional Accessories", name: "Optional Accessory", value: "SCE-FA - Filter Fan" }
    ];

    expect(requiredElectricalFields(product({ description: "EL Enclosure", attributes }))).toEqual([]);
  });

  it("still requires ratings for a thermal device even though it lives in an enclosure catalog", () => {
    const result = product({
      description: "Fan Heater w/ Thermostat",
      attributes: [{ group: "Product Specifications", name: "Description", value: "Fan Heater w/ Thermostat" }]
    });

    expect(requiredElectricalFields(result)).toEqual(["voltage"]);
  });

  it("uses document evidence when the catalog PDF is the only thing describing the product", () => {
    // Eaton/ABB `CBE…` rows exist solely inside a catalogue PDF. Discarding document text for them
    // would declare every such switch-disconnector non-electrical.
    const result = product({
      catalogNumber: "CBE04417",
      description: undefined,
      title: undefined,
      attributes: [
        { group: "PDF Matched Rows", name: "Matched product row", value: "40 1 EIS-40/1 CBE04417 12" },
        { group: "PDF other - Technical Data", name: "Rated insulation voltage Ui", value: "230/240VAC & 400/415VAC" },
        { group: "PDF other - Technical Data", name: "Product", value: "switch-disconnector" }
      ]
    });

    expect(requiredElectricalFields(result)).toEqual(["current"]);
  });

  it("counts a datasheet's published rating when deciding a controller is not an unrated family page", () => {
    // The Micro820's rated voltage appears only in its PDF. Judging "are ratings published?" from
    // the filtered device-nature text made it look like a family overview with no ratings, which
    // silently dropped the device-type requirement.
    const result = product({
      catalogNumber: "2080-LC20-20QBB",
      title: "Micro820 Controller",
      description: "Micro820 Controller",
      productUrl: "https://example.test/products/family/micro820",
      attributes: [
        { group: "PDF datasheet", name: "120/240V AC", value: "Yes" },
        { group: "PDF datasheet", name: "• ACTIVE", value: "Most current offering within a product category." }
      ]
    });

    expect(requiredElectricalFields(result, {
      deviceType: "Programmable Logic Controller",
      deviceTypeConfidence: 0.99,
      deviceTypeElectricalFields: ["voltage"]
    })).toEqual(["voltage"]);
  });

  it("still reads the product's own spec attributes", () => {
    const result = product({
      description: "Inductive proximity sensor",
      attributes: [{ group: "Technical Data", name: "Sensor type", value: "inductive" }]
    });

    expect(requiredElectricalFields(result)).toEqual(["voltage"]);
  });
});
