import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, MarkerExtractionRule, ProductResult } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import type { FetchedText } from "./http-client.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { catalogTextMatches, sameCatalogNumber } from "./catalog-number.js";
import { extractMarkerData } from "./marker-extractor.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";

const ABB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export class ABBConnector implements ManufacturerConnector {
  id = "abb";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const urls = buildAbbOfficialUrls(catalogNumber);
    const officialResults: ProductResult[] = [];
    let lastError: unknown;

    for (const url of urls) {
      try {
        const fetched = await fetchAbbPage(url, context);
        officialResults.push(parseAbbProductPage(catalogNumber, fetched, context.manufacturer.markerRules));
      } catch (error) {
        lastError = error;
      }
    }

    const directPrimary = bestAbbResult(officialResults);
    if (directPrimary && isRichAbbResult(directPrimary)) return directPrimary;

    const searchPrimary = bestAbbResult(await fetchAbbSearchResults(catalogNumber, context));
    if (searchPrimary) return directPrimary && directPrimary.status !== "failed" ? mergeResults(searchPrimary, directPrimary) : searchPrimary;

    const primary =
      directPrimary ??
      officialResults.find((result) => result.status === "partial") ??
      officialResults[0] ??
      emptyResult("abb", catalogNumber, lastError instanceof Error ? lastError.message : "ABB fetch failed.");

    if (primary.status === "found") return primary;

    try {
      const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
      return mergeResults(primary, fallback);
    } catch (error) {
      return {
        ...primary,
        error: primary.error ?? (error instanceof Error ? error.message : "ABB fallback failed.")
      };
    }
  }
}

function bestAbbResult(results: ProductResult[]): ProductResult | undefined {
  const useful = results.filter((result) => result.status !== "failed");
  return useful.sort((left, right) => abbResultScore(right) - abbResultScore(left))[0];
}

function isRichAbbResult(result: ProductResult): boolean {
  return result.status === "found" && result.attributes.some((attr) => attr.group === "ABB Product Data") && result.attributes.length >= 25;
}

function abbResultScore(result: ProductResult): number {
  if (result.status === "failed") return -1000;
  const abbProductDataCount = result.attributes.filter((attr) => attr.group === "ABB Product Data").length;
  const electricalScore = (result.normalized.voltage ? 40 : 0) + (result.normalized.current ? 40 : 0);
  const physicalScore = (result.normalized.dimensions ? 20 : 0) + (result.normalized.weight ? 20 : 0) + (result.normalized.protection ? 15 : 0);
  return result.confidence * 100 + result.attributes.length + result.documents.length * 5 + abbProductDataCount * 4 + electricalScore + physicalScore;
}

async function fetchAbbPage(url: string, context: ScrapeContext) {
  try {
    const fetched = await context.http.fetchText(url, {
      timeoutMs: 25000,
      signal: context.signal,
      headers: { "user-agent": ABB_USER_AGENT }
    });
    if (fetched.statusCode < 400 && fetched.text.trim()) return fetched;
  } catch {
    // Fall through to PowerShell on Windows for sites that reject fetch.
  }
  if (process.platform === "win32") {
    return context.http.fetchTextViaPowerShell(url, { timeoutMs: 30000, signal: context.signal });
  }
  return context.http.fetchText(url, { timeoutMs: 25000, signal: context.signal });
}

function buildAbbOfficialUrls(catalogNumber: string): string[] {
  const smartlinksParams = new URLSearchParams({
    ProductId: catalogNumber,
    Language: "en",
    PrintPreview: "False",
    pid: catalogNumber
  });

  return [
    `https://new.abb.com/products/${encodeURIComponent(catalogNumber)}`,
    `https://new.abb.com/products/en/${encodeURIComponent(catalogNumber)}`,
    `https://www.abb.com/global/en/products/${encodeURIComponent(catalogNumber)}`,
    `https://new.abb.com/smartlinks/en?${smartlinksParams.toString()}`
  ];
}

async function fetchAbbSearchResults(catalogNumber: string, context: ScrapeContext): Promise<ProductResult[]> {
  const results: ProductResult[] = [];
  for (const url of await buildAbbSearchProductUrls(catalogNumber, context)) {
    try {
      const fetched = await fetchAbbPage(url, context);
      const result = parseAbbProductPage(catalogNumber, fetched, context.manufacturer.markerRules);
      if (result.status !== "failed") results.push(result);
    } catch {
      // Keep trying the other official product-id candidates.
    }
  }
  return results;
}

