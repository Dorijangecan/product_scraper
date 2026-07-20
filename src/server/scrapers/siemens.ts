import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { sameCatalogNumber } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const SIEMENS_BASE = "https://sieportal.siemens.com";
const SIEMENS_PRODUCT_API = `${SIEMENS_BASE}/api/mall/SearchApi/GetProductsDetails`;
const SIEMENS_ENVIRONMENT_URL = `${SIEMENS_BASE}/assets/environments/environment.js`;
const SIEMENS_MMPDATA_SOURCE = {
  id: "siemens-mmpdata",
  label: "Siemens Industry Mall product data",
  enabled: true,
  sourceType: "official-fallback" as const,
  directUrlTemplates: ["https://mall.industry.siemens.com/goos/catalog/Pages/mmpdata.ashx?MLFB1={part}&lang=en"],
  confidence: 0.82,
  fetchPolicy: { timeoutMs: 12000, maxAttempts: 1 }
};

interface SiemensAuthConfig {
  authority: string;
  anonymousTokenUrl: string;
  clientId: string;
  clientSecret: string;
}

// Module-level memoization: Siemens OAuth tokens are reusable across catalog numbers until they expire.
let tokenCache: { token: string; expiresAt: number } | undefined;

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
        const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
        return withDiscoveryFallbackDiagnostics(mergeResults(result, fallback), discovery);
      }
    } catch {
      // Fall through to generic official discovery and configured public URL templates.
    }

    // The public product-data endpoint is a real rendered specification table, unlike the
    // unauthenticated Mall product URL which can return a generic search shell. Use it before
    // broad discovery for regular MLFB numbers; special lines without mmpdata remain unresolved
    // until an identity-confirmed fallback or source document is available.
    const mallDataResult = await context.fallback.scrape(catalogNumber, [SIEMENS_MMPDATA_SOURCE]);
    if (mallDataResult && mallDataResult.status !== "failed") return mallDataResult;

    // Building Technologies stock numbers (for example S55180-A179) are published in Siemens
    // Industry Mall, but are not exposed through the automation-focused SiePortal API nor the
    // mmpdata endpoint.  From this server's network the Mall product and search pages return
    // Access Denied, so sending them through generic discovery can only consume its full 60 s
    // deadline per row.  Return an honest, identity-confirmed partial result with the official
    // product link instead.  This is deliberately narrow: regular MLFBs still get the API plus
    // full discovery pipeline, and no HVAC fields are guessed from a family page.
    if (isSiemensBuildingTechnologiesStockNumber(catalogNumber)) {
      return siemensMallStockNumberResult(catalogNumber);
    }

    const { result, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
    return withDiscoveryFallbackDiagnostics(
      result ?? emptyResult(this.id, catalogNumber, "Siemens public API, official discovery, and configured fallback pages did not return product data."),
      discovery
    );
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
    // Reuse a cached token across catalog numbers when it still has >60s of life left.
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
      return tokenCache.token;
    }
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
    const parsed = JSON.parse(fetched.text) as { access_token?: string; error?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error(parsed.error || "Siemens anonymous token was not returned.");
    const expiresInSec = typeof parsed.expires_in === "number" && parsed.expires_in > 60 ? parsed.expires_in : 300;
    tokenCache = { token: parsed.access_token, expiresAt: Date.now() + (expiresInSec - 60) * 1000 };
    return parsed.access_token;
  }
}

function isSiemensBuildingTechnologiesStockNumber(catalogNumber: string): boolean {
  return /^S\d{5}-[A-Z]\d+$/i.test(catalogNumber.trim());
}

function siemensMallStockNumberResult(catalogNumber: string): ProductResult {
  const stockNumber = catalogNumber.trim();
  const productUrl = `https://mall.industry.siemens.com/mall/CZ/CZ/Catalog/Product/?mlfb=${encodeURIComponent(stockNumber)}`;
  // Smart Infrastructure publishes the selected product's datasheet through this official,
  // server-readable endpoint even when the corresponding interactive Mall page is blocked.
  // `prodId` is an exact stock number, so the document is a safe enrichment candidate rather
  // than a family-wide guessed attachment.
  const datasheetUrl = `https://hit.sbt.siemens.com/RWD/AssetsByProduct.aspx?RC=WW&asset_type=Data%20Sheet%20for%20Product&lang=en&prodId=${encodeURIComponent(stockNumber)}`;
  const attributes: AttributeRecord[] = [
    {
      group: "Siemens Industry Mall",
      name: "Article Number",
      value: stockNumber,
      sourceUrl: productUrl,
      sourceType: "official"
    }
  ];
  return {
    manufacturerId: "siemens",
    catalogNumber,
    status: "partial",
    confidence: 0.5,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("siemens", catalogNumber, productUrl),
    title: stockNumber,
    normalized: normalizeFields(attributes, []),
    attributes,
    documents: [
      {
        type: "datasheet",
        label: "Siemens Building Technologies product datasheet",
        url: datasheetUrl,
        sourceUrl: productUrl
      }
    ],
    sources: [
      { url: productUrl, sourceType: "official", parser: "siemens-building-technologies-stock-number", fetchedAt: new Date().toISOString() },
      { url: datasheetUrl, sourceType: "official", parser: "siemens-building-technologies-datasheet", fetchedAt: new Date().toISOString() }
    ],
    diagnostics: {
      chosenUrl: productUrl,
      notes: [
        "This Siemens Building Technologies stock number is not available through the public server-side API or mmpdata endpoint. Its official product-specific datasheet was attached for enrichment; broad discovery was skipped to avoid a known 60-second timeout."
      ]
    }
  };
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

