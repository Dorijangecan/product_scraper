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

    expect(audit.missing).toEqual(["image", "weight", "dimensions", "material"]);
    expect(audit.retryMissing).toEqual(["image", "weight", "dimensions", "material"]);
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

    expect(audit.missing).toEqual(["voltage", "current"]);
    expect(audit.retryMissing).toEqual(["voltage", "current"]);
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

    expect(audit.missing).toEqual(["voltage"]);
    expect(audit.retryMissing).toEqual(["voltage"]);
    expect(audit.notApplicable).toEqual(["current"]);
  });

  it("does not burn ABB contactor time retrying material after electrical data is complete", () => {
    const abbManufacturer: ManufacturerConfig = { ...manufacturer, id: "abb", canonicalName: "ABB", shortName: "ABB" };
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

    expect(audit.missing).toEqual(["material"]);
    expect(audit.requirements.material).toBe("preferred");
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain("preferred-only");
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
      ["image", "weight", "dimensions"]
    );

    expect(strictManufacturer.scrapeRecipe?.requiredDocuments).toEqual(["datasheet", "image"]);
    expect(strictManufacturer.scrapeRecipe?.qualityPolicy?.requiredNormalizedFields).toEqual([
      "certificates",
      "weight",
      "dimensions"
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
    expect(result.diagnostics?.finalCompleteness?.afterMissing).toEqual(["certificates"]);
    expect(result.diagnostics?.finalCompleteness?.records?.some((record) => record.field === "certificates" && record.status === "missing")).toBe(true);
    expect(result.diagnostics?.notes).toContain("Final completeness still missing: certificates");
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

  it("repairs missing weight and dimensions from existing raw evidence before using the network", () => {
    const result = product({
      title: "ABC-123 enclosure",
      attributes: [
        { group: "PDF datasheet", name: "Unit weight", value: "12 lb", sourceUrl: "https://example.test/abc-123.pdf", parser: "pdf-table-extractor" },
        { group: "Specs", name: "Overall size", value: "10 x 20 x 30 mm", sourceUrl: "https://example.test/products/ABC-123" }
      ]
    });

    const repaired = repairFinalCompletenessFromEvidence(result, manufacturer);

    expect(repaired.repairedFields).toEqual(["weight", "dimensions"]);
    expect(repaired.result.normalized.weight).toBe("12 lb (5.44 kg)");
    expect(repaired.result.normalized.dimensions).toBe("10 x 20 x 30 mm");
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
