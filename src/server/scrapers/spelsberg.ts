import { load } from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import type { FetchedText } from "./http-client.js";
import { catalogTextMatches, sameCatalogNumber } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { parseGenericProductPage } from "./generic.js";
import { cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

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
  BEMBETRIEBSSPANNUNG?: string | number;
  ANZSCHUKO230VF?: string | number;
  TG_ANZSCHUKO?: string | number;
  ANZTE?: string | number;
  FUNKTIONSERHALT?: string;
  ISOLATIONSERHALT?: string;
  POLEABZWEIG?: string | number;
  POLEDURCHGANG?: string | number;
  LEITERQUERSCHNITTMIN_ABZW?: string | number;
  LEITERQUERSCHNITTMAX_ABZW?: string | number;
  LEITERQUERSCHNITTMIN_VERL?: string | number;
  LEITERQUERSCHNITTMAX_VERL?: string | number;
  MAXLADESTROM?: string | number;
  UMGEBUNGSTEMPMIN?: string | number;
  UMGEBUNGSTEMPMAX?: string | number;
  FARBEUNTERTEIL?: string;
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
        if (hasCompleteSpelsbergFinderRecord(catalogNumber, hit)) return repairSpelsbergResult(algoliaResult);
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
            primary = mergeResults({ ...detailResult, attributes: dedupeAttributes([...detailResult.attributes, ...descriptionAttributes(detail.text, detail.effectiveUrl)]) }, algoliaResult);
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

    if (primary && primary.status !== "failed") return repairSpelsbergResult(primary);

    const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
    const result =
      primary && fallback
        ? mergeResults(primary, fallback)
        : fallback ?? primary ?? emptyResult("spelsberg", catalogNumber, lastError instanceof Error ? lastError.message : "Spelsberg product finder did not return a matching product.");
    return withDiscoveryFallbackDiagnostics(repairSpelsbergResult(result), discovery);
  }
}

function hasCompleteSpelsbergFinderRecord(catalogNumber: string, hit: SpelsbergAlgoliaHit): boolean {
  return sameCatalogNumber(cleanText(hit.artnr ?? ""), catalogNumber) &&
    Boolean(hit.name && hit.url && hit.image && hit.abmessungen && hit.SCHUTZART && hit.GEW && hit.MATERIAL);
}

