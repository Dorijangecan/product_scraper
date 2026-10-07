import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { dedupeAttributes, dedupeDocuments, dedupeSources } from "./dedupe.js";
import { cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const LAPP_PARSER = "lapp-occ-product";
const LAPP_PARSER_VERSION = "lapp-occ-v1";
const LAPP_API_TEMPLATE = "https://api-shop.lapp.com/occ/v2/us/products/{part}?fields=FULL";
const LAPP_PDP_PREFIX = "https://www.lapp.com/en_GB/gb/GBP";

export class LappConnector implements ManufacturerConnector {
  readonly id = "lapp";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const apiUrl = LAPP_API_TEMPLATE.replace("{part}", encodeURIComponent(catalogNumber));
    try {
      const fetched = await context.http.fetchText(apiUrl, {
        timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 20000,
        maxAttempts: context.manufacturer.fetchPolicy?.maxAttempts ?? 1,
        cacheTtlMs: context.manufacturer.fetchPolicy?.cacheTtlMs,
        headers: {
          accept: "application/xml,text/xml;q=0.9,*/*;q=0.5",
          "accept-language": "en-GB,en;q=0.9"
        },
        signal: context.signal
      });
      return parseLappProduct(catalogNumber, fetched);
    } catch (error) {
      return emptyResult("lapp", catalogNumber, `LAPP article API failed for ${catalogNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function parseLappProduct(catalogNumber: string, fetched: FetchedText): ProductResult {
  const $ = cheerio.load(fetched.text, { xmlMode: true });
  const exactCode = cleanText($("product > code").first().text());
  if (exactCode !== catalogNumber) {
    return emptyResult("lapp", catalogNumber, `LAPP API identity mismatch: requested ${catalogNumber}, received ${exactCode || "no article code"}.`);
  }

  const sourceUrl = fetched.effectiveUrl;
  const relativePdp = cleanText($("product > canonicalUrl").first().text()) || cleanText($("product > url").first().text());
  if (!relativePdp || !new RegExp(`/p/${escapeRegExp(catalogNumber)}$`).test(relativePdp)) {
    return emptyResult("lapp", catalogNumber, `LAPP API did not return an exact PDP path for ${catalogNumber}.`);
  }
  const productUrl = `${LAPP_PDP_PREFIX}${relativePdp.startsWith("/") ? relativePdp : `/${relativePdp}`}`;
  const title = cleanText($("product > name").first().text()) || undefined;
  const description = cleanText($("product > description").first().text()) || undefined;

  const attributes: AttributeRecord[] = [
    lappAttribute("LAPP Product Data", "Catalog Number", catalogNumber, sourceUrl, "variant", "exact"),
    ...(title ? [lappAttribute("LAPP Product Data", "Article Name", title, sourceUrl, "variant")] : []),
    ...lappFeatureAttributes($, sourceUrl),
    ...lappCategoryAttributes($, sourceUrl),
    ...lappDescriptionAttributes(description, sourceUrl)
  ];

  const image = lappProductImage($, sourceUrl);
  const documents: DocumentRecord[] = [
    ...(image ? [image] : []),
    ...lappDocuments($, sourceUrl)
  ];
  const dedupedAttributes = dedupeAttributes(attributes);
  const dedupedDocuments = dedupeDocuments(documents);
  const source: SourceRecord = {
    url: sourceUrl,
    sourceType: "official",
    parser: LAPP_PARSER,
    parserVersion: LAPP_PARSER_VERSION,
    stage: "lapp-occ-api",
    reason: "Exact LAPP OCC article response matched the requested article code and PDP path.",
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  };

  return {
    manufacturerId: "lapp",
    catalogNumber,
    status: "found",
    confidence: image ? 0.94 : 0.82,
    productUrl,
    localizedUrls: { en: productUrl },
    title,
    description,
    normalized: normalizeFields(dedupedAttributes, dedupedDocuments),
    attributes: dedupedAttributes,
    documents: dedupedDocuments,
    sources: dedupeSources([source]),
    diagnostics: {
      chosenUrl: productUrl,
      terminal: {
        skipNetworkFallback: true,
        reason: "LAPP OCC returned an authoritative exact article response; speculative HTML/browser discovery must not replace it with a family page, PDF, or unrelated image."
      },
      notes: [
        `LAPP exact article API: ${sourceUrl}`,
        image ? "Selected LAPP image: format=product and imageType=GALLERY." : "LAPP API returned no gallery product image."
      ]
    }
  };
}

function lappCategoryAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const categories = $("product > categoryLevelNames").map((_, element) => cleanText($(element).text())).get().filter(Boolean);
  return categories.length
    ? [lappAttribute("LAPP Product Data", "Classification Path", [...new Set(categories)].join(" > "), sourceUrl, "variant")]
    : [];
}

function lappFeatureAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("product > classifications > features").each((_, element) => {
    const name = cleanText($(element).children("name").first().text());
    const values = $(element).children("featureValues").children("value").map((__, value) => cleanText($(value).text())).get().filter(Boolean);
    if (!name || !values.length) return;
    attributes.push(lappAttribute("LAPP Technical Data", name, [...new Set(values)].join("; "), sourceUrl, "variant"));
  });
  return attributes;
}

function lappDescriptionAttributes(description: string | undefined, sourceUrl: string): AttributeRecord[] {
  if (!description) return [];
  return description
    .split(/\s*;\s*/)
    .map((part) => part.match(/^([^:]{2,100}):\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match?.[1] && match[2]))
    .map((match) => lappAttribute("LAPP Description", cleanText(match[1]), cleanText(match[2]), sourceUrl, "variant"));
}

function lappProductImage($: cheerio.CheerioAPI, sourceUrl: string): DocumentRecord | undefined {
  const productImage = $("product > images").filter((_, element) => {
    const format = cleanText($(element).children("format").first().text()).toLowerCase();
    const imageType = cleanText($(element).children("imageType").first().text()).toUpperCase();
    return format === "product" && imageType === "GALLERY";
  }).first();
  const url = cleanText(productImage.children("url").first().text());
  if (!url || !/^https:\/\/contentmedia\.lappcdn\.com\//i.test(url)) return undefined;
  return {
    type: "image",
    label: cleanText(productImage.children("altText").first().text()) || "LAPP product image",
    url,
    sourceUrl,
    sourceType: "official",
    parser: LAPP_PARSER,
    stage: "lapp-occ-api",
    confidence: 0.96
  };
}

function lappDocuments($: cheerio.CheerioAPI, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("product > documents").each((_, element) => {
    const url = cleanText($(element).children("url").first().text());
    const label = cleanText($(element).children("altText").first().text()) || "LAPP document";
    if (!url || !/^https:\/\/(?:contentmedia\.lappcdn\.com|imager\.lapp\.com)\//i.test(url)) return;
    documents.push({
      type: /manual|instruction|installation/i.test(label) ? "manual" : "datasheet",
      label,
      url,
      sourceUrl,
      sourceType: "official",
      parser: LAPP_PARSER,
      stage: "lapp-occ-api",
      confidence: 0.9
    });
  });
  return documents;
}

function lappAttribute(
  group: string,
  name: string,
  value: string,
  sourceUrl: string,
  scope: NonNullable<AttributeRecord["scope"]>,
  matchLevel?: AttributeRecord["matchLevel"]
): AttributeRecord {
  return { group, name, value, sourceUrl, sourceType: "official", parser: LAPP_PARSER, stage: "lapp-occ-api", confidence: 0.94, scope, ...(matchLevel ? { matchLevel } : {}) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
