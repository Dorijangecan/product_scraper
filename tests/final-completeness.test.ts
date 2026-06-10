import { describe, expect, it } from "vitest";
import type { ManufacturerConfig, ProductResult } from "../src/shared/types.js";
import {
  applyFinalCompletenessStatus,
  evaluateFinalCompleteness,
  finalNetworkRetryDecision,
  repairFinalCompletenessFromEvidence,
  withFinalCompletenessDiagnostics,
  withFinalCompletenessPolicy
} from "../src/server/scrapers/final-completeness.js";

const manufacturer: ManufacturerConfig = {
  id: "test",
  canonicalName: "Test",
  shortName: "TST",
  rateLimitMs: 100,
  officialBaseUrls: ["https://example.test/products"],
  fallbackSources: []
};

describe("final completeness audit", () => {
  it("retries missing core export fields without requiring passive electrical ratings", () => {
    const audit = evaluateFinalCompleteness(
      product({
        title: "ABC-123 steel enclosure",
        normalized: { certificates: "CE" },
        attributes: [{ group: "Product", name: "Catalog Description", value: "Steel enclosure" }],
        documents: []
      }),
      manufacturer
    );

    expect(audit.missing).toEqual(["image", "weight", "dimensions", "material", "color", "protection", "typeCode"]);
    expect(audit.retryMissing).toEqual(["image", "weight", "dimensions", "material", "color", "protection", "typeCode"]);
    expect(audit.notApplicable).toEqual(["voltage", "current"]);
  });

  it("retries required electrical fields for active products", () => {
    const audit = evaluateFinalCompleteness(
      product({
        title: "ABC-123 contactor",
        normalized: { weight: "1 kg", dimensions: "10 x 20 x 30 mm", material: "plastic", certificates: "CE" },
        attributes: [{ group: "Product", name: "Catalog Description", value: "Contactor" }],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/abc-123.png" }]
      }),
      manufacturer
    );

    expect(audit.missing).toEqual(["voltage", "current", "operatingTemperature", "typeCode"]);
    expect(audit.retryMissing).toEqual(["voltage", "current", "operatingTemperature", "typeCode"]);
    expect(audit.notApplicable).toEqual([]);
  });

  it("treats HMI current as not applicable when only voltage is required", () => {
    const audit = evaluateFinalCompleteness(
      product({
        manufacturerId: "rockwell",
        catalogNumber: "2715P-T7CD",
        title: "PanelView 5510 HMI operator panel",
        normalized: { weight: "1.8 kg", dimensions: "7 in", material: "plastic", certificates: "CE" },
        attributes: [{ group: "Rockwell Product Data", name: "Product Type", value: "HMI operator panel touch screen" }],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/2715p.png" }]
      }),
      manufacturer
    );

    expect(audit.missing).toEqual(["voltage", "operatingTemperature"]);
    expect(audit.retryMissing).toEqual(["voltage", "operatingTemperature"]);
    expect(audit.notApplicable).toEqual(["current"]);
    expect(audit.values.typeCode).toBe("2715P-T7CD");
  });

  it("uses device type classification to require gateway voltage without inventing a current requirement", () => {
    const audit = evaluateFinalCompleteness(
      product({
        catalogNumber: "GW-ETH-1",
        title: "Industrial Ethernet communication gateway",
        normalized: { weight: "120 g", dimensions: "100 x 25 x 75 mm", material: "plastic", certificates: "CE" },
        attributes: [{ group: "Product Data", name: "Product Type", value: "Modbus TCP to EtherNet/IP communication gateway" }],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/gw-eth-1.png" }]
      }),
      manufacturer
    );

    expect(audit.missing).toEqual(["voltage", "operatingTemperature", "typeCode"]);
    expect(audit.retryMissing).toEqual(["voltage", "operatingTemperature", "typeCode"]);
    expect(audit.notApplicable).toEqual(["current"]);
  });

  it("uses signal-device profiles to retry missing lamp color before PDT export", () => {
    const audit = evaluateFinalCompleteness(
      product({
        catalogNumber: "STACK-1",
        title: "Stack light beacon",
        normalized: {
          weight: "250 g",
          dimensions: "60 x 60 x 120 mm",
          material: "polycarbonate",
          voltage: "24 V DC",
          certificates: "CE",
          operatingTemperatureMin: "-25",
          operatingTemperatureMax: "60"
        },
        attributes: [{ group: "Product Data", name: "Product Type", value: "Stack Light / Beacon" }],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/stack-1.png" }]
      }),
      manufacturer
    );

    expect(audit.missing).toEqual(["color", "typeCode"]);
    expect(audit.retryMissing).toEqual(["color", "typeCode"]);
    expect(audit.requirements.color).toBe("preferred");
    expect(audit.notApplicable).toEqual(["current"]);
  });

  it("does not retry non-manual final fields for Rockwell Micro820 family pages", () => {
    const familyUrl = "https://www.rockwellautomation.com/en-us/products/hardware/allen-bradley/programmable-controllers/micro-controllers/micro800-family/micro820-controllers.html";
    const audit = evaluateFinalCompleteness(
      product({
        manufacturerId: "rockwell",
        catalogNumber: "2080-LC20-20AWB",
        title: "Micro820 Controller",
        description: "Micro820 Controller",
        productUrl: familyUrl,
        normalized: { weight: "0.38 kg", certificates: "UL, CE, RCM, KC, ABS, ODVA, BV, UKCA" },
        attributes: [
          { group: "Rockwell Family", name: "Product Family", value: "Micro820", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl },
          { group: "Rockwell Family", name: "Product Type", value: "Micro820 Controller", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl }
        ],
        documents: [{ type: "datasheet", label: "Technical Datasheet (EN)", url: familyUrl, sourceType: "official" }],
        sources: [{ url: familyUrl, sourceType: "official", parser: "rockwell-family-page", stage: "rockwell-family-page", fetchedAt: "2026-06-09T00:00:00.000Z" }]
      }),
      manufacturer
    );

    expect(audit.missing).toEqual([]);
    expect(audit.retryMissing).toEqual([]);
    expect(audit.notApplicable).toEqual(["image", "dimensions", "material", "voltage", "current", "operatingTemperature"]);
  });

  it("does not burn ABB contactor time retrying material after electrical data is complete", () => {
    const abbManufacturer: ManufacturerConfig = {
      ...manufacturer,
      id: "abb",
      canonicalName: "ABB",
      shortName: "ABB",
      scrapeRecipe: { qualityPolicy: { preferredFinalFields: ["material"] } }
    };
    const result = product({
      manufacturerId: "abb",
      title: "AF40 contactor box",
      normalized: {
        weight: "0.87 kg",
        dimensions: "131 x 55 x 111 mm",
        voltage: "Main Circuit 690 V",
        current: "(690 V) 40 A",
        certificates: "CE"
      },
      attributes: [
        { group: "ABB Product Data", name: "Catalog Description", value: "AF40 contactor box" },
        { group: "ABB Technical", name: "Rated Operational Current AC-1", value: "(690 V) 40 A" },
        { group: "ABB Technical", name: "Rated Operational Voltage", value: "Main Circuit 690 V" }
      ],
      documents: [{ type: "image", label: "Product image", url: "https://example.test/af40.png" }],
      diagnostics: { fallbackStages: [] },
      qualityGate: { passed: true, identityConfirmed: true, score: 100, missing: [], reason: "quality ok", attempts: [] }
    });
    const audit = evaluateFinalCompleteness(result, abbManufacturer);
    const decision = finalNetworkRetryDecision(result, abbManufacturer, audit);

    expect(audit.missing).toEqual(["material", "operatingTemperature", "typeCode"]);
    expect(audit.requirements.material).toBe("preferred");
    expect(audit.requirements.operatingTemperature).toBe("preferred");
    expect(audit.requirements.typeCode).toBe("preferred");
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain("preferred-only");
  });

  it("uses manufacturer profile policy, not built-in manufacturer IDs, to skip preferred final retries", () => {
    const profiledManufacturer: ManufacturerConfig = {
      ...manufacturer,
      id: "profiled",
      scrapeRecipe: {
        fallbackPolicy: { skipPreferredFinalCompletenessRetry: true }
      }
    };
    const result = product({
      manufacturerId: "profiled",
      title: "ABC-123 contactor",
      normalized: {
        weight: "0.5 kg",
        dimensions: "45 x 90 x 70 mm",
        material: "plastic",
        voltage: "24 V DC",
        current: "5 A",
        certificates: "CE"
      },
      attributes: [
        { group: "Product Data", name: "Product Type", value: "Contactor" },
        { group: "Electrical", name: "Rated voltage", value: "24 V DC" },
        { group: "Electrical", name: "Rated current", value: "5 A" }
      ],
      documents: [{ type: "image", label: "Product image", url: "https://example.test/abc-123.png" }],
      diagnostics: { fallbackStages: [] }
    });
    const audit = evaluateFinalCompleteness(result, profiledManufacturer);
    const decision = finalNetworkRetryDecision(result, profiledManufacturer, audit);

    expect(audit.missing).toEqual(["operatingTemperature", "typeCode"]);
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain("manufacturer profile");
  });

  it("uses manufacturer profile policy to require core final PDT fields", () => {
    const strictManufacturer: ManufacturerConfig = {
      ...manufacturer,
      id: "strict-profile",
      scrapeRecipe: {
        qualityPolicy: { requiredFinalFields: ["weight", "dimensions", "material"] }
      }
    };
    const audit = evaluateFinalCompleteness(
      product({
        manufacturerId: "strict-profile",
        title: "Remote display module",
        normalized: { certificates: "CE" },
        attributes: [{ group: "Product Data", name: "Product Type", value: "Remote display module" }],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/display.png" }]
      }),
      strictManufacturer
    );

    expect(audit.missing).toEqual(["weight", "dimensions", "material"]);
    expect(audit.requirements.weight).toBe("required");
    expect(audit.requirements.dimensions).toBe("required");
    expect(audit.requirements.material).toBe("required");
  });

  it("uses manufacturer profile policy, not built-in manufacturer IDs, for type-code fallback", () => {
    const result = product({
      manufacturerId: "profiled-typecode",
      catalogNumber: "PTC-100",
      title: "Profiled controller",
      normalized: { weight: "0.5 kg", dimensions: "45 x 90 x 70 mm", material: "plastic", certificates: "CE" },
      attributes: [{ group: "Product Data", name: "Product Type", value: "Communication Gateway" }],
      documents: [{ type: "image", label: "Product image", url: "https://example.test/ptc-100.png" }]
    });
    const defaultAudit = evaluateFinalCompleteness(result, { ...manufacturer, id: "profiled-typecode" });
    const profiledAudit = evaluateFinalCompleteness(result, {
      ...manufacturer,
      id: "profiled-typecode",
      scrapeRecipe: {
        qualityPolicy: { typeCodeFallback: "catalogNumber" }
      }
    });

    expect(defaultAudit.values.typeCode).toBeUndefined();
    expect(defaultAudit.missing).toContain("typeCode");
    expect(profiledAudit.values.typeCode).toBe("PTC-100");
    expect(profiledAudit.missing).not.toContain("typeCode");
  });

  it("does not start expensive final network retry only for image and typeCode", () => {
    const result = product({
      title: "ABC-123 contactor",
      normalized: {
        weight: "0.5 kg",
        dimensions: "45 x 90 x 70 mm",
        material: "plastic",
        voltage: "24 V DC",
        current: "5 A",
        certificates: "CE",
        operatingTemperatureMin: "-20",
        operatingTemperatureMax: "60"
      },
      attributes: [{ group: "Product Data", name: "Product Type", value: "Contactor" }],
      documents: [],
      diagnostics: { fallbackStages: [] }
    });
    const audit = evaluateFinalCompleteness(result, manufacturer);
    const decision = finalNetworkRetryDecision(result, manufacturer, audit);

    expect(audit.missing).toEqual(["image", "typeCode"]);
    expect(audit.retryMissing).toEqual(["image", "typeCode"]);
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain("final-only fields");
  });

  it("does not count a failed image download as final image coverage", () => {
    const audit = evaluateFinalCompleteness(
      product({
        title: "ABC-123 enclosure",
        normalized: { weight: "1 kg", dimensions: "10 x 20 x 30 mm", material: "steel", certificates: "CE" },
        documents: [
          {
            type: "image",
            label: "Product image",
            url: "https://example.test/abc-123.png",
            downloadStatus: "failed",
            downloadError: "HTTP 404"
          }
        ]
      }),
      manufacturer
    );

    expect(audit.missing).toContain("image");
    expect(audit.retryMissing).toContain("image");
  });

  it("adds a temporary quality policy for the missing fields only", () => {
    const strictManufacturer = withFinalCompletenessPolicy(
      {
        ...manufacturer,
        scrapeRecipe: {
          requiredDocuments: ["datasheet"],
          qualityPolicy: { requiredNormalizedFields: ["certificates"] }
        }
      },
      ["image", "weight", "dimensions", "operatingTemperature", "typeCode"]
    );

    expect(strictManufacturer.scrapeRecipe?.requiredAttributes).toEqual([
      "type code|typecode|model code|modellcode|extended product type|type designation|product main type|main type|catalog(?:ue)? type|order type|MLFB"
    ]);
    expect(strictManufacturer.scrapeRecipe?.requiredDocuments).toEqual(["datasheet", "image"]);
    expect(strictManufacturer.scrapeRecipe?.qualityPolicy?.requiredNormalizedFields).toEqual([
      "certificates",
      "weight",
      "dimensions",
      "operatingTemperatureMin",
      "operatingTemperatureMax"
    ]);
  });

  it("records before and after diagnostics", () => {
    const before = evaluateFinalCompleteness(product({ title: "ABC-123 enclosure" }), manufacturer);
    const after = evaluateFinalCompleteness(
      product({
        title: "ABC-123 enclosure",
        normalized: { weight: "1 kg", dimensions: "10 x 20 x 30 mm", material: "steel" },
        documents: [{ type: "image", label: "Product image", url: "https://example.test/abc-123.png" }]
      }),
      manufacturer
    );
    const result = withFinalCompletenessDiagnostics(product({}), before, after);

    expect(result.diagnostics?.finalCompleteness?.beforeMissing).toContain("weight");
    expect(result.diagnostics?.finalCompleteness?.retryMissing).toContain("image");
    expect(result.diagnostics?.finalCompleteness?.afterMissing).toEqual(["certificates", "color", "protection", "typeCode"]);
    expect(result.diagnostics?.finalCompleteness?.records?.some((record) => record.field === "certificates" && record.status === "missing")).toBe(true);
    expect(result.diagnostics?.notes).toContain("Final completeness still missing: certificates, color, protection, typeCode");
  });

  it("downgrades found results when required final fields are still missing", () => {
    const result = product({
      title: "ABC-123 contactor",
      normalized: { material: "plastic" },
      documents: [],
      confidence: 0.91,
      status: "found"
    });
    const audit = evaluateFinalCompleteness(result, manufacturer);
    const finalized = applyFinalCompletenessStatus(result, audit, manufacturer);

    expect(finalized.status).toBe("partial");
    expect(finalized.confidence).toBeLessThanOrEqual(0.74);
    expect(finalized.error).toContain("Final required fields missing");
    expect(finalized.diagnostics?.notes).toContain("Final required fields missing: image, voltage, current");
  });

  it("repairs missing weight, dimensions, and protection from existing raw evidence before using the network", () => {
    const result = product({
      title: "ABC-123 enclosure",
      attributes: [
        { group: "PDF datasheet", name: "Unit weight", value: "12 lb", sourceUrl: "https://example.test/abc-123.pdf", parser: "pdf-table-extractor" },
        { group: "Specs", name: "Overall size", value: "10 x 20 x 30 mm", sourceUrl: "https://example.test/products/ABC-123" },
        { group: "PDF datasheet", name: "Degree of protection", value: "IP66, NEMA Type 4X", sourceUrl: "https://example.test/abc-123.pdf", parser: "pdf-table-extractor" }
      ]
    });

    const repaired = repairFinalCompletenessFromEvidence(result, manufacturer);

    expect(repaired.repairedFields).toEqual(expect.arrayContaining(["weight", "dimensions", "protection"]));
    expect(repaired.result.normalized.weight).toBe("12 lb (5.44 kg)");
    expect(repaired.result.normalized.dimensions).toBe("10 x 20 x 30 mm");
    expect(repaired.result.normalized.protection).toContain("IP66");
    expect(repaired.result.normalized.protection).toContain("NEMA Type 4X");
    expect(repaired.result.normalized.protection).not.toContain("Type4X");
    expect(repaired.result.attributes.some((attr) => attr.group === "Final Field Repair" && attr.name === "Weight")).toBe(true);
  });

  it("does not repair missing fields when structured identity evidence belongs to another catalog", () => {
    const result = product({
      title: "ABC-123 enclosure",
      attributes: [
        { group: "Structured Data", name: "sku", value: "XYZ-999", sourceUrl: "https://example.test/products/ABC-123" },
        { group: "PDF datasheet", name: "Unit weight", value: "12 lb", sourceUrl: "https://example.test/abc-123.pdf", parser: "pdf-table-extractor" },
        { group: "Specs", name: "Overall size", value: "10 x 20 x 30 mm", sourceUrl: "https://example.test/products/ABC-123" }
      ]
    });

    const repaired = repairFinalCompletenessFromEvidence(result, manufacturer);

    expect(repaired.repairedFields).toEqual([]);
    expect(repaired.result.normalized.weight).toBeUndefined();
    expect(repaired.result.normalized.dimensions).toBeUndefined();
    expect(repaired.result.attributes.some((attr) => attr.group === "Final Field Repair")).toBe(false);
  });

  it("does not repair current or dimensions from lifetime and cable cross-section text", () => {
    const result = product({
      title: "ABC-123 industrial contactor",
      attributes: [
        {
          group: "PDF datasheet - Environmental conditions",
          name: "MTTF (40 °C)",
          value: "1000 a",
          sourceUrl: "https://example.test/abc-123.pdf",
          parser: "pdf-table-extractor"
        },
        {
          group: "Balluff Digital Product Passport",
          name: "Resolution",
          value: "multi turn [bit]; PVC grey, 4x2x0.14 mm²",
          sourceUrl: "https://example.test/products/ABC-123"
        }
      ]
    });

    const repaired = repairFinalCompletenessFromEvidence(result, manufacturer);

    expect(repaired.repairedFields).not.toContain("current");
    expect(repaired.repairedFields).not.toContain("dimensions");
    expect(repaired.result.normalized.current).toBeUndefined();
    expect(repaired.result.normalized.dimensions).toBeUndefined();
  });

  it("uses ontology-driven final fields for product color and type code", () => {
    const audit = evaluateFinalCompleteness(
      product({
        title: "ABC-123 steel enclosure",
        normalized: {
          weight: "1 kg",
          dimensions: "10 x 20 x 30 mm",
          material: "steel",
          color: "ANSI-61 gray",
          protection: "IP66",
          certificates: "CE"
        },
        attributes: [
          { group: "Product", name: "Catalog Description", value: "Steel enclosure" },
          { group: "ABB Product Data", name: "Extended Product Type", value: "ENC-123" }
        ],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/abc-123.png" }]
      }),
      manufacturer
    );

    expect(audit.missing).toEqual([]);
    expect(audit.values.color).toBe("ANSI-61 gray");
    expect(audit.values.protection).toBe("IP66");
    expect(audit.values.typeCode).toBe("ENC-123");
    expect(audit.requirements.color).toBe("preferred");
    expect(audit.requirements.protection).toBe("preferred");
    expect(audit.requirements.typeCode).toBe("preferred");
  });

  it("treats operating temperature as an ontology-driven final field for active devices", () => {
    const audit = evaluateFinalCompleteness(
      product({
        title: "ABC-123 inductive proximity sensor",
        normalized: {
          weight: "80 g",
          dimensions: "M12 x 50 mm",
          material: "brass",
          voltage: "10...30 V DC",
          current: "200 mA",
          certificates: "CE",
          operatingTemperatureMin: "-25",
          operatingTemperatureMax: "70"
        },
        attributes: [
          { group: "General", name: "Product Type", value: "Inductive proximity sensor" },
          { group: "Product Data", name: "Type Code", value: "BES-123" }
        ],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/bes-123.png" }]
      }),
      manufacturer
    );

    expect(audit.missing).toEqual([]);
    expect(audit.values.operatingTemperature).toBe("-25..70 °C");
    expect(audit.values.typeCode).toBe("BES-123");
  });

  it("skips the final network retry when all useful fallback stages already ran", () => {
    const result = product({
      title: "ABC-123 enclosure",
      diagnostics: {
        fallbackStages: ["discovery-search", "reader", "browser"],
        discoveredCandidates: [{ url: "https://example.test/products/ABC-123", score: 90, reason: "fixture" }]
      }
    });
    const audit = evaluateFinalCompleteness(result, manufacturer);
    const decision = finalNetworkRetryDecision(result, manufacturer, audit);

    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain("Skipped duplicate");
    expect(decision.triedStages).toEqual(["discovery", "reader", "browser"]);
  });
});

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
        fetchedAt: "2026-05-24T00:00:00.000Z",
        statusCode: 200
      }
    ],
    ...overrides
  };
}
