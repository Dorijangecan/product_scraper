import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { catalogTextMatches, compactCatalogNumber } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { parseGenericProductPage } from "./generic.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const ROCKWELL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const ROCKWELL_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export class RockwellConnector implements ManufacturerConnector {
  readonly id = "rockwell";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const results: ProductResult[] = [];
    const urls = rockwellPrimaryUrls(catalogNumber);
    const attemptedUrls: string[] = [...urls];

    // Parallelize the 5 endpoints — each lives on an independent host so per-host throttling doesn't apply.
    const fetchedAll = await Promise.all(urls.map((url) => fetchRockwellOptional(url, context)));

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const fetched = fetchedAll[i];
      if (!fetched) continue;

      if (rockwellFamilyPageForCatalog(catalogNumber) === url) {
        results.push(parseRockwellFamilyPage(catalogNumber, fetched));
        continue;
      }

      if (/\/bin\/rockwell-automation\/dpp\b/i.test(url)) {
        const dpp = parseRockwellDpp(catalogNumber, fetched);
        if (dpp) results.push(dpp);
        continue;
      }

      if (/\/cutsheet\b/i.test(url)) {
        results.push(parseRockwellCutsheetPage(catalogNumber, fetched));
        continue;
      }

      if (/\/drawings\b/i.test(url)) {
        results.push(parseRockwellDrawingsPage(catalogNumber, fetched));
        continue;
      }

      const parsed = parseGenericProductPage("rockwell", catalogNumber, fetched, "official", "rockwell-product-page", {
        localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
        markerRules: context.manufacturer.markerRules,
        extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy,
        confidence: 0.78
      });
      // parseGenericProductPage's own identity gate is a plain (non-boundary-anchored) substring
      // match, shared across every manufacturer — it would accept a sibling catalog's page (e.g.
      // "1606-XLB120EH") as evidence for "1606-XLB120E" since the shorter number is a literal
      // prefix. Re-verify with the boundary-anchored check before trusting this page at all.
      if (parsed.status !== "failed" && matchesRockwellCatalogStrict(fetched.text, catalogNumber)) {
        results.push(withRockwellConfidence(enrichRockwellParsedPage(parsed, fetched, catalogNumber, "rockwell-product-page"), 0.84));
      }
    }

    const merged = mergeRockwellResults(results);
    if (merged && merged.status !== "failed") {
      return {
        ...finalizeRockwellResult(merged),
        diagnostics: {
          ...merged.diagnostics,
          attemptedUrls: [...(merged.diagnostics?.attemptedUrls ?? []), ...attemptedUrls]
        }
      };
    }

    const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: "rockwell" });
    const fallbackResult = fallback
      ? finalizeRockwellResult(fallback)
      : emptyResult("rockwell", catalogNumber, "No Rockwell Automation product data could be fetched through primary endpoints, official discovery, or configured fallback pages.");

    return withDiscoveryFallbackDiagnostics(
      {
        ...fallbackResult,
        diagnostics: {
          ...fallbackResult.diagnostics,
          attemptedUrls: [...(fallbackResult.diagnostics?.attemptedUrls ?? []), ...attemptedUrls]
        }
      },
      discovery
    );
  }
}

function rockwellPrimaryUrls(catalogNumber: string): string[] {
  const encoded = encodeURIComponent(catalogNumber);
  const lower = encodeURIComponent(catalogNumber.toLowerCase());
  const dppParams = new URLSearchParams({ catalogNumber: catalogNumber.toLowerCase(), serialNumber: "" });
  const familyUrl = rockwellFamilyPageForCatalog(catalogNumber);
  return [
    `https://www.rockwellautomation.com/en-us/products/details.${encoded}.html`,
    `https://www.rockwellautomation.com/en-us/products/details.${lower}.html`,
    `https://configurator.rockwellautomation.com/api/Product/${encoded}/cutsheet`,
    `https://configurator.rockwellautomation.com/api/Product/${encoded}/drawings`,
    `https://www.rockwellautomation.com/bin/rockwell-automation/dpp?${dppParams.toString()}`,
    familyUrl
  ].filter(Boolean) as string[];
}

