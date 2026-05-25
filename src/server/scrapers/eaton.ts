import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, LocalizedUrlTemplate, ProductResult, ScrapeDiagnostics, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { classifyDocument, cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { catalogTextMatches, compactCatalogNumber, encodeSlashBraceCatalogPart, fillCatalogTemplate, templateContainsCatalogPlaceholder } from "./catalog-number.js";

const EATON_PRODUCT_BASE_URL = "https://www.eaton.com/us/en-us/skuPage";
const EATON_SKU_LOCALE_PATHS = [
  "us/en-us",
  "de/de-de",
  "gb/en-gb",
  "ca/en-gb",
  "au/en-gb",
  "ae/en-gb",
  "no/no-no",
  "pl/pl-pl",
  "fr/fr-fr",
  "it/it-it",
  "es/es-es"
];
const EATON_SEARCH_LOCALE_PATHS = ["us/en-us", "gb/en-gb", "de/de-de", "no/no-no", "fr/fr-fr", "it/it-it", "es/es-es"];

interface EatonSearchCandidate {
  url: string;
  score: number;
  reason: string;
}

const KNOWN_FIELDS = [
  "Product Length/Depth",
  "Product Diameter",
  "Product Height",
  "Product Width",
  "Product Weight",
  "Catalog Number",
  "Product Name",
  "Certifications",
  "Catalog Notes",
  "Global Catalog",
  "Product Type",
  "Facing Material",
  "Voltage rating",
  "Amperage Rating",
  "Frequency rating",
  "Number of poles",
  "Transmission Type",
  "Clutch Size",
  "Torque rating",
  "Input shaft size",
  "Used with",
  "Material",
  "Series",
  "Model",
  "Size",
  "Type",
  "UPC",
  "SKU",
  "EAN",
  "Model Code",
  "Compliances",
  "Warranty",
  "Frame",
  "Class",
  "Trip Type",
  "Terminals",
  "Battery type",
  "Receptacle",
  "VA rating",
  "Wattage",
  "Output nominal voltage",
  "Input connection",
  "Input nominal voltage",
  "Nominal frequency",
  "Input voltage range",
  "Input frequency range",
  "Communication",
  "Noise level",
  "Temperature range",
  "Relative humidity",
  "Package contents",
  "Standard factory warranty",
  "Extended service plans",
  "Interrupt rating",
  "Interrupt rating range",
  "Features",
  "Special features",
  "Handle color",
  "Mounting",
  "Mounting hardware",
  "Product Category",
  "Circuit breaker type",
  "Circuit breaker frame type",
  "Pre-Damper",
  "Number of Discs",
  "Damper Spring Count",
  "Friction pad count",
  "Portfolio rating",
  "Hydraulic Linkage",
  "Vehicle classification group",
  "Accessory/spare part type",
  "Color",
  "Dimensions - band specification",
  "Rated operation current (Ie)",
  "Rated operational current for specified heat dissipation (In)",
  "Rated operational voltage (Ue) - max",
  "Voltage rating - max",
  "Voltage type",
  "Degree of protection",
  "Material quality",
  "Enclosure color",
  "Surface finishing",
  "RAL-number",
  "Thickness of mounting plate",
  "EL Number",
  "HP rating - max",
  "Frame size",
  "Coil",
  "Coil voltage",
  "Contact configuration",
  "Continuous ampere rating",
  "Operation",
  "Enclosure",
  "Enclosure material",
  "Fuse configuration",
  "Number of wires",
  "NEMA rating",
  "Mounting Method",
  "Wire size",
  "Main circuit breaker",
  "Bus material",
  "Cover",
  "Number of circuits",
  "Number of spaces",
  "Phase",
  "Quantity",
  "Box size",
  "Actuator",
  "Actuator function",
  "Button color",
  "Bezel",
  "Illumination",
  "Environmental rating",
  "Design",
  "Connection",
  "Connection type",
  "Connection type (auxiliary circuit)",
  "Connector",
  "Connector group",
  "Connector type",
  "Connector Style",
  "Connector Plating",
  "Contact Plating",
  "Cable Length",
  "Cable Length Range",
  "Cable Outer Diameter (OD)",
  "Outer Cable Diameter",
  "Cable Jacket Material",
  "Cable Jacket Rating",
  "Cable Jacket Color",
  "Cable Type",
  "Gland type",
  "Thread Size",
  "Thread type",
  "Outer sheath (min/max)",
  "Cable sealing range",
  "SideA Connector1",
  "SideB Connector1",
  "Application",
  "Operating frequency",
  "Overvoltage category",
  "Pollution degree",
  "Protection",
  "Rated impulse withstand voltage (Uimp)",
  "Resistance per pole",
  "Suitable for",
  "Utilization category",
  "Lifespan, mechanical",
  "Rated conditional short-circuit current (Iq)",
  "Static heat dissipation, non-current-dependent Pvs",
  "Shock resistance",
  "Opening diameter",
  "Unlocking method"
].sort((left, right) => right.length - left.length);

export class EatonConnector implements ManufacturerConnector {
  readonly id = "eaton";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const candidates = buildEatonProductUrlCandidates(catalogNumber, context.manufacturer.localizedUrlTemplates);
    const diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes"> = {
      attemptedUrls: [],
      discoveredCandidates: [],
      notes: []
    };
    let result: ProductResult | undefined;

    for (const officialUrl of candidates.slice(0, 4)) {
      try {
        const fetched = await context.http.fetchText(officialUrl, { timeoutMs: 5000, maxAttempts: 1, signal: context.signal });
        result = parseEatonProductPage(catalogNumber, fetched, officialUrl, context.manufacturer.localizedUrlTemplates);
      } catch {
        // Try the next Eaton locale before falling back to the public reader.
      }
      if (result && result.status !== "failed") return withEatonDiagnostics(result, diagnostics);
    }

    const searchCandidates = await discoverEatonSearchCandidates(catalogNumber, context, diagnostics);
    for (const candidate of searchCandidates.slice(0, 6)) {
      try {
        const fetched = await context.http.fetchText(candidate.url, { timeoutMs: 7000, maxAttempts: 1, signal: context.signal });
        result = parseEatonProductPage(catalogNumber, fetched, candidate.url, context.manufacturer.localizedUrlTemplates);
      } catch {
        // Try the next official Eaton search result.
      }
      if (result && result.status !== "failed") return withEatonDiagnostics(result, diagnostics);
    }

    for (const officialUrl of candidates) {
      try {
        const fetched = await context.http.fetchText(buildEatonReaderUrl(officialUrl), {
          timeoutMs: 12000,
          maxAttempts: 1,
          signal: context.signal,
          headers: {
            accept: "text/markdown,text/plain,*/*"
          }
        });
        result = parseEatonProductPage(catalogNumber, fetched, officialUrl, context.manufacturer.localizedUrlTemplates);
      } catch {
        // Fall through to the next reader locale.
      }
      if (result && result.status !== "failed") return withEatonDiagnostics(result, diagnostics);
    }

    for (const candidate of searchCandidates.slice(0, 4)) {
      try {
        const fetched = await context.http.fetchText(buildEatonReaderUrl(candidate.url), {
          timeoutMs: 12000,
          maxAttempts: 1,
          signal: context.signal,
          headers: {
            accept: "text/markdown,text/plain,*/*"
          }
        });
        result = parseEatonProductPage(catalogNumber, fetched, candidate.url, context.manufacturer.localizedUrlTemplates);
      } catch {
        // Fall through to the next discovered reader page.
      }
      if (result && result.status !== "failed") return withEatonDiagnostics(result, diagnostics);
    }

    const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
    return fallback ? withEatonDiagnostics(fallback, diagnostics) : withEatonDiagnostics(result ?? emptyResult("eaton", catalogNumber, "No Eaton product page could be fetched."), diagnostics);
  }
}

