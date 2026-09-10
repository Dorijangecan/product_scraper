import type { ProductResult } from "../../shared/types.js";
import type { AttributeRecord, DocumentRecord } from "../../shared/types.js";
import * as cheerio from "cheerio";
import { catalogTextMatches } from "./catalog-number.js";
import type { FetchedText } from "./http-client.js";
import { emptyResult, normalizeFields } from "./normalizer.js";
import { parseGenericProductPage } from "./generic.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const REER_API = "https://www.reersafety.com/wp-json/wp/v2/product";
const REER_PARSER = "reer-wordpress-product-v1";

interface ReerApiItem {
  link?: string;
  slug?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
}

/**
 * ReeR's public product catalogue is WordPress-backed. The REST search endpoint gives us the
 * canonical English product URL, while the product page contains the real technical tables,
 * downloads and product images. Never construct a slug from the order number: the slug contains
 * a human product name and can change independently of the catalogue number.
 */
export class ReerConnector implements ManufacturerConnector {
  readonly id = "reer";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const apiUrl = `${REER_API}?search=${encodeURIComponent(catalogNumber)}&per_page=20&_fields=link,slug,title,content`;
    const attemptedUrls = [apiUrl];

    try {
      const apiResponse = await context.http.fetchText(apiUrl, {
        timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 20000,
        maxAttempts: context.manufacturer.fetchPolicy?.maxAttempts ?? 2,
        retryBackoffMs: context.manufacturer.fetchPolicy?.retryBackoffMs,
        headers: {
          accept: "application/json",
          ...(context.manufacturer.fetchPolicy?.acceptLanguage
            ? { "accept-language": context.manufacturer.fetchPolicy.acceptLanguage }
            : {}),
          ...(context.manufacturer.fetchPolicy?.referer ? { referer: context.manufacturer.fetchPolicy.referer } : {})
        },
        signal: context.signal
      });
      const item = selectExactReerApiItem(apiResponse.text, catalogNumber);
      if (!item?.link) return withAttemptedUrls(emptyResult("reer", catalogNumber, `ReeR REST catalogue did not return an exact product for ${catalogNumber}.`), attemptedUrls);

      const productUrl = canonicalReerProductUrl(item.link);
      attemptedUrls.push(productUrl);
      const productPage = await context.http.fetchText(productUrl, {
        timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 20000,
        maxAttempts: context.manufacturer.fetchPolicy?.maxAttempts ?? 2,
        retryBackoffMs: context.manufacturer.fetchPolicy?.retryBackoffMs,
        headers: {
          ...(context.manufacturer.fetchPolicy?.acceptLanguage
            ? { "accept-language": context.manufacturer.fetchPolicy.acceptLanguage }
            : {}),
          ...(context.manufacturer.fetchPolicy?.referer ? { referer: context.manufacturer.fetchPolicy.referer } : {})
        },
        signal: context.signal
      });
      if (!reerProductPageMatches(productPage, catalogNumber)) {
        return withAttemptedUrls(emptyResult("reer", catalogNumber, "ReeR product page failed exact catalog-number identity validation."), attemptedUrls);
      }

      const parsed = parseGenericProductPage("reer", catalogNumber, productPage, "official", REER_PARSER, {
        match: { requireCatalogNumber: true },
        localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
        confidence: 0.88,
        extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy
      });
      const description = extractReerLongDescription(productPage.text) ?? parsed.description;
      const curated = curateReerPage(parsed, productPage.text, catalogNumber, productUrl, description);
      return withAttemptedUrls({
        ...parsed,
        description,
        normalized: curated.normalized,
        attributes: curated.attributes,
        documents: curated.documents,
        productUrl,
        diagnostics: { ...parsed.diagnostics, chosenUrl: productUrl }
      }, attemptedUrls);
    } catch (error) {
      return withAttemptedUrls(
        emptyResult("reer", catalogNumber, error instanceof Error ? `ReeR lookup failed: ${error.message}` : "ReeR lookup failed."),
        attemptedUrls
      );
    }
  }
}

