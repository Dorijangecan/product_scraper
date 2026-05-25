import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type {
  DocumentRecord,
  ManufacturerConfig,
  ManufacturerInspectRequest,
  ManufacturerInspectResult,
  ManufacturerTestRequest,
  ManufacturerTestResult,
  ManufacturerTestSampleResult
} from "../shared/types.js";
import { parseManufacturerConfig } from "./config/manufacturers.js";
import type { ScraperDb } from "./db.js";
import type { AppPaths } from "./paths.js";
import { attachEvidence } from "./scrapers/evidence.js";
import { GenericFallbackScraper } from "./scrapers/generic.js";
import type { CachedHttpClient, FetchedText } from "./scrapers/http-client.js";
import { getConnector } from "./scrapers/index.js";
import { endpointTemplateFromUrl } from "./scrapers/learned-endpoints.js";
import { finalizeQualityGate } from "./scrapers/quality-gate.js";
import { runDeterministicScrapePipeline } from "./scrapers/deterministic-pipeline.js";
import { BrowserRenderSession } from "./scrapers/browser-renderer.js";
import { templateContainsCatalogPlaceholder } from "./scrapers/catalog-number.js";
import type { ScrapeContext } from "./scrapers/types.js";

const DEFAULT_EXPAND_SELECTORS = [
  "button[aria-expanded='false']",
  "[role='button'][aria-expanded='false']",
  "summary",
  "[role='tab']",
  ".accordion button",
  "button.show-more",
  "button[class*='show']",
  "button:has-text('Downloads')",
  "button:has-text('Technical data')"
];

const DEFAULT_CLOSE_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "button:has-text('Accept all')",
  "button:has-text('I agree')",
  "button:has-text('Akzeptieren')",
  "button[aria-label='Close']"
];