async function fetchRockwellOptional(url: string, context: ScrapeContext): Promise<FetchedText | undefined> {
  try {
    const fetched = await context.http.fetchText(url, {
      timeoutMs: 20000,
      cacheTtlMs: ROCKWELL_CACHE_TTL_MS,
      maxAttempts: 1,
      signal: context.signal,
      headers: {
        "user-agent": ROCKWELL_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    return fetched.statusCode < 400 ? fetched : undefined;
  } catch {
    return undefined;
  }
}

function mergeRockwellResults(results: ProductResult[]): ProductResult | undefined {
  const usable = results.filter((result) => result.status !== "failed");
  if (!usable.length) return undefined;
  return usable.reduce((merged, result) => mergeResults(merged, result));
}

function finalizeRockwellResult(result: ProductResult): ProductResult {
  const attributes = dedupeAttributes(result.attributes);
  const documents = dedupeDocuments(result.documents);
  const normalized = normalizeFields(attributes, documents);
  const title = cleanText(result.title) || attrValue(attributes, /\b(product name|catalog description|description)\b/i);
  const description = preferredRockwellDescription(cleanText(result.description), title, attributes);
  const productUrl = preferredRockwellProductUrl(result);
  const richEnough = attributes.length >= 8 || documents.some((doc) => doc.type === "datasheet" || doc.type === "cad" || doc.type === "image");
  return {
    ...result,
    status: richEnough ? "found" : result.status,
    confidence: richEnough ? Math.max(result.confidence, 0.86) : result.confidence,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("rockwell", result.catalogNumber, productUrl, result.localizedUrls ? undefined : undefined),
    title,
    description,
    normalized,
    attributes,
    documents
  };
}

function preferredRockwellDescription(current: string, title: string | undefined, attributes: AttributeRecord[]): string | undefined {
  const attributeDescription = attrValue(attributes, /\bdescription\b/i);
  if (attributeDescription && (!current || sameText(current, title) || attributeDescription.length > current.length + 12)) {
    return attributeDescription;
  }
  return current || attributeDescription;
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  const normalize = (value: string | undefined) => cleanText(value ?? "").toLowerCase().replace(/[\s._-]+/g, "");
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function withRockwellConfidence(result: ProductResult, confidence: number): ProductResult {
  return {
    ...result,
    confidence: Math.max(result.confidence, confidence),
    attributes: result.attributes.map((attribute) => ({
      ...attribute,
      sourceType: attribute.sourceType ?? "official",
      parser: attribute.parser ?? "rockwell-product-page",
      confidence: attribute.confidence ?? confidence
    })),
    documents: result.documents.map((document) => ({
      ...document,
      sourceType: document.sourceType ?? "official",
      parser: document.parser ?? "rockwell-product-page",
      confidence: document.confidence ?? confidence
    }))
  };
}

function enrichRockwellParsedPage(result: ProductResult, fetched: FetchedText, catalogNumber: string, parser: string): ProductResult {
  const $ = cheerio.load(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const attributes = dedupeAttributes([
    ...result.attributes,
    ...extractRockwellStructuredAttributes($, fetched.text, sourceUrl, catalogNumber, parser)
  ]);
  const documents = dedupeDocuments([
    ...result.documents,
    ...extractRockwellDocumentLinks($, catalogNumber, sourceUrl, parser)
  ]);
  return {
    ...result,
    normalized: normalizeFields(attributes, documents),
    attributes,
    documents
  };
}

export function parseRockwellCutsheetPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  if (fetched.statusCode >= 400 || !matchesRockwellCatalogStrict(fetched.text, catalogNumber)) {
    return emptyResult("rockwell", catalogNumber, "Rockwell cutsheet page did not contain the catalog number.");
  }
  const generic = parseGenericProductPage("rockwell", catalogNumber, fetched, "official", "rockwell-cutsheet", {
    match: { compact: true, ignoreCase: true },
    confidence: 0.82
  });
  const $ = cheerio.load(fetched.text);
  const title = cleanText($("h3").first().text()) || generic.title;
  const linkedCatalog = cleanText($("a[href*='configurator']").first().text());
  const description = cleanText($("h3").first().nextAll("p").first().text()) || generic.description;
  const sourceUrl = fetched.effectiveUrl;
  const attributes: AttributeRecord[] = [
    ...generic.attributes,
    ...optionalAttribute("Rockwell Cutsheet", "Catalog Number", linkedCatalog || catalogNumber, sourceUrl),
    ...optionalAttribute("Rockwell Cutsheet", "Product Family", title, sourceUrl),
    ...optionalAttribute("Rockwell Cutsheet", "Description", description, sourceUrl),
    ...extractRockwellStructuredAttributes($, fetched.text, sourceUrl, catalogNumber, "rockwell-cutsheet"),
    ...extractRockwellCutsheetTextAttributes(catalogNumber, fetched.text, sourceUrl)
  ];
  const documents: DocumentRecord[] = [
    ...generic.documents,
    {
      type: "datasheet",
      label: "Rockwell product cutsheet",
      url: sourceUrl,
      sourceUrl,
      sourceType: "official",
      parser: "rockwell-cutsheet",
      confidence: 0.88
    },
    ...extractRockwellDocumentLinks($, catalogNumber, sourceUrl, "rockwell-cutsheet")
  ];

  return buildRockwellResult(catalogNumber, fetched, "rockwell-cutsheet", title, description, attributes, documents, 0.84);
}

export function parseRockwellDrawingsPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  if (fetched.statusCode >= 400 || !matchesRockwellCatalogStrict(fetched.text, catalogNumber)) {
    return emptyResult("rockwell", catalogNumber, "Rockwell drawings page did not contain the catalog number.");
  }
  const $ = cheerio.load(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const attributes: AttributeRecord[] = [
    ...optionalAttribute("Rockwell Drawings", "Catalog Number", catalogNumber, sourceUrl)
  ];
  const documents = extractRockwellDocumentLinks($, catalogNumber, sourceUrl, "rockwell-drawings");
  return buildRockwellResult(catalogNumber, fetched, "rockwell-drawings", undefined, undefined, attributes, documents, 0.8);
}

export function parseRockwellFamilyPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  const family = rockwellFamilyForCatalog(catalogNumber);
  if (!family || fetched.statusCode >= 400) {
    return emptyResult("rockwell", catalogNumber, "Rockwell family page is not available for this catalog.");
  }

  const pageText = cleanText(fetched.text);
  if (!family.identity.test(pageText)) {
    return emptyResult("rockwell", catalogNumber, "Rockwell family page did not match the expected product family.");
  }

  const $ = cheerio.load(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const generic = parseGenericProductPage("rockwell", catalogNumber, fetched, "official", "rockwell-family-page", {
    confidence: 0.72
  });
  const title = generic.title ?? cleanText($("h1").first().text());
  const description = generic.description ?? title;
  const documents: DocumentRecord[] = [
    {
      type: "datasheet",
      label: "Rockwell family page",
      url: sourceUrl,
      sourceUrl,
      sourceType: "official",
      parser: "rockwell-family-page",
      confidence: 0.86
    },
    ...generic.documents,
    ...extractRockwellDocumentLinks($, catalogNumber, sourceUrl, "rockwell-family-page")
  ];
  const attributes: AttributeRecord[] = [
    ...generic.attributes,
    ...optionalAttribute("Rockwell Family", "Catalog Number", catalogNumber, sourceUrl, "rockwell-family-page"),
    ...optionalAttribute("Rockwell Family", "Product Family", title, sourceUrl, "rockwell-family-page"),
    ...optionalAttribute("Rockwell Family", "Description", description, sourceUrl, "rockwell-family-page")
  ];

  return buildRockwellResult(catalogNumber, fetched, "rockwell-family-page", title, description, attributes, documents, 0.78);
}

export function parseRockwellDpp(catalogNumber: string, fetched: FetchedText): ProductResult | undefined {
  const payload = decodeRockwellDppPayload(fetched.text);
  if (!payload) return undefined;
  if (!dppPayloadMatchesCatalog(payload, catalogNumber)) return undefined;
  const sourceUrl = fetched.effectiveUrl;
  const attributes: AttributeRecord[] = [
    ...optionalAttribute("Rockwell Digital Product Passport", "DPP Last Updated", cleanDppString(payload.lastUpdated), sourceUrl, "rockwell-digital-product-passport"),
    ...optionalAttribute("Rockwell Digital Product Passport", "DPP Schema Version", cleanDppString(payload.dppSchemaVersion), sourceUrl, "rockwell-digital-product-passport")
  ];
  const documents: DocumentRecord[] = [];
  collectDppElements(payload.elements, sourceUrl, attributes, documents);

  const productUrl = cleanDppString(payload.uniqueProductIdentifier) || attrValue(attributes, /\bunique product identifier\b/i);
  const title = attrValue(attributes, /\bproduct name\b/i);
  const description = attrValue(attributes, /\bdescription\b/i) || title;

  const result = buildRockwellResult(catalogNumber, fetched, "rockwell-digital-product-passport", title, description, attributes, documents, 0.9);
  return {
    ...result,
    productUrl: productUrl && /^https?:\/\//i.test(productUrl) ? productUrl : result.productUrl,
    sources: result.sources.map((source) => ({
      ...source,
      reason: "Rockwell Digital Product Passport returned signed structured product data."
    }))
  };
}

function decodeRockwellDppPayload(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const credential = recordAt(parsed, "verifiableCredential");
    const id = cleanDppString(credential?.id);
    const jwt = id?.startsWith("data:") ? id.split(",").pop() : id;
    const payloadPart = jwt?.split(".")[1];
    if (!payloadPart) return undefined;
    const json = Buffer.from(base64UrlToBase64(payloadPart), "base64").toString("utf8");
    const payload = JSON.parse(json) as Record<string, unknown>;
    return payload && typeof payload === "object" ? payload : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlToBase64(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return padded + "=".repeat((4 - (padded.length % 4)) % 4);
}

function collectDppElements(
  value: unknown,
  sourceUrl: string,
  attributes: AttributeRecord[],
  documents: DocumentRecord[],
  group = "Rockwell Digital Product Passport"
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const label = dppElementLabel(item);
    const nextGroup = label && /(?:info|dimensions|categor|facility|producer)/i.test(label) ? `Rockwell ${label}` : group;
    const rawValue = cleanDppString(item.value);
    const url = cleanDppString(item.url);
    if (label && rawValue) {
      attributes.push({
        group,
        name: label,
        value: normalizeRockwellUnit(rawValue),
        sourceUrl,
        sourceType: "official",
        parser: "rockwell-digital-product-passport",
        confidence: 0.92
      });
    }
    if (label && url && /^https?:\/\//i.test(url)) {
      const contentType = cleanDppString(item.contentType) ?? "";
      documents.push({
        type: classifyRockwellDppDocument(label, url, contentType),
        label: cleanDppString(item.resourceTitle) || label,
        url,
        sourceUrl,
        sourceType: "official",
        parser: "rockwell-digital-product-passport",
        confidence: 0.9
      });
    }
    collectDppElements(item.elements, sourceUrl, attributes, documents, nextGroup);
  }
}

function dppElementLabel(item: Record<string, unknown>): string | undefined {
  const named = Array.isArray(item.name)
    ? item.name.map((entry) => (isRecord(entry) ? cleanDppString(entry.value) : undefined)).find(Boolean)
    : undefined;
  return cleanText(named || humanizeRockwellKey(cleanDppString(item.elementId)));
}

function normalizeRockwellUnit(value: string): string {
  return cleanText(value)
    .replace(/\bGRM\b/gi, "g")
    .replace(/\bKGM\b/gi, "kg")
    .replace(/\bCMT\b/gi, "cm")
    .replace(/\bMMT\b/gi, "mm")
    .replace(/\bMTR\b/gi, "m")
    .replace(/\bINH\b/gi, "in");
}

function extractRockwellCutsheetTextAttributes(catalogNumber: string, html: string, sourceUrl: string): AttributeRecord[] {
  const lines = rockwellTextLinesFromHtml(html);
  const attributes: AttributeRecord[] = [];
  let section = "Rockwell Cutsheet";

  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index];
    if (isRockwellCutsheetSection(line)) {
      section = `Rockwell Cutsheet - ${canonicalRockwellCutsheetSection(line)}`;
      continue;
    }
    if (isRockwellCutsheetNoise(line, catalogNumber)) continue;

    const value = lines[index + 1];
    if (!isRockwellCutsheetLabel(line) || !isRockwellCutsheetValue(value, catalogNumber)) continue;
    if (isRockwellCutsheetSection(value) || isRockwellCutsheetNoise(value, catalogNumber)) continue;

    attributes.push({
      group: section,
      name: canonicalRockwellCutsheetLabel(line),
      value: normalizeRockwellCutsheetValue(value),
      sourceUrl,
      sourceType: "official",
      parser: "rockwell-cutsheet",
      confidence: 0.82
    });
    index += 1;
  }

  return dedupeAttributes(attributes).slice(0, 120);
}

function rockwellTextLinesFromHtml(html: string): string[] {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(?:td|th|tr|table|p|div|li|h[1-6]|section|article)\s*>/gi, "\n")
    .replace(/<\s*(?:td|th|tr|table|p|div|li|h[1-6]|section|article)[^>]*>/gi, "\n");
  return cheerio.load(withBreaks).root().text()
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean);
}

