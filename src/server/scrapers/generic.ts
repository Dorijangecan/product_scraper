import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, FallbackSourceConfig, ProductResult, SourceRecord } from "../../shared/types.js";
import type { CachedHttpClient, FetchedText } from "./http-client.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";

export class GenericFallbackScraper {
  constructor(
    private readonly manufacturerId: ProductResult["manufacturerId"],
    private readonly http: CachedHttpClient
  ) {}

  async scrape(catalogNumber: string, sources: FallbackSourceConfig[], signal?: AbortSignal): Promise<ProductResult | undefined> {
    for (const source of sources.filter((item) => item.enabled)) {
      for (const template of source.directUrlTemplates) {
        const url = fillTemplate(template, catalogNumber);
        try {
          const fetched = await this.fetchTextWithFallback(url, signal);
          if (!fetched.text.toLowerCase().includes(catalogNumber.toLowerCase())) continue;
          const parsed = parseGenericProductPage(this.manufacturerId, catalogNumber, fetched, source.sourceType, source.label);
          const detailUrl = findLinkedProductDetailUrl(fetched.text, fetched.effectiveUrl, catalogNumber);
          if (detailUrl) {
            try {
              const detail = await this.fetchTextWithFallback(detailUrl, signal);
              if (detail.text.toLowerCase().includes(catalogNumber.toLowerCase())) {
                const detailParsed = parseGenericProductPage(this.manufacturerId, catalogNumber, detail, source.sourceType, source.label);
                if (detailParsed.status !== "failed") return mergeResults(detailParsed, parsed);
              }
            } catch {
              // Keep the original parsed page when detail navigation fails.
            }
          }
          if (parsed.status !== "failed") return parsed;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }

  private async fetchTextWithFallback(url: string, signal?: AbortSignal): Promise<FetchedText> {
    try {
      return await this.http.fetchText(url, { timeoutMs: 15000, signal });
    } catch {
      return this.http.fetchTextViaPowerShell(url, { timeoutMs: 30000, signal });
    }
  }
}

export function parseGenericProductPage(
  manufacturerId: ProductResult["manufacturerId"],
  catalogNumber: string,
  fetched: FetchedText,
  sourceType: SourceRecord["sourceType"],
  parserLabel = "generic"
): ProductResult {
  const $ = cheerio.load(fetched.text);
  const title = cleanText($("h1").first().text() || $("title").first().text()).replace(/\s+\|.+$/, "");
  const description = cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content"));
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const titleDimensions = dimensionsFromText(title);
  if (titleDimensions) {
    attributes.push({
      group: "Derived",
      name: "Dimensions",
      value: titleDimensions,
      sourceUrl: fetched.effectiveUrl
    });
  }

  const jsonLdProducts = readJsonLdProducts($);
  for (const product of jsonLdProducts) {
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
  documents.push(...extractImageDocuments($, catalogNumber, fetched.effectiveUrl, jsonLdProducts));

  for (const product of readEmbeddedProductData($)) {
    for (const [name, value] of Object.entries(product)) {
      if (value === undefined || value === null || typeof value === "object") continue;
      attributes.push({
        group: "Embedded Product Data",
        name,
        value: cleanText(String(value)),
        sourceUrl: fetched.effectiveUrl
      });
    }
  }

  $("[data-row-data]").each((_, element) => {
    for (const attr of parseDataRowAttributes($(element).attr("data-row-data"), fetched.effectiveUrl)) {
      attributes.push(attr);
    }
  });

  $("meta").each((_, element) => {
    const name = $(element).attr("name") || $(element).attr("property");
    const value = $(element).attr("content");
    if (!name || !value) return;
    if (/image:(?:alt|width|height|secure_url|type)$/i.test(name)) return;
    if (/description|brand|manufacturer|image|product|og:/i.test(name)) {
      attributes.push({
        group: "Meta",
        name,
        value: cleanText(value),
        sourceUrl: fetched.effectiveUrl
      });
    }
  });
  attributes.push(...extractCertificationAttributes($, fetched.effectiveUrl));

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

  $("dt").each((_, element) => {
    const name = cleanText($(element).text());
    const value = cleanText($(element).next("dd").text());
    if (name && value) {
      attributes.push({ group: "Definition List", name, value, sourceUrl: fetched.effectiveUrl });
    }
  });

  $("li,p").slice(0, 600).each((_, element) => {
    const pair = splitNameValue($(element).text());
    if (pair) {
      attributes.push({ group: "Text", ...pair, sourceUrl: fetched.effectiveUrl });
      return;
    }
    const text = cleanText($(element).text());
    const certContext = cleanText(
      [
        $(element).attr("class"),
        $(element).attr("id"),
        $(element).parent().attr("class"),
        $(element).parent().attr("id"),
        $(element).parents("[class*='cert'],[id*='cert']").first().attr("class"),
        $(element).parents("[class*='cert'],[id*='cert']").first().attr("id")
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (text && text.length <= 120 && /cert/i.test(certContext)) {
      attributes.push({ group: "Certifications", name: "Certification", value: text, sourceUrl: fetched.effectiveUrl });
    }
  });

  attributes.push(...extractPlainTextAttributes(fetched.text, fetched.effectiveUrl));

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const absolute = new URL(href, fetched.effectiveUrl).toString();
    if (!isDownloadableProductDocumentUrl(absolute)) return;
    const label = cleanText($(element).text()) || absolute.split("/").pop() || "Document";
    const type = classifyDocument(label, absolute);
    const rowContext = cleanText($(element).closest("tr,li,.resource,.document,.download,.ra-product-new__documentation-table").text());
    if (
      type === "other" &&
      !absolute.toLowerCase().includes(catalogNumber.toLowerCase()) &&
      !rowContext.toLowerCase().includes(catalogNumber.toLowerCase())
    ) {
      return;
    }
    documents.push({
      type,
      label,
      url: absolute,
      sourceUrl: fetched.effectiveUrl
    });
  });

  const matched = fetched.text.toLowerCase().includes(catalogNumber.toLowerCase());
  if (!matched) {
    return emptyResult(manufacturerId, catalogNumber, "Fallback page did not contain the catalog number.");
  }

  const normalized = normalizeFields(attributes, documents);
  return {
    manufacturerId,
    catalogNumber,
    status: attributes.length || documents.length ? "partial" : "failed",
    confidence: attributes.length || documents.length ? 0.55 : 0,
    productUrl: fetched.effectiveUrl,
    localizedUrls: buildLocalizedProductUrls(manufacturerId, catalogNumber, fetched.effectiveUrl),
    title,
    description,
    normalized,
    attributes: dedupeAttributes(attributes),
    documents: dedupeDocuments(documents),
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType,
        parser: parserLabel,
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      }
    ],
    error: attributes.length || documents.length ? undefined : "No structured fallback data found."
  };
}

function fillTemplate(template: string, catalogNumber: string): string {
  const compact = catalogNumber.replace(/[^a-z0-9]/gi, "");
  const afterColon = catalogNumber.includes(":") ? catalogNumber.split(":").pop() ?? catalogNumber : catalogNumber;
  const snake = catalogNumber
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const dash = catalogNumber
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return template
    .replaceAll("{part}", encodeURIComponent(catalogNumber))
    .replaceAll("{partUpper}", encodeURIComponent(catalogNumber.toUpperCase()))
    .replaceAll("{partLower}", encodeURIComponent(catalogNumber.toLowerCase()))
    .replaceAll("{partCompact}", encodeURIComponent(compact))
    .replaceAll("{partAfterColon}", encodeURIComponent(afterColon))
    .replaceAll("{partAfterColonLower}", encodeURIComponent(afterColon.toLowerCase()))
    .replaceAll("{partAfterColonCompact}", encodeURIComponent(afterColon.replace(/[^a-z0-9]/gi, "")))
    .replaceAll("{partSnake}", encodeURIComponent(snake))
    .replaceAll("{partDash}", encodeURIComponent(dash));
}

function extractImageDocuments(
  $: cheerio.CheerioAPI,
  catalogNumber: string,
  sourceUrl: string,
  jsonLdProducts: Record<string, unknown>[]
): DocumentRecord[] {
  const structuredDocuments: DocumentRecord[] = [];
  const metaDocuments: DocumentRecord[] = [];
  const domDocuments: DocumentRecord[] = [];
  for (const product of jsonLdProducts) {
    for (const imageUrl of imageUrlsFromStructuredValue(product.image)) {
      const absolute = toAbsoluteUrl(imageUrl, sourceUrl);
      if (absolute) {
        structuredDocuments.push({ type: "image", label: "Product image", url: absolute, sourceUrl });
      }
    }
  }

  $("meta").each((_, element) => {
    const name = $(element).attr("name") || $(element).attr("property");
    const content = $(element).attr("content");
    if (!name || !content || !/image/i.test(name)) return;
    if (/image:(?:alt|width|height|type)$/i.test(name)) return;
    const absolute = toAbsoluteUrl(content, sourceUrl);
    if (absolute && isLikelyImageUrl(absolute)) {
      metaDocuments.push({ type: "image", label: cleanText(name) || "Product image", url: absolute, sourceUrl });
    }
  });

  const partKey = compactKey(catalogNumber);
  $("img[src],img[data-src],img[data-lazy-src],img[srcset]").each((_, element) => {
    const rawUrl =
      $(element).attr("src") ||
      $(element).attr("data-src") ||
      $(element).attr("data-lazy-src") ||
      firstSrcsetUrl($(element).attr("srcset"));
    const absolute = rawUrl ? toAbsoluteUrl(rawUrl, sourceUrl) : undefined;
    if (!absolute) return;
    if (!isLikelyImageUrl(absolute)) return;
    const context = [
      $(element).attr("alt"),
      $(element).attr("title"),
      $(element).attr("class"),
      $(element).attr("id"),
      $(element).parent().attr("class"),
      $(element).parent().attr("id")
    ]
      .filter(Boolean)
      .join(" ");
    if (!looksLikeProductImage(absolute, context, partKey)) return;
    const label = cleanText($(element).attr("alt") || $(element).attr("title") || "Product image");
    domDocuments.push({ type: "image", label, url: absolute, sourceUrl });
  });

  const documents = dedupeDocuments([...structuredDocuments, ...metaDocuments, ...domDocuments]);
  const filtered = domDocuments.length
    ? documents.filter(
        (doc) =>
          !metaDocuments.some((metaDoc) => metaDoc.url === doc.url) ||
          !domDocuments.some((domDoc) => imageIdentity(domDoc.url) === imageIdentity(doc.url))
      )
    : documents;
  return filtered.slice(0, 10);
}

function imageUrlsFromStructuredValue(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => imageUrlsFromStructuredValue(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.url, record.contentUrl, record.thumbnailUrl].flatMap((item) => imageUrlsFromStructuredValue(item));
  }
  return [];
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcset
    ?.split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .find(Boolean);
}

function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /^data:/i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function looksLikeProductImage(url: string, context: string, compactPart: string): boolean {
  const combined = `${url} ${context}`.toLowerCase();
  if (/(logo|favicon|sprite|spinner|loader|social|flag|avatar|placeholder|spacer|transparent|bit\.gif|mobile[_-]?menu|illustration[_-]?footer|footer|faq|icon)/i.test(combined)) return false;
  const compactCombined = compactKey(combined);
  if (compactPart && compactCombined.includes(compactPart)) return true;
  return /\b(product|sku|catalog|gallery|zoom|primary|pim|media|asset|large|detail|photo|image)\b/i.test(combined);
}

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isLikelyImageUrl(url: string): boolean {
  if (/\/(?:bit|spacer|transparent)\.gif(?:[?#]|$)/i.test(url)) return false;
  if (/(favicon|mobile[_-]?menu|illustration[_-]?footer|footer|logo|sprite|spinner|loader|social|placeholder|faq|icon)/i.test(url)) return false;
  return /\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#]|$)/i.test(url) || /\/is\/image\/|\/mdmfiles\/|\/images?\//i.test(url);
}

function isDownloadableProductDocumentUrl(url: string): boolean {
  return (
    /\.(pdf|zip|dwg|dxf|stp|step)(\?|$)/i.test(url) ||
    /\/documents\/(?:td|in|sg)\//i.test(url) ||
    /\/cutsheet(?:[?#]|$)/i.test(url)
  );
}

function imageIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    return pathLikeBaseName(parsed.pathname)
      .replace(/\.(?:png|jpe?g|webp|gif|avif|svg)$/i, "")
      .replace(/[-_]\d{2,5}x\d{2,5}$/i, "")
      .toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function pathLikeBaseName(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
}

function dimensionsFromText(text: string): string | undefined {
  const match = text.match(/\b(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)(?:\s*(mm|cm|in|inch|"))?\b/i);
  if (!match) return undefined;
  const unit = match[4] ? (match[4] === `"` ? "in" : match[4]) : "";
  return [match[1], match[2], match[3]].map((part) => `${part}${unit}`).join(" x ");
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
      // Ignore malformed script blocks.
    }
  });
  return products;
}

function readEmbeddedProductData($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  $("script").each((_, element) => {
    const raw = $(element).text();
    const match = raw.match(/window\.products\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return;
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (Array.isArray(parsed)) {
        products.push(...parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))));
      }
    } catch {
      // Ignore non-JSON script assignments.
    }
  });
  return products;
}

function parseDataRowAttributes(raw: string | undefined, sourceUrl: string): AttributeRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const attributes: AttributeRecord[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const name = cleanText(String(record.label ?? record.name ?? ""));
      const value = cleanText(String(record.value ?? ""));
      if (!name || !value) continue;
      attributes.push({ group: "Embedded Spec Rows", name, value, sourceUrl });
    }
    return attributes;
  } catch {
    return [];
  }
}

function extractCertificationAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const values = new Set<string>();
  $("img[src],img[data-src],img[alt],a[href]").each((_, element) => {
    const context = cleanText(
      [
        $(element).attr("alt"),
        $(element).attr("title"),
        $(element).attr("src"),
        $(element).attr("data-src"),
        $(element).attr("href"),
        $(element).text(),
        $(element).parent().attr("class"),
        $(element).parent().attr("id")
      ]
        .filter(Boolean)
        .join(" ")
    );
    for (const token of certificateTokensFromText(context)) values.add(token);
  });
  return [...values].map((value) => ({
    group: "Certifications",
    name: "Certification",
    value,
    sourceUrl
  }));
}

