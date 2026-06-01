import type { ManufacturerConfig, ScrapeDiagnostics, SourceRecord } from "../../shared/types.js";
import { catalogTextMatches, compactCatalogNumber, fillCatalogTemplate, templateContainsCatalogPlaceholder } from "./catalog-number.js";
import type { FetchedText } from "./http-client.js";
import type { ScrapeContext } from "./types.js";
import { discoverProductLinksWithDiagnostics } from "./link-discovery.js";
import { learnedEndpointUrls } from "./learned-endpoints.js";

export interface ProductDiscoveryCandidate {
  url: string;
  score: number;
  reason: string;
  stage: "direct-template" | "localized-template" | "learned-endpoint" | "search-result" | "sitemap" | "url-variant";
  sourceType: SourceRecord["sourceType"];
}

export interface ProductDiscoveryResult {
  candidates: ProductDiscoveryCandidate[];
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "rejectedLinks" | "notes">;
}

export async function discoverOfficialProductCandidates(catalogNumber: string, context: ScrapeContext): Promise<ProductDiscoveryResult> {
  const candidates = new Map<string, ProductDiscoveryCandidate>();
  const attemptedUrls: string[] = [];
  const rejectedLinks: NonNullable<ScrapeDiagnostics["rejectedLinks"]> = [];
  const notes: string[] = [];
  const manufacturer = context.manufacturer;
  const policy = manufacturer.scrapeRecipe?.discoveryPolicy;
  const maxCandidates = policy?.maxCandidates ?? 12;

  const add = (candidate: ProductDiscoveryCandidate) => {
    if (!isAllowedOfficialUrl(candidate.url, manufacturer)) return;
    const key = canonicalCandidateKey(candidate.url);
    const existing = candidates.get(key);
    if (!existing || candidate.score > existing.score) candidates.set(key, candidate);
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

  for (const url of officialVariantUrls(manufacturer, catalogNumber)) {
    add({
      url,
      score: scoreDiscoveryCandidate(url, catalogNumber, "url-variant", manufacturer),
      reason: "official URL variant",
      stage: "url-variant",
      sourceType: "official-fallback"
    });
  }

  for (const url of nventRaychemFamilyUrls(manufacturer, catalogNumber)) {
    add({
      url,
      score: 104,
      reason: "nVent RAYCHEM family page inferred from catalog prefix",
      stage: "url-variant",
      sourceType: "official-fallback"
    });
  }

  for (const template of searchTemplates(manufacturer)) {
    if (candidates.size >= maxCandidates) break;
    const searchUrl = fillCatalogTemplate(template, catalogNumber);
    attemptedUrls.push(searchUrl);
    try {
      const fetched = await fetchDiscoveryText(searchUrl, context);
      const discovered = discoverProductLinksWithDiagnostics(fetched.text, fetched.effectiveUrl, catalogNumber);
      rejectedLinks.push(...discovered.rejected);
      for (const link of discovered.candidates) {
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
  return [
    ...(manufacturer.scrapeRecipe?.discoveryPolicy?.searchUrlTemplates ?? []),
    ...(manufacturer.scrapeRecipe?.searchUrlTemplates ?? [])
  ].filter(templateContainsCatalogPlaceholder);
}

function officialVariantUrls(manufacturer: ManufacturerConfig, catalogNumber: string): string[] {
  const urls: string[] = [];
  const variants = urlVariantValues(catalogNumber, manufacturer.scrapeRecipe?.discoveryPolicy?.urlVariants);
  for (const baseUrl of manufacturer.officialBaseUrls) {
    if (templateContainsCatalogPlaceholder(baseUrl)) continue;
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      continue;
    }
    const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/g, "")}`;
    for (const variant of variants.slice(0, 5)) {
      urls.push(`${base}/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/products/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/product/${encodeURIComponent(variant)}`);
      urls.push(`${parsed.origin}/search?q=${encodeURIComponent(variant)}`);
    }
  }
  return [...new Set(urls)];
}

function nventRaychemFamilyUrls(manufacturer: ManufacturerConfig, catalogNumber: string): string[] {
  if (manufacturer.id !== "nvent") return [];
  const slugs = raychemFamilySlugs(catalogNumber);
  return slugs.map((slug) => `https://www.chemelex.com/en-us/raychem/products/${slug}`);
}

function raychemFamilySlugs(catalogNumber: string): string[] {
  const normalized = catalogNumber.toUpperCase();
  const compact = compactCatalogNumber(catalogNumber).toUpperCase();
  const slugs: string[] = [];
  const add = (slug: string) => {
    if (!slugs.includes(slug)) slugs.push(slug);
  };

  if (/\bHWAT[-\s_]*ECO\b/i.test(normalized) || compact.startsWith("HWATECO")) add("hwat-eco-electronic-control-unit");
  if (/\bELEXANT[-\s_]*3500I\b/i.test(normalized) || compact.startsWith("ELEXANT3500I")) add("elexant-3500i-electronic-thermostat");
  if (/\bELEXANT[-\s_]*4010I\b/i.test(normalized) || compact.startsWith("ELEXANT4010I")) add("elexant-4010i-heat-trace-controller");
  if (/\bELEXANT[-\s_]*4020I\b/i.test(normalized) || compact.startsWith("ELEXANT4020I")) add("elexant-4020i-heat-trace-controller");
  if (/\bETS[-\s_]*05\b/i.test(normalized) || compact.startsWith("ETS05")) add("ets-05-electronic-thermostat");
  if (/\bTC[-\s_]*3\b/i.test(normalized) || compact.startsWith("TC3")) add("tc3-mechanical-thermostat");
  if (/\bAMC[-\s_]*F5\b/i.test(normalized) || compact.startsWith("AMCF5")) add("amc-f5-mechanical-thermostat");
  if (/\bAMC[-\s_]*1A\b/i.test(normalized) || compact.startsWith("AMC1A")) add("amc-1a-mechanical-thermostat");
  if (/\bAMC[-\s_]*1B\b/i.test(normalized) || compact.startsWith("AMC1B")) add("amc-1b-mechanical-thermostat");
  if (/\bAMC[-\s_]*1H\b/i.test(normalized) || compact.startsWith("AMC1H")) add("amc-1h-mechanical-thermostat");
  if (/\bAMC[-\s_]*2B[-\s_]*2\b/i.test(normalized) || compact.startsWith("AMC2B2")) add("amc-2b-2-mechanical-thermostat");
  if (/^NGC40IO\b/.test(compact)) add("ngc-40-series-io-module");
  if (/^NGC40BRIDGE\b/.test(compact)) add("ngc-40-series-bridge-module");
  if (/^NGC40PTM\b/.test(compact)) add("ngc-40-series-power-termination-module");
  if (/^NGC40HTC3?\b/.test(compact)) add("ngc-40-series-control-module");
  if (/^NGC40\b/.test(compact)) add("ngc-40-series-control-module");

  if (/^(?:RAYCLIC|RAYCLICSB|RAYCLICE|RAYCLICLE)/.test(compact)) add("rayclic-connection-kit");
  if (/^(?:GT66|GS54|AT180)\b/.test(compact)) add("fixing-tape");
  if (/^(?:ETL|WARNING)/.test(compact)) add("warning-label");
  if (/^MONIPT100260\b/.test(compact)) add("moni-pt100-260-rtd-sensor-for-non-hazardous-areas");

  if (/^\d+XLE[12]/.test(compact) || compact.includes("XLTRACEEDGE")) add("xl-trace-edge-self-regulating-heating-cable");
  if (/^GM[12]XT?\b/.test(compact)) add("icestop-self-regulating-heating-cable");
  if (/(?:^|\D)LBTV\d/i.test(normalized) || compact.includes("LBTV")) add("lbtv-self-regulating-heating-cable");
  if (/(?:^|\D)QTVR\d/i.test(normalized) || compact.includes("QTVR")) add("qtvr-self-regulating-heating-cable");
  if (/(?:^|\D)XTVR\d/i.test(normalized) || compact.includes("XTVR")) add("xtvr-self-regulating-heating-cable");
  if (/(?:^|\D)HTV\d/i.test(normalized) || compact.includes("HTV")) add("htv-self-regulating-heating-cable");
  if (/(?:^|\D)BTV\d/i.test(normalized) || compact.includes("BTV")) add("btv-self-regulating-heating-cable");
  if (/(?:^|\D)VPL\d/i.test(normalized) || compact.includes("VPL")) add("vpl-power-limiting-heating-cable");
  if (/^HWAT(?!ECO)/.test(compact)) add("hwat-self-regulating-heating-cable");

  return slugs;
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
  const keys = requested?.length ? requested : ["part", "partUpper", "partLower", "partCompact", "partAfterColon", "partAfterColonCompact"];
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
  return /\/sitemap[^/]*\.xml\b|\/robots\.txt\b|[?&]q=|\/search(?:\b|[/?])/i.test(url);
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
