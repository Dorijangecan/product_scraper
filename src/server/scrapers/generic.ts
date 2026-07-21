import { sameUrlIgnoringHash as sameUrl } from "../url-util.js";
import { uniqueStrings as uniqueStringsBase } from "../text-util.js";
import * as cheerio from "cheerio";
import type {
  AttributeRecord,
  DocumentRecord,
  ExtractionPolicyConfig,
  FallbackSourceConfig,
  LocalizedUrlTemplate,
  ManufacturerConfig,
  MarkerExtractionRule,
  MatchPolicyConfig,
  ProductResult,
  ScrapeDiagnostics,
  SourceRecord
} from "../../shared/types.js";
import type { CachedHttpClient, FetchedText } from "./http-client.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { catalogTextMatches, compactCatalogNumber, fillCatalogTemplate } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { extractMarkerData } from "./marker-extractor.js";
import { discoverProductLinksWithDiagnostics, type ProductLinkDiscoveryResult } from "./link-discovery.js";
import { documentUrlLooksDownloadable, documentUrlLooksRelevant } from "./document-url.js";
import { listFieldRegistryDocumentLabels } from "./field-registry.js";
import { extractElectricalSpecAttributesFromText, extractOntologySpecAttributesFromText } from "./electrical-spec-miner.js";

const GENERIC_PARSER_VERSION = "generic-v3";

const PLAIN_TEXT_METADATA_LABELS = [
  "Product type",
  "Product family",
  "Product line",
  "Type",
  "GTIN",
  "Country of origin",
  "Customs tariff number",
  "Item number",
  "Packing unit",
  "Minimum order quantity",
  "Sales key",
  "Product key",
  "Connection method",
  "Mounting",
  "Mounting type",
  "Pitch",
  "Number of positions",
  "Number of rows",
  "Number of connections",
  "Contact surface",
  "Plug-in system",
  "Type of packaging"
];
const PLAIN_TEXT_INLINE_LABELS = uniqueStrings([...listFieldRegistryDocumentLabels(), ...PLAIN_TEXT_METADATA_LABELS])
  .filter((label) => label.length >= 2)
  .sort((left, right) => right.length - left.length || left.localeCompare(right));

interface GenericParseOptions {
  match?: MatchPolicyConfig;
  localizedUrlTemplates?: LocalizedUrlTemplate[];
  confidence?: number;
  markerRules?: MarkerExtractionRule[];
  extractionPolicy?: ExtractionPolicyConfig;
}

export class GenericFallbackScraper {
  constructor(
    private readonly manufacturerId: ProductResult["manufacturerId"],
    private readonly http: CachedHttpClient,
    private readonly manufacturer?: ManufacturerConfig
  ) {}

  async scrape(catalogNumber: string, sources: FallbackSourceConfig[], signal?: AbortSignal): Promise<ProductResult | undefined> {
    let bestPartial: ProductResult | undefined;
    for (const source of sources.filter((item) => item.enabled && this.sourceAllowedByPolicy(item)).sort(compareFallbackSources)) {
      for (const template of source.directUrlTemplates) {
        throwIfCancelled(signal);
        const url = fillCatalogTemplate(template, catalogNumber);
        const match = { ...this.manufacturer?.match, ...source.match };
        try {
          const fetched = await this.fetchTextWithFallback(url, source, signal);
          if (isUnresolvedSiemensReaderPage(this.manufacturerId, catalogNumber, fetched)) continue;
          if ((match.requireCatalogNumber ?? true) && !catalogTextMatches(fetched.text, catalogNumber, match)) continue;
          const parsed = parseGenericProductPage(this.manufacturerId, catalogNumber, fetched, source.sourceType, source.label, {
            match,
            localizedUrlTemplates: this.manufacturer?.localizedUrlTemplates,
            confidence: source.confidence,
            markerRules: [...(this.manufacturer?.markerRules ?? []), ...(source.markerRules ?? [])],
            extractionPolicy: this.manufacturer?.scrapeRecipe?.extractionPolicy
          });
          const discovery = discoverProductLinksWithDiagnostics(fetched.text, fetched.effectiveUrl, catalogNumber);
          let detailResolved = false;
          for (const candidate of discovery.candidates.slice(0, 4)) {
            if (sameUrl(candidate.url, fetched.effectiveUrl)) continue;
            try {
              const detail = await this.fetchTextWithFallback(candidate.url, source, signal);
              if (catalogTextMatches(detail.text, catalogNumber, match)) {
                const detailParsed = parseGenericProductPage(this.manufacturerId, catalogNumber, detail, source.sourceType, source.label, {
                  match,
                  localizedUrlTemplates: this.manufacturer?.localizedUrlTemplates,
                  confidence: source.confidence,
                  markerRules: [...(this.manufacturer?.markerRules ?? []), ...(source.markerRules ?? [])],
                  extractionPolicy: this.manufacturer?.scrapeRecipe?.extractionPolicy
                });
                detailResolved = !isUnresolvedSearchResultPage(detail.effectiveUrl, detailParsed.title, false);
                if (detailResolved && detailParsed.status !== "failed") {
                  const merged = withLinkDiagnostics(mergeResults(detailParsed, parsed), discovery);
                  if (isStrongGenericResult(merged)) return merged;
                  bestPartial = pickBetterResult(bestPartial, merged);
                }
              }
            } catch (error) {
              if (isCancellationError(error, signal)) throw error;
              // Keep trying the next search/detail candidate.
            }
          }
          if (isUnresolvedSearchResultPage(fetched.effectiveUrl, parsed.title, detailResolved)) continue;
          if (parsed.status !== "failed") {
            const parsedWithDiagnostics = withLinkDiagnostics(parsed, discovery);
            if (isStrongGenericResult(parsedWithDiagnostics)) return parsedWithDiagnostics;
            bestPartial = pickBetterResult(bestPartial, parsedWithDiagnostics);
          }
        } catch (error) {
          if (isCancellationError(error, signal)) throw error;
          continue;
        }
      }
    }
    return bestPartial;
  }

  private sourceAllowedByPolicy(source: FallbackSourceConfig): boolean {
    if (source.sourceType !== "distributor") return true;
    return this.manufacturer?.scrapeRecipe?.fallbackPolicy?.distributorFallback !== false;
  }

  private async fetchTextWithFallback(url: string, source: FallbackSourceConfig, signal?: AbortSignal): Promise<FetchedText> {
    const policy = { ...this.manufacturer?.fetchPolicy, ...source.fetchPolicy };
    const headers = fetchHeaders(policy);
    try {
      const fetched = await this.http.fetchText(url, {
        timeoutMs: policy.timeoutMs ?? 15000,
        cacheTtlMs: policy.cacheTtlMs,
        maxAttempts: policy.maxAttempts,
        retryBackoffMs: policy.retryBackoffMs,
        headers,
        signal
      });
      if (hasEnoughContent(fetched, policy)) return fetched;
    } catch (error) {
      if (isCancellationError(error, signal)) throw error;
      // Fall through to alternate user agents and PowerShell.
    }

    for (const userAgent of policy.fallbackUserAgents ?? []) {
      try {
        const fetched = await this.http.fetchText(url, {
          timeoutMs: policy.timeoutMs ?? 15000,
          cacheTtlMs: policy.cacheTtlMs,
          maxAttempts: policy.maxAttempts,
          retryBackoffMs: policy.retryBackoffMs,
          headers: fetchHeaders({ ...policy, userAgent }),
          signal
        });
        if (hasEnoughContent(fetched, policy)) return fetched;
      } catch (error) {
        if (isCancellationError(error, signal)) throw error;
        // Try the next fetch path.
      }
    }

    return this.http.fetchTextViaPowerShell(url, {
        timeoutMs: policy.timeoutMs ? Math.max(policy.timeoutMs, 30000) : 30000,
        cacheTtlMs: policy.cacheTtlMs,
        headers,
        signal
      });
  }
}

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Cancelled by user.");
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && /cancelled by user/i.test(error.message));
}

function isUnresolvedSiemensReaderPage(
  manufacturerId: ProductResult["manufacturerId"],
  catalogNumber: string,
  fetched: FetchedText
): boolean {
  if (manufacturerId !== "siemens" || !/r\.jina\.ai/i.test(`${fetched.requestedUrl} ${fetched.effectiveUrl}`)) return false;
  // Siemens's reader representation can return its generic search or shell page with unrelated
  // results. A catalog number merely appearing in the URL is not product evidence; accept it
  // only when the rendered markdown has an actual product heading for the requested article.
  const escapedCatalog = catalogNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return !new RegExp(`^#\\s+[^\\n]*${escapedCatalog}`, "im").test(fetched.text);
}

function withLinkDiagnostics(result: ProductResult, discovery: ProductLinkDiscoveryResult): ProductResult {
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      rejectedLinks: [
        ...(result.diagnostics?.rejectedLinks ?? []),
        ...discovery.rejected.map((candidate) => ({
          url: candidate.url,
          score: candidate.score,
          reason: candidate.reason
        }))
      ].slice(0, 30)
    }
  };
}

function compareFallbackSources(left: FallbackSourceConfig, right: FallbackSourceConfig): number {
  return sourceRank(left) - sourceRank(right);
}

function sourceRank(source: FallbackSourceConfig): number {
  return source.sourceType === "official-fallback" ? 0 : 10;
}

function isStrongGenericResult(result: ProductResult): boolean {
  if (result.status === "failed") return false;
  if (isSuspiciousResultUrl(result.productUrl)) return false;
  const imageCount = result.documents.filter((doc) => doc.type === "image").length;
  const nonImageDocCount = result.documents.length - imageCount;
  if (result.attributes.length >= 3 && (result.documents.length > 0 || result.title)) return true;
  if (result.attributes.length >= 2 && imageCount > 0) return true;
  if (result.attributes.length >= 1 && nonImageDocCount > 0 && imageCount > 0) return true;
  return false;
}

function pickBetterResult(current: ProductResult | undefined, candidate: ProductResult): ProductResult {
  if (!current) return candidate;
  return resultEvidenceScore(candidate) > resultEvidenceScore(current) ? candidate : current;
}

function resultEvidenceScore(result: ProductResult): number {
  let score = result.confidence * 100;
  score += Math.min(result.attributes.length, 20) * 4;
  score += Math.min(result.documents.length, 10) * 6;
  if (result.documents.some((doc) => doc.type === "image")) score += 18;
  if (result.sources.some((source) => source.sourceType === "official" || source.sourceType === "official-fallback")) score += 15;
  if (result.title) score += 8;
  if (isSuspiciousResultUrl(result.productUrl)) score -= 40;
  return score;
}

function isSuspiciousResultUrl(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const full = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase();
    if (/\/search(?:\/|$)|[?&](?:q|query|search|term)=/i.test(full)) return true;
    if (/partcommunity|3d-cad-models|\/cad(?:\/|$)|\/download(?:\/|$)|\/documents?(?:\/|$)/i.test(full)) return true;
    if (/\.(?:pdf|zip|dwg|dxf|stp|step|png|jpe?g|webp)(?:[?#]|$)/i.test(full)) return true;
    return false;
  } catch {
    return /\b(?:search|query)=|\/search\/|partcommunity|3d-cad-models|\.(?:pdf|zip|dwg|dxf|stp|step|png|jpe?g|webp)\b/i.test(url);
  }
}

export function isUnresolvedSearchResultPage(url: string, title: string | undefined, detailResolved: boolean): boolean {
  if (detailResolved) return false;
  const normalizedTitle = cleanText(title).toLowerCase();
  if (/\b(search results?|søkeresultater|sokeresultater|suchergebnisse|résultats de recherche)\b/i.test(normalizedTitle)) return true;
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.replace(/^www\./, "").toLowerCase() === "abb-control-products.partcommunity.com" &&
      /\/3d-cad-models(?:\/|$)/i.test(parsed.pathname) &&
      parsed.searchParams.has("part")
    ) {
      return true;
    }
    return /\/search(?:\/|$)/i.test(parsed.pathname) || [...parsed.searchParams.keys()].some((key) => /^(?:s|q|query|search|term)$/i.test(key));
  } catch {
    return /\b(?:search|query)=|\/search\//i.test(url);
  }
}