async function buildAbbSearchProductUrls(catalogNumber: string, context: ScrapeContext): Promise<string[]> {
  const searchUrl = `https://new.abb.com/api/PisSearchApi?query=${encodeURIComponent(catalogNumber)}&pageNumber=1&pageSize=8&lang=en`;
  let fetched: FetchedText;
  try {
    fetched = await context.http.fetchText(searchUrl, {
      timeoutMs: 15000,
      cacheTtlMs: 1000 * 60 * 60 * 24,
      signal: context.signal,
      headers: { accept: "application/json,text/plain,*/*", "user-agent": ABB_USER_AGENT }
    });
  } catch {
    return [];
  }

  const urls: string[] = [];
  for (const item of parseAbbSearchItems(fetched.text, catalogNumber)) {
    const slug = abbProductSlug(item.alias ?? catalogNumber);
    urls.push(
      `https://new.abb.com/products/pl/${encodeURIComponent(item.productId)}/${slug}`,
      `https://new.abb.com/products/de/${encodeURIComponent(item.productId)}/${slug}`,
      `https://new.abb.com/products/${encodeURIComponent(item.productId)}/${slug}`,
      `https://new.abb.com/products/${encodeURIComponent(item.productId)}`,
      `https://www.abb.com/global/en/products/${encodeURIComponent(item.productId.toLowerCase())}`
    );
  }
  return [...new Set(urls)].slice(0, 24);
}

