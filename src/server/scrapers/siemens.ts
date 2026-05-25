import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { sameCatalogNumber } from "./catalog-number.js";

const SIEMENS_BASE = "https://sieportal.siemens.com";
const SIEMENS_PRODUCT_API = `${SIEMENS_BASE}/api/mall/SearchApi/GetProductsDetails`;
const SIEMENS_ENVIRONMENT_URL = `${SIEMENS_BASE}/assets/environments/environment.js`;

interface SiemensAuthConfig {
  authority: string;
  anonymousTokenUrl: string;
  clientId: string;
  clientSecret: string;
}

export class SiemensConnector implements ManufacturerConnector {
  readonly id = "siemens";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    try {
      const auth = await this.readAuthConfig(context);
      const token = await this.fetchAnonymousToken(auth, context);
      const fetched = await context.http.fetchText(SIEMENS_PRODUCT_API, {
        method: "POST",
        body: JSON.stringify({
          language: "en",
          countryCode: "WW",
          products: [{ itemId: "1", articleNumber: catalogNumber }]
        }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        timeoutMs: 20000,
        signal: context.signal
      });
      const result = parseSiemensProductApiResponse(catalogNumber, fetched);
      if (result.status !== "failed") {
        const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
        return mergeResults(result, fallback);
      }
    } catch {
      // Fall through to configured public URL templates.
    }

    const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
    if (fallback) return fallback;
    return emptyResult(this.id, catalogNumber, "Siemens public API and configured fallback pages did not return product data.");
  }

  private async readAuthConfig(context: ScrapeContext): Promise<SiemensAuthConfig> {
    const fetched = await context.http.fetchText(SIEMENS_ENVIRONMENT_URL, {
      timeoutMs: 15000,
      signal: context.signal
    });
    const text = fetched.text;
    const authority = readEnvironmentString(text, "authority");
    const anonymousTokenUrl = readEnvironmentString(text, "anonymousTokenUrl");
    const clientId = readEnvironmentString(text, "client_id");
    const clientSecret = readEnvironmentString(text, "client_secret");
    if (!authority || !anonymousTokenUrl || !clientId || !clientSecret) {
      throw new Error("Siemens public auth settings were not found.");
    }
    return { authority, anonymousTokenUrl, clientId, clientSecret };
  }

  private async fetchAnonymousToken(auth: SiemensAuthConfig, context: ScrapeContext): Promise<string> {
    const tokenUrl = new URL(auth.anonymousTokenUrl, auth.authority).toString();
    const fetched = await context.http.fetchText(tokenUrl, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: auth.clientId,
        client_secret: auth.clientSecret
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      cache: false,
      timeoutMs: 15000,
      signal: context.signal
    });
    const parsed = JSON.parse(fetched.text) as { access_token?: string; error?: string };
    if (!parsed.access_token) throw new Error(parsed.error || "Siemens anonymous token was not returned.");
    return parsed.access_token;
  }
}

export function parseSiemensProductApiResponse(catalogNumber: string, fetched: FetchedText): ProductResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fetched.text) as unknown;
  } catch {
    return emptyResult("siemens", catalogNumber, "Siemens API response was not valid JSON.");
  }

  const products = isRecord(parsed) && Array.isArray(parsed.products) ? parsed.products.filter(isRecord) : [];
  const product = products.find((item) => sameCatalogNumber(item.articleNumber, catalogNumber)) ?? products[0];
  if (!product) return emptyResult("siemens", catalogNumber, "Siemens API response did not include a product.");

  const productUrl = `https://sieportal.siemens.com/en-ww/products-services/detail/${encodeURIComponent(catalogNumber)}`;
  const attributes: AttributeRecord[] = [
    { group: "Siemens API", name: "Article Number", value: catalogNumber, sourceUrl: fetched.effectiveUrl },
    ...flattenProductAttributes(product, fetched.effectiveUrl)
  ];
  const documents = siemensDocuments(product, fetched.effectiveUrl);
  const normalized = normalizeFields(attributes, documents);
  const title = stringValue(product.materialShortText) || stringValue(product.articleNumber) || catalogNumber;
  const description = stringValue(product.description);

  return {
    manufacturerId: "siemens",
    catalogNumber,
    status: attributes.length || documents.length ? "found" : "failed",
    confidence: attributes.length || documents.length ? 0.85 : 0,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("siemens", catalogNumber, productUrl),
    title,
    description,
    normalized,
    attributes: dedupeAttributes(attributes),
    documents: dedupeDocuments(documents),
    sources: [
      siemensSource(productUrl, "siemens-sieportal-detail", fetched),
      siemensSource(fetched.effectiveUrl, "siemens-sieportal-api", fetched)
    ],
    error: attributes.length || documents.length ? undefined : "Siemens API product contained no extractable fields."
  };
}

function flattenProductAttributes(product: Record<string, unknown>, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  flattenValue(product, [], attributes, sourceUrl);
  return attributes;
}

function flattenValue(value: unknown, path: string[], attributes: AttributeRecord[], sourceUrl: string) {
  if (value === undefined || value === null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = cleanText(String(value));
    if (text) attributes.push({ group: "Siemens API", name: path.map(labelFromKey).join(" "), value: text, sourceUrl });
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => item === undefined || item === null || ["string", "number", "boolean"].includes(typeof item))) {
      const text = value.map((item) => cleanText(String(item ?? ""))).filter(Boolean).join("; ");
      if (text) attributes.push({ group: "Siemens API", name: path.map(labelFromKey).join(" "), value: text, sourceUrl });
      return;
    }
    value.filter(isRecord).slice(0, 25).forEach((item, index) => flattenValue(item, [...path, String(index + 1)], attributes, sourceUrl));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenValue(child, [...path, key], attributes, sourceUrl);
    }
  }
}

function siemensDocuments(product: Record<string, unknown>, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  addDocument(documents, "image", "Product image", stringValue(product.imageUrl), sourceUrl);
  addDocument(documents, "image", "Product thumbnail", stringValue(product.thumbnailUrl), sourceUrl);
  addDocument(documents, "datasheet", "Siemens datasheet", stringValue(product.pdfDatasheetUrl), sourceUrl);
  return documents;
}

function addDocument(documents: DocumentRecord[], type: DocumentRecord["type"], label: string, url: string | undefined, sourceUrl: string) {
  if (!url) return;
  try {
    documents.push({ type, label, url: new URL(url, SIEMENS_BASE).toString(), sourceUrl });
  } catch {
    // Ignore malformed optional Siemens document URLs.
  }
}

function readEnvironmentString(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`${key}\\s*:\\s*['"]([^'"]+)['"]`));
  return match?.[1];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const text = cleanText(String(value));
  return text || undefined;
}

function labelFromKey(key: string): string {
  if (key === "materialShortText") return "Product Short Text";
  return key
    .replace(/^ui(?=[A-Z])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function siemensSource(url: string, parser: string, fetched: FetchedText): SourceRecord {
  return {
    url,
    sourceType: "official",
    parser,
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  };
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