export function parseGenericProductPage(
  manufacturerId: ProductResult["manufacturerId"],
  catalogNumber: string,
  fetched: FetchedText,
  sourceType: SourceRecord["sourceType"],
  parserLabel = "generic",
  options: GenericParseOptions = {}
): ProductResult {
  const $ = cheerio.load(fetched.text);
  const title = cleanProductTitle($);
  if (isBlockedOrErrorPage(fetched, title)) {
    return emptyResult(manufacturerId, catalogNumber, `Official page could not be parsed: HTTP ${fetched.statusCode}${title ? ` (${title})` : ""}.`);
  }
  const description = cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content"));
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const documentCandidates: NonNullable<ScrapeDiagnostics["documentCandidates"]> = [];
  attributes.push(...extractCatalogIdentityAttributes($, catalogNumber, fetched.effectiveUrl));
  const jsonLdProducts = readJsonLdProducts($, catalogNumber);
  for (const product of jsonLdProducts) {
    for (const [name, value] of Object.entries(product)) {
      if (value === undefined || value === null || typeof value === "object") continue;
      attributes.push({
        group: "Structured Data",
        name,
        value: cleanText(String(value)),
        sourceUrl: fetched.effectiveUrl
      });
    }
    attributes.push(...attributesFromJsonLdProduct(product, fetched.effectiveUrl));
  }
  documents.push(...extractImageDocuments($, catalogNumber, fetched.effectiveUrl, jsonLdProducts, options.extractionPolicy));
  documents.push(...documentsFromJsonLdProducts(jsonLdProducts, fetched.effectiveUrl));

  for (const product of readEmbeddedProductData($)) {
    for (const [name, value] of Object.entries(product)) {
      if (value === undefined || value === null || typeof value === "object") continue;
      attributes.push({
        group: "Embedded Product Data",
        name,
        value: cleanText(String(value)),
        sourceUrl: fetched.effectiveUrl
      });
    }
  }

  const dynamicData = extractDynamicComponentData($, fetched.text, catalogNumber, fetched.effectiveUrl);
  attributes.push(...dynamicData.attributes);
  documents.push(...dynamicData.documents);

  const embeddedTableData = extractEmbeddedTableData(fetched.text, catalogNumber, fetched.effectiveUrl, options.extractionPolicy);
  attributes.push(...embeddedTableData.attributes);
  documents.push(...embeddedTableData.documents);

  const embeddedPropertyData = extractEmbeddedPropertyData(fetched.text, fetched.effectiveUrl);
  attributes.push(...embeddedPropertyData.attributes);
  documents.push(...embeddedPropertyData.documents);

  $("[data-row-data]").each((_, element) => {
    for (const attr of parseDataRowAttributes($(element).attr("data-row-data"), fetched.effectiveUrl, catalogNumber)) {
      attributes.push(attr);
    }
  });

  $("meta").each((_, element) => {
    const name = $(element).attr("name") || $(element).attr("property");
    const value = $(element).attr("content");
    if (!name || !value) return;
    if (/image:(?:alt|width|height|secure_url|type)$/i.test(name)) return;
    if (/description|brand|manufacturer|image|product|og:/i.test(name)) {
      attributes.push({
        group: "Meta",
        name,
        value: cleanText(value),
        sourceUrl: fetched.effectiveUrl
      });
    }
  });
  attributes.push(...extractCertificationAttributes($, fetched.effectiveUrl));
  attributes.push(...extractProductSectionAttributes($, fetched.effectiveUrl));
  attributes.push(...extractLabeledSpecAttributes($, fetched.effectiveUrl));
  attributes.push(...extractSemanticSpecAttributes($, fetched.effectiveUrl));
  attributes.push(...extractSchemaPropertyValueAttributes($, fetched.effectiveUrl));
  attributes.push(...extractSectionAwareSpecAttributes($, fetched.effectiveUrl));
  attributes.push(...extractHeadingValueSpecAttributes($, fetched.effectiveUrl));
  attributes.push(...extractPageWideSpecAttributes($, catalogNumber, fetched.effectiveUrl));
  attributes.push(...extractSummaryAttributes(title, description, fetched.effectiveUrl));

  $("tr").each((_, element) => {
    const cells = $(element)
      .find("th,td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);
    if (cells.length && cells.every((cell) => /^header\s+\d+$/i.test(cell))) return;
    if (cells.length >= 2) {
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const cell of cells.slice(1)) {
        const trimmed = cleanText(cell);
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(trimmed);
      }
      attributes.push({
        group: "Table",
        name: cells[0],
        value: unique.join(" | "),
        sourceUrl: fetched.effectiveUrl
      });
    }
  });

  $("dt").each((_, element) => {
    const name = cleanText($(element).text());
    const value = cleanText($(element).next("dd").text());
    if (name && value) {
      attributes.push({ group: "Definition List", name, value, sourceUrl: fetched.effectiveUrl });
    }
  });

  $("li,p").slice(0, 600).each((_, element) => {
    const pair = splitNameValue($(element).text());
    if (pair) {
      attributes.push({ group: "Text", ...pair, sourceUrl: fetched.effectiveUrl });
      return;
    }
    const text = cleanText($(element).text());
    const certContext = cleanText(
      [
        $(element).attr("class"),
        $(element).attr("id"),
        $(element).parent().attr("class"),
        $(element).parent().attr("id"),
        $(element).parents("[class*='cert'],[id*='cert']").first().attr("class"),
        $(element).parents("[class*='cert'],[id*='cert']").first().attr("id")
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (text && text.length <= 120 && /cert/i.test(certContext)) {
      attributes.push({ group: "Certifications", name: "Certification", value: text, sourceUrl: fetched.effectiveUrl });
    }
  });

  attributes.push(...extractPlainTextAttributes(fetched.text, fetched.effectiveUrl));
  attributes.push(...extractKnownPlainTextSpecAttributes(fetched.text, fetched.effectiveUrl));
  attributes.push(...extractElectricalSpecAttributesFromText({
    text: fetched.text,
    sourceUrl: fetched.effectiveUrl,
    group: "Electrical Text"
  }));
  attributes.push(...extractOntologySpecAttributesFromText({
    text: fetched.text,
    sourceUrl: fetched.effectiveUrl,
    group: "Ontology Spec Text"
  }));
  documents.push(...extractPlainTextDocumentLinks(fetched.text, fetched.effectiveUrl, catalogNumber, options));
  documents.push(...extractHiddenDocumentLinks($, fetched.text, fetched.effectiveUrl, catalogNumber, options));

  const markerData = extractMarkerData(fetched.text, options.markerRules, fetched.effectiveUrl);
  attributes.push(...markerData.attributes);
  documents.push(...markerData.documents);

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const absolute = toAbsoluteUrl(href, fetched.effectiveUrl);
    if (!absolute) {
      documentCandidates.push({ url: href, status: "rejected", reason: "Invalid or non-HTTP document URL.", sourceUrl: fetched.effectiveUrl });
      return;
    }
    const policyDocumentMatch = matchesAnyPattern(absolute, options.extractionPolicy?.documentUrlPatterns);
    const rowContext = documentContextForAnchor($, element);
    const label = cleanText($(element).text() || $(element).attr("aria-label") || $(element).attr("title")) || documentLabelFromContext(rowContext, absolute);
    const labelType = classifyDocument(label, absolute);
    const type = labelType === "other" ? classifyDocument(`${label} ${rowContext}`, absolute) : labelType;
    if (matchesAnyPattern(absolute, options.extractionPolicy?.ignoredDocumentUrlPatterns)) {
      documentCandidates.push({ url: absolute, label, type, status: "rejected", reason: "Matched ignored document URL pattern.", sourceUrl: fetched.effectiveUrl });
      return;
    }
    if (!isDocumentUrlWithContext(absolute, `${label} ${rowContext}`, type) && !policyDocumentMatch) {
      documentCandidates.push({ url: absolute, label, type, status: "rejected", reason: "Link did not look like a product document.", sourceUrl: fetched.effectiveUrl });
      return;
    }
    if (isUnrelatedPolicyDocument(label, rowContext, absolute, catalogNumber, options)) {
      documentCandidates.push({ url: absolute, label, type, status: "rejected", reason: "Rejected unrelated policy/legal document.", sourceUrl: fetched.effectiveUrl });
      return;
    }
    if (
      type === "other" &&
      !policyDocumentMatch &&
      !catalogTextMatches(absolute, catalogNumber, options.match) &&
      !catalogTextMatches(rowContext, catalogNumber, options.match)
    ) {
      documentCandidates.push({ url: absolute, label, type, status: "rejected", reason: "Generic document link did not match catalog identity.", sourceUrl: fetched.effectiveUrl });
      return;
    }
    documentCandidates.push({ url: absolute, label, type, status: "accepted", reason: policyDocumentMatch ? "Matched configured document URL pattern." : "Recognized product document link.", sourceUrl: fetched.effectiveUrl });
    documents.push({
      type,
      label,
      url: absolute,
      sourceUrl: fetched.effectiveUrl
    });
  });

  const matched = catalogTextMatches(fetched.text, catalogNumber, options.match);
  if ((options.match?.requireCatalogNumber ?? true) && !matched) {
    return emptyResult(manufacturerId, catalogNumber, "Fallback page did not contain the catalog number.");
  }

  const cleanAttributes = applyExtractionPolicyToAttributes(dedupeAttributes(attributes), options.extractionPolicy).slice(
    0,
    options.extractionPolicy?.maxRawAttributes ?? 600
  ).map((attr) => ({
    ...attr,
    sourceType: attr.sourceType ?? sourceType,
    parser: attr.parser ?? parserLabel,
    stage: attr.stage ?? parserLabel,
    confidence: attr.confidence ?? confidenceForSource(sourceType, options.confidence)
  }));
  const cleanDocuments = dedupeDocuments(documents).slice(0, options.extractionPolicy?.maxDocuments ?? 120).map((doc) => ({
    ...doc,
    sourceType: doc.sourceType ?? sourceType,
    parser: doc.parser ?? parserLabel,
    stage: doc.stage ?? parserLabel,
    confidence: doc.confidence ?? confidenceForSource(sourceType, options.confidence)
  }));
  const normalized = normalizeFields(cleanAttributes, cleanDocuments);
  const confidence = options.confidence ?? 0.55;
  return {
    manufacturerId,
    catalogNumber,
    status: cleanAttributes.length || cleanDocuments.length ? "partial" : "failed",
    confidence: cleanAttributes.length || cleanDocuments.length ? confidence : 0,
    productUrl: fetched.effectiveUrl,
    localizedUrls: buildLocalizedProductUrls(manufacturerId, catalogNumber, fetched.effectiveUrl, options.localizedUrlTemplates),
    title,
    description,
    normalized,
    attributes: cleanAttributes,
    documents: cleanDocuments,
    diagnostics: documentCandidates.length
      ? {
          documentCandidates: documentCandidates.slice(0, 120)
        }
      : undefined,
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType,
        parser: parserLabel,
        parserVersion: GENERIC_PARSER_VERSION,
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      }
    ],
    error: cleanAttributes.length || cleanDocuments.length ? undefined : "No structured fallback data found."
  };
}

function cleanProductTitle($: cheerio.CheerioAPI): string {
  const h1 = $("h1").first().clone();
  h1.find("script,style,noscript,[aria-hidden='true'],.visually-hidden,.sr-only").remove();
  return cleanText(h1.text() || $("title").first().text())
    .replace(/\s+The Quick Ship feature is designed to streamline[\s\S]*$/i, "")
    .replace(/\s+\|.+$/, "");
}

function isBlockedOrErrorPage(fetched: FetchedText, title: string): boolean {
  if (fetched.statusCode >= 400) return true;
  const compactTitle = cleanText(title).toLowerCase();
  if (/^(just a moment|access denied|attention required|forbidden|not found|are you a robot|verify you are human)$/i.test(compactTitle)) return true;
  // Bot-wall / anti-automation challenge markers. Returning true here makes the generic parser
  // emit an empty result, so the quality gate fails and the pipeline escalates to the browser
  // renderer instead of mistaking the challenge HTML for product data.
  if (/cf-browser-verification|challenge-platform|cf-challenge|cdn-cgi\/challenge-platform/i.test(fetched.text)) return true;
  const challengeText = cleanText(fetched.text).slice(0, 4000).toLowerCase();
  return /\b(?:verify you are human|are you a robot|enable javascript (?:and cookies )?to continue|please complete the (?:security|captcha) check|request (?:was )?blocked|unusual traffic from your|access to this page has been denied|px-captcha|hcaptcha|g-recaptcha)\b/i.test(challengeText);
}

function extractCatalogIdentityAttributes($: cheerio.CheerioAPI, catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const bodyText = cleanText($("body").text());
  const attributes: AttributeRecord[] = [];
  for (const match of bodyText.matchAll(/\b(?:Catalog#|Catalog Number|Part Number|SKU|MPN)\s*:?\s*([A-Z0-9][A-Z0-9._:\/-]{2,})/gi)) {
    const value = cleanText(match[1]);
    if (!catalogTextMatches(value, catalogNumber, { compact: true, ignoreCase: true, afterColon: true })) continue;
    attributes.push({ group: "Identity", name: "Catalog Number", value, sourceUrl });
  }
  return dedupeAttributes(attributes).slice(0, 3);
}

function confidenceForSource(sourceType: SourceRecord["sourceType"], configured: number | undefined): number {
  const fallback = sourceType === "distributor" ? 0.45 : sourceType === "official" || sourceType === "official-fallback" ? 0.68 : 0.55;
  return Math.min(configured ?? fallback, sourceType === "distributor" ? 0.45 : 0.95);
}

function extractImageDocuments(
  $: cheerio.CheerioAPI,
  catalogNumber: string,
  sourceUrl: string,
  jsonLdProducts: Record<string, unknown>[],
  extractionPolicy?: ExtractionPolicyConfig
): DocumentRecord[] {
  const structuredDocuments: DocumentRecord[] = [];
  const metaDocuments: DocumentRecord[] = [];
  const domDocuments: DocumentRecord[] = [];
  for (const product of jsonLdProducts) {
    for (const imageUrl of imageUrlsFromStructuredValue(product.image)) {
      const absolute = toAbsoluteUrl(imageUrl, sourceUrl);
      if (
        absolute &&
        !matchesAnyPattern(absolute, extractionPolicy?.ignoredImageUrlPatterns) &&
        !isLikelySchematicImage(absolute.toLowerCase())
      ) {
        structuredDocuments.push({ type: "image", label: "Product image", url: absolute, sourceUrl });
      }
    }
  }

  $("meta").each((_, element) => {
    const name = $(element).attr("name") || $(element).attr("property");
    const content = $(element).attr("content");
    if (!name || !content || !/image/i.test(name)) return;
    if (/image:(?:alt|width|height|type)$/i.test(name)) return;
    const absolute = toAbsoluteUrl(content, sourceUrl);
    if (
      absolute &&
      isLikelyImageUrl(absolute) &&
      !matchesAnyPattern(absolute, extractionPolicy?.ignoredImageUrlPatterns) &&
      !isLikelySchematicImage(`${name} ${absolute}`.toLowerCase())
    ) {
      metaDocuments.push({ type: "image", label: cleanText(name) || "Product image", url: absolute, sourceUrl });
    }
  });

  const partKey = compactKey(catalogNumber);
  $("img[src],img[data-src],img[data-lazy-src],img[srcset]").each((_, element) => {
    const rawUrl =
      $(element).attr("src") ||
      $(element).attr("data-src") ||
      $(element).attr("data-lazy-src") ||
      firstSrcsetUrl($(element).attr("srcset"));
    const absolute = rawUrl ? toAbsoluteUrl(rawUrl, sourceUrl) : undefined;
    if (!absolute) return;
    if (!isLikelyImageUrl(absolute)) return;
    if (matchesAnyPattern(absolute, extractionPolicy?.ignoredImageUrlPatterns)) return;
    const context = imageContextForElement($, element);
    if (!looksLikeProductImage(absolute, context, partKey)) return;
    const label = cleanText($(element).attr("alt") || $(element).attr("title") || "Product image");
    domDocuments.push({ type: "image", label, url: absolute, sourceUrl });
  });

  const usefulMetaDocuments = domDocuments.length
    ? metaDocuments.filter((doc) => isUsefulMetaImageDocument(doc, domDocuments, partKey))
    : metaDocuments;
  return dedupeDocuments([...structuredDocuments, ...usefulMetaDocuments, ...domDocuments]).slice(0, 10);
}

function imageContextForElement($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): string {
  const elementContext = [
    $(element).attr("alt"),
    $(element).attr("title"),
    $(element).attr("class"),
    $(element).attr("id")
  ];
  const ancestorContext = $(element)
    .parents()
    .slice(0, 5)
    .map((_, parent) => [$(parent).attr("class"), $(parent).attr("id")].filter(Boolean).join(" "))
    .get();
  return cleanText([...elementContext, ...ancestorContext].filter(Boolean).join(" "));
}

function isUsefulMetaImageDocument(doc: DocumentRecord, domDocuments: DocumentRecord[], compactPart: string): boolean {
  const compactUrl = compactKey(doc.url);
  if (compactPart && compactUrl.includes(compactPart)) return true;
  if (/product[_-]?and[_-]?sku|product[-_/]?image|sku[_-]?image/i.test(doc.url)) return true;
  return domDocuments.some((domDoc) => domDoc.url === doc.url || imageIdentity(domDoc.url) === imageIdentity(doc.url));
}

function imageUrlsFromStructuredValue(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => imageUrlsFromStructuredValue(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.url, record.contentUrl, record.thumbnailUrl].flatMap((item) => imageUrlsFromStructuredValue(item));
  }
  return [];
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcset
    ?.split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .find(Boolean);
}

function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /^data:/i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

// Schematics, wiring/connection diagrams, dimensional drawings and CAD previews are NOT the
// product photo the user wants. Reject them by filename/alt/path markers. Deliberately narrow:
// product TYPE words that merely sound technical ("circuit breaker", "wiring duct") must NOT match,
// so we only key off unambiguous drawing/diagram/CAD tokens.
const SCHEMATIC_IMAGE_RE =
  /\b(?:schematic|schaltbild|diagram|diagramm|dimensional|ma(?:ss|ß)zeichnung|drawing|zeichnung|blueprint|exploded|cross[-\s]?section|line\s*art|cad)\b/i;
const SCHEMATIC_FILE_RE = /\.(?:dwg|dxf|step|stp)(?:[?#]|$)/i;

export function isLikelySchematicImage(combined: string): boolean {
  return SCHEMATIC_IMAGE_RE.test(combined) || SCHEMATIC_FILE_RE.test(combined);
}

function looksLikeProductImage(url: string, context: string, compactPart: string): boolean {
  const combined = `${url} ${context}`.toLowerCase();
  if (/(logo|favicon|sprite|spinner|loader|social|flag|avatar|placeholder|spacer|transparent|bit\.gif|mobile[_-]?menu|illustration[_-]?footer|footer|faq|icon)/i.test(combined)) return false;
  if (isLikelySchematicImage(combined)) return false;
  const compactCombined = compactKey(combined);
  if (compactPart && compactCombined.includes(compactPart)) return true;
  if (/product[_-]?and[_-]?sku|product[-_/\s]?(?:gallery|image|hero)|\b(?:gallery|zoom|primary|pim)\b/i.test(combined)) return true;
  return /\b(product|sku|catalog)\b/i.test(combined) && /\b(photo|image|media|asset|large|detail)\b/i.test(combined);
}

const compactKey = compactCatalogNumber;

function isLikelyImageUrl(url: string): boolean {
  if (/\/(?:bit|spacer|transparent)\.gif(?:[?#]|$)/i.test(url)) return false;
  if (/(favicon|mobile[_-]?menu|illustration[_-]?footer|footer|logo|sprite|spinner|loader|social|placeholder|faq|icon)/i.test(url)) return false;
  return /\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#]|$)/i.test(url) || /\/is\/image\/|\/mdmfiles\/|\/images?\/|\/api\/og\?|\/opengraph-image(?:[?#]|$)/i.test(url);
}

function isDocumentUrlWithContext(url: string, context: string, type: DocumentRecord["type"]): boolean {
  return documentUrlLooksRelevant(url, context, type);
}

function isUnrelatedPolicyDocument(
  label: string,
  context: string,
  url: string,
  catalogNumber: string,
  options: GenericParseOptions
): boolean {
  const text = `${label} ${url}`;
  if (!/\b(?:terms?|conditions?|privacy|cookies?|legal|returns?|shipping|sales policy|warranty)\b|termsconditions/i.test(text)) return false;
  if (/\b(?:certificate|declaration|conformity|datasheet|data\s*sheet|manual|instruction|installation)\b/i.test(`${label} ${context}`)) return false;
  return !catalogTextMatches(label, catalogNumber, options.match) && !catalogTextMatches(url, catalogNumber, options.match);
}

function imageIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    return pathLikeBaseName(parsed.pathname)
      .replace(/\.(?:png|jpe?g|webp|gif|avif|svg)$/i, "")
      .replace(/[-_]\d{2,5}x\d{2,5}$/i, "")
      .toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function pathLikeBaseName(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1] ?? value;
}

function dimensionsFromText(text: string): string | undefined {
  const match = text.match(/\b(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)(?:\s*(mm|cm|in|inch|"))?\b/i);
  if (!match) return undefined;
  const unit = match[4] ? (match[4] === `"` ? "in" : match[4]) : "";
  return cleanText(`${[match[1], match[2], match[3]].join(" x ")} ${unit}`);
}

function extractSummaryAttributes(title: string, description: string | undefined, sourceUrl: string): AttributeRecord[] {
  const text = uniqueStringValues([title, description].map((value) => cleanText(value)).filter(Boolean)).join("; ");
  if (!text || text.length > 1200) return [];

  const attributes: AttributeRecord[] = [];
  const push = (name: string, value: string) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    attributes.push({
      group: "Title/Description Inference",
      name,
      value: cleaned,
      sourceUrl,
      sourceType: "generated",
      parser: "summary-inference",
      stage: "summary-inference",
      confidence: 0.45
    });
  };

  const dimensions = dimensionsFromText(text);
  if (dimensions) push("Dimensions", dimensions);

  const voltage = extractUniqueMatches(
    text,
    /(?<![\w.])\d+(?:[.,]\d+)?\s*(?:v?\s*(?:(?:\.{2,3}|\u2026|\u2013|\u2014|-|to)\s*\d+(?:[.,]\d+)?\s*)?v(?:\s*(?:ac|dc)|ac|dc)?(?:\s*(?:\/|-)\s*dc)?|volts?)\b/gi
  );
  if (voltage.length) push("Voltage", voltage.join("; "));

  const current = extractUniqueMatches(
    text,
    /(?<![\w.-])\d+(?:[.,]\d+)?\s*(?:(?:\.{2,3}|\u2026|\u2013|\u2014|-|to)\s*\d+(?:[.,]\d+)?\s*)?(?:kA|mA|A|amps?|amperes?)\b(?![a-z0-9-])/gi
  );
  if (current.length) push("Current", current.join("; "));

  const power = extractUniqueMatches(
    text,
    /(?<![\w.-])\d+(?:[.,]\d+)?\s*(?:W\/m|W\/ft|BTU\/hr\.?|kVA|kW|MW|VA|W|BTU)\b(?![a-z0-9-])/gi
  );
  if (power.length) push("Power", power.join("; "));

  const material = firstKnownPhrase(text, [
    "Copper Clad Aluminum",
    "Modified Polyolefin",
    "Stainless Steel",
    "Mild Steel",
    "Carbon Steel",
    "Polycarbonate",
    "Thermoplastic Elastomer",
    "Thermoplastic",
    "Polyester",
    "Polyolefin",
    "Aluminum",
    "Aluminium",
    "Fiberglass",
    "Glass Fiber",
    "Silicone",
    "Copper",
    "Brass",
    "Steel",
    "Nylon",
    "PVC",
    "PBT",
    "ABS"
  ]);
  if (material) push("Material", material);

  const finish = firstRegexPhrase(
    text,
    /\b(?:(?:black|white|gr[ae]y|red|blue|green|yellow|orange|silver|natural)\s+)?(?:ANSI[-\s]?61|RAL\s*\d{4}|powder[-\s]?coated|painted|anodized|brushed|nickel[-\s]?plated|zinc[-\s]?plated|chrome[-\s]?plated|pregalvanized|galvanized)\b[^.;,]*/i
  );
  if (finish) push("Finish", finish);

  const color = firstKnownPhrase(text, [
    "Light Gray",
    "Light Grey",
    "Traffic White",
    "Dark Gray",
    "Dark Grey",
    "Gray",
    "Grey",
    "Black",
    "White",
    "Red",
    "Blue",
    "Green",
    "Yellow",
    "Orange",
    "Silver",
    "Natural"
  ]);
  if (color) push("Color", color);

  return dedupeAttributes(attributes).slice(0, 12);
}

function extractUniqueMatches(text: string, pattern: RegExp): string[] {
  return uniqueStringValues((text.match(pattern) ?? []).map(cleanText).filter(Boolean)).slice(0, 8);
}

function firstKnownPhrase(text: string, phrases: string[]): string | undefined {
  for (const phrase of phrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) return phrase;
  }
  return undefined;
}

function firstRegexPhrase(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern)?.[0];
  return match ? cleanText(match) : undefined;
}

function readJsonLdProducts($: cheerio.CheerioAPI, catalogNumber: string): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text();
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const product of collectJsonLdProducts(parsed, catalogNumber)) {
        const key = JSON.stringify(product).slice(0, 2000);
        if (seen.has(key)) continue;
        seen.add(key);
        products.push(product);
      }
    } catch {
      // Ignore malformed script blocks.
    }
  });
  return products;
}