export async function inspectManufacturerDraft(
  input: ManufacturerInspectRequest,
  http: CachedHttpClient
): Promise<ManufacturerInspectResult> {
  const website = normalizeWebsiteUrl(input.websiteUrl);
  const samples = cleanSamples(input.sampleCatalogNumbers);
  if (!samples.length) throw new Error("Add at least one sample catalog number.");

  const parsedWebsite = new URL(website);
  const origin = parsedWebsite.origin;
  const host = parsedWebsite.hostname.replace(/^www\./, "");
  const attemptedUrls: string[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];
  const discoveredProductUrls = new Set<string>();
  const directTemplates = new Set<string>();
  const searchTemplates = new Set<string>();
  const sitemapUrls = new Set<string>();

  for (const sample of samples) {
    const template = endpointTemplateFromUrl(website, sample);
    if (template) {
      directTemplates.add(template);
      reasons.push(`Product URL template inferred from pasted URL for ${sample}.`);
    }
  }

  addCommonSearchTemplates(origin, searchTemplates);

  const homepage = await tryFetchText(http, origin, attemptedUrls, warnings);
  if (homepage) {
    for (const template of extractSearchTemplates(homepage.text, homepage.effectiveUrl)) searchTemplates.add(template);
    reasons.push("Homepage inspected for search forms and product search links.");
  }

  for (const sitemap of await discoverSitemapUrls(http, origin, attemptedUrls, warnings)) sitemapUrls.add(sitemap);
  const sitemapProductUrls = await discoverSampleUrlsFromSitemaps(http, [...sitemapUrls], samples, attemptedUrls, warnings);
  for (const url of sitemapProductUrls) {
    discoveredProductUrls.add(url);
    for (const sample of samples) {
      const template = endpointTemplateFromUrl(url, sample);
      if (template) directTemplates.add(template);
    }
  }
  if (sitemapProductUrls.length) reasons.push(`Found ${sitemapProductUrls.length} sample-looking product URL(s) in sitemaps.`);

  const canonicalName = clean(input.canonicalName) || titleFromHost(host);
  const shortName = (clean(input.shortName) || acronym(canonicalName)).toUpperCase().slice(0, 6);
  const id = slugify(canonicalName || host);
  const allowDistributorFallback = input.allowDistributorFallback === true;
  const directUrlTemplates = [...directTemplates].filter(templateContainsCatalogPlaceholder);
  const searchUrlTemplates = [...searchTemplates].filter(templateContainsCatalogPlaceholder);

  const suggested: ManufacturerConfig = {
    id,
    canonicalName,
    shortName,
    rateLimitMs: 1500,
    officialBaseUrls: uniqueStrings([origin, ...directUrlTemplates]),
    fallbackSources: directUrlTemplates.length
      ? [
          {
            id: `${id}-official-pages`,
            label: `${shortName} official product pages`,
            enabled: true,
            sourceType: "official-fallback",
            directUrlTemplates,
            confidence: 0.74
          }
        ]
      : [],
    fetchPolicy: {
      timeoutMs: 20000,
      maxAttempts: 2,
      acceptLanguage: "en-US,en;q=0.9,de;q=0.6"
    },
    scrapeRecipe: {
      searchUrlTemplates,
      minAttributes: 1,
      dynamicFramework: ["json-ld", "embedded-json", "next", "nuxt", "astro", "livewire", "api"],
      discoveryPolicy: {
        searchUrlTemplates,
        sitemapUrls: [...sitemapUrls].slice(0, 12),
        enableRobotsSitemaps: true,
        allowedOfficialDomains: [host],
        maxCandidates: 16
      },
      interactionPolicy: {
        closeOverlaySelectors: DEFAULT_CLOSE_SELECTORS,
        expandSelectors: DEFAULT_EXPAND_SELECTORS,
        tabSelectors: ["[role='tab']", "button[role='tab']", ".tabs button"],
        downloadSectionSelectors: ["a[href*='download']", "button:has-text('Downloads')", "button:has-text('Documents')"],
        scrollPasses: 2,
        maxClicks: 70,
        networkIdleTimeoutMs: 12000
      },
      extractionPolicy: {
        documentUrlPatterns: ["datasheet|data.?sheet|technical|certificate|declaration|manual|download|cad|step|dwg|dxf"],
        ignoredImageUrlPatterns: ["logo|favicon|sprite|icon|placeholder|spinner|loader"],
        maxRawAttributes: 800,
        maxDocuments: 120
      },
      qualityPolicy: {
        minRawAttributes: 1,
        partialConfidenceCap: 0.74,
        distributorConfidenceCap: 0.45
      },
      fallbackPolicy: {
        officialFirst: true,
        readerOnQualityFailure: true,
        browserOnQualityFailure: true,
        distributorFallback: allowDistributorFallback,
        distributorConfidenceCap: 0.45,
        maxReaderAttempts: 1,
        maxBrowserAttempts: 1
      },
      confidenceRules: {
        foundMinScore: 70,
        partialMaxConfidence: 0.74,
        distributorMaxConfidence: 0.45
      }
    }
  };

  if (!directUrlTemplates.length) warnings.push("No direct product URL template was detected. The test will rely on search and sitemap discovery.");
  if (!searchUrlTemplates.length) warnings.push("No search template was detected from the homepage. Common search URLs were still proposed.");
  if (!sitemapUrls.size) warnings.push("No sitemap was found from robots.txt or /sitemap.xml.");

  return {
    suggested,
    attemptedUrls: uniqueStrings(attemptedUrls),
    discoveredProductUrls: [...discoveredProductUrls].slice(0, 30),
    directUrlTemplates,
    searchUrlTemplates,
    sitemapUrls: [...sitemapUrls],
    reasons: uniqueStrings(reasons),
    warnings: uniqueStrings(warnings)
  };
}

export async function testManufacturerDraft(
  input: ManufacturerTestRequest,
  deps: { db: ScraperDb; http: CachedHttpClient; paths: AppPaths }
): Promise<ManufacturerTestResult> {
  const manufacturer = parseManufacturerConfig(input.manufacturer);
  const samples = cleanSamples(input.sampleCatalogNumbers).slice(0, 5);
  if (!samples.length) throw new Error("Add at least one sample catalog number.");
  const runDir = path.join(deps.paths.outputDir, "_manufacturer-wizard-test");
  const documentsDir = path.join(runDir, "documents");
  await fs.mkdir(documentsDir, { recursive: true });
  const fallback = new GenericFallbackScraper(manufacturer.id, deps.http, manufacturer);
  const browserRenderer = new BrowserRenderSession();
  const results: ManufacturerTestSampleResult[] = [];

  try {
    for (const catalogNumber of samples) {
      results.push(await testOneSample(catalogNumber, manufacturer, fallback, browserRenderer, {
        db: deps.db,
        http: deps.http,
        runDir,
        documentsDir
      }));
    }
  } finally {
    await browserRenderer.close();
  }

  const foundCount = results.filter((result) => result.passed).length;
  const warnings = foundCount
    ? []
    : ["At least one sample must find an official identity-confirmed product before this manufacturer can be saved."];
  return {
    passed: foundCount > 0,
    foundCount,
    sampleCount: results.length,
    samples: results,
    warnings
  };
}

