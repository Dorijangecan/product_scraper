import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { catalogTextMatches } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";
import { parseGenericProductPage } from "./generic.js";

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
      if (parsed.status !== "failed") results.push(withRockwellConfidence(parsed, 0.84));
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

    const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
    if (fallback) {
      return finalizeRockwellResult({
        ...fallback,
        diagnostics: {
          ...fallback.diagnostics,
          attemptedUrls: [...(fallback.diagnostics?.attemptedUrls ?? []), ...attemptedUrls]
        }
      });
    }

    return emptyResult("rockwell", catalogNumber, "No Rockwell Automation product data could be fetched.");
  }
}

function rockwellPrimaryUrls(catalogNumber: string): string[] {
  const encoded = encodeURIComponent(catalogNumber);
  const lower = encodeURIComponent(catalogNumber.toLowerCase());
  const dppParams = new URLSearchParams({ catalogNumber: catalogNumber.toLowerCase(), serialNumber: "" });
  return [
    `https://www.rockwellautomation.com/en-us/products/details.${encoded}.html`,
    `https://www.rockwellautomation.com/en-us/products/details.${lower}.html`,
    `https://configurator.rockwellautomation.com/api/Product/${encoded}/cutsheet`,
    `https://configurator.rockwellautomation.com/api/Product/${encoded}/drawings`,
    `https://www.rockwellautomation.com/bin/rockwell-automation/dpp?${dppParams.toString()}`
  ];
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
  const description = cleanText(result.description) || attrValue(attributes, /\bdescription\b/i);
  const productUrl =
    canonicalRockwellProductUrl(result.catalogNumber) ??
    result.productUrl;
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

export function parseRockwellCutsheetPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  if (fetched.statusCode >= 400 || !catalogTextMatches(fetched.text, catalogNumber, { compact: true, ignoreCase: true })) {
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
    ...optionalAttribute("Rockwell Cutsheet", "Description", description, sourceUrl)
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
  if (fetched.statusCode >= 400 || !catalogTextMatches(fetched.text, catalogNumber, { compact: true, ignoreCase: true })) {
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

export function parseRockwellDpp(catalogNumber: string, fetched: FetchedText): ProductResult | undefined {
  const payload = decodeRockwellDppPayload(fetched.text);
  if (!payload) return undefined;
  const sourceUrl = fetched.effectiveUrl;
  const attributes: AttributeRecord[] = [];
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
        type: /image/i.test(label) || /image\//i.test(contentType) ? "image" : "other",
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

function extractRockwellDocumentLinks(
  $: cheerio.CheerioAPI,
  catalogNumber: string,
  sourceUrl: string,
  parser: string
): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("a[href],img[src]").each((_, element) => {
    const rawUrl = $(element).attr("href") || $(element).attr("src");
    const url = rawUrl ? toAbsoluteUrl(rawUrl, sourceUrl) : undefined;
    if (!url || isIgnoredRockwellUrl(url)) return;
    const label = cleanText($(element).text() || $(element).attr("alt") || $(element).attr("title") || pathBaseName(url));
    const context = cleanText(`${label} ${url} ${$(element).closest("tr,li,div").text()}`);
    if (!isRockwellProductDocument(context, url, catalogNumber)) return;
    documents.push({
      type: parser === "rockwell-drawings" ? "cad" : classifyRockwellDocument(label, url),
      label: label || pathBaseName(url),
      url,
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.84
    });
  });
  return dedupeDocuments(documents);
}

function isRockwellProductDocument(context: string, url: string, catalogNumber: string): boolean {
  if (/\.(?:pdf|zip|dwg|dxf|stp|step|wmf)(?:[?#]|$)/i.test(url)) return true;
  if (/\/api\/Product\/[^/]+\/cutsheet\b/i.test(url)) return true;
  if (/\/resources\/images\/productinfo\//i.test(url)) return true;
  return catalogTextMatches(context, catalogNumber, { compact: true, ignoreCase: true });
}

function classifyRockwellDocument(label: string, url: string): DocumentRecord["type"] {
  const combined = `${label} ${url}`;
  if (/\/resources\/images\/productinfo\/|\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(combined)) return "image";
  if (/\.(?:dwg|dxf|stp|step|wmf|zip)(?:[?#]|$)|\b(?:drawing|cad|3d|2d|step|dxf|dwg)\b/i.test(combined)) return "cad";
  if (/\b(?:manual|user manual|installation)\b/i.test(combined)) return "manual";
  if (/\b(?:cert|declaration|conformity|rohs|reach|ul|ce)\b/i.test(combined)) return "certificate";
  if (/\/cutsheet\b|\b(?:cutsheet|technical data|technical document|datasheet|data sheet)\b|\.pdf(?:[?#]|$)/i.test(combined)) return "datasheet";
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

function optionalAttribute(group: string, name: string, value: string | undefined, sourceUrl: string): AttributeRecord[] {
  const cleaned = cleanText(value);
  if (!cleaned) return [];
  return [{
    group,
    name,
    value: cleaned,
    sourceUrl,
    sourceType: "official",
    parser: "rockwell-cutsheet",
    confidence: 0.86
  }];
}

function attrValue(attributes: AttributeRecord[], pattern: RegExp): string | undefined {
  return attributes.find((attribute) => pattern.test(`${attribute.group ?? ""} ${attribute.name}`) && cleanText(attribute.value))?.value;
}

function canonicalRockwellProductUrl(catalogNumber: string): string | undefined {
  const encoded = encodeURIComponent(catalogNumber);
  return `https://www.rockwellautomation.com/en-us/products/details.${encoded}.html`;
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