function extractPlainTextAttributes(text: string, sourceUrl: string): AttributeRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean)
    .filter((line) => !/^(login|add to cart|show more|trigger search|browse categories|skip to|home|support|cart)$/i.test(line));
  const attributes: AttributeRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const tableMatch = line.match(/^\|?\s*([^|]{2,90})\s+\|\s+([^|]{1,300})\s*\|?$/);
    if (tableMatch) {
      attributes.push({ group: "Plain Text", name: cleanText(tableMatch[1]), value: cleanText(tableMatch[2]), sourceUrl });
      continue;
    }
    const pair = splitNameValue(line);
    if (pair) {
      attributes.push({ group: "Plain Text", ...pair, sourceUrl });
      continue;
    }
    if (isPlainTextLabel(line)) {
      const value = nextPlainTextValue(lines, index + 1);
      if (value) attributes.push({ group: "Plain Text", name: line, value, sourceUrl });
    }
  }
  return dedupeAttributes(attributes).slice(0, 120);
}

function isPlainTextLabel(line: string): boolean {
  return /^(article number|product description|product family|product lifecycle|plm effective date|product class|packaging dimensions|package size|net weight|country of origin|commodity code|upc|ean|compliance|certificates?|approvals?|material|dimensions?|weight)$/i.test(
    line.replace(/\s*\(.+\)\s*$/g, "")
  );
}

