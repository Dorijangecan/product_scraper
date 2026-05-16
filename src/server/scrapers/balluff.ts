import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { classifyDocument, cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";

const BALLUFF_BASE = "https://www.balluff.com/en-us/products";

export class BalluffConnector implements ManufacturerConnector {
  id = "balluff";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const url = `${BALLUFF_BASE}/${encodeURIComponent(catalogNumber)}`;
    try {
      const fetched = await context.http.fetchText(url, { timeoutMs: 20000, signal: context.signal });
      return parseBalluffProductPage(catalogNumber, fetched);
    } catch (error) {
      return emptyResult("balluff", catalogNumber, error instanceof Error ? error.message : "Balluff fetch failed.");
    }
  }
}

export function parseBalluffProductPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  const $ = cheerio.load(fetched.text);
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const products = readJsonLdProducts($);
  const product = products.find((item) => String(item.sku ?? item.mpn ?? "").toLowerCase() === catalogNumber.toLowerCase()) ?? products[0];

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
    const offer = product.offers;
    if (offer && typeof offer === "object" && !Array.isArray(offer)) {
      const offerRecord = offer as Record<string, unknown>;
      for (const name of ["availability", "price", "priceCurrency"]) {
        const value = offerRecord[name];
        if (value === undefined || value === null) continue;
        attributes.push({
          group: "Offer",
          name,
          value: cleanText(String(value)),
          sourceUrl: fetched.effectiveUrl
        });
      }
    }
  }

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

  const imageUrl = firstImageUrl(product?.image) ?? $("meta[property='og:image']").attr("content");
  if (imageUrl) {
    documents.push({
      type: "image",
      label: "Product image",
      url: new URL(imageUrl, fetched.effectiveUrl).toString(),
      sourceUrl: fetched.effectiveUrl
    });
  }

  parseMetaDescriptionSpecs($("meta[name='description']").attr("content"), fetched.effectiveUrl).forEach((attr) => attributes.push(attr));

  $("tr").each((_, element) => {
    const name = cleanText($(element).find("th").first().text());
    const value = cleanText($(element).find("td").first().text());
    if (!name || !value) return;
    if (/alternative|further alternative/i.test(name)) return;
    attributes.push({
      group: "Table",
      name,
      value,
      sourceUrl: fetched.effectiveUrl
    });
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const absolute = new URL(href, fetched.effectiveUrl).toString();
    if (!isBalluffDocumentUrl(absolute)) return;
    documents.push(documentFromUrl(absolute, cleanText($(element).text()), fetched.effectiveUrl));
  });

  for (const absolute of extractEmbeddedDocumentUrls(fetched.text, fetched.effectiveUrl)) {
    documents.push(documentFromUrl(absolute, "", fetched.effectiveUrl));
  }

  const title = cleanText(
    [
      catalogNumber,
      product?.alternateName ? `(${String(product.alternateName)})` : "",
      $("h2").last().text() || $("meta[property='product:plural_title']").attr("content") || $("title").text()
    ]
      .filter(Boolean)
      .join(" ")
  );
  const description = cleanText($("meta[name='description']").attr("content") ?? $("meta[property='og:description']").attr("content") ?? "");
  const productUrl = cleanText($("link[rel='canonical']").attr("href") ?? fetched.effectiveUrl);
  const matched =
    fetched.text.toLowerCase().includes(catalogNumber.toLowerCase()) ||
    String(product?.sku ?? product?.mpn ?? "").toLowerCase() === catalogNumber.toLowerCase();

  if (!matched) {
    return {
      ...emptyResult("balluff", catalogNumber, "Balluff product page did not contain the catalog number."),
      sources: [
        {
          url: fetched.effectiveUrl,
          sourceType: "official",
          parser: "balluff-product-page",
          fetchedAt: fetched.fetchedAt,
          statusCode: fetched.statusCode
        }
      ]
    };
  }

  const cleanAttributes = dedupeAttributes(attributes);
  const cleanDocuments = dedupeDocuments(documents);

  return {
    manufacturerId: "balluff",
    catalogNumber,
    status: cleanAttributes.length || cleanDocuments.length ? "found" : "partial",
    confidence: product ? 0.92 : 0.75,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("balluff", catalogNumber, productUrl),
    title,
    description,
    normalized: normalizeFields(cleanAttributes, cleanDocuments),
    attributes: cleanAttributes,
    documents: cleanDocuments,
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType: "official",
        parser: "balluff-product-page",
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

function parseMetaDescriptionSpecs(description: string | undefined, sourceUrl: string): AttributeRecord[] {
  if (!description) return [];
  const attributes: AttributeRecord[] = [];
  const price = description.match(/List price [^:]+:\s*([^-]+)/i)?.[1];
  if (price) attributes.push({ group: "Meta Specs", name: "List price", value: cleanText(price), sourceUrl });

  const fields = [
    "Connection 1",
    "Connection 2",
    "Cable",
    "Number of conductors",
    "Cable temperature, fixed routing",
    "Cable temperature, flexible routing",
    "Operating voltage Ub",
    "Rated current (40 °C)",
    "IP rating",
    "Approval/Conformity"
  ];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const nextFields = fields.filter((candidate) => candidate !== field).map(escapeRegExp).join("|");
    const pattern = new RegExp(`${escapeRegExp(field)}:\\s*([\\s\\S]*?)(?:,\\s*(?:${nextFields}):|\\s+-\\s+BALLUFF|$)`, "i");
    const value = description.match(pattern)?.[1];
    if (value) {
      const cleanedValue = cleanText(value);
      attributes.push({ group: "Meta Specs", name: field, value: cleanedValue, sourceUrl });
      if (field === "Cable") {
        const length = cleanedValue.match(/(?:^|,\s*)(\d+(?:[.,]\d+)?\s*m)\b/i)?.[1];
        if (length) attributes.push({ group: "Meta Specs", name: "Cable length", value: cleanText(length), sourceUrl });
      }
    }
  }
  return attributes;
}

