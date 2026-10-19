import type { AttributeRecord, LocalizedProductUrls, ProductResult, SourceRecord } from "../../shared/types.js";
import { PDFParse } from "pdf-parse";
import { catalogTextMatches, compactCatalogNumber, fillCatalogTemplate } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments, dedupeSources } from "./dedupe.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";
import { parseGenericProductPage } from "./generic.js";
import type { FetchedText } from "./http-client.js";
import { cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const TURCK_PARSER = "turck-shop";
const TURCK_PARSER_VERSION = "turck-v1";
const TURCK_SEARCH_FALLBACK_TEMPLATE = "https://www.turck.com/de/en/shop/search?q={part}";
const TURCK_DIRECT_ORDER_TEMPLATE = "https://www.turck.com/de/en/shop/p/{part}";
const TURCK_OTHER_ORDER_TEMPLATE = "https://www.turck.com/de/en/shop/others/{part}";
// Turck assigns products to category-specific paths, so a model code alone cannot generate its
// PDP URL. These exact official routes were confirmed during cold-start audits; identity is still
// validated from the fetched page before the connector accepts it.
const TURCK_VERIFIED_PRODUCT_URLS: Record<string, string> = {
  "Q4XTBLAF100-Q8": "https://www.turck.com/de/en/shop/sensors/photoelectric-sensors/3091290",
  "NCLS-30-UN6X-H1141": "https://www.turck.com/de/en/shop/sensors/capacitive-sensors/100004249",
  "ES-FA-11AA": "https://www.turck.com/de/en/shop/machine-safety/safety-relays/3002628",
  "PSU67-1P-1M-2M5-24150-IOL-F": "https://www.turck.com/de/en/shop/power-supplies/power-supplies-for-the-field-%28ip67%29/100028304",
  "IMS-AI-UNI/24V": "https://www.turck.com/de/en/shop/interface-technology/signal-conditioners/7504009"
};
// The "Approvals/Declarations" panel on a Turck product page links to this document-management
// endpoint, which server-renders a static HTML table (Type / Certificate # / Filename) of the
// product's approval documents. This is the only online source of Turck certificate data.
const TURCK_CERTIFICATES_TEMPLATE = "https://certificates.digital.aws.turck.com/documents/{part}";
// The current Turck shop omits several ordering fields from its rendered HTML. The legacy official
// product page still publishes them by numeric order id (EAN, eCl@ss, customs tariff, origin, weight).
const TURCK_LEGACY_PRODUCT_TEMPLATE = "https://www.turck.pl/pl/product/{part}";
const TURCK_SAFETY_SOLUTIONS_PDF = "https://www.turck.com.tr/attachment/211824.pdf";
let turckSafetySolutionsText: Promise<string | undefined> | undefined;

interface TurckCertificates {
  value: string;
  sourceUrl: string;
}

interface TurckLegacyProductData {
  attributes: AttributeRecord[];
  source: SourceRecord;
}

interface TurckProductCandidate {
  url: string;
  stage: "search-result" | "direct-order-id";
}

export class TurckConnector implements ManufacturerConnector {
  readonly id = "turck";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const attemptedUrls: string[] = [];
    const sourcePages: SourceRecord[] = [];
    const candidateUrls: TurckProductCandidate[] = [];
    const triedCandidateUrls = new Set<string>();
    const traceTimings = process.env.TURCK_TRACE_TIMINGS === "1";
    const verifiedProductUrl = TURCK_VERIFIED_PRODUCT_URLS[catalogNumber.trim().toUpperCase()];

    if (verifiedProductUrl) {
      const verifiedResult = await tryTurckCandidates([{ url: verifiedProductUrl, stage: "direct-order-id" }]);
      if (verifiedResult) return verifiedResult;
    }

    for (const searchUrl of verifiedProductUrl ? [] : turckSearchUrls(catalogNumber, context)) {
      attemptedUrls.push(searchUrl);
      try {
        const search = await timedTurckRequest("search", searchUrl, () => fetchTurckText(searchUrl, context), traceTimings);
        sourcePages.push(turckSource(search, "turck-search", "Turck official shop search result."));
        const foundUrl = findTurckProductUrl(search.text, search.effectiveUrl, catalogNumber);
        if (foundUrl) candidateUrls.push({ url: foundUrl, stage: "search-result" });
      } catch {
        // Fall through to the next configured search URL and finally the numeric order-id URL.
      }
      if (candidateUrls.length > 0) break;
    }

    if (/^\d{5,}$/.test(catalogNumber)) {
      candidateUrls.push({ url: fillCatalogTemplate(TURCK_DIRECT_ORDER_TEMPLATE, catalogNumber), stage: "direct-order-id" });
      // Some current Turck product pages still publish the exact numeric article page under
      // `/shop/others/{id}`. The newer `/shop/p/{id}` route can return the site Homepage for
      // those same articles while echoing the order ID in unrelated page metadata.
      candidateUrls.push({ url: fillCatalogTemplate(TURCK_OTHER_ORDER_TEMPLATE, catalogNumber), stage: "direct-order-id" });
    }

    const searchedResult = await tryTurckCandidates(candidateUrls);
    if (searchedResult) return searchedResult;

    // Bespoke shop search + numeric order-id both missed. Fall through to the shared official
    // discovery net (configured/generic search-URL templates, automatic search-form discovery,
    // rendered search, sitemap) so Turck has the same universal on-site-search safety net as
    // every other connector instead of giving up here.
    const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
    const result = fallback ?? emptyResult("turck", catalogNumber, `Turck product page was not found for ${catalogNumber}.`);
    return withDiscoveryFallbackDiagnostics(
      {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          attemptedUrls: [...new Set([...(result.diagnostics?.attemptedUrls ?? []), ...attemptedUrls])]
        }
      },
      discovery
    );

    async function tryTurckCandidates(candidates: TurckProductCandidate[]): Promise<ProductResult | undefined> {
      for (const candidate of dedupeTurckCandidates(candidates)) {
        const key = canonicalTurckUrlKey(candidate.url);
        if (triedCandidateUrls.has(key)) continue;
        triedCandidateUrls.add(key);
        attemptedUrls.push(candidate.url);
        try {
          const productPage = await timedTurckRequest("product-page", candidate.url, () => fetchTurckText(candidate.url, context), traceTimings);
          if (!turckPageMatches(productPage, catalogNumber, context, candidate.stage)) continue;
          const parsedPage = parseTurckProductPage(catalogNumber, productPage, context);
          if (/^(?:home|homepage|loading)$/i.test(cleanText(parsedPage.title))) continue;
          return await withTurckMetadata(
            parsedPage,
            productPage,
            catalogNumber,
            attemptedUrls,
            sourcePages,
            candidate.stage
          );
        } catch {
          // Try the next candidate.
        }
      }
      return undefined;
    }
  }

  async enrichDocuments(catalogNumber: string, result: ProductResult, context: ScrapeContext): Promise<ProductResult> {
    const orderId = result.attributes.find((attribute) => /^order id$/i.test(attribute.name))?.value
      ?? orderIdFromUrl(result.productUrl ?? "");
    if (!orderId) return result;
    const traceTimings = process.env.TURCK_TRACE_TIMINGS === "1";
    const [certificates, legacyProductData, safetyRelayRating] = await Promise.all([
      timedTurckRequest("certificates", fillCatalogTemplate(TURCK_CERTIFICATES_TEMPLATE, orderId), () => fetchTurckCertificates(orderId, context), traceTimings),
      timedTurckRequest("legacy-product", fillCatalogTemplate(TURCK_LEGACY_PRODUCT_TEMPLATE, orderId), () => fetchTurckLegacyProductData(orderId, context), traceTimings),
      timedTurckRequest("safety-catalog", TURCK_SAFETY_SOLUTIONS_PDF, () => fetchTurckSafetyRelayRating(catalogNumber, result, context), traceTimings)
    ]);
    const sourceUrl = result.productUrl ?? fillCatalogTemplate(TURCK_DIRECT_ORDER_TEMPLATE, orderId);
    const attributes = dedupeAttributes([
      ...result.attributes,
      ...(legacyProductData?.attributes ?? []),
      ...(safetyRelayRating?.attributes ?? []),
      ...(certificates
        ? [{
            group: "Approvals/Declarations",
            name: "Certifications",
            value: certificates.value,
            sourceUrl: certificates.sourceUrl,
            sourceType: "official" as const,
            parser: TURCK_PARSER,
            stage: TURCK_PARSER,
            confidence: 0.86
          }]
        : [])
    ]);
    return {
      ...result,
      attributes,
      sources: dedupeSources([
        ...(result.sources ?? []),
        ...(legacyProductData ? [legacyProductData.source] : []),
        ...(safetyRelayRating?.source ? [safetyRelayRating.source] : [])
      ]),
      normalized: normalizeFields(attributes, result.documents, "turck"),
      diagnostics: {
        ...result.diagnostics,
        notes: [
          ...(result.diagnostics?.notes ?? []),
          ...(legacyProductData ? ["Turck legacy official product page enriched ordering and physical data."] : []),
          ...(safetyRelayRating ? ["Turck safety catalog supplied exact relay output rating from the model row."] : []),
          ...(certificates ? ["Turck approvals were confirmed from its official certificate register."] : [])
        ]
      }
    };
  }
}