async function testOneSample(
  catalogNumber: string,
  manufacturer: ManufacturerConfig,
  fallback: GenericFallbackScraper,
  browserRenderer: BrowserRenderSession,
  deps: { db: ScraperDb; http: CachedHttpClient; runDir: string; documentsDir: string }
): Promise<ManufacturerTestSampleResult> {
  try {
    const connector = getConnector(manufacturer.id);
    const context: ScrapeContext = {
      http: deps.http,
      manufacturer,
      runDir: deps.runDir,
      documentsDir: deps.documentsDir,
      signal: undefined,
      browserRenderer,
      learnedEndpoints: {
        list: (manufacturerId: string, limit?: number) => deps.db.listLearnedEndpoints(manufacturerId, limit),
        upsert: (endpoint: Parameters<ScraperDb["upsertLearnedEndpoint"]>[0]) => deps.db.upsertLearnedEndpoint(endpoint)
      },
      fallback: {
        scrape: (part: string, sources: ManufacturerConfig["fallbackSources"]) => fallback.scrape(part, sources)
      },
      downloadDocument: async (doc: DocumentRecord) => ({ ...doc, downloadStatus: "skipped" as const })
    };
    const initial = finalizeQualityGate(await connector.scrape(catalogNumber, context), manufacturer);
    const enriched = initial.qualityGate?.passed
      ? initial
      : await runDeterministicScrapePipeline(initial, catalogNumber, context);
    const result = attachEvidence(finalizeQualityGate(enriched, manufacturer));
    const official = isOfficialProductUrl(result.productUrl, manufacturer) || result.sources.some((source) => isOfficialProductUrl(source.url, manufacturer));
    const passed =
      result.status !== "failed" &&
      Boolean(result.qualityGate?.identityConfirmed) &&
      official &&
      ((result.evidence?.length ?? 0) > 0 || result.attributes.length > 0 || result.documents.length > 0);
    return {
      catalogNumber,
      status: result.status,
      passed,
      identityConfirmed: result.qualityGate?.identityConfirmed ?? false,
      productUrl: result.productUrl,
      title: result.title,
      confidence: result.confidence,
      attributes: result.attributes.length,
      documents: result.documents.length,
      evidence: result.evidence?.length ?? 0,
      missing: result.qualityGate?.missing ?? [],
      attemptedUrls: result.diagnostics?.attemptedUrls ?? [],
      reason: passed
        ? "Official product identity confirmed."
        : result.qualityGate?.reason ?? result.error ?? "No official product identity was confirmed."
    };
  } catch (error) {
    return {
      catalogNumber,
      status: "error",
      passed: false,
      identityConfirmed: false,
      confidence: 0,
      attributes: 0,
      documents: 0,
      evidence: 0,
      missing: ["error"],
      attemptedUrls: [],
      reason: error instanceof Error ? error.message : "Unexpected test error"
    };
  }
}

