import { uniqueStrings } from "../text-util.js";
import * as cheerio from "cheerio";
import type { DocumentRecord, ManufacturerConfig, ScrapeDiagnostics, SourceRecord } from "../../shared/types.js";
import { catalogTextMatches, compactCatalogNumber, fillCatalogTemplate, templateContainsCatalogPlaceholder } from "./catalog-number.js";
import type { FetchedText } from "./http-client.js";
import type { ScrapeContext } from "./types.js";
import { discoverProductLinksWithDiagnostics } from "./link-discovery.js";
import { learnEndpointFromNetworkFetch, learnedEndpointUrls } from "./learned-endpoints.js";
import { discoverSourceDocumentsWithDiagnostics } from "./source-document-discovery.js";

export interface ProductDiscoveryCandidate {
  url: string;
  score: number;
  reason: string;
  stage: "direct-template" | "localized-template" | "learned-endpoint" | "search-result" | "sitemap" | "url-variant";
  sourceType: SourceRecord["sourceType"];
}

export interface ProductDiscoveryResult {
  candidates: ProductDiscoveryCandidate[];
  documentCandidates: DocumentRecord[];
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "rejectedLinks" | "notes">;
}

export async function discoverOfficialProductCandidates(catalogNumber: string, context: ScrapeContext): Promise<ProductDiscoveryResult> {
  const candidates = new Map<string, ProductDiscoveryCandidate>();
  const attemptedUrls: string[] = [];
  const rejectedLinks: NonNullable<ScrapeDiagnostics["rejectedLinks"]> = [];
  const documentCandidates = new Map<string, DocumentRecord>();
  const notes: string[] = [];
  const manufacturer = context.manufacturer;
  const policy = manufacturer.scrapeRecipe?.discoveryPolicy;
  const maxCandidates = policy?.maxCandidates ?? 12;

  const add = (candidate: ProductDiscoveryCandidate) => {
    if (!isAllowedOfficialUrl(candidate.url, manufacturer)) {
      rejectedLinks.push({
        url: candidate.url,
        score: candidate.score,
        reason: `Rejected ${candidate.stage} candidate outside allowed official domains: ${candidate.reason}`
      });
      return;
    }
    const key = canonicalCandidateKey(candidate.url);
    const existing = candidates.get(key);
    if (!existing || candidate.score > existing.score) {
      if (existing) {
        rejectedLinks.push({
          url: existing.url,
          score: existing.score,
          reason: `Replaced duplicate ${existing.stage} candidate with higher-scoring ${candidate.stage} candidate for the same canonical URL`
        });
      }
      candidates.set(key, candidate);
      return;
    }
    rejectedLinks.push({
      url: candidate.url,
      score: candidate.score,
      reason: `Rejected duplicate ${candidate.stage} candidate because an equal or higher-scoring canonical URL was already found`
    });
  };

  const addDocuments = (documents: DocumentRecord[]) => {
    for (const document of documents) {
      if (!isAllowedOfficialUrl(document.url, manufacturer)) {
        rejectedLinks.push({
          url: document.url,
          score: Math.round((document.confidence ?? 0.4) * 100),
          reason: "Rejected discovered document outside allowed official domains"
        });
        continue;
      }
      const key = canonicalCandidateKey(document.url);
      if (!documentCandidates.has(key)) documentCandidates.set(key, document);
    }
  };

  for (const template of officialDirectTemplates(manufacturer)) {
    add({
      url: fillCatalogTemplate(template.urlTemplate, catalogNumber),
      score: template.score,
      reason: template.reason,
      stage: template.stage,
      sourceType: "official-fallback"
    });
  }

  for (const learned of learnedEndpointUrls(manufacturer, catalogNumber, context.learnedEndpoints, Math.min(maxCandidates, 12))) {
    add({
      url: learned.url,
      score: Math.min(96, 86 + Math.min(8, learned.endpoint.successCount)),
      reason: `learned official ${learned.endpoint.parserKind} endpoint (${learned.endpoint.successCount} previous success${learned.endpoint.successCount === 1 ? "" : "es"})`,
      stage: "learned-endpoint",
      sourceType: "official-fallback"
    });
  }

  const configuredSearchUrls = configuredSearchTemplates(manufacturer).map((template) => fillCatalogTemplate(template, catalogNumber));
  const renderedSearchCandidates: string[] = [];
  const processedSearchUrls = new Set<string>();
  let searchedUrlCount = 0;

  const processSearchUrls = async (urls: string[]): Promise<void> => {
    for (const searchUrl of uniqueStrings(urls)) {
      if (searchedUrlCount >= 28) break;
      if (processedSearchUrls.has(searchUrl)) continue;
      processedSearchUrls.add(searchUrl);
      searchedUrlCount += 1;
      attemptedUrls.push(searchUrl);
      let discoveredCount = 0;
      try {
        const fetched = await fetchDiscoveryText(searchUrl, context);
        const discovered = discoverProductLinksWithDiagnostics(fetched.text, fetched.effectiveUrl, catalogNumber);
        rejectedLinks.push(...discovered.rejected);
        const sourceDocuments = discoverSourceDocumentsWithDiagnostics(fetched.text, fetched.effectiveUrl, catalogNumber, {
          sourceType: "official-fallback",
          parser: "official-discovery",
          stage: "search-document"
        });
        addDocuments(sourceDocuments.documents);
        rejectedLinks.push(...sourceDocuments.rejected);
        for (const link of discovered.candidates) {
          discoveredCount += 1;
          add({
            url: link.url,
            score: scoreDiscoveryCandidate(link.url, catalogNumber, "search-result", manufacturer) + Math.min(20, Math.round(link.score / 5)),
            reason: `official search result: ${link.reason}`,
            stage: "search-result",
            sourceType: "official-fallback"
          });
        }
      } catch (error) {
        notes.push(`Search discovery failed for ${searchUrl}: ${formatError(error)}`);
      }
      if (discoveredCount === 0) renderedSearchCandidates.push(searchUrl);
      if (configuredSearchUrls.length && searchedUrlCount >= configuredSearchUrls.length && hasSearchResultCandidate(candidates)) break;
    }
  };

  // Configured + generic search-URL templates first (cheap: no extra page fetch to find a form).
  await processSearchUrls(searchTemplates(manufacturer).map((template) => fillCatalogTemplate(template, catalogNumber)));
  // Fallback for EVERY connector: if templates surfaced no product, auto-discover the site’s real
  // search FORM from the homepage and submit the catalog number to it — i.e. "type it into their
  // search box". Previously this ran only when no search templates were configured, so a broken or
  // renamed configured endpoint disabled on-site search entirely; now it is a universal safety net.
  if (!hasSearchResultCandidate(candidates)) {
    await processSearchUrls(await discoverSearchFormUrls(catalogNumber, context, attemptedUrls, notes));
  }

  if (!hasSearchResultCandidate(candidates) && shouldUseRenderedSearchDiscovery(context)) {
    for (const searchUrl of renderedSearchCandidates.slice(0, 4)) {
      attemptedUrls.push(`browser:${searchUrl}`);
      try {
        const rendered = await context.browserRenderer!.renderProductPage(searchUrl, manufacturer.scrapeRecipe, context.signal);
        const renderedTexts = [
          ...(rendered.fetched ? [rendered.fetched] : []),
          ...rendered.networkTexts.filter((fetched) => /search|suggest|product|catalog|sku|api|json/i.test(`${fetched.effectiveUrl} ${fetched.contentType}`)).slice(0, 8)
        ];
        for (const fetched of renderedTexts) {
          const discovered = discoverProductLinksWithDiagnostics(fetched.text, fetched.effectiveUrl || searchUrl, catalogNumber);
          rejectedLinks.push(...discovered.rejected);
          const isNetworkText = fetched !== rendered.fetched;
          const sourceDocuments = discoverSourceDocumentsWithDiagnostics(fetched.text, fetched.effectiveUrl || searchUrl, catalogNumber, {
            sourceType: "official-fallback",
            parser: "official-discovery",
            stage: isNetworkText ? "rendered-search-network-document" : "rendered-search-document"
          });
          addDocuments(sourceDocuments.documents);
          rejectedLinks.push(...sourceDocuments.rejected);
          if (isNetworkText && discovered.candidates.length) {
            const learned = learnEndpointFromNetworkFetch({
              manufacturer,
              catalogNumber,
              fetched,
              discoveredFromUrl: searchUrl,
              parserKind: "browser-search-network",
              store: context.learnedEndpoints
            });
            if (learned) notes.push(`Learned search/product API endpoint from rendered search: ${fetched.effectiveUrl}`);
          }
          for (const link of discovered.candidates) {
            add({
              url: link.url,
              score: scoreDiscoveryCandidate(link.url, catalogNumber, "search-result", manufacturer) + Math.min(24, 6 + Math.round(link.score / 5)),
              reason: `rendered official search result: ${link.reason}`,
              stage: "search-result",
              sourceType: "official-fallback"
            });
          }
        }
        if (rendered.error) notes.push(`Rendered search discovery failed for ${searchUrl}: ${rendered.error}`);
        if (hasSearchResultCandidate(candidates)) break;
      } catch (error) {
        notes.push(`Rendered search discovery failed for ${searchUrl}: ${formatError(error)}`);
      }
    }
  }

  for (const url of officialVariantUrls(manufacturer, catalogNumber)) {
    add({
      url,
      score: scoreDiscoveryCandidate(url, catalogNumber, "url-variant", manufacturer),
      reason: "official URL variant",
      stage: "url-variant",
      sourceType: "official-fallback"
    });
  }

  if ((policy?.enableRobotsSitemaps ?? true) && candidates.size < Math.max(4, maxCandidates / 2)) {
    for (const url of await discoverFromSitemaps(catalogNumber, context, attemptedUrls, notes)) {
      add({
        url,
        score: scoreDiscoveryCandidate(url, catalogNumber, "sitemap", manufacturer),
        reason: "official sitemap catalog match",
        stage: "sitemap",
        sourceType: "official-fallback"
      });
      if (candidates.size >= maxCandidates) break;
    }
  }

  const sorted = [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.url.length - right.url.length)
    .slice(0, maxCandidates);

  return {
    candidates: sorted,
    documentCandidates: [...documentCandidates.values()].slice(0, 20),
    diagnostics: {
      attemptedUrls,
      discoveredCandidates: sorted.map((candidate) => ({
        url: candidate.url,
        score: candidate.score,
        reason: candidate.reason,
        stage: candidate.stage,
        sourceType: candidate.sourceType
      })),
      rejectedLinks: rejectedLinks.slice(0, 30),
      notes
    }
  };
}