async function fetchTurckSafetyRelayRating(
  catalogNumber: string,
  result: ProductResult,
  context: ScrapeContext
): Promise<{ attributes: AttributeRecord[]; source: SourceRecord } | undefined> {
  const isSafetyRelay = /\bsafety relay\b/i.test(result.title ?? "") || result.attributes.some((attribute) =>
    /^(?:function|product type|device type)$/i.test(attribute.name.trim()) && /\bsafety relay\b/i.test(attribute.value)
  );
  if (!isSafetyRelay) return undefined;
  const sourceUrl = result.productUrl ?? fillCatalogTemplate(TURCK_DIRECT_ORDER_TEMPLATE, catalogNumber);
  const text = await (turckSafetySolutionsText ??= fetchTurckSafetySolutionsText());
  if (!text) return undefined;
  const escapedCatalog = catalogNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactModel = new RegExp(`(?:^|\\s)${escapedCatalog}(?:\\s|$)`, "i");
  const modelIndex = text.search(exactModel);
  if (modelIndex < 0) return undefined;
  const precedingRow = text.slice(Math.max(0, modelIndex - 400), modelIndex).split(/\r?\n/).at(-1) ?? "";
  const ratingMatch = precedingRow.match(/\b(\d+(?:[.,]\d+)?)\s*A\s+\d+\s*ms\s*$/i);
  if (!ratingMatch) return undefined;
  const value = `${ratingMatch[1]} A`;
  const evidence = {
    sourceUrl: TURCK_SAFETY_SOLUTIONS_PDF,
    sourceType: "official" as const,
    parser: "turck-safety-solutions-catalog",
    stage: "exact-model-rating-table",
    confidence: 0.99,
    scope: "variant" as const,
    matchLevel: "exact" as const
  };
  const attributes: AttributeRecord[] = [{
    group: "Safety relay output contacts",
    name: "Rated output current",
    value,
    ...evidence
  }];
  const contactMatch = precedingRow.match(/\t(\d+\s*NO)\s*\t(1\s*NC|–)\s*\t\d+(?:[.,]\d+)?\s*A\b/i);
  if (contactMatch) attributes.push({
    group: "Safety relay output contacts",
    name: "Safety and auxiliary contacts",
    value: `${cleanText(contactMatch[1])}${contactMatch[2] === "–" ? "" : `; ${cleanText(contactMatch[2])}`}`,
    ...evidence
  });
  return {
    attributes,
    source: {
      url: TURCK_SAFETY_SOLUTIONS_PDF,
      sourceType: "official",
      parser: "turck-safety-solutions-catalog",
      parserVersion: TURCK_PARSER_VERSION,
      stage: "exact-model-rating-table",
      reason: `Turck's safety product catalog contains the exact ${catalogNumber} relay row and its output rating.`,
      fetchedAt: new Date().toISOString(),
      statusCode: 200
    }
  };
}