function collectJsonLdProducts(value: unknown, catalogNumber: string): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  const compactPart = compactCatalogNumber(catalogNumber).toLowerCase();

  const walk = (item: unknown, depth: number) => {
    if (depth > 8 || item === null || item === undefined) return;
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 200)) walk(child, depth + 1);
      return;
    }
    if (typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const variantRecords = arrayRecords(record.hasVariant);
    if (isJsonLdProductRecord(record) && jsonLdProductMatchesCatalog(record, compactPart, variantRecords.length)) {
      products.push(record);
    }
    if (variantRecords.length) {
      const matchingVariants = variantRecords.filter((variant) => jsonLdProductMatchesCatalog(variant, compactPart, variantRecords.length));
      for (const variant of matchingVariants.length ? matchingVariants : variantRecords.length === 1 ? variantRecords : []) {
        walk(variant, depth + 1);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (/^(?:breadcrumb|review|aggregateRating|offers?)$/i.test(key)) continue;
      if (key === "hasVariant") continue;
      walk(child, depth + 1);
    }
  };

  walk(value, 0);
  return products;
}

function isJsonLdProductRecord(record: Record<string, unknown>): boolean {
  const rawType = record["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  if (types.some((type) => typeof type === "string" && /^(?:Product|ProductModel|ProductGroup|IndividualProduct)$/i.test(type))) return true;
  return Boolean(record.sku || record.mpn || record.productID || record.model || record.additionalProperty || record.hasVariant);
}

function jsonLdProductMatchesCatalog(record: Record<string, unknown>, compactPart: string, siblingCount: number): boolean {
  if (!compactPart) return true;
  const identity = uniqueStrings([
    firstString(record, ["sku", "mpn", "productID", "model", "gtin", "name", "alternateName", "@id"]),
    firstNestedString(record, ["identifier"], ["value", "name", "text"])
  ].map((value) => cleanText(value)).filter((value): value is string => Boolean(value))).join(" ");
  if (!identity) return siblingCount <= 1;
  return compactCatalogNumber(identity).toLowerCase().includes(compactPart);
}

function readEmbeddedProductData($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  $("script").each((_, element) => {
    const raw = $(element).text();
    const match = raw.match(/window\.products\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) return;
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (Array.isArray(parsed)) {
        products.push(...parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))));
      }
    } catch {
      // Ignore non-JSON script assignments.
    }
  });
  return products;
}

function attributesFromJsonLdProduct(product: Record<string, unknown>, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const push = (group: string, name: string | undefined, value: string | undefined, unit?: string) => {
    const cleanName = cleanSpecPairLabel(name);
    const rawValue = cleanText(value);
    if (!rawValue) return;
    const cleanValue = cleanSpecPairValue(appendUnit(rawValue, unit), cleanName);
    if (!isUsefulSectionAwareSpecPair(cleanName, cleanValue)) return;
    attributes.push({ group, name: cleanName, value: cleanValue, sourceUrl });
  };

  for (const key of ["brand", "manufacturer"]) {
    const value = product[key];
    if (typeof value === "string" || typeof value === "number") {
      push("Structured Data", titleFromDataKey(key), String(value));
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      push("Structured Data", titleFromDataKey(key), firstString(value as Record<string, unknown>, ["name", "legalName"]));
    }
  }

  for (const property of arrayRecords(product.additionalProperty)) {
    const name = firstString(property, ["name", "propertyID", "identifier", "label"]);
    const value =
      firstString(property, ["value", "valueReference", "displayValue", "text"]) ??
      schemaValueText(property.value) ??
      firstArrayString(property, ["values", "valueList", "displayValues"]);
    const unit = firstString(property, ["unitCode", "unitText", "unit", "uom"]) ?? schemaUnitText(property.value);
    push("Structured Properties", name, value, unit);
  }

  return dedupeAttributes(attributes).slice(0, 120);
}

function documentsFromJsonLdProducts(products: Record<string, unknown>[], sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || value === undefined || documents.length > 80) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 120)) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    maybeAddDocumentFromRecord(record, sourceUrl, documents);
    for (const [key, child] of Object.entries(record)) {
      if (!/^(?:subjectOf|associatedMedia|encoding|encodings|media|documents?|downloads?|resources?|mainEntityOfPage|url|contentUrl)$/i.test(key)) continue;
      walk(child, depth + 1);
    }
  };
  for (const product of products) walk(product, 0);
  return dedupeDocuments(documents).slice(0, 60);
}

function documentContextForAnchor($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): string {
  const parentWithHeading = $(element)
    .parents()
    .filter((_, parent) => !/^(?:html|body)$/i.test(parent.tagName ?? "") && $(parent).children("h2,h3,h4").length > 0)
    .first();
  const headedContext = cleanText(parentWithHeading.text());
  if (headedContext && headedContext.length <= 260) return headedContext;

  const contextSelectors = [
    "tr",
    "li",
    ".resource",
    ".document",
    ".download",
    "[class*='resource']",
    "[class*='document']",
    "[class*='download']",
    ".ra-product-new__documentation-table"
  ].join(",");
  const nearest = cleanText($(element).closest(contextSelectors).first().text());
  if (nearest && nearest.length <= 260) return nearest;
  const parentElement = $(element).parent();
  const parent = /^(?:html|body)$/i.test(parentElement.get(0)?.tagName ?? "") ? "" : cleanText(parentElement.text());
  if (parent && parent.length <= 260) return parent;
  return nearest || parent;
}

