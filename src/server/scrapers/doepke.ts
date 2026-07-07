import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { catalogTextMatches, fillCatalogTemplate } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments, dedupeSources } from "./dedupe.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { classifyDocument, cleanText, emptyResult, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";

const DOEPKE_PARSER = "doepke-prodext";
const DOEPKE_PARSER_VERSION = "doepke-v1";
// `prodext.php` is a legacy but stable Doepke endpoint keyed directly off the article number
// (ARTNR) — every product family (RCCB, RCBO, accessories, ...) renders from the same static
// template, so a single GET resolves the product with no search/discovery step. English is tried
// first: its technical-data labels ("Weight", "Width", "Rated voltage (AC)", ...) line up with the
// shared ontology synonyms directly, while German is a same-content fallback for older articles
// that only publish a German page.
const DOEPKE_PRODEXT_TEMPLATES = [
  "https://www.doepke.de/source/prodext.php?ARTNR={part}&lang=en",
  "https://www.doepke.de/source/prodext.php?ARTNR={part}&lang=de"
];
// The real German not-found text is "Ein Produkt mit der Artikelnummer {ARTNR} ist uns leider
// nicht bekannt." — a guessed "kein produkt..." phrasing never matched it, so a not-found DE page
// (which echoes the searched article number back in its own text) passed catalogTextMatches as a
// false-positive "found" result with 0 attributes/documents, then fell through to the generic
// discovery fallback, which grabbed unrelated images (site logo, language flags, other products)
// from whatever page it found next.
const DOEPKE_NOT_FOUND_PATTERN = /not aware of any product|ist uns leider nicht bekannt/i;

// The page is a shared, decades-old FrontPage-style template with mismatched-case tags
// (`<div ...>...</DIV>`) and inline `javascript:` links. The generic understanding-engine
// heuristics (built for well-formed modern markup) mis-split this into garbage attributes and
// picked up a `javascript:` pseudo-URL as a "document". Every product page renders from the exact
// same fixed element ids below, so reading them directly is both simpler and far more reliable
// than fighting the generic table/prose extractors on this one template.
const DOEPKE_TITLE_SELECTOR = "#ART_RKopf";
const DOEPKE_DESCRIPTION_SELECTOR = "#ART_Text";
const DOEPKE_IMAGE_SELECTOR = "#ART_Bild img";
// Repeating `<div id="ART_EGn">Label<br><b>Value</b></div>` feature rows (poles, residual current
// type, rated current, ...). The id is reused on every row (invalid HTML, but consistent).
const DOEPKE_FEATURE_ROW_SELECTOR = 'div[id="ART_EGn"]';
// Real downloadable assets sit in `<div id="ART_Link"><a href="/uploads/...">Label</a></div>`
// rows. Accessory cross-reference links (other article numbers) and the "open in popup" javascript
// thumbnail link use the same `#ART_Link`-ish styling but never point at `/uploads/`.
const DOEPKE_DOWNLOAD_LINK_SELECTOR = 'div[id="ART_Link"] > a[href^="/uploads/"], div[id="ART_Link"] > a[href^="https://www.doepke.de/uploads/"]';
const DOEPKE_DATASHEET_LABEL_PREFIX = /^(?:data\s*sheet|datenblatt|hoja\s+de\s+datos)\s*/i;
// Ignore installer executables and raw tender-text export formats: not product facts, not
// something a customer document sheet needs, and .exe downloads are undesirable to surface at all.
const DOEPKE_IGNORED_DOWNLOAD_EXTENSIONS = /\.(?:exe|rtf|x81|p81|d81|html)(?:[?#]|$)/i;

export class DoepkeConnector implements ManufacturerConnector {
  readonly id = "doepke";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const attemptedUrls: string[] = [];

    for (const template of DOEPKE_PRODEXT_TEMPLATES) {
      const url = fillCatalogTemplate(template, catalogNumber);
      attemptedUrls.push(url);
      try {
        const fetched = await fetchDoepkeText(url, context);
        if (!doepkePageMatches(fetched.text, catalogNumber)) continue;
        return withDoepkeMetadata(catalogNumber, fetched, context);
      } catch {
        // Try the next locale template.
      }
    }

    // Neither the English nor the German prodext.php lookup matched (typo'd or discontinued
    // article number). Fall through to the shared official discovery net for a last resort.
    const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: this.id });
    const result = fallback ?? emptyResult("doepke", catalogNumber, `Doepke product page was not found for ${catalogNumber}.`);
    return withDiscoveryFallbackDiagnostics(
      {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          attemptedUrls: [...new Set([...(result.diagnostics?.attemptedUrls ?? []), ...attemptedUrls])]
        }
      },
      discovery
    );
  }
}