function isBalluffDocumentUrl(url: string): boolean {
  return /publications\.balluff\.com\/pdfengine\/pdf/i.test(url) || /partcommunity\.com/i.test(url);
}

function documentFromUrl(url: string, label: string, sourceUrl: string): DocumentRecord {
  const parsed = new URL(url);
  const typeParam = parsed.searchParams.get("type")?.toLowerCase();
  const cleanLabel =
    label ||
    (typeParam === "pdb"
      ? "Datasheet"
      : typeParam === "mcd"
        ? "Material compliance declaration"
        : typeParam === "weee"
          ? "WEEE certificate"
          : /partcommunity\.com/i.test(url)
            ? "CAD model"
            : "Balluff document");
  return {
    type: /partcommunity\.com/i.test(url) ? "cad" : classifyDocument(cleanLabel, url),
    label: cleanLabel,
    url,
    sourceUrl
  };
}

function extractEmbeddedDocumentUrls(html: string, baseUrl: string): string[] {
  const decoded = html
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"');
  const urls = new Set<string>();
  const keyedUrls = decoded.matchAll(
    /"(?:datasheet|materialComplianceDeclarationUrl|weeePdfUrl|cadLink|caeLink|multiCaeLink|onlineManualUrl)"\s*:\s*"([^"]+)"/gi
  );
  for (const match of keyedUrls) {
    if (match[1] && isBalluffDocumentUrl(match[1])) urls.add(match[1]);
  }
  const inlineUrls = decoded.match(/https?:\/\/(?:publications\.balluff\.com\/pdfengine\/pdf)[^"'<\s]+/gi) ?? [];
  for (const url of inlineUrls) urls.add(url);
  return [...urls].map((url) => new URL(url, baseUrl).toString());
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