function documentLabelFromContext(context: string, absoluteUrl: string): string {
  const cleaned = cleanText(context)
    .replace(/\b(?:download|view|open|select|file type)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned && cleaned.length <= 160) return cleaned;
  const sizedLabel = cleaned.match(/\b[A-Z0-9][A-Z0-9 _.,:;()\/+\-'–-]{4,120}\s+\d+(?:[.,]\d+)?\s*(?:KB|MB)\s+[A-Za-z, ]+\b/i)?.[0];
  if (sizedLabel) return cleanText(sizedLabel);
  return absoluteUrl.split("/").pop()?.replace(/\?.*$/, "") || "Document";
}

function extractDynamicComponentData(
  $: cheerio.CheerioAPI,
  rawText: string,
  catalogNumber: string,
  sourceUrl: string
): { attributes: AttributeRecord[]; documents: DocumentRecord[] } {
  const extracted = { attributes: [] as AttributeRecord[], documents: [] as DocumentRecord[] };
  const seenJson = new Set<string>();
  const addJson = (value: unknown, group: string) => {
    const fingerprint = (JSON.stringify(value) ?? String(value)).slice(0, 2000);
    if (seenJson.has(fingerprint)) return;
    seenJson.add(fingerprint);
    const parsed = extractProductDataFromUnknown(value, sourceUrl, group, catalogNumber);
    extracted.attributes.push(...parsed.attributes);
    extracted.documents.push(...parsed.documents);
  };

  if (/^\s*[{[]/.test(rawText.trim())) {
    try {
      addJson(JSON.parse(rawText), "Network JSON");
    } catch {
      // The generic parser also receives HTML and markdown; non-JSON text is normal.
    }
  }

  $("script[type*='json'],script#__NEXT_DATA__,script#__NUXT_DATA__,script#__ASTRO_DATA__,script#ng-state").each((_, element) => {
    if (isSystemJsonScript($, element)) return;
    if (/^application\/ld\+json$/i.test($(element).attr("type") ?? "")) return;
    const raw = $(element).text().trim();
    if (!raw) return;
    try {
      addJson(JSON.parse(raw), dynamicScriptGroup($(element).attr("id")));
    } catch {
      // Ignore malformed embedded state blocks.
    }
  });

  $("script").each((_, element) => {
    const raw = $(element).text();
    for (const jsonText of extractAssignedJsonBlocks(raw)) {
      try {
        addJson(JSON.parse(jsonText), "Embedded State");
      } catch {
        // Ignore JS snippets that look like JSON but are not valid JSON.
      }
    }
  });

  $("*").each((_, element) => {
    const attribs = (element as { attribs?: Record<string, string> }).attribs ?? {};
    for (const [name, value] of Object.entries(attribs)) {
      if (!/^data-|^wire:snapshot$/i.test(name)) continue;
      if (/^data-row-data$/i.test(name)) continue;
      const normalized = value.trim();
      if (!normalized || !/^[{[]/.test(normalized)) continue;
      try {
        addJson(JSON.parse(normalized), /^wire:snapshot$/i.test(name) ? "Livewire Snapshot" : "Data Attribute State");
      } catch {
        // Attribute state is best-effort.
      }
    }
  });

  return {
    attributes: dedupeAttributes(extracted.attributes).slice(0, 300),
    documents: dedupeDocuments(extracted.documents).slice(0, 80)
  };
}

function isSystemJsonScript($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): boolean {
  const selector = $(element).attr("data-drupal-selector");
  const id = $(element).attr("id");
  return /drupal-settings-json/i.test(`${selector ?? ""} ${id ?? ""}`);
}

function extractProductDataFromUnknown(
  value: unknown,
  sourceUrl: string,
  group: string,
  catalogNumber: string
): { attributes: AttributeRecord[]; documents: DocumentRecord[] } {
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const compactPart = compactCatalogNumber(catalogNumber).toLowerCase();

  const walk = (item: unknown, path: string[], depth: number) => {
    if (attributes.length > 350 || documents.length > 100 || depth > 8 || item === null || item === undefined) return;
    if (Array.isArray(item)) {
      for (const child of scopedDynamicArrayItems(item, catalogNumber).slice(0, 250)) walk(child, path, depth + 1);
      return;
    }
    if (typeof item !== "object") {
      const key = path.at(-1) ?? "";
      const text = cleanText(String(item));
      const parsedStringJson = parseStringifiedJson(text);
      if (parsedStringJson !== undefined) {
        walk(parsedStringJson, path, depth + 1);
        return;
      }
      if (text && !isSystemStatePath(path) && isUsefulDynamicKey(key) && isUsefulDynamicValue(text, compactPart)) {
        attributes.push({ group, name: titleFromPath(path), value: text, sourceUrl });
      }
      maybeAddDocument(text, titleFromPath(path), sourceUrl, documents);
      return;
    }

    const record = item as Record<string, unknown>;
    maybeAddDocumentFromRecord(record, sourceUrl, documents);
    if (!isSystemStatePath(path)) {
      attributes.push(...dynamicSpecMapAttributes(record, path, sourceUrl));
    }
    const pair = dynamicNameValuePair(record);
    if (pair && !isSystemStatePath(path) && isUsefulDynamicValue(pair.value, compactPart)) {
      attributes.push({ group, name: pair.name, value: pair.value, sourceUrl });
    }

    for (const [key, child] of Object.entries(record)) {
      if (key.startsWith("_") && !/next|nuxt|astro/i.test(key)) continue;
      walk(child, [...path, key], depth + 1);
    }
  };

  walk(value, [], 0);
  return {
    attributes: dedupeAttributes(attributes),
    documents: dedupeDocuments(documents)
  };
}

function scopedDynamicArrayItems(items: unknown[], catalogNumber: string): unknown[] {
  const records = items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  if (records.length < 2) return items;
  const productLikeRecords = records.filter(isDynamicProductLikeRecord);
  if (productLikeRecords.length < 2) return items;
  const matching = productLikeRecords.filter((record) => dynamicRecordMatchesCatalog(record, catalogNumber));
  return matching.length ? matching : items;
}

function isDynamicProductLikeRecord(record: Record<string, unknown>): boolean {
  return Boolean(firstString(record, DYNAMIC_PRODUCT_IDENTITY_KEYS));
}

function dynamicRecordMatchesCatalog(record: Record<string, unknown>, catalogNumber: string): boolean {
  const identity = uniqueStrings([
    firstString(record, DYNAMIC_PRODUCT_IDENTITY_KEYS),
    firstNestedString(record, ["identifier", "identity"], ["value", "name", "text", "id", "sku", "code"])
  ].map((value) => cleanText(value)).filter(Boolean)).join(" ");
  return Boolean(identity && catalogTextMatches(identity, catalogNumber, { compact: true, ignoreCase: true, afterColon: true }));
}

const DYNAMIC_PRODUCT_IDENTITY_KEYS = [
  "sku",
  "mpn",
  "catalogNumber",
  "catalogNo",
  "catalog",
  "partNumber",
  "partNo",
  "productId",
  "productID",
  "articleNumber",
  "articleNo",
  "itemNumber",
  "itemNo",
  "orderNumber",
  "model",
  "modelCode"
];

function parseStringifiedJson(value: string): unknown | undefined {
  if (!value || value.length > 120_000) return undefined;
  const variants = uniqueStrings([
    value,
    decodeHtmlForJsonSearch(value),
    decodeEscapedJsonString(value),
    decodeEscapedJsonString(decodeHtmlForJsonSearch(value))
  ])
    .map((candidate) => candidate.trim())
    .filter((candidate) => /^[{[]/.test(candidate));
  for (const candidate of variants.slice(0, 4)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Continue with decoded variants.
    }
  }
  return undefined;
}

function isSystemStatePath(path: string[]): boolean {
  return path.some((part) => /^(languages?|ajaxPageState|region_manager|back_to_top|ckeditorAccordion|permissionsHash|theme_token|pluralDelimiter)$/i.test(part));
}

function dynamicNameValuePair(record: Record<string, unknown>): { name: string; value: string } | undefined {
  const name = firstString(record, [
    "characteristicName",
    "attributeName",
    "propertyName",
    "specName",
    "attributeLabel",
    "propertyLabel",
    "specLabel",
    "label",
    "name",
    "title",
    "key",
    "displayName"
  ]);
  const value =
    dynamicValueText(record) ??
    firstNestedString(record, ["value", "displayValue", "formattedValue", "data"], ["formatted", "display", "label", "name", "text", "value"]) ??
    firstArrayString(record, ["values", "valueList", "displayValues", "options", "items"]) ??
    firstCharacteristicValue(record.characteristicValues);
  const unit = firstString(record, ["unit", "unitText", "unitOfMeasure", "uom"]);
  if (!name || !value) return undefined;
  return { name: cleanText(name), value: appendUnit(cleanText(value), unit) };
}

function dynamicSpecMapAttributes(record: Record<string, unknown>, path: string[], sourceUrl: string): AttributeRecord[] {
  if (!isSpecMapPath(path)) return [];
  if (dynamicNameValuePair(record)) return [];
  const attributes: AttributeRecord[] = [];
  const group = titleFromPath(path);
  for (const [rawName, rawValue] of Object.entries(record).slice(0, 240)) {
    if (rawName.startsWith("_") || /^(?:id|uuid|url|href|link|links|image|images|documents?|downloads?|resources?)$/i.test(rawName)) continue;
    const name = cleanSpecPairLabel(titleFromDataKey(rawName));
    const value = cleanSpecPairValue(valueTextFromUnknown(rawValue), name);
    if (!isUsefulSectionAwareSpecPair(name, value)) continue;
    attributes.push({ group, name, value, sourceUrl });
  }
  return dedupeAttributes(attributes).slice(0, 120);
}

function isSpecMapPath(path: string[]): boolean {
  const key = path.at(-1) ?? "";
  return /^(?:specs?|specifications?|technicalSpecifications?|technicalData|attributes?|properties|characteristics?|parameters?|productAttributes?|productDetails?)$/i.test(key);
}

function dynamicValueText(record: Record<string, unknown>): string | undefined {
  const minMax = minMaxValueText(record);
  if (minMax) return minMax;
  return (
    firstString(record, [
      "value",
      "labelText",
      "displayValue",
      "valueText",
      "formattedValue",
      "formatted",
      "text",
      "specValue",
      "propertyValue",
      "rawValue",
      "selectedValue"
    ]) ?? firstNestedString(record, ["selected", "option"], ["value", "label", "name", "text", "displayValue"])
  );
}

function valueTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return cleanText(String(value));
  if (Array.isArray(value)) {
    const values = value
      .slice(0, 20)
      .map((item) => valueTextFromUnknown(item))
      .filter((item): item is string => Boolean(item));
    return values.length ? uniqueStrings(values).join("; ") : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const base = dynamicValueText(record) ?? firstArrayString(record, ["values", "valueList", "displayValues", "options", "items"]);
  const unit = firstString(record, ["unit", "unitText", "unitCode", "unitOfMeasure", "uom"]);
  return base ? appendUnit(base, unit) : undefined;
}

function minMaxValueText(record: Record<string, unknown>): string | undefined {
  const min = firstString(record, ["minValue", "minimumValue", "min", "minimum"]);
  const max = firstString(record, ["maxValue", "maximumValue", "max", "maximum"]);
  if (!min && !max) return undefined;
  const unit = firstString(record, ["unitText", "unitCode", "unit", "uom", "symbol"]) ?? firstNestedString(record, ["unit", "uom"], ["symbol", "code", "name", "label", "text", "value"]);
  const suffix = unit ? ` ${cleanText(unit)}` : "";
  if (min && max) return `${cleanText(min)}...${cleanText(max)}${suffix}`;
  if (min) return `>= ${cleanText(min)}${suffix}`;
  return `<= ${cleanText(max)}${suffix}`;
}

function firstCharacteristicValue(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const text = firstString(item as Record<string, unknown>, ["labelText", "value", "text"]);
    if (text) values.push(cleanText(text));
  }
  return values.length ? values.join("; ") : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function schemaValueText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return cleanText(String(value));
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return minMaxValueText(record) ?? firstString(record, ["value", "name", "text", "displayValue", "formattedValue"]);
}

function schemaUnitText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return firstString(value as Record<string, unknown>, ["unitText", "unitCode", "unit", "uom"]);
}

function firstNestedString(record: Record<string, unknown>, keys: string[], nestedKeys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = firstString(value as Record<string, unknown>, nestedKeys);
    if (nested) return nested;
  }
  return undefined;
}

function firstArrayString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const values = value
      .slice(0, 20)
      .map((item) => {
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return cleanText(String(item));
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return firstString(item as Record<string, unknown>, ["value", "label", "name", "text", "displayValue", "formatted"]);
        }
        return "";
      })
      .filter((item): item is string => Boolean(item));
    if (values.length) return uniqueStrings(values).join("; ");
  }
  return undefined;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function maybeAddDocument(value: string, label: string, sourceUrl: string, documents: DocumentRecord[]) {
  const absolute = toAbsoluteUrl(value, sourceUrl);
  if (!absolute) return;
  if (!documentUrlLooksDownloadable(absolute) && !isLikelyImageUrl(absolute)) return;
  documents.push({
    type: classifyDocument(label, absolute),
    label: cleanText(label) || absolute.split("/").pop() || "Document",
    url: absolute,
    sourceUrl
  });
}

function maybeAddDocumentFromRecord(record: Record<string, unknown>, sourceUrl: string, documents: DocumentRecord[]) {
  const url = firstString(record, [
    "url",
    "href",
    "contentUrl",
    "downloadUrl",
    "downloadUri",
    "documentUrl",
    "datasheetUrl",
    "manualUrl",
    "pdfUrl",
    "fileUrl",
    "mediaUrl",
    "resourceUrl",
    "assetUrl",
    "imageUrl",
    "primaryImageUrl",
    "thumbnailUrl",
    "downloadLink",
    "src",
    "file",
    "uri"
  ]);
  if (!url) return;
  const label = uniqueStrings([
    firstString(record, ["manualLabel", "datasheetLabel", "documentLabel", "fileName", "filename", "resourceName", "assetName", "label", "title", "name", "displayName", "description"]),
    firstString(record, ["type", "documentType", "category", "group", "encodingFormat", "fileFormat"]),
    firstString(record, ["language", "locale"])
  ].map((value) => cleanText(value)).filter(Boolean)).join(" - ");
  maybeAddDocument(url, label || "Document", sourceUrl, documents);
}

function extractAssignedJsonBlocks(raw: string): string[] {
  const markers = [
    "window.__NUXT__",
    "window.__INITIAL_STATE__",
    "window.__APOLLO_STATE__",
    "window.__PRELOADED_STATE__",
    "window.__PRODUCT_DATA__",
    "window.productData",
    "window.product",
    "window.digitalData",
    "digitalData",
    "utag_data",
    "dataLayer.push",
    "gtag(",
    "gtag (",
    "productData",
    "__NEXT_DATA__",
    "__ASTRO_DATA__"
  ];
  const blocks: string[] = [];
  for (const marker of markers) {
    let index = raw.indexOf(marker);
    while (index >= 0) {
      const start = raw.slice(index).search(/[{\[]/);
      if (start >= 0) {
        const block = readBalancedJson(raw, index + start);
        if (block) blocks.push(block);
      }
      index = raw.indexOf(marker, index + marker.length);
    }
  }
  return blocks;
}

function readBalancedJson(raw: string, start: number): string | undefined {
  const opening = raw[start];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : "";
  if (!closing) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === opening) depth += 1;
    if (char === closing) depth -= 1;
    if (depth === 0) return raw.slice(start, index + 1);
  }
  return undefined;
}

function dynamicScriptGroup(id: string | undefined): string {
  if (/next/i.test(id ?? "")) return "Next Data";
  if (/nuxt/i.test(id ?? "")) return "Nuxt Data";
  if (/astro/i.test(id ?? "")) return "Astro Data";
  return "Embedded JSON";
}

function isUsefulDynamicKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return /(product|catalog|article|order|part|item|sku|mpn|model|brand|manufacturer|material|weight|height|width|depth|length|diameter|dimension|voltage|current|power|temperature|ambient|storage|torque|frequency|pressure|flow|protection|\bip\b|certificate|certification|approval|class|eclass|etim|unspsc|description|feature|connection|channel|input|output|cable|datasheet|document|download|\burl\b|image)/i.test(
    normalized
  );
}

function isUsefulDynamicValue(value: string, compactPart: string): boolean {
  if (!value || value.length > 500) return false;
  if (compactPart && compactCatalogNumber(value).toLowerCase().includes(compactPart)) return true;
  return !/^-?\d+$/.test(value) && !/[{}]|function\s*\(|@media|display\s*:/i.test(value);
}

function titleFromPath(path: string[]): string {
  const useful = path.filter((part) => !/^(props|pageProps|data|attributes|items|edges|nodes|\d+)$/i.test(part)).slice(-3);
  return cleanText(useful.join(" / ")) || "Embedded value";
}

function extractEmbeddedTableData(
  rawText: string,
  catalogNumber: string,
  sourceUrl: string,
  extractionPolicy?: ExtractionPolicyConfig
): { attributes: AttributeRecord[]; documents: DocumentRecord[] } {
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const productTableNames = uniqueStrings([
    "ProductDetail_ProductVariantsTable_Metric",
    "ProductDetail_ProductVariantsTable_Imperial",
    "ProductDetail_ProductVariantsTable",
    "productItemsTableDataMetric",
    "productItemsTableDataImperial",
    "productItemsTableData",
    ...(extractionPolicy?.embeddedProductTableNames ?? [])
  ]);
  const resourceTableNames = uniqueStrings([
    "ProductDetail_ProductResourcesTable",
    "resourcesTableData",
    "productResourcesTableData",
    ...(extractionPolicy?.embeddedResourceTableNames ?? [])
  ]);

  for (const tableName of productTableNames) {
    for (const table of extractNamedJsonArrays(rawText, tableName)) {
      attributes.push(...attributesFromEmbeddedProductTable(table, catalogNumber, sourceUrl));
    }
  }
  for (const tableName of resourceTableNames) {
    for (const table of extractNamedJsonArrays(rawText, tableName)) {
      documents.push(...documentsFromEmbeddedResourceTable(table, sourceUrl));
    }
  }

  return {
    attributes: dedupeAttributes(attributes).slice(0, 250),
    documents: dedupeDocuments(documents).slice(0, 80)
  };
}

function extractEmbeddedPropertyData(rawText: string, sourceUrl: string): { attributes: AttributeRecord[]; documents: DocumentRecord[] } {
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const seenAttributes = new Set<string>();
  const seenDocuments = new Set<string>();
  const propertyPattern = /"groupName"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,500}?"values"\s*:\s*\[([\s\S]*?)\][\s\S]{0,160}?"unit"\s*:\s*(?:"((?:\\.|[^"\\])*)"|null)/g;
  const mediaPattern = /"mediaUrl"\s*:\s*"((?:\\.|[^"\\])*)"/g;

  for (const text of embeddedJsonSearchTexts(rawText)) {
    for (const match of text.matchAll(propertyPattern)) {
      const name = decodeEmbeddedJsonValue(match[1]);
      const values = valuesFromEmbeddedJsonArray(match[2]);
      const unit = match[3] ? decodeEmbeddedJsonValue(match[3]) : undefined;
      if (!name || !values.length) continue;
      const value = appendUnit(values.join("; "), unit);
      if (!isUsefulEmbeddedProperty(name, value)) continue;
      const group = translatedNameBefore(text, match.index ?? 0) ?? "Embedded Product Properties";
      const key = `${group}|${name}|${value}`;
      if (seenAttributes.has(key)) continue;
      seenAttributes.add(key);
      attributes.push({ group, name, value, sourceUrl });
    }

    for (const match of text.matchAll(mediaPattern)) {
      const absolute = toAbsoluteUrl(decodeEmbeddedJsonValue(match[1]), sourceUrl);
      if (!absolute || !isLikelyImageUrl(absolute) || seenDocuments.has(absolute)) continue;
      seenDocuments.add(absolute);
      documents.push({
        type: "image",
        label: "Product image",
        url: absolute,
        sourceUrl
      });
    }
  }

  return {
    attributes: dedupeAttributes(attributes).slice(0, 250),
    documents: dedupeDocuments(documents).slice(0, 40)
  };
}

function valuesFromEmbeddedJsonArray(raw: string): string[] {
  return [...raw.matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((match) => decodeEmbeddedJsonValue(match[1]))
    .filter(Boolean)
    .slice(0, 20);
}

function decodeEmbeddedJsonValue(value: string): string {
  try {
    return cleanText(JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string);
  } catch {
    return cleanText(value.replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">").replace(/\\u0026/gi, "&"));
  }
}