export function encodeEatonSkuPart(catalogNumber: string): string {
  return encodeSlashBraceCatalogPart(catalogNumber);
}

export function buildEatonSkuPageUrl(catalogNumber: string, localePath = "us/en-us"): string {
  return `${EATON_PRODUCT_BASE_URL.replace("/us/en-us/", `/${localePath}/`)}.${encodeEatonSkuPart(catalogNumber)}.html`;
}

export function buildEatonProductUrlCandidates(catalogNumber: string, localizedUrlTemplates?: LocalizedUrlTemplate[]): string[] {
  const urls = [
    ...(localizedUrlTemplates ?? [])
      .filter((template) => templateContainsCatalogPlaceholder(template.urlTemplate))
      .map((template) => fillCatalogTemplate(template.urlTemplate, catalogNumber)),
    ...EATON_SKU_LOCALE_PATHS.map((localePath) => buildEatonSkuPageUrl(catalogNumber, localePath))
  ];
  return [...new Set(urls.filter((url) => /^https:\/\/www\.eaton\.com\//i.test(url)))];
}

export function buildEatonSearchApiUrl(catalogNumber: string, localePath = "us/en-us"): string {
  return `https://www.eaton.com/content/eaton/${localePath}/site-search/jcr:content/root/responsivegrid/search_results.searchTerm$${encodeURIComponent(catalogNumber)}.SortBy$relevance.Facets$.startDate$.endDate$.loadMore$.json`;
}

export function buildEatonSearchApiUrlCandidates(catalogNumber: string, configuredTemplates: string[] = []): string[] {
  const configured = configuredTemplates
    .filter(templateContainsCatalogPlaceholder)
    .map((template) => fillCatalogTemplate(template, catalogNumber));
  return [...new Set([...configured, ...EATON_SEARCH_LOCALE_PATHS.map((localePath) => buildEatonSearchApiUrl(catalogNumber, localePath))])]
    .filter((url) => /^https:\/\/www\.eaton\.com\//i.test(url));
}

export function extractEatonSearchCandidates(text: string, baseUrl: string, catalogNumber: string): EatonSearchCandidate[] {
  const candidates = new Map<string, EatonSearchCandidate>();
  const add = (rawUrl: unknown, context: string, reason: string, baseScore: number) => {
    const url = typeof rawUrl === "string" ? normalizeEatonSearchProductUrl(rawUrl, baseUrl) : undefined;
    if (!url) return;
    const score = scoreEatonSearchCandidate(url, context, catalogNumber, baseScore);
    const key = url.toLowerCase();
    const existing = candidates.get(key);
    if (!existing || score > existing.score) candidates.set(key, { url, score, reason });
  };

  try {
    const parsed = JSON.parse(text) as unknown;
    for (const item of findEatonSearchResultItems(parsed)) {
      const context = cleanText([
        item.title,
        item.description,
        item.contentType,
        item.url,
        item.completeUrl,
        item.elNumber,
        item.modelCode,
        item.catalogNumber,
        item.statusBadge && typeof item.statusBadge === "object" ? Object.values(item.statusBadge).join(" ") : undefined,
        ...readSecondaryLinkText(item)
      ].filter(Boolean).join(" "));
      const isSku = /^sku$/i.test(String(item.contentType ?? ""));
      add(item.completeUrl, context, isSku ? "Eaton site-search SKU result" : "Eaton site-search result", isSku ? 72 : 42);
      add(item.url, context, isSku ? "Eaton site-search SKU content path" : "Eaton site-search content path", isSku ? 64 : 35);
      for (const link of readSecondaryLinks(item)) add(link.url, `${context} ${link.text ?? ""}`, "Eaton site-search secondary link", isSku ? 58 : 32);
    }
  } catch {
    for (const match of text.replace(/\\\//g, "/").matchAll(/https?:\/\/www\.eaton\.com\/[^"'<>\s)]+\/skuPage\.[^"'<>\s)]+\.html/gi)) {
      add(match[0], match[0], "Eaton site-search inline SKU URL", 45);
    }
  }

  return [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.url.length - right.url.length)
    .slice(0, 12);
}

function buildEatonReaderUrl(officialUrl: string): string {
  return `https://r.jina.ai/http://${officialUrl.replace(/^https?:\/\//i, "")}`;
}

async function discoverEatonSearchCandidates(
  catalogNumber: string,
  context: ScrapeContext,
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes">
): Promise<EatonSearchCandidate[]> {
  const configuredTemplates = [
    ...(context.manufacturer.scrapeRecipe?.discoveryPolicy?.searchUrlTemplates ?? []),
    ...(context.manufacturer.scrapeRecipe?.searchUrlTemplates ?? [])
  ];
  const searchUrls = buildEatonSearchApiUrlCandidates(catalogNumber, configuredTemplates);
  const byUrl = new Map<string, EatonSearchCandidate>();

  for (const searchUrl of searchUrls.slice(0, 8)) {
    diagnostics.attemptedUrls?.push(searchUrl);
    try {
      const fetched = await context.http.fetchText(searchUrl, {
        timeoutMs: 10000,
        maxAttempts: 1,
        signal: context.signal,
        headers: {
          accept: "application/json,text/plain,*/*",
          referer: `https://www.eaton.com/us/en-us/site-search.html.searchTerm$${encodeURIComponent(catalogNumber)}.tabs$all.html`
        }
      });
      for (const candidate of extractEatonSearchCandidates(fetched.text, fetched.effectiveUrl, catalogNumber)) {
        const existing = byUrl.get(candidate.url.toLowerCase());
        if (!existing || candidate.score > existing.score) byUrl.set(candidate.url.toLowerCase(), candidate);
      }
    } catch (error) {
      diagnostics.notes?.push(`Eaton search discovery failed for ${searchUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const candidates = [...byUrl.values()].sort((left, right) => right.score - left.score || left.url.length - right.url.length);
  diagnostics.discoveredCandidates?.push(
    ...candidates.map((candidate) => ({
      url: candidate.url,
      score: candidate.score,
      reason: candidate.reason,
      stage: "search-result" as const,
      sourceType: "official-fallback" as const
    }))
  );
  return candidates;
}

function normalizeEatonSearchProductUrl(rawUrl: string, baseUrl: string): string | undefined {
  if (!rawUrl || /^javascript:|^mailto:|^tel:|^data:/i.test(rawUrl)) return undefined;
  try {
    let parsed = new URL(rawUrl.trim().replace(/\\u002f/gi, "/").replace(/&amp;/gi, "&"), baseUrl);
    const contentPath = parsed.pathname.match(/^\/content\/eaton\/([^/]+\/[^/]+)\/skuPage\.([^/?#]+)$/i);
    if (contentPath) {
      parsed = new URL(`https://www.eaton.com/${contentPath[1]}/skuPage.${contentPath[2]}.html`);
    }
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\.specifications\.html$/i, ".html");
    if (/\/skuPage\.[^/]+$/i.test(parsed.pathname) && !/\.html$/i.test(parsed.pathname)) parsed.pathname = `${parsed.pathname}.html`;
    if (!isEatonSkuPageUrl(parsed)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isEatonSkuPageUrl(url: URL): boolean {
  return /^www\.eaton\.com$/i.test(url.hostname) && /\/skuPage\.[^/]+\.html$/i.test(url.pathname) && !/\.pdf$/i.test(url.pathname);
}

function scoreEatonSearchCandidate(url: string, context: string, catalogNumber: string, baseScore: number): number {
  let score = baseScore;
  const title = context.split(/\s+/)[0] ?? "";
  const exactCatalog = new RegExp(`(^|[^a-z0-9])${escapeRegExp(catalogNumber)}([^a-z0-9]|$)`, "i");
  const compactPart = compactCatalogNumber(catalogNumber);
  if (catalogTextMatches(context, catalogNumber, { compact: true, afterColon: true })) score += 18;
  if (catalogTextMatches(url, catalogNumber, { compact: true, afterColon: true })) score += 24;
  if (exactCatalog.test(context)) score += 30;
  if (exactCatalog.test(url)) score += 35;
  if (compactCatalogNumber(title) === compactCatalogNumber(catalogNumber)) score += 28;
  if (compactPart && compactCatalogNumber(url).includes(compactPart)) score += 18;
  if (/\/skuPage\./i.test(url)) score += 10;
  if (/\b(discontinued|obsolete)\b/i.test(context)) score -= 6;
  return Math.max(0, Math.min(180, score));
}

function findEatonSearchResultItems(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(findEatonSearchResultItems);
  const record = value as Record<string, unknown>;
  const direct = Array.isArray(record.siteSearchResults) ? record.siteSearchResults : [];
  return direct.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function readSecondaryLinks(item: Record<string, unknown>): Array<{ text?: string; url?: string }> {
  const rawLinks = Array.isArray(item.secondaryLinkList) ? item.secondaryLinkList : [];
  return rawLinks.filter((link): link is { text?: string; url?: string } => Boolean(link) && typeof link === "object");
}

function readSecondaryLinkText(item: Record<string, unknown>): string[] {
  return readSecondaryLinks(item).flatMap((link) => [link.text, link.url]).filter((value): value is string => typeof value === "string");
}

function withEatonDiagnostics(
  result: ProductResult,
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes">
): ProductResult {
  const attemptedUrls = uniqueStrings([...(result.diagnostics?.attemptedUrls ?? []), ...(diagnostics.attemptedUrls ?? [])]).slice(0, 80);
  const discoveredCandidates = [
    ...(result.diagnostics?.discoveredCandidates ?? []),
    ...(diagnostics.discoveredCandidates ?? [])
  ].slice(0, 40);
  const notes = uniqueStrings([...(result.diagnostics?.notes ?? []), ...(diagnostics.notes ?? [])]).slice(0, 40);
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      ...(attemptedUrls.length ? { attemptedUrls } : {}),
      ...(discoveredCandidates.length ? { discoveredCandidates } : {}),
      ...(notes.length ? { notes } : {})
    }
  };
}

export function parseEatonProductPage(
  catalogNumber: string,
  fetched: FetchedText,
  officialUrl: string,
  localizedUrlTemplates?: LocalizedUrlTemplate[]
): ProductResult {
  const text = fetched.text;
  const htmlParsed = parseHtmlProductData(catalogNumber, fetched);
  if (isEatonNotFoundPage(fetched, htmlParsed.title, htmlParsed.description)) {
    return emptyResult("eaton", catalogNumber, "Eaton page returned a not-found page.");
  }
  if (!catalogTextMatches(text, catalogNumber)) {
    return emptyResult("eaton", catalogNumber, "Eaton page did not contain the catalog number.");
  }

  const shouldParseMarkdown = htmlParsed.attributes.length === 0;
  const lines = shouldParseMarkdown ? text.split(/\r?\n/).map(cleanMarkdownLine).filter(Boolean) : [];
  const markdownAttributes = shouldParseMarkdown ? extractMarkdownAttributes(lines, fetched.effectiveUrl) : [];
  const markdownDocuments = shouldParseMarkdown
    ? [
        ...extractMarkdownImages(text, catalogNumber, fetched.effectiveUrl),
        ...extractMarkdownLinks(text, catalogNumber, fetched.effectiveUrl)
      ]
    : [];
  const attributes = dedupeAttributes([...htmlParsed.attributes, ...markdownAttributes]).map((attr) => ({
    sourceType: "official-fallback" as const,
    parser: "eaton-product-page",
    stage: htmlParsed.attributes.length ? "static-html" : "reader",
    confidence: htmlParsed.attributes.length ? 0.9 : 0.84,
    ...attr
  }));
  const documents = dedupeDocuments([...htmlParsed.documents, ...markdownDocuments]).map((doc) => ({
    sourceType: "official-fallback" as const,
    parser: "eaton-product-page",
    stage: htmlParsed.attributes.length ? "static-html" : "reader",
    confidence: htmlParsed.attributes.length ? 0.9 : 0.84,
    ...doc
  }));
  const title = cleanText(htmlParsed.title || readMarkdownTitle(lines) || catalogNumber);
  const description = htmlParsed.description || readDescription(lines, catalogNumber);
  const normalized = normalizeFields(attributes, documents);
  const catalogNumberForUrls = preferredEatonCatalogNumber(catalogNumber, attributes);
  const hasUsableProductData = hasUsableEatonProductData(attributes, documents);
  return {
    manufacturerId: "eaton",
    catalogNumber,
    status: hasUsableProductData ? "found" : "failed",
    confidence: hasUsableProductData ? 0.82 : 0,
    productUrl: officialUrl,
    localizedUrls: buildLocalizedProductUrls("eaton", catalogNumberForUrls, officialUrl, localizedUrlTemplates),
    title,
    description,
    normalized,
    attributes,
    documents,
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType: "official-fallback",
        parser: "eaton-product-page",
        parserVersion: "eaton-v2",
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      } satisfies SourceRecord
    ],
    error: hasUsableProductData ? undefined : "No usable Eaton product data found."
  };
}

function hasUsableEatonProductData(attributes: AttributeRecord[], documents: DocumentRecord[]): boolean {
  if (documents.length > 0) return true;
  if (attributes.length >= 3) return true;
  return attributes.some((attr) => /^(?:catalog number|model code|product name|product type)$/i.test(attr.name));
}

function isEatonNotFoundPage(fetched: FetchedText, title?: string, description?: string): boolean {
  if (fetched.statusCode === 404) return true;
  const notFoundTitlePattern = /^(?:404|404\s+(?:error|errore|erreur|fehler)|(?:error|errore|erreur|fehler)\s+404)(?:\s*\|\s*Eaton)?$/i;
  if (notFoundTitlePattern.test(cleanText(title))) return true;
  const pageIntro = cleanText(`${title ?? ""} ${description ?? ""} ${fetched.text.slice(0, 2500)}`);
  return (
    /\btitle:\s*(?:404|404\s+(?:error|errore|erreur|fehler)|(?:error|errore|erreur|fehler)\s+404)(?:\s*\|\s*Eaton)?\b/i.test(pageIntro) ||
    /\b404\s+(?:error|errore|erreur|fehler)\b/i.test(pageIntro) ||
    /\b(?:error|errore|erreur|fehler)\s+404\b/i.test(pageIntro) ||
    /\bpage\s+not\s+found\b/i.test(pageIntro) ||
    /\bthe\s+page\s+you\s+requested\s+could\s+not\s+be\s+found\b/i.test(pageIntro)
  );
}

function preferredEatonCatalogNumber(requestedCatalogNumber: string, attributes: AttributeRecord[]): string {
  const pageCatalogNumber = attributes.find((attr) => /^catalog number$/i.test(attr.name) && /^[\w./(){} -]{2,80}$/i.test(attr.value))?.value;
  return cleanText(pageCatalogNumber) || requestedCatalogNumber;
}

function parseHtmlProductData(catalogNumber: string, fetched: FetchedText): {
  title?: string;
  description?: string;
  attributes: AttributeRecord[];
  documents: DocumentRecord[];
} {
  if (!/<(?:html|table|tr|div|meta)\b/i.test(fetched.text)) return { attributes: [], documents: [] };
  const $ = cheerio.load(fetched.text);
  const title = cleanText(
    $("meta[property='og:title']").attr("content") ||
      $("title").first().text() ||
      $(".module-product-detail-card-v2__title,h1").first().text()
  ).replace(/\s+\|\s+Eaton$/i, "");
  const description = cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content"));
  const attributes: AttributeRecord[] = [];
  const structured = extractHtmlStructuredProductData($, fetched.effectiveUrl);

  $(".product-specification-item").each((_, section) => {
    const group = cleanText($(section).find(".product-specification-item__title,h2,h3").first().text()) || "Product specifications";
    if (isIgnoredAttributeSection(group)) return;
    $(section).find("tr.specification-row").each((__, row) => {
      const name = cleanText($(row).find(".specification-title,strong,th").first().text());
      const valueCell = $(row).find(".specification-value,td").last();
      const value = cleanElementText(valueCell);
      if (!name || !value) return;
      attributes.push({ group, name, value, sourceUrl: fetched.effectiveUrl });
    });
  });

  if (attributes.length === 0) {
    $("tr").each((_, row) => {
      const cells = $(row)
        .find("th,td")
        .map((__, cell) => cleanElementText($(cell)))
        .get()
        .filter(Boolean);
      if (cells.length < 2) return;
      attributes.push({ group: "Product specifications", name: cells[0], value: cells.slice(1).join(" "), sourceUrl: fetched.effectiveUrl });
    });
  }

  return {
    title,
    description,
    attributes: [
      ...attributes,
      ...structured.attributes,
      ...extractHtmlDataLayerAttributes($, fetched.effectiveUrl),
      ...extractHtmlMetaAttributes($, fetched.effectiveUrl),
      ...extractHtmlBreadcrumbAttributes($, fetched.effectiveUrl),
      ...extractHtmlRelatedProductAttributes($, fetched.effectiveUrl)
    ],
    documents: [...extractHtmlDocuments($, catalogNumber, fetched.effectiveUrl), ...structured.documents]
  };
}

function cleanElementText(element: cheerio.Cheerio<any>): string {
  const html = element.html();
  if (!html) return cleanText(element.text());
  const normalizedHtml = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/li>/gi, "</li>\n");
  return cleanText(cheerio.load(`<div>${normalizedHtml}</div>`).text());
}

function extractHtmlStructuredProductData(
  $: cheerio.CheerioAPI,
  sourceUrl: string
): { attributes: AttributeRecord[]; documents: DocumentRecord[] } {
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const addAttribute = (name: string, value: unknown) => {
    const text = cleanText(structuredText(value));
    if (!text || text.length > 500) return;
    attributes.push({ group: "Structured Product Data", name, value: text, sourceUrl });
  };
  const addImage = (value: unknown, label = "Product image") => {
    for (const rawUrl of structuredImageUrls(value)) {
      const absolute = toAbsoluteUrl(rawUrl, sourceUrl);
      if (!absolute) continue;
      documents.push({ type: "image", label, url: normalizeEatonImageUrl(absolute), sourceUrl });
    }
  };

  $("script[type='application/ld+json']").each((_, script) => {
    const parsed = parseJsonLdScript($(script).text());
    if (!parsed) return;
    for (const product of findJsonLdProducts(parsed)) {
      addAttribute("Product Name", product.name);
      addAttribute("Description", product.description);
      addAttribute("SKU", product.sku);
      addAttribute("MPN", product.mpn);
      addAttribute("Model", product.model);
      addAttribute("GTIN", product.gtin ?? product.gtin8 ?? product.gtin12 ?? product.gtin13 ?? product.gtin14);
      addAttribute("Brand", structuredBrandName(product.brand));
      addAttribute("Category", product.category);
      addAttribute("Product URL", product.url);
      addImage(product.image, cleanText(structuredText(product.name)) || "Product image");
    }

    for (const breadcrumb of findJsonLdBreadcrumbs(parsed)) {
      if (breadcrumb.length >= 2) attributes.push({ group: "Product hierarchy", name: "Breadcrumb", value: breadcrumb.join(" > "), sourceUrl });
    }
  });

  return { attributes, documents };
}

function parseJsonLdScript(text: string): unknown | undefined {
  const cleaned = text.trim();
  if (!cleaned) return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function findJsonLdProducts(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(findJsonLdProducts);
  if (!isRecord(value)) return [];
  const direct = jsonLdTypeIncludes(value["@type"], "Product") ? [value] : [];
  const nested = Object.values(value).flatMap(findJsonLdProducts);
  return [...direct, ...nested];
}

function findJsonLdBreadcrumbs(value: unknown): string[][] {
  if (Array.isArray(value)) return value.flatMap(findJsonLdBreadcrumbs);
  if (!isRecord(value)) return [];
  const direct = jsonLdTypeIncludes(value["@type"], "BreadcrumbList") ? [readBreadcrumbList(value)] : [];
  const nested = Object.values(value).flatMap(findJsonLdBreadcrumbs);
  return [...direct, ...nested].filter((breadcrumb) => breadcrumb.length > 0);
}

function readBreadcrumbList(record: Record<string, unknown>): string[] {
  const items = Array.isArray(record.itemListElement) ? record.itemListElement : [];
  return items
    .map((item) => {
      if (!isRecord(item)) return structuredText(item);
      if (isRecord(item.item)) return structuredText(item.item.name);
      return structuredText(item.name);
    })
    .map(cleanText)
    .filter(Boolean);
}

function jsonLdTypeIncludes(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((item) => jsonLdTypeIncludes(item, expected));
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/^schema:/, "");
  return normalized === expected.toLowerCase();
}

function structuredBrandName(value: unknown): string | undefined {
  if (isRecord(value)) return structuredText(value.name);
  return structuredText(value);
}

function structuredText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(structuredText).filter(Boolean).join("; ");
  if (isRecord(value)) return structuredText(value.name ?? value.value ?? value.url);
  return undefined;
}

function structuredImageUrls(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(structuredImageUrls);
  if (!isRecord(value)) return [];
  return [value.url, value.contentUrl, value.thumbnailUrl].flatMap(structuredImageUrls);
}

function extractHtmlMetaAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const labels: Record<string, string> = {
    "og:title": "Open Graph Title",
    "og:description": "Open Graph Description",
    "og:url": "Open Graph URL",
    "og:type": "Open Graph Type",
    "coveo:product_brand": "Product Brand",
    "coveo:product_core_group": "Product Core Group",
    "coveo:product_lines": "Product Lines",
    "coveo:product_categories": "Product Categories",
    "coveo:product_regions": "Product Regions",
    "product:brand": "Product Brand",
    "product:category": "Product Category",
    "product:retailer_item_id": "Retailer Item ID",
    "product:availability": "Product Availability"
  };
  const attributes: AttributeRecord[] = [];

  $("meta[name],meta[property]").each((_, element) => {
    const rawName = cleanText($(element).attr("name") || $(element).attr("property")).toLowerCase();
    const label = labels[rawName];
    const value = cleanText($(element).attr("content"));
    if (!label || !value) return;
    attributes.push({ group: "Page metadata", name: label, value, sourceUrl });
  });

  const canonical = toAbsoluteUrl($("link[rel='canonical']").first().attr("href") ?? "", sourceUrl);
  if (canonical) attributes.push({ group: "Page metadata", name: "Canonical URL", value: canonical, sourceUrl });

  return attributes;
}

function extractHtmlDataLayerAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const labels: Record<string, string> = {
    country: "Country",
    language: "Language",
    channel: "Channel",
    pageType: "Page Type",
    productFamily: "Product Family",
    productSku: "Product SKU",
    productName: "Product Name",
    domain: "Domain"
  };

  $("script").each((_, script) => {
    const text = $(script).text();
    if (!/dataLayerJson\s*=/.test(text)) return;
    for (const record of extractScriptObjectAssignments(text, "dataLayerJson")) {
      for (const [key, rawValue] of Object.entries(record)) {
        const label = labels[key];
        const value = cleanText(normalizeDataLayerValue(rawValue));
        if (!label || !value || value.length > 500) continue;
        attributes.push({ group: "Eaton data layer", name: label, value, sourceUrl });
      }
    }
  });

  return attributes;
}

function extractScriptObjectAssignments(text: string, variableName: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pattern = new RegExp(`${escapeRegExp(variableName)}\\s*=\\s*({[\\s\\S]*?})\\s*;`, "g");
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Ignore unrelated scripts or non-JSON JavaScript objects.
    }
  }
  return records;
}