function isRockwellCutsheetSection(line: string): boolean {
  return /^(?:product details|data|additional details|accessories|manufacturing|family|supporting documentation and downloads|circuit breaker data|contact block data)$/i.test(line);
}

function canonicalRockwellCutsheetSection(line: string): string {
  return cleanText(line).toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function isRockwellCutsheetNoise(line: string, catalogNumber: string): boolean {
  return (
    /^cut sheet\b/i.test(line) ||
    /^product registration link$/i.test(line) ||
    /^link to literature library/i.test(line) ||
    /^supporting documentation and downloads$/i.test(line) ||
    catalogTextMatches(line, catalogNumber, { compact: true, ignoreCase: true })
  );
}

function isRockwellCutsheetLabel(line: string): boolean {
  if (line.length < 2 || line.length > 140) return false;
  if (/^(?:yes|no|none|not applicable|factory assembled)$/i.test(line)) return false;
  if (/^(?:\d+(?:[.,]\d+)?\s*)?(?:v|a|w|kw|kg|g|mm|cm|in|°c|°f|ip\d+)/i.test(line)) return false;
  return /[A-Za-z]/.test(line);
}

function isRockwellCutsheetValue(line: string, catalogNumber: string): boolean {
  if (!line || line.length > 500) return false;
  if (/^cut sheet\b/i.test(line)) return false;
  if (catalogTextMatches(line, catalogNumber, { compact: true, ignoreCase: true })) return true;
  return /[A-Za-z0-9]/.test(line);
}

function canonicalRockwellCutsheetLabel(line: string): string {
  return cleanText(line)
    .replace(/\(A\)\b/i, "(A)")
    .replace(/\s+/g, " ");
}

function normalizeRockwellCutsheetValue(value: string): string {
  return cleanText(value)
    .replace(/\b(\d+(?:[.,]\d+)?)\s*Arms\b/gi, "$1 A RMS")
    .replace(/&amp;/gi, "&")
    .replace(/\s*â€¦\s*/g, "...")
    .replace(/\s*…\s*/g, "...");
}

function extractRockwellStructuredAttributes(
  $: cheerio.CheerioAPI,
  html: string,
  sourceUrl: string,
  catalogNumber: string,
  parser: string
): AttributeRecord[] {
  const attributes: AttributeRecord[] = [
    ...extractRockwellDomTableAttributes($, sourceUrl, parser),
    ...extractRockwellDataAttributeSpecs($, sourceUrl, parser),
    ...extractRockwellJsonPairAttributes(html, sourceUrl, parser)
  ];
  return dedupeAttributes(attributes)
    .filter((attr) => isUsefulRockwellStructuredAttribute(attr, catalogNumber))
    .slice(0, 180);
}

function extractRockwellDomTableAttributes($: cheerio.CheerioAPI, sourceUrl: string, parser: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("tr").each((_, row) => {
    const cells = $(row)
      .find("th,td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);
    if (cells.length < 2) return;
    const name = canonicalRockwellCutsheetLabel(cells[0]);
    const value = normalizeRockwellCutsheetValue(joinUniqueRockwellCells(cells.slice(1)));
    if (!isLikelyRockwellSpecName(name) || !isLikelyRockwellSpecValue(value)) return;
    attributes.push({
      group: rockwellStructuredGroup($, row, "Rockwell Structured Table"),
      name,
      value,
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.86
    });
  });

  $("dt").each((_, element) => {
    const name = canonicalRockwellCutsheetLabel($(element).text());
    const value = normalizeRockwellCutsheetValue($(element).next("dd").text());
    if (!isLikelyRockwellSpecName(name) || !isLikelyRockwellSpecValue(value)) return;
    attributes.push({
      group: rockwellStructuredGroup($, element, "Rockwell Structured List"),
      name,
      value,
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.84
    });
  });

  return attributes;
}

function extractRockwellDataAttributeSpecs($: cheerio.CheerioAPI, sourceUrl: string, parser: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $(
    "*[data-label],*[data-name],*[data-display-name],*[data-attribute-name],*[data-spec-name],*[data-title],*[data-value],*[data-attribute-value],*[data-spec-value]"
  ).each((_, element) => {
    const attrs = (element as { attribs?: Record<string, string> }).attribs ?? {};
    const name = firstCleanRockwellValue(
      attrs["data-label"],
      attrs["data-name"],
      attrs["data-display-name"],
      attrs["data-attribute-name"],
      attrs["data-spec-name"],
      attrs["data-title"],
      attrs["aria-label"]
    );
    const value = firstCleanRockwellValue(
      attrs["data-value"],
      attrs["data-attribute-value"],
      attrs["data-spec-value"],
      attrs["data-text"],
      attrs.value,
      $(element).text()
    );
    if (!name || !value || name === value) return;
    if (!isLikelyRockwellSpecName(name) || !isLikelyRockwellSpecValue(value)) return;
    attributes.push({
      group: rockwellStructuredGroup($, element, "Rockwell Data Attributes"),
      name: canonicalRockwellCutsheetLabel(name),
      value: normalizeRockwellCutsheetValue(value),
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.82
    });
  });
  return attributes;
}

function extractRockwellJsonPairAttributes(html: string, sourceUrl: string, parser: string): AttributeRecord[] {
  const decoded = decodeRockwellEmbeddedText(html);
  const attributes: AttributeRecord[] = [];
  const labelValuePattern =
    /"(?:attributeName|displayName|label|name|title|propertyName)"\s*:\s*"((?:\\.|[^"\\]){2,140})"[\s\S]{0,700}?"(?:value|displayValue|attributeValue|text|propertyValue|values)"\s*:\s*(?:"((?:\\.|[^"\\]){1,400})"|\[((?:\\.|[^\]\\]){1,600})\])/gi;
  for (const match of decoded.matchAll(labelValuePattern)) {
    const name = unescapeRockwellJsonString(match[1]);
    const value = normalizeRockwellJsonValue(match[2] ?? match[3]);
    if (!name || !value) continue;
    if (!isLikelyRockwellSpecName(name) || !isLikelyRockwellSpecValue(value)) continue;
    attributes.push({
      group: "Rockwell Embedded JSON",
      name: canonicalRockwellCutsheetLabel(name),
      value: normalizeRockwellCutsheetValue(value),
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.8
    });
  }
  return attributes;
}

