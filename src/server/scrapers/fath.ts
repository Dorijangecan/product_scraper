import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { catalogTextMatches, compactCatalogNumber } from "./catalog-number.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

// FATH24 (Shopware-based) catalog numbers look like 098ABG045 / 098ABG045S01 / 093BA1001D80M12.
// Direct product URLs are slug-prefixed (e.g. /en/Anti-slip-Plate-for-Bell-Feet/098ABG045), so we
// can't construct them without first finding the slug. The reliable entry point is the search
// page, which lists product links containing the exact catalog token; the same page also embeds
// the product image (".../media/.../<lower-sku>_p_3d.jpg"). Once we resolve the canonical detail
// URL we fetch the product page via the Jina reader (the Shopware DOM is too JS-heavy for static
// cheerio to find specs on every variant).
const FATH_BASE = "https://www.fath24.com";
const FATH_SEARCH_TEMPLATE = (catalogNumber: string) =>
  `${FATH_BASE}/en/search?search=${encodeURIComponent(catalogNumber)}`;

export class FathConnector implements ManufacturerConnector {
  readonly id = "fath";

  async scrape(rawCatalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    // FATH catalog inputs from CSV imports often carry trailing whitespace; FATH's search treats
    // " " as a literal token so "6SL0040I.476 " returns zero hits. Normalise once up front.
    const catalogNumber = rawCatalogNumber.trim();
    const searchUrl = FATH_SEARCH_TEMPLATE(catalogNumber);
    const attemptedUrls: string[] = [];
    const notes: string[] = [];

    let searchPage: FetchedText | undefined;
    try {
      searchPage = await fetchFathPage(context, searchUrl, { reader: true, timeoutMs: 25000 });
      attemptedUrls.push(searchPage.effectiveUrl);
    } catch (error) {
      notes.push(`FATH search fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!searchPage) {
      // Direct fetch fallback in case the Jina reader is unavailable.
      try {
        searchPage = await fetchFathPage(context, searchUrl, { reader: false, timeoutMs: 20000 });
        attemptedUrls.push(searchPage.effectiveUrl);
      } catch (error) {
        notes.push(`FATH direct search fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!searchPage) {
      return withFathDiscoveryFallback(emptyResult("fath", catalogNumber, "FATH search page could not be fetched."), catalogNumber, context, attemptedUrls, notes);
    }

    const detailUrl = findFathDetailUrl(searchPage.text, catalogNumber);
    if (!detailUrl) {
      // No exact product URL on the search page — try to salvage an image-only result from the
      // search markdown so the caller at least gets a product image.
      const fallback = buildFathResultFromSearch(catalogNumber, searchPage);
      return withFathDiscoveryFallback(fallback ?? emptyResult("fath", catalogNumber, "FATH search returned no matching product."), catalogNumber, context, attemptedUrls, notes);
    }

    let detailPage: FetchedText | undefined;
    try {
      detailPage = await fetchFathPage(context, detailUrl, { reader: true, timeoutMs: 25000 });
      attemptedUrls.push(detailPage.effectiveUrl);
    } catch (error) {
      notes.push(`FATH detail reader fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!detailPage) {
      try {
        detailPage = await fetchFathPage(context, detailUrl, { reader: false, timeoutMs: 20000 });
        attemptedUrls.push(detailPage.effectiveUrl);
      } catch (error) {
        notes.push(`FATH detail direct fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!detailPage) {
      const fallback = buildFathResultFromSearch(catalogNumber, searchPage, detailUrl);
      return withFathDiscoveryFallback(fallback ?? emptyResult("fath", catalogNumber, "FATH product detail page could not be fetched."), catalogNumber, context, attemptedUrls, notes);
    }

    const result = parseFathProductPage(catalogNumber, detailPage, detailUrl, searchPage, context.manufacturer.localizedUrlTemplates);
    return withDiagnostics(result, attemptedUrls, notes);
  }
}

async function withFathDiscoveryFallback(
  primary: ProductResult,
  catalogNumber: string,
  context: ScrapeContext,
  attemptedUrls: string[],
  notes: string[]
): Promise<ProductResult> {
  const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: "fath" });
  const result = fallback ? mergeResults(primary, fallback) : primary;
  return withDiscoveryFallbackDiagnostics(withDiagnostics(result, attemptedUrls, notes), discovery);
}