export function scoreDiscoveryCandidate(
  url: string,
  catalogNumber: string,
  stage: ProductDiscoveryCandidate["stage"],
  manufacturer?: ManufacturerConfig
): number {
  let score = stage === "learned-endpoint"
    ? 74
    : stage === "direct-template" || stage === "localized-template"
      ? 70
      : stage === "search-result"
        ? 58
        : stage === "sitemap"
          ? 52
          : 40;
  if (catalogTextMatches(url, catalogNumber, { compact: true, afterColon: true })) score += 30;
  if (pathContainsCatalogSegment(url, catalogNumber)) score += 35;
  if (/\b(product|products|sku|catalog|details?|partnumber|skupage)\b|\/p\//i.test(url)) score += 15;
  if (manufacturer && isAllowedOfficialUrl(url, manufacturer)) score += 10;
  if (/[?&](?:q|query|search|term)=/i.test(url)) score -= 12;
  if (/\.(?:pdf|zip|dwg|dxf|stp|step|png|jpe?g|webp)(?:[?#]|$)/i.test(url)) score -= 45;
  return Math.max(0, Math.min(100, score));
}

function officialDirectTemplates(manufacturer: ManufacturerConfig): Array<{
  urlTemplate: string;
  score: number;
  reason: string;
  stage: ProductDiscoveryCandidate["stage"];
}> {
  return [
    ...(manufacturer.localizedUrlTemplates ?? []).map((template) => ({
      urlTemplate: template.urlTemplate,
      score: 82,
      reason: `${template.locale.toUpperCase()} localized official template`,
      stage: "localized-template" as const
    })),
    ...manufacturer.officialBaseUrls.filter(templateContainsCatalogPlaceholder).map((urlTemplate) => ({
      urlTemplate,
      score: 78,
      reason: "official URL template",
      stage: "direct-template" as const
    })),
    ...manufacturer.fallbackSources
      .filter((source) => source.enabled && source.sourceType === "official-fallback")
      .flatMap((source) =>
        source.directUrlTemplates.map((urlTemplate) => ({
          urlTemplate,
          score: source.confidence ? Math.round(source.confidence * 100) : 68,
          reason: `official configured source: ${source.label}`,
          stage: "direct-template" as const
        }))
      )
  ].filter((template) => templateContainsCatalogPlaceholder(template.urlTemplate));
}

function searchTemplates(manufacturer: ManufacturerConfig): string[] {
  const configured = configuredSearchTemplates(manufacturer);
  return [...new Set([...configured, ...genericOfficialSearchTemplates(manufacturer)])];
}

function configuredSearchTemplates(manufacturer: ManufacturerConfig): string[] {
  return [
    ...(manufacturer.scrapeRecipe?.discoveryPolicy?.searchUrlTemplates ?? []),
    ...(manufacturer.scrapeRecipe?.searchUrlTemplates ?? [])
  ].filter(templateContainsCatalogPlaceholder);
}

function genericOfficialSearchTemplates(manufacturer: ManufacturerConfig): string[] {
  const bases = new Set<string>();
  for (const base of officialUrlBases(manufacturer)) {
    bases.add(base.origin);
    const localePrefix = localePathPrefix(base.segments);
    if (localePrefix) bases.add(`${base.origin}/${localePrefix}`);
  }

  const templates: string[] = [];
  const queryKeys = ["q", "query", "search", "text", "keyword", "searchTerm"];
  for (const base of bases) {
    const cleanBase = base.replace(/\/+$/g, "");
    for (const key of queryKeys) {
      templates.push(`${cleanBase}/search?${key}={part}`);
    }
    templates.push(`${cleanBase}/search/{part}`);
    templates.push(`${cleanBase}/site-search?q={part}`);
  }
  return templates.slice(0, 18);
}

function localePathPrefix(segments: string[]): string | undefined {
  const first = segments[0];
  const second = segments[1];
  if (!first) return undefined;
  if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(first)) return first;
  if (/^[a-z]{2}$/i.test(first) && /^[a-z]{2}$/i.test(second ?? "")) return `${first}/${second}`;
  return undefined;
}

function hasSearchResultCandidate(candidates: Map<string, ProductDiscoveryCandidate>): boolean {
  return [...candidates.values()].some((candidate) => candidate.stage === "search-result");
}

function shouldUseRenderedSearchDiscovery(context: ScrapeContext): boolean {
  if (!context.browserRenderer) return false;
  if (context.browserRenderer.isUnavailable?.()) return false;
  if (context.manufacturer.scrapeRecipe?.fallbackPolicy?.browserOnQualityFailure === false) return false;
  if (context.manufacturer.scrapeRecipe?.fallbackPolicy?.maxBrowserAttempts === 0) return false;
  return true;
}

async function discoverSearchFormUrls(
  catalogNumber: string,
  context: ScrapeContext,
  attemptedUrls: string[],
  notes: string[]
): Promise<string[]> {
  const urls: string[] = [];
  for (const pageUrl of searchFormProbePages(context.manufacturer).slice(0, 4)) {
    attemptedUrls.push(pageUrl);
    try {
      const fetched = await fetchDiscoveryText(pageUrl, context);
      urls.push(...searchUrlsFromForms(fetched.text, fetched.effectiveUrl, catalogNumber));
    } catch (error) {
      notes.push(`Search form discovery failed for ${pageUrl}: ${formatError(error)}`);
    }
  }
  return uniqueStrings(urls).slice(0, 10);
}

function searchFormProbePages(manufacturer: ManufacturerConfig): string[] {
  const pages = new Set<string>();
  for (const base of officialUrlBases(manufacturer)) {
    pages.add(base.origin);
    const localePrefix = localePathPrefix(base.segments);
    if (localePrefix) pages.add(`${base.origin}/${localePrefix}`);
    if (!base.hasCatalogPlaceholder && base.pathname) {
      pages.add(`${base.origin}${base.pathname}`);
    }
  }
  return [...pages].filter((url) => /^https?:\/\//i.test(url));
}

function searchUrlsFromForms(html: string, baseUrl: string, catalogNumber: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $("form").each((_, form) => {
    const method = ($(form).attr("method") || "get").toLowerCase();
    if (method && method !== "get" && method !== "post") return;
    const formContext = cleanFormContext($, form);
    const queryName = searchQueryInputName($, form, formContext);
    if (!queryName) return;
    const action = $(form).attr("action") || baseUrl;
    let target: URL;
    try {
      target = new URL(action, baseUrl);
    } catch {
      return;
    }
    $(form)
      .find("input[type='hidden'][name]")
      .each((__, input) => {
        const name = $(input).attr("name");
        const value = $(input).attr("value");
        if (name && value !== undefined && name !== queryName) target.searchParams.set(name, value);
      });
    target.searchParams.set(queryName, catalogNumber);
    urls.push(target.toString());
  });
  return urls;
}

function cleanFormContext($: cheerio.CheerioAPI, form: Parameters<cheerio.CheerioAPI>[0]): string {
  return [
    $(form).attr("role"),
    $(form).attr("class"),
    $(form).attr("id"),
    $(form).attr("action"),
    $(form).text(),
    $(form).find("input,button").map((_, input) => [$(input).attr("type"), $(input).attr("name"), $(input).attr("id"), $(input).attr("placeholder"), $(input).attr("aria-label"), $(input).attr("value")].filter(Boolean).join(" ")).get().join(" ")
  ]
    .map((value) => String(value ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchQueryInputName($: cheerio.CheerioAPI, form: Parameters<cheerio.CheerioAPI>[0], context: string): string | undefined {
  const hasSearchContext = /\b(search|suche|find|keyword|query|site-search|site search|product search|catalog search|product finder|part finder)\b/i.test(context);
  const inputs = $(form).find("input[name],select[name],textarea[name]").toArray();
  const ranked = inputs
    .map((input) => {
      const name = $(input).attr("name") ?? "";
      const haystack = [name, $(input).attr("type"), $(input).attr("id"), $(input).attr("class"), $(input).attr("placeholder"), $(input).attr("aria-label")].filter(Boolean).join(" ");
      let score = 0;
      if (/^(?:q|s|query|search|text|keyword|searchTerm|term)$/i.test(name)) score += 50;
      if (/\b(?:catalog|catalogue|cat|part|partnumber|part-number|part_number|mpn|sku|article|article-no|articleno|article_number|item|item-no|itemno|product(?:code|id|number)?|model|mlfb)\b/i.test(haystack)) score += 45;
      if (/search/i.test($(input).attr("type") ?? "")) score += 30;
      if (/\b(search|suche|find|keyword|query|term|text)\b/i.test(haystack)) score += 20;
      if (hasSearchContext) score += 10;
      if (/email|mail|zip|postal|country|language|csrf|token|session|password|login/i.test(haystack)) score -= 80;
      return { name, score };
    })
    .filter((item) => item.name && item.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!ranked[0]) return undefined;
  if (!hasSearchContext && ranked[0].score < 40) return undefined;
  return ranked[0].name;
}

function officialVariantUrls(manufacturer: ManufacturerConfig, catalogNumber: string): string[] {
  const urls: string[] = [];
  const variants = urlVariantValues(catalogNumber, manufacturer.scrapeRecipe?.discoveryPolicy?.urlVariants);
  for (const parsed of officialUrlBases(manufacturer)) {
    const base = `${parsed.origin}${parsed.pathname}`;
    for (const variant of variants.slice(0, 5)) {
      if (parsed.pathname) urls.push(`${base}/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/products/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/product/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/search?q=${encodeURIComponent(variant)}`);
    }
  }
  return [...new Set(urls)];
}

function officialUrlBases(manufacturer: ManufacturerConfig): Array<{
  origin: string;
  pathname: string;
  segments: string[];
  hasCatalogPlaceholder: boolean;
}> {
  const bases: Array<{ origin: string; pathname: string; segments: string[]; hasCatalogPlaceholder: boolean }> = [];
  const seen = new Set<string>();
  for (const baseUrl of manufacturer.officialBaseUrls) {
    try {
      const parsed = new URL(baseUrl);
      const rawSegments = parsed.pathname.split("/").filter(Boolean).map((segment) => safeDecode(segment));
      const placeholderIndex = rawSegments.findIndex((segment) => templateContainsCatalogPlaceholder(segment));
      const segments = placeholderIndex >= 0 ? rawSegments.slice(0, placeholderIndex) : rawSegments;
      const pathname = segments.length ? `/${segments.map(encodeURIComponent).join("/")}`.replace(/\/+$/g, "") : "";
      const key = `${parsed.origin}${pathname}|${templateContainsCatalogPlaceholder(baseUrl) ? "template" : "base"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bases.push({
        origin: parsed.origin,
        pathname,
        segments,
        hasCatalogPlaceholder: templateContainsCatalogPlaceholder(baseUrl)
      });
    } catch {
      // Invalid configured URLs are ignored; direct templates already validate elsewhere.
    }
  }
  return bases;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlVariantValues(catalogNumber: string, requested: Array<string> | undefined): string[] {
  const afterColon = catalogNumber.includes(":") ? catalogNumber.split(":").pop() ?? catalogNumber : catalogNumber;
  const all: Record<string, string> = {
    part: catalogNumber,
    partUpper: catalogNumber.toUpperCase(),
    partLower: catalogNumber.toLowerCase(),
    partCompact: compactCatalogNumber(catalogNumber),
    partSnake: catalogNumber.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase(),
    partDash: catalogNumber.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase(),
    partAfterColon: afterColon,
    partAfterColonCompact: compactCatalogNumber(afterColon)
  };
  const keys = requested ? requested : ["part", "partUpper", "partLower", "partCompact", "partAfterColon", "partAfterColonCompact"];
  return [...new Set(keys.map((key) => all[key]).filter(Boolean))];
}

async function discoverFromSitemaps(
  catalogNumber: string,
  context: ScrapeContext,
  attemptedUrls: string[],
  notes: string[]
): Promise<string[]> {
  const manufacturer = context.manufacturer;
  const sitemapUrls = [
    ...(manufacturer.scrapeRecipe?.discoveryPolicy?.sitemapUrls ?? []),
    ...(await robotsSitemapUrls(context, attemptedUrls, notes))
  ];
  const found = new Set<string>();
  const queue = [...new Set(sitemapUrls)].slice(0, 8);
  const compactPart = compactCatalogNumber(catalogNumber);

  while (queue.length && found.size < 12) {
    const sitemapUrl = queue.shift()!;
    attemptedUrls.push(sitemapUrl);
    try {
      const fetched = await fetchDiscoveryText(sitemapUrl, context);
      const locs = extractSitemapLocs(fetched.text);
      for (const loc of locs) {
        if (catalogTextMatches(loc, catalogNumber, { compact: true, afterColon: true }) || compactCatalogNumber(loc).includes(compactPart)) {
          found.add(loc);
          continue;
        }
        if (queue.length < 8 && /sitemap/i.test(loc) && /\b(product|catalog|sku|pim|en|de)\b/i.test(loc)) queue.push(loc);
      }
    } catch (error) {
      notes.push(`Sitemap discovery failed for ${sitemapUrl}: ${formatError(error)}`);
    }
  }
  return [...found].filter((url) => isAllowedOfficialUrl(url, manufacturer));
}

async function robotsSitemapUrls(context: ScrapeContext, attemptedUrls: string[], notes: string[]): Promise<string[]> {
  const urls = new Set<string>();
  for (const origin of officialOrigins(context.manufacturer).slice(0, 3)) {
    const robotsUrl = `${origin}/robots.txt`;
    attemptedUrls.push(robotsUrl);
    try {
      const fetched = await fetchDiscoveryText(robotsUrl, context);
      for (const match of fetched.text.matchAll(/^sitemap:\s*(.+)$/gim)) urls.add(match[1].trim());
    } catch (error) {
      notes.push(`Robots discovery failed for ${robotsUrl}: ${formatError(error)}`);
    }
    urls.add(`${origin}/sitemap.xml`);
  }
  return [...urls];
}

// 24h TTL for discovery indexes (sitemaps, robots.txt, search-result pages). These change
// far more often than individual product pages, so the default 7-day product-page TTL is
// inappropriate — a stale sitemap can hide newly published catalog numbers for days.
const DISCOVERY_INDEX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isDiscoveryIndexUrl(url: string): boolean {
  return /\/sitemap[^/]*\.xml\b|\/robots\.txt\b|[?&](?:q|query|search|text|keyword|searchTerm)=|\/(?:site-)?search(?:\b|[/?])/i.test(url);
}

async function fetchDiscoveryText(url: string, context: ScrapeContext): Promise<FetchedText> {
  const policy = context.manufacturer.fetchPolicy ?? {};
  const indexOverride = isDiscoveryIndexUrl(url) ? DISCOVERY_INDEX_CACHE_TTL_MS : undefined;
  return context.http.fetchText(url, {
    timeoutMs: Math.min(policy.timeoutMs ?? 15000, 30000),
    cacheTtlMs: indexOverride ?? policy.cacheTtlMs,
    maxAttempts: 1,
    headers: {
      ...(policy.userAgent ? { "user-agent": policy.userAgent } : {}),
      ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
      ...(policy.referer ? { referer: policy.referer } : {})
    },
    signal: context.signal
  });
}

function extractSitemapLocs(text: string): string[] {
  return [...text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)]
    .map((match) => decodeXml(match[1].trim()))
    .filter((url) => /^https?:\/\//i.test(url));
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function isAllowedOfficialUrl(url: string, manufacturer: ManufacturerConfig): boolean {
  const allowed = [
    ...(manufacturer.scrapeRecipe?.discoveryPolicy?.allowedOfficialDomains ?? []),
    ...officialOrigins(manufacturer).map((origin) => {
      try {
        return new URL(origin).hostname;
      } catch {
        return origin;
      }
    })
  ].map((host) => host.replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase());

  if (!allowed.length) return true;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return allowed.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
  } catch {
    return false;
  }
}

function officialOrigins(manufacturer: ManufacturerConfig): string[] {
  return [...new Set(manufacturer.officialBaseUrls.flatMap((baseUrl) => {
    try {
      return [new URL(baseUrl).origin];
    } catch {
      return [];
    }
  }))];
}

function canonicalCandidateKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function pathContainsCatalogSegment(url: string, catalogNumber: string): boolean {
  try {
    const compactPart = compactCatalogNumber(catalogNumber);
    return new URL(url).pathname
      .split("/")
      .map((segment) => compactCatalogNumber(decodeURIComponent(segment)))
      .some((segment) => segment === compactPart);
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