function curateReerPage(parsed: ProductResult, html: string, catalogNumber: string, sourceUrl: string, descriptionOverride?: string): {
  normalized: ProductResult["normalized"];
  attributes: AttributeRecord[];
  documents: DocumentRecord[];
} {
  const $ = cheerio.load(html);
  const description = descriptionOverride ?? parsed.description;
  const attributes: AttributeRecord[] = [
    {
      group: "ReeR Product Data", name: "Catalog Number", value: catalogNumber,
      sourceUrl, sourceType: "official", parser: REER_PARSER, stage: REER_PARSER, confidence: 0.98
    },
    ...(parsed.title ? [{
      group: "ReeR Product Data", name: "Product Name", value: parsed.title,
      sourceUrl, sourceType: "official" as const, parser: REER_PARSER, stage: REER_PARSER, confidence: 0.98
    }] : []),
    ...(description ? [{
      group: "ReeR Product Data", name: "Description", value: description,
      sourceUrl, sourceType: "official" as const, parser: REER_PARSER, stage: REER_PARSER, confidence: 0.95
    }, {
      group: "ReeR Product Data", name: "Description long", value: description,
      sourceUrl, sourceType: "official" as const, parser: REER_PARSER, stage: REER_PARSER, confidence: 0.95
    }] : [])
  ];

  $(".woocommerce-Tabs-panel table tr, .woocommerce-product-details__short-description table tr").each((_, row) => {
    const cells = $(row).find("td,th").toArray();
    if (cells.length < 2) return;
    const name = cleanCell($(cells[0]).text());
    const rawValue = cleanCell($(cells[1]).text());
    const value = /\b(?:dimension|height|width|depth|length|cross section)\b/i.test(name) && /\(\s*mm\s*\)/i.test(name) && !/\b(?:mm|cm|m|in|inch|inches)\b/i.test(rawValue)
      ? `${rawValue} mm`
      : rawValue;
    if (!name || !value || name.length > 100 || value.length > 500) return;
    attributes.push({
      group: "ReeR Technical Data", name, value, sourceUrl, sourceType: "official",
      parser: REER_PARSER, stage: REER_PARSER, confidence: 0.96
    });
  });

  const pageImages = extractReerPageImages($, sourceUrl);
  const documents = curateReerDocuments([...pageImages, ...parsed.documents], parsed.title);
  const normalized = normalizeFields(attributes, documents);
  const certificateLabels = documents
    .filter((document) => document.type === "certificate")
    .map((document) => cleanCell(document.label ?? ""))
    .filter((label) => label && !/^document$/i.test(label));
  if (certificateLabels.length) normalized.certificates = [...new Set(certificateLabels)].join(", ");
  const powerSupply = attributes.find((attribute) => /^(?:power supply|supply voltage|operating voltage|rated voltage)/i.test(attribute.name));
  if (powerSupply) normalized.voltage = powerSupply.value;
  const temperature = attributes.find((attribute) => /^operating temperature/i.test(attribute.name));
  if (temperature) {
    const match = temperature.value.match(/(-?)\s*(\d+(?:[.,]\d+)?)\s*\.\.\.\s*(-?)\s*(\d+(?:[.,]\d+)?)/);
    if (match) {
      normalized.operatingTemperatureMin = `${match[1]}${match[2]}`.replace(",", ".");
      normalized.operatingTemperatureMax = `${match[3]}${match[4]}`.replace(",", ".");
    }
  }
  if (!attributes.some((attribute) => /^(?:power supply|supply voltage|operating voltage|rated voltage)/i.test(attribute.name))) {
    delete normalized.voltage;
  }
  if (!attributes.some((attribute) => /^(?:rated current|current consumption|switching current|operating current)/i.test(attribute.name))) {
    delete normalized.current;
  }
  const dimensions = attributes.find((attribute) => /^(?:dimensions|cross section dimensions)/i.test(attribute.name));
  if (dimensions) {
    normalized.dimensions = dimensions.value;
  } else {
    delete normalized.dimensions;
  }
  return { normalized, attributes, documents };
}

function extractReerLongDescription(html: string): string | undefined {
  const $ = cheerio.load(html);
  const value = cleanCell($(".product-short-description").first().text());
  return value || undefined;
}