export function doepkePageMatches(html: string, catalogNumber: string): boolean {
  if (DOEPKE_NOT_FOUND_PATTERN.test(html)) return false;
  return catalogTextMatches(html, catalogNumber);
}

function withDoepkeMetadata(catalogNumber: string, fetched: FetchedText, context: ScrapeContext): ProductResult {
  const sourceUrl = fetched.effectiveUrl;
  const $ = cheerio.load(fetched.text);

  const title = doepkeTitle($);
  const description = doepkeShortDescription($);
  const datasheet = doepkeDatasheetLink($, sourceUrl);
  const image = doepkeProductImage($, sourceUrl);

  const attributes: AttributeRecord[] = [
    ...doepkeFeatureAttributes($, sourceUrl),
    {
      group: "Doepke Product Data",
      name: "Catalog Number",
      value: catalogNumber,
      sourceUrl,
      sourceType: "official",
      parser: DOEPKE_PARSER,
      stage: DOEPKE_PARSER,
      confidence: 0.9
    },
    ...(datasheet?.typeCode
      ? [{
          group: "Doepke Product Data",
          name: "Type Code",
          value: datasheet.typeCode,
          sourceUrl,
          sourceType: "official" as const,
          parser: DOEPKE_PARSER,
          stage: DOEPKE_PARSER,
          confidence: 0.88
        }]
      : [])
  ];

  const documents: DocumentRecord[] = [
    ...(image ? [image] : []),
    ...(datasheet ? [datasheet.document] : []),
    ...doepkeDownloadDocuments($, sourceUrl, catalogNumber)
  ];

  const dedupedAttributes = dedupeAttributes(attributes);
  const dedupedDocuments = dedupeDocuments(documents);

  return {
    manufacturerId: "doepke",
    catalogNumber,
    status: dedupedAttributes.length || dedupedDocuments.length ? "found" : "partial",
    confidence: 0.8,
    productUrl: sourceUrl,
    localizedUrls: buildLocalizedProductUrls("doepke", catalogNumber, sourceUrl, context.manufacturer.localizedUrlTemplates),
    title,
    description,
    normalized: normalizeFields(dedupedAttributes, dedupedDocuments),
    attributes: dedupedAttributes,
    documents: dedupedDocuments,
    sources: dedupeSources([doepkeSource(fetched, "Doepke prodext.php article page accepted.")]),
    diagnostics: { chosenUrl: sourceUrl }
  };
}

/**
 * `#ART_RKopf` holds the product designation followed by a nested `#TLINK` div that repeats the
 * datasheet link ("&raquo; articles properties") for a second time on the page. Dropping that
 * whole nested div (not just the `<a>` inside it) is required to avoid a trailing "»" artifact.
 */
export function doepkeTitle($: cheerio.CheerioAPI): string | undefined {
  return cleanText($(DOEPKE_TITLE_SELECTOR).clone().find("#TLINK").remove().end().text()) || undefined;
}

/**
 * The `#ART_Text` block is a flat run of text and `<br>` tags starting with a one-line
 * plain-language description ("Residual current circuit-breakers, four-pole, 63 A, ..."), followed
 * by `<div id="ART_TXT_Z1">Function:</div>` (or "Funktion:", "Features:", ...) heading markers that
 * introduce the long-form marketing prose. Reading only the text nodes before the first such
 * heading div gives the short description without any string-splitting assumptions about language.
 */
export function doepkeShortDescription($: cheerio.CheerioAPI): string | undefined {
  const container = $(DOEPKE_DESCRIPTION_SELECTOR);
  if (!container.length) return undefined;
  const parts: string[] = [];
  for (const node of container.contents().toArray()) {
    if (node.type === "tag") {
      if (node.name.toLowerCase() === "div") break;
      continue;
    }
    if (node.type === "text") parts.push(node.data);
  }
  return cleanText(parts.join(" ")) || undefined;
}

/**
 * Reads the "Features" mini spec table: repeating `<div id="ART_EGn">Label<br><b>Value</b></div>`
 * rows (poles, residual current type, rated current, IΔn, ...). This is the only structured product
 * data present on the HTML page — everything else (weight, dimensions, material, certificates,
 * voltage) lives exclusively in the datasheet PDF and is filled in later by document enrichment.
 */
export function doepkeFeatureAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $(DOEPKE_FEATURE_ROW_SELECTOR).each((_, element) => {
    const $row = $(element);
    const value = cleanText($row.find("b").first().text());
    const label = cleanText($row.clone().find("b").remove().end().text());
    if (!label || !value) return;
    attributes.push({
      group: "Doepke Features",
      name: label,
      value,
      sourceUrl,
      sourceType: "official",
      parser: DOEPKE_PARSER,
      stage: DOEPKE_PARSER,
      confidence: 0.9
    });
  });
  return attributes;
}

