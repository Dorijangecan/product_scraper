import { collapseWhitespace as clean, slugify, uniqueStrings } from "./text-util.js";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type {
  DocumentRecord,
  ManufacturerConfig,
  ManufacturerInspectRequest,
  ManufacturerInspectResult,
  ManufacturerAliasSuggestion,
  ManufacturerTestRequest,
  ManufacturerTestResult,
  ManufacturerTestSampleResult,
  LearnedExtractorProposal,
  ProductResult
} from "../shared/types.js";
import { parseManufacturerConfig } from "./config/manufacturers.js";
import type { ScraperDb } from "./db.js";
import type { AppPaths } from "./paths.js";
import { attachEvidence } from "./scrapers/evidence.js";
import { GenericFallbackScraper } from "./scrapers/generic.js";
import type { CachedHttpClient, FetchedText } from "./scrapers/http-client.js";
import { getConnector } from "./scrapers/index.js";
import { endpointTemplateFromUrl } from "./scrapers/learned-endpoints.js";
import { catalogTextMatches } from "./scrapers/catalog-number.js";
import { finalizeQualityGate } from "./scrapers/quality-gate.js";
import { suggestTechnicalAttributeAlias } from "./scrapers/technical-attribute-aliases.js";
import { enrichResultFromDownloadedDocuments } from "./scrapers/document-enrichment.js";
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
  const samples = cleanSamples(input.sampleCatalogNumbers).slice(0, 3);
  requiredManufacturerSamplePasses(samples.length);
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
  const requiredPasses = requiredManufacturerSamplePasses(samples.length);
  const warnings = foundCount >= requiredPasses
    ? []
    : [`At least ${requiredPasses} of ${samples.length} samples must find an official identity-confirmed product before this manufacturer can be saved.`];
  return {
    passed: foundCount >= requiredPasses,
    foundCount,
    sampleCount: results.length,
    samples: results,
    confirmedSelectorSuggestions: confirmedLearnedExtractorSuggestions(results),
    warnings
  };
}

/** A learned recipe must generalize beyond its pasted example before a user can save it. */
export function requiredManufacturerSamplePasses(sampleCount: number): 2 {
  if (sampleCount < 3) throw new Error("Add three sample catalog numbers to validate a manufacturer recipe.");
  return 2;
}

/** Stable enough to bind an in-memory wizard validation to the configuration that was tested. */
export function wizardValidationKey(manufacturer: ManufacturerConfig): string {
  const parsed = parseManufacturerConfig(manufacturer);
  const hosts = parsed.officialBaseUrls
    .map((url) => {
      try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return url.trim().toLowerCase(); }
    })
    .sort()
    .join(",");
  return `${parsed.id}|${hosts}`;
}

/** A selector from one page may be accidental page furniture.  It is reviewable only after the same
 * narrow recipe appears on two distinct official, identity-confirmed samples in the wizard run. */
export function confirmedLearnedExtractorSuggestions(samples: ManufacturerTestSampleResult[]): LearnedExtractorProposal[] {
  const observed = new Map<string, { proposal: LearnedExtractorProposal; catalogs: Set<string> }>();
  for (const sample of samples) {
    if (!sample.passed || !sample.identityConfirmed) continue;
    for (const proposal of uniqueSelectorSuggestions(sample.selectorSuggestions ?? [])) {
      const key = `${proposal.host}|${proposal.kind}|${proposal.pattern}`.toLowerCase();
      const entry = observed.get(key) ?? { proposal, catalogs: new Set<string>() };
      entry.catalogs.add(sample.catalogNumber);
      observed.set(key, entry);
    }
  }
  return [...observed.values()]
    .filter(({ catalogs }) => catalogs.size >= 2)
    .map(({ proposal }) => proposal)
    .sort((left, right) => `${left.host}|${left.kind}|${left.pattern}`.localeCompare(`${right.host}|${right.kind}|${right.pattern}`));
}

/**
 * Persist only the narrow recipe grammar which page-mining can replay safely. Wizard samples
 * collect candidate signals first; this is intentionally a separate, operator-triggered step.
 */