function appendUnit(value: string, unit: string | undefined): string {
  const cleanedUnit = unit ? cleanText(unit) : "";
  if (!cleanedUnit || new RegExp(`\\b${escapeRegex(cleanedUnit)}\\b`, "i").test(value)) return value;
  if (value.includes("; ")) return `${value} ${cleanedUnit}`;
  return `${value} ${cleanedUnit}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function translatedNameBefore(text: string, index: number): string | undefined {
  const prefix = text.slice(Math.max(0, index - 2500), index);
  const matches = [...prefix.matchAll(/"translatedName"\s*:\s*"((?:\\.|[^"\\])*)"/g)];
  return matches.length ? decodeEmbeddedJsonValue(matches[matches.length - 1][1]) : undefined;
}

function isUsefulEmbeddedProperty(name: string, value: string): boolean {
  if (!value || value.length > 500) return false;
  if (/^\s*(?:-|n\/?a|not available|none|without|ohne)\s*$/i.test(value)) return false;
  return isUsefulDynamicKey(name) || /\b(?:standard|cert|approval|voltage|current|material|dimension|weight|protection|ip|connection|coding|actuator|temperature|ambient|storage|torque|frequency|pressure|flow)\b/i.test(name);
}

function extractNamedJsonArrays(rawText: string, key: string): unknown[] {
  const arrays: unknown[] = [];
  const seen = new Set<string>();
  const markers = [`"${key}"`, `'${key}'`, key];
  for (const text of embeddedJsonSearchTexts(rawText)) {
    for (const marker of markers) {
      let fromIndex = 0;
      while (fromIndex < text.length) {
        const markerIndex = text.indexOf(marker, fromIndex);
        if (markerIndex < 0) break;
        fromIndex = markerIndex + marker.length;
        if (marker === key && !isUnquotedObjectKey(text, markerIndex, key.length)) continue;
        const assignment = text.slice(fromIndex).match(/^\s*[:=]\s*/);
        if (!assignment) continue;
        const arrayStart = fromIndex + assignment[0].length + leadingWhitespaceLength(text.slice(fromIndex + assignment[0].length));
        if (text[arrayStart] !== "[") continue;
        const block = readBalancedJson(text, arrayStart);
        if (!block) continue;
        try {
          const parsed = JSON.parse(block) as unknown;
          const fingerprint = JSON.stringify(parsed);
          if (!fingerprint || seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          arrays.push(parsed);
        } catch {
          // Embedded JS often contains optional non-JSON fragments; invalid candidates are ignored.
        }
      }
    }
  }
  return arrays;
}

function embeddedJsonSearchTexts(rawText: string): string[] {
  const htmlDecoded = decodeHtmlForJsonSearch(rawText);
  const jsDecoded = decodeEscapedJsonString(rawText);
  const decodedBoth = decodeEscapedJsonString(htmlDecoded);
  return uniqueStrings([rawText, htmlDecoded, jsDecoded, decodedBoth].filter(Boolean));
}

function decodeHtmlForJsonSearch(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&");
}

function decodeEscapedJsonString(value: string): string {
  return value
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, "/");
}

function leadingWhitespaceLength(value: string): number {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

function isUnquotedObjectKey(text: string, index: number, length: number): boolean {
  const previous = text[index - 1] ?? "";
  const next = text[index + length] ?? "";
  return !/[\w$-]/.test(previous) && !/[\w$-]/.test(next);
}

function attributesFromEmbeddedProductTable(table: unknown, catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const rows = tableRows(table);
  if (rows.length < 2) return [];
  const headers = tableHeaderLabels(rows[0]);
  if (headers.length < 2 || !headers.some((header) => /catalog|item|part|sku|model|voltage|material|height|width|depth|length/i.test(header))) {
    return [];
  }
  const attributes: AttributeRecord[] = [];
  for (const row of rows.slice(1)) {
    if (!embeddedRowMatchesCatalog(headers, row, catalogNumber)) continue;
    headers.forEach((header, index) => {
      const value = tableCellText(row[index]);
      if (!header || !value || !isUsefulDataRowValue(value)) return;
      attributes.push({
        group: "Embedded Product Table",
        name: header,
        value,
        sourceUrl
      });
    });
  }
  return attributes;
}

function documentsFromEmbeddedResourceTable(table: unknown, sourceUrl: string): DocumentRecord[] {
  const rows = tableRows(table);
  if (!rows.length) return [];
  let headers = tableHeaderLabels(rows[0]);
  let dataRows = rows.slice(1);
  if (!headers.some((header) => /document|resource|url|language|category|type|name|size/i.test(header))) {
    headers = ["Document Category", "Document Type", "Document Name", "Document Size", "Document Language", "Document URL"];
    dataRows = rows;
  }

  const documents: DocumentRecord[] = [];
  for (const row of dataRows) {
    const urlValue = tableValueByHeader(headers, row, /(?:document|resource)?\s*url|href|download/i) ?? row.map(tableCellText).find((value) => Boolean(toAbsoluteUrl(value, sourceUrl)));
    const absolute = urlValue ? toAbsoluteUrl(urlValue, sourceUrl) : undefined;
    if (!absolute || (!documentUrlLooksDownloadable(absolute) && !isLikelyImageUrl(absolute))) continue;
    const category = tableValueByHeader(headers, row, /category|group|section/i);
    const docType = tableValueByHeader(headers, row, /^type$|document type|file type/i);
    const name = tableValueByHeader(headers, row, /^(?:document|resource)\s*name$|^name$|title|description/i) ?? pathLikeBaseName(new URL(absolute).pathname);
    const size = tableValueByHeader(headers, row, /size/i);
    const language = tableValueByHeader(headers, row, /language|locale/i);
    const label = uniqueStrings([category, name, size, language].map((value) => cleanText(value)).filter(Boolean)).join(" - ");
    documents.push({
      type: classifyDocument(`${category ?? ""} ${docType ?? ""} ${name ?? ""}`, absolute),
      label: label || name || pathLikeBaseName(absolute),
      url: absolute,
      sourceUrl
    });
  }
  return documents;
}

function tableRows(table: unknown): unknown[][] {
  if (!Array.isArray(table)) return [];
  return table.filter((row): row is unknown[] => Array.isArray(row));
}

function tableHeaderLabels(row: unknown[]): string[] {
  return row.map(tableCellText).map((label) => cleanText(label));
}

function tableCellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") {
    return cleanText(stripHtml(String(cell)));
  }
  if (typeof cell !== "object" || Array.isArray(cell)) return "";
  const record = cell as Record<string, unknown>;
  for (const key of ["columnName", "label", "name", "title", "header", "text", "value", "displayName"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return cleanText(stripHtml(String(value)));
  }
  return "";
}

function embeddedRowMatchesCatalog(headers: string[], row: unknown[], catalogNumber: string): boolean {
  const catalogIndexes = headers
    .map((header, index) => (/\b(catalog|item|part|sku|model|ordering|article)\b/i.test(header) ? index : -1))
    .filter((index) => index >= 0);
  const valuesToCheck = (catalogIndexes.length ? catalogIndexes : row.map((_, index) => index)).map((index) => tableCellText(row[index]));
  return valuesToCheck.some((value) => catalogTextMatches(value, catalogNumber, { compact: true, ignoreCase: true, afterColon: true }));
}

function tableValueByHeader(headers: string[], row: unknown[], pattern: RegExp): string | undefined {
  const index = headers.findIndex((header) => pattern.test(header));
  if (index < 0) return undefined;
  const value = tableCellText(row[index]);
  return value || undefined;
}

function uniqueStrings(values: string[]): string[] {
  return uniqueStringsBase(values, { filterEmpty: false, caseInsensitive: true });
}

function parseDataRowAttributes(raw: string | undefined, sourceUrl: string, catalogNumber: string): AttributeRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const attributes: AttributeRecord[] = [];
    const rowRecords = parsed.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    const keyedRows = rowRecords.filter((record) => !("label" in record && "value" in record));
    const keyedRowsToParse = keyedRows.filter((record) => rowContainsCatalogNumber(record, catalogNumber));
    for (const item of rowRecords) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const name = cleanText(String(record.label ?? record.name ?? ""));
      const value = cleanText(dataRowValue(record));
      if (!name || !value) {
        continue;
      }
      attributes.push({ group: "Embedded Spec Rows", name, value, sourceUrl });
    }
    for (const record of keyedRowsToParse) {
      for (const [key, rawValue] of Object.entries(record)) {
        if (/^(_|qs$|href$|url$)/i.test(key)) continue;
        const value = cleanText(stripHtml(String(rawValue ?? "")));
        if (!value || !isUsefulDataRowValue(value)) continue;
        attributes.push({ group: "Embedded Product Table", name: titleFromDataKey(key), value, sourceUrl });
      }
    }
    return attributes;
  } catch {
    return [];
  }
}

function dataRowValue(record: Record<string, unknown>): string {
  const rawValue = cleanText(String(record.value ?? ""));
  if (!rawValue) return "";
  const label = cleanText(String(record.label ?? record.name ?? ""));
  const measureSystem = cleanText(String(record.measuresys ?? ""));
  const attributeId = cleanText(String(record.attributeId ?? ""));
  const unit = nventMeasurementUnitFor(rawValue, label, attributeId, measureSystem);
  return unit ? `${rawValue}${unit}` : rawValue;
}

function nventMeasurementUnitFor(value: string, label: string, attributeId: string, measureSystem: string): string | undefined {
  if (!/^-?\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?$/.test(value)) return undefined;
  if (/\b(?:mm|cm|m|in|inch|inches|lb|lbs|kg|g|oz|")\b/i.test(value)) return undefined;
  const context = `${label} ${attributeId}`;
  if (/\b(?:height|width|depth|length)\b/i.test(context)) {
    if (/^imperial$/i.test(measureSystem)) return "in";
    if (/^metric$/i.test(measureSystem)) return "mm";
  }
  if (/\b(?:weight|mass)\b/i.test(context)) {
    if (/^imperial$/i.test(measureSystem)) return "lb";
    if (/^metric$/i.test(measureSystem)) return "kg";
  }
  return undefined;
}

function rowContainsCatalogNumber(record: Record<string, unknown>, catalogNumber: string): boolean {
  const text = Object.values(record).map((value) => stripHtml(String(value ?? ""))).join(" ");
  return catalogTextMatches(text, catalogNumber, { compact: true, ignoreCase: true });
}

function isUsefulDataRowValue(value: string): boolean {
  return value.length <= 300 && !/^(yes|no|select|download)$/i.test(value);
}

function titleFromDataKey(key: string): string {
  return cleanText(
    key
      .replace(/_imperial$|_metric$/i, "")
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

function stripHtml(value: string): string {
  if (!/[<>]/.test(value)) return value;
  return cleanText(cheerio.load(value).text());
}

function extractProductSectionAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("h2,h3,h4").each((_, element) => {
    const heading = cleanText($(element).text());
    if (!heading) return;
    const complianceSection = complianceSectionForHeading(heading);
    if (complianceSection) {
      for (const value of sectionTextValues($, element, 8)) {
        attributes.push({ group: complianceSection.group, name: complianceSection.name, value, sourceUrl });
      }
      return;
    }
    if (/^features$/i.test(heading)) {
      for (const value of sectionListValues($, element)) {
        attributes.push({ group: "Features", name: "Feature", value, sourceUrl });
      }
      return;
    }
    if (/^industry standards?$/i.test(heading)) {
      for (const value of sectionTextValues($, element, 8)) {
        attributes.push({ group: "Industry Standards", name: "Industry Standard", value, sourceUrl });
      }
      return;
    }
    if (/^bulletin number$/i.test(heading)) {
      const value = sectionTextValues($, element, 2)[0];
      if (value) attributes.push({ group: "Product Specifications", name: "Bulletin Number", value, sourceUrl });
      return;
    }
    if (/^warning$/i.test(heading)) {
      for (const value of sectionTextValues($, element, 4)) {
        attributes.push({ group: "Warnings", name: "Warning", value, sourceUrl });
      }
    }
  });
  return dedupeAttributes(attributes).slice(0, 80);
}

function complianceSectionForHeading(heading: string): { group: string; name: string } | undefined {
  if (/^(?:industry\s+)?standards?$/i.test(heading)) return { group: "Industry Standards", name: "Industry Standard" };
  if (/^(?:(?:product\s+)?certifications?|certificates?)$/i.test(heading)) return { group: "Certifications", name: "Certification" };
  if (/^(?:approval|approvals|approval\/conformity|approvals? and certifications?)$/i.test(heading)) return { group: "Approvals", name: "Approval" };
  if (/^(?:declarations?|declarations? of conformity|conformity declarations?|compliance declarations?)$/i.test(heading)) return { group: "Declarations", name: "Declaration" };
  if (/^(?:compliance|compliances|regulatory compliance|environmental compliance)$/i.test(heading)) return { group: "Compliance", name: "Compliance" };
  return undefined;
}

function extractLabeledSpecAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("[class*='spec-label'],[class*='attribute-label'],[class*='field-label']").each((_, labelElement) => {
    const label = cleanText($(labelElement).text()).replace(/[:：]\s*$/, "");
    if (!label || label.length > 120 || !isUsefulSpecLabel(label)) return;
    const parent = $(labelElement).parent();
    if (!parent.length) return;
    const clone = parent.clone();
    clone.find("[class*='spec-label'],[class*='attribute-label'],[class*='field-label']").first().remove();
    const value = cleanSectionValue(clone.text()).replace(/^[:：]\s*/, "");
    if (!value || value.length > 300 || /^(copy table|show metric|show imperial|download)$/i.test(value)) return;
    attributes.push({
      group: labeledSpecGroup($, labelElement),
      name: label,
      value,
      sourceUrl
    });
  });
  return dedupeAttributes(attributes).slice(0, 140);
}

function extractSemanticSpecAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const push = (name: string | undefined, value: string | undefined, group = "Product Specifications") => {
    const cleanName = cleanText(name).replace(/[:ďĽš]\s*$/, "");
    const cleanValue = cleanText(value);
    if (!cleanName || !cleanValue) return;
    if (!isUsefulSpecLabel(cleanName) || !isUsefulDataRowValue(cleanValue)) return;
    attributes.push({ group, name: cleanName, value: cleanValue, sourceUrl });
  };

  $("[itemprop]").each((_, element) => {
    const prop = $(element).attr("itemprop");
    if (!prop || !isUsefulSpecLabel(prop)) return;
    const value = cleanText($(element).attr("content") || $(element).attr("value") || $(element).text());
    push(titleFromDataKey(prop), value, "Structured Properties");
  });

  $("[data-label],[data-name],[data-title],[data-spec-name],[data-attribute-name],[data-property-name]").each((_, element) => {
    const attrs = element.attribs ?? {};
    const name =
      attrs["data-spec-name"] ??
      attrs["data-attribute-name"] ??
      attrs["data-property-name"] ??
      attrs["data-label"] ??
      attrs["data-name"] ??
      attrs["data-title"];
    const value =
      attrs["data-spec-value"] ??
      attrs["data-attribute-value"] ??
      attrs["data-property-value"] ??
      attrs["data-value"] ??
      attrs["data-display-value"] ??
      stripLeadingLabelPrefix(cleanText($(element).text()), name);
    push(name, value, semanticSpecGroup($, element));
  });

  $("[aria-label]").each((_, element) => {
    const aria = cleanText($(element).attr("aria-label"));
    const match = aria.match(/^([^:]{2,80})[:ďĽš]\s*(.{1,220})$/);
    if (!match) return;
    push(match[1], match[2], semanticSpecGroup($, element));
  });

  return dedupeAttributes(attributes).slice(0, 180);
}

function extractSchemaPropertyValueAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const selectors = [
    "[itemtype*='PropertyValue']",
    "[typeof*='PropertyValue']",
    "[itemprop='additionalProperty'][itemscope]",
    "[property='additionalProperty'][typeof]"
  ].join(",");

  $(selectors).slice(0, 300).each((_, element) => {
    const name = schemaScopedValue($, element, ["name", "propertyID", "identifier", "label"]);
    const rawValue = schemaScopedValue($, element, ["value", "valueReference", "displayValue", "text"]);
    const unit = schemaScopedValue($, element, ["unitText", "unitCode", "unit", "uom"]);
    const cleanName = cleanSpecPairLabel(name);
    const cleanValue = cleanSpecPairValue(appendUnit(cleanText(rawValue), unit), cleanName);
    if (!isUsefulSectionAwareSpecPair(cleanName, cleanValue)) return;
    attributes.push({ group: schemaPropertyGroup($, element), name: cleanName, value: cleanValue, sourceUrl });
  });

  return dedupeAttributes(attributes).slice(0, 160);
}

function schemaScopedValue($: cheerio.CheerioAPI, root: Parameters<cheerio.CheerioAPI>[0], propertyNames: string[]): string | undefined {
  for (const propertyName of propertyNames) {
    const direct = $(root)
      .find(`[itemprop='${propertyName}'],[property='${propertyName}']`)
      .filter((_, element) => $(element).parents("[itemtype*='PropertyValue'],[typeof*='PropertyValue'],[itemscope]").first().get(0) === root)
      .first();
    if (!direct.length) continue;
    const value = cleanText(direct.attr("content") || direct.attr("value") || direct.attr("data-value") || direct.text());
    if (value) return value;
  }
  return undefined;
}

function schemaPropertyGroup($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): string {
  const heading = cleanText(
    [
      $(element).closest("section,article,div").find("h2,h3,h4,[role='heading'],[class*='heading'],[class*='title']").first().text(),
      $(element).prevAll("h2,h3,h4,[role='heading']").first().text()
    ].filter(Boolean)[0]
  );
  if (heading && heading.length <= 90) return heading;
  return "Schema Properties";
}

function extractSectionAwareSpecAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seenContainers = new Set<unknown>();
  const containers = $(
    [
      "section",
      "article",
      "[role='tabpanel']",
      "[class*='spec']",
      "[id*='spec']",
      "[class*='tech']",
      "[id*='tech']",
      "[class*='attribute']",
      "[id*='attribute']",
      "[class*='property']",
      "[id*='property']",
      "[class*='product-detail']",
      "[id*='product-detail']",
      "[class*='accordion']",
      "[id*='accordion']",
      "[class*='tab']",
      "[id*='tab']",
      "[class*='feature']",
      "[id*='feature']"
    ].join(",")
  );

  const push = (name: string | undefined, value: string | undefined, group: string) => {
    const cleanName = cleanSpecPairLabel(name);
    const cleanValue = cleanSpecPairValue(value, cleanName);
    if (!isUsefulSectionAwareSpecPair(cleanName, cleanValue)) return;
    attributes.push({ group, name: cleanName, value: cleanValue, sourceUrl });
  };

  containers.slice(0, 500).each((_, container) => {
    if (seenContainers.has(container)) return;
    seenContainers.add(container);
    if (!isLikelySpecContainer($, container)) return;
    const group = sectionAwareSpecGroup($, container);

    for (const pair of classHintSpecPairs($, container)) {
      push(pair.name, pair.value, group);
    }

    $(container)
      .find("[class*='row'],[class*='item'],[class*='property'],[class*='attribute'],[class*='field'],[class*='detail'],[class*='spec']")
      .slice(0, 220)
      .each((__, row) => {
        const pair = childElementSpecPair($, row);
        if (pair) push(pair.name, pair.value, group);
      });

    $(container)
      .children("div,li,p")
      .slice(0, 160)
      .each((__, row) => {
        const pair = childElementSpecPair($, row) ?? splitNameValue($(row).text());
        if (pair) push(pair.name, pair.value, group);
      });
  });

  return dedupeAttributes(attributes).slice(0, 180);
}

function extractHeadingValueSpecAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("h2,h3,h4,h5,h6,[role='heading']")
    .slice(0, 500)
    .each((_, heading) => {
      if (isNavigationLike($, heading)) return;
      const name = cleanSpecPairLabel($(heading).text());
      if (!isUsefulSpecLabel(name) || isBroadSectionHeading(name)) return;
      const value = cleanSpecPairValue(nextHeadingValue($, heading), name);
      if (!isUsefulSectionAwareSpecPair(name, value)) return;
      attributes.push({ group: loosePairGroup($, heading), name, value, sourceUrl });
    });
  return dedupeAttributes(attributes).slice(0, 120);
}

function nextHeadingValue($: cheerio.CheerioAPI, heading: Parameters<cheerio.CheerioAPI>[0]): string | undefined {
  let node = $(heading).next();
  for (let index = 0; index < 5 && node.length; index += 1) {
    const tagName = String(node.get(0)?.tagName ?? "").toLowerCase();
    if (/^h[1-6]$/i.test(tagName) || node.is("[role='heading']")) return undefined;
    if (node.is("script,style,noscript,svg,img,picture,button,a,table")) {
      node = node.next();
      continue;
    }
    const text = cleanSectionValue(node.text());
    if (text && text.length <= 300) return text;
    node = node.next();
  }
  const parent = $(heading).parent();
  if (parent.length && parent.children().length <= 6) {
    const clone = parent.clone();
    clone.children().first().remove();
    const text = cleanSectionValue(clone.text());
    if (text && text.length <= 300) return text;
  }
  return undefined;
}

function isBroadSectionHeading(value: string): boolean {
  return /^(?:features?|spec(?:ification)?s?|technical\s+(?:data|details?|spec(?:ification)?s?)|product\s+(?:details?|data|information|spec(?:ification)?s?)|documents?|downloads?|resources?|overview|description|related\s+products?)$/i.test(
    value
  );
}

function extractPageWideSpecAttributes($: cheerio.CheerioAPI, catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  return dedupeAttributes([
    ...extractHeaderMappedTableAttributes($, catalogNumber, sourceUrl),
    ...extractLooseChildPairAttributes($, sourceUrl),
    ...extractAlternatingSpecGridAttributes($, sourceUrl),
    ...extractResponsiveCellAttributes($, sourceUrl),
    ...extractAriaReferencedAttributes($, sourceUrl)
  ]).slice(0, 240);
}

function extractHeaderMappedTableAttributes($: cheerio.CheerioAPI, catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("table").slice(0, 120).each((_, table) => {
    const rows: string[][] = [];
    $(table).find("tr").slice(0, 80).each((__, row) => {
      const cells = $(row).find("th,td").map((___, cell) => cleanSectionValue($(cell).text())).get().filter(Boolean);
      if (cells.length) rows.push(cells);
    });
    if (rows.length < 2) return;
    const header = rows[0].map(cleanSpecPairLabel);
    if (header.length < 2 || header.filter(isUsefulSpecLabel).length === 0) return;
    if (header.every((cell) => /^header\s+\d+$/i.test(cell))) return;

    const dataRows = rows.slice(1).filter((row) => row.length >= 2);
    const matchingRows = dataRows.filter((row) => catalogTextMatches(row.join(" "), catalogNumber, { compact: true, ignoreCase: true, afterColon: true }));
    const chosenRows = matchingRows.length > 0 ? matchingRows : dataRows.length === 1 && tableLooksProductSpecific($, table) ? dataRows : [];
    if (!chosenRows.length) return;
    const group = tableSpecGroup($, table);

    for (const row of chosenRows.slice(0, 4)) {
      for (let index = 0; index < Math.min(header.length, row.length); index += 1) {
        const name = header[index];
        const value = cleanSpecPairValue(row[index], name);
        if (!isUsefulSectionAwareSpecPair(name, value)) continue;
        attributes.push({ group, name, value, sourceUrl });
      }
    }
  });
  return dedupeAttributes(attributes).slice(0, 180);
}

function extractLooseChildPairAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("div,li,p,section,article,[role='row']")
    .slice(0, 1600)
    .each((_, row) => {
      if (isInsideTable($, row) || isNavigationLike($, row)) return;
      const pair = childElementSpecPair($, row) ?? splitNameValue($(row).text());
      if (!pair) return;
      const name = cleanSpecPairLabel(pair.name);
      const value = cleanSpecPairValue(pair.value, name);
      if (!isUsefulSectionAwareSpecPair(name, value)) return;
      attributes.push({ group: loosePairGroup($, row), name, value, sourceUrl });
    });
  return dedupeAttributes(attributes).slice(0, 160);
}

function extractAlternatingSpecGridAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const containers = $(
    [
      "section",
      "article",
      "[role='table']",
      "[role='grid']",
      "[role='list']",
      "[class*='spec']",
      "[id*='spec']",
      "[class*='tech']",
      "[id*='tech']",
      "[class*='attribute']",
      "[id*='attribute']",
      "[class*='property']",
      "[id*='property']",
      "[class*='parameter']",
      "[id*='parameter']",
      "[class*='characteristic']",
      "[id*='characteristic']",
      "[class*='product-detail']",
      "[id*='product-detail']"
    ].join(",")
  );

  containers.slice(0, 700).each((_, container) => {
    if (isInsideTable($, container) || isNavigationLike($, container) || !isLikelySpecContainer($, container)) return;
    const cells = directTextCells($, container);
    const pairs = alternatingSpecPairsFromTexts(cells.map((cell) => cell.text));
    if (pairs.length < 2) return;
    const group = sectionAwareSpecGroup($, container);
    for (const pair of pairs) {
      attributes.push({ group, name: pair.name, value: pair.value, sourceUrl });
    }
  });

  return dedupeAttributes(attributes).slice(0, 160);
}

function directTextCells($: cheerio.CheerioAPI, container: Parameters<cheerio.CheerioAPI>[0]): Array<{ text: string }> {
  return $(container)
    .children()
    .filter((_, child) => {
      const tagName = String(child.tagName ?? "").toLowerCase();
      return !/^(?:script|style|noscript|svg|img|picture|button|a|table|thead|tbody|tr|ul|ol|select|option)$/i.test(tagName);
    })
    .map((_, child) => ({ text: cleanSectionValue($(child).text()) }))
    .get()
    .filter((cell) => Boolean(cell.text) && cell.text.length <= 300);
}

function alternatingSpecPairsFromTexts(texts: string[]): Array<{ name: string; value: string }> {
  if (texts.length < 4 || texts.length > 80) return [];
  const candidates = [0, 1].map((offset) => alternatingSpecPairsFromOffset(texts, offset));
  return candidates.sort((left, right) => right.length - left.length)[0] ?? [];
}

function alternatingSpecPairsFromOffset(texts: string[], offset: number): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  for (let index = offset; index + 1 < texts.length; index += 2) {
    const name = cleanSpecPairLabel(texts[index]);
    const value = cleanSpecPairValue(texts[index + 1], name);
    if (!isUsefulSectionAwareSpecPair(name, value)) continue;
    if (looksLikeAnotherSpecLabel(value)) continue;
    pairs.push({ name, value });
  }
  return pairs;
}

function looksLikeAnotherSpecLabel(value: string): boolean {
  const cleaned = cleanSpecPairLabel(value);
  if (!cleaned || cleaned.length > 80) return false;
  if (/[0-9]/.test(cleaned) || /\b(?:mm|cm|m|in|inch|kg|g|lb|v|a|w|hz|bar|psi|ip\d+|nema)\b/i.test(cleaned)) return false;
  return isUsefulSpecLabel(cleaned);
}

function extractResponsiveCellAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("td[data-label],td[data-title],td[headers],li[data-label],div[data-label]")
    .slice(0, 500)
    .each((_, element) => {
      const name = cleanSpecPairLabel($(element).attr("data-label") || $(element).attr("data-title") || $(element).attr("headers"));
      const value = cleanSpecPairValue($(element).text(), name);
      if (!isUsefulSectionAwareSpecPair(name, value)) return;
      attributes.push({ group: tableSpecGroup($, $(element).closest("table").get(0) ?? element), name, value, sourceUrl });
    });
  return dedupeAttributes(attributes).slice(0, 120);
}

function extractAriaReferencedAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("[aria-labelledby],[aria-describedby]")
    .slice(0, 700)
    .each((_, element) => {
      if (isNavigationLike($, element)) return;
      const labelText = referencedElementText($, $(element).attr("aria-labelledby"));
      const describedText = referencedElementText($, $(element).attr("aria-describedby"));
      const ownText = cleanSectionValue($(element).text());
      const name = cleanSpecPairLabel(labelText || ariaPairLabelFromOwnText(ownText));
      const valueSource = describedText || (labelText ? ownText : undefined);
      const value = cleanSpecPairValue(valueSource, name);
      if (!isUsefulSectionAwareSpecPair(name, value)) return;
      attributes.push({ group: loosePairGroup($, element), name, value, sourceUrl });
    });
  return dedupeAttributes(attributes).slice(0, 120);
}

function referencedElementText($: cheerio.CheerioAPI, idList: string | undefined): string | undefined {
  const ids = cleanText(idList).split(/\s+/).filter(Boolean).slice(0, 5);
  const values: string[] = [];
  for (const id of ids) {
    const text = cleanSectionValue($("[id]").filter((_, element) => $(element).attr("id") === id).first().text());
    if (text) values.push(text);
  }
  return values.length ? uniqueStringValues(values).join(" ") : undefined;
}

function ariaPairLabelFromOwnText(text: string): string | undefined {
  const pair = splitNameValue(text);
  return pair?.name;
}

function tableLooksProductSpecific($: cheerio.CheerioAPI, table: Parameters<cheerio.CheerioAPI>[0]): boolean {
  const context = cleanText([
    $(table).attr("class"),
    $(table).attr("id"),
    $(table).closest("section,article,div").find("h2,h3,h4,[role='heading']").first().text(),
    $(table).prevAll("h2,h3,h4,[role='heading']").first().text()
  ].filter(Boolean).join(" "));
  return /\b(?:spec|technical|tech|electrical|mechanical|attribute|property|characteristic|parameter|product|variant|data|rating)\b/i.test(context);
}

function tableSpecGroup($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): string {
  const heading = cleanText(
    [
      $(element).closest("section,article,div").find("h2,h3,h4,[role='heading'],[class*='heading'],[class*='title']").first().text(),
      $(element).prevAll("h2,h3,h4,[role='heading']").first().text()
    ].filter(Boolean)[0]
  );
  if (heading && heading.length <= 90) return heading;
  return "Product Table";
}

function loosePairGroup($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): string {
  const heading = cleanText(
    [
      $(element).closest("section,article").find("h2,h3,h4,[role='heading'],[class*='heading'],[class*='title']").first().text(),
      $(element).prevAll("h2,h3,h4,[role='heading']").first().text()
    ].filter(Boolean)[0]
  );
  if (heading && heading.length <= 90) return heading;
  return "Page Evidence";
}

function isInsideTable($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): boolean {
  return $(element).parents("table").length > 0;
}

function isNavigationLike($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): boolean {
  const tagName = (element as { tagName?: string } | undefined)?.tagName;
  const context = cleanText([$(element).attr("class"), $(element).attr("id"), tagName].filter(Boolean).join(" "));
  return /\b(?:nav|menu|breadcrumb|footer|header|cookie|modal|pagination|toolbar|filter|facet)\b/i.test(context);
}

function isLikelySpecContainer($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): boolean {
  const tagName = String((element as { tagName?: string } | undefined)?.tagName ?? "").toLowerCase();
  if (/^(?:html|body|head|script|style|noscript|nav|footer|header|form|button|select|option)$/i.test(tagName)) return false;
  const text = cleanText($(element).text());
  if (!text || text.length < 8 || text.length > 9000) return false;
  const context = cleanText(
    [
      $(element).attr("class"),
      $(element).attr("id"),
      $(element).attr("role"),
      $(element).attr("aria-label"),
      $(element).find("h2,h3,h4,h5,[role='heading'],[class*='heading'],[class*='title']").first().text()
    ]
      .filter(Boolean)
      .join(" ")
  );
  return /\b(?:spec|technical|tech|electrical|mechanical|attribute|property|characteristic|parameter|feature|detail|data|rating)\b/i.test(context);
}

function classHintSpecPairs($: cheerio.CheerioAPI, container: Parameters<cheerio.CheerioAPI>[0]): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  $(container)
    .find(
      [
        "[class*='spec-label']",
        "[class*='attribute-label']",
        "[class*='field-label']",
        "[class*='property-label']",
        "[class*='label']",
        "[class*='spec-name']",
        "[class*='attribute-name']",
        "[class*='property-name']",
        "[class*='characteristic-name']"
      ].join(",")
    )
    .slice(0, 180)
    .each((_, labelElement) => {
      if (hasValueClassHint($, labelElement)) return;
      const name = cleanSpecPairLabel($(labelElement).text());
      if (!isUsefulSpecLabel(name)) return;
      const value = valueForClassHintLabel($, labelElement);
      if (value) pairs.push({ name, value });
    });
  return pairs;
}

function valueForClassHintLabel($: cheerio.CheerioAPI, labelElement: Parameters<cheerio.CheerioAPI>[0]): string | undefined {
  const parent = $(labelElement).parent();
  const hintedValue = parent
    .find(
      [
        "[class*='spec-value']",
        "[class*='attribute-value']",
        "[class*='field-value']",
        "[class*='property-value']",
        "[class*='value']",
        "[class*='characteristic-value']"
      ].join(",")
    )
    .filter((_, valueElement) => valueElement !== labelElement)
    .first();
  if (hintedValue.length) return cleanSectionValue(hintedValue.text());

  const next = $(labelElement).next();
  const nextText = cleanSectionValue(next.text());
  if (next.length && nextText && nextText.length <= 300) return nextText;

  if (parent.length && parent.children().length <= 8) {
    const clone = parent.clone();
    clone.children().filter((_, child) => child === labelElement).first().remove();
    const value = cleanSectionValue(clone.text()).replace(/^[:ÄŹÄ˝Ĺˇ]\s*/, "");
    if (value && value.length <= 300) return value;
  }

  return undefined;
}

function childElementSpecPair($: cheerio.CheerioAPI, row: Parameters<cheerio.CheerioAPI>[0]): { name: string; value: string } | undefined {
  if ($(row).is("script,style,noscript,table,thead,tbody,tr,ul,ol,select,button,a")) return undefined;
  const children = $(row)
    .children()
    .filter((_, child) => !/^(?:script|style|noscript|svg|img|picture|button|a)$/i.test(String(child.tagName ?? "")))
    .toArray();
  if (children.length < 2 || children.length > 8) return undefined;

  const texts = children.map((child) => cleanSectionValue($(child).text())).filter(Boolean);
  if (texts.length < 2) return undefined;
  if (alternatingSpecPairsFromTexts(texts).length >= 2) return undefined;
  const [name, ...valueParts] = texts;
  const value = valueParts.join(" | ");
  if (!isUsefulSectionAwareSpecPair(cleanSpecPairLabel(name), cleanSpecPairValue(value, name))) return undefined;
  return { name, value };
}

function sectionAwareSpecGroup($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): string {
  const aria = cleanText($(element).attr("aria-label"));
  if (aria && aria.length <= 90 && /\b(?:spec|technical|tech|electrical|mechanical|data|attribute|characteristic|parameter)\b/i.test(aria)) return aria;
  const ownHeading = cleanText($(element).children("h2,h3,h4,h5,[role='heading'],[class*='heading'],[class*='title']").first().text());
  if (ownHeading && ownHeading.length <= 90) return ownHeading;
  const descendantHeading = cleanText($(element).find("h2,h3,h4,h5,[role='heading'],[class*='heading'],[class*='title']").first().text());
  if (descendantHeading && descendantHeading.length <= 90) return descendantHeading;
  const previousHeading = cleanText($(element).prevAll("h2,h3,h4,h5,[role='heading']").first().text());
  if (previousHeading && previousHeading.length <= 90) return previousHeading;
  return "Product Specifications";
}

function cleanSpecPairLabel(label: string | undefined): string {
  return cleanText(label)
    .replace(/[:ÄŹÄ˝Ĺˇ]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSpecPairValue(value: string | undefined, label: string): string {
  let cleaned = cleanSectionValue(value ?? "").replace(/^[:ÄŹÄ˝Ĺˇ]\s*/, "");
  cleaned = stripLeadingLabelPrefix(cleaned, label);
  return cleanSectionValue(applyLabelUnitHintToSpecValue(label, cleaned));
}

/**
 * Removes a leading duplicate of `label` from the start of `value` ("Weight Weight 12 kg" → "12 kg").
 * Building `new RegExp("^" + escapeRegex(label) + ...)` from an arbitrary DOM-derived label is a
 * crash risk: a heading/label that is really an entire navigation blob (thousands of chars — e.g.
 * Ganter's mega-menu <h2> whose .text() is the whole category tree) escapes to a pattern that
 * exceeds V8's compiled-regex size limit and throws "regular expression too large". Thrown from deep
 * inside generic parsing during smart-fallback, that uncaught error failed the ENTIRE product. Real
 * spec labels are short, so skip the prefix-strip for oversized labels and never let a pathological
 * label take the whole item down.
 */
function stripLeadingLabelPrefix(value: string, label: string | undefined): string {
  const trimmed = cleanText(label ?? "");
  if (!trimmed || trimmed.length > 120) return value;
  try {
    return value.replace(new RegExp(`^${escapeRegex(trimmed)}\\s*[:ÄŹÄ˝Ĺˇ]?\\s*`, "i"), "");
  } catch {
    return value;
  }
}

function applyLabelUnitHintToSpecValue(label: string, value: string): string {
  const unit = cleanText(label.match(/\[\s*(m?v|k?v|m?a|k?a|m?w|k?w|v|a|w)\s*\]/i)?.[1] ?? "");
  if (!unit || !/[-+]?\d/.test(value)) return value;
  const normalizedUnit = unit === unit.toLowerCase() ? unit.replace(/^([mkv])?([vaw])$/i, (_, prefix: string = "", base: string) => `${prefix}${base.toUpperCase()}`) : unit;
  const unitKindPattern =
    /v$/i.test(normalizedUnit) ? /\b(?:mV|V|kV|VAC|VDC|Vac|Vdc)\b/i :
    /a$/i.test(normalizedUnit) ? /\b(?:uA|mA|A|kA)\b/i :
    /\b(?:mW|W|kW)\b/i;
  if (unitKindPattern.test(value)) return value;
  if (/\b(?:AC|DC)\b/i.test(value)) return value.replace(/([-+]?\d+(?:[.,]\d+)?(?:\s*(?:\.\.\.|-|to)\s*[-+]?\d+(?:[.,]\d+)?)?)\s+(AC|DC)\b/i, `$1 ${normalizedUnit} $2`);
  return value.replace(/([-+]?\d+(?:[.,]\d+)?(?:\s*(?:\.\.\.|-|to)\s*[-+]?\d+(?:[.,]\d+)?)?)/, `$1 ${normalizedUnit}`);
}

function isUsefulSectionAwareSpecPair(name: string, value: string): boolean {
  if (!name || !value) return false;
  if (name.length > 120 || value.length > 300) return false;
  if (!isUsefulSpecLabel(name) || !isUsefulDataRowValue(value)) return false;
  if (cleanText(name).toLowerCase() === cleanText(value).toLowerCase()) return false;
  if (/^(?:download|downloads|resources?|documents?|manuals?|videos?|view|show|hide|read more|learn more|add to cart|quantity)$/i.test(name)) return false;
  if (/^(?:download|downloads|view|show|hide|select|read more|learn more|copy table)$/i.test(value)) return false;
  if (/\b(?:privacy|cookie|terms?|conditions?|newsletter|subscribe|login|sign in)\b/i.test(`${name} ${value}`)) return false;
  return /[A-Za-z0-9]/.test(value);
}

function hasValueClassHint($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): boolean {
  const context = cleanText([$(element).attr("class"), $(element).attr("id")].filter(Boolean).join(" "));
  return /\bvalue\b|(?:^|[-_])value(?:$|[-_])/i.test(context);
}

function semanticSpecGroup($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0]): string {
  const container = $(element).closest("[id*='spec'],[class*='spec'],[id*='tech'],[class*='tech'],[id*='attribute'],[class*='attribute'],section,article,div");
  const heading = cleanText(container.find("h2,h3,h4,[class*='heading'],[class*='title']").first().text());
  if (heading && heading.length <= 80) return heading;
  return "Product Specifications";
}

function isUsefulSpecLabel(label: string): boolean {
  // A real spec label is short. The keyword test below only requires the keyword to appear ANYWHERE
  // in the string, so a whole navigation/description blob that merely happens to contain "material"
  // or "length" would otherwise qualify as a "label" — polluting output and (via the prefix-strip
  // regex) risking a "regular expression too large" crash. Cap length before the keyword test.
  if (label.length > 120) return false;
  return /classification|type|material|finish|colou?r|height|width|depth|length|diameter|weight|mass|voltage|current|power|temperature|ambient|storage|torque|frequency|pressure|flow|sensor|signal|display|enclosure|function|mounting|protection|rating|standard|certification|approval|ground|path|jacket|conductor|connection|channel|input|output|i\/o|package|brand|manufacturer|model|sku|mpn|gtin|upc|ean|catalog|order|part|item|article/i.test(label);
}

function labeledSpecGroup($: cheerio.CheerioAPI, labelElement: Parameters<cheerio.CheerioAPI>[0]): string {
  const container = $(labelElement).closest("[id*='spec'],[class*='spec'],section,article,div");
  const heading = cleanText(container.find("h2,h3,h4").first().text());
  if (heading && heading.length <= 80) return heading;
  return "Product Specifications";
}

function sectionListValues($: cheerio.CheerioAPI, heading: Parameters<cheerio.CheerioAPI>[0]): string[] {
  const container = $(heading).parent();
  const values = container
    .find("li")
    .map((_, item) => cleanSectionValue($(item).text()))
    .get()
    .filter(isUsefulSectionValue);
  if (values.length) return uniqueStringValues(values).slice(0, 30);
  return sectionTextValues($, heading, 8);
}

function sectionTextValues($: cheerio.CheerioAPI, heading: Parameters<cheerio.CheerioAPI>[0], maxSiblings: number): string[] {
  const values: string[] = [];
  let node = $(heading).next();
  for (let index = 0; index < maxSiblings && node.length; index += 1) {
    if (/^h[1-6]$/i.test(String(node[0]?.tagName ?? ""))) break;
    if (node.is("script,style,noscript")) {
      node = node.next();
      continue;
    }
    if (node.is("a") && /read more|read less|print this page/i.test(cleanText(node.text()))) {
      node = node.next();
      continue;
    }
    const listValues = node
      .find("li")
      .map((_, item) => cleanSectionValue($(item).text()))
      .get()
      .filter(Boolean);
    if (listValues.length) {
      values.push(...listValues);
    } else {
      const text = cleanSectionValue(node.text());
      if (isUsefulSectionValue(text)) values.push(text);
    }
    node = node.next();
  }
  return uniqueStringValues(values.filter(isUsefulSectionValue)).slice(0, 30);
}

function cleanSectionValue(value: string): string {
  return cleanText(value)
    .replace(/\bRead more\b.*$/i, "")
    .replace(/\bRead less\b.*$/i, "")
    .replace(/\bPrint This Page\b.*$/i, "")
    .trim();
}

function isUsefulSectionValue(value: string): value is string {
  const cleaned = cleanText(value);
  return Boolean(cleaned) && cleaned.length <= 300 && !/^(?:yes|no|select|download|view|read more|read less|learn more|print this page|resources?)$/i.test(cleaned);
}

function uniqueStringValues(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function extractCertificationAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const values = new Set<string>();
  // Rendered certification lists (e.g. Rockwell's <ul class="ra-product-new__certification-list">)
  // beat icon alt-text guesses: the list enumerates every approval, the icons only show the top few.
  $("[class*='certification-list'] li, [class*='certifications-list'] li, [class*='approval-list'] li").each((_, element) => {
    const text = cleanText($(element).text());
    if (text) values.add(text);
  });
  $("img[src],img[data-src],img[alt],a[href]").each((_, element) => {
    const context = cleanText(
      [
        $(element).attr("alt"),
        $(element).attr("title"),
        $(element).attr("src"),
        $(element).attr("data-src"),
        $(element).attr("href"),
        $(element).text(),
        $(element).parent().attr("class"),
        $(element).parent().attr("id")
      ]
        .filter(Boolean)
        .join(" ")
    );
    for (const token of certificateTokensFromText(context)) values.add(token);
  });
  return [...values].map((value) => ({
    group: "Certifications",
    name: "Certification",
    value,
    sourceUrl
  }));
}

function extractPlainTextAttributes(text: string, sourceUrl: string): AttributeRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean)
    .filter((line) => !isPlainTextNoiseLine(line));
  const attributes: AttributeRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isPlainTextMarkdownLinkLine(line)) continue;
    const tableMatch = line.match(/^\|?\s*([^|]{2,90})\s+\|\s+([^|]{1,300})\s*\|?$/);
    if (tableMatch) {
      attributes.push({ group: "Plain Text", name: cleanText(tableMatch[1]), value: cleanText(tableMatch[2]), sourceUrl });
      continue;
    }
    const pair = splitNameValue(line);
    if (pair) {
      if (!isInlineSpecSummaryPair(pair)) {
        attributes.push({ group: "Plain Text", ...pair, sourceUrl });
      }
      continue;
    }
    if (isPlainTextLabel(line)) {
      const value = nextPlainTextValue(lines, index + 1);
      if (value) attributes.push({ group: "Plain Text", name: line, value, sourceUrl });
    }
  }
  return dedupeAttributes(attributes).slice(0, 120);
}

function isInlineSpecSummaryPair(pair: { name: string; value: string }): boolean {
  return (
    pair.name.includes(",") &&
    /,\s*(?:rated|nominal|number of|product range|pitch|connection method|mounting|color|gtin|weight|customs tariff)\b/i.test(pair.value)
  );
}

function extractKnownPlainTextSpecAttributes(text: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const normalizedText = text
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean)
    .join(" ");

  for (const match of normalizedText.matchAll(/(?:^|[,.]\s+)([A-Za-z][A-Za-z0-9 /()[\].+-]{2,80}?):\s*([^,;\n]{1,160})/g)) {
    const name = cleanText(match[1]);
    const value = cleanInlineSpecValue(match[2]);
    if (!isKnownInlineSpecLabel(name) || !value) continue;
    attributes.push({ group: "Plain Text Specs", name, value, sourceUrl });
  }

  attributes.push(...extractDelimitedPlainTextSpecAttributes(normalizedText, sourceUrl));

  const fixedPatterns: Array<{
    name: string | ((match: RegExpMatchArray) => string);
    value: (match: RegExpMatchArray) => string;
    pattern: RegExp;
  }> = [
    {
      name: "Nominal current",
      value: (match) => match[1],
      pattern: /\bNominal current(?:\s+I\s*N)?\s+(\d+(?:[.,]\d+)?\s*(?:mA|A|kA))\b/gi
    },
    {
      name: "Nominal voltage",
      value: (match) => match[1],
      pattern: /\bNominal voltage(?:\s+U\s*N)?\s+(\d+(?:[.,]\d+)?\s*(?:mV|V|kV))\b/gi
    },
    {
      name: (match) => `Rated voltage${match[1] ? ` ${cleanText(match[1])}` : ""}`,
      value: (match) => match[2],
      pattern: /\bRated voltage\s*(\([^)]{1,24}\))?\s*(\d+(?:[.,]\d+)?\s*(?:mV|V|kV))\b/gi
    },
    {
      name: "GTIN",
      value: (match) => match[1],
      pattern: /\bGTIN\s+(\d{8,14})\b/gi
    },
    {
      name: (match) => `Weight per piece (${cleanText(match[1])} packing)`,
      value: (match) => match[2],
      pattern: /\bWeight per piece \((including|excluding) packing\)\s*(\d+(?:[.,]\d+)?\s*(?:mg|g|kg|lb|lbs|oz))\b/gi
    },
    {
      name: "Customs tariff number",
      value: (match) => match[1],
      pattern: /\bCustoms tariff number\s+([0-9]{6,12})\b/gi
    },
    {
      name: "Product type",
      value: (match) => match[1],
      pattern: /\bProduct type\s+([A-Za-z][A-Za-z0-9 /().,+-]{2,120}?)(?=\s+Product family\b|\s+Product line\b|\s+Type\b|\s+Number of\b|\s+Pitch\b|$)/gi
    },
    {
      name: "Product family",
      value: (match) => match[1],
      pattern: /\bProduct family\s+([A-Za-z0-9][A-Za-z0-9 /().,+-]{1,80}?)(?=\s+Product line\b|\s+Type\b|\s+Number of\b|\s+Pitch\b|$)/gi
    },
    {
      name: "Product line",
      value: (match) => match[1],
      pattern: /\bProduct line\s+([A-Za-z0-9][A-Za-z0-9 /().,+-]{1,100}?)(?=\s+Type\b|\s+Number of\b|\s+Pitch\b|$)/gi
    },
    {
      name: "Country of origin",
      value: (match) => match[1],
      pattern: /\bCountry of origin\s+([A-Z]{2})\b/g
    },
    {
      name: (match) => `ECLASS-${match[1]}`,
      value: (match) => match[2],
      pattern: /\bECLASS-([0-9]+(?:\.[0-9]+)?)\s+([0-9]{6,10})\b/gi
    },
    {
      name: (match) => `ETIM ${match[1]}`,
      value: (match) => match[2],
      pattern: /\bETIM\s+([0-9]+(?:\.[0-9]+)?)\s+(EC[0-9]{6})\b/gi
    },
    {
      name: (match) => `UNSPSC ${match[1]}`,
      value: (match) => match[2],
      pattern: /\bUNSPSC\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]{6,10})\b/gi
    }
  ];

  for (const entry of fixedPatterns) {
    for (const match of normalizedText.matchAll(entry.pattern)) {
      const name = typeof entry.name === "function" ? entry.name(match) : entry.name;
      const value = cleanInlineSpecValue(entry.value(match));
      if (!name || !value) continue;
      attributes.push({ group: "Plain Text Specs", name, value, sourceUrl });
    }
  }

  const dimensions = normalizedText.match(
    /\bDimensions\s+Width\s+(\d+(?:[.,]\d+)?\s*(?:mm|cm|m|in|inch|inches))\s+Height\s+(\d+(?:[.,]\d+)?\s*(?:mm|cm|m|in|inch|inches))\s+Depth\s+(\d+(?:[.,]\d+)?\s*(?:mm|cm|m|in|inch|inches))\b/i
  );
  if (dimensions) {
    attributes.push(
      { group: "Plain Text Specs", name: "Width", value: cleanInlineSpecValue(dimensions[1]), sourceUrl },
      { group: "Plain Text Specs", name: "Height", value: cleanInlineSpecValue(dimensions[2]), sourceUrl },
      { group: "Plain Text Specs", name: "Depth", value: cleanInlineSpecValue(dimensions[3]), sourceUrl }
    );
  }

  // Drop pairs whose value is a leaked JSON/markup fragment (e.g. a `{"width":"..(mm)","height":"..}`
  // object split as if it were `Name: Value` plain text). Such fragments carry structural tokens that
  // never appear in a real spec value and would otherwise pollute PDT columns (Turck's shop page embeds
  // a dimensions JSON blob that the delimited-label matcher used to mis-read as a "Width" spec).
  return dedupeAttributes(attributes.filter((attr) => !looksLikeStructuredMarkupFragment(attr.value))).slice(0, 120);
}

/**
 * True when a value string carries JSON structural tokens (`":"`, `","`, an escaped quote, or a brace)
 * that only appear when a serialized JSON object leaks into a plain-text spec value. Legitimate spec
 * values use the inch double-prime (e.g. `1.5"`) but never a quote directly adjacent to `:`/`,`. We do
 * NOT reject on stray HTML tags here — cleanInlineSpecValue can leave a harmless trailing `</p>` that
 * the downstream normalizer tolerates, and rejecting those would drop valid values (e.g. "RAL 7035").
 */
function looksLikeStructuredMarkupFragment(value: string | undefined): boolean {
  if (!value) return false;
  return /["'\\]\s*[:,]\s*["']|[:,]\s*["'][A-Za-z]|\\"|[{}]/.test(value);
}

function isKnownInlineSpecLabel(name: string): boolean {
  const normalized = normalizePlainTextSpecLabel(name);
  if (PLAIN_TEXT_INLINE_LABELS.some((label) => normalizePlainTextSpecLabel(label) === normalized)) return true;
  return /^(?:rated|nominal)\s+(?:current|voltage)(?:\s*\([^)]{1,24}\))?$|^(?:nominal\s+)?cross\s+section$|^number\s+of\s+(?:potentials|positions(?:\s+per\s+row)?|solder\s+pins\s+per\s+potential)$|^contact\s+connection\s+type$|^pin\s+layout$|^solder\s+pin(?:\s*\[[^\]]+\])?$|^weight\s+per\s+piece(?:\s*\([^)]{1,40}\))?$/i.test(name);
}

