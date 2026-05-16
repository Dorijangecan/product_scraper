import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import type { FetchedText } from "./http-client.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";

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
        const result = parseAbbProductPage(catalogNumber, fetched);
        officialResults.push(result);
        if (result.status === "found") return result;
      } catch (error) {
        lastError = error;
      }
    }

    const primary =
      officialResults.find((result) => result.status === "partial") ??
      officialResults[0] ??
      emptyResult("abb", catalogNumber, lastError instanceof Error ? lastError.message : "ABB fetch failed.");

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
    `https://new.abb.com/smartlinks/en?${smartlinksParams.toString()}`
  ];
}

export function parseAbbProductPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  const $ = cheerio.load(fetched.text);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const products = readJsonLdProducts($);
  const product = products.find((item) => {
    const sku = String(item.sku ?? item.productID ?? "").toLowerCase();
    return sku === catalogNumber.toLowerCase();
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

  attributes.push(...extractAbbEmbeddedAttributes(fetched.text, fetched.effectiveUrl));

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
    fetched.text.toLowerCase().includes(catalogNumber.toLowerCase()) ||
    String(product?.sku ?? product?.productID ?? "").toLowerCase() === catalogNumber.toLowerCase();

  if (!matched) {
    return {
      ...emptyResult("abb", catalogNumber, "ABB product page did not contain the catalog number."),
      sources: [
        {
          url: fetched.effectiveUrl,
          sourceType: "official",
          parser: "abb-product-page",
          fetchedAt: fetched.fetchedAt,
          statusCode: fetched.statusCode
        }
      ]
    };
  }

  const cleanAttributes = dedupeAttributes(attributes);
  const cleanDocuments = dedupeDocuments(documents);
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
  const attributes: AttributeRecord[] = [];
  const pattern = /"attributeName":"([^"]+)"[\s\S]{0,700}?"values":\[\{"text":"([^"]*)"/g;
  for (const match of html.matchAll(pattern)) {
    const name = cleanAbbJsonValue(match[1]);
    const value = cleanAbbJsonValue(match[2]);
    if (!name || !value) continue;
    attributes.push({ group: "ABB Product Data", name, value, sourceUrl });
  }
  return attributes;
}

function cleanAbbJsonValue(value: string): string {
  return cleanText(value.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/<br\s*\/?>/gi, "; ").replace(/<\/?[^>]+>/g, " "));
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