async function fetchFathPage(
  context: ScrapeContext,
  url: string,
  options: { reader: boolean; timeoutMs: number }
): Promise<FetchedText> {
  const targetUrl = options.reader ? `https://r.jina.ai/${url.replace(/^https?:\/\//i, "http://")}` : url;
  return context.http.fetchText(targetUrl, {
    timeoutMs: options.timeoutMs,
    maxAttempts: 1,
    signal: context.signal,
    headers: options.reader
      ? { accept: "text/markdown,text/plain,*/*" }
      : { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" }
  });
}

/**
 * Returns the canonical fath24 product URL for the given catalog number by scanning the search
 * page text for a link whose final path segment equals the requested SKU (case-insensitive).
 */
export function findFathDetailUrl(text: string, catalogNumber: string): string | undefined {
  const target = catalogNumber.trim().toLowerCase();
  const candidates = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/(?:www\.)?fath24\.com\/[^\s)"'<>]+/gi)) {
    const url = match[0].replace(/[),.;]+$/, "");
    if (!/\/(?:en|de)\//.test(url)) continue;
    if (/\/media\//i.test(url) || /\/search(?:\?|$)/i.test(url) || /#/.test(url)) continue;
    const last = url.split("/").pop()?.toLowerCase() ?? "";
    if (last === target) candidates.add(url);
  }
  // Sort so the english locale wins, then shortest URL (cleanest slug).
  return [...candidates].sort((left, right) => {
    const enLeft = /\/en\//.test(left) ? 0 : 1;
    const enRight = /\/en\//.test(right) ? 0 : 1;
    return enLeft - enRight || left.length - right.length;
  })[0];
}

function parseFathProductPage(
  catalogNumber: string,
  detail: FetchedText,
  productUrl: string,
  search: FetchedText,
  localizedUrlTemplates?: NonNullable<ScrapeContext["manufacturer"]>["localizedUrlTemplates"]
): ProductResult {
  const detailText = detail.text;
  if (!catalogTextMatches(detailText, catalogNumber)) {
    return emptyResult("fath", catalogNumber, "FATH detail page did not contain the catalog number.");
  }

  const title = readFathTitle(detailText, catalogNumber);
  const description = readFathDescription(detailText);
  const attributes = collapseFathEclassRows(extractFathAttributes(detailText, detail.effectiveUrl));
  const documents: DocumentRecord[] = [];

  const productImages = collectFathProductImages(detailText, search.text, catalogNumber, detail.effectiveUrl);
  for (const image of productImages) documents.push(image);

  for (const doc of collectFathDocuments(detailText, detail.effectiveUrl)) documents.push(doc);

  const stamped = (attribute: AttributeRecord) => ({
    sourceType: "official-fallback" as const,
    parser: "fath-product-page",
    stage: "reader",
    confidence: 0.78,
    ...attribute
  });
  const stampedDoc = (doc: DocumentRecord) => ({
    sourceType: "official-fallback" as const,
    parser: "fath-product-page",
    stage: "reader",
    confidence: 0.78,
    ...doc
  });

  const finalAttributes = attributes.map(stamped);
  const finalDocuments = documents.map(stampedDoc);
  const normalized = normalizeFields(finalAttributes, finalDocuments);
  const hasUsable = finalDocuments.some((doc) => doc.type === "image") || finalAttributes.length >= 3;

  const sources: SourceRecord[] = [
    {
      url: search.effectiveUrl,
      sourceType: "official-fallback",
      parser: "fath-search",
      parserVersion: "fath-v1",
      fetchedAt: search.fetchedAt,
      statusCode: search.statusCode
    },
    {
      url: detail.effectiveUrl,
      sourceType: "official-fallback",
      parser: "fath-product-page",
      parserVersion: "fath-v1",
      fetchedAt: detail.fetchedAt,
      statusCode: detail.statusCode
    }
  ];

  return {
    manufacturerId: "fath",
    catalogNumber,
    status: hasUsable ? "found" : "partial",
    confidence: hasUsable ? 0.78 : 0.5,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("fath", catalogNumber, productUrl, localizedUrlTemplates),
    title,
    description,
    normalized,
    attributes: finalAttributes,
    documents: finalDocuments,
    sources,
    error: hasUsable ? undefined : "FATH product found but no usable data extracted."
  };
}

function buildFathResultFromSearch(
  catalogNumber: string,
  search: FetchedText,
  productUrl?: string
): ProductResult | undefined {
  const images = collectFathProductImages(search.text, search.text, catalogNumber, search.effectiveUrl);
  if (images.length === 0) return undefined;
  const stampedDocs = images.map((doc) => ({
    sourceType: "official-fallback" as const,
    parser: "fath-search",
    stage: "search",
    confidence: 0.62,
    ...doc
  }));
  return {
    manufacturerId: "fath",
    catalogNumber,
    status: "partial",
    confidence: 0.62,
    productUrl: productUrl ?? search.effectiveUrl,
    localizedUrls: {},
    title: `FATH ${catalogNumber}`,
    description: undefined,
    normalized: normalizeFields([], stampedDocs),
    attributes: [],
    documents: stampedDocs,
    sources: [
      {
        url: search.effectiveUrl,
        sourceType: "official-fallback",
        parser: "fath-search",
        parserVersion: "fath-v1",
        fetchedAt: search.fetchedAt,
        statusCode: search.statusCode
      }
    ],
    error: "FATH detail page unavailable; using image-only result from search."
  };
}

function readFathTitle(text: string, catalogNumber: string): string {
  const titleLine = text.split(/\r?\n/).find((line) => /^Title:\s*/i.test(line));
  if (titleLine) {
    return cleanText(titleLine.replace(/^Title:\s*/i, "").replace(/\s*[|\-–]\s*FATH(?:24)?(?:\s+GmbH)?$/i, ""));
  }
  const heading = text.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  if (heading) return cleanText(heading.replace(/^#+\s*/, ""));
  return `FATH ${catalogNumber}`;
}

function readFathDescription(text: string): string | undefined {
  const meta = text.match(/Description:\s*(.+)/i);
  if (meta) return cleanText(meta[1]);
  return undefined;
}

/**
 * Pulls product images from FATH's Shopware /media tree. Real product photos follow the strict
 * pattern "<sku>_p_<view>.<ext>" where <sku> is the catalog number in lowercase with separators
 * stripped (e.g. "6sacp3j316b_p_3d.jpg" or "098abg045_p_app.jpg"). We require the filename
 * prefix before "_p_" to match the requested catalog number — otherwise the product detail page
 * (which embeds related-products and "complete cable solution" tiles) leaks unrelated images
 * into the result.
 *
 * SKUs with length variants like "6SACP3J316B.2000" share the same base image set as ".4000"
 * because FATH names images after the base SKU only, so we also accept the part before the
 * first dot/dash as a match.
 */
function collectFathProductImages(
  detailText: string,
  searchText: string,
  catalogNumber: string,
  sourceUrl: string
): DocumentRecord[] {
  const accept = buildFathSkuMatcher(catalogNumber);
  if (!accept) return [];

  // Pass 1: collect every "<prefix>_p_<view>.<ext>" candidate from the detail page (only).
  // Search-page fallback handles the no-detail case further down.
  const candidates = collectFathImageCandidates(detailText);

  // Pass 2: try strict matching first (image SKU prefix equals or is a known variant of ours).
  const strict = candidates.filter((candidate) => accept.score(candidate.compactPrefix) >= 0);

  // Pass 3: if strict yields nothing, fall back to the page's *main* product image group.
  // FATH reuses a single image set across an entire variant family — e.g. "6SBEU04I.264_p_*.jpg"
  // covers the IE/FR/GB/Eco variants too — so when our strict matcher rejects them all we trust
  // the page itself: pick the prefix that has the most "_p_<view>" companions, since the main
  // product always carries the full 3d+2d+app+co set while related-products cards have just one.
  const chosen = strict.length > 0 ? strict : pickFathMainProductImages(candidates);
  if (chosen.length === 0) {
    // Last-ditch search-page lookup so we still produce an image-only result when the detail
    // page is unavailable.
    return [...collectFathImageCandidates(searchText)]
      .filter((candidate) => accept.score(candidate.compactPrefix) >= 0)
      .sort((left, right) => viewOrderRank(left.url) - viewOrderRank(right.url))
      .slice(0, 1)
      .map((candidate) => ({
        type: "image",
        label: `FATH product image ${candidate.fileName}`,
        url: candidate.url,
        sourceUrl
      }));
  }

  chosen.sort((left, right) => {
    const scoreDelta = accept.score(right.compactPrefix) - accept.score(left.compactPrefix);
    if (scoreDelta !== 0) return scoreDelta;
    return viewOrderRank(left.url) - viewOrderRank(right.url);
  });
  return chosen.slice(0, 1).map((candidate) => ({
    type: "image",
    label: `FATH product image ${candidate.fileName}`,
    url: candidate.url,
    sourceUrl
  }));
}

interface FathImageCandidate {
  url: string;
  fileName: string;
  prefix: string;
  compactPrefix: string;
}

function collectFathImageCandidates(text: string): FathImageCandidate[] {
  const seen = new Set<string>();
  const candidates: FathImageCandidate[] = [];
  for (const match of text.matchAll(/https?:\/\/(?:www\.)?fath24\.com\/media\/[^\s)"'<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s)"'<>]*)?/gi)) {
    const url = match[0].replace(/[),.;]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    if (/\/(?:fath-logo|colorcode-popup|404|navi|icon|spinner|placeholder|teaser)/i.test(url)) continue;
    const fileName = url.split("/").pop()?.split("?")[0]?.toLowerCase() ?? "";
    const prefixMatch = fileName.match(/^(.+?)_p_(?:3d|2d|app|co|3D|2D|APP|CO)\b/i);
    if (!prefixMatch) continue;
    const prefix = prefixMatch[1];
    candidates.push({ url, fileName, prefix, compactPrefix: compactCatalogNumber(prefix) });
  }
  return candidates;
}

/**
 * Picks the prefix group that most likely represents this page's main product. FATH lists the
 * primary product first with its full 3d/2d/app/co set, so the prefix with the most companions
 * wins; ties are broken by first-appearance order (i.e. the prefix the page renders first).
 */
function pickFathMainProductImages(candidates: FathImageCandidate[]): FathImageCandidate[] {
  if (candidates.length === 0) return [];
  const order: string[] = [];
  const groups = new Map<string, FathImageCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.compactPrefix;
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.push(candidate);
    } else {
      groups.set(key, [candidate]);
      order.push(key);
    }
  }
  if (order.length === 0) return [];
  // Sort prefixes by member count desc, then by first-seen position (preserve order tiebreaker).
  const ranked = order
    .map((key, index) => ({ key, count: groups.get(key)?.length ?? 0, index }))
    .sort((left, right) => right.count - left.count || left.index - right.index);
  return groups.get(ranked[0].key) ?? [];
}

function viewOrderRank(url: string): number {
  const lower = url.toLowerCase();
  if (lower.includes("_p_3d")) return 0;
  if (lower.includes("_p_app")) return 1;
  if (lower.includes("_p_2d")) return 2;
  if (lower.includes("_p_co")) return 3;
  return 99;
}

interface FathSkuMatcher {
  /** Returns a score (higher = better match) or -1 if the image SKU is unrelated. */
  score(imageSkuCompact: string): number;
}

/**
 * Builds a matcher describing which image filename SKU prefixes legitimately belong to the
 * requested catalog number. FATH conventions:
 *   - Each product page has images named "<sku>_p_<view>.<ext>" where <sku> is the catalog
 *     number with separators (dots, dashes) stripped to lowercase.
 *   - Length variants like "6SACP3J316B.2000" and "6SACP3J316B.4000" share the same image set
 *     (named after the canonical variant, e.g. "6sacp3j316b.2000"). When asked about ".4000"
 *     we therefore also accept ".2000" family images.
 *   - But suffix-letter variants like "6SACP3J316BS01" are *different products* with their own
 *     images, so we don't accept those when asked about the plain SKU.
 */
function buildFathSkuMatcher(catalogNumber: string): FathSkuMatcher | undefined {
  const full = compactCatalogNumber(catalogNumber);
  if (!full) return undefined;
  const beforeSeparator = catalogNumber.split(/[.\-]/)[0];
  const base = beforeSeparator ? compactCatalogNumber(beforeSeparator) : "";
  const hasNumericVariant = base.length >= 4 && base !== full && /^\d+$/.test(full.slice(base.length));
  return {
    score(imageSkuCompact: string): number {
      if (!imageSkuCompact) return -1;
      if (imageSkuCompact === full) return 100;
      // When the requested SKU has a numeric length suffix (e.g. ".4000"), accept sibling
      // length variants of the same base — FATH only stores one image set per family.
      if (hasNumericVariant && imageSkuCompact.startsWith(base)) {
        const suffix = imageSkuCompact.slice(base.length);
        if (/^\d+$/.test(suffix)) return 60;
      }
      // Exact base-only image (no suffix in filename) — accept as family fallback.
      if (hasNumericVariant && imageSkuCompact === base) return 70;
      return -1;
    }
  };
}

function collectFathDocuments(text: string, sourceUrl: string): DocumentRecord[] {
  const out: DocumentRecord[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+\.(?:pdf|zip|dwg|dxf|stp|step))[^)]*\)/gi)) {
    const label = cleanText(match[1]);
    const url = match[2];
    if (seen.has(url)) continue;
    seen.add(url);
    // FATH's footer links to its legal docs (Terms of Delivery, Purchasing Conditions, RoHS).
    // Those are not product documents and would otherwise show up on every result.
    if (/general[\s_-]*(?:terms|purchasing|conditions)|terms[\s_-]*of[\s_-]*delivery|purchasing[\s_-]*conditions|privacy|imprint|impressum|agb/i.test(`${label} ${url}`)) {
      continue;
    }
    const type: DocumentRecord["type"] = /\.(?:pdf)$/i.test(url)
      ? /datasheet|data\s*sheet/i.test(label) ? "datasheet" : "other"
      : "cad";
    out.push({ type, label: label || "FATH document", url, sourceUrl });
  }
  return out.slice(0, 10);
}