function extractDelimitedPlainTextSpecAttributes(text: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const labelPattern = plainTextInlineLabelPattern();
  const pattern = new RegExp(
    `(?:^|[\\s,;|])(${labelPattern})\\s*(?::|-)?\\s+(.{1,180}?)(?=\\s+(?:${labelPattern})\\s*(?::|-)?\\s+|$)`,
    "gi"
  );
  for (const match of text.matchAll(pattern)) {
    const name = canonicalPlainTextInlineLabel(match[1]);
    const value = cleanDelimitedPlainTextSpecValue(name, match[2]);
    if (!name || !isUsefulDelimitedPlainTextSpecValue(name, value)) continue;
    attributes.push({ group: "Plain Text Specs", name, value, sourceUrl });
  }
  return attributes;
}

function plainTextInlineLabelPattern(): string {
  return PLAIN_TEXT_INLINE_LABELS.map(escapeRegExp).join("|").replace(/\\ /g, "\\s+");
}

function canonicalPlainTextInlineLabel(label: string): string {
  const normalized = normalizePlainTextSpecLabel(label);
  return PLAIN_TEXT_INLINE_LABELS.find((entry) => normalizePlainTextSpecLabel(entry) === normalized) ?? cleanText(label);
}

function normalizePlainTextSpecLabel(label: string): string {
  return cleanText(label).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isUsefulDelimitedPlainTextSpecValue(name: string, value: string): boolean {
  if (!value || value.length > 160) return false;
  if (/^(?:-|n\/?a|not applicable|none)$/i.test(value)) return false;
  if (normalizePlainTextSpecLabel(name) === normalizePlainTextSpecLabel(value)) return false;
  if (PLAIN_TEXT_INLINE_LABELS.some((label) => normalizePlainTextSpecLabel(label) === normalizePlainTextSpecLabel(value))) return false;
  return /[A-Za-z0-9]/.test(value);
}

function cleanDelimitedPlainTextSpecValue(name: string, value: string): string {
  let cleaned = cleanInlineSpecValue(value);
  if (/\bvoltage\b/i.test(name)) {
    cleaned = cleaned.replace(/^(?:U\s*)?N\s+/i, "").replace(/^U\s+N\s+/i, "");
  }
  if (/\bcurrent\b/i.test(name)) {
    cleaned = cleaned.replace(/^(?:I\s*)?N\s+/i, "").replace(/^I\s+N\s+/i, "");
  }
  return cleanInlineSpecValue(cleaned);
}

function cleanInlineSpecValue(value: string): string {
  return cleanText(value)
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\s*(?:## Product details.*|- \[x\].*)$/i, "")
    .replace(/\.$/, "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainTextMarkdownLinkLine(line: string): boolean {
  return /^(?:\*+\s*)?!?\[[^\]]+\]\(https?\s*(?:[:|]\s*)?\/\//i.test(line);
}

function extractPlainTextDocumentLinks(
  text: string,
  sourceUrl: string,
  catalogNumber: string,
  options: GenericParseOptions
): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const match of text.matchAll(/!?\[([^\]]{1,180})\]\(([^)\r\n]{1,1000})\)/g)) {
    const label = cleanText(match[1]);
    const rawUrl = cleanText(match[2]);
    const absolute = toAbsoluteUrl(normalizePlainTextLinkUrl(rawUrl), sourceUrl);
    if (!label || !absolute) continue;
    if (matchesAnyPattern(absolute, options.extractionPolicy?.ignoredDocumentUrlPatterns)) continue;
    const policyDocumentMatch = matchesAnyPattern(absolute, options.extractionPolicy?.documentUrlPatterns);
    const type = classifyDocument(label, absolute);
    if (isUnrelatedPolicyDocument(label, "", absolute, catalogNumber, options)) continue;
    if (
      !isDocumentUrlWithContext(absolute, label, type) &&
      !isLikelyImageUrl(absolute) &&
      !policyDocumentMatch &&
      !isDocumentLikePlainTextLink(label, type)
    ) {
      continue;
    }
    if (
      type === "other" &&
      !policyDocumentMatch &&
      !catalogTextMatches(absolute, catalogNumber, options.match) &&
      !catalogTextMatches(label, catalogNumber, options.match)
    ) {
      continue;
    }
    documents.push({
      type,
      label,
      url: absolute,
      sourceUrl
    });
  }
  return dedupeDocuments(documents).slice(0, 80);
}

