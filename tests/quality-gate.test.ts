import { describe, expect, it } from "vitest";
import type { ManufacturerConfig, ProductResult } from "../src/shared/types.js";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import { finalizeQualityGate } from "../src/server/scrapers/quality-gate.js";

const manufacturer: ManufacturerConfig = {
  id: "test",
  canonicalName: "Test",
  shortName: "TST",
  rateLimitMs: 100,
  officialBaseUrls: ["https://example.test/products"],
  fallbackSources: [],
  scrapeRecipe: {
    requiredSections: ["Technical Data"],
    requiredAttributes: ["Voltage", "Material"],
    requiredDocuments: ["datasheet"],
    minAttributes: 2,
    fallbackPolicy: { distributorConfidenceCap: 0.4 },
    confidenceRules: { foundMinScore: 80, partialMaxConfidence: 0.7, distributorMaxConfidence: 0.4 }
  }
};

const productTypeAwareManufacturer: ManufacturerConfig = {
  id: "test",
  canonicalName: "Test",
  shortName: "TST",
  rateLimitMs: 100,
  officialBaseUrls: ["https://example.test/products"],
  fallbackSources: [],
  scrapeRecipe: {
    minAttributes: 1,
    fallbackPolicy: { distributorConfidenceCap: 0.4 },
    confidenceRules: { foundMinScore: 70, partialMaxConfidence: 0.7, distributorMaxConfidence: 0.4 }
  }
};

