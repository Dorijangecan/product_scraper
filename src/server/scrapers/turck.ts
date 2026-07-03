import type { AttributeRecord, LocalizedProductUrls, ProductResult, SourceRecord } from "../../shared/types.js";
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
// The "Approvals/Declarations" panel on a Turck product page links to this document-management
// endpoint, which server-renders a static HTML table (Type / Certificate # / Filename) of the
// product's approval documents. This is the only online source of Turck certificate data.
const TURCK_CERTIFICATES_TEMPLATE = "https://certificates.digital.aws.turck.com/documents/{part}";
// The current Turck shop omits several ordering fields from its rendered HTML. The legacy official
// product page still publishes them by numeric order id (EAN, eCl@ss, customs tariff, origin, weight).
const TURCK_LEGACY_PRODUCT_TEMPLATE = "https://www.turck.pl/pl/product/{part}";

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

    for (const searchUrl of turckSearchUrls(catalogNumber, context)) {
      attemptedUrls.push(searchUrl);
      try {
        const search = await fetchTurckText(searchUrl, context);
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
    }

    for (const candidate of dedupeTurckCandidates(candidateUrls)) {
      attemptedUrls.push(candidate.url);
      try {
        const productPage = await fetchTurckText(candidate.url, context);
        if (!turckPageMatches(productPage, catalogNumber, context, candidate.stage)) {
          continue;
        }
        return await withTurckMetadata(
          parseTurckProductPage(catalogNumber, productPage, context),
          productPage,
          catalogNumber,
          attemptedUrls,
          sourcePages,
          candidate.stage,
          context
        );
      } catch {
        // Try the next candidate.
      }
    }

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
  }
}

function parseTurckProductPage(catalogNumber: string, fetched: FetchedText, context: ScrapeContext): ProductResult {
  return parseGenericProductPage("turck", catalogNumber, fetched, "official", TURCK_PARSER, {
    match: context.manufacturer.match,
    confidence: 0.78,
    extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy,
    localizedUrlTemplates: context.manufacturer.localizedUrlTemplates
  });
}

async function withTurckMetadata(
  result: ProductResult,
  fetched: FetchedText,
  catalogNumber: string,
  attemptedUrls: string[],
  sourcePages: SourceRecord[],
  discoveryStage: TurckProductCandidate["stage"],
  context: ScrapeContext
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
  let certificates: TurckCertificates | undefined;
  let legacyProductData: TurckLegacyProductData | undefined;
  if (orderId) {
    [certificates, legacyProductData] = await Promise.all([
      fetchTurckCertificates(orderId, context),
      fetchTurckLegacyProductData(orderId, context)
    ]);
  }
  const attributes: AttributeRecord[] = [
    ...result.attributes,
    ...(legacyProductData?.attributes ?? []),
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
      value: catalogNumber,
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
  ];
  const dedupedAttributes = dedupeAttributes(attributes);
  const documents = dedupeDocuments([
    ...result.documents,
    ...(certificates
      ? [{
          type: "certificate" as const,
          label: "Approvals/Declarations",
          url: certificates.sourceUrl,
          sourceUrl
        }]
      : [])
  ]);
  return {
    ...result,
    title,
    description,
    productUrl: sourceUrl,
    localizedUrls: turckLocalizedUrls(sourceUrl),
    confidence: Math.max(result.confidence, 0.78),
    attributes: dedupedAttributes,
    documents,
    sources: dedupeSources([
      ...sourcePages,
      ...(result.sources ?? []),
      turckSource(fetched, TURCK_PARSER, `Turck product page accepted from ${discoveryStage}.`),
      ...(legacyProductData ? [legacyProductData.source] : [])
    ]),
    normalized: normalizeFields(dedupedAttributes, documents),
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
        `Turck product page accepted from ${discoveryStage === "search-result" ? "official search result" : "numeric order-id URL"}.`,
        ...(legacyProductData ? ["Turck legacy official product page enriched ordering and physical data."] : [])
      ]
    }
  };
}

function turckSearchUrls(catalogNumber: string, context: ScrapeContext): string[] {
  const recipe = context.manufacturer.scrapeRecipe;
  const templates = [
    ...(recipe?.discoveryPolicy?.searchUrlTemplates ?? []),
    ...(recipe?.searchUrlTemplates ?? []),
    TURCK_SEARCH_FALLBACK_TEMPLATE
  ];
  return [...new Set(templates.map((template) => fillCatalogTemplate(template, catalogNumber)))];
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
  return context.http.fetchText(url, {
    timeoutMs: policy.timeoutMs ?? 10000,
    maxAttempts: policy.maxAttempts ?? 1,
    retryBackoffMs: policy.retryBackoffMs,
    cacheTtlMs: policy.cacheTtlMs,
    headers: {
      ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
      ...(policy.referer ? { referer: policy.referer } : {}),
      ...(policy.userAgent ? { "user-agent": policy.userAgent } : {})
    },
    signal: context.signal
  });
}

/**
 * Fetch and parse the Turck document-management page for an order id and distil its approval-document
 * table into a certificate value (e.g. "CE, UKCA, CCC"). The page is static server-rendered HTML, so a
 * plain GET is enough — no browser render. Returns undefined when the page is unreachable or lists no
 * approval rows so the caller simply omits the certificate attribute.
 */
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
      return { group: "Turck Classifications", name: "ECLASS 5.1.4", value: cleanedValue.match(/\b\d{8}\b/)?.[0] ?? cleanedValue, confidence: 0.9 };
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
  const candidates: Array<{ url: string; score: number }> = [];
  for (const pattern of urlPatterns) {
    for (const match of decoded.matchAll(pattern)) {
      const rawUrl = match[1];
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

function turckLocalizedUrls(productUrl: string): LocalizedProductUrls {
  const urls: LocalizedProductUrls = { en: productUrl };
  if (/\/de\/en\//i.test(productUrl)) {
    urls.de = productUrl.replace(/\/de\/en\//i, "/de/de/");
  } else if (/\/de\/de\//i.test(productUrl)) {
    urls.de = productUrl;
    urls.en = productUrl.replace(/\/de\/de\//i, "/de/en/");
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