function extractHiddenDocumentLinks(
  $: cheerio.CheerioAPI,
  text: string,
  sourceUrl: string,
  catalogNumber: string,
  options: GenericParseOptions
): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const add = (rawUrl: string | undefined, label: string, context: string) => {
    const absolute = rawUrl ? toAbsoluteUrl(normalizePlainTextLinkUrl(rawUrl), sourceUrl) : undefined;
    if (!absolute) return;
    if (matchesAnyPattern(absolute, options.extractionPolicy?.ignoredDocumentUrlPatterns)) return;
    const policyDocumentMatch = matchesAnyPattern(absolute, options.extractionPolicy?.documentUrlPatterns);
    const labelType = classifyDocument(label, absolute);
    const type = labelType === "other" ? classifyDocument(`${label} ${context}`, absolute) : labelType;
    if (!isDocumentUrlWithContext(absolute, `${label} ${context}`, type) && !policyDocumentMatch) return;
    if (isUnrelatedPolicyDocument(label, context, absolute, catalogNumber, options)) return;
    if (
      type === "other" &&
      !policyDocumentMatch &&
      !catalogTextMatches(absolute, catalogNumber, options.match) &&
      !catalogTextMatches(context, catalogNumber, options.match)
    ) {
      return;
    }
    documents.push({
      type,
      label: cleanText(label) || documentLabelFromContext(context, absolute),
      url: absolute,
      sourceUrl
    });
  };

  $("[data-url],[data-href],[data-file],[data-download],[data-document-url],[data-datasheet-url],[data-manual-url],[data-resource-url],a[download],button[formaction],form[action]").each((_, element) => {
    const attrs = element.attribs ?? {};
    const context = cleanText(
      [
        $(element).text(),
        $(element).attr("title"),
        $(element).attr("aria-label"),
        $(element).closest("tr,li,article,.resource,.download,.document,.product,.card").text()
      ]
        .filter(Boolean)
        .join(" ")
    );
    for (const [name, value] of Object.entries(attrs)) {
      if (!/^(?:data-(?:url|href|file|download|document-url|datasheet-url|manual-url|resource-url)|href|action|formaction)$/i.test(name)) continue;
      add(value, labelFromDocumentAttributeName(name, context), context);
    }
  });

  $("meta[content]").each((_, element) => {
    const name = $(element).attr("name") || $(element).attr("property") || "meta";
    add($(element).attr("content"), cleanText(name), cleanText([$("h1").first().text(), $("title").first().text()].filter(Boolean).join(" ")));
  });

  for (const found of findDocumentUrlsInText(text, sourceUrl)) {
    add(found.url, found.label, found.context);
  }

  return dedupeDocuments(documents).slice(0, 100);
}

