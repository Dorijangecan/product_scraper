import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import type { FetchedText } from "./http-client.js";
import { catalogTextMatches } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { parseGenericProductPage } from "./generic.js";
import { cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";

const ALGOLIA_APP_ID = "NG1O3MB1NI";
const ALGOLIA_API_KEY = "35654b18ecea8d001fec2453b93029f2";
const ALGOLIA_INDEX = "els_articles_en";
const ALGOLIA_QUERY_URL = `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`;

interface SpelsbergAlgoliaResponse {
  hits?: SpelsbergAlgoliaHit[];
}

interface SpelsbergAlgoliaHit {
  artnr?: string;
  name?: string;
  produktart?: string;
  artikeltext?: string;
  agtext?: string;
  abmessungen?: string;
  url?: string;
  image?: string;
  SCHUTZART?: string;
  SCHLAGFESTIGKEIT?: string;
  GEW?: string | number;
  BREITE?: string | number;
  LAENGE?: string | number;
  HOEHE?: string | number;
  MATERIAL?: unknown;
  EANMINVME?: string;
  ETIMKLASSE?: string;
  ZOLLTARIFNR?: string;
  BEMISOLATIONSSPANAC?: string | number;
  BEMISOLATIONSSPANDC?: string | number;
}

export class SpelsbergConnector implements ManufacturerConnector {
  id = "spelsberg";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    let primary: ProductResult | undefined;
    let lastError: unknown;

    try {
      const search = await searchSpelsberg(catalogNumber, context);
      const hit = bestSpelsbergHit(catalogNumber, parseAlgoliaHits(search.text));
      if (hit) {
        const algoliaResult = resultFromAlgoliaHit(catalogNumber, hit, search);
        const detailUrl = officialProductUrlFromHit(hit);
        if (detailUrl) {
          try {
            const detail = await context.http.fetchText(detailUrl, {
              timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 25000,
              headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                referer: "https://www.spelsberg.com/product-finder/"
              },
              signal: context.signal
            });
            const detailResult = parseGenericProductPage("spelsberg", catalogNumber, detail, "official-fallback", "spelsberg-product-page", {
              match: context.manufacturer.match,
              localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
              confidence: 0.82,
              markerRules: context.manufacturer.markerRules,
              extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy
            });
            primary = mergeResults(detailResult, algoliaResult);
          } catch (error) {
            lastError = error;
            primary = algoliaResult;
          }
        } else {
          primary = algoliaResult;
        }
      }
    } catch (error) {
      lastError = error;
    }

    if (primary && primary.status !== "failed") return primary;

    const fallback = await context.fallback.scrape(catalogNumber, context.manufacturer.fallbackSources);
    if (fallback) return primary ? mergeResults(primary, fallback) : fallback;

    return primary ?? emptyResult("spelsberg", catalogNumber, lastError instanceof Error ? lastError.message : "Spelsberg product finder did not return a matching product.");
  }
}

async function searchSpelsberg(catalogNumber: string, context: ScrapeContext): Promise<FetchedText> {
  return context.http.fetchText(ALGOLIA_QUERY_URL, {
    method: "POST",
    body: JSON.stringify({ query: catalogNumber, hitsPerPage: 5 }),
    headers: {
      "content-type": "application/json",
      "x-algolia-application-id": ALGOLIA_APP_ID,
      "x-algolia-api-key": ALGOLIA_API_KEY,
      referer: "https://www.spelsberg.com/product-finder/"
    },
    timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 20000,
    signal: context.signal
  });
}

function parseAlgoliaHits(raw: string): SpelsbergAlgoliaHit[] {
  try {
    const parsed = JSON.parse(raw) as SpelsbergAlgoliaResponse;
    return Array.isArray(parsed.hits) ? parsed.hits : [];
  } catch {
    return [];
  }
}

function bestSpelsbergHit(catalogNumber: string, hits: SpelsbergAlgoliaHit[]): SpelsbergAlgoliaHit | undefined {
  return hits.find((hit) => catalogTextMatches(`${hit.name ?? ""} ${hit.artnr ?? ""}`, catalogNumber, { compact: true, ignoreCase: true }));
}