export function approveWizardLearnedExtractor(
  proposal: LearnedExtractorProposal,
  manufacturer: ManufacturerConfig,
  db: Pick<ScraperDb, "upsertLearnedExtractor">,
  validation?: ManufacturerTestResult
): LearnedExtractorProposal {
  const parsedManufacturer = parseManufacturerConfig(manufacturer);
  if (proposal.manufacturerId !== parsedManufacturer.id) {
    throw new Error("The learned recipe belongs to a different manufacturer.");
  }
  if (!isReplayableRecipe(proposal)) {
    throw new Error("Only reviewed replayable table-row, HTML table-header, or JSON script recipes can be approved from the wizard.");
  }
  const recipeKey = `${proposal.host}|${proposal.kind}|${proposal.pattern}`.toLowerCase();
  const confirmed = validation?.confirmedSelectorSuggestions.some(
    (candidate) => `${candidate.host}|${candidate.kind}|${candidate.pattern}`.toLowerCase() === recipeKey
  );
  if (!validation?.passed || validation.sampleCount < 3 || validation.foundCount < requiredManufacturerSamplePasses(validation.sampleCount) || !confirmed) {
    throw new Error("A confirmed wizard test must reproduce this recipe on two official samples before approval.");
  }
  const source = parseOfficialSourceUrl(proposal.sourceUrl, parsedManufacturer);
  const host = source.hostname.replace(/^www\./, "").toLowerCase();
  if (proposal.host.replace(/^www\./, "").toLowerCase() !== host) {
    throw new Error("The learned recipe host does not match its source URL.");
  }
  const approved: LearnedExtractorProposal = {
    manufacturerId: parsedManufacturer.id,
    host,
    kind: proposal.kind,
    pattern: proposal.pattern,
    sourceUrl: source.toString(),
    parserKind: proposal.parserKind.trim().slice(0, 160) || "wizard-review"
  };
  db.upsertLearnedExtractor(approved);
  return approved;
}

/** Stores reproducible wizard evidence outside the curated ground-truth corpus. */
export async function captureWizardFixture(input: {
  runDir: string;
  manufacturerId: string;
  catalogNumber: string;
  productUrl: string;
  html: string;
}): Promise<string | undefined> {
  if (!catalogTextMatches(input.html, input.catalogNumber, { compact: true, ignoreCase: true, afterColon: true })) return undefined;
  const safeCatalog = input.catalogNumber.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_ .-]+|[_ .-]+$/g, "");
  if (!safeCatalog) return undefined;
  const fixtureDir = path.join(input.runDir, "fixtures", safeCatalog);
  await fs.mkdir(fixtureDir, { recursive: true });
  const pagePath = path.join(fixtureDir, "page.html");
  await fs.writeFile(pagePath, input.html, "utf8");
  await fs.writeFile(path.join(fixtureDir, "case.json"), JSON.stringify({
    manufacturerId: input.manufacturerId,
    catalogNumber: input.catalogNumber,
    productUrl: input.productUrl,
    capturedAt: new Date().toISOString()
  }, null, 2), "utf8");
  return pagePath;
}

/**
 * Turns genuinely unmapped labels into conservative, review-only ontology suggestions.
 * The selected value still comes solely from the deterministic extraction pipeline; a
 * wizard operator must explicitly decide whether a suggestion belongs in the alias table.
 */