function parseAbbSearchItems(text: string, catalogNumber: string): Array<{ productId: string; alias?: string; score: number }> {
  try {
    const parsed = JSON.parse(text) as { Items?: Array<Record<string, unknown>> };
    return (parsed.Items ?? [])
      .flatMap((item): Array<{ productId: string; alias: string; score: number }> => {
        const productId = firstStringOrNumber(item.ProductId, item.productId);
        if (!productId) return [];
        const alias =
          firstExactCatalogText(catalogNumber, item.GlobalCommercialAlias, item.ExtendedProductType, item.Title) ??
          firstTextMatchingCatalog(catalogNumber, item.GlobalCommercialAlias, item.ExtendedProductType, item.Title, item.CatalogDescription);
        const haystack = cleanText(
          [item.ProductId, item.GlobalCommercialAlias, item.ExtendedProductType, item.Title, item.CatalogDescription, item.LongDescription]
            .map((value) => firstStringOrNumber(value))
            .filter(Boolean)
            .join(" ")
        );
        if (!catalogTextMatches(haystack, catalogNumber) && !sameCatalogNumber(productId, catalogNumber)) return [];
        return [{
          productId,
          alias: alias && sameCatalogNumber(alias, catalogNumber) ? alias : catalogNumber,
          score: abbSearchItemScore(catalogNumber, productId, haystack)
        }];
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
  } catch {
    return [];
  }
}

function firstTextMatchingCatalog(catalogNumber: string, ...values: unknown[]): string | undefined {
  return values
    .map((value) => firstStringOrNumber(value))
    .find((value): value is string => Boolean(value && catalogTextMatches(value, catalogNumber)));
}

function firstExactCatalogText(catalogNumber: string, ...values: unknown[]): string | undefined {
  return values
    .map((value) => firstStringOrNumber(value))
    .find((value): value is string => Boolean(value && sameCatalogNumber(value, catalogNumber)));
}

function abbSearchItemScore(catalogNumber: string, productId: string, haystack: string): number {
  let score = 0;
  if (sameCatalogNumber(productId, catalogNumber)) score += 100;
  if (catalogTextMatches(haystack, catalogNumber)) score += 80;
  if (new RegExp(`\\(${escapeRegExp(catalogNumber)}\\)`, "i").test(haystack)) score += 20;
  if (/\b(?:spare|replacement|kit|package)\b/i.test(haystack)) score -= 20;
  if (productId.toUpperCase().endsWith("P01")) score -= 15;
  return score;
}

function abbProductSlug(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "product";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseAbbProductPage(catalogNumber: string, fetched: FetchedText, markerRules?: MarkerExtractionRule[]): ProductResult {
  const $ = cheerio.load(fetched.text);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const products = readJsonLdProducts($);
  const product = products.find((item) => {
    const sku = String(item.sku ?? item.productID ?? "");
    return sameCatalogNumber(sku, catalogNumber);
  }) ?? products[0];

  if (product) {
    for (const [name, value] of Object.entries(product)) {
      if (value === undefined || value === null || typeof value === "object") continue;
      attributes.push({
        group: "Structured Data",
        name,
        value: cleanText(String(value)),
        sourceUrl: fetched.effectiveUrl
      });
    }
  }

  const embeddedAttributes = extractAbbEmbeddedAttributes(fetched.text, fetched.effectiveUrl);
  attributes.push(...embeddedAttributes);
  attributes.push(...extractAbbRelationshipAttributes(fetched.text, fetched.effectiveUrl));
  attributes.push(...extractAbbClassificationAttributes(fetched.text, fetched.effectiveUrl));
  documents.push(...extractAbbDocumentReferences(embeddedAttributes, fetched.effectiveUrl));
  const markerData = extractMarkerData(fetched.text, markerRules, fetched.effectiveUrl);
  attributes.push(...markerData.attributes);
  documents.push(...markerData.documents);
  documents.push(...extractAbbEmbeddedImages(fetched.text, fetched.effectiveUrl));

  $("meta").each((_, element) => {
    const name = $(element).attr("name") || $(element).attr("property");
    const value = $(element).attr("content");
    if (!name || !value) return;
    if (/description|brand|manufacturer|image|product|og:/i.test(name)) {
      attributes.push({
        group: "Meta",
        name,
        value: cleanText(value),
        sourceUrl: fetched.effectiveUrl
      });
    }
  });

  const imageUrl = firstImageUrl(product?.image) ?? $("meta[property='og:image']").attr("content") ?? $("meta[name='image']").attr("content");
  if (imageUrl) {
    documents.push({
      type: "image",
      label: "Product image",
      url: new URL(imageUrl, fetched.effectiveUrl).toString(),
      sourceUrl: fetched.effectiveUrl
    });
  }
  $("img[src],img[data-master]").each((_, element) => {
    const rawUrl = $(element).attr("data-master") || $(element).attr("src");
    if (!rawUrl || !/productimages\.abb\.com/i.test(rawUrl)) return;
    documents.push({
      type: "image",
      label: cleanText($(element).attr("alt") || "Product image"),
      url: new URL(rawUrl, fetched.effectiveUrl).toString(),
      sourceUrl: fetched.effectiveUrl
    });
  });

  $("tr").each((_, element) => {
    const cells = $(element)
      .find("th,td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);
    if (cells.length >= 2) {
      attributes.push({
        group: "Table",
        name: cells[0],
        value: cells.slice(1).join(" | "),
        sourceUrl: fetched.effectiveUrl
      });
    }
  });

  $("li,p").slice(0, 600).each((_, element) => {
    const pair = splitNameValue($(element).text());
    if (pair && pair.name.length <= 80 && pair.value.length <= 500) {
      attributes.push({ group: "Text", ...pair, sourceUrl: fetched.effectiveUrl });
    }
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const absolute = new URL(href, fetched.effectiveUrl).toString();
    if (!/\.(pdf|zip|dwg|dxf|stp|step)(\?|$)/i.test(absolute) && !/library.*download/i.test(absolute)) return;
    const label = cleanText($(element).text()) || absolute.split("/").pop() || "Document";
    documents.push({
      type: classifyDocument(label, absolute),
      label,
      url: absolute,
      sourceUrl: fetched.effectiveUrl
    });
  });

  const title = cleanText(String(product?.name ?? $("h1").first().text() ?? $("title").text()));
  const description = cleanText(
    String(product?.description ?? $("meta[name='description']").attr("content") ?? $("meta[property='og:description']").attr("content") ?? "")
  );
  const productUrl = cleanText(String(product?.url ?? $("link[rel='canonical']").attr("href") ?? fetched.effectiveUrl));
  const matched =
    catalogTextMatches(fetched.text, catalogNumber) ||
    sameCatalogNumber(String(product?.sku ?? product?.productID ?? ""), catalogNumber);

  if (!matched) {
    return {
      ...emptyResult("abb", catalogNumber, "ABB product page did not contain the catalog number."),
      sources: [
        {
          url: fetched.effectiveUrl,
          sourceType: "official",
          parser: "abb-product-page",
          parserVersion: "abb-v2",
          fetchedAt: fetched.fetchedAt,
          statusCode: fetched.statusCode
        }
      ]
    };
  }

  const cleanAttributes = dedupeAttributes(attributes);
  const cleanDocuments = coalesceAbbImageDocuments(dedupeDocuments(documents));
  const normalized = normalizeFields(cleanAttributes, cleanDocuments);
  const hasUsefulData = Boolean(product) || cleanAttributes.length > 0 || cleanDocuments.length > 0;

  return {
    manufacturerId: "abb",
    catalogNumber,
    status: hasUsefulData ? "found" : "partial",
    confidence: product ? 0.9 : 0.65,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("abb", catalogNumber, productUrl),
    title,
    description,
    normalized,
    attributes: cleanAttributes,
    documents: cleanDocuments,
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType: "official",
        parser: "abb-product-page",
        parserVersion: "abb-v2",
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      }
    ]
  };
}

function readJsonLdProducts($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | Record<string, unknown>[];
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (entry["@type"] === "Product") products.push(entry);
      }
    } catch {
      // Ignore malformed structured data.
    }
  });
  return products;
}

function firstImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
  return undefined;
}

function extractAbbEmbeddedAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const modelAttributes = extractAbbModelAttributes(html, sourceUrl);
  if (modelAttributes.length) return modelAttributes;
  return extractAbbRegexAttributes(html, sourceUrl);
}

function extractAbbRegexAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const pattern = /"attributeCode":"([^"]+)"[\s\S]{0,300}?"attributeName":"([^"]+)"[\s\S]{0,1600}?"values":\[(.*?)\]\s*,\s*"isInternal"/g;
  for (const match of html.matchAll(pattern)) {
    const code = cleanAbbJsonValue(match[1]);
    const name = canonicalAbbAttributeName(code, match[2]);
    const value = parseAbbAttributeValues(match[3]);
    if (!name || !value) continue;
    attributes.push({
      group: "ABB Product Data",
      name,
      value,
      sourceUrl,
      sourceType: "official",
      parser: "abb-embedded-json",
      confidence: 0.94
    });
  }
  return attributes;
}

function extractAbbModelAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (const product of extractAbbProductPayloads(html)) {
    const productDetails = recordAt(product, "productDetails");
    const item = recordAt(productDetails, "item");
    pushUniqueAbbAttributes(attributes, attributesFromAbbMap(recordAt(item, "attributes"), "ABB Product Data", sourceUrl), seen);
    for (const groupContainer of [recordAt(item, "attributeGroups"), recordAt(productDetails, "attributeGroups"), recordAt(product, "attributeGroups")]) {
      for (const group of arrayAt(groupContainer, "items")) {
        if (!isRecord(group)) continue;
        const groupName = abbModelGroupName(group);
        pushUniqueAbbAttributes(attributes, attributesFromAbbMap(recordAt(group, "attributes"), groupName, sourceUrl), seen);
      }
    }
  }
  return attributes;
}

function extractAbbRelationshipAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (const product of extractAbbProductPayloads(html)) {
    for (const relationship of arrayAt(recordAt(product, "productRelationships"), "items")) {
      if (!isRecord(relationship)) continue;
      const relationshipLabel = cleanText(firstStringOrNumber(relationship.description, relationship.type, relationship.code) ?? "Related Products");
      const relationshipName = abbRelationshipAttributeName(relationshipLabel);
      for (const row of arrayAt(recordAt(relationship, "table"), "rows")) {
        const values = recordAt(row, "values");
        if (!values) continue;
        const cells = abbRelationshipCells(values);
        const identifier = cells.get("identifier") ?? cells.get("product id") ?? cells.get("productid") ?? cells.get("part number");
        const description = cells.get("description");
        const type = cells.get("type");
        const quantity = cells.get("quantity");
        const unit = cells.get("unit of measure") ?? cells.get("unitofmeasure");
        const details = [
          identifier,
          description ? `- ${description}` : undefined,
          type && type !== identifier ? `(Type: ${type})` : undefined,
          quantity ? `(Qty: ${[quantity, unit].filter(Boolean).join(" ")})` : undefined
        ].filter(Boolean).join(" ");
        const value = cleanText(details || [...cells.entries()].map(([key, cell]) => `${key}: ${cell}`).join("; "));
        if (!value) continue;
        const attr = {
          group: `ABB ${relationshipLabel}`,
          name: relationshipName,
          value,
          sourceUrl,
          sourceType: "official" as const,
          parser: "abb-product-model-relationships",
          confidence: 0.9
        };
        const key = `${attr.group}|${attr.name}|${attr.value}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        attributes.push(attr);
      }
    }
  }
  return attributes;
}

function extractAbbClassificationAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (const product of extractAbbProductPayloads(html)) {
    const items = recordAt(recordAt(product, "productClassifications"), "items");
    if (!items) continue;
    for (const [classification, rawPaths] of Object.entries(items)) {
      for (const path of arrayAt(rawPaths)) {
        const pathItems = arrayAt(path);
        const value = pathItems
          .map((item) => (isRecord(item) ? firstStringOrNumber(item.name, item.cid) : undefined))
          .filter((item): item is string => Boolean(item))
          .map(cleanText)
          .filter((item) => item && !/^root$/i.test(item))
          .join(" > ");
        if (!value) continue;
        const attr = {
          group: "ABB Product Classification",
          name: `${humanizeAbbAttributeCode(classification)} Path`,
          value,
          sourceUrl,
          sourceType: "official" as const,
          parser: "abb-product-model-classification",
          confidence: 0.88
        };
        const key = `${attr.name}|${attr.value}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        attributes.push(attr);
      }
    }
  }
  return attributes;
}

function attributesFromAbbMap(attributeMap: Record<string, unknown> | undefined, group: string, sourceUrl: string): AttributeRecord[] {
  if (!attributeMap) return [];
  const attributes: AttributeRecord[] = [];
  for (const value of Object.values(attributeMap)) {
    if (!isRecord(value)) continue;
    const code = cleanAbbJsonValue(firstStringOrNumber(value.attributeCode) ?? "");
    const fallbackName = firstStringOrNumber(value.attributeName, code);
    const name = canonicalAbbAttributeName(code, fallbackName ?? code);
    const attrValue = parseAbbAttributeValueObjects(arrayAt(value.values));
    if (!name || !attrValue) continue;
    attributes.push({
      group,
      name,
      value: attrValue,
      sourceUrl,
      sourceType: "official",
      parser: "abb-product-model",
      confidence: 0.96
    });
  }
  return attributes;
}