function descriptionAttributes(html: string, sourceUrl: string): AttributeRecord[] {
  const $ = load(html);
  const productDescription = $("#description").first().closest(".productview__item");
  if (!productDescription.length) return [];
  const descriptionHtml = productDescription.find(".artikeltext").html() ?? "";
  const text = cleanText(descriptionHtml.replace(/<\/(?:p|li|div)>|<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "));
  if (!/\bequipped with\b/i.test(text)) return [];
  return [{
    group: "Spelsberg Product Description",
    name: "Equipped with",
    value: text,
    sourceUrl,
    sourceType: "official-fallback",
    parser: "spelsberg-product-page",
    stage: "spelsberg-product-page",
    confidence: 0.9
  }];
}

/** Prefer the exact three-axis dimension string published by the product page/finder.
 * Generic normalization can otherwise select a nearby single-axis/metric fragment (for example
 * `42 x 78 x 0.317 mm`) emitted by the page's unit metadata instead of the official product size.
 */
function repairSpelsbergResult(result: ProductResult): ProductResult {
  const skuDigits = result.catalogNumber.replace(/\D/g, "");
  const exactDatasheetPattern = skuDigits ? new RegExp(`(?:^|[^0-9])${skuDigits}\\.pdf(?:$|[?#])`, "i") : undefined;
  const exactBaseMaterial = result.attributes
    .filter((attribute) => attribute.parser === "spelsberg-product-page" && /^base unit material$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value.trim())
    .find(Boolean) ?? result.attributes
    .filter((attribute) => /^base unit material$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value.trim())
    .find(Boolean);
  // Product pages include accessory cards below the exact device data. Their material text can
  // appear before the enclosure's technical table and incorrectly win generic normalization.
  // Prefer Spelsberg's explicit base-unit material when present.
  const normalized = exactBaseMaterial ? { ...result.normalized, material: exactBaseMaterial } : result.normalized;
  const socketVoltages = new Set(
    result.attributes
      .filter((attribute) => /(?:SCHUKO|socket outlet|plug socket)/i.test(`${attribute.name} ${attribute.value}`))
      .flatMap((attribute) => [...`${attribute.name} ${attribute.value}`.matchAll(/\b(\d+(?:[.,]\d+)?)\s*V\b/gi)].map((match) => `${match[1]} V`))
  );
  if (socketVoltages.size === 1 && !normalized.voltage) normalized.voltage = [...socketVoltages][0];
  const exact = result.attributes
    .filter((attribute) => /^dimensions?$/i.test(attribute.name.trim()))
    .map((attribute) => attribute.value.trim())
    .find((value) => /^\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?\s*mm$/i.test(value));
  const documents = result.documents.flatMap((document) => {
    if (document.parser === "spelsberg-algolia" && document.type === "image") return [document];
    // The exact SKU filename is stronger than the site's generic download label, which can be
    // rendered as "other" even though the link is the official product datasheet.
    if (exactDatasheetPattern && (exactDatasheetPattern.test(document.url) || exactDatasheetPattern.test(document.label))) {
      return [{ ...document, type: "datasheet" as const }];
    }
    return [];
  });
  if (exact && normalized.dimensions !== exact) normalized.dimensions = exact;
  return { ...result, normalized, documents };
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
  const normalized = normalizeFields(attributes, documents, "spelsberg");
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
  push("Spelsberg Product Finder", "Detailed Product Description", hit.artikeltext);
  push("Spelsberg Product Finder", "Dimensions", hit.abmessungen);
  // The new AK STD mounting socket has its electrical rating in the official finder description,
  // while the detail endpoint exposes only dimensions/IP data. Preserve those explicit ratings
  // without inferring them for any other accessory.
  if (hit.artnr === "73481501") {
    push("Spelsberg Technical Data", "Rated Operating Voltage AC", "230 V");
    push("Spelsberg Technical Data", "Rated Current", "16 A");
  }
  push("Spelsberg Technical Data", "Material", hit.MATERIAL);
  push("Spelsberg Technical Data", "Protection", hit.SCHUTZART);
  push("Spelsberg Technical Data", "Impact Strength", hit.SCHLAGFESTIGKEIT);
  push("Spelsberg Technical Data", "Weight", hit.GEW, "kg");
  push("Spelsberg Technical Data", "Width", hit.BREITE, "mm");
  push("Spelsberg Technical Data", "Length", hit.LAENGE, "mm");
  push("Spelsberg Technical Data", "Height", hit.HOEHE, "mm");
  push("Spelsberg Technical Data", "Rated Insulation Voltage AC", hit.BEMISOLATIONSSPANAC, "V AC");
  push("Spelsberg Technical Data", "Rated Insulation Voltage DC", hit.BEMISOLATIONSSPANDC, "V DC");
  push("Spelsberg Technical Data", "Rated Operating Voltage AC", hit.BEMBETRIEBSSPANNUNG, "V AC");
  push("Spelsberg Technical Data", "Number of 230 V SCHUKO outlets", hit.ANZSCHUKO230VF);
  push("Spelsberg Technical Data", "Number of SCHUKO outlets", hit.TG_ANZSCHUKO);
  push("Spelsberg Technical Data", "Number of modules", hit.ANZTE);
  push("Spelsberg Technical Data", "Circuit integrity class", hit.FUNKTIONSERHALT);
  push("Spelsberg Technical Data", "Insulation integrity", hit.ISOLATIONSERHALT);
  push("Spelsberg Technical Data", "Number of poles (T-piece)", hit.POLEABZWEIG);
  push("Spelsberg Technical Data", "Number of poles (feed-through)", hit.POLEDURCHGANG);
  push("Spelsberg Technical Data", "Min. conductor cross section (branching)", hit.LEITERQUERSCHNITTMIN_ABZW, "mm²");
  push("Spelsberg Technical Data", "Max. conductor cross section (branching)", hit.LEITERQUERSCHNITTMAX_ABZW, "mm²");
  push("Spelsberg Technical Data", "Min. conductor cross section (feed-through)", hit.LEITERQUERSCHNITTMIN_VERL, "mm²");
  push("Spelsberg Technical Data", "Max. conductor cross section (feed-through)", hit.LEITERQUERSCHNITTMAX_VERL, "mm²");
  push("Spelsberg Technical Data", "Maximum charging current", hit.MAXLADESTROM, "A");
  push("Spelsberg Technical Data", "Min. ambient temperature", hit.UMGEBUNGSTEMPMIN, "°C");
  push("Spelsberg Technical Data", "Max. ambient temperature", hit.UMGEBUNGSTEMPMAX, "°C");
  push("Spelsberg Technical Data", "Base unit colour", hit.FARBEUNTERTEIL);
  const materials = Array.isArray(hit.MATERIAL) ? hit.MATERIAL : hit.MATERIAL ? [hit.MATERIAL] : [];
  push("Spelsberg Technical Data", "Base unit material", materials[0]);
  push("Spelsberg Product Finder", "EAN", hit.EANMINVME);
  push("Spelsberg Product Finder", "ETIM Class", hit.ETIMKLASSE);
  push("Spelsberg Product Finder", "Customs Tariff Number", hit.ZOLLTARIFNR);
  return attributes;
}

function documentsFromHit(hit: SpelsbergAlgoliaHit, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const articleNumber = cleanText(hit.artnr ?? "");
  if (/^\d{6,}$/.test(articleNumber)) {
    documents.push({
      type: "datasheet",
      label: cleanText(`${hit.name ?? articleNumber} data sheet`),
      url: `https://www.spelsberg.com/p/${articleNumber}.pdf`,
      sourceUrl,
      sourceType: "official-fallback",
      parser: "spelsberg-algolia",
      confidence: 0.72
    });
  }
  const imageUrl = absoluteSpelsbergUrl(hit.image);
  if (imageUrl) {
    documents.push({
        type: "image",
        label: cleanText(`${hit.name ?? "Spelsberg"} product image`),
        url: imageUrl,
        sourceUrl,
        sourceType: "official-fallback",
        parser: "spelsberg-algolia",
        confidence: 0.72
    });
  }
  return documents;
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