export function doepkeDatasheetLink(
  $: cheerio.CheerioAPI,
  baseUrl: string
): { document: DocumentRecord; typeCode?: string } | undefined {
  const link = $(DOEPKE_DOWNLOAD_LINK_SELECTOR)
    .filter((_, element) => /_dbl_[a-z]{2}\.pdf(?:[?#]|$)/i.test($(element).attr("href") ?? ""))
    .first();
  const href = link.attr("href");
  if (!href) return undefined;

  const url = absoluteDoepkeUrl(href, baseUrl);
  if (!url) return undefined;
  const label = cleanText(link.text()) || "Data sheet";
  const typeCode = cleanText(label.replace(DOEPKE_DATASHEET_LABEL_PREFIX, "")) || undefined;
  return {
    document: { type: "datasheet", label, url, sourceUrl: baseUrl },
    typeCode
  };
}

export function doepkeProductImage($: cheerio.CheerioAPI, baseUrl: string): DocumentRecord | undefined {
  const src = $(DOEPKE_IMAGE_SELECTOR).first().attr("src");
  if (!src) return undefined;
  const url = absoluteDoepkeUrl(src, baseUrl);
  if (!url) return undefined;
  return { type: "image", label: "Product image", url, sourceUrl: baseUrl };
}

/**
 * Every other real download (manual, technical info sheets, dimensional drawing, wiring diagram,
 * STEP file) lives in an `#ART_Link` anchor pointing at `/uploads/...`. The datasheet is excluded
 * here since `doepkeDatasheetLink` already emits it as the primary "datasheet" document.
 */
export function doepkeDownloadDocuments($: cheerio.CheerioAPI, baseUrl: string, catalogNumber: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const seenUrls = new Set<string>();
  $(DOEPKE_DOWNLOAD_LINK_SELECTOR).each((_, element) => {
    const href = $(element).attr("href");
    if (!href || DOEPKE_IGNORED_DOWNLOAD_EXTENSIONS.test(href)) return;
    const url = absoluteDoepkeUrl(href, baseUrl);
    if (!url || seenUrls.has(url)) return;
    const isDatasheet = /_dbl_[a-z]{2}\.pdf(?:[?#]|$)/i.test(href);
    if (isDatasheet) return;
    seenUrls.add(url);
    const label = cleanText($(element).text()) || `${catalogNumber} document`;
    documents.push({ type: doepkeDocumentType(label, url), label, url, sourceUrl: baseUrl });
  });
  return documents;
}

/**
 * `classifyDocument` treats any "technical information"/"technical data" label as a "datasheet",
 * but Doepke's "Technical information Derating graph"/"...dissipation power" links are shared,
 * series-wide bulletins (not per-article specs) reused across every DFS 2/4 catalog number.
 * Letting them share the "datasheet" type with the real per-article datasheet makes
 * `enrichResultFromDownloadedDocuments` parse and merge all of them together, and their unrelated
 * text can out-rank/corrupt attributes the real datasheet already resolved correctly. Demote them
 * to "other" so only the genuine per-article datasheet drives datasheet-priority enrichment.
 */
function doepkeDocumentType(label: string, url: string): DocumentRecord["type"] {
  if (/^(?:technical information|prospectus)\b/i.test(label)) return "other";
  // "Wiring diagram"/"Connection diagram" is a circuit schematic JPG, not a product photo — but
  // `classifyDocument` falls through to its generic `.jpe?g` check and tags it "image" since its
  // label doesn't contain "drawing" the way "Dimensional drawing" does. Left as "image" it competes
  // with the real product photo for the image slot.
  if (/^(?:wiring|connection)\s+diagram\b/i.test(label)) return "cad";
  return classifyDocument(label, url);
}

function absoluteDoepkeUrl(rawUrl: string, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function doepkeSource(fetched: FetchedText, reason: string): SourceRecord {
  return {
    url: fetched.effectiveUrl,
    sourceType: "official",
    parser: DOEPKE_PARSER,
    parserVersion: DOEPKE_PARSER_VERSION,
    stage: DOEPKE_PARSER,
    reason,
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  };
}

async function fetchDoepkeText(url: string, context: ScrapeContext): Promise<FetchedText> {
  const policy = context.manufacturer.fetchPolicy ?? {};
  return context.http.fetchText(url, {
    timeoutMs: policy.timeoutMs ?? 15000,
    maxAttempts: policy.maxAttempts ?? 1,
    retryBackoffMs: policy.retryBackoffMs,
    cacheTtlMs: policy.cacheTtlMs,
    headers: {
      ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
      ...(policy.referer ? { referer: policy.referer } : {}),
      ...(policy.userAgent ? { "user-agent": policy.userAgent } : {})
    },
    signal: context.signal
  });
}