function rockwellStructuredGroup($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0], fallback: string): string {
  const container = $(element).parents("section,article,div").first();
  const heading = $(element).prevAll("h1,h2,h3,h4,h5,h6").first().text() ||
    container.find("h1,h2,h3,h4,h5,h6").first().text() ||
    container.prevAll("h1,h2,h3,h4,h5,h6").first().text();
  const cleaned = cleanText(heading);
  return cleaned ? `${fallback} - ${canonicalRockwellCutsheetSection(cleaned)}` : fallback;
}

function joinUniqueRockwellCells(cells: string[]): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const cell of cells) {
    const value = cleanText(cell);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values.join(" | ");
}

function firstCleanRockwellValue(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => cleanText(value)).find(Boolean);
}

function decodeRockwellEmbeddedText(value: string): string {
  return value
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function unescapeRockwellJsonString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return cleanText(JSON.parse(`"${value.replace(/"/g, "\\\"")}"`) as string);
  } catch {
    return cleanText(value.replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
  }
}

function normalizeRockwellJsonValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const decoded = decodeRockwellEmbeddedText(value);
  const stringValues = [...decoded.matchAll(/"((?:\\.|[^"\\])+)"/g)]
    .map((match) => unescapeRockwellJsonString(match[1]))
    .filter((entry): entry is string => Boolean(entry));
  if (stringValues.length > 0) return joinUniqueRockwellCells(stringValues);
  return unescapeRockwellJsonString(decoded);
}