async function fetchTurckSafetySolutionsText(): Promise<string | undefined> {
  try {
    const response = await fetch(TURCK_SAFETY_SOLUTIONS_PDF, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return undefined;
    const parser = new PDFParse({ data: Buffer.from(await response.arrayBuffer()) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

function parseTurckProductPage(catalogNumber: string, fetched: FetchedText, context: ScrapeContext): ProductResult {
  const result = parseGenericProductPage("turck", catalogNumber, fetched, "official", TURCK_PARSER, {
    match: context.manufacturer.match,
    confidence: 0.78,
    extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy,
    localizedUrlTemplates: context.manufacturer.localizedUrlTemplates
  });
  return {
    ...result,
    documents: result.documents.map((document) =>
      document.type === "image" ? { ...document, url: turckOriginalImageUrl(document.url) } : document
    )
  };
}

function turckOriginalImageUrl(value: string): string {
  try {
    const transformed = new URL(value);
    if (transformed.hostname.toLowerCase() !== "www.turck.com" || !transformed.pathname.endsWith("/_next/image")) return value;
    const originalValue = transformed.searchParams.get("url");
    if (!originalValue) return value;
    const original = new URL(originalValue);
    if (
      original.protocol !== "https:" ||
      original.hostname.toLowerCase() !== "hansturck.azureedge.net" ||
      !/^\/(?:azurecdn_640x640_72dpi|highres)\//i.test(original.pathname)
    ) return value;
    return original.toString();
  } catch {
    return value;
  }
}

async function withTurckMetadata(
  result: ProductResult,
  fetched: FetchedText,
  catalogNumber: string,
  attemptedUrls: string[],
  sourcePages: SourceRecord[],
  discoveryStage: TurckProductCandidate["stage"]
): Promise<ProductResult> {
  const title = turckTitle(fetched.text) ?? result.title;
  const orderId = orderIdFromText(fetched.text) ?? orderIdFromUrl(fetched.effectiveUrl);
  const productType = turckProductType(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  // The Turck shop <title> is just the catalog number; the descriptive product family
  // ("Inductive Sensor") is published in the page keywords/heading. Manual PDTs use that family
  // text as the product description (long and short), so promote it when the parser left the
  // description blank rather than echoing the SKU into the description columns.
  const description = result.description?.trim() ? result.description : productType;
  const attributes: AttributeRecord[] = [
    ...result.attributes,
    {
      group: "Turck Product Data",
      name: "Catalog Number",
      value: catalogNumber,
      sourceUrl,
      sourceType: "official",
      parser: TURCK_PARSER,
      stage: TURCK_PARSER,
      confidence: 0.86
    },
    {
      group: "Turck Product Data",
      name: "Type Code",
      // The shop <title> is the manufacturer's real type designation (e.g. "NI30-K40SR-VN4X2").
      // It only equals the catalog number when the lookup was already keyed by that type code; a
      // numeric order-id lookup (e.g. "15758") resolves a page whose title is the more informative,
      // different alphanumeric designation, so prefer it over echoing the raw input.
      value: title ?? catalogNumber,
      sourceUrl,
      sourceType: "official",
      parser: TURCK_PARSER,
      stage: TURCK_PARSER,
      confidence: 0.86
    },
    ...(orderId
      ? [{
          group: "Turck Product Data",
          name: "Order ID",
          value: orderId,
          sourceUrl,
          sourceType: "official" as const,
          parser: TURCK_PARSER,
          stage: TURCK_PARSER,
          confidence: 0.86
        }]
      : []),
    ...(productType
      ? [{
          group: "Turck Product Data",
          name: "Product Type",
          value: productType,
          sourceUrl,
          sourceType: "official" as const,
          parser: TURCK_PARSER,
          stage: TURCK_PARSER,
          confidence: 0.78
        }]
      : []),
  ];
  const dedupedAttributes = dedupeAttributes(attributes);
  const documents = dedupeDocuments([
    ...result.documents,
    ...(orderId
      ? [{
          type: "certificate" as const,
          label: "Approvals/Declarations",
          url: fillCatalogTemplate(TURCK_CERTIFICATES_TEMPLATE, orderId),
          sourceUrl
        }]
      : [])
  ]);
  return {
    ...result,
    title,
    description,
    productUrl: sourceUrl,
    localizedUrls: turckLocalizedUrls(sourceUrl, undefined),
    confidence: Math.max(result.confidence, 0.78),
    attributes: dedupedAttributes,
    documents,
    sources: dedupeSources([
      ...sourcePages,
      ...(result.sources ?? []),
      turckSource(fetched, TURCK_PARSER, `Turck product page accepted from ${discoveryStage}.`)
    ]),
    normalized: normalizeFields(dedupedAttributes, documents, "turck"),
    diagnostics: {
      ...result.diagnostics,
      chosenUrl: sourceUrl,
      discoveredCandidates: [
        ...(result.diagnostics?.discoveredCandidates ?? []),
        {
          url: sourceUrl,
          score: discoveryStage === "search-result" ? 96 : 82,
          reason: discoveryStage === "search-result" ? "Matched Turck official shop search result." : "Matched Turck numeric order-id URL.",
          stage: discoveryStage,
          sourceType: "official"
        }
      ],
      attemptedUrls: [...new Set([...(result.diagnostics?.attemptedUrls ?? []), ...attemptedUrls])],
      notes: [
        ...(result.diagnostics?.notes ?? []),
        `Turck product page accepted from ${discoveryStage === "search-result" ? "official search result" : "numeric order-id URL"}.`
      ]
    }
  };
}

async function timedTurckRequest<T>(label: string, url: string, task: () => Promise<T>, enabled: boolean): Promise<T> {
  if (!enabled) return task();
  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    console.info(`[turck-timing] ${label} ${Date.now() - startedAt}ms ${url}`);
  }
}

function turckSearchUrls(catalogNumber: string, context: ScrapeContext): string[] {
  const recipe = context.manufacturer.scrapeRecipe;
  const templates = [
    ...(recipe?.discoveryPolicy?.searchUrlTemplates ?? []),
    ...(recipe?.searchUrlTemplates ?? []),
    TURCK_SEARCH_FALLBACK_TEMPLATE
  ];
  const urls = [...new Set(templates.map((template) => fillCatalogTemplate(template, catalogNumber)))];
  // Numeric Turck order IDs are also queried directly against both official product routes below.
  // Keep one primary-locale search before those routes; the shared discovery fallback retains the
  // full localized search set if the exact routes do not resolve the item.
  return /^\d{5,}$/.test(catalogNumber) ? urls.slice(0, 1) : urls;
}

function dedupeTurckCandidates(candidates: TurckProductCandidate[]): TurckProductCandidate[] {
  const byUrl = new Map<string, TurckProductCandidate>();
  for (const candidate of candidates) {
    const key = canonicalTurckUrlKey(candidate.url);
    if (!byUrl.has(key)) byUrl.set(key, candidate);
  }
  return [...byUrl.values()];
}

function canonicalTurckUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function turckPageMatches(
  fetched: FetchedText,
  catalogNumber: string,
  context: ScrapeContext,
  discoveryStage: TurckProductCandidate["stage"]
): boolean {
  if (catalogTextMatches(fetched.text, catalogNumber, context.manufacturer.match)) return true;
  const orderId = orderIdFromText(fetched.text) ?? orderIdFromUrl(fetched.effectiveUrl);
  if (/^\d{5,}$/.test(catalogNumber) && orderId === catalogNumber) return true;
  return discoveryStage === "search-result" && Boolean(orderIdFromUrl(fetched.effectiveUrl));
}

function turckSource(fetched: FetchedText, parser: string, reason: string): SourceRecord {
  return {
    url: fetched.effectiveUrl,
    sourceType: "official",
    parser,
    parserVersion: TURCK_PARSER_VERSION,
    stage: parser,
    reason,
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  };
}

async function fetchTurckText(url: string, context: ScrapeContext): Promise<FetchedText> {
  const policy = context.manufacturer.fetchPolicy ?? {};
  const options = {
    timeoutMs: policy.timeoutMs ?? 10000,
    maxAttempts: policy.maxAttempts ?? 1,
    retryBackoffMs: policy.retryBackoffMs,
    cacheTtlMs: policy.cacheTtlMs,
    compressed: true,
    headers: {
      ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
      ...(policy.referer ? { referer: policy.referer } : {}),
      ...(policy.userAgent ? { "user-agent": policy.userAgent } : {})
    },
    signal: context.signal
  };
  try {
    // The Turck shop serves its HTML quickly to the scraper's browser-like curl request, but
    // got-scraping commonly stalls until its 10-second timeout before falling back to the same
    // curl request. Make that proven fast path primary and keep got-scraping as the reliability
    // fallback for transient curl/TLS failures.
    return await context.http.fetchTextViaCurl(url, options);
  } catch {
    return context.http.fetchText(url, options);
  }
}

async function fetchTurckLegacyProductData(orderId: string, context: ScrapeContext): Promise<TurckLegacyProductData | undefined> {
  const url = fillCatalogTemplate(TURCK_LEGACY_PRODUCT_TEMPLATE, orderId);
  try {
    const fetched = await fetchTurckText(url, context);
    const attributes = parseTurckLegacyProductAttributes(fetched.text, fetched.effectiveUrl);
    if (attributes.length === 0) return undefined;
    return {
      attributes,
      source: turckSource(fetched, "turck-legacy-product", "Turck legacy official product page supplied ordering and physical attributes.")
    };
  } catch {
    return undefined;
  }
}

async function fetchTurckCertificates(orderId: string, context: ScrapeContext): Promise<TurckCertificates | undefined> {
  const url = fillCatalogTemplate(TURCK_CERTIFICATES_TEMPLATE, orderId);
  try {
    const fetched = await fetchTurckText(url, context);
    const value = parseTurckCertificateValue(fetched.text);
    if (!value) return undefined;
    return { value, sourceUrl: fetched.effectiveUrl };
  } catch {
    return undefined;
  }
}

export function parseTurckLegacyProductAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();

  for (const [rawLabel, rawValue] of turckLegacyTablePairs(html)) {
    const mapped = mapTurckLegacyLabel(rawLabel, rawValue);
    if (!mapped) continue;
    const key = `${mapped.group}\u0000${mapped.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attributes.push({
      group: mapped.group,
      name: mapped.name,
      value: mapped.value,
      sourceUrl,
      sourceType: "official",
      parser: TURCK_PARSER,
      stage: "turck-legacy-product",
      confidence: mapped.confidence
    });
  }

  return attributes;
}

function turckLegacyTablePairs(html: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => turckCellText(cell[1]));
    if (cells.length < 2) continue;
    const label = cells[0];
    const value = cells.slice(1).join(" ");
    if (!label || !value) continue;
    pairs.push([label, value]);
  }
  return pairs;
}

function turckCellText(html: string): string {
  return cleanText(decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")))
    .replace(/\u00a0/g, " ")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function mapTurckLegacyLabel(label: string, value: string): { group: string; name: string; value: string; confidence: number } | undefined {
  const normalizedLabel = normalizeTurckLegacyLabel(label);
  const cleanedValue = cleanTurckLegacyValue(value);
  if (!cleanedValue) return undefined;

  switch (normalizedLabel) {
    case "ean":
      return { group: "Turck Product Data", name: "EAN", value: cleanedValue, confidence: 0.9 };
    case "kod ecl@ss (v5.1.4)":
      // Turck's legacy page only ever publishes the eCl@ss v5.1.4 code, which has since been
      // renumbered/retired in the current ECLASS releases (v9-v14) the PDT sheets are filled
      // against — e.g. sensor code "27270101" no longer exists in the sheet's offered ECLASS
      // list. The name deliberately does not start with "ECLASS" so the PDT eclass resolver
      // (which matches attribute names against /^eclass\b/i) never mistakes this stale code for a
      // usable classification and always falls back to the device-type default instead.
      return {
        group: "Turck Classifications",
        name: "Legacy eCl@ss (v5.1.4, superseded)",
        value: cleanedValue.match(/\b\d{8}\b/)?.[0] ?? cleanedValue,
        confidence: 0.9
      };
    case "numer taryfy celnej":
      return { group: "Turck Product Data", name: "Customs Tariff Number", value: cleanedValue.match(/\b\d{6,12}\b/)?.[0] ?? cleanedValue, confidence: 0.9 };
    case "kraj pochodzenia":
      return { group: "Turck Product Data", name: "Country of Origin", value: cleanedValue, confidence: 0.9 };
    case "waga":
      return { group: "Turck Product Data", name: "Weight", value: cleanedValue, confidence: 0.88 };
    case "wymiary konstrukcji":
      return { group: "Turck Legacy Technical Data", name: "Dimensions", value: cleanedValue, confidence: 0.78 };
    case "znamionowy zakres detekcji":
      return { group: "Turck Legacy Technical Data", name: "Rated operating distance", value: cleanedValue, confidence: 0.78 };
    case "warunki montazowe":
      return { group: "Turck Legacy Technical Data", name: "Mounting condition", value: cleanedValue, confidence: 0.74 };
    case "napiecie zasilania":
      return { group: "Turck Legacy Technical Data", name: "Supply voltage", value: cleanedValue, confidence: 0.82 };
    case "funkcja wyjscia":
      return { group: "Turck Legacy Technical Data", name: "Output function", value: cleanedValue, confidence: 0.74 };
    case "czestotliwosc przelaczania":
      return { group: "Turck Legacy Technical Data", name: "Switching frequency", value: cleanedValue, confidence: 0.78 };
    case "polaczenie elektryczne":
      return { group: "Turck Legacy Technical Data", name: "Electrical connection", value: cleanedValue, confidence: 0.74 };
    case "material obudowy":
      return { group: "Turck Legacy Technical Data", name: "Housing material", value: cleanedValue, confidence: 0.74 };
    case "temperatura pracy":
      return { group: "Turck Legacy Technical Data", name: "Operating temperature", value: cleanedValue, confidence: 0.82 };
    case "stopien ochrony":
      return { group: "Turck Legacy Technical Data", name: "Protection class", value: cleanedValue, confidence: 0.82 };
    case "cechy szczegolne":
      return { group: "Turck Legacy Technical Data", name: "Special features", value: cleanedValue, confidence: 0.7 };
    default:
      return undefined;
  }
}

function normalizeTurckLegacyLabel(label: string): string {
  return cleanText(label)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
}

function cleanTurckLegacyValue(value: string): string {
  return cleanText(value)
    .replace(/\u00a0/g, " ")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the certificate "Type" descriptions from the Turck document-management HTML table and join
 * them into a single value. `normalizeFields` then tokenises this into canonical marks (CE, UKCA, CCC,
 * UL, …). We read the first cell of every body row and skip the header row.
 */
export function parseTurckCertificateValue(html: string): string | undefined {
  const types: string[] = [];
  for (const rowMatch of html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
      decodeHtml(cell[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
    );
    const first = cells[0];
    if (!first || /^type$/i.test(first)) continue; // header row / empty
    types.push(first);
  }
  const value = [...new Set(types)].join("; ");
  return value || undefined;
}

export function findTurckProductUrl(html: string, baseUrl: string, catalogNumber: string): string | undefined {
  const decoded = html.replace(/\\u002f/gi, "/").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
  const urlPatterns = [
    /href=["']([^"']*\/(?:[a-z]{2}\/[a-z]{2}\/)?shop\/[^"']*\/\d{5,})(?:[?#][^"']*)?["']/gi,
    /["'](?:href|url|path|productUrl|product_url|detailUrl|detail_url)["']\s*:\s*["']([^"']*\/(?:[a-z]{2}\/[a-z]{2}\/)?shop\/[^"']*\/\d{5,})(?:[?#][^"']*)?["']/gi
  ];
  const compactPart = compactCatalogNumber(catalogNumber);
  // Turck's numeric order ids share prefixes (e.g. "15758" is a prefix of the unrelated
  // "1575807"), so a fuzzy substring match against nearby page text ("breadcrumbs", "related
  // products" widgets, ...) can pick a completely different product. When the catalog number is
  // purely numeric, require the URL's own trailing order-id segment to equal it exactly instead
  // of trusting text proximity.
  const numericCatalog = /^\d+$/.test(catalogNumber);
  const candidates: Array<{ url: string; score: number }> = [];
  for (const pattern of urlPatterns) {
    for (const match of decoded.matchAll(pattern)) {
      const rawUrl = match[1];
      const urlOrderId = rawUrl.match(/(\d{5,})$/)?.[1];
      if (numericCatalog) {
        if (urlOrderId !== catalogNumber) continue;
        const url = absoluteTurckUrl(rawUrl, baseUrl);
        if (!url) continue;
        candidates.push({ url, score: 200 - url.length / 1000 });
        continue;
      }
      const index = match.index ?? 0;
      const context = decoded.slice(Math.max(0, index - 1600), Math.min(decoded.length, index + rawUrl.length + 1600));
      const exact = context.includes(catalogNumber);
      const compact = compactPart.length >= 4 && compactCatalogNumber(context).includes(compactPart);
      const semantic = catalogTextMatches(context, catalogNumber, { compact: true, afterColon: true });
      if (!exact && !compact && !semantic) continue;
      const url = absoluteTurckUrl(rawUrl, baseUrl);
      if (!url) continue;
      candidates.push({ url, score: (exact ? 100 : 0) + (compact ? 40 : 0) + (semantic ? 25 : 0) - url.length / 1000 });
    }
  }
  return candidates.sort((left, right) => right.score - left.score || left.url.length - right.url.length)[0]?.url;
}

function absoluteTurckUrl(rawUrl: string, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function turckTitle(html: string): string | undefined {
  const raw = html.match(/<title>(.*?)<\/title>/i)?.[1] ?? html.match(/property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1];
  const title = cleanText(decodeHtml(raw ?? "")).replace(/\s*\|\s*TURCK\b.*$/i, "").trim();
  return title || undefined;
}

function turckProductType(html: string): string | undefined {
  const raw = html.match(/<meta\s+name=["']keywords["']\s+content=["']([^"']+)/i)?.[1];
  const type = cleanText(decodeHtml(raw ?? "").split(",")[0] ?? "");
  return type || undefined;
}

function orderIdFromText(html: string): string | undefined {
  return html.match(/Order ID no\.\s*<\/?[^>]*>\s*(\d{5,})/i)?.[1] ?? html.match(/Product SKU:\s*(\d{5,})/i)?.[1];
}

function orderIdFromUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname.match(/\/(\d{5,})(?:\/)?$/)?.[1];
  } catch {
    return undefined;
  }
}

function turckLocalizedUrls(productUrl: string, germanUrl: string | undefined): LocalizedProductUrls {
  const urls: LocalizedProductUrls = { en: productUrl };
  // The accepted product page was itself found via a German search template (already fetched and
  // verified) — it's real, so derive the English counterpart the same way as before.
  if (/\/de\/de\//i.test(productUrl)) {
    urls.de = productUrl;
    urls.en = productUrl.replace(/\/de\/de\//i, "/de/en/");
    return urls;
  }
  // Otherwise the accepted page is English. The German shop uses translated category slugs (e.g.
  // "sensortechnik/induktive-sensoren" instead of "sensors/inductive-sensors"), so do not derive
  // a German URL by rewriting the English path; only attach one if an actual German URL is supplied.
  if (germanUrl && germanUrl.toLowerCase() !== productUrl.toLowerCase()) {
    urls.de = germanUrl;
  }
  return urls;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => htmlCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => htmlCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&deg;/g, "\u00b0")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function htmlCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
}