describe("quality gate", () => {
  it("promotes only identity-confirmed complete product data to found", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 enclosure",
        attributes: [
          { group: "Technical Data", name: "Voltage", value: "24 V", sourceUrl: "https://example.test/products/ABC-123" },
          { group: "Technical Data", name: "Material", value: "Steel", sourceUrl: "https://example.test/products/ABC-123" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://example.test/ABC-123.pdf" }]
      }),
      manufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.passed).toBe(true);
    expect(result.qualityGate?.missing).toEqual([]);
  });

  it("keeps identity-confirmed pages partial when required data is missing", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 enclosure",
        attributes: [{ group: "Technical Data", name: "Voltage", value: "24 V" }],
        documents: []
      }),
      manufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.confidence).toBeLessThanOrEqual(0.7);
    expect(result.qualityGate?.missing).toContain("attribute:Material");
    expect(result.qualityGate?.missing).toContain("document:datasheet");
  });

  it("keeps distributor-only product data partial even when all required fields are present", () => {
    const result = finalizeQualityGate(
      product({
        productUrl: "https://distributor.test/products/ABC-123",
        sources: [
          {
            url: "https://distributor.test/products/ABC-123",
            sourceType: "distributor",
            parser: "fixture",
            fetchedAt: "2026-05-20T00:00:00.000Z",
            statusCode: 200
          }
        ],
        title: "ABC-123 enclosure",
        attributes: [
          { group: "Technical Data", name: "Voltage", value: "24 V", sourceType: "distributor" },
          { group: "Technical Data", name: "Material", value: "Steel", sourceType: "distributor" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://distributor.test/ABC-123.pdf" }]
      }),
      manufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.confidence).toBeLessThanOrEqual(0.4);
    expect(result.qualityGate?.passed).toBe(false);
    expect(result.qualityGate?.missing).toContain("official-source");
  });

  it("does not trust official-fallback labels when the URL is not an official host", () => {
    const result = finalizeQualityGate(
      product({
        productUrl: "https://marketplace.test/products/ABC-123",
        sources: [
          {
            url: "https://marketplace.test/products/ABC-123",
            sourceType: "official-fallback",
            parser: "fixture",
            fetchedAt: "2026-05-20T00:00:00.000Z",
            statusCode: 200
          }
        ],
        title: "ABC-123 enclosure",
        attributes: [
          { group: "Technical Data", name: "Voltage", value: "24 V", sourceType: "official-fallback" },
          { group: "Technical Data", name: "Material", value: "Steel", sourceType: "official-fallback" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://marketplace.test/ABC-123.pdf" }]
      }),
      manufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.qualityGate?.missing).toContain("official-source");
  });

  it("trusts reader fallback URLs only when they wrap an official host", () => {
    const result = finalizeQualityGate(
      product({
        productUrl: "https://r.jina.ai/http://https://example.test/products/ABC-123",
        sources: [
          {
            url: "https://r.jina.ai/http://https://example.test/products/ABC-123",
            sourceType: "official-fallback",
            parser: "reader",
            fetchedAt: "2026-05-20T00:00:00.000Z",
            statusCode: 200
          }
        ],
        title: "ABC-123 enclosure",
        attributes: [
          { group: "Technical Data", name: "Voltage", value: "24 V", sourceType: "official-fallback" },
          { group: "Technical Data", name: "Material", value: "Steel", sourceType: "official-fallback" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://example.test/ABC-123.pdf" }]
      }),
      manufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("official-source");
  });

  it("fails wrong-product pages even when they contain specs", () => {
    const result = finalizeQualityGate(
      product({
        title: "XYZ-999 enclosure",
        productUrl: "https://example.test/products/XYZ-999",
        attributes: [
          { group: "Technical Data", name: "Voltage", value: "24 V" },
          { group: "Technical Data", name: "Material", value: "Steel" }
        ],
        documents: [{ type: "datasheet", label: "XYZ-999 datasheet", url: "https://example.test/XYZ-999.pdf" }]
      }),
      manufacturer
    );

    expect(result.status).toBe("failed");
    expect(result.qualityGate?.identityConfirmed).toBe(false);
    expect(result.qualityGate?.missing).toContain("identity");
  });

  it("fails pages with structured identity conflicts even when the URL matches the requested product", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 enclosure",
        productUrl: "https://example.test/products/ABC-123",
        normalized: { voltage: "24 V", material: "Steel" },
        attributes: [
          { group: "Structured Data", name: "sku", value: "XYZ-999" },
          { group: "Technical Data", name: "Voltage", value: "24 V" },
          { group: "Technical Data", name: "Material", value: "Steel" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://example.test/ABC-123.pdf" }]
      }),
      manufacturer
    );

    expect(result.status).toBe("failed");
    expect(result.qualityGate?.identityConfirmed).toBe(false);
    expect(result.qualityGate?.missing).toContain("identity-conflict");
    expect(result.error).toContain("Structured product identity conflicts");
  });

  it("does not treat EAN or UPC labels as catalog identity conflicts", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 enclosure",
        productUrl: "https://example.test/products/ABC-123",
        normalized: { voltage: "24 V", material: "Steel" },
        attributes: [
          { group: "Structured Data", name: "EAN (European Article Number)", value: "4030661425931" },
          { group: "Structured Data", name: "UPC", value: "195125000292" },
          { group: "Technical Data", name: "Voltage", value: "24 V" },
          { group: "Technical Data", name: "Material", value: "Steel" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://example.test/ABC-123.pdf" }]
      }),
      manufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("identity-conflict");
  });

  it("ignores generic internal numeric article/order numbers for alphanumeric catalog identity", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "unseen-maker",
        catalogNumber: "TK PS 2518-11-m",
        title: "TK PS 2518-11-m",
        productUrl: "https://example.test/products/TK-PS-2518-11-m",
        normalized: { material: "Polyamide", dimensions: "111 x 254 x 0.18 mm" },
        attributes: [
          { group: "Ordering data", name: "Article number (order number)", value: "10590801" },
          { group: "Technical Data", name: "Material", value: "Polyamide" },
          { group: "Technical Data", name: "Dimensions", value: "111 x 254 x 0.18 mm" }
        ],
        documents: [{ type: "datasheet", label: "TK PS 2518-11-m datasheet", url: "https://example.test/TK-PS-2518-11-m.pdf" }]
      }),
      { ...manufacturer, id: "unseen-maker" }
    );

    expect(result.status).toBe("partial");
    expect(result.qualityGate?.identityConfirmed).toBe(true);
    expect(result.qualityGate?.missing).not.toContain("identity-conflict");
  });

  it("still treats mismatched numeric article numbers as identity conflicts when the requested catalog is numeric", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "unseen-maker",
        catalogNumber: "10590801",
        title: "10590801 enclosure",
        productUrl: "https://example.test/products/10590801",
        normalized: { voltage: "24 V", material: "Steel" },
        attributes: [
          { group: "Ordering data", name: "Article Number", value: "10590802" },
          { group: "Technical Data", name: "Voltage", value: "24 V" },
          { group: "Technical Data", name: "Material", value: "Steel" }
        ],
        documents: [{ type: "datasheet", label: "10590801 datasheet", url: "https://example.test/10590801.pdf" }]
      }),
      { ...manufacturer, id: "unseen-maker" }
    );

    expect(result.status).toBe("failed");
    expect(result.qualityGate?.identityConfirmed).toBe(false);
    expect(result.qualityGate?.missing).toContain("identity-conflict");
  });

  it("accepts one matching structured identity even when a page also lists related product ids", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 enclosure",
        attributes: [
          { group: "Structured Data", name: "sku", value: "ABC-123" },
          { group: "Related Products", name: "Product ID", value: "XYZ-999" },
          { group: "Technical Data", name: "Voltage", value: "24 V" },
          { group: "Technical Data", name: "Material", value: "Steel" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://example.test/ABC-123.pdf" }]
      }),
      manufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("identity-conflict");
  });

  it("uses exact weak identity labels to resolve related-product id conflicts for unseen manufacturers", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "unseen-maker",
        title: "ABC-123 enclosure",
        attributes: [
          { group: "Product Data", name: "Type designation", value: "ABC-123" },
          { group: "Related Products", name: "Product ID", value: "XYZ-999" },
          { group: "Technical Data", name: "Voltage", value: "24 V" },
          { group: "Technical Data", name: "Material", value: "Steel" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://example.test/ABC-123.pdf" }]
      }),
      { ...manufacturer, id: "unseen-maker" }
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("identity-conflict");
  });

  it("does not let descriptive weak identity text hide a structured catalog conflict", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "unseen-maker",
        title: "ABC-123 enclosure",
        attributes: [
          { group: "Product Data", name: "Type designation", value: "ABC-123 accessory kit" },
          { group: "Structured Data", name: "sku", value: "XYZ-999" },
          { group: "Technical Data", name: "Voltage", value: "24 V" },
          { group: "Technical Data", name: "Material", value: "Steel" }
        ],
        documents: [{ type: "datasheet", label: "ABC-123 datasheet", url: "https://example.test/ABC-123.pdf" }]
      }),
      { ...manufacturer, id: "unseen-maker" }
    );

    expect(result.status).toBe("failed");
    expect(result.qualityGate?.missing).toContain("identity-conflict");
  });

  it("does not accept search URLs as product identity", () => {
    const result = finalizeQualityGate(
      product({
        title: "Search results for ABC-123",
        productUrl: "https://example.test/search?q=ABC-123",
        attributes: [
          { group: "Search Results", name: "Result", value: "ABC-123 and other products" },
          { group: "Technical Data", name: "Voltage", value: "24 V" },
          { group: "Technical Data", name: "Material", value: "Steel" }
        ],
        documents: []
      }),
      manufacturer
    );

    expect(result.status).toBe("failed");
    expect(result.qualityGate?.identityConfirmed).toBe(false);
  });

  it("does not require voltage and current for passive enclosure products", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 steel enclosure",
        attributes: [{ group: "Product Specifications", name: "Material", value: "Steel" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require voltage and current for abbreviated SCE enclosure descriptions", () => {
    const sce = getManufacturerConfig("sce");
    expect(sce).toBeDefined();

    const result = finalizeQualityGate(
      product({
        manufacturerId: "sce",
        catalogNumber: "SCE-N68C4018",
        title: "SCE-N68C4018",
        description: "1DR Enc. Center Bay - Both Side Open",
        productUrl: "https://www.saginawcontrol.com/partnumber_info?n=SCE-N68C4018",
        normalized: {
          weight: "348.00 lbs (157.85 kg)",
          dimensions: "68.00 x 40.25 x 18.00 in",
          material: "carbon steel",
          protection: "NEMA Type 3R, 4, 12 and Type 13"
        },
        attributes: [
          { group: "Product Specifications", name: "Part Number", value: "SCE-N68C4018" },
          { group: "Product Specifications", name: "Description", value: "1DR Enc. Center Bay - Both Side Open" },
          {
            group: "Application",
            name: "Application",
            value: "Designed to house a variety of electrical and electronic controls and instruments."
          },
          { group: "Construction", name: "Construction Detail", value: "Provisions for light kit." }
        ],
        documents: [{ type: "image", label: "Product image", url: "https://www.saginawcontrol.com/images/sce-n68c4018.png" }]
      }),
      sce!
    );

    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require voltage and current for passive rack cabinets even when network switches are mentioned", () => {
    const result = finalizeQualityGate(
      product({
        title: "ProLine S1 Cabinet, 1200x600x900mm, Black, Steel",
        description: "Cabinet to house servers, switches, cables and other communication equipment.",
        normalized: { dimensions: "1200 x 600 x 900 mm", material: "Steel" },
        attributes: [
          { group: "Product specifications", name: "Cabinet Type", value: "Communication and Server" },
          { group: "Product specifications", name: "Rack Mount Spacing", value: "19-in" },
          { group: "Product specifications", name: "Material", value: "Steel" }
        ]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require voltage and current for passive pressure regulator valves", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "siemens",
        catalogNumber: "BPZ:VSG519K15-5",
        title: "VSG519K15-5 differential pressure regulator valve",
        normalized: { material: "Valve body spheroidal cast iron GJS-400-15", dimensions: "DN 15", weight: "4.5 kg" },
        attributes: [
          { group: "Customer datasheet", name: "Product Type", value: "Differential pressure regulator valve" },
          { group: "Customer datasheet", name: "Material", value: "Valve body spheroidal cast iron GJS-400-15" }
        ],
        documents: [{ type: "datasheet", label: "BPZ:VSG519K15-5 datasheet", url: "file:///customer/siemens-vsg519k15-5-datasheet.csv" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require voltage and current for passive Siemens module carrier base units", () => {
    const siemens = getManufacturerConfig("siemens");
    expect(siemens).toBeDefined();

    const result = finalizeQualityGate(
      product({
        manufacturerId: "siemens",
        catalogNumber: "6ES7193-6BP00-0DA0",
        productUrl: "https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=6ES7193-6BP00-0DA0",
        normalized: { weight: "45 g (0.05 kg)" },
        attributes: [
          { group: "Plain Text", name: "Article Number", value: "6ES7193-6BP00-0DA0" },
          { group: "Plain Text", name: "Product description", value: "SIMATIC ET 200SP, BaseUnit BU15-P16+A0+2D" },
          { group: "Plain Text", name: "Net weight", value: "45 g" }
        ],
        documents: [
          {
            type: "datasheet",
            label: "Download product data sheet",
            url: "https://mall.industry.siemens.com/teddatasheet/?format=PDF&mlfbs=6ES7193-6BP00-0DA0&language=en&caller=SiePortal"
          }
        ],
        sources: [
          {
            url: "https://mall.industry.siemens.com/mall/en/WW/Catalog/Product?mlfb=6ES7193-6BP00-0DA0",
            sourceType: "official-fallback",
            parser: "fixture",
            fetchedAt: "2026-05-20T00:00:00.000Z",
            statusCode: 200
          }
        ]
      }),
      siemens!
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require voltage and current for passive module carrier base units from unseen manufacturers", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "unseen-maker",
        catalogNumber: "BU15-P16-A0-2D",
        title: "Remote I/O BaseUnit BU15-P16+A0+2D",
        productUrl: "https://example.test/products/BU15-P16-A0-2D",
        normalized: { material: "polycarbonate", dimensions: "15 x 60 x 35 mm", weight: "45 g" },
        attributes: [
          { group: "Product Data", name: "Catalog Number", value: "BU15-P16-A0-2D" },
          { group: "Product Data", name: "Product description", value: "Remote I/O terminal base unit for electronic modules" },
          { group: "Technical Data", name: "Material", value: "polycarbonate" },
          { group: "Technical Data", name: "Dimensions", value: "15 x 60 x 35 mm" },
          { group: "Technical Data", name: "Net weight", value: "45 g" }
        ],
        documents: [{ type: "datasheet", label: "BU15-P16 datasheet", url: "https://example.test/bu15-p16.pdf" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).not.toBe("failed");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("requires voltage and current for active electrical products", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 contactor",
        attributes: [{ group: "Technical Data", name: "Material", value: "Plastic" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.qualityGate?.missing).toContain("normalized:voltage");
    expect(result.qualityGate?.missing).toContain("normalized:current");
  });

  it("requires voltage but not current for HMI operator panels without published current", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "rockwell",
        catalogNumber: "2715P-T7CD",
        title: "2715P-T7CD PanelView 5510 Terminal",
        productUrl: "https://www.rockwellautomation.com/en-us/products/details.2715P-T7CD.html",
        attributes: [
          { group: "Structured Data", name: "sku", value: "2715P-T7CD" },
          { group: "Rockwell Product Data", name: "Product Type", value: "HMI operator panel touch screen" }
        ]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.qualityGate?.missing).toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("uses device type classification to require gateway voltage without current", () => {
    const result = finalizeQualityGate(
      product({
        catalogNumber: "GW-ETH-1",
        title: "Industrial Ethernet communication gateway",
        attributes: [
          { group: "Structured Data", name: "sku", value: "GW-ETH-1" },
          { group: "Product Data", name: "Product Type", value: "Modbus TCP to EtherNet/IP communication gateway" }
        ]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.qualityGate?.missing).toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not force normalized voltage/current fallback for Rockwell Micro820 family pages", () => {
    const familyUrl = "https://www.rockwellautomation.com/en-us/products/hardware/allen-bradley/programmable-controllers/micro-controllers/micro800-family/micro820-controllers.html";
    const result = finalizeQualityGate(
      product({
        manufacturerId: "rockwell",
        catalogNumber: "2080-LC20-20AWB",
        title: "Micro820 Controller",
        description: "Micro820 Controller",
        productUrl: familyUrl,
        attributes: [
          { group: "Rockwell Family", name: "Product Family", value: "Micro820", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl },
          { group: "Rockwell Family", name: "Weight", value: "0.38 kg", parser: "rockwell-family-page", sourceType: "official", sourceUrl: familyUrl }
        ],
        documents: [{ type: "datasheet", label: "Technical Datasheet (EN)", url: familyUrl, sourceType: "official" }],
        sources: [{ url: familyUrl, sourceType: "official", parser: "rockwell-family-page", stage: "rockwell-family-page", fetchedAt: "2026-06-09T00:00:00.000Z" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("requires voltage and current for Schneider pushbuttons with electrical contacts", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "schneider",
        catalogNumber: "XB4BA21",
        title: "XB4BA21 Harmony 22mm push button, 1 NO contact",
        attributes: [
          { group: "Schneider Main", name: "Product or Component Type", value: "Push-button" },
          { group: "Schneider Main", name: "Contacts type and composition", value: "1 NO" }
        ]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.qualityGate?.missing).toContain("normalized:voltage");
    expect(result.qualityGate?.missing).toContain("normalized:current");
  });

  it("accepts active electrical products when voltage and current are present", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 contactor",
        normalized: { voltage: "24 V AC/DC", current: "9 A" },
        attributes: [
          { group: "Technical Data", name: "Rated Voltage", value: "24 V AC/DC" },
          { group: "Technical Data", name: "Rated Current", value: "9 A" }
        ]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("requires only current for Eaton rotary disconnect main switches", () => {
    const eaton = getManufacturerConfig("eaton")!;
    const result = finalizeQualityGate(
      product({
        manufacturerId: "eaton",
        catalogNumber: "P1-25/I2/SVB",
        title: "P1-25/I2/SVB Eaton rotary disconnect switch",
        productUrl: "https://www.eaton.com/us/en-us/skuPage.P1-25-I2-SVB.html",
        normalized: { current: "25 A" },
        attributes: [
          { group: "Product", name: "Catalog Number", value: "P1-25/I2/SVB" },
          { group: "Product", name: "Product Name", value: "Eaton rotary disconnect switch" },
          { group: "Technical Data", name: "Type", value: "Main switch" },
          { group: "Technical Data", name: "Amperage Rating", value: "25 A" },
          { group: "Technical Data", name: "Dimensions", value: "145 x 72 x 126 mm" },
          { group: "Certifications", name: "Certification", value: "UL" }
        ],
        documents: [{ type: "datasheet", label: "P1-25/I2/SVB datasheet", url: "https://www.eaton.com/us/en-us/skuPage.P1-25-I2-SVB.html" }]
      }),
      eaton
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("requires only voltage for SCE thermal and lighting products", () => {
    const sce = getManufacturerConfig("sce")!;
    const result = finalizeQualityGate(
      product({
        manufacturerId: "sce",
        catalogNumber: "SCE-HF1251A",
        title: "SCE-HF1251A Heater W/Thermostat",
        productUrl: "https://www.saginawcontrol.com/partnumber_info?n=SCE-HF1251A",
        normalized: { voltage: "120 V AC", material: "Aluminum", dimensions: "5.41 x 4.38 x 4.56 in", weight: "4.00 lbs" },
        attributes: [
          { group: "Product Specifications", name: "Part Number", value: "SCE-HF1251A" },
          { group: "Product Specifications", name: "Description", value: "Heater W/Thermostat" },
          { group: "Product Specifications", name: "Volt", value: "120 VAC" },
          { group: "Product Specifications", name: "Watt", value: "125" },
          { group: "Construction", name: "Construction Detail", value: "Aluminum housing." }
        ],
        documents: [
          { type: "image", label: "Product image", url: "https://www.saginawcontrol.com/images/sce-hf1251a.png" },
          { type: "manual", label: "Fan/Heater with Thermostat", url: "https://www.saginawcontrol.com/instman/fan-heater.pdf" }
        ]
      }),
      sce
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("recognizes SCE heat exchangers and blowers as voltage-rated devices", () => {
    const sce = getManufacturerConfig("sce")!;
    const heatExchanger = finalizeQualityGate(
      product({
        manufacturerId: "sce",
        catalogNumber: "SCE-HE04W120V",
        title: "SCE-HE04W120V Exchanger, Heat",
        productUrl: "https://www.saginawcontrol.com/partnumber_info?n=SCE-HE04W120V",
        normalized: { voltage: "120 V", dimensions: "20.00 x 7.50 x 5.95 in", weight: "14.08 lbs" },
        attributes: [
          { group: "Product Specifications", name: "Part Number", value: "SCE-HE04W120V" },
          { group: "Product Specifications", name: "Description", value: "Exchanger, Heat" },
          { group: "Product Specifications", name: "Height", value: "20.00\"" },
          { group: "Product Specifications", name: "Width", value: "7.50\"" },
          { group: "Product Specifications", name: "Depth", value: "5.95\"" },
          { group: "Product Specifications", name: "Weight", value: "14.08 lbs" }
        ],
        documents: [{ type: "image", label: "Product image", url: "https://www.saginawcontrol.com/images/sce-he04w120v.png" }]
      }),
      sce
    );
    const blower = finalizeQualityGate(
      product({
        manufacturerId: "sce",
        catalogNumber: "SCE-BP115",
        title: "SCE-BP115 Blower Package",
        productUrl: "https://www.saginawcontrol.com/partnumber_info?n=SCE-BP115",
        normalized: { voltage: "115 V", current: "2.5 A", dimensions: "12.00 x 12.00 x 6.00 in", weight: "6.00 lbs" },
        attributes: [
          { group: "Product Specifications", name: "Part Number", value: "SCE-BP115" },
          { group: "Product Specifications", name: "Description", value: "Blower Package" },
          { group: "Product Specifications", name: "Volt", value: "115" },
          { group: "Product Specifications", name: "Max. Current", value: "2.5" },
          { group: "Product Specifications", name: "Height", value: "12.00\"" },
          { group: "Product Specifications", name: "Width", value: "12.00\"" },
          { group: "Product Specifications", name: "Depth", value: "6.00\"" },
          { group: "Product Specifications", name: "Weight", value: "6.00 lbs" }
        ],
        documents: [{ type: "image", label: "Product image", url: "https://www.saginawcontrol.com/images/sce-bp115.png" }]
      }),
      sce
    );

    expect(heatExchanger.status).toBe("found");
    expect(heatExchanger.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(blower.status).toBe("found");
    expect(blower.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(blower.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require electrical ratings for SCE passive program ports", () => {
    const sce = getManufacturerConfig("sce")!;
    const result = finalizeQualityGate(
      product({
        manufacturerId: "sce",
        catalogNumber: "P-P11R2-K3RF0-U450",
        title: "P-P11R2-K3RF0-U450 Port, Programming",
        productUrl: "https://www.saginawcontrol.com/partnumber_info?n=P-P11R2-K3RF0-U450",
        normalized: { material: "polycarbonate", dimensions: "3.50 x 5.10 x 1.65 in", weight: "2.00 lbs" },
        attributes: [
          { group: "Product Specifications", name: "Part Number", value: "P-P11R2-K3RF0-U450" },
          { group: "Product Specifications", name: "Description", value: "Port, Programming" },
          { group: "Product Specifications", name: "Interface", value: "Ethernet/USB" },
          { group: "Product Specifications", name: "UL Type", value: "4" },
          { group: "Application", name: "Application", value: "Data interface ports outside the enclosure." }
        ],
        documents: [
          { type: "image", label: "Product image", url: "https://www.saginawcontrol.com/images/p-p11r2-k3rf0-u450.png" },
          { type: "manual", label: "Convenience Receptacles & Program Ports", url: "https://www.saginawcontrol.com/instman/program-ports.pdf" }
        ]
      }),
      sce
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require electrical ratings for passive programming ports from unseen manufacturers", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "unseen-maker",
        catalogNumber: "P-P11R2-K3RF0-U450",
        title: "Panel programming port",
        productUrl: "https://example.test/products/P-P11R2-K3RF0-U450",
        normalized: { material: "polycarbonate", dimensions: "3.50 x 5.10 x 1.65 in", weight: "2.00 lbs" },
        attributes: [
          { group: "Product Specifications", name: "Part Number", value: "P-P11R2-K3RF0-U450" },
          { group: "Product Specifications", name: "Description", value: "Port, Programming" },
          { group: "Product Specifications", name: "Material", value: "polycarbonate" },
          { group: "Product Specifications", name: "Dimensions", value: "3.50 x 5.10 x 1.65 in" },
          { group: "Product Specifications", name: "Weight", value: "2.00 lbs" },
          { group: "Application", name: "Application", value: "Data interface ports outside the enclosure." }
        ],
        documents: [{ type: "manual", label: "Convenience receptacles and program ports", url: "https://example.test/program-ports.pdf" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("requires voltage for enclosure thermal devices from unseen manufacturers", () => {
    const result = finalizeQualityGate(
      product({
        manufacturerId: "unseen-maker",
        catalogNumber: "HX-120",
        title: "HX-120 Heat Exchanger",
        normalized: { dimensions: "20 x 8 x 6 in", weight: "14 lb" },
        attributes: [
          { group: "Product Specifications", name: "Description", value: "Exchanger, Heat" },
          { group: "Product Specifications", name: "Height", value: "20 in" }
        ],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/hx-120.png" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.qualityGate?.missing).toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("accepts SCE service consumables when Saginaw publishes only an image document", () => {
    const sce = getManufacturerConfig("sce")!;
    const result = finalizeQualityGate(
      product({
        manufacturerId: "sce",
        catalogNumber: "SCE-SSCLEAN",
        title: "SCE-SSCLEAN Stainless Steel Cleaner",
        productUrl: "https://www.saginawcontrol.com/partnumber_info?n=SCE-SSCLEAN",
        normalized: { dimensions: "1.00 x 1.00 x 1.00 in", weight: "1.00 lbs" },
        attributes: [
          { group: "Product Specifications", name: "Part Number", value: "SCE-SSCLEAN" },
          { group: "Product Specifications", name: "Description", value: "Stainless Steel Cleaner" },
          { group: "Product Specifications", name: "Height", value: "1.00\"" },
          { group: "Product Specifications", name: "Width", value: "1.00\"" },
          { group: "Product Specifications", name: "Depth", value: "1.00\"" },
          { group: "Product Specifications", name: "Weight", value: "1.00 lbs" }
        ],
        documents: [{ type: "image", label: "Product image", url: "https://www.saginawcontrol.com/images/sce-ssclean.png" }]
      }),
      sce
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("document:manual|cad|datasheet|other");
  });

  it("still requires ratings for safety switches even when the description mentions a cover", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 safety switch",
        attributes: [
          {
            group: "ABB Product Data",
            name: "Long Description",
            value: "Safety switch, plastic enclosure, IP65. The cover is interlocked."
          }
        ]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("partial");
    expect(result.qualityGate?.missing).toContain("normalized:voltage");
    expect(result.qualityGate?.missing).toContain("normalized:current");
  });

  it("requires only voltage for ABB remote racking motors", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 RRD Motor 110 - 220Vac/dc E1.3",
        normalized: { voltage: "110...220 V AC/DC" },
        attributes: [
          {
            group: "ABB Product Data",
            name: "Catalog Description",
            value: "SACE Emax 3 RRD Motor 110 - 220Vac/dc E1.3"
          }
        ]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("requires only current for ABB current-sensor style products", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 current sensor for external neutral 2000A",
        normalized: { current: "2000 A" },
        attributes: [{ group: "ABB Product Data", name: "Catalog Description", value: "Current sensor for external neutral 2000A" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require electrical ratings for ABB lock and cover accessories", () => {
    const result = finalizeQualityGate(
      product({
        title: "ABC-123 key lock in connected-isolated position",
        attributes: [{ group: "ABB Product Data", name: "Catalog Description", value: "KEY LOCK WITH DIFFERENT KEYS" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("uses generic voltage-only sensor rules for previously unseen manufacturers", () => {
    const result = finalizeQualityGate(
      product({
        title: "ZX-77 capacitive level sensor",
        normalized: { voltage: "18...30 V DC", protection: "IP67" },
        attributes: [
          { group: "Technical Data", name: "Product group", value: "Capacitive level sensors" },
          { group: "Technical Data", name: "Operating voltage", value: "18...30 V DC" }
        ],
        documents: [{ type: "datasheet", label: "ZX-77 datasheet", url: "https://example.test/ZX-77.pdf" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not invent electrical requirements for generic passive pilot-device actuators", () => {
    const result = finalizeQualityGate(
      product({
        title: "ZX-M22 non-illuminated pushbutton actuator head",
        normalized: { material: "plastic", protection: "IP66" },
        attributes: [
          { group: "Technical Data", name: "Product type", value: "Non-illuminated pushbutton actuator" },
          { group: "Technical Data", name: "Degree of protection", value: "IP66" }
        ],
        documents: [{ type: "datasheet", label: "ZX-M22 datasheet", url: "https://example.test/ZX-M22.pdf" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("requires only published current for generic mechanical limit switches", () => {
    const result = finalizeQualityGate(
      product({
        title: "ZX-LS mechanical single position limit switch",
        normalized: { current: "6 A", protection: "IP65" },
        attributes: [
          { group: "Technical Data", name: "Product group", value: "Mechanical single position limit switches" },
          { group: "Technical Data", name: "Continuous current", value: "6 A" }
        ],
        documents: [{ type: "datasheet", label: "ZX-LS datasheet", url: "https://example.test/ZX-LS.pdf" }]
      }),
      productTypeAwareManufacturer
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require cordset-only attributes for Balluff sensors", () => {
    const balluff = getManufacturerConfig("balluff");
    expect(balluff).toBeDefined();

    const result = finalizeQualityGate(
      product({
        manufacturerId: "balluff",
        catalogNumber: "BOS025P",
        title: "BOS025P photoelectric sensor",
        productUrl: "https://www.balluff.com/en-gb/products/BOS025P",
        normalized: { voltage: "10...30 VDC" },
        attributes: [
          { group: "Structured Data", name: "sku", value: "BOS025P" },
          { group: "Balluff Summary Features", name: "Product group", value: "Photoelectric sensors" },
          { group: "Balluff Key features", name: "Principle of optical operation", value: "Through-beam sensor (receiver)" },
          { group: "Balluff Key features", name: "Dimension", value: "18 x 75 mm" },
          { group: "Balluff Key features", name: "Operating voltage Ub", value: "10...30 VDC" },
          { group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-27-09-01" },
          { group: "Balluff Classifications", name: "ETIM 9.0", value: "EC002716" },
          { group: "Balluff Key features", name: "Approval/Conformity", value: "CE; UKCA; WEEE" }
        ],
        documents: [{ type: "datasheet", label: "BOS025P datasheet", url: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=123&con=en" }]
      }),
      balluff!
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.passed).toBe(true);
    expect(result.qualityGate?.missing.some((item) => /connection|cable|rated current/i.test(item))).toBe(false);
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("accepts Balluff capacitive level sensors and SmartCamera products without current", () => {
    const balluff = getManufacturerConfig("balluff");
    expect(balluff).toBeDefined();

    for (const fixture of [
      {
        catalogNumber: "BCS01CY",
        title: "BCS01CY Capacitive level sensors",
        group: "Capacitive level sensors",
        extra: { name: "Sensitivity", value: "teachable depending on media" }
      },
      {
        catalogNumber: "BVS002F",
        title: "BVS002F SmartCamera for machine vision",
        group: "SmartCamera for machine vision",
        extra: { name: "Image resolution", value: "1280 x 1024 pixels" }
      },
      {
        catalogNumber: "BGL0001",
        title: "BGL0001 Standard fork light barriers made of metal",
        group: "Fork light barriers",
        extra: { name: "Principle of operation", value: "Fork sensor" }
      },
      {
        catalogNumber: "BNI0086",
        title: "BNI0086 SmartLight - LED stack lights",
        group: "SmartLight - LED stack lights",
        extra: { name: "Segments, number max.", value: "3" }
      },
      {
        catalogNumber: "BAE012E",
        title: "BAE012E Machine Lights",
        group: "Machine Lights",
        extra: { name: "Light type", value: "LED White light diffuse" }
      }
    ]) {
      const result = finalizeQualityGate(
        product({
          manufacturerId: "balluff",
          catalogNumber: fixture.catalogNumber,
          title: fixture.title,
          productUrl: `https://www.balluff.com/en-gb/products/${fixture.catalogNumber}`,
          normalized: { voltage: "18...30 VDC" },
          attributes: [
            { group: "Structured Data", name: "sku", value: fixture.catalogNumber },
            { group: "Balluff Summary Features", name: "Product group", value: fixture.group },
            { group: "Balluff Key features", name: fixture.extra.name, value: fixture.extra.value },
            { group: "Balluff Key features", name: "Operating voltage Ub", value: "18...30 VDC" },
            { group: "Balluff Key features", name: "IP rating", value: "IP67" },
            { group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-27-42-01" },
            { group: "Balluff Classifications", name: "ETIM 9.0", value: "EC002715" },
            { group: "Balluff Key features", name: "Approval/Conformity", value: "CE; UKCA; WEEE" }
          ],
          documents: [{ type: "datasheet", label: `${fixture.catalogNumber} datasheet`, url: `https://publications.balluff.com/pdfengine/pdf?type=pdb&id=${fixture.catalogNumber}&con=en` }]
        }),
        balluff!
      );

      expect(result.status).toBe("found");
      expect(result.qualityGate?.passed).toBe(true);
      expect(result.qualityGate?.missing).not.toContain("normalized:current");
    }
  });

  it("does not require electrical current for passive Balluff fiber optics and field attachables", () => {
    const balluff = getManufacturerConfig("balluff");
    expect(balluff).toBeDefined();

    for (const fixture of [
      {
        catalogNumber: "BFO0041",
        title: "BFO0041 Cylindrical glass fibers with straight and angled optics",
        normalized: {
          dimensions: "Ø 8 x 25 mm",
          material: "Stainless steel",
          protection: "IP50"
        }
      },
      {
        catalogNumber: "BCC00T8",
        title: "BCC00T8 Field attachables",
        normalized: {
          voltage: "30 V DC",
          protection: "IP67"
        }
      }
    ]) {
      const result = finalizeQualityGate(
        product({
          manufacturerId: "balluff",
          catalogNumber: fixture.catalogNumber,
          title: fixture.title,
          productUrl: `https://www.balluff.com/en-gb/products/${fixture.catalogNumber}`,
          normalized: fixture.normalized,
          attributes: [
            { group: "Structured Data", name: "sku", value: fixture.catalogNumber },
            { group: "Balluff Summary Features", name: "Product group", value: fixture.title },
            { group: "Balluff Key features", name: "IP rating", value: fixture.normalized.protection ?? "IP67" },
            { group: "Balluff Key features", name: "Connection", value: "M12x1" },
            { group: "Balluff Key features", name: "Ambient temperature", value: "-20...80 °C" },
            { group: "Balluff Key features", name: "Version", value: "standard" },
            { group: "Balluff Key features", name: "Material", value: fixture.normalized.material ?? "not published" },
            { group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-44-01-14" },
            { group: "Balluff Key features", name: "Approval/Conformity", value: "WEEE" }
          ],
          documents: [{ type: "datasheet", label: `${fixture.catalogNumber} datasheet`, url: `https://publications.balluff.com/pdfengine/pdf?type=pdb&id=${fixture.catalogNumber}&con=en` }]
        }),
        balluff!
      );

      expect(result.status).toBe("found");
      expect(result.qualityGate?.missing).not.toContain("normalized:current");
      expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    }
  });

  it("requires only current for Balluff mechanical single position limit switches", () => {
    const balluff = getManufacturerConfig("balluff");
    expect(balluff).toBeDefined();

    const result = finalizeQualityGate(
      product({
        manufacturerId: "balluff",
        catalogNumber: "BSE0005",
        title: "BSE0005 Mechanical single position limit switches",
        productUrl: "https://www.balluff.com/en-gb/products/BSE0005",
        normalized: { current: "6.0 A" },
        attributes: [
          { group: "Structured Data", name: "sku", value: "BSE0005" },
          { group: "Balluff Summary Features", name: "Product group", value: "Mechanical single position limit switches" },
          { group: "Balluff Key features", name: "Housing material", value: "Thermoplast, GF" },
          { group: "Balluff Key features", name: "Continuous current", value: "1. Switch position: 6.0 A" },
          { group: "Balluff Key features", name: "Connection type", value: "1. Switch position: Screw terminal" },
          { group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-27-06-91" },
          { group: "Balluff Classifications", name: "ETIM 9.0", value: "EC000030" },
          { group: "Balluff Key features", name: "Approval/Conformity", value: "CE; UKCA; WEEE" }
        ],
        documents: [{ type: "datasheet", label: "BSE0005 datasheet", url: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=BSE0005&con=en" }]
      }),
      balluff!
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.passed).toBe(true);
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
  });

  it("does not require voltage for passive Balluff RFID read/write heads and antennas", () => {
    const balluff = getManufacturerConfig("balluff");
    expect(balluff).toBeDefined();

    const result = finalizeQualityGate(
      product({
        manufacturerId: "balluff",
        catalogNumber: "BIS00PZ",
        title: "BIS00PZ HF read/write heads and antennas (13.56 MHz)",
        productUrl: "https://www.balluff.com/en-us/products/BIS00PZ",
        normalized: { dimensions: "120 x 60 x 240 mm", protection: "IP65" },
        attributes: [
          { group: "Structured Data", name: "sku", value: "BIS00PZ" },
          { group: "Balluff Summary Features", name: "Product group", value: "HF (13.56 MHz)" },
          { group: "Balluff Key features", name: "Antenna type", value: "right-angle" },
          { group: "Balluff Key features", name: "Connection", value: "Female, 4-pin, D-coded; Male, 5-pin" },
          { group: "Balluff Key features", name: "IP rating", value: "IP65" },
          { group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-28-04-02" },
          { group: "Balluff Classifications", name: "ETIM 9.0", value: "EC002998" },
          { group: "Balluff Key features", name: "Approval/Conformity", value: "CE; UL; WEEE" }
        ],
        documents: [{ type: "datasheet", label: "BIS00PZ datasheet", url: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=BIS00PZ&con=en" }]
      }),
      balluff!
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.passed).toBe(true);
    expect(result.qualityGate?.missing).not.toContain("normalized:voltage");
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });

  it("does not require current for Balluff configured limit-switch pages without published contact ratings", () => {
    const balluff = getManufacturerConfig("balluff");
    expect(balluff).toBeDefined();

    const result = finalizeQualityGate(
      product({
        manufacturerId: "balluff",
        catalogNumber: "BNS0519",
        title: "BNS0519 Mechanical multiple position limit switches with safety switch positions",
        productUrl: "https://www.balluff.com/en-us/products/BNS0519",
        normalized: { protection: "IP67" },
        attributes: [
          { group: "Structured Data", name: "sku", value: "BNS0519" },
          { group: "Balluff Key features", name: "Housing material", value: "Aluminum, Anodized" },
          { group: "Balluff Key features", name: "Version", value: "Safety EN 60204-1" },
          { group: "Balluff Key features", name: "Installation", value: "Vertical" },
          { group: "Balluff Key features", name: "Approach direction", value: "longitudinal, parallel to attachment surface" },
          { group: "Balluff Key features", name: "IP rating", value: "IP67" },
          { group: "Balluff Classifications", name: "ECLASS 14.0", value: "27-27-06-02" },
          { group: "Balluff Classifications", name: "ETIM 9.0", value: "EC001829" },
          { group: "Balluff Key features", name: "Approval/Conformity", value: "CE; WEEE" }
        ],
        documents: [{ type: "datasheet", label: "BNS0519 datasheet", url: "https://publications.balluff.com/pdfengine/pdf?type=pdb&id=BNS0519&con=en" }]
      }),
      balluff!
    );

    expect(result.status).toBe("found");
    expect(result.qualityGate?.passed).toBe(true);
    expect(result.qualityGate?.missing).not.toContain("normalized:current");
  });
});

function product(overrides: Partial<ProductResult>): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "ABC-123",
    status: "partial",
    confidence: 0.9,
    productUrl: "https://example.test/products/ABC-123",
    normalized: {},
    attributes: [],
    documents: [],
    sources: [
      {
        url: overrides.productUrl ?? "https://example.test/products/ABC-123",
        sourceType: "official",
        parser: "fixture",
        fetchedAt: "2026-05-20T00:00:00.000Z",
        statusCode: 200
      }
    ],
    ...overrides
  };
}