function isUsefulRockwellStructuredAttribute(attr: AttributeRecord, catalogNumber: string): boolean {
  const name = cleanText(attr.name);
  const value = cleanText(attr.value);
  if (!name || !value) return false;
  if (catalogTextMatches(name, catalogNumber, { compact: true, ignoreCase: true })) return false;
  if (/^(?:image|url|href|link|path|locale|language|id|uuid|guid|slug|status|available|active)$/i.test(name)) return false;
  return true;
}

function isLikelyRockwellSpecName(value: string): boolean {
  const name = cleanText(value);
  if (!name || name.length < 2 || name.length > 140) return false;
  if (/^(?:yes|no|true|false|null|undefined|\d+|select|view|download)$/i.test(name)) return false;
  if (/^(?:href|url|src|alt|title|class|style|target|rel|type)$/i.test(name)) return false;
  const pair = splitNameValue(name);
  if (pair && pair.value.length > pair.name.length) return false;
  return /[a-z]/i.test(name);
}

function isLikelyRockwellSpecValue(value: string): boolean {
  const cleaned = cleanText(value);
  if (!cleaned || cleaned.length > 500) return false;
  if (/^(?:select|view|download|learn more|sign in|add to cart)$/i.test(cleaned)) return false;
  return /[a-z0-9]/i.test(cleaned);
}