function pushUniqueAbbAttributes(target: AttributeRecord[], incoming: AttributeRecord[], seen: Set<string>) {
  for (const attr of incoming) {
    const key = `${attr.name}|${attr.value}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(attr);
  }
}

function abbModelGroupName(group: Record<string, unknown>): string {
  const raw = cleanText(firstStringOrNumber(group.description, group.code) ?? "Product Data");
  return raw ? `ABB ${raw}` : "ABB Product Data";
}

function abbRelationshipAttributeName(label: string): string {
  if (/accessor/i.test(label)) return "Accessory";
  if (/where\s*used|used\s*with/i.test(label)) return "Used With";
  if (/variant/i.test(label)) return "Variant Product";
  if (/spare/i.test(label)) return "Spare Part";
  return "Related Product";
}

function abbRelationshipCells(values: Record<string, unknown>): Map<string, string> {
  const cells = new Map<string, string>();
  for (const [key, cell] of Object.entries(values)) {
    const text = uniqueStrings(flattenAbbCellText(cell)).join("; ");
    if (text) cells.set(humanizeAbbAttributeCode(key).toLowerCase(), text);
  }
  return cells;
}

function flattenAbbCellText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenAbbCellText);
  if (isRecord(value)) {
    const ownText = firstStringOrNumber(value.text, value.value, value.displayValue, value.name);
    const link = recordAt(value, "link");
    const linkText = link ? firstStringOrNumber(link.text, link.productId, link.documentId, link.url) : undefined;
    return [ownText, linkText].map((item) => cleanText(item)).filter(Boolean);
  }
  const text = firstStringOrNumber(value);
  return text ? [cleanText(text)] : [];
}

function extractAbbProductPayloads(html: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = [];
  let offset = 0;
  const marker = "var model =";
  while (offset < html.length) {
    const markerIndex = html.indexOf(marker, offset);
    if (markerIndex < 0) break;
    const objectStart = html.indexOf("{", markerIndex);
    if (objectStart < 0) break;
    const objectText = extractBalancedJsonObject(html, objectStart);
    offset = objectStart + Math.max(1, objectText?.length ?? 1);
    if (!objectText) continue;
    try {
      const parsed = JSON.parse(objectText) as Record<string, unknown>;
      const product = recordAt(parsed, "ProductViewModel", "Product") ?? recordAt(parsed, "Product");
      if (product) payloads.push(product);
    } catch {
      // Ignore non-JSON scripts.
    }
  }
  return payloads;
}

function extractBalancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function recordAt(value: unknown, ...path: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractAbbDocumentReferences(attributes: AttributeRecord[], sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const attr of attributes) {
    const type = abbDocumentType(attr.name, attr.value);
    if (!type) continue;
    for (const documentId of extractAbbDocumentIds(attr.value)) {
      documents.push({
        type,
        label: `${attr.name}: ${documentId}`,
        url: abbLibraryDownloadUrl(documentId),
        sourceUrl,
        sourceType: "official",
        parser: "abb-embedded-json-document-ref",
        confidence: 0.9
      });
    }
  }
  return documents;
}

function extractAbbEmbeddedImages(html: string, sourceUrl: string): DocumentRecord[] {
  const modelImages = extractAbbModelImages(html, sourceUrl);
  if (modelImages.length) return modelImages;

  const imageUrlsByPath = new Map<string, string>();
  for (const match of html.matchAll(/https?:\\?\/\\?\/cdn\.productimages\.abb\.com\\?\/[^"')<\s]+/gi)) {
    const url = cleanAbbJsonValue(match[0]).replace(/\\\//g, "/");
    const key = abbImageUrlKey(url);
    const existing = imageUrlsByPath.get(key);
    if (!existing || abbImageUrlRank(url) < abbImageUrlRank(existing)) imageUrlsByPath.set(key, url);
  }
  const urls = [...imageUrlsByPath.values()].sort((left, right) => abbImageUrlRank(left) - abbImageUrlRank(right)).slice(0, 1);
  return urls.map((url) => ({
    type: "image" as const,
    label: imageLabelFromUrl(url),
    url: new URL(url, sourceUrl).toString(),
    sourceUrl,
    sourceType: "official" as const,
    parser: "abb-embedded-image",
    confidence: 0.86
  }));
}

function extractAbbModelImages(html: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const product of extractAbbProductPayloads(html)) {
    for (const image of arrayAt(recordAt(product, "productDetails", "item"), "images")) {
      if (!isRecord(image)) continue;
      const candidates = uniqueStrings(
        [firstStringOrNumber(image.url), firstStringOrNumber(image.masterUrl), firstStringOrNumber(image.thumbnailUrl)]
          .map((url) => url?.replace(/\\\//g, "/"))
          .filter((url): url is string => Boolean(url))
      ).sort((left, right) => abbImageUrlRank(left) - abbImageUrlRank(right));
      const primary = candidates[0];
      if (!primary) continue;
      documents.push({
        type: "image",
        label: imageLabelFromUrl(primary),
        url: new URL(primary, sourceUrl).toString(),
        candidateUrls: candidates.slice(1).map((url) => new URL(url, sourceUrl).toString()),
        sourceUrl,
        sourceType: "official",
        parser: "abb-product-model-image",
        confidence: 0.9
      });
    }
  }
  return documents;
}

function abbImageUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/_(?:\d+x\d+|master|thumbnail|thumb)(?=\.[a-z0-9]+$)/i, "").toLowerCase();
  } catch {
    return (url.split("?")[0] ?? url).replace(/_(?:\d+x\d+|master|thumbnail|thumb)(?=\.[a-z0-9]+$)/i, "").toLowerCase();
  }
}

function abbImageUrlRank(url: string): number {
  const lower = url.toLowerCase();
  if (/_400x400\b|400\s*x\s*400/.test(lower)) return 0;
  if (/_master\b|master\./.test(lower)) return 1;
  if (/_100x100\b|thumbnail|thumb/.test(lower)) return 3;
  return 2;
}

function imageLabelFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (/_400x400\b|400\s*x\s*400/.test(lower)) return "Product image 400x400";
  if (/_master\b|master\./.test(lower)) return "Product image master";
  if (/_100x100\b|thumbnail|thumb/.test(lower)) return "Product image thumbnail";
  return "Product image";
}

function coalesceAbbImageDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const images = documents.filter((doc) => doc.type === "image");
  if (images.length <= 1) return documents;

  const rankedImages = [...images].sort((left, right) => abbImageUrlRank(left.url) - abbImageUrlRank(right.url));
  const primary = rankedImages[0];
  const candidateUrls = [
    ...new Set(
      rankedImages
        .slice(1)
        .flatMap((doc) => [doc.url, ...(doc.candidateUrls ?? [])])
        .filter((url): url is string => Boolean(url && url !== primary.url))
    )
  ];

  return [
    {
      ...primary,
      candidateUrls: candidateUrls.length ? candidateUrls : primary.candidateUrls
    },
    ...documents.filter((doc) => doc.type !== "image")
  ];
}

function abbDocumentType(name: string, value: string): DocumentRecord["type"] | undefined {
  const text = `${name} ${value}`;
  if (!extractAbbDocumentIds(value).length) return undefined;
  if (/\b(data\s*sheet|technical information|catalogue?|brochure)\b/i.test(text)) return "datasheet";
  if (/\b(instructions?|manuals?|user manual|installation)\b/i.test(text)) return "manual";
  if (/\b(cad|drawing|diagram|dimension|2d|3d|step|dxf)\b/i.test(text)) return "cad";
  if (/\b(declaration|certificate|certification|rohs|reach|atex|csa|vde|epd|environmental|cmrt|tsca|weee)\b/i.test(text)) return "certificate";
  if (/\bdocument\b/i.test(text)) return "other";
  return undefined;
}

function extractAbbDocumentIds(value: string): string[] {
  if (/\b(no certification needed|not available|not needed|not applicable)\b/i.test(value)) return [];
  return [
    ...new Set(
      (value.match(/\b[0-9][A-Z0-9]{7,}(?:[-_][A-Z0-9]+)?\b/g) ?? [])
        .filter((id) => !/^\d+$/.test(id))
        .filter((id) => !/^805\d{10}$/.test(id))
    )
  ];
}

function abbLibraryDownloadUrl(documentId: string): string {
  const params = new URLSearchParams({
    DocumentID: documentId,
    LanguageCode: "en",
    DocumentPartId: "",
    Action: "Launch"
  });
  return `https://search.abb.com/library/Download.aspx?${params.toString()}`;
}

function parseAbbAttributeValues(rawValues: string): string | undefined {
  const values: string[] = [];
  try {
    const parsed = JSON.parse(`[${rawValues}]`) as Array<Record<string, unknown>>;
    return parseAbbAttributeValueObjects(parsed);
  } catch {
    for (const match of rawValues.matchAll(/"(?:text|value)":"((?:\\.|[^"\\])*)"/g)) {
      values.push(cleanAbbJsonValue(match[1]));
    }
  }
  const unique = [...new Set(values.map(cleanText).filter(Boolean))];
  return unique.length ? unique.join("; ") : undefined;
}