function normalizeDataLayerValue(value: unknown): string | undefined {
  const text = structuredText(value);
  if (!text) return undefined;
  return text.includes("||") ? text.split("||").pop() : text;
}

function extractHtmlBreadcrumbAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const crumbs = uniqueStrings(
    $("nav.breadcrumb a,.breadcrumb a,.breadcrumb li,.cmp-breadcrumb__item a,.cmp-breadcrumb__item")
      .map((_, element) => cleanText($(element).text()))
      .get()
      .filter((value) => value && !/^(?:home|eaton|products?)$/i.test(value))
  );
  return crumbs.length >= 2 ? [{ group: "Product hierarchy", name: "Breadcrumb", value: crumbs.join(" > "), sourceUrl }] : [];
}

function extractMarkdownAttributes(lines: string[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const knownFields = knownMarkdownFields(lines);
  let group = "Eaton Page";
  let pending: AttributeRecord | undefined;

  const flushPending = () => {
    if (!pending) return;
    if (!isIgnoredAttributeSection(pending.group) && pending.value && !/^date$/i.test(pending.name)) {
      attributes.push({ ...pending, value: cleanText(pending.value.replace(/^[*\s-]+/, "")) });
    }
    pending = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^#+\s*(.+)$/);
    if (heading) {
      flushPending();
      group = cleanText(heading[1].replace(/\s+\|\s+Eaton$/i, ""));
      continue;
    }

    const boldPair = line.match(/^\*\*([^*]{2,140})\*\*\s*(.*)$/);
    if (boldPair) {
      const name = cleanText(boldPair[1]);
      const value = cleanText(boldPair[2].replace(/^[-*]\s*/, ""));
      flushPending();
      if (!value) {
        group = name;
        continue;
      }
      pending = { group, name, value, sourceUrl };
      continue;
    }

    const pipePair = line.match(/^\|?\s*([^|]{2,140})\s+\|\s+(.+?)\s*\|?$/);
    if (pipePair) {
      flushPending();
      attributes.push({ group, name: cleanText(pipePair[1]), value: cleanText(pipePair[2]), sourceUrl });
      continue;
    }

    const knownField = exactKnownFieldLine(line, knownFields);
    if (knownField) {
      const nextLine = lines[index + 1];
      if (isLikelyMarkdownValueLine(nextLine, knownFields)) {
        flushPending();
        pending = { group, name: knownField, value: cleanText(nextLine.replace(/^[-*]\s+/, "")), sourceUrl };
        index += 1;
        continue;
      }
    }

    const knownPair = splitKnownFieldLine(line, knownFields);
    if (knownPair) {
      flushPending();
      pending = { group, ...knownPair, sourceUrl };
      continue;
    }

    if (isLikelyEatonFieldLabel(line, lines[index + 1], group, knownFields)) {
      flushPending();
      pending = { group, name: cleanText(line.replace(/:$/, "")), value: cleanText(lines[index + 1].replace(/^[-*]\s+/, "")), sourceUrl };
      index += 1;
      continue;
    }

    if (pending && !isSectionBoundary(line)) {
      pending.value = cleanText(`${pending.value} ${line.replace(/^[-*]\s+/, "")}`);
    }
  }
  flushPending();
  return attributes;
}

function knownMarkdownFields(lines: string[]): string[] {
  const labels = new Set(KNOWN_FIELDS);
  for (const line of lines) {
    const match = line.match(/^\*\*([^*]{2,140})\*\*/);
    if (match) labels.add(cleanText(match[1]));
  }
  return [...labels].filter((label) => !isIgnoredAttributeSection(label)).sort((left, right) => right.length - left.length);
}

function splitKnownFieldLine(line: string, knownFields: string[]): { name: string; value: string } | undefined {
  for (const field of knownFields) {
    const match = line.match(new RegExp(`^${escapeRegExp(field)}\\s+(.+)$`, "i"));
    if (!match) continue;
    return { name: field, value: cleanText(match[1]) };
  }
  return undefined;
}

function exactKnownFieldLine(line: string, knownFields: string[]): string | undefined {
  const normalized = cleanText(line.replace(/:$/, ""));
  if (!normalized) return undefined;
  return knownFields.find((field) => field.toLowerCase() === normalized.toLowerCase());
}

function isLikelyMarkdownValueLine(line: string | undefined, knownFields: string[]): line is string {
  const cleaned = cleanText(line);
  if (/^add to list\s+download$/i.test(cleaned)) return false;
  if (!cleaned || isSectionBoundary(cleaned) || exactKnownFieldLine(cleaned, knownFields) || isIgnoredAttributeSection(cleaned)) return false;
  if (/^(?:download|add to list|clear selection|continue|submit|search|x|×|specifications|resources|support)$/i.test(cleaned)) return false;
  return true;
}

function isLikelyEatonFieldLabel(line: string, nextLine: string | undefined, group: string, knownFields: string[]): boolean {
  const cleaned = cleanText(line.replace(/:$/, ""));
  if (!isLikelyMarkdownValueLine(nextLine, knownFields) || isIgnoredAttributeSection(group) || /^eaton page$/i.test(group)) return false;
  if (!cleaned || cleaned.length < 2 || cleaned.length > 160 || isSectionBoundary(cleaned) || exactKnownFieldLine(cleaned, knownFields)) return false;
  if (/^[-*]|[|{}<>]|https?:\/\/|www\.|@/.test(cleaned)) return false;
  if (/:/.test(cleaned)) return false;
  if (isLikelyEatonValueLine(cleaned)) return false;
  if (/^(?:add to list|download|last ned|legg til|image|button|contact me|find|please|serial number|are you sure|cancel|sign out)$/i.test(cleaned)) {
    return false;
  }
  if (cleaned.split(/\s+/).length > 12) return false;
  if (/^\d+(?:\.\d+)+\s+\S/.test(cleaned)) return true;
  return /\b(?:actuator|air|ambient|analog|application|awg|battery|bezel|box|burst|bus|button|cable|capacity|catalog|category|certifications?|class|clearance|coil|color|communication|compliances?|conductors?|configuration|connection|connector|consumption|contact|continuous|cover|current|degree|design|diagnostics?|diameter|digital|discharge|dissipation|drop|ean|efficiency|electromagnetic|enclosure|environmental|explosion|features?|fall|frame|frequency|function|fuse|gland|height|horsepower|hp|humidity|illumination|immunity|impulse|input|insulation|interference|interrupt|isolation|jacket|length|lifespan|loss|material|method|model|mounting|nema|noise|number|operation|output|overvoltage|package|phase|plating|poles|pollution|position|power|pressure|product|protection|protocol|quantity|rating|receptacle|release|resistance|resolution|ripple|safety|sheath|shock|short-?circuit|size|software|standard|suitable|supply|surge|technology|temperature|terminal|thickness|thread|trip|type|upc|usb|used with|utili[sz]ation|vibration|voltage|warranty|weight|width|wire)\b/i.test(
    cleaned
  );
}

function isLikelyEatonValueLine(value: string): boolean {
  return /^(?:[<>≤≥]?\s*)?\d+(?:[.,]\d+)?\s*(?:(?:-|\.{2,3}|to)\s*\d+(?:[.,]\d+)?\s*)?(?:v(?:ac|dc)?|a|ma|ka|w|kw|va|hz|khz|mm|cm|m|in|lb|kg|g|%|°|db)\b/i.test(
    value
  );
}

function isSectionBoundary(line: string): boolean {
  return /^#+\s+/.test(line) || /^\*\*[^*]{2,140}\*\*/.test(line);
}

function isIgnoredAttributeSection(value: string | undefined): boolean {
  if (
    /\b(manuals and user guides|declarations of conformity|certification reports|warranty guides|time\/current curves|white papers|ecad model|mcad model|installation videos|installation instructions)\b/i.test(
      value ?? ""
    )
  ) {
    return true;
  }
  return /\b(export product specification|authenticate product|contact|how to buy|support|resources|specifications and datasheets|brochures|catalogs|drawings|manuals|application notes|multimedia|cross references|technical service bulletins|company|quick links|date)\b/i.test(
    value ?? ""
  );
}

function extractHtmlDocuments($: cheerio.CheerioAPI, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("meta[property='og:image'],meta[name='twitter:image'],meta[name='image']").each((_, element) => {
    const rawUrl = $(element).attr("content");
    const absolute = rawUrl ? toAbsoluteUrl(rawUrl, sourceUrl) : undefined;
    if (!absolute) return;
    const context = `Product image ${absolute} ${$(element).attr("property") ?? ""} ${$(element).attr("name") ?? ""}`;
    if (!looksLikeEatonProductImage(context, catalogNumber)) return;
    documents.push({ type: "image", label: "Product image", url: normalizeEatonImageUrl(absolute), sourceUrl });
  });

  $("img[src],img[data-src],img[data-lazy-src],source[srcset]").each((_, element) => {
    const rawUrl =
      $(element).attr("src") ||
      $(element).attr("data-src") ||
      $(element).attr("data-lazy-src") ||
      firstSrcsetUrl($(element).attr("srcset"));
    const absolute = rawUrl ? toAbsoluteUrl(rawUrl, sourceUrl) : undefined;
    if (!absolute) return;
    const label = cleanText($(element).attr("alt") || $(element).attr("title") || "Product image");
    const ancestorContext = $(element)
      .parents()
      .slice(0, 7)
      .map((__, parent) => $(parent).attr("class") || (parent as { tagName?: string }).tagName || "")
      .get()
      .join(" ");
    const context = `${label} ${absolute} ${$(element).attr("class") ?? ""} ${$(element).parent().attr("class") ?? ""} ${ancestorContext}`;
    if (!looksLikeEatonProductImage(context, catalogNumber)) return;
    const normalizedUrl = normalizeEatonImageUrl(absolute);
    documents.push({
      type: "image",
      label: label || "Product image",
      url: normalizedUrl,
      ...(normalizedUrl !== absolute ? { candidateUrls: [absolute, normalizedUrl] } : {}),
      sourceUrl
    });
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const url = toAbsoluteUrl(href, sourceUrl);
    if (!url) return;
    const label = readEatonLinkLabel($, element, url);
    if (!isEatonDocumentLink(label, url, catalogNumber)) return;
    documents.push({ type: classifyEatonDocument(label, url), label, url, sourceUrl });
  });

  return documents;
}

function extractHtmlRelatedProductAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();

  $(".module-related-products a[href],.upsell-products a[href],.related-products-component__card a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const url = href ? toAbsoluteUrl(href, sourceUrl) : undefined;
    if (!url || !/\/skuPage\.[^/]+\.html/i.test(url)) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const catalogNumber = relatedCatalogNumberFromUrl(url) || cleanText($(element).text());
    const card = $(element).closest(".related-products-component__card,.slides,.col-xs-12");
    const description = cleanRelatedProductDescription(cleanElementText(card), catalogNumber);
    attributes.push({
      group: "Designed to work together",
      name: "Related Product",
      value: cleanText([catalogNumber, description].filter(Boolean).join(" - ") + ` (${url})`),
      sourceUrl
    });
  });

  return attributes.slice(0, 60);
}