function extractFathAttributes(text: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  // FATH's Shopware product page renders specs as a markdown table or as "Label: Value" pairs.
  // We pick up both shapes from the Jina markdown reader output.
  const lines = text.split(/\r?\n/);
  let group = "FATH specifications";
  let inVariantsTable = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const heading = line.match(/^#+\s*(.+)$/);
    if (heading) {
      group = cleanText(heading[1]);
      inVariantsTable = /^variants?$/i.test(group);
      continue;
    }
    if (inVariantsTable) continue;
    // Skip the prefixed "Title:" / "Description:" / "Markdown content:" headers Jina inserts.
    if (/^(?:title|description|markdown\s+content|url\s+source):/i.test(line)) continue;
    const pipe = line.match(/^\|?\s*([^|]{2,80})\s*\|\s*(.+?)\s*\|?$/);
    if (pipe && !/^[-:|\s]+$/.test(pipe[2])) {
      const name = cleanText(pipe[1]).replace(/:+$/, "");
      const value = cleanText(pipe[2]);
      if (isUsableFathSpec(name, value)) attributes.push({ group, name, value, sourceUrl });
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9 /().,-]{1,70}):+\s+(.+)$/);
    if (pair) {
      const name = cleanText(pair[1]).replace(/:+$/, "");
      const value = cleanText(pair[2]);
      if (isUsableFathSpec(name, value)) attributes.push({ group, name, value, sourceUrl });
    }
  }
  return attributes.slice(0, 60);
}