function parseAbbAttributeValueObjects(items: unknown[]): string | undefined {
  const values: string[] = [];
  for (const item of items) {
    if (isRecord(item)) {
      const text = abbValueText(item);
      if (text) values.push(cleanAbbJsonValue(text));
    } else {
      const text = firstStringOrNumber(item);
      if (text) values.push(cleanAbbJsonValue(text));
    }
  }
  const unique = uniqueStrings(values.map(cleanText).filter(Boolean));
  return unique.length ? unique.join("; ") : undefined;
}

function abbValueText(item: Record<string, unknown>): string | undefined {
  const rawText = firstStringOrNumber(item.text, item.value, item.displayValue, item.name);
  const unit = firstStringOrNumber(item.unit, item.unitOfMeasure, item.uom, item.symbol);
  if (!rawText) return undefined;
  if (unit && /^\d+(?:[.,]\d+)?$/.test(rawText) && !rawText.toLowerCase().includes(unit.toLowerCase())) {
    return `${rawText} ${unit}`;
  }
  return rawText;
}

function firstStringOrNumber(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function canonicalAbbAttributeName(code: string, fallbackName: string): string {
  const baseCode = baseAbbAttributeCode(code);
  const known: Record<string, string> = {
    "#DisplayName": "Display Name",
    "ABB.Type": "ABB Type Designation",
    AmpereRating: "Ampere Rating",
    A2LCertificateUL: "A2L Certificate UL",
    CatalogDescription: "Catalog Description",
    CadDimensionalDrawing: "CAD Dimensional Drawing",
    ClosureType: "Closure Type",
    Color: "Color",
    ConMinRepTem: "Conflict Minerals Reporting Template (CMRT)",
    ConCapMaiCon: "Connecting Capacity Main Circuit",
    ConCapUlCsa: "Connecting Capacity UL/CSA",
    ConFreAirTheCur: "Conventional Free-air Thermal Current",
    ConTheCur: "Conventional Thermal Current",
    ConfigurationType: "Configuration Type",
    CoverPlateType: "Cover Plate Type",
    CoverStyle: "Cover Style",
    CountryOfOrigin: "Country of Origin",
    CustomsTariffNumber: "Customs Tariff Number",
    DataSheetTechnicalInformation: "Data Sheet, Technical Information",
    DatSheTecInf: "Data Sheet, Technical Information",
    DegreeOfProtection: "Degree of Protection",
    DieTesVol: "Dielectric Test Voltage",
    DinPlaceUnits: "DIN Place Units",
    DisplayName: "Display Name",
    DoorMaterial: "Door Material",
    DoorType: "Door Type",
    DooSurFin: "Door Surface Finishing",
    Ean: "EAN",
    Eclass: "eClass",
    EnergyLimitingClass: "Energy Limiting Class",
    EnclosureMaterial: "Enclosure Material",
    EnvProDecEpd: "Environmental Product Declaration - EPD",
    ExtendedProductType: "Extended Product Type",
    Frequency: "Frequency",
    Function: "Function",
    GloComAli: "Global Commercial Alias",
    HandleType: "Handle Type",
    HousingMaterial: "Housing Material",
    HorsePowerRating: "Horsepower Rating UL/CSA",
    ImpResRat: "Impact Resistance Rating",
    InsMan: "Instructions and Manuals",
    InputVoltage: "Input Voltage",
    InputVoltageType: "Input Voltage Type",
    LongDescription: "Long Description",
    MaxOpeVolUlCsa: "Maximum Operating Voltage UL/CSA",
    MountingType: "Mounting Type",
    NeutralType: "Neutral Type",
    NumberOfPoles: "Number of Poles",
    NumberOfModules: "Number of Modules",
    NumberOfRows: "Number of Rows",
    NumOfLinTer: "Number of Line Terminals",
    NumProPol: "Number of Protected Poles",
    ObjClaCod: "Object Classification Code",
    OperationalVoltage: "Rated Operational Voltage",
    OvervoltageCategory: "Overvoltage Category",
    OutputCurrent: "Output Current",
    OutputPower: "Output Power",
    OutputVoltage: "Output Voltage",
    PackageLevel1Ean: "Package Level 1 EAN",
    PacLev1GroWei: "Package Level 1 Gross Weight",
    PoleNetWeight: "Pole Net Weight",
    PowerLoss: "Power Loss",
    ProductMainType: "Product Main Type",
    ProductId: "Product ID",
    ProAvaCla: "Product Availability Class",
    ProductNetDepth: "Product Net Depth / Length",
    ProductNetHeight: "Product Net Height",
    ProductNetWeight: "Product Net Weight",
    ProductNetWidth: "Product Net Width",
    ProductName: "Product Name",
    ProductSalesStatus: "Product Sales Status",
    ProductType: "Product Type",
    RatConShoCirCur: "Rated Conditional Short-Circuit Current",
    RatConCirVol: "Rated Control Circuit Voltage",
    RatedCurrent: "Rated Current",
    RatedInputVoltage: "Rated Input Voltage",
    RatImpWitVol: "Rated Impulse Withstand Voltage",
    RatInsVol: "Rated Insulation Voltage",
    RatOpeCurAc1: "Rated Operational Current AC-1",
    RatOpeCurAc3: "Rated Operational Current AC-3",
    RatOpeCurAc3e: "Rated Operational Current AC-3e",
    RatOpeCurAc15: "Rated Operational Current AC-15",
    RatOpeCurAc21: "Rated Operational Current AC-21A",
    RatOpeCurAc21a: "Rated Operational Current AC-21A",
    RatOpeCurAc22: "Rated Operational Current AC-22A",
    RatOpeCurAc22a: "Rated Operational Current AC-22A",
    RatOpeCurAc23: "Rated Operational Current AC-23A",
    RatOpeCurAc23a: "Rated Operational Current AC-23A",
    RatOpeCurDc1: "Rated Operational Current DC-1",
    RatOpeCurDc3: "Rated Operational Current DC-3",
    RatOpeCurDc5: "Rated Operational Current DC-5",
    RatOpeCurDc13: "Rated Operational Current DC-13",
    RatOpePowAc23: "Rated Operational Power AC-23A",
    RatOpePowAc23a: "Rated Operational Power AC-23A",
    RatOpeVol: "Rated Operational Voltage",
    RatSerShoCirBreCap: "Rated Service Short-Circuit Breaking Capacity",
    RatShoCirCap: "Rated Short-Circuit Capacity",
    RatShoCirMakCap: "Rated Short-circuit Making Capacity",
    RatShoTimWitCur: "Rated Short-time Withstand Current",
    RatUltShoCirBreCap: "Rated Ultimate Short-Circuit Breaking Capacity",
    RatedFrequency: "Rated Frequency",
    RatedOutputCurrent: "Rated Output Current",
    RatedOutputPower: "Rated Output Power",
    RatedOutputVoltage: "Rated Output Voltage",
    RatedOuputVoltage: "Rated Output Voltage",
    RalNum: "RAL Number",
    ReachDeclaration: "REACH Declaration",
    ReachDate: "REACH Date",
    ReachInformation: "REACH Information",
    RoHSDate: "RoHS Date",
    RoHSInformation: "RoHS Declaration",
    RoHSStatus: "RoHS Information",
    SellingUnitOfMeasure: "Selling Unit of Measure",
    ScrewTerminalType: "Screw Terminal Type",
    ShortCircuitCapacity: "Short Circuit Capacity",
    StandardizationBody: "Standardization Body",
    Standards: "Standards",
    SuitableForClass: "Suitable for Product Class",
    TerminalType: "Terminal Type",
    TransparentDoor: "Transparent Door",
    TriCha: "Tripping Characteristic",
    WeeeCategory: "WEEE Category",
    WirStrLen: "Wire Stripping Length"
  };
  if (known[code]) return known[code];
  if (known[baseCode]) return known[baseCode];
  const officialName = cleanAbbJsonValue(fallbackName);
  if (isUsefulAbbEnglishAttributeName(officialName)) return officialName;
  const humanized = humanizeAbbAttributeCode(baseCode);
  return humanized || officialName;
}

function baseAbbAttributeCode(code: string): string {
  return code.replace(/_[A-Z0-9]+$/, "");
}

function humanizeAbbAttributeCode(code: string): string {
  return cleanText(
    code
      .replace(/[.#_]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/\bId\b/g, "ID")
      .replace(/\bEan\b/g, "EAN")
      .replace(/\bAc\b/g, "AC")
      .replace(/\bDc\b/g, "DC")
      .replace(/\bUl\b/g, "UL")
      .replace(/\bCsa\b/g, "CSA")
      .replace(/\bIp\b/g, "IP")
  );
}

function isUsefulAbbEnglishAttributeName(value: string): boolean {
  if (!value || value.length > 90) return false;
  return /\b(?:abb|alias|approval|cad|catalog|certificate|circuit|class|code|color|colour|commercial|configuration|connection|contact|country|current|data|declaration|depth|description|designation|dimension|display|door|drawing|ean|electrical|enclosure|environmental|finish(?:ing)?|frequency|gross|height|housing|iec|information|instructions?|manuals?|material|module|mounting|name|net|number|operat(?:e|ing|ional)|order|package|pole|power|product|protection|quantity|rated|reach|rohs|sales|sheet|standard|status|surface|tariff|terminal|technical|type|ul|unit|voltage|weight|width|weee)\b/i.test(value);
}

function cleanAbbJsonValue(value: string): string {
  return cleanText(
    value
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/<br\s*\/?>/gi, "; ")
      .replace(/<\/?[^>]+>/g, " ")
  );
}
