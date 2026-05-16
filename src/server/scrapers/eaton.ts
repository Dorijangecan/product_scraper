import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { classifyDocument, cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const EATON_PRODUCT_URL = "https://www.eaton.com/us/en-us/skuPage.{part}.html";
const EATON_READER_URL = "https://r.jina.ai/http://www.eaton.com/us/en-us/skuPage.{part}.html";

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
  "SKU"
].sort((left, right) => right.length - left.length);

export class EatonConnector implements ManufacturerConnector {
  readonly id = "eaton";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const officialUrl = EATON_PRODUCT_URL.replace("{part}", encodeURIComponent(catalogNumber));
    const readerUrl = EATON_READER_URL.replace("{part}", encodeURIComponent(catalogNumber));
    let fetched: FetchedText | undefined;
    try {
      fetched = await context.http.fetchText(officialUrl, { timeoutMs: 10000, signal: context.signal });
    } catch {
      fetched = await context.http.fetchText(readerUrl, {
        timeoutMs: 30000,
        signal: context.signal,
        headers: {
          accept: "text/markdown,text/plain,*/*"
        }
      });
    }
    const result = parseEatonProductPage(catalogNumber, fetched, officialUrl);
    if (result.status !== "failed") return result;

    const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
    return fallback ?? result;
  }
}

export function parseEatonProductPage(catalogNumber: string, fetched: FetchedText, officialUrl: string): ProductResult {
  const text = fetched.text;
  if (!text.toLowerCase().includes(catalogNumber.toLowerCase())) {
    return emptyResult("eaton", catalogNumber, "Eaton page did not contain the catalog number.");
  }

  const lines = text.split(/\r?\n/).map(cleanMarkdownLine).filter(Boolean);
  const title = cleanText(
    readPrefixedLine(lines, "Title:")?.replace(/\s+\|\s+Eaton$/i, "") ||
      lines.find((line) => line.startsWith("# "))?.replace(/^#+\s*/, "") ||
      catalogNumber
  );
  const description = readDescription(lines, catalogNumber);
  const attributes = dedupeAttributes(extractAttributes(lines, fetched.effectiveUrl));
  const documents = dedupeDocuments([...extractMarkdownImages(text, catalogNumber, fetched.effectiveUrl), ...extractMarkdownLinks(text, catalogNumber, fetched.effectiveUrl)]);
  const normalized = normalizeFields(attributes, documents);
  return {
    manufacturerId: "eaton",
    catalogNumber,
    status: attributes.length || documents.length ? "found" : "failed",
    confidence: attributes.length || documents.length ? 0.82 : 0,
    productUrl: officialUrl,
    localizedUrls: buildLocalizedProductUrls("eaton", catalogNumber, officialUrl),
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
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      } satisfies SourceRecord
    ],
    error: attributes.length || documents.length ? undefined : "No Eaton product attributes found."
  };
}

function extractAttributes(lines: string[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  for (const line of lines) {
    const boldPair = line.match(/^\*\*([^*]{2,80})\*\*\s*(.+)$/);
    if (boldPair) {
      attributes.push({ group: "Eaton Page", name: cleanText(boldPair[1]), value: cleanText(boldPair[2]), sourceUrl });
      continue;
    }
    for (const field of KNOWN_FIELDS) {
      const match = line.match(new RegExp(`^${escapeRegExp(field)}\\s+(.+)$`, "i"));
      if (!match) continue;
      attributes.push({ group: "Eaton Page", name: field, value: cleanText(match[1]), sourceUrl });
      break;
    }
  }
  return attributes;
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
    if (!/\.(pdf|zip|dwg|dxf|stp|step)(?:[?#]|$)/i.test(url)) continue;
    const type = classifyDocument(label, url);
    if (type === "other" && !`${label} ${url}`.toLowerCase().includes(catalogNumber.toLowerCase())) continue;
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
  const seen = new Set<string>();
  return documents.filter((doc) => {
    const key = doc.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