function extractRockwellDocumentLinks(
  $: cheerio.CheerioAPI,
  catalogNumber: string,
  sourceUrl: string,
  parser: string
): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("a[href],img[src],*[data-href],*[data-url],*[data-download-url],*[data-document-url],*[data-link]").each((_, element) => {
    for (const url of rockwellElementUrls(element, sourceUrl)) {
      if (isIgnoredRockwellUrl(url)) continue;
      const label = cleanText($(element).text() || $(element).attr("alt") || $(element).attr("title") || pathBaseName(url));
      const context = cleanText(`${label} ${url} ${$(element).closest("tr,li,div").text()}`);
      if (!isRockwellProductDocument(context, url, catalogNumber)) continue;
      documents.push({
        type: parser === "rockwell-drawings" ? "cad" : classifyRockwellDocument(label, url),
        label: label || pathBaseName(url),
        url,
        sourceUrl,
        sourceType: "official",
        parser,
        confidence: 0.84
      });
    }
  });
  for (const url of rockwellDocumentUrlsFromText($.root().html() ?? "", sourceUrl)) {
    if (isIgnoredRockwellUrl(url) || !isRockwellProductDocument(url, url, catalogNumber)) continue;
    documents.push({
      type: parser === "rockwell-drawings" ? "cad" : classifyRockwellDocument(pathBaseName(url), url),
      label: pathBaseName(url),
      url,
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.78
    });
  }
  return dedupeDocuments(documents);
}

function rockwellElementUrls(element: unknown, sourceUrl: string): string[] {
  const attrs = (element as { attribs?: Record<string, string> }).attribs ?? {};
  const candidates = [
    attrs.href,
    attrs.src,
    attrs["data-href"],
    attrs["data-url"],
    attrs["data-download-url"],
    attrs["data-document-url"],
    attrs["data-link"]
  ];
  return candidates
    .flatMap((value) => value ? [value, ...rockwellDocumentUrlCandidates(value)] : [])
    .map((value) => toAbsoluteUrl(value, sourceUrl))
    .filter((url): url is string => Boolean(url));
}

function rockwellDocumentUrlsFromText(text: string, sourceUrl: string): string[] {
  return rockwellDocumentUrlCandidates(text)
    .map((value) => toAbsoluteUrl(value, sourceUrl))
    .filter((url): url is string => Boolean(url));
}