function nextPlainTextValue(lines: string[], start: number): string | undefined {
  for (let index = start; index < Math.min(lines.length, start + 5); index += 1) {
    const value = lines[index];
    if (!value || /^#+\s/.test(value) || isPlainTextLabel(value)) continue;
    return value;
  }
  return undefined;
}

function certificateTokensFromText(value: string): string[] {
  return [
    ...(value.match(/\bREACH\b/gi) ?? []),
    ...(value.match(/\bRoHS\b/gi) ?? []),
    ...(value.match(/\bWEEE\b/gi) ?? []),
    ...(value.match(/\bCE\b/g) ?? []),
    ...(value.match(/\bcULus\b/g) ?? []),
    ...(value.match(/\bUL\b/g) ?? []),
    ...(value.match(/\bCSA\b/g) ?? []),
    ...(value.match(/\bUKCA\b/g) ?? []),
    ...(value.match(/\bPED\s+\d{4}\/\d+\/[A-Z]+/gi) ?? []),
    ...(value.match(/\bNEMA(?:\s+Type)?\s+[A-Z0-9, ]+/gi) ?? []),
    ...(value.match(/\bIEC\s+\d+(?:[-\s]\d+)?(?:\s+IP\s*\d+[A-Z]?)?/gi) ?? []),
    ...(value.match(/\bIP\s*\d+[A-Z]?\b/gi) ?? [])
  ].map(cleanText);
}

function findLinkedProductDetailUrl(html: string, baseUrl: string, catalogNumber: string): string | undefined {
  const $ = cheerio.load(html);
  const partKey = compactKey(catalogNumber);
  const candidates: string[] = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || !/\/product\//i.test(href)) return;
    const context = cleanText(
      [
        $(element).text(),
        $(element).attr("title"),
        $(element).find("img").attr("alt"),
        $(element).closest("li,article,.product,.product-loop-row,.search-row").text()
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (partKey && !compactKey(context).includes(partKey)) return;
    try {
      const absolute = new URL(href, baseUrl).toString();
      if (absolute !== baseUrl && !candidates.includes(absolute)) candidates.push(absolute);
    } catch {
      // Ignore invalid links.
    }
  });
  return candidates[0];
}

function dedupeAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  const seen = new Set<string>();
  return attributes.filter((attr) => {
    const key = `${attr.group ?? ""}|${attr.name}|${attr.value}`.toLowerCase();
    if (!attr.name || !attr.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const seen = new Set<string>();
  return documents.filter((doc) => {
    const key = doc.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
