import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";
import { RittalConnector } from "../src/server/scrapers/rittal.js";
import { attachEvidence } from "../src/server/scrapers/evidence.js";
import { emptyResult, mergeResults, normalizeFields } from "../src/server/scrapers/normalizer.js";
import { classifyDeviceType } from "../src/server/scrapers/device-type.js";
import { requiredElectricalFields } from "../src/shared/product-requirements.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import type { ScrapeContext } from "../src/server/scrapers/types.js";

describe("Rittal built-in profile", () => {
  it("routes unseen Rittal order numbers through official-domain shared discovery", () => {
    const config = getManufacturerConfig("rittal");

    expect(config).toBeDefined();
    expect(config?.officialBaseUrls).toContain("https://www.rittal.com/com-en");
    expect(config?.localizedUrlTemplates).toEqual([
      { locale: "en", urlTemplate: "https://www.rittal.com/com-en/products/show/{part}" },
      { locale: "de", urlTemplate: "https://www.rittal.com/de-de/products/show/{part}" }
    ]);
    expect(config?.scrapeRecipe?.discoveryPolicy).toMatchObject({
      allowedOfficialDomains: ["rittal.com"],
      enableRobotsSitemaps: true,
      maxCandidates: 16
    });
    expect(config?.fallbackSources).toEqual([]);
  });

  it("parses an official Rittal PDP that references Cloudflare challenge scripts", () => {
    const text = readFileSync("benchmarks/rittal-15-new-20261006/evidence/official-pdp-1038000.html", "utf8");
    expect(text).toContain("/cdn-cgi/challenge-platform");
    const fetched: FetchedText = {
      requestedUrl: "https://www.rittal.com/com-en/products/show/1038000",
      effectiveUrl: "https://www.rittal.com/com-en/products/PG20231215SCH101/PG20231512SCH301/PRO70743?variantId=1038000",
      statusCode: 200,
      contentType: "text/html;charset=UTF-8",
      text,
      fetchedAt: "2026-10-06T09:51:16.000Z",
      fromCache: true
    };

    const result = parseGenericProductPage("rittal", "1038000", fetched, "official", "rittal-regression");
    expect(result.error).toBeUndefined();
    expect(result.productUrl).toBe(fetched.effectiveUrl);
    expect(result.documents.some((document) => document.type === "image" && /rittal\.com/i.test(document.url))).toBe(true);
    expect(JSON.stringify(result.attributes)).toContain("1038000");
  });

  it("still rejects an actual Cloudflare interstitial", () => {
    const fetched: FetchedText = {
      requestedUrl: "https://www.rittal.com/com-en/products/show/1038000",
      effectiveUrl: "https://www.rittal.com/com-en/products/show/1038000",
      statusCode: 200,
      contentType: "text/html;charset=UTF-8",
      text: "<html><head><title>Just a moment...</title></head><body>Verify you are human to continue. <script src='/cdn-cgi/challenge-platform'></script></body></html>",
      fetchedAt: "2026-10-06T09:51:16.000Z",
      fromCache: false
    };

    const result = parseGenericProductPage("rittal", "1038000", fetched, "official", "rittal-regression");
    expect(result.productUrl).toBeUndefined();
    expect(result.error).toMatch(/could not be parsed/i);
  });

  it("uses the exact order-number resolver before broad discovery", async () => {
    const text = readFileSync("benchmarks/rittal-15-new-20261006/evidence/official-pdp-1038000.html", "utf8");
    const fetched: FetchedText = {
      requestedUrl: "https://www.rittal.com/com-en/products/show/1038000",
      effectiveUrl: "https://www.rittal.com/com-en/products/PG20231215SCH101/PG20231512SCH301/PRO70743?variantId=1038000",
      statusCode: 200,
      contentType: "text/html;charset=UTF-8",
      text,
      fetchedAt: "2026-10-06T09:51:16.000Z",
      fromCache: false
    };
    let fetchCount = 0;
    const manufacturer = getManufacturerConfig("rittal")!;
    const context = {
      manufacturer,
      signal: undefined,
      http: { fetchText: async () => { fetchCount++; return fetched; } },
      fallback: { scrape: async () => { throw new Error("broad discovery must not run after exact resolver success"); } }
    } as unknown as ScrapeContext;

    const result = await new RittalConnector().scrape("1038000", context);
    expect(fetchCount).toBe(2); // exact English resolver plus optional German locale verification
    expect(result.status).not.toBe("failed");
    expect(result.productUrl).toBe(fetched.effectiveUrl);
    expect(result.title).toContain("Basic enclosure AX");
    expect(classifyDeviceType(result).type).toBe("Enclosure");
  });

  it("fills localized descriptions from an independently confirmed German exact-variant PDP", async () => {
    const englishText = readFileSync("benchmarks/rittal-15-new-20261006/evidence/official-pdp-1038000.html", "utf8");
    const germanText = readFileSync("benchmarks/rittal-15-new-20261006/evidence/official-pdp-de-1038000.html", "utf8");
    const english: FetchedText = {
      requestedUrl: "https://www.rittal.com/com-en/products/show/1038000",
      effectiveUrl: "https://www.rittal.com/com-en/products/PG20231215SCH101/PG20231512SCH301/PRO70743?variantId=1038000",
      statusCode: 200,
      contentType: "text/html;charset=UTF-8",
      text: englishText,
      fetchedAt: "2026-10-06T09:51:16.000Z",
      fromCache: false
    };
    const german: FetchedText = {
      requestedUrl: "https://www.rittal.com/de-de/products/show/1038000",
      effectiveUrl: "https://www.rittal.com/de-de/products/PG20231215SCH101/PG20231512SCH301/PRO70743?variantId=1038000",
      statusCode: 200,
      contentType: "text/html;charset=UTF-8",
      text: germanText,
      fetchedAt: "2026-10-06T09:51:16.000Z",
      fromCache: false
    };
    const context = {
      manufacturer: getManufacturerConfig("rittal")!,
      signal: undefined,
      http: { fetchText: async (url: string) => url.includes("/de-de/") ? german : english },
      fallback: { scrape: async () => { throw new Error("broad discovery must not run after exact resolver success"); } }
    } as unknown as ScrapeContext;

    const result = await new RittalConnector().scrape("1038000", context);
    expect(result.localizedDescriptions?.en?.title).toContain("Basic enclosure AX");
    expect(result.localizedDescriptions?.de?.title).toContain("Basisschrank AX");
    expect(result.localizedDescriptions?.de?.description).toContain("Kompakt-Schaltschrank AX");
    expect(result.sources.some((source) => source.url === german.effectiveUrl)).toBe(true);
    expect(result.diagnostics?.attemptedUrls).toContain(german.requestedUrl);
  });

  it("does not accept a German locale page for a different order-number variant", async () => {
    const englishText = readFileSync("benchmarks/rittal-15-new-20261006/evidence/official-pdp-1038000.html", "utf8");
    const germanText = readFileSync("benchmarks/rittal-15-new-20261006/evidence/official-pdp-de-1038000.html", "utf8");
    const english: FetchedText = {
      requestedUrl: "https://www.rittal.com/com-en/products/show/1038000",
      effectiveUrl: "https://www.rittal.com/com-en/products/PG20231215SCH101/PG20231512SCH301/PRO70743?variantId=1038000",
      statusCode: 200,
      contentType: "text/html;charset=UTF-8",
      text: englishText,
      fetchedAt: "2026-10-06T09:51:16.000Z",
      fromCache: false
    };
    const german: FetchedText = {
      requestedUrl: "https://www.rittal.com/de-de/products/show/1038000",
      effectiveUrl: "https://www.rittal.com/de-de/products/PG20231215SCH101/PG20231512SCH301/PRO70743?variantId=1038001",
      statusCode: 200,
      contentType: "text/html;charset=UTF-8",
      text: germanText.replaceAll("1038000", "1038001"),
      fetchedAt: "2026-10-06T09:51:16.000Z",
      fromCache: false
    };
    const context = {
      manufacturer: getManufacturerConfig("rittal")!,
      signal: undefined,
      http: { fetchText: async (url: string) => url.includes("/de-de/") ? german : english },
      fallback: { scrape: async () => { throw new Error("broad discovery must not run after exact resolver success"); } }
    } as unknown as ScrapeContext;

    const result = await new RittalConnector().scrape("1038000", context);
    expect(result.localizedDescriptions?.en?.title).toContain("Basic enclosure AX");
    expect(result.localizedDescriptions?.de).toBeUndefined();
  });

  it("classifies Rittal access units, mounting fasteners, and safety locks by their product function", () => {
    const cases = [
      ["8618800", "Mounting Accessory", "https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240405ZUB003/PG20240405ZUB007/PRO82563?variantId=8618800"],
      ["7030200", "Access Sensor", "https://www.rittal.com/com-en/products/PG20231215ITI101/PG20240408ITI301/PG20240913ITI006/PG20240925ITI004/PRO37142?variantId=7030200"],
      ["5302042", "Mounting Accessory", "https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240408ZUB101/PG20240408ZUB103/PRO136670?variantId=5302042"],
      ["8617353", "Mounting Accessory", "https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240403ZUB102/PG20240403ZUB105/PRO86680?variantId=8617353"],
      ["2418000", "Lock / Interlock", "https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240411ZUB101/PG20240327ZUB101/PRO14664?variantId=2418000"]
    ] as const;

    for (const [catalogNumber, expectedType, productUrl] of cases) {
      const text = readFileSync(`benchmarks/rittal-15-new-20261006-v2/evidence/official-pdp-${catalogNumber}.html`, "utf8");
      const fetched: FetchedText = {
        requestedUrl: `https://www.rittal.com/com-en/products/show/${catalogNumber}`,
        effectiveUrl: productUrl,
        statusCode: 200,
        contentType: "text/html;charset=UTF-8",
        text,
        fetchedAt: "2026-10-06T00:00:00.000Z",
        fromCache: true
      };
      const result = parseGenericProductPage("rittal", catalogNumber, fetched, "official", "rittal-order-resolver");
      expect(classifyDeviceType(result).type, catalogNumber).toBe(expectedType);
    }
  });

  it("uses the exact Rittal Design field for CMC access sensors and does not require passive sensor supply ratings", () => {
    const productUrl = "https://www.rittal.com/com-en/products/PG20231215ZUB101/PG20240405ZUB001/PG20240405ZUB002/PRO23678?variantId=7320530";
    const result = {
      ...emptyResult("rittal", "7320530", "not scraped"),
      status: "found" as const,
      confidence: 0.88,
      title: "CMC III sensors",
      productUrl,
      description: "Monitor various parameters in enclosures or rooms.",
      attributes: [
        { group: "Definition List", name: "Design", value: "Access sensor", sourceUrl: productUrl, sourceType: "official" as const, parser: "rittal-order-resolver" },
        { group: "Definition List", name: "Measuring technique", value: "Reed contact, magnet", sourceUrl: productUrl, sourceType: "official" as const, parser: "rittal-order-resolver" },
        { group: "Definition List", name: "Interfaces", value: "RJ12", sourceUrl: productUrl, sourceType: "official" as const, parser: "rittal-order-resolver" }
      ]
    };

    expect(classifyDeviceType(result).type).toBe("Access Sensor");
    expect(requiredElectricalFields(result, { deviceType: "Access Sensor", deviceTypeConfidence: 0.9 })).toEqual([]);
  });

  it("does not normalize a Rittal kA withstand figure as operating current", () => {
    const attributes = [
      { group: "Technical Data", name: "Rated current", value: "20 kA", sourceUrl: "https://www.rittal.com/com-en/products/example?variantId=3486937", sourceType: "official" as const, parser: "rittal-order-resolver" },
      { group: "Technical Data", name: "Rated voltage", value: "110 V - 240 V", sourceUrl: "https://www.rittal.com/com-en/products/example?variantId=3486937", sourceType: "official" as const, parser: "rittal-order-resolver" }
    ];

    const normalized = normalizeFields(attributes, [], "rittal");
    expect(normalized.voltage).toContain("110");
    expect(normalized.current).toBeUndefined();
    expect(attributes[0].value).toBe("20 kA");

    expect(normalizeFields([
      { group: "PDF datasheet", name: "Feature", value: "3R/4, 12 a NEMA 4X.", sourceUrl: "https://www.rittal.com/com-en/products/example?variantId=3243080" }
    ], [], "rittal").current).toBeUndefined();

    const primary = {
      manufacturerId: "rittal" as const,
      catalogNumber: "3486937",
      status: "found" as const,
      confidence: 0.9,
      normalized: { current: "20 kA" },
      attributes,
      documents: [],
      sources: []
    };
    expect(mergeResults(primary, emptyResult("rittal", "3486937", "no fallback" )).normalized.current).toBeUndefined();

    const evidenceAttached = attachEvidence({
      ...primary,
      normalized: { voltage: "110 V - 240 V" }
    });
    expect(evidenceAttached.normalized.current).toBeUndefined();
  });

  it("uses labeled Rittal product-page values instead of family or linked-manual inference", () => {
    const productUrl = "https://www.rittal.com/com-en/products/example?variantId=9340050";
    const normalized = normalizeFields([
      { group: "Definition List", name: "Material", value: "Polyamide", sourceUrl: productUrl, sourceType: "official", parser: "rittal-order-resolver" },
      { group: "Title/Description Inference", name: "Material", value: "Copper", sourceUrl: productUrl, sourceType: "generated", parser: "summary-inference" },
      { group: "Title/Description Inference", name: "Current", value: "800 A", sourceUrl: productUrl, sourceType: "generated", parser: "summary-inference" },
      { group: "PDF manual", name: "Colour", value: "Status", sourceUrl: productUrl, sourceType: "generated", parser: "pdf-table-extractor" },
      { group: "PDF datasheet", name: "Feature", value: "IP 54 / IP 55", sourceUrl: productUrl, sourceType: "generated", parser: "pdf-table-extractor" }
    ], [], "rittal");

    expect(normalized.material).toBe("Polyamide");
    expect(normalized.current).toBeUndefined();
    expect(normalized.color).toBeUndefined();
    expect(normalized.protection).toBeUndefined();

    const componentMaterials = normalizeFields([
      { group: "Definition List", name: "Material", value: "Light body: Extruded aluminiumLight cover: PolycarbonateLight ends: PC-ABS", sourceUrl: productUrl, sourceType: "official", parser: "rittal-order-resolver" },
      { group: "Definition List", name: "Surface finish", value: "Enclosure and door: Dipcoat primed, powder-coated on the outside, textured paintMounting plate: Zinc-plated", sourceUrl: productUrl, sourceType: "official", parser: "rittal-order-resolver" }
    ], [], "rittal");
    expect(componentMaterials.material).toBe("Light body: Extruded aluminium; Light cover: Polycarbonate; Light ends: PC-ABS");
    expect(componentMaterials.finish).toBe("Enclosure and door: Dipcoat primed, powder-coated on the outside, textured paint; Mounting plate: Zinc-plated");

    expect(normalizeFields([
      { group: "Definition List", name: "Material", value: "PE plastic Volume: 12 l", sourceUrl: productUrl, sourceType: "official", parser: "rittal-order-resolver" }
    ], [], "rittal").material).toBe("PE plastic");

    const relatedDeviceProtection = normalizeFields([
      { group: "PDF datasheet", name: "Feature", value: "Krytí: IP 54/IP 55/IP 56, UL typ", sourceUrl: productUrl, sourceType: "generated", parser: "pdf-table-extractor" }
    ], [], "rittal");
    expect(relatedDeviceProtection.protection).toBeUndefined();

    const noDirectMaterial = normalizeFields([
      { group: "Title/Description Inference", name: "Material", value: "stainless steel", sourceUrl: productUrl, sourceType: "generated", parser: "summary-inference" }
    ], [], "rittal");
    expect(noDirectMaterial.material).toBeUndefined();
  });

  it("preserves all official voltage modes published on Rittal cooling products", () => {
    const voltage = normalizeFields([
      {
        group: "Technical Data",
        name: "Rated operating voltage",
        value: "110 V - 240 V, 1~, 50 Hz/60 Hz | 380 V - 480 V, 3~, 50 Hz/60 Hz",
        sourceUrl: "https://www.rittal.com/com-en/products/example?variantId=3486937"
      }
    ], [], "rittal").voltage;

    expect(voltage).toContain("110 V - 240 V");
    expect(voltage).toContain("380 V - 480 V");
  });

  it("uses the official Rittal title ahead of broader cabinet context", () => {
    const classification = classifyDeviceType({
      manufacturerId: "rittal",
      catalogNumber: "3173120",
      status: "found",
      confidence: 0.9,
      title: "Pleated filter",
      description: "Pleated filter for cooling units and rack cabinets.",
      normalized: {},
      attributes: [],
      documents: [],
      sources: []
    });
    expect(classification.type).toBe("Filter");
  });

  it("classifies a managed PDU by the exact official product title", () => {
    const classification = classifyDeviceType({
      manufacturerId: "rittal",
      catalogNumber: "7955401",
      status: "found",
      confidence: 0.9,
      title: "PDU managed, international version",
      description: "Power distribution unit with metering.",
      normalized: {},
      attributes: [],
      documents: [],
      sources: []
    });
    expect(classification.type).toBe("Power Distribution Unit");
  });

  it("classifies the plural sensor title used by the CMC III product page", () => {
    const classification = classifyDeviceType({
      manufacturerId: "rittal",
      catalogNumber: "7320530",
      status: "found",
      confidence: 0.9,
      title: "CMC III sensors",
      description: "Sensors for the CMC III monitoring system.",
      normalized: {},
      attributes: [],
      documents: [],
      sources: []
    });
    expect(classification.type).toBe("Sensor");
  });
});