function isUsableFathSpec(name: string, value: string): boolean {
  if (!name || !value) return false;
  if (/^(?:url|image|images?|title|description|breadcrumb|search|home|product quantity|part\s*#?|part\s+number)$/i.test(name)) return false;
  // Names that are markdown links (e.g. "[098ABG045](https://...)") come from the Variants table
  // — they describe sibling products, not this one's specs.
  if (/^\[.*\]\(.+\)$/.test(name)) return false;
  if (value.length > 240) return false;
  if (/^https?:\/\//i.test(value)) return false;
  return true;
}

/**
 * FATH repeats the ECLASS code across versions 6.0–16.0 as separate rows. Collapse them into a
 * single attribute that shows the latest version + value so the export stays readable.
 */
function collapseFathEclassRows(attributes: AttributeRecord[]): AttributeRecord[] {
  const out: AttributeRecord[] = [];
  let latestEclass: { version: number; attribute: AttributeRecord } | undefined;
  for (const attr of attributes) {
    const match = attr.name.match(/^\(ECLASS\s+(\d+(?:\.\d+)?)\)$/i);
    if (match) {
      const version = Number.parseFloat(match[1]);
      if (!latestEclass || version > latestEclass.version) latestEclass = { version, attribute: attr };
      continue;
    }
    out.push(attr);
  }
  if (latestEclass) {
    out.push({ ...latestEclass.attribute, name: `ECLASS ${latestEclass.version}` });
  }
  return out;
}

function withDiagnostics(result: ProductResult, attemptedUrls: string[], notes: string[]): ProductResult {
  if (attemptedUrls.length === 0 && notes.length === 0) return result;
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      attemptedUrls: [...(result.diagnostics?.attemptedUrls ?? []), ...attemptedUrls].slice(0, 40),
      notes: [...(result.diagnostics?.notes ?? []), ...notes].slice(0, 40)
    }
  };
}