async function discoverSitemapUrls(
  http: CachedHttpClient,
  origin: string,
  attemptedUrls: string[],
  warnings: string[]
): Promise<string[]> {
  const urls = new Set<string>([`${origin}/sitemap.xml`]);
  const robotsUrl = `${origin}/robots.txt`;
  const robots = await tryFetchText(http, robotsUrl, attemptedUrls, warnings);
  if (robots) {
    for (const match of robots.text.matchAll(/^sitemap:\s*(.+)$/gim)) {
      const url = match[1].trim();
      if (/^https?:\/\//i.test(url)) urls.add(url);
    }
  }
  return [...urls].slice(0, 10);
}

async function discoverSampleUrlsFromSitemaps(
  http: CachedHttpClient,
  sitemapUrls: string[],
  samples: string[],
  attemptedUrls: string[],
  warnings: string[]
): Promise<string[]> {
  const found = new Set<string>();
  const queue = [...sitemapUrls].slice(0, 10);
  while (queue.length && found.size < 30) {
    const sitemapUrl = queue.shift()!;
    const fetched = await tryFetchText(http, sitemapUrl, attemptedUrls, warnings);
    if (!fetched) continue;
    for (const loc of extractSitemapLocs(fetched.text)) {
      if (samples.some((sample) => urlLooksLikeSample(loc, sample))) found.add(loc);
      if (queue.length < 12 && /sitemap/i.test(loc) && /product|catalog|pim|sku|article|en|de/i.test(loc)) queue.push(loc);
    }
  }
  return [...found];
}

function extractSearchTemplates(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const templates = new Set<string>();
  $("form").each((_, form) => {
    const action = $(form).attr("action") || baseUrl;
    const method = ($(form).attr("method") || "get").toLowerCase();
    if (method !== "get") return;
    const inputName = $(form)
      .find("input[name]")
      .map((__, input) => $(input).attr("name") ?? "")
      .get()
      .find((name) => /^(q|query|search|searchterm|term|keyword|s)$/i.test(name));
    if (!inputName) return;
    try {
      const parsed = new URL(action, baseUrl);
      parsed.searchParams.set(inputName, "{part}");
      templates.add(parsed.toString());
    } catch {
      // Ignore malformed form actions.
    }
  });
  $("a[href]").each((_, link) => {
    const href = $(link).attr("href");
    const text = `${href ?? ""} ${$(link).text()}`;
    if (!href || !/search|suche|find|product/i.test(text)) return;
    try {
      const parsed = new URL(href, baseUrl);
      if (!/search|suche|find/i.test(parsed.pathname)) return;
      parsed.searchParams.set(parsed.searchParams.has("q") ? "q" : "q", "{part}");
      templates.add(parsed.toString());
    } catch {
      // Ignore malformed links.
    }
  });
  return [...templates].filter(templateContainsCatalogPlaceholder).slice(0, 12);
}

function addCommonSearchTemplates(origin: string, output: Set<string>) {
  output.add(`${origin}/search?q={part}`);
  output.add(`${origin}/search?query={part}`);
  output.add(`${origin}/search/{part}`);
  output.add(`${origin}/?s={part}`);
}

async function tryFetchText(
  http: CachedHttpClient,
  url: string,
  attemptedUrls: string[],
  warnings: string[]
): Promise<FetchedText | undefined> {
  attemptedUrls.push(url);
  try {
    return await http.fetchText(url, {
      timeoutMs: 15000,
      maxAttempts: 1,
      cacheTtlMs: 24 * 60 * 60 * 1000,
      headers: { accept: "text/html,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5" }
    });
  } catch (error) {
    warnings.push(`Could not inspect ${url}: ${error instanceof Error ? error.message : "request failed"}`);
    return undefined;
  }
}

function normalizeWebsiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Official website URL is required.");
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Website URL must be http or https.");
  parsed.hash = "";
  return parsed.toString();
}

function isOfficialProductUrl(url: string | undefined, manufacturer: ManufacturerConfig): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return manufacturer.officialBaseUrls.some((baseUrl) => {
      try {
        const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
        return host === baseHost || host.endsWith(`.${baseHost}`);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function extractSitemapLocs(text: string): string[] {
  return [...text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)]
    .map((match) => decodeXml(match[1].trim()))
    .filter((url) => /^https?:\/\//i.test(url));
}

function urlLooksLikeSample(url: string, sample: string): boolean {
  return compact(url).includes(compact(sample.includes(":") ? sample.split(":").pop() ?? sample : sample));
}

function cleanSamples(values: string[]): string[] {
  return uniqueStrings(values.map(clean).filter(Boolean)).slice(0, 10);
}

function titleFromHost(host: string): string {
  return host
    .replace(/^www\./, "")
    .split(".")
    .filter((part) => part && !/^(com|de|net|org|co|us|eu|hr|ba|rs)$/i.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || host;
}

function acronym(value: string): string {
  const words = value.split(/[^a-z0-9]+/i).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3);
  return words.map((word) => word[0]).join("").slice(0, 4);
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clean(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