function resultFromAlgoliaHit(catalogNumber: string, hit: SpelsbergAlgoliaHit, search: FetchedText): ProductResult {
  const sourceUrl = officialProductUrlFromHit(hit) ?? search.effectiveUrl;
  const attributes = dedupeAttributes(attributesFromHit(hit, sourceUrl));
  const documents = dedupeDocuments(documentsFromHit(hit, sourceUrl));
  const normalized = normalizeFields(attributes, documents);
  const sources: SourceRecord[] = [
    {
      url: search.effectiveUrl,
      sourceType: "official-fallback",
      parser: "spelsberg-algolia",
      parserVersion: "spelsberg-v1",
      fetchedAt: search.fetchedAt,
      statusCode: search.statusCode
    }
  ];

  return {
    manufacturerId: "spelsberg",
    catalogNumber,
    status: attributes.length || documents.length ? "partial" : "failed",
    confidence: attributes.length || documents.length ? 0.72 : 0,
    productUrl: sourceUrl,
    localizedUrls: buildLocalizedProductUrls("spelsberg", catalogNumber, sourceUrl),
    title: cleanText(hit.name ?? ""),
    description: cleanText(hit.agtext ?? hit.artikeltext ?? ""),
    normalized,
    attributes,
    documents,
    sources,
    error: attributes.length || documents.length ? undefined : "Spelsberg product finder returned no structured product data."
  };
}

function attributesFromHit(hit: SpelsbergAlgoliaHit, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const push = (group: string, name: string, value: unknown, unit?: string) => {
    const values = Array.isArray(value) ? value.map(String).filter(Boolean).join("; ") : value === undefined || value === null ? "" : String(value);
    const cleaned = cleanText(values);
    if (!cleaned) return;
    attributes.push({
      group,
      name,
      value: unit && !new RegExp(`\\b${unit}\\b`, "i").test(cleaned) ? `${cleaned} ${unit}` : cleaned,
      sourceUrl,
      sourceType: "official-fallback",
      parser: "spelsberg-algolia",
      confidence: 0.72
    });
  };

  push("Spelsberg Product Finder", "Article Number", hit.artnr);
  push("Spelsberg Product Finder", "Product Name", hit.name);
  push("Spelsberg Product Finder", "Product Type", hit.produktart);
  push("Spelsberg Product Finder", "Description", hit.agtext ?? hit.artikeltext);
  push("Spelsberg Product Finder", "Dimensions", hit.abmessungen);
  push("Spelsberg Technical Data", "Material", hit.MATERIAL);
  push("Spelsberg Technical Data", "Protection", hit.SCHUTZART);
  push("Spelsberg Technical Data", "Impact Strength", hit.SCHLAGFESTIGKEIT);
  push("Spelsberg Technical Data", "Weight", hit.GEW, "kg");
  push("Spelsberg Technical Data", "Width", hit.BREITE, "mm");
  push("Spelsberg Technical Data", "Length", hit.LAENGE, "mm");
  push("Spelsberg Technical Data", "Height", hit.HOEHE, "mm");
  push("Spelsberg Technical Data", "Rated Insulation Voltage AC", hit.BEMISOLATIONSSPANAC, "V AC");
  push("Spelsberg Technical Data", "Rated Insulation Voltage DC", hit.BEMISOLATIONSSPANDC, "V DC");
  push("Spelsberg Product Finder", "EAN", hit.EANMINVME);
  push("Spelsberg Product Finder", "ETIM Class", hit.ETIMKLASSE);
  push("Spelsberg Product Finder", "Customs Tariff Number", hit.ZOLLTARIFNR);
  return attributes;
}

function documentsFromHit(hit: SpelsbergAlgoliaHit, sourceUrl: string): DocumentRecord[] {
  const imageUrl = absoluteSpelsbergUrl(hit.image);
  return imageUrl
    ? [{
        type: "image",
        label: cleanText(`${hit.name ?? "Spelsberg"} product image`),
        url: imageUrl,
        sourceUrl,
        sourceType: "official-fallback",
        parser: "spelsberg-algolia",
        confidence: 0.72
      }]
    : [];
}

function officialProductUrlFromHit(hit: SpelsbergAlgoliaHit): string | undefined {
  return absoluteSpelsbergUrl(hit.url);
}

function absoluteSpelsbergUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, "https://www.spelsberg.com").toString();
  } catch {
    return undefined;
  }
}