function curateReerDocuments(documents: DocumentRecord[], title: string | undefined): DocumentRecord[] {
  const valid = documents.filter((document) => {
    if (!/^https?:\/\//i.test(document.url)) return false;
    if (/javascript:|my-account|wp-content\/themes|reer-assets\/I1\//i.test(document.url)) return false;
    if (document.type === "image") return !/download|fdb|logo|certificate|tipo|sil3|schematic|diagram|drawing|macro|cad|layout|wiring|circuit|pinout|dimension|technical|^1\.jpg$|^2\.jpg$/i.test(`${document.label ?? ""} ${document.url}`);
    return /\.pdf(?:[?#]|$)/i.test(document.url);
  });
  const images = valid.filter((document) => document.type === "image");
  const preferredImage = [...images].sort((left, right) => imageScore(right, title) - imageScore(left, title))[0];
  return [...(preferredImage ? [preferredImage] : []), ...valid.filter((document) => document.type !== "image")];
}

function imageScore(document: DocumentRecord, title: string | undefined): number {
  const text = `${document.label ?? ""} ${document.url}`;
  let score = 0;
  if (title && new RegExp(escapeRegExp(title), "i").test(document.label ?? "")) score += 100;
  if (/wp-content\/uploads/i.test(document.url)) score += 20;
  if (/allmod|product|model/i.test(text)) score += 10;
  if (!/og:image/i.test(document.label ?? "") && !/_TT(?:[-_.]|$)/i.test(document.url)) score += 45;
  if (/og:image/i.test(document.label ?? "")) score -= 20;
  if (/_TT(?:[-_.]|$)/i.test(document.url)) score -= 10;
  return score;
}

function extractReerPageImages($: cheerio.CheerioAPI, sourceUrl: string): DocumentRecord[] {
  const candidates: DocumentRecord[] = [];
  $("img[src], img[data-src], img[data-lazy-src]").each((_, element) => {
    const rawUrl = $(element).attr("src") ?? $(element).attr("data-src") ?? $(element).attr("data-lazy-src") ?? "";
    if (!/^https?:\/\//i.test(rawUrl) || !/\/wp-content\/uploads\//i.test(rawUrl)) return;
    if (/themes\/|logo|favicon|sprite|icon|menu|footer|social|banner/i.test(rawUrl)) return;
    const label = cleanCell($(element).attr("alt") ?? $(element).attr("title") ?? "Product image");
    if (/schematic|diagram|drawing|macro|cad|layout|wiring|circuit|pinout|dimension|technical/i.test(`${label} ${rawUrl}`)) return;
    candidates.push({
      type: "image", label, url: rawUrl, sourceUrl, sourceType: "official",
      parser: REER_PARSER, stage: REER_PARSER, confidence: 0.92
    });
  });
  return candidates;
}

function cleanCell(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function selectExactReerApiItem(rawJson: string, catalogNumber: string): ReerApiItem | undefined {
  let items: ReerApiItem[];
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return undefined;
    items = parsed.filter((item): item is ReerApiItem => Boolean(item && typeof item === "object"));
  } catch {
    return undefined;
  }
  return items.find((item) => {
    const link = item.link ?? "";
    const slug = item.slug ?? "";
    let pathname = "";
    try {
      pathname = new URL(link).pathname;
    } catch {
      return false;
    }
    return new RegExp(`-${escapeRegExp(catalogNumber)}\\/?$`, "i").test(pathname) ||
      new RegExp(`-${escapeRegExp(catalogNumber)}$`, "i").test(slug) ||
      (catalogTextMatches(`${item.title?.rendered ?? ""} ${item.content?.rendered ?? ""}`, catalogNumber) && link.includes("/en/product/"));
  });
}

export function reerProductPageMatches(fetched: Pick<FetchedText, "effectiveUrl" | "text">, catalogNumber: string): boolean {
  return /reersafety\.com\/en\/product\//i.test(fetched.effectiveUrl) &&
    new RegExp(`-${escapeRegExp(catalogNumber)}\\/?(?:[?#]|$)`, "i").test(fetched.effectiveUrl) &&
    catalogTextMatches(fetched.text, catalogNumber);
}

function canonicalReerProductUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  return url.toString();
}

function withAttemptedUrls(result: ProductResult, attemptedUrls: string[]): ProductResult {
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      attemptedUrls: [...new Set([...(result.diagnostics?.attemptedUrls ?? []), ...attemptedUrls])]
    }
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