function labelFromDocumentAttributeName(name: string, context: string): string {
  if (/datasheet/i.test(name)) return "Datasheet";
  if (/manual/i.test(name)) return "Installation manual";
  if (/document|resource|download|file/i.test(name)) return "Document";
  return documentLabelFromContext(context, "");
}

function findDocumentUrlsInText(text: string, sourceUrl: string): Array<{ url: string; label: string; context: string }> {
  const decodedTexts = embeddedJsonSearchTexts(text);
  const found: Array<{ url: string; label: string; context: string }> = [];
  for (const decoded of decodedTexts) {
    const urlPattern = /https?:\/\/[^"'<>\s)]+|\/[a-z0-9][^"'<>\s)]*/gi;
    for (const match of decoded.matchAll(urlPattern)) {
      const rawUrl = match[0].replace(/[\\,.;]+$/g, "");
      const absolute = toAbsoluteUrl(rawUrl, sourceUrl);
      if (!absolute) continue;
      const index = match.index ?? 0;
      const context = cleanText(decoded.slice(Math.max(0, index - 180), Math.min(decoded.length, index + rawUrl.length + 180)));
      const label = documentLabelFromContext(context, absolute);
      const type = classifyDocument(label, absolute);
      if (!isDocumentUrlWithContext(absolute, context, type)) continue;
      found.push({
        url: absolute,
        label,
        context
      });
    }
  }
  return found;
}

function normalizePlainTextLinkUrl(value: string): string {
  return cleanText(value)
    .replace(/^<|>$/g, "")
    .replace(/^(https?)\s*\|\s*\/\//i, "$1://")
    .replace(/^(https?)\s*:\s+\/\//i, "$1://")
    .replace(/\s+/g, "%20");
}

function isDocumentLikePlainTextLink(label: string, type: DocumentRecord["type"]): boolean {
  if (type !== "other") return true;
  return /\b(download|document|datasheet|data sheet|manual|instruction|certificate|declaration|conformity|cad|drawing|spec(?:ification)? sheet|technical)\b/i.test(label);
}

function isPlainTextNoiseLine(line: string): boolean {
  if (/^(login|add to cart|show more|trigger search|browse categories|skip to|home|support|cart)$/i.test(line)) return true;
  if (/^\s*<\s*(?:!doctype|html|head|body|script|style|noscript|iframe|title|link|meta|div|span|button|table|thead|tbody|tr|td|th|a|img|picture|source|svg|symbol|use|path|ul|ol|li|section|article|form|input|h[1-6])\b/i.test(line)) return true;
  if (/^\s*<\/\s*(?:html|head|body|script|style|noscript|iframe|title|div|span|button|table|thead|tbody|tr|td|th|a|picture|svg|symbol|use|ul|ol|li|section|article|form|h[1-6])\s*>/i.test(line)) return true;
  if (/^\s*(?:border|margin|padding|display|position|opacity|filter|background|font|color|width|height|top|left|right|bottom)[\w-]*\s*[:=]/i.test(line)) return true;
  if (/^\s*["']?@(?:context|type|graph|id)["']?\s*[:=]/i.test(line)) return true;
  if (/^\s*["'][\w.:-]+["']\s*:\s*["[{]/.test(line)) return true;
  return false;
}

function isPlainTextLabel(line: string): boolean {
  return /^(article number|product description|product family|product lifecycle|plm effective date|product class|packaging dimensions|package size|net weight|country of origin|commodity code|upc|ean|compliance|certificates?|approvals?|material|dimensions?|weight)$/i.test(
    line.replace(/\s*\(.+\)\s*$/g, "")
  );
}

function nextPlainTextValue(lines: string[], start: number): string | undefined {
  for (let index = start; index < Math.min(lines.length, start + 5); index += 1) {
    const value = lines[index];
    if (!value || /^#+\s/.test(value) || isPlainTextLabel(value)) continue;
    return value;
  }
  return undefined;
}

function certificateTokensFromText(value: string): string[] {
  return uniqueStrings([
    ...(value.match(/\bREACH\b/gi) ?? []),
    ...(value.match(/\bRoHS\b/gi) ?? []),
    ...(value.match(/\bWEEE\b/gi) ?? []),
    ...(value.match(/\bCE\b/g) ?? []),
    ...(value.match(/\bcULus\b/g) ?? []),
    ...(value.match(/\bcURus\b/g) ?? []),
    ...(value.match(/\bcUL\b/g) ?? []),
    ...(value.match(/\bUL\b/g) ?? []),
    ...(value.match(/\bCSA\b/g) ?? []),
    ...(value.match(/\bUKCA\b/g) ?? []),
    // Certification badge icons/links whose visible text is a country-qualified phrase rather than
    // the bare code (confirmed live on Rockwell product pages: alt="Korean KC" / "Australian RCM" /
    // "Eurasian Economic Community") — matched here so they don't fall through as unrecognized
    // noise, and canonicalized to the bare code below to match the shared Rockwell cert allowlist
    // (sanitizeSourceCertifications in eclass-resolvers.ts) that consumes this function's output.
    ...(value.match(/\bKorean\s+KC\b/gi) ?? []),
    ...(value.match(/\bAustralian\s+RCM\b/gi) ?? []),
    ...(value.match(/\bEurasian\s+Economic\s+Community\b/gi) ?? []),
    ...(value.match(/\bATEX\b/g) ?? []),
    ...(value.match(/\bIECEx\b/gi) ?? []),
    ...(value.match(/\bClass\s+I\s+Div\.?\s*2\b/gi) ?? []),
    ...(value.match(/\bNEC\s+Class\s+2\b/gi) ?? []),
    ...(value.match(/\bVDE\b/g) ?? []),
    ...(value.match(/\bT(?:Ü|U)V\b/gi) ?? []),
    ...(value.match(/\bDNV\b/g) ?? []),
    ...(value.match(/\bGOST\b/gi) ?? []),
    ...(value.match(/\bFCC\b/g) ?? []),
    ...(value.match(/\bPED\s+\d{4}\/\d+\/[A-Z]+/gi) ?? []),
    ...(value.match(/\bNEMA(?:\s+Type)?\s+[A-Z0-9, ]+/gi) ?? []),
    ...(value.match(/\bIEC\s+\d+(?:[-\s]\d+)?(?:\s+IP\s*\d{1,2}[A-Z]?)?/g) ?? []),
    ...(value.match(/\bIP\s*\d{1,2}[A-Z]?\b/g) ?? [])
  ].map(canonicalCertificateToken).map(cleanText));
}

function canonicalCertificateToken(value: string): string {
  const cleaned = cleanText(value);
  if (/^reach$/i.test(cleaned)) return "REACH";
  if (/^rohs$/i.test(cleaned)) return "RoHS";
  if (/^weee$/i.test(cleaned)) return "WEEE";
  if (/^ce$/i.test(cleaned)) return "CE";
  if (/^ul$/i.test(cleaned)) return "UL";
  if (/^csa$/i.test(cleaned)) return "CSA";
  if (/^ukca$/i.test(cleaned)) return "UKCA";
  if (/^culus$/i.test(cleaned)) return "cULus";
  if (/^curus$/i.test(cleaned)) return "cURus";
  if (/^cul$/i.test(cleaned)) return "cUL";
  if (/^korean\s+kc$/i.test(cleaned)) return "KC";
  if (/^australian\s+rcm$/i.test(cleaned)) return "RCM";
  if (/^eurasian\s+economic\s+community$/i.test(cleaned)) return "EAC";
  if (/^atex$/i.test(cleaned)) return "ATEX";
  if (/^iecex$/i.test(cleaned)) return "IECEx";
  if (/^class\s+i\s+div\.?\s*2$/i.test(cleaned)) return "Class I Div 2";
  if (/^nec\s+class\s+2$/i.test(cleaned)) return "NEC Class 2";
  if (/^vde$/i.test(cleaned)) return "VDE";
  if (/^t(?:ü|u)v$/i.test(cleaned)) return "TÜV";
  if (/^dnv$/i.test(cleaned)) return "DNV";
  if (/^gost$/i.test(cleaned)) return "GOST";
  if (/^fcc$/i.test(cleaned)) return "FCC";
  return cleaned;
}

function applyExtractionPolicyToAttributes(attributes: AttributeRecord[], policy?: ExtractionPolicyConfig): AttributeRecord[] {
  const aliases = policy?.labelAliases;
  if (!aliases || Object.keys(aliases).length === 0) return attributes;
  const normalizedAliases = new Map(Object.entries(aliases).map(([key, value]) => [labelKey(key), value]));
  return attributes.map((attr) => ({
    ...attr,
    name: normalizedAliases.get(labelKey(attr.name)) ?? attr.name
  }));
}

function matchesAnyPattern(value: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false;
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return value.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

function labelKey(value: string): string {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function fetchHeaders(policy: { userAgent?: string; acceptLanguage?: string; referer?: string }): Record<string, string> | undefined {
  const headers = {
    ...(policy.userAgent ? { "user-agent": policy.userAgent } : {}),
    ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
    ...(policy.referer ? { referer: policy.referer } : {})
  };
  return Object.keys(headers).length ? headers : undefined;
}

function hasEnoughContent(fetched: FetchedText, policy: { minContentLength?: number }): boolean {
  if (fetched.statusCode >= 400) return false;
  return !policy.minContentLength || fetched.text.trim().length >= policy.minContentLength;
}