function rockwellDocumentUrlCandidates(value: string | undefined): string[] {
  if (!value) return [];
  const decoded = value
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
  const matches = [
    ...decoded.matchAll(/https?:\/\/literature\.rockwellautomation\.com\/[^\s"'<>]+?\.(?:pdf|zip|dwg|dxf|stp|step|wmf)(?:[?#][^\s"'<>]*)?/gi),
    ...decoded.matchAll(/\/idc\/groups\/literature\/documents\/[^\s"'<>]+?\.(?:pdf|zip|dwg|dxf|stp|step|wmf)(?:[?#][^\s"'<>]*)?/gi)
  ];
  return matches.map((match) => match[0]);
}

function isRockwellProductDocument(context: string, url: string, catalogNumber: string): boolean {
  if (/\.(?:pdf|zip|dwg|dxf|stp|step|wmf)(?:[?#]|$)/i.test(url)) return true;
  if (/\/api\/Product\/[^/]+\/cutsheet\b/i.test(url)) return true;
  if (/\/resources\/images\/productinfo\//i.test(url)) return true;
  return matchesRockwellCatalogStrict(context, catalogNumber);
}

/**
 * Boundary-anchored catalog match, scoped to Rockwell's own page-identity checks (URL confirmation
 * + document-link attribution). `catalogTextMatches`'s "compact" fallback is a plain substring test
 * on punctuation-stripped text, so it treats "1606-XLB120E" as found inside "1606-XLB120EH" — a
 * genuinely different, longer sibling catalog number (Rockwell's 1606-XLB power supply line ships
 * ...90E / ...90EH / ...90EQ side by side, same prefix, different products). That false-positive
 * lets a sibling SKU's page/link get attributed to the wrong catalog number. Requiring the match to
 * not directly abut another alphanumeric character rejects that collision while still tolerating
 * punctuation/case differences around a genuine match.
 *
 * Deliberately NOT a change to the shared `catalogTextMatches` in catalog-number.ts: other callers
 * (e.g. the customer-document family-PDF fallback) intentionally rely on the looser prefix-tolerant
 * substring match, so tightening it globally would break that unrelated, already-working behavior.
 */
function matchesRockwellCatalogStrict(text: string, catalogNumber: string): boolean {
  if (!catalogTextMatches(text, catalogNumber, { compact: true, ignoreCase: true })) return false;
  const needle = compactCatalogNumber(catalogNumber);
  if (needle.length < 4) return true;
  const haystack = text.toLowerCase();
  const map: number[] = [];
  let compact = "";
  for (let i = 0; i < haystack.length; i += 1) {
    if (/[a-z0-9]/i.test(haystack[i])) {
      compact += haystack[i];
      map.push(i);
    }
  }
  let from = 0;
  while (true) {
    const index = compact.indexOf(needle, from);
    if (index === -1) return false;
    const startOrig = map[index];
    const endOrig = map[index + needle.length - 1];
    const before = startOrig > 0 ? haystack[startOrig - 1] : undefined;
    const after = endOrig + 1 < haystack.length ? haystack[endOrig + 1] : undefined;
    if (!/[a-z0-9]/i.test(before ?? "-") && !/[a-z0-9]/i.test(after ?? "-")) return true;
    from = index + 1;
  }
}

function classifyRockwellDocument(label: string, url: string): DocumentRecord["type"] {
  const combined = `${label} ${url}`;
  if (/\/resources\/images\/productinfo\/|\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(combined)) return "image";
  if (/\.(?:dwg|dxf|stp|step|wmf|zip)(?:[?#]|$)|\b(?:drawing|cad|3d|2d|step|dxf|dwg)\b/i.test(combined)) return "cad";
  if (/\b(?:manual|user manual|installation)\b/i.test(combined)) return "manual";
  if (/\/documents\/(?:in|um|rm)\//i.test(combined)) return "manual";
  if (/\b(?:cert|declaration|conformity|rohs|reach|ul|ce)\b/i.test(combined)) return "certificate";
  if (/\/documents\/td\//i.test(combined) || /\/cutsheet\b|\b(?:cutsheet|technical data|technical document|datasheet|data sheet)\b|\.pdf(?:[?#]|$)/i.test(combined)) return "datasheet";
  return "other";
}

function isIgnoredRockwellUrl(url: string): boolean {
  return /RockwellAutomation_logo|spotify\.com|privacy|sign[-_]?in|custhelp\.com/i.test(url);
}

function buildRockwellResult(
  catalogNumber: string,
  fetched: FetchedText,
  parser: string,
  title: string | undefined,
  description: string | undefined,
  attributes: AttributeRecord[],
  documents: DocumentRecord[],
  confidence: number
): ProductResult {
  const cleanAttributes = dedupeAttributes(attributes).filter((attribute) => attribute.name && attribute.value);
  const cleanDocuments = dedupeDocuments(documents);
  const normalized = normalizeFields(cleanAttributes, cleanDocuments);
  const sourceType: SourceRecord["sourceType"] = "official";
  return {
    manufacturerId: "rockwell",
    catalogNumber,
    status: cleanAttributes.length || cleanDocuments.length ? "partial" : "failed",
    confidence: cleanAttributes.length || cleanDocuments.length ? confidence : 0,
    productUrl: canonicalRockwellProductUrl(catalogNumber) ?? fetched.effectiveUrl,
    localizedUrls: buildLocalizedProductUrls("rockwell", catalogNumber, fetched.effectiveUrl),
    title: cleanText(title),
    description: cleanText(description),
    normalized,
    attributes: cleanAttributes.map((attribute) => ({
      ...attribute,
      sourceType: attribute.sourceType ?? sourceType,
      parser: attribute.parser ?? parser,
      confidence: attribute.confidence ?? confidence
    })),
    documents: cleanDocuments.map((document) => ({
      ...document,
      sourceType: document.sourceType ?? sourceType,
      parser: document.parser ?? parser,
      confidence: document.confidence ?? confidence
    })),
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType,
        parser,
        parserVersion: "rockwell-v1",
        stage: parser,
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      }
    ]
  };
}

function optionalAttribute(group: string, name: string, value: string | undefined, sourceUrl: string, parser = "rockwell-cutsheet"): AttributeRecord[] {
  const cleaned = cleanText(value);
  if (!cleaned) return [];
  return [{
    group,
    name,
    value: cleaned,
    sourceUrl,
    sourceType: "official",
    parser,
    confidence: 0.86
  }];
}

function attrValue(attributes: AttributeRecord[], pattern: RegExp): string | undefined {
  return attributes.find((attribute) => pattern.test(`${attribute.group ?? ""} ${attribute.name}`) && cleanText(attribute.value))?.value;
}

function canonicalRockwellProductUrl(catalogNumber: string): string | undefined {
  const familyUrl = rockwellFamilyPageForCatalog(catalogNumber);
  if (familyUrl) return familyUrl;
  const encoded = encodeURIComponent(catalogNumber);
  return `https://www.rockwellautomation.com/en-us/products/details.${encoded}.html`;
}

function preferredRockwellProductUrl(result: ProductResult): string | undefined {
  if (isCatalogConfirmedRockwellUrl(result.productUrl, result.catalogNumber)) return result.productUrl;
  return canonicalRockwellProductUrl(result.catalogNumber) ?? result.productUrl;
}

function isCatalogConfirmedRockwellUrl(url: string | undefined, catalogNumber: string): boolean {
  const cleaned = cleanText(url);
  if (!cleaned) return false;
  try {
    const parsed = new URL(cleaned);
    if (!/(^|\.)rockwellautomation\.com$/i.test(parsed.hostname)) return false;
    const full = decodeURIComponent(`${parsed.pathname}${parsed.search}`);
    if (/\/(?:search|site-search)(?:[/.?&]|$)|[?&](?:keyword|search|q)=/i.test(full)) return false;
    return matchesRockwellCatalogStrict(full, catalogNumber);
  } catch {
    return false;
  }
}

function dppPayloadMatchesCatalog(payload: Record<string, unknown>, catalogNumber: string): boolean {
  const values = dppValuesByLabel(payload.elements, /^(?:registered id|catalog number|catalogue number)$/i);
  if (!values.length) return true;
  return values.some((value) => matchesRockwellCatalogStrict(value, catalogNumber));
}

function dppValuesByLabel(value: unknown, labelPattern: RegExp): string[] {
  const values: string[] = [];
  const walk = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) walk(child);
      return;
    }
    if (!isRecord(item)) return;
    const label = dppElementLabel(item);
    const rawValue = cleanDppString(item.value);
    if (label && rawValue && labelPattern.test(label)) values.push(rawValue);
    walk(item.elements);
  };
  walk(value);
  return values;
}

function classifyRockwellDppDocument(label: string, url: string, contentType: string): DocumentRecord["type"] {
  if (/image/i.test(label) || /image\//i.test(contentType)) return "image";
  return classifyRockwellDocument(label, url);
}

interface RockwellFamilyPageRule {
  url: string;
  identity: RegExp;
}

function rockwellFamilyForCatalog(catalogNumber: string): RockwellFamilyPageRule | undefined {
  if (/^\s*2080-LC20-/i.test(catalogNumber)) {
    return {
      url: "https://www.rockwellautomation.com/en-us/products/hardware/allen-bradley/programmable-controllers/micro-controllers/micro800-family/micro820-controllers.html",
      identity: /\bMicro820\b/i
    };
  }
  return undefined;
}

function rockwellFamilyPageForCatalog(catalogNumber: string): string | undefined {
  return rockwellFamilyForCatalog(catalogNumber)?.url;
}

function humanizeRockwellKey(value: string | undefined): string {
  return cleanText(
    value
      ?.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

function cleanDppString(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const cleaned = cleanText(String(value));
    return cleaned || undefined;
  }
  return undefined;
}

function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function pathBaseName(url: string): string {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
  } catch {
    return url;
  }
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const next = value[key];
  return isRecord(next) ? next : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