export function buildWizardAliasSuggestions(labels: readonly string[], manufacturerId?: string): ManufacturerAliasSuggestion[] {
  const suggestions: ManufacturerAliasSuggestion[] = [];
  for (const label of uniqueStrings(labels.map(clean)).slice(0, 12)) {
    const suggestion = suggestTechnicalAttributeAlias(label, { manufacturerId });
    if (!suggestion || suggestion.score < 0.75) continue;
    suggestions.push({ label, ...suggestion });
  }
  return suggestions.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

/** Download only non-asset documents needed to prove a wizard recipe against its own PDF evidence. */
export async function downloadWizardDocument(
  doc: DocumentRecord,
  catalogNumber: string,
  documentsDir: string,
  http: Pick<CachedHttpClient, "downloadFile">
): Promise<DocumentRecord> {
  if (doc.localPath || doc.downloadStatus === "downloaded") return doc;
  if (doc.enrichable === false || doc.type === "image" || doc.type === "cad") {
    return { ...doc, downloadStatus: "skipped", downloadError: "Not an enrichable PDF document for wizard validation." };
  }
  const urls = uniqueStrings([doc.url, ...(doc.candidateUrls ?? [])]);
  if (!urls.length) return { ...doc, downloadStatus: "skipped", downloadError: "No document URL was supplied." };
  const fileName = `${catalogNumber}-${doc.type}-${slugify(doc.label) || "document"}${wizardDocumentExtension(urls[0])}`;
  let lastError: unknown;
  for (const url of urls) {
    try {
      const localPath = await http.downloadFile(url, documentsDir, fileName);
      return { ...doc, url, localPath, downloadStatus: "downloaded", downloadError: undefined };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ...doc,
    downloadStatus: "failed",
    downloadError: lastError instanceof Error ? lastError.message : "Document download failed for every candidate URL."
  };
}

function wizardDocumentExtension(url: string): string {
  try {
    const extension = path.extname(new URL(url).pathname);
    return /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : ".pdf";
  } catch {
    return ".pdf";
  }
}

async function downloadWizardDocuments(result: ProductResult, catalogNumber: string, documentsDir: string, http: CachedHttpClient): Promise<ProductResult> {
  const documents: DocumentRecord[] = [];
  for (const doc of result.documents.slice(0, 8)) {
    documents.push(await downloadWizardDocument(doc, catalogNumber, documentsDir, http));
  }
  return { ...result, documents };
}

async function testOneSample(
  catalogNumber: string,
  manufacturer: ManufacturerConfig,
  fallback: GenericFallbackScraper,
  browserRenderer: BrowserRenderSession,
  deps: { db: ScraperDb; http: CachedHttpClient; runDir: string; documentsDir: string }
): Promise<ManufacturerTestSampleResult> {
  try {
    const selectorSuggestions: LearnedExtractorProposal[] = [];
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
        upsert: (endpoint: Parameters<ScraperDb["upsertLearnedEndpoint"]>[0]) => deps.db.upsertLearnedEndpoint(endpoint),
        recordFailure: (manufacturerId: string, method: "GET" | "POST", urlTemplate: string) => deps.db.recordLearnedEndpointFailure(manufacturerId as Parameters<ScraperDb["recordLearnedEndpointFailure"]>[0], method, urlTemplate)
      },
      // The wizard's "test" run is how a new manufacturer is validated before saving, so it must
      // exercise the same learning path a real run does — otherwise the recipe is approved on a
      // pipeline that behaves differently from the one that will actually scrape.
      learnedExtractors: {
        list: (manufacturerId: string, host: string, limit?: number) => deps.db.listLearnedExtractors(manufacturerId, host, limit),
        propose: (extractor) => selectorSuggestions.push(extractor)
      },
      targetHealth: {
        record: (observation: Parameters<ScraperDb["recordStageObservation"]>[0]) => deps.db.recordStageObservation(observation),
        get: (manufacturerId: string, stage?: string, host?: string) => deps.db.getTargetHealth(manufacturerId, stage, host)
      },
      fallback: {
        scrape: (part: string, sources: ManufacturerConfig["fallbackSources"]) => fallback.scrape(part, sources)
      },
      downloadDocuments: true,
      saveDocuments: true,
      downloadDocument: (doc: DocumentRecord) => downloadWizardDocument(doc, catalogNumber, deps.documentsDir, deps.http)
    };
    const initial = finalizeQualityGate(await connector.scrape(catalogNumber, context), manufacturer);
    const resolved = initial.qualityGate?.passed
      ? initial
      : await runDeterministicScrapePipeline(initial, catalogNumber, context);
    const downloaded = await downloadWizardDocuments(resolved, catalogNumber, deps.documentsDir, deps.http);
    const enriched = await enrichResultFromDownloadedDocuments(downloaded);
    const result = attachEvidence(finalizeQualityGate(enriched, manufacturer));
    const aliasSuggestions = buildWizardAliasSuggestions((result.diagnostics?.unmappedSpecLabels ?? []).map(({ label }) => label), manufacturer.id);
    const official = isOfficialProductUrl(result.productUrl, manufacturer) || result.sources.some((source) => isOfficialProductUrl(source.url, manufacturer));
    const passed =
      result.status !== "failed" &&
      Boolean(result.qualityGate?.identityConfirmed) &&
      official &&
      ((result.evidence?.length ?? 0) > 0 || result.attributes.length > 0 || result.documents.length > 0);
    let fixturePath: string | undefined;
    if (passed && result.productUrl) {
      try {
        const fetched = await deps.http.fetchText(result.productUrl, { timeoutMs: 20000, maxAttempts: 1 });
        if (/html/i.test(fetched.contentType ?? "")) {
          fixturePath = await captureWizardFixture({ runDir: deps.runDir, manufacturerId: manufacturer.id, catalogNumber, productUrl: fetched.effectiveUrl, html: fetched.text });
        }
      } catch {
        // Fixture capture improves reproducibility but must not invalidate a verified scrape.
      }
    }
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
      fixturePath,
      aliasSuggestions,
      // A mined selector is evidence only when this exact sample also cleared official identity.
      // Failed samples may contain a product comparison, challenge page, or sibling family table.
      selectorSuggestions: passed ? uniqueSelectorSuggestions(selectorSuggestions) : [],
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

function uniqueSelectorSuggestions(values: LearnedExtractorProposal[]): LearnedExtractorProposal[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!isReplayableRecipe(value)) return false;
    const key = `${value.host}|${value.kind}|${value.pattern}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function isReplayableTableRowRecipe(pattern: string): boolean {
  return /^css:table-row:tr(?:#[A-Za-z][\w-]{0,79}|(?:\.[A-Za-z_-][\w-]{0,79}){1,2})$/.test(pattern);
}

/** Mirrors page-mining's matrix-table grammar. The header is input evidence, not a selector: it
 * must be percent-encoded and cleanly decode before the table reader will use it. */
function isReplayableHtmlTableHeaderRecipe(pattern: string): boolean {
  const prefix = "html-table:header-column:";
  if (!pattern.startsWith(prefix)) return false;
  const rest = pattern.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return false;
  const selector = rest.slice(0, separator);
  if (!/^table(?:#[A-Za-z][\w-]{0,79}|(?:\.[A-Za-z_-][\w-]{0,79}){1,2})$/.test(selector)) return false;
  try {
    const header = decodeURIComponent(rest.slice(separator + 1));
    return Boolean(header && header.length <= 180 && clean(header) === header);
  } catch {
    return false;
  }
}

/** Mirrors page-mining's deliberately small replay grammar. A JSON recipe names exactly one stable
 * script ID; it is not a free-form JSONPath or selector supplied by the operator. */
function isReplayableRecipe(value: Pick<LearnedExtractorProposal, "kind" | "pattern">): boolean {
  return (value.kind === "dom-pattern" && (isReplayableTableRowRecipe(value.pattern) || isReplayableHtmlTableHeaderRecipe(value.pattern))) ||
    (value.kind === "json-path" && /^json:script:#[A-Za-z_][\w-]{0,79}$/.test(value.pattern));
}

function parseOfficialSourceUrl(sourceUrl: string, manufacturer: ManufacturerConfig): URL {
  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    throw new Error("The learned recipe source URL is invalid.");
  }
  if (source.protocol !== "https:") throw new Error("The learned recipe source must use HTTPS.");
  const sourceHost = source.hostname.replace(/^www\./, "").toLowerCase();
  const official = manufacturer.officialBaseUrls.some((baseUrl) => {
    try {
      const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "").toLowerCase();
      return sourceHost === baseHost || sourceHost.endsWith(`.${baseHost}`);
    } catch {
      return false;
    }
  });
  if (!official) throw new Error("The learned recipe source is not on an official manufacturer host.");
  return source;
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

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
