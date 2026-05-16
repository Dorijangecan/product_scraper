import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { classifyDocument, cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const SCHNEIDER_PRODUCT_URL = "https://www.se.com/us/en/product/{part}/";

export class SchneiderConnector implements ManufacturerConnector {
  readonly id = "schneider";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const officialUrl = SCHNEIDER_PRODUCT_URL.replace("{part}", encodeURIComponent(catalogNumber));
    let fetched: FetchedText | undefined;
    try {
      fetched = await context.http.fetchText(officialUrl, { timeoutMs: 25000, signal: context.signal });
      if (fetched.statusCode >= 400) throw new Error(`Schneider returned HTTP ${fetched.statusCode}`);
    } catch {
      fetched = await context.http.fetchTextViaPowerShell(officialUrl, { timeoutMs: 35000, signal: context.signal });
    }

    const result = parseSchneiderProductPage(catalogNumber, fetched);
    if (result.status !== "failed") return result;

    const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
    return fallback ?? result;
  }
}

export function parseSchneiderProductPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  const $ = cheerio.load(fetched.text);
  const decoded = decodeEmbeddedHtml(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const matched = decoded.toLowerCase().includes(catalogNumber.toLowerCase());
  const source = {
    url: sourceUrl,
    sourceType: "official-fallback",
    parser: "schneider-product-page",
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  } satisfies SourceRecord;

  if (!matched) {
    return {
      ...emptyResult("schneider", catalogNumber, "Schneider page did not contain the catalog number."),
      sources: [source]
    };
  }

  const productInfo = readProductInfo(decoded);
  const canonicalUrl = cleanText($("link[rel='canonical']").attr("href") || sourceUrl);
  const title = cleanText(
    $("h1").first().text() ||
      productInfo.description ||
      $("meta[property='og:title']").attr("content") ||
      $("title").first().text()
  ).replace(/\s+\|\s+Schneider Electric.*$/i, "");
  const description = cleanText(
    productInfo.description || $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content")
  );
  const attributes = dedupeAttributes([
    ...extractProductInfoAttributes(productInfo, catalogNumber, sourceUrl),
    ...extractCharacteristics(decoded, sourceUrl),
    ...extractSustainabilityCharacteristics(decoded, sourceUrl)
  ]);
  const documents = dedupeDocuments([...extractImageDocuments(decoded, catalogNumber, sourceUrl), ...extractLinkedDocuments(decoded, sourceUrl)]);
  const normalized = normalizeFields(attributes, documents);

  return {
    manufacturerId: "schneider",
    catalogNumber,
    status: attributes.length || documents.length ? "found" : "partial",
    confidence: attributes.length || documents.length ? 0.86 : 0.55,
    productUrl: canonicalUrl,
    localizedUrls: buildLocalizedProductUrls("schneider", catalogNumber, canonicalUrl),
    title,
    description,
    normalized,
    attributes,
    documents,
    sources: [source],
    error: attributes.length || documents.length ? undefined : "No Schneider product data found."
  };
}

function readProductInfo(decoded: string): { brand?: string; description?: string; productId?: string } {
  return {
    brand: readJsonString(decoded, /"brand":"([^"]+)"/),
    description: readJsonString(decoded, /"description":"([^"]+)"/),
    productId: readJsonString(decoded, /"productId":"([^"]+)"/)
  };
}

function extractProductInfoAttributes(
  productInfo: { brand?: string; description?: string; productId?: string },
  catalogNumber: string,
  sourceUrl: string
): AttributeRecord[] {
  const attributes: AttributeRecord[] = [
    { group: "Schneider Product Info", name: "Catalog Number", value: catalogNumber, sourceUrl }
  ];
  if (productInfo.brand) attributes.push({ group: "Schneider Product Info", name: "Brand", value: productInfo.brand, sourceUrl });
  if (productInfo.productId) attributes.push({ group: "Schneider Product Info", name: "Product ID", value: productInfo.productId, sourceUrl });
  if (productInfo.description) attributes.push({ group: "Schneider Product Info", name: "Description", value: productInfo.description, sourceUrl });
  return attributes;
}

function extractCharacteristics(decoded: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const pattern =
    /"characteristicName":"([^"]+)"[\s\S]{0,800}?"characteristicValues":\[\{[\s\S]{0,400}?"labelText":"([^"]*)"/g;
  for (const match of decoded.matchAll(pattern)) {
    const name = cleanJsonValue(match[1]);
    const value = cleanJsonValue(match[2]);
    if (!name || !value) continue;
    attributes.push({ group: "Schneider Characteristics", name, value, sourceUrl });
  }
  return attributes;
}

function extractSustainabilityCharacteristics(decoded: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const pattern = /"charName":\{"labelText":"([^"]+)"[\s\S]{0,600}?"charValue":\{"labelText":"([^"]*)"/g;
  for (const match of decoded.matchAll(pattern)) {
    const name = cleanJsonValue(match[1]);
    const value = cleanJsonValue(match[2]);
    if (!name || !value) continue;
    attributes.push({ group: "Schneider Sustainability", name, value, sourceUrl });
  }
  return attributes;
}

function extractImageDocuments(decoded: string, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const part = catalogNumber.toLowerCase();
  const documents: DocumentRecord[] = [];
  for (const url of extractDownloadUrls(decoded)) {
    if (!/p_File_Type=rendition_/i.test(url)) continue;
    const params = readUrlParams(url);
    const ref = cleanText(params.get("p_Doc_Ref") ?? "");
    if (!ref.toLowerCase().includes(part)) continue;
    documents.push({
      type: "image",
      label: imageLabelFromRef(ref),
      url,
      sourceUrl
    });
  }
  return documents.sort((left, right) => imageRank(left.url) - imageRank(right.url)).slice(0, 8);
}

function extractLinkedDocuments(decoded: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const url of extractDownloadUrls(decoded)) {
    if (/p_File_Type=rendition_/i.test(url)) continue;
    const params = readUrlParams(url);
    const label =
      cleanText(params.get("p_File_Name")) ||
      cleanText(params.get("p_Archive_Name")) ||
      cleanText(params.get("p_enDocType")) ||
      cleanText(params.get("p_Doc_Ref")) ||
      "Schneider document";
    const type = classifyDocument(label, url);
    if (type === "other") continue;
    documents.push({ type, label, url, sourceUrl });
  }
  return documents;
}

function extractDownloadUrls(decoded: string): string[] {
  const urls = new Set<string>();
  for (const match of decoded.matchAll(/https:\/\/download\.(?:schneider-electric|se)\.com\/files\?[^"'<>\s]+/g)) {
    urls.add(match[0].replace(/\\u0026/g, "&"));
  }
  return [...urls];
}

function readUrlParams(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function imageLabelFromRef(ref: string): string {
  if (/dimension/i.test(ref)) return "Technical illustration with dimensions";
  if (/main|iop/i.test(ref)) return "Product image";
  return cleanText(ref) || "Product image";
}

function imageRank(url: string): number {
  if (/iopmain|main/i.test(url)) return 0;
  if (/dimension/i.test(url)) return 1;
  return 2;
}

function readJsonString(decoded: string, pattern: RegExp): string | undefined {
  const match = decoded.match(pattern);
  return match ? cleanJsonValue(match[1]) : undefined;
}

function cleanJsonValue(value: string): string {
  return cleanText(
    value
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/<br\s*\/?>/gi, "; ")
      .replace(/<\/?[^>]+>/g, " ")
  );
}

function decodeEmbeddedHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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
    if (!doc.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