function relatedCatalogNumberFromUrl(url: string): string | undefined {
  try {
    const match = new URL(url).pathname.match(/\/skuPage\.([^/]+?)\.html$/i);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function cleanRelatedProductDescription(value: string, catalogNumber: string | undefined): string | undefined {
  let cleaned = cleanText(value);
  if (catalogNumber) {
    const partPattern = escapeRegExp(catalogNumber);
    cleaned = cleanText(cleaned.replace(new RegExp(`^(?:${partPattern}\\s*){1,4}`, "i"), ""));
  }
  if (!cleaned || cleaned.toLowerCase() === catalogNumber?.toLowerCase()) return undefined;
  return cleaned;
}

function readEatonLinkLabel($: cheerio.CheerioAPI, element: any, url: string): string {
  const rawLabel =
    $(element).attr("data-title") ||
    $(element).attr("aria-label")?.replace(/^download\s+(?:pdf\s+)?for\s+/i, "") ||
    $(element).text() ||
    $(element).closest("[data-title]").attr("data-title") ||
    url.split("/").pop() ||
    "Document";
  const label = normalizeEatonDocumentLabel(cleanText(rawLabel), url);
  const category = cleanText($(element).closest(".resource-list-item").find(".resource-list-item__title").first().text());
  if (!category || new RegExp(`^${escapeRegExp(category)}\\s*:`, "i").test(label)) return label;
  if (/^(?:download|document)$/i.test(label)) return category;
  return label.toLowerCase().includes(category.toLowerCase()) ? label : cleanText(`${label} (${category})`);
}

function normalizeEatonDocumentLabel(label: string, url: string): string {
  const skuPdf = url.match(/\/skuPage\.([^/?#]+)\.pdf(?:[?#]|$)/i);
  if (skuPdf && /^(?:product specifications?|download|document)$/i.test(label)) {
    return `Eaton Specification Sheet - ${cleanText(decodeUrlPart(skuPdf[1]))}`;
  }
  return label;
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcset
    ?.split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .find(Boolean);
}

function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  if (!value || /^javascript:|^mailto:|^tel:|^data:/i.test(value)) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function looksLikeEatonProductImage(context: string, catalogNumber: string): boolean {
  const haystack = context.toLowerCase();
  if (/logo|icon|email|social|geolocation|cookie|support|knowledge|registration|myeaton|footer|spinner|loader|article-feature|getty|rol-byod|abstract/i.test(haystack)) return false;
  if (/resources\/siteconfig|siteconfig\/360|\/360\.png|characteristic-curve|curve-|schematic|diagram/i.test(haystack)) return false;
  if (/\b(?:related-products|upsell-products|cross-sell|card-product-tiles)\b/i.test(haystack)) return false;
  if (/\.spin(?:[?#\s]|$)/i.test(haystack)) return false;
  const compactPart = compactCatalogNumber(catalogNumber);
  const compactHaystack = compactCatalogNumber(context);
  if (compactPart && compactHaystack.includes(compactPart)) return true;
  return /\/mdmfiles\//i.test(haystack) && /product|sku|catalog|image|photo/i.test(haystack);
}

function isEatonDocumentLink(label: string, url: string, catalogNumber: string): boolean {
  const combined = `${label} ${url}`;
  if (/\.(pdf|zip|dwg|dxf|stp|step)(?:[?#]|$)/i.test(url)) return true;
  if (/\b(catalog|brochure|manual|guide|instruction|data\s*sheet|datasheet|technical|specification|drawing|cad|ecad|mcad|3d model|2d model|curve|certificate|declaration|application note|service bulletin)\b|\bda-c[es]-/i.test(combined)) {
    return /\/content\/dam\/eaton\//i.test(url) || catalogTextMatches(combined, catalogNumber);
  }
  return false;
}

function classifyEatonDocument(label: string, url: string): DocumentRecord["type"] {
  const combined = `${label} ${url}`;
  if (/\/skuPage\.[^/]+\.pdf(?:[?#]|$)/i.test(url)) return "datasheet";
  if (/\.(?:dwg|dxf|stp|step|zip)(?:[?#]|$)|\b(?:cad|ecad|mcad|3d|2d|drawing|3d model|2d model)\b|\bda-c[es]-/i.test(combined)) return "cad";
  if (/\b(?:manual|instruction|installation|user guide|service manual)\b/i.test(combined)) return "manual";
  if (/\b(?:warranty|guarantee|service plan|service option|service contract)\b/i.test(combined)) return "other";
  if (/\b(?:characteristic curve|curve|schematic|diagram)\b/i.test(combined)) return "other";
  if (/\b(?:certificate|certification|declaration|conformity|rohs|weee|reach|prop(?:osition)?\s*65)\b/i.test(combined)) return "certificate";
  if (/\.(?:pdf)(?:[?#]|$)/i.test(url)) return "datasheet";
  return classifyDocument(label, url);
}

function extractMarkdownImages(text: string, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const match of text.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const label = cleanText(match[1]) || "Product image";
    const originalUrl = match[2];
    const url = normalizeEatonImageUrl(originalUrl);
    const haystack = `${label} ${originalUrl} ${url}`.toLowerCase();
    if (!haystack.includes(catalogNumber.toLowerCase()) && !/\/mdmfiles\//i.test(originalUrl)) continue;
    if (/logo|icon|email|social|geolocation|cookie/i.test(haystack)) continue;
    documents.push({ type: "image", label, url, sourceUrl });
  }
  return documents.slice(0, 8);
}

function normalizeEatonImageUrl(url: string): string {
  const match = url.match(/\/mdmfiles\/[^/]+\/([^/?#]+)\/(?:\d+x\d+_[^/?#]+)/i);
  if (!match) return url;
  return `https://dynamicmedia.eaton.com/is/image/eaton/${encodeURIComponent(match[1])}?wid=500&hei=500`;
}

function extractMarkdownLinks(text: string, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const label = cleanText(match[1]);
    const url = match[2];
    if (!/\.(pdf|zip|dwg|dxf|stp|step)(?:[?#]|$)/i.test(url) && !isEatonDocumentLink(label, url, catalogNumber)) continue;
    const type = classifyEatonDocument(label, url);
    if (type === "other" && !catalogTextMatches(`${label} ${url}`, catalogNumber) && !/\bwarranty\b/i.test(`${label} ${url}`)) continue;
    documents.push({ type, label, url, sourceUrl });
  }
  return documents;
}

function readDescription(lines: string[], catalogNumber: string): string | undefined {
  const descriptionLabel = lines.find((line) => /^descriptionLabel/i.test(line));
  if (descriptionLabel) return cleanText(descriptionLabel.replace(/^descriptionLabel/i, ""));
  const headingIndex = lines.findIndex((line) => line.replace(/^#+\s*/, "").toLowerCase() === catalogNumber.toLowerCase());
  if (headingIndex >= 0) {
    return lines.slice(headingIndex + 1).find((line) => line.length > 20 && !/^(specifications|resources|sku|serial number)/i.test(line));
  }
  return undefined;
}

function readMarkdownTitle(lines: string[]): string | undefined {
  return cleanText(
    readPrefixedLine(lines, "Title:")?.replace(/\s+\|\s+Eaton$/i, "") ||
      lines.find((line) => line.startsWith("# "))?.replace(/^#+\s*/, "").replace(/\s+\|\s+Eaton$/i, "")
  );
}

function readPrefixedLine(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

function cleanMarkdownLine(value: string): string {
  return cleanText(value.replace(/^[-*]\s+/, "").replace(/\\_/g, "_"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  const seen = new Set<string>();
  return attributes.filter((attr) => {
    const key = `${attr.group ?? ""}|${attr.name}|${attr.value}`.toLowerCase();
    if (seen.has(key) || !attr.name || !attr.value) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const order: string[] = [];
  const byUrl = new Map<string, DocumentRecord>();
  for (const doc of documents) {
    const key = doc.url.toLowerCase();
    if (!doc.url) continue;
    const existing = byUrl.get(key);
    if (!existing) {
      order.push(key);
      byUrl.set(key, doc);
      continue;
    }
    if (documentLabelScore(doc) > documentLabelScore(existing)) byUrl.set(key, doc);
  }
  return order.map((key) => byUrl.get(key)).filter((doc): doc is DocumentRecord => Boolean(doc));
}

function documentLabelScore(doc: DocumentRecord): number {
  let score = doc.label.length;
  if (/\b(eaton specification sheet|data\s*sheet|datasheet|technical data|3d drawing|cad|manual|installation|catalog)\b/i.test(doc.label)) score += 80;
  if (/^(download|document|product specifications?)$/i.test(doc.label)) score -= 60;
  if (doc.type === "datasheet" || doc.type === "cad" || doc.type === "manual") score += 20;
  return score;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
