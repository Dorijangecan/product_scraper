import { uniqueStrings } from "../text-util.js";
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { PDFParse } from "pdf-parse";
import type { AttributeRecord, DocumentRecord, LocalizedUrlTemplate, ProductResult, ScrapeDiagnostics, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { classifyDocument, cleanText, emptyResult, mergeResults, normalizeFields } from "./normalizer.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { catalogTextMatches, compactCatalogNumber, encodeSlashBraceCatalogPart, fillCatalogTemplate, sameCatalogNumber, templateContainsCatalogPlaceholder } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments as dedupeSharedDocuments } from "./dedupe.js";
import { documentUrlLooksDownloadable, documentUrlLooksRelevant } from "./document-url.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const EATON_PRODUCT_HOST = "www.eaton.com";
const EATON_CHINA_PRODUCT_HOST = "www.eaton.com.cn";
const EATON_PRODUCT_BASE_URL = `https://${EATON_PRODUCT_HOST}/us/en-us/skuPage`;
const EATON_E6_CATALOG_PDF_URL =
  "https://www.eaton.com.cn/content/dam/eaton/products/electrical-circuit-protection/circuit-breakers/e6-series/eaton-e6-catalogue-en-cn.pdf";
const EATON_RAPID_LINK_5X_CATALOG_CN_PDF_URL =
  "https://www.eaton.com.cn/content/dam/eaton/products/industrialcontrols-drives-automation-sensors/en-globalprime/rapid-link-5x/eaton-rapid-link-5x-catalog-zh-cn.pdf";
const EATON_RAPID_LINK_5X_CATALOG_EN_PDF_URL =
  "https://www.eaton.com/content/dam/eaton/products/industrialcontrols-drives-automation-sensors/rapid-link-5x/eaton-rapid-link-5x-catalog-en-us.pdf";
const EATON_SKU_LOCALES = [
  { host: EATON_PRODUCT_HOST, localePath: "at/de-de" },
  { host: EATON_PRODUCT_HOST, localePath: "us/en-us" },
  { host: EATON_PRODUCT_HOST, localePath: "de/de-de" },
  { host: EATON_PRODUCT_HOST, localePath: "gb/en-gb" },
  { host: EATON_PRODUCT_HOST, localePath: "ca/en-gb" },
  { host: EATON_PRODUCT_HOST, localePath: "au/en-gb" },
  { host: EATON_PRODUCT_HOST, localePath: "ae/en-gb" },
  { host: EATON_PRODUCT_HOST, localePath: "no/no-no" },
  { host: EATON_PRODUCT_HOST, localePath: "pl/pl-pl" },
  { host: EATON_PRODUCT_HOST, localePath: "fr/fr-fr" },
  { host: EATON_PRODUCT_HOST, localePath: "it/it-it" },
  { host: EATON_PRODUCT_HOST, localePath: "es/es-es" },
  { host: EATON_CHINA_PRODUCT_HOST, localePath: "cn/zh-cn" }
];
const EATON_SEARCH_LOCALES = [
  { host: EATON_PRODUCT_HOST, localePath: "at/de-de" },
  { host: EATON_PRODUCT_HOST, localePath: "us/en-us" },
  { host: EATON_CHINA_PRODUCT_HOST, localePath: "cn/zh-cn" },
  { host: EATON_PRODUCT_HOST, localePath: "gb/en-gb" },
  { host: EATON_PRODUCT_HOST, localePath: "de/de-de" },
  { host: EATON_PRODUCT_HOST, localePath: "no/no-no" },
  { host: EATON_PRODUCT_HOST, localePath: "fr/fr-fr" },
  { host: EATON_PRODUCT_HOST, localePath: "it/it-it" },
  { host: EATON_PRODUCT_HOST, localePath: "es/es-es" }
];

interface EatonSearchCandidate {
  url: string;
  score: number;
  reason: string;
}

const KNOWN_FIELDS = [
  "Product Length/Depth",
  "Product Diameter",
  "Product Height",
  "Product Width",
  "Product Weight",
  "Catalog Number",
  "Product Name",
  "Certifications",
  "Catalog Notes",
  "Global Catalog",
  "Product Type",
  "Facing Material",
  "Voltage rating",
  "Amperage Rating",
  "Frequency rating",
  "Number of poles",
  "Transmission Type",
  "Clutch Size",
  "Torque rating",
  "Input shaft size",
  "Used with",
  "Material",
  "Series",
  "Model",
  "Size",
  "Type",
  "UPC",
  "SKU",
  "EAN",
  "Model Code",
  "Compliances",
  "Warranty",
  "Frame",
  "Class",
  "Trip Type",
  "Terminals",
  "Battery type",
  "Receptacle",
  "VA rating",
  "Wattage",
  "Output nominal voltage",
  "Input connection",
  "Input nominal voltage",
  "Nominal frequency",
  "Input voltage range",
  "Input frequency range",
  "Communication",
  "Noise level",
  "Temperature range",
  "Relative humidity",
  "Package contents",
  "Standard factory warranty",
  "Extended service plans",
  "Interrupt rating",
  "Interrupt rating range",
  "Features",
  "Special features",
  "Handle color",
  "Mounting",
  "Mounting hardware",
  "Product Category",
  "Circuit breaker type",
  "Circuit breaker frame type",
  "Pre-Damper",
  "Number of Discs",
  "Damper Spring Count",
  "Friction pad count",
  "Portfolio rating",
  "Hydraulic Linkage",
  "Vehicle classification group",
  "Accessory/spare part type",
  "Color",
  "Dimensions - band specification",
  "Rated operation current (Ie)",
  "Rated operational current for specified heat dissipation (In)",
  "Rated operational voltage (Ue) - max",
  "Voltage rating - max",
  "Voltage type",
  "Degree of protection",
  "Material quality",
  "Enclosure color",
  "Surface finishing",
  "RAL-number",
  "Thickness of mounting plate",
  "EL Number",
  "HP rating - max",
  "Frame size",
  "Coil",
  "Coil voltage",
  "Contact configuration",
  "Continuous ampere rating",
  "Operation",
  "Enclosure",
  "Enclosure material",
  "Fuse configuration",
  "Number of wires",
  "NEMA rating",
  "Mounting Method",
  "Wire size",
  "Main circuit breaker",
  "Bus material",
  "Cover",
  "Number of circuits",
  "Number of spaces",
  "Phase",
  "Quantity",
  "Box size",
  "Actuator",
  "Actuator function",
  "Button color",
  "Bezel",
  "Illumination",
  "Environmental rating",
  "Design",
  "Connection",
  "Connection type",
  "Connection type (auxiliary circuit)",
  "Connector",
  "Connector group",
  "Connector type",
  "Connector Style",
  "Connector Plating",
  "Contact Plating",
  "Cable Length",
  "Cable Length Range",
  "Cable Outer Diameter (OD)",
  "Outer Cable Diameter",
  "Cable Jacket Material",
  "Cable Jacket Rating",
  "Cable Jacket Color",
  "Cable Type",
  "Gland type",
  "Thread Size",
  "Thread type",
  "Outer sheath (min/max)",
  "Cable sealing range",
  "SideA Connector1",
  "SideB Connector1",
  "Application",
  "Operating frequency",
  "Overvoltage category",
  "Pollution degree",
  "Protection",
  "Rated impulse withstand voltage (Uimp)",
  "Resistance per pole",
  "Suitable for",
  "Utilization category",
  "Lifespan, mechanical",
  "Rated conditional short-circuit current (Iq)",
  "Static heat dissipation, non-current-dependent Pvs",
  "Shock resistance",
  "Opening diameter",
  "Unlocking method"
].sort((left, right) => right.length - left.length);

// Session-scoped breaker: once Eaton's bot-mitigation makes the first browser render time out,
// we treat the host as render-blocked for the rest of the process and stop spending ~45s on each
// subsequent attempt. This is reset on process exit (per-module), so no caching issue across runs.
const EATON_BROWSER_BLOCKED_COOLDOWN_MS = 1000 * 60 * 30; // 30 minutes
let eatonBrowserBlockedUntil = 0;

function isEatonBrowserBlocked(): boolean {
  return Date.now() < eatonBrowserBlockedUntil;
}

function markEatonBrowserBlocked(reason: string): void {
  eatonBrowserBlockedUntil = Date.now() + EATON_BROWSER_BLOCKED_COOLDOWN_MS;
  debugEaton(`disabling browser render for ${EATON_BROWSER_BLOCKED_COOLDOWN_MS / 60000}min: ${reason}`);
}

function debugEaton(message: string): void {
  if (typeof process !== "undefined" && process.env?.DEBUG_EATON) console.warn(`[eaton] ${message}`);
}

export class EatonConnector implements ManufacturerConnector {
  readonly id = "eaton";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const partNumber = cleanText(catalogNumber) || catalogNumber.trim();
    const candidates = buildEatonProductUrlCandidates(partNumber, context.manufacturer.localizedUrlTemplates);
    const diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes"> = {
      attemptedUrls: [],
      discoveredCandidates: [],
      notes: []
    };
    const cbePdfResult = await scrapeEatonCbeCatalogPdf(partNumber, context, diagnostics);
    if (cbePdfResult) return withEatonDiagnostics(cbePdfResult, diagnostics);
    let result: ProductResult | undefined;
    let attemptedSearchDiscovery = false;
    let searchDiscoveryFoundEvidence = false;
    const runSearchDiscovery = async () => {
      if (attemptedSearchDiscovery) return;
      attemptedSearchDiscovery = true;
      const searchDocuments: DocumentRecord[] = [];
      const searchCandidates = await discoverEatonSearchCandidates(partNumber, context, diagnostics, searchDocuments);
      if (searchCandidates.length > 0 || searchDocuments.length > 0) searchDiscoveryFoundEvidence = true;
      const searchBatches = chunk(searchCandidates.slice(0, 4), 2);
      let earlyOut = false;
      for (const batch of searchBatches) {
        const searchResults = await Promise.all(
          batch.map(async (candidate) => {
            const fetched =
              (await fetchEatonReader(candidate.url, context, { timeoutMs: 12000, waitForSelector: false })) ??
              (await fetchEatonDirectOptional(candidate.url, context));
            if (!fetched) return undefined;
            return { candidate, parsed: parseEatonProductPage(partNumber, fetched, candidate.url, context.manufacturer.localizedUrlTemplates) };
          })
        );
        const parsedSearchResults = searchResults.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.parsed.status !== "failed"));
        const hasExactIdentityResult = parsedSearchResults.some((entry) => hasExactEatonIdentity(entry.parsed, partNumber));
        for (const entry of parsedSearchResults) {
          if (hasExactIdentityResult && !hasExactEatonIdentity(entry.parsed, partNumber)) continue;
          result = mergeEatonResults(result, entry.parsed);
          if (isRichEatonResult(entry.parsed)) earlyOut = true;
        }
        if (earlyOut) break;
      }
      const documentResult = buildEatonDocumentSearchResult(partNumber, searchDocuments);
      if (documentResult) result = mergeEatonResults(result, documentResult);
    };

    // Fan the first batch of direct candidates out in parallel — per-host throttling still
    // staggers requests, but waiting serially on each 5s timeout cost ~20s/item even when
    // every URL 404s. We still merge ALL successful parses (locales surface different fields)
    // and only short-circuit once the merged picture is rich enough.
    const initialDirectResults = await Promise.all(
      candidates.slice(0, 4).map(async (officialUrl) => {
        try {
          const fetched = await context.http.fetchText(officialUrl, { timeoutMs: 5000, maxAttempts: 1, signal: context.signal });
          return { officialUrl, parsed: parseEatonProductPage(partNumber, fetched, officialUrl, context.manufacturer.localizedUrlTemplates) };
        } catch {
          return undefined;
        }
      })
    );
    for (const entry of initialDirectResults) {
      if (!entry) continue;
      if (entry.parsed.status === "failed") continue;
      result = mergeEatonResults(result, entry.parsed);
    }
    if (result && result.status !== "failed" && isRichEatonResult(result)) {
      result = await enrichEatonLocalizedDescriptions(result, context, diagnostics);
      return withEatonDiagnostics(result, diagnostics);
    }

    if (!result || result.status === "failed" || !hasExactEatonIdentity(result, partNumber)) {
      await runSearchDiscovery();
      if (shouldStopAfterEmptyEatonSearch(partNumber, result, attemptedSearchDiscovery, searchDiscoveryFoundEvidence)) {
        return withEatonDiagnostics(
          emptyResult("eaton", partNumber, "Eaton site search did not expose an official CDVRL SKU page or source document for this catalog number."),
          diagnostics
        );
      }
      if (result && result.status !== "failed" && result.documents.some((doc) => doc.stage === "search-document")) {
        return withEatonDiagnostics(result, diagnostics);
      }
      if (result && isRichEatonResult(result)) {
        result = await enrichEatonLocalizedDescriptions(result, context, diagnostics);
        return withEatonDiagnostics(result, diagnostics);
      }
    }

    // Jina's plain markdown snapshot is often Eaton's fastest source-backed path. Try that
    // before any browser-backed render so bot-mitigation does not consume the fixture budget.
    if (candidates[0]) {
      const plainReader = await fetchEatonReader(candidates[0], context, { timeoutMs: 12000, waitForSelector: false });
      if (plainReader) {
        debugEaton(`primary reader parse start ${candidates[0]}`);
        const parseStartedAt = Date.now();
        const parsed = parseEatonProductPage(partNumber, plainReader, candidates[0], context.manufacturer.localizedUrlTemplates);
        debugEaton(
          `primary reader parse done ${Date.now() - parseStartedAt}ms status=${parsed.status} attrs=${parsed.attributes.length} docs=${parsed.documents.length} rich=${isRichEatonResult(parsed)}`
        );
        if (parsed.status !== "failed") result = mergeEatonResults(result, parsed);
        if (result && isRichEatonResult(result)) {
          result = await enrichEatonLocalizedDescriptions(result, context, diagnostics);
          return withEatonDiagnostics(result, diagnostics);
        }
      }
    }

    // Iterate ALL locales via Jina without-wait and MERGE results — different Eaton locales
    // (de/it/no) sometimes surface fields the US page omits (Rated voltage, Frequency rating,
    // approval codes). We keep the original coverage but run 4 in flight per batch, so the
    // wall-clock collapses from ~150s serial to ~12s per batch with the same merged output.
    // Bail only once the merged result is rich.
    const skipSkuReaderSweep = (!result || result.status === "failed") && attemptedSearchDiscovery && !searchDiscoveryFoundEvidence;

    if (!result || result.status === "failed") {
      await runSearchDiscovery();
      if (shouldStopAfterEmptyEatonSearch(partNumber, result, attemptedSearchDiscovery, searchDiscoveryFoundEvidence)) {
        return withEatonDiagnostics(
          emptyResult("eaton", partNumber, "Eaton site search did not expose an official CDVRL SKU page or source document for this catalog number."),
          diagnostics
        );
      }
      if (result && result.status !== "failed" && result.documents.some((doc) => doc.stage === "search-document")) {
        return withEatonDiagnostics(result, diagnostics);
      }
    }

    if ((!result || !isRichEatonResult(result)) && !skipSkuReaderSweep) {
      const localeBatches = chunk(candidates, 4);
      for (const batch of localeBatches) {
        const batchResults = await Promise.all(
          batch.map((officialUrl) =>
            fetchEatonReader(officialUrl, context, { timeoutMs: 12000, waitForSelector: false }).then((fetched) =>
              fetched ? parseEatonProductPage(partNumber, fetched, officialUrl, context.manufacturer.localizedUrlTemplates) : undefined
            )
          )
        );
        for (const parsed of batchResults) {
          if (!parsed || parsed.status === "failed") continue;
          result = mergeEatonResults(result, parsed);
        }
        if (result && isRichEatonResult(result)) break;
      }
    }

    // Search discovery as last resort. Original: 4 URLs × (8s direct + 22s Jina) serial = ~120s.
    // We keep the full coverage of 4 URLs but fan them out in two parallel batches so the
    // wall-clock collapses to ~30s. Each candidate still tries the direct JCR endpoint first
    // and falls back to its Jina mirror only on failure, so quality is identical.
    if (!result || result.status === "failed" || !isRichEatonResult(result)) {
      await runSearchDiscovery();
      if (shouldStopAfterEmptyEatonSearch(partNumber, result, attemptedSearchDiscovery, searchDiscoveryFoundEvidence)) {
        return withEatonDiagnostics(
          emptyResult("eaton", partNumber, "Eaton site search did not expose an official CDVRL SKU page or source document for this catalog number."),
          diagnostics
        );
      }
      if (result && result.status !== "failed" && result.documents.some((doc) => doc.stage === "search-document") && !isRichEatonResult(result)) {
        return withEatonDiagnostics(result, diagnostics);
      }
    }

    // Browser-backed sources are last-resort only: they can recover hydrated spec tables, but
    // they are the slowest and least stable Eaton path under bot checks.
    if (candidates[0] && (!result || !isRichEatonResult(result)) && !skipSkuReaderSweep) {
      const richReader = await fetchEatonReader(candidates[0], context, { timeoutMs: 18000, waitForSelector: true });
      if (richReader) {
        const parsed = parseEatonProductPage(partNumber, richReader, candidates[0], context.manufacturer.localizedUrlTemplates);
        if (parsed.status !== "failed") result = mergeEatonResults(result, parsed);
      }
    }

    if ((!result || !isRichEatonResult(result)) && !skipSkuReaderSweep && context.browserRenderer && !context.browserRenderer.isUnavailable?.() && !isEatonBrowserBlocked()) {
      for (const officialUrl of candidates.slice(0, 2)) {
        const rendered = await renderEatonProductInBrowser(partNumber, officialUrl, context, diagnostics);
        if (!rendered) {
          if (isEatonBrowserBlocked()) break;
          markEatonBrowserBlocked(`first browser attempt failed for ${officialUrl}`);
          break;
        }
        if (rendered.status !== "failed") {
          if (!result || result.status === "failed" || rendered.attributes.length > result.attributes.length) result = rendered;
          if (isRichEatonResult(rendered)) break;
        }
      }
    }

    if (!result || result.status === "failed") {
      const pdfFallback = await scrapeEatonCbeCatalogPdf(partNumber, context, diagnostics);
      if (pdfFallback) result = mergeEatonResults(result, pdfFallback);
    }

    if (result && result.status !== "failed") {
      result = await enrichEatonLocalizedDescriptions(result, context, diagnostics);
      return withEatonDiagnostics(result, diagnostics);
    }

    const { result: fallback, discovery } = await scrapeDiscoveredFallback(partNumber, context, { idPrefix: this.id });
    const recovered = withDiscoveryFallbackDiagnostics(
      fallback ?? result ?? emptyResult("eaton", partNumber, "No Eaton product page could be fetched through Eaton-specific paths or generic official discovery."),
      discovery
    );
    return withEatonDiagnostics(recovered, diagnostics);
  }
}

const EATON_TECH_DATA_FIELDS = ["voltage rating", "rated voltage", "voltage rating - max", "rated operational voltage", "amperage rating", "number of poles", "frame size", "frame", "frequency rating", "trip type", "interrupt rating", "utilization category", "rated impulse withstand voltage", "rated operation current"];
const EATON_RICH_TECH_FIELD_THRESHOLD = 3;
const EATON_RICH_TOTAL_ATTRIBUTE_THRESHOLD = 10;
const EATON_RICH_DOCUMENT_THRESHOLD = 2;

function shouldStopAfterEmptyEatonSearch(
  catalogNumber: string,
  result: ProductResult | undefined,
  attemptedSearchDiscovery: boolean,
  searchDiscoveryFoundEvidence: boolean
): boolean {
  return isEatonCdvrlCatalogNumber(catalogNumber) && attemptedSearchDiscovery && !searchDiscoveryFoundEvidence && (!result || result.status === "failed" || !hasExactEatonIdentity(result, catalogNumber));
}

function isEatonCdvrlCatalogNumber(catalogNumber: string): boolean {
  return /^CDVRL\d{5}$/i.test(cleanText(catalogNumber));
}

function mergeEatonResults(primary: ProductResult | undefined, incoming: ProductResult): ProductResult {
  if (!primary || primary.status === "failed") return incoming;
  const primaryIsEnglish = hasEnglishEatonSource(primary);
  const incomingIsEnglish = hasEnglishEatonSource(incoming);
  if (primaryIsEnglish !== incomingIsEnglish) {
    const [base, addition] = primaryIsEnglish ? [primary, incoming] : [incoming, primary];
    return mergeResults(base, addition);
  }
  // Prefer attribute-richer result as the "primary" side of the merge so its title/description win.
  const [base, addition] = incoming.attributes.length > primary.attributes.length ? [incoming, primary] : [primary, incoming];
  return mergeResults(base, addition);
}

function hasEnglishEatonSource(result: ProductResult): boolean {
  return result.sources
    .map((source) => source.url)
    .filter((url): url is string => Boolean(url))
    .some(isEnglishEatonUrl);
}

function hasExactEatonIdentity(result: ProductResult, catalogNumber: string): boolean {
  if (result.productUrl && eatonSkuPathMatches(result.productUrl, catalogNumber)) return true;
  return result.attributes.some((attr) => {
    if (!/\b(?:catalog\s*number|model\s*code|global\s*catalog)\b/i.test(`${attr.group ?? ""} ${attr.name}`)) return false;
    return sameCatalogNumber(attr.value, catalogNumber, { compact: true, afterColon: true, ignoreCase: true });
  });
}

function eatonSkuPathMatches(url: string, catalogNumber: string): boolean {
  try {
    const match = new URL(url).pathname.match(/\/skuPage\.([^/]+?)\.html$/i);
    return Boolean(match?.[1] && sameCatalogNumber(decodeURIComponent(match[1]), catalogNumber, { compact: true, afterColon: true, ignoreCase: true }));
  } catch {
    return false;
  }
}

function isRichEatonResult(result: ProductResult): boolean {
  const haystack = result.attributes.map((attr) => `${attr.name}`.toLowerCase()).join("|");
  const techMatches = EATON_TECH_DATA_FIELDS.filter((field) => haystack.includes(field)).length;
  // Need a meaningful number of tech-data hits AND a respectable attribute count, OR a thick
  // attribute set with at least one tech field, OR document coverage. This stops the pipeline
  // bailing out early on a result that only mentions e.g. "Amperage Rating" with nothing else.
  if (techMatches >= EATON_RICH_TECH_FIELD_THRESHOLD) return true;
  if (techMatches >= 1 && result.attributes.length >= EATON_RICH_TOTAL_ATTRIBUTE_THRESHOLD) return true;
  if (result.documents.filter((doc) => doc.type === "datasheet" || doc.type === "cad" || doc.type === "manual").length >= EATON_RICH_DOCUMENT_THRESHOLD && result.attributes.length >= EATON_RICH_TOTAL_ATTRIBUTE_THRESHOLD) return true;
  return false;
}

const EATON_BROWSER_RECIPE = {
  interactionPolicy: {
    networkIdleTimeoutMs: 12000,
    // "domcontentloaded" waits past TLS+initial HTML so cookie banners / spec tables can mount,
    // unlike "commit" which gives up before Eaton's bot-mitigation completes the response.
    gotoWaitUntil: "domcontentloaded" as const,
    gotoTimeoutMs: 45000,
    blockResourceTypes: ["image", "media", "font"] as const,
    scrollPasses: 3,
    maxClicks: 40,
    closeOverlaySelectors: [
      "#onetrust-accept-btn-handler",
      "button#onetrust-accept-btn-handler",
      "button:has-text('Accept all cookies')",
      "button:has-text('Accept All Cookies')",
      "button:has-text('Accept all')",
      "button:has-text('I accept')",
      "button:has-text('Akzeptieren')",
      "button:has-text('Alle Cookies akzeptieren')"
    ],
    expandSelectors: [
      "button:has-text('Technical data')",
      "button:has-text('Technische Daten')",
      "button:has-text('Specifications')",
      "button:has-text('Spezifikationen')",
      "button:has-text('Caractéristiques')",
      "button:has-text('General specifications')",
      "button:has-text('Performance Ratings')",
      "button:has-text('Physical Attributes')",
      "button:has-text('Show more')",
      "button:has-text('Show all')",
      "button:has-text('Mehr anzeigen')",
      ".product-specification-item__title button",
      ".product-specification-item__title[aria-expanded='false']",
      "[aria-controls*='specification']",
      "button[data-toggle][aria-expanded='false']"
    ],
    waitForSelectors: [
      ".product-specification-item",
      ".specification-row",
      ".specification-title",
      ".module-product-detail-card-v2__title"
    ]
  }
} as unknown as Parameters<NonNullable<ScrapeContext["browserRenderer"]>["renderProductPage"]>[1];

async function renderEatonProductInBrowser(
  catalogNumber: string,
  officialUrl: string,
  context: ScrapeContext,
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes">
): Promise<ProductResult | undefined> {
  if (!context.browserRenderer) return undefined;
  diagnostics.attemptedUrls?.push(`browser:${officialUrl}`);
  try {
    const rendered = await context.browserRenderer.renderProductPage(officialUrl, EATON_BROWSER_RECIPE, context.signal);
    if (rendered.error || !rendered.fetched) {
      if (rendered.error) diagnostics.notes?.push(`Eaton browser render failed for ${officialUrl}: ${rendered.error}`);
      return undefined;
    }
    const parsed = parseEatonProductPage(catalogNumber, rendered.fetched, officialUrl, context.manufacturer.localizedUrlTemplates);
    if (parsed.status === "failed") return undefined;
    parsed.sources = parsed.sources.map((source) => ({
      ...source,
      parser: source.parser ?? "eaton-browser-render",
      stage: source.stage ?? "browser-render"
    }));
    parsed.attributes = parsed.attributes.map((attr) => ({ ...attr, stage: attr.stage ?? "browser-render" }));
    parsed.documents = parsed.documents.map((doc) => ({ ...doc, stage: doc.stage ?? "browser-render" }));
    return parsed;
  } catch (error) {
    diagnostics.notes?.push(`Eaton browser render exception for ${officialUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function encodeEatonSkuPart(catalogNumber: string): string {
  return encodeSlashBraceCatalogPart(cleanText(catalogNumber) || catalogNumber.trim());
}

export function buildEatonSkuPageUrl(catalogNumber: string, localePath = "us/en-us", host = EATON_PRODUCT_HOST): string {
  return `https://${host}/${localePath}/skuPage.${encodeEatonSkuPart(catalogNumber)}.html`;
}

function eatonSkuFromProductUrl(url: string): string | undefined {
  try {
    const match = new URL(url).pathname.match(/\/skuPage\.([^/]+?)\.html$/i);
    return match ? decodeUrlPart(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function canonicalEatonEnglishProductUrl(url: string): string | undefined {
  const sku = eatonSkuFromProductUrl(url);
  return sku ? buildEatonSkuPageUrl(sku, "us/en-us") : undefined;
}

export function buildEatonProductUrlCandidates(catalogNumber: string, localizedUrlTemplates?: LocalizedUrlTemplate[]): string[] {
  const partNumber = cleanText(catalogNumber) || catalogNumber.trim();
  const catalogNumbers = /^5\d{5}$/.test(partNumber) ? [`EP-${partNumber}`, partNumber] : [partNumber];
  const urls = [
    ...catalogNumbers.flatMap((part) =>
      (localizedUrlTemplates ?? [])
        .filter((template) => templateContainsCatalogPlaceholder(template.urlTemplate))
        .map((template) => fillCatalogTemplate(template.urlTemplate, part))
    ),
    ...catalogNumbers.flatMap((part) => EATON_SKU_LOCALES.map((locale) => buildEatonSkuPageUrl(part, locale.localePath, locale.host)))
  ];
  return [...new Set(urls.filter(isAllowedEatonProductUrl))];
}

export function buildEatonSearchApiUrl(catalogNumber: string, localePath = "us/en-us", host = EATON_PRODUCT_HOST): string {
  const partNumber = cleanText(catalogNumber) || catalogNumber.trim();
  return `https://${host}/content/eaton/${localePath}/site-search/jcr:content/root/responsivegrid/search_results.searchTerm$${encodeURIComponent(partNumber)}.SortBy$relevance.Facets$.startDate$.endDate$.loadMore$.json`;
}

export function buildEatonSearchApiUrlCandidates(catalogNumber: string, configuredTemplates: string[] = []): string[] {
  const partNumber = cleanText(catalogNumber) || catalogNumber.trim();
  const configured = configuredTemplates
    .filter(templateContainsCatalogPlaceholder)
    .map((template) => fillCatalogTemplate(template, partNumber));
  return [...new Set([...configured, ...EATON_SEARCH_LOCALES.map((locale) => buildEatonSearchApiUrl(partNumber, locale.localePath, locale.host))])]
    .filter(isAllowedEatonProductUrl);
}

export function extractEatonSearchCandidates(text: string, baseUrl: string, catalogNumber: string): EatonSearchCandidate[] {
  const candidates = new Map<string, EatonSearchCandidate>();
  const add = (rawUrl: unknown, context: string, reason: string, baseScore: number) => {
    const url = typeof rawUrl === "string" ? normalizeEatonSearchProductUrl(rawUrl, baseUrl) : undefined;
    if (!url) return;
    const score = scoreEatonSearchCandidate(url, context, catalogNumber, baseScore);
    const key = url.toLowerCase();
    const existing = candidates.get(key);
    if (!existing || score > existing.score) candidates.set(key, { url, score, reason });
  };

  try {
    const parsed = JSON.parse(text) as unknown;
    for (const item of findEatonSearchResultItems(parsed)) {
      const context = cleanText([
        item.title,
        item.description,
        item.contentType,
        item.url,
        item.completeUrl,
        item.elNumber,
        item.modelCode,
        item.catalogNumber,
        item.statusBadge && typeof item.statusBadge === "object" ? Object.values(item.statusBadge).join(" ") : undefined,
        ...readSecondaryLinkText(item)
      ].filter(Boolean).join(" "));
      const isSku = /^sku$/i.test(String(item.contentType ?? ""));
      add(item.completeUrl, context, isSku ? "Eaton site-search SKU result" : "Eaton site-search result", isSku ? 72 : 42);
      add(item.url, context, isSku ? "Eaton site-search SKU content path" : "Eaton site-search content path", isSku ? 64 : 35);
      for (const link of readSecondaryLinks(item)) add(link.url, `${context} ${link.text ?? ""}`, "Eaton site-search secondary link", isSku ? 58 : 32);
    }
  } catch {
    for (const match of text.replace(/\\\//g, "/").matchAll(/https?:\/\/www\.eaton\.com\/[^"'<>\s)]+\/skuPage\.[^"'<>\s)]+\.html/gi)) {
      add(match[0], match[0], "Eaton site-search inline SKU URL", 45);
    }
  }

  return [...candidates.values()]
    .sort((left, right) => right.score - left.score || left.url.length - right.url.length)
    .slice(0, 12);
}

function extractEatonSearchDocuments(text: string, baseUrl: string, catalogNumber: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const baseUrlConfirmsCatalog = catalogTextMatches(baseUrl, catalogNumber, { compact: true, afterColon: true, ignoreCase: true });
  const push = (rawUrl: unknown, rawLabel: unknown, rawContext: unknown) => {
    const url = typeof rawUrl === "string" ? toAbsoluteUrl(rawUrl.trim().replace(/\\u002f/gi, "/").replace(/&amp;/gi, "&"), baseUrl) : undefined;
    if (!url) return;
    const label = cleanText(String(rawLabel ?? "")) || documentLabelFromEatonSearchUrl(url);
    const context = cleanText([label, rawContext, url].filter(Boolean).join(" "));
    if (!catalogTextMatches(context, catalogNumber, { compact: true, afterColon: true, ignoreCase: true }) && !baseUrlConfirmsCatalog) return;
    if (!isEatonDocumentLink(context, url, catalogNumber)) return;
    documents.push({
      type: classifyEatonDocument(label || context, url),
      label: normalizeEatonDocumentLabel(label || documentLabelFromEatonSearchUrl(url), url),
      url,
      sourceUrl: baseUrl,
      sourceType: "official-fallback",
      parser: "eaton-search",
      stage: "search-document",
      confidence: 0.72
    });
  };

  try {
    const parsed = JSON.parse(text) as unknown;
    for (const item of findEatonSearchResultItems(parsed)) {
      const context = cleanText([
        item.title,
        item.description,
        item.contentType,
        item.url,
        item.completeUrl,
        item.elNumber,
        item.modelCode,
        item.catalogNumber,
        ...readSecondaryLinkText(item)
      ].filter(Boolean).join(" "));
      push(item.completeUrl, item.title, context);
      push(item.url, item.title, context);
      for (const link of readSecondaryLinks(item)) push(link.url, link.text ?? item.title, context);
    }
  } catch {
    const normalized = text.replace(/\\\//g, "/");
    for (const match of normalized.matchAll(/https?:\/\/(?:www\.)?eaton\.com(?:\.cn)?\/[^"'<>\s)]+(?:\.pdf|format=pdf|documentId=|docId=)[^"'<>\s)]*/gi)) {
      const index = match.index ?? 0;
      const context = cleanText(normalized.slice(Math.max(0, index - 240), Math.min(normalized.length, index + match[0].length + 240)));
      push(match[0], documentLabelFromEatonSearchUrl(match[0]), context);
    }
  }

  return dedupeDocuments(documents)
    .filter((doc) => doc.type === "datasheet" || doc.type === "manual" || doc.type === "other")
    .slice(0, 6);
}

function buildEatonDocumentSearchResult(catalogNumber: string, documents: DocumentRecord[]): ProductResult | undefined {
  const cleanDocuments = prioritizeEatonSearchDocuments(dedupeDocuments(documents)).slice(0, 6);
  if (!cleanDocuments.length) return undefined;
  const attributes: AttributeRecord[] = [
    {
      group: "Eaton Search",
      name: "Catalog Number",
      value: catalogNumber,
      sourceUrl: cleanDocuments[0].sourceUrl ?? cleanDocuments[0].url,
      sourceType: "official-fallback",
      parser: "eaton-search",
      stage: "search-document",
      confidence: 0.72
    }
  ];
  return {
    manufacturerId: "eaton",
    catalogNumber,
    status: "partial",
    confidence: 0.62,
    productUrl: cleanDocuments[0].sourceUrl ?? cleanDocuments[0].url,
    title: `${catalogNumber} - Eaton document search`,
    description: `Eaton search found source documents for ${catalogNumber}.`,
    normalized: normalizeFields(attributes, cleanDocuments),
    attributes,
    documents: cleanDocuments,
    sources: [
      {
        url: cleanDocuments[0].sourceUrl ?? cleanDocuments[0].url,
        sourceType: "official-fallback",
        parser: "eaton-search",
        parserVersion: "eaton-v2",
        fetchedAt: new Date().toISOString()
      }
    ],
    diagnostics: {
      fallbackStages: ["eaton-search-documents"],
      notes: [`Eaton SKU pages did not expose a usable product page; using ${cleanDocuments.length} search document candidate(s).`]
    }
  };
}

function prioritizeEatonSearchDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return [...documents].sort((left, right) => eatonSearchDocumentScore(right) - eatonSearchDocumentScore(left));
}

function eatonSearchDocumentScore(doc: DocumentRecord): number {
  const text = `${doc.type} ${doc.label} ${doc.url}`.toLowerCase();
  let score = 0;
  if (doc.type === "datasheet") score += 100;
  if (doc.type === "manual") score += 70;
  if (/\b(?:catalog|catalogue|sample|datasheet|data\s*sheet|technical|spec(?:ification)?)\b/i.test(text)) score += 35;
  if (/\b(?:installation|instruction|manual|user\s*manual)\b/i.test(text)) score += 10;
  if (/\b(?:certificate|declaration|rohs|reach|warranty)\b/i.test(text)) score -= 40;
  return score;
}

function documentLabelFromEatonSearchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = decodeUrlPart(parsed.pathname.split("/").pop() ?? "");
    return cleanText(filename.replace(/\.(?:pdf|zip|dwg|dxf|stp|step)$/i, "").replace(/[-_]+/g, " ")) || "Eaton document";
  } catch {
    return "Eaton document";
  }
}

function buildEatonReaderUrl(officialUrl: string): string {
  return `https://r.jina.ai/http://${officialUrl.replace(/^https?:\/\//i, "")}`;
}

function stripJinaTextPreamble(text: string): string {
  // Jina prepends "Title: …\n\nURL Source: …\n\nMarkdown Content:\n" before the proxied body.
  // For JSON endpoints we want the raw body so JSON.parse can succeed.
  const marker = text.indexOf("Markdown Content:");
  if (marker < 0) return text;
  return text.slice(marker + "Markdown Content:".length).trimStart();
}

async function fetchEatonReader(
  officialUrl: string,
  context: ScrapeContext,
  options: { timeoutMs: number; waitForSelector: boolean }
): Promise<FetchedText | undefined> {
  // The "x-engine: browser" + "x-wait-for-selector" combo asks Jina's headless reader
  // to wait until Eaton's client-side spec table has rendered before snapshotting.
  // Without this, Jina returns the SPA shell and we miss Voltage rating, Number of poles, etc.
  const headers: Record<string, string> = { accept: "text/markdown,text/plain,*/*" };
  if (options.waitForSelector) {
    headers["x-engine"] = "browser";
    headers["x-wait-for-selector"] = ".specification-row, .product-specification-item, .specification-title";
    headers["x-timeout"] = "30";
  }
  const startedAt = Date.now();
  const mode = options.waitForSelector ? "reader-render" : "reader";
  try {
    const fetched = await context.http.fetchText(buildEatonReaderUrl(officialUrl), {
      timeoutMs: options.timeoutMs,
      maxAttempts: 1,
      signal: context.signal,
      headers
    });
    debugEaton(`${mode} ${officialUrl} ok ${Date.now() - startedAt}ms ${fetched.text.length} chars`);
    return fetched;
  } catch {
    debugEaton(`${mode} ${officialUrl} failed ${Date.now() - startedAt}ms`);
    return undefined;
  }
}

async function fetchEatonDirectOptional(url: string, context: ScrapeContext): Promise<FetchedText | undefined> {
  try {
    return await context.http.fetchText(url, {
      timeoutMs: 12000,
      maxAttempts: 1,
      signal: context.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,*/*;q=0.8",
        referer: "https://www.eaton.com/"
      }
    });
  } catch {
    return undefined;
  }
}

async function discoverEatonSearchCandidates(
  catalogNumber: string,
  context: ScrapeContext,
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes">,
  documentSink?: DocumentRecord[]
): Promise<EatonSearchCandidate[]> {
  const configuredTemplates = [
    ...(context.manufacturer.scrapeRecipe?.discoveryPolicy?.searchUrlTemplates ?? []),
    ...(context.manufacturer.scrapeRecipe?.searchUrlTemplates ?? [])
  ];
  const searchUrls = buildEatonSearchApiUrlCandidates(catalogNumber, configuredTemplates);
  const byUrl = new Map<string, EatonSearchCandidate>();

  if (documentSink) {
    const fastDocumentUrls = searchUrls.filter(isEatonFastDocumentSearchUrl);
    await Promise.all(fastDocumentUrls.map((searchUrl) => searchEatonSearchUrl(searchUrl, catalogNumber, context, diagnostics, byUrl, documentSink)));
    if (documentSink.length > 0) {
      return [...byUrl.values()].sort((left, right) => right.score - left.score || left.url.length - right.url.length);
    }
    if (fastDocumentUrls.length > 0 && isEatonCdvrlCatalogNumber(catalogNumber) && byUrl.size === 0) {
      const familyDocuments = eatonRapidLinkFamilyDocuments(catalogNumber, fastDocumentUrls[0]);
      if (familyDocuments.length) {
        documentSink.push(...familyDocuments);
        diagnostics.notes?.push("Eaton China search returned no exact CDVRL hit; using official Rapid Link 5X family catalog for source-backed extraction.");
        return [];
      }
      diagnostics.notes?.push("Eaton China document search returned no CDVRL source documents; skipped slower locale search sweep for this Rapid Link catalog number.");
      return [];
    }
  }

  // Fan the first four search URLs out in parallel; each one tries the direct JCR endpoint
  // first and falls back to its Jina mirror only when the direct call fails. Previously this
  // ran 4 URLs × 2 stages serially (~120s worst case); 4 in parallel cuts that to ~22s while
  // preserving the same locale coverage (locale-specific search hits sometimes surface SKUs
  // the US locale misses).
  await Promise.all(
    searchUrls
      .filter((searchUrl) => !documentSink || !isEatonFastDocumentSearchUrl(searchUrl))
      .slice(0, 4)
      .map((searchUrl) => searchEatonSearchUrl(searchUrl, catalogNumber, context, diagnostics, byUrl, documentSink))
  );

  const candidates = [...byUrl.values()].sort((left, right) => right.score - left.score || left.url.length - right.url.length);
  diagnostics.discoveredCandidates?.push(
    ...candidates.map((candidate) => ({
      url: candidate.url,
      score: candidate.score,
      reason: candidate.reason,
      stage: "search-result" as const,
      sourceType: "official-fallback" as const
    }))
  );
  return candidates;
}

function isEatonFastDocumentSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^www\.eaton\.com\.cn$/i.test(parsed.hostname) && /\/site-search\//i.test(parsed.pathname);
  } catch {
    return /www\.eaton\.com\.cn\/.*\/site-search\//i.test(url);
  }
}

function eatonRapidLinkFamilyDocuments(catalogNumber: string, sourceUrl?: string): DocumentRecord[] {
  if (!isEatonRapidLinkCatalogCoveredRange(catalogNumber)) return [];
  return [
    {
      type: "datasheet",
      label: "Eaton Rapid Link 5X RASP5X product catalog",
      url: EATON_RAPID_LINK_5X_CATALOG_CN_PDF_URL,
      candidateUrls: [EATON_RAPID_LINK_5X_CATALOG_EN_PDF_URL],
      sourceUrl: sourceUrl ?? EATON_RAPID_LINK_5X_CATALOG_CN_PDF_URL,
      sourceType: "official-fallback",
      parser: "eaton-rapid-link-family-catalog",
      stage: "search-document",
      confidence: 0.68
    }
  ];
}

function isEatonRapidLinkCatalogCoveredRange(catalogNumber: string): boolean {
  const match = cleanText(catalogNumber).match(/^CDVRL(\d{5})$/i);
  if (!match) return false;
  const value = Number(match[1]);
  return [
    [1, 144],
    [289, 432],
    [10001, 10144],
    [10289, 10576],
    [10721, 11044],
    [20001, 20756]
  ].some(([start, end]) => value >= start && value <= end);
}

async function searchEatonSearchUrl(
  searchUrl: string,
  catalogNumber: string,
  context: ScrapeContext,
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes">,
  byUrl: Map<string, EatonSearchCandidate>,
  documentSink?: DocumentRecord[]
): Promise<void> {
  diagnostics.attemptedUrls?.push(searchUrl);
  let succeeded = false;
  try {
    const fetched = await context.http.fetchText(searchUrl, {
      timeoutMs: 8000,
      maxAttempts: 1,
      signal: context.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        referer: `https://www.eaton.com/us/en-us/site-search.html.searchTerm$${encodeURIComponent(catalogNumber)}.tabs$all.html`
      }
    });
    addEatonSearchCandidates(byUrl, extractEatonSearchCandidates(fetched.text, fetched.effectiveUrl, catalogNumber));
    documentSink?.push(...extractEatonSearchDocuments(fetched.text, fetched.effectiveUrl, catalogNumber));
    succeeded = true;
  } catch (error) {
    diagnostics.notes?.push(`Eaton search discovery failed for ${searchUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if ((documentSink?.length ?? 0) > 0) return;
  if (!succeeded) {
    const jinaUrl = buildEatonReaderUrl(searchUrl);
    try {
      const fetched = await context.http.fetchText(jinaUrl, {
        timeoutMs: 22000,
        maxAttempts: 1,
        signal: context.signal,
        headers: { accept: "text/plain,application/json,*/*" }
      });
      const text = stripJinaTextPreamble(fetched.text);
      addEatonSearchCandidates(byUrl, extractEatonSearchCandidates(text, fetched.effectiveUrl, catalogNumber));
      documentSink?.push(...extractEatonSearchDocuments(text, fetched.effectiveUrl, catalogNumber));
    } catch (error) {
      diagnostics.notes?.push(`Eaton reader search discovery failed for ${jinaUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function addEatonSearchCandidates(byUrl: Map<string, EatonSearchCandidate>, candidates: EatonSearchCandidate[]): void {
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url.toLowerCase());
    if (!existing || candidate.score > existing.score) byUrl.set(candidate.url.toLowerCase(), candidate);
  }
}

function normalizeEatonSearchProductUrl(rawUrl: string, baseUrl: string): string | undefined {
  if (!rawUrl || /^javascript:|^mailto:|^tel:|^data:/i.test(rawUrl)) return undefined;
  try {
    let parsed = new URL(rawUrl.trim().replace(/\\u002f/gi, "/").replace(/&amp;/gi, "&"), baseUrl);
    const contentPath = parsed.pathname.match(/^\/content\/eaton\/([^/]+\/[^/]+)\/skuPage\.([^/?#]+)$/i);
    if (contentPath) {
      parsed = new URL(`https://${eatonSkuHostForLocalePath(contentPath[1], parsed.hostname)}/${contentPath[1]}/skuPage.${contentPath[2]}.html`);
    }
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\.specifications\.html$/i, ".html");
    if (/\/skuPage\.[^/]+$/i.test(parsed.pathname) && !/\.html$/i.test(parsed.pathname)) parsed.pathname = `${parsed.pathname}.html`;
    if (!isEatonSkuPageUrl(parsed)) return undefined;
    return isChinaEatonUrl(parsed.toString()) ? parsed.toString() : canonicalEatonEnglishProductUrl(parsed.toString()) ?? parsed.toString();
  } catch {
    return undefined;
  }
}

function isEatonSkuPageUrl(url: URL): boolean {
  return isAllowedEatonHost(url.hostname) && /\/skuPage\.[^/]+\.html$/i.test(url.pathname) && !/\.pdf$/i.test(url.pathname);
}

function eatonSkuHostForLocalePath(localePath: string, fallbackHost: string): string {
  if (/^cn\/zh-cn$/i.test(localePath)) return EATON_CHINA_PRODUCT_HOST;
  return isAllowedEatonHost(fallbackHost) ? fallbackHost : EATON_PRODUCT_HOST;
}

function isAllowedEatonProductUrl(url: string): boolean {
  try {
    return isAllowedEatonHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isAllowedEatonHost(hostname: string): boolean {
  return new RegExp(`^(?:${escapeRegExp(EATON_PRODUCT_HOST)}|${escapeRegExp(EATON_CHINA_PRODUCT_HOST)})$`, "i").test(hostname);
}

function scoreEatonSearchCandidate(url: string, context: string, catalogNumber: string, baseScore: number): number {
  let score = baseScore;
  const title = context.split(/\s+/)[0] ?? "";
  const exactCatalog = new RegExp(`(^|[^a-z0-9])${escapeRegExp(catalogNumber)}([^a-z0-9]|$)`, "i");
  const compactPart = compactCatalogNumber(catalogNumber);
  if (catalogTextMatches(context, catalogNumber, { compact: true, afterColon: true })) score += 18;
  if (catalogTextMatches(url, catalogNumber, { compact: true, afterColon: true })) score += 24;
  if (exactCatalog.test(context)) score += 30;
  if (exactCatalog.test(url)) score += 35;
  if (compactCatalogNumber(title) === compactCatalogNumber(catalogNumber)) score += 28;
  if (compactPart && compactCatalogNumber(url).includes(compactPart)) score += 18;
  if (/\/skuPage\./i.test(url)) score += 10;
  if (/\b(discontinued|obsolete)\b/i.test(context)) score -= 6;
  return Math.max(0, Math.min(180, score));
}

function findEatonSearchResultItems(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(findEatonSearchResultItems);
  const record = value as Record<string, unknown>;
  const direct = Array.isArray(record.siteSearchResults) ? record.siteSearchResults : [];
  return direct.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function readSecondaryLinks(item: Record<string, unknown>): Array<{ text?: string; url?: string }> {
  const rawLinks = Array.isArray(item.secondaryLinkList) ? item.secondaryLinkList : [];
  return rawLinks.filter((link): link is { text?: string; url?: string } => Boolean(link) && typeof link === "object");
}

function readSecondaryLinkText(item: Record<string, unknown>): string[] {
  return readSecondaryLinks(item).flatMap((link) => [link.text, link.url]).filter((value): value is string => typeof value === "string");
}

interface EatonCbeCatalogRecord {
  articleNumber: string;
  partNumber: string;
  productName?: string;
  productFamily?: string;
  productBase?: string;
  eclassCode?: string;
  eclassVersion?: string;
  ratedCurrent?: string;
  ratedVoltage?: string;
  ratedInsulationVoltage?: string;
  poles?: string;
  residualCurrent?: string;
  releaseCharacteristic?: string;
  unitPerPackage?: string;
  weightKg?: string;
  depthMm?: string;
  widthMm?: string;
  heightMm?: string;
  operatingTemperature?: string;
  degreeOfProtection?: string;
  connectionType?: string;
}

let eatonCbeCatalogRecordsPromise: Promise<Map<string, EatonCbeCatalogRecord>> | undefined;

async function scrapeEatonCbeCatalogPdf(
  catalogNumber: string,
  context: ScrapeContext,
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes">
): Promise<ProductResult | undefined> {
  if (!/^CBE\d+$/i.test(catalogNumber)) return undefined;
  diagnostics.attemptedUrls?.push(EATON_E6_CATALOG_PDF_URL);
  const records = await loadEatonCbeCatalogRecords(context);
  const record = records.get(catalogNumber.toUpperCase());
  if (!record) return undefined;
  diagnostics.discoveredCandidates?.push({
    url: EATON_E6_CATALOG_PDF_URL,
    score: 91,
    reason: "Eaton E6 catalog PDF article-number table",
    stage: "pdf-catalog",
    sourceType: "official-fallback"
  });
  const documents: DocumentRecord[] = [
    {
      type: "datasheet",
      label: "Eaton E6 Series Miniature Circuit Breaker catalog",
      url: EATON_E6_CATALOG_PDF_URL,
      sourceType: "official-fallback"
    }
  ];
  const attributes: AttributeRecord[] = [
    eatonPdfAttr("Catalog Number", record.articleNumber),
    eatonPdfAttr("Model Code", record.partNumber),
    eatonPdfAttr("Part number", record.partNumber),
    record.productName ? eatonPdfAttr("Product Name", record.productName) : undefined,
    eatonPdfAttr("Catalog Description", [record.productName, record.partNumber].filter(Boolean).join(" ")),
    record.productFamily ? eatonPdfAttr("Product family", record.productFamily) : undefined,
    record.productBase ? eatonPdfAttr("Product base", record.productBase) : undefined,
    record.eclassCode ? eatonPdfAttr(`ECLASS ${record.eclassVersion ?? "13"}`, record.eclassCode) : undefined,
    record.ratedCurrent ? eatonPdfAttr("Rated current", `${record.ratedCurrent} A`) : undefined,
    record.ratedVoltage ? eatonPdfAttr("Rated voltage", `${record.ratedVoltage} V`) : undefined,
    record.ratedInsulationVoltage ? eatonPdfAttr("Rated insulation voltage", `${record.ratedInsulationVoltage} V`) : undefined,
    record.poles ? eatonPdfAttr("Number of poles", record.poles) : undefined,
    record.residualCurrent ? eatonPdfAttr("Rated residual current", `${record.residualCurrent} A`) : undefined,
    record.releaseCharacteristic ? eatonPdfAttr("Release characteristic", record.releaseCharacteristic) : undefined,
    record.unitPerPackage ? eatonPdfAttr("Unit per package", record.unitPerPackage) : undefined,
    record.weightKg ? eatonPdfAttr("Product Net Weight", `${record.weightKg} kg`) : undefined,
    record.depthMm ? eatonPdfAttr("Product Net Depth", `${record.depthMm} mm`) : undefined,
    record.widthMm ? eatonPdfAttr("Product Net Width", `${record.widthMm} mm`) : undefined,
    record.heightMm ? eatonPdfAttr("Product Net Height", `${record.heightMm} mm`) : undefined,
    record.operatingTemperature ? eatonPdfAttr("Operating temperature", record.operatingTemperature) : undefined,
    record.degreeOfProtection ? eatonPdfAttr("Degree of protection", record.degreeOfProtection) : undefined,
    record.connectionType ? eatonPdfAttr("Connection type", record.connectionType) : undefined
  ].filter((attr): attr is AttributeRecord => Boolean(attr));
  const title = [record.partNumber, record.productName].filter(Boolean).join(" - ");
  return {
    manufacturerId: "eaton",
    catalogNumber,
    status: "found",
    confidence: 0.88,
    productUrl: EATON_E6_CATALOG_PDF_URL,
    localizedUrls: buildLocalizedProductUrls("eaton", catalogNumber, EATON_E6_CATALOG_PDF_URL),
    title,
    description: title,
    normalized: normalizeFields(attributes, documents),
    attributes,
    documents,
    sources: [
      {
        url: EATON_E6_CATALOG_PDF_URL,
        sourceType: "official-fallback",
        parser: "eaton-e6-pdf-catalog",
        parserVersion: "eaton-v2",
        fetchedAt: new Date().toISOString()
      }
    ]
  };
}

function eatonPdfAttr(name: string, value: string): AttributeRecord {
  return {
    group: "PDF catalog",
    name,
    value,
    sourceType: "official-fallback",
    parser: "eaton-e6-pdf-catalog",
    stage: "pdf-catalog",
    confidence: 0.86,
    sourceUrl: EATON_E6_CATALOG_PDF_URL
  };
}

const EATON_CBE_PDF_FETCH_TIMEOUT_MS = 30000;
const EATON_CBE_RECORDS_CACHE_BASENAME = "eaton-cbe-catalog-records.json";

async function loadEatonCbeCatalogRecords(context: ScrapeContext): Promise<Map<string, EatonCbeCatalogRecord>> {
  // Per-process singleton: every CBE item shares the same in-flight (or resolved) promise so we
  // never download or parse the catalog PDF more than once per server lifetime.
  if (!eatonCbeCatalogRecordsPromise) {
    eatonCbeCatalogRecordsPromise = (async () => {
      const cachePath = path.join(context.http.cacheDir, EATON_CBE_RECORDS_CACHE_BASENAME);
      // Disk cache survives process restarts — the PDF rarely changes, so on cold start we
      // skip the ~1MB cross-region download and the 57-page PDF parse entirely.
      const cached = await readEatonCbeCatalogCache(cachePath);
      if (cached) return cached;

      // The original implementation used the global fetch() with no timeout. If eaton.com.cn
      // is slow or partially blocked from the host, every CBE item silently hung forever on
      // the same shared promise. Bound the fetch with an AbortController so failure surfaces
      // and subsequent items can fall back to the non-PDF pipeline instead of waiting.
      const controller = new AbortController();
      const externalSignal = context.signal;
      const onExternalAbort = () => controller.abort(externalSignal?.reason);
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error("Eaton CBE PDF fetch timed out")), EATON_CBE_PDF_FETCH_TIMEOUT_MS);
      try {
        const fetched = await fetch(EATON_E6_CATALOG_PDF_URL, {
          signal: controller.signal,
          headers: { "user-agent": "product-scraper/1.0", accept: "application/pdf,*/*" }
        });
        if (!fetched.ok) throw new Error(`Eaton E6 PDF fetch failed: ${fetched.status}`);
        const parser = new PDFParse({ data: Buffer.from(await fetched.arrayBuffer()) });
        try {
          const parsed = await parser.getText({ first: 57 });
          const records = parseEatonCbeCatalogRecords(parsed.text);
          await writeEatonCbeCatalogCache(cachePath, records).catch(() => undefined);
          return records;
        } finally {
          await parser.destroy?.();
        }
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", onExternalAbort);
      }
    })().catch((error) => {
      // Clear the cached rejection so the NEXT CBE item gets a fresh attempt instead of
      // inheriting an already-failed promise (otherwise one network blip poisons the rest of
      // the run).
      eatonCbeCatalogRecordsPromise = undefined;
      throw error;
    });
  }
  return eatonCbeCatalogRecordsPromise;
}

async function readEatonCbeCatalogCache(cachePath: string): Promise<Map<string, EatonCbeCatalogRecord> | undefined> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const entries = JSON.parse(raw) as Array<[string, EatonCbeCatalogRecord]>;
    if (!Array.isArray(entries) || !entries.length) return undefined;
    return new Map(entries);
  } catch {
    return undefined;
  }
}

async function writeEatonCbeCatalogCache(cachePath: string, records: Map<string, EatonCbeCatalogRecord>): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify([...records.entries()]), "utf8");
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

// The E6 catalog is a clean, uniform TAB-delimited table: every product row is
//   [ratings...]  <part number>  <CBE article number>  <units per package>
// The earlier two regexes only matched the EIS (20) and ED6 (84) families and silently dropped
// the other ~1270 rows (ELD6 780, E6 468, Z accessories 22, ...). This generic parser keys off
// the CBE cell, takes the part number from the cell before it, and derives the structured fields
// from the (authoritative) part number per family \u2014 covering every CBE article in the catalog.
export function parseEatonCbeCatalogRecords(text: string): Map<string, EatonCbeCatalogRecord> {
  const records = new Map<string, EatonCbeCatalogRecord>();
  const normalized = text.replace(/\u00a0/g, " ");
  for (const rawLine of normalized.split(/\r?\n/)) {
    const cells = rawLine.split(/\t+|\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
    const cbeIndex = cells.findIndex((cell) => /^CBE\d+$/i.test(cell));
    if (cbeIndex < 1) continue;
    const article = cells[cbeIndex].toUpperCase();
    if (records.has(article)) continue;
    const trailing = cells[cbeIndex + 1];
    const record = deriveEatonCbeRecord(
      article,
      cells[cbeIndex - 1],
      cells.slice(0, cbeIndex - 1),
      trailing && /^\d+$/.test(trailing) ? trailing : undefined
    );
    if (record) records.set(article, record);
  }
  return records;
}

export function deriveEatonCbeRecord(
  article: string,
  partNumber: string,
  ratingCells: string[],
  unitPerPackage: string | undefined
): EatonCbeCatalogRecord | undefined {
  if (!partNumber || /^CBE\d+$/i.test(partNumber)) return undefined;
  const descriptiveCells = ratingCells.filter((cell) => /[A-Za-z]/.test(cell) && !/^\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?$/.test(cell));
  const base: EatonCbeCatalogRecord = {
    articleNumber: article,
    partNumber,
    ...(unitPerPackage ? { unitPerPackage } : {}),
    ...(descriptiveCells[0] ? { productName: descriptiveCells.join(" ") } : {})
  };

  let match: RegExpMatchArray | null;
  if ((match = partNumber.match(/^EIS-(\d+)\/(\d+)$/i))) {
    return { ...base, ratedCurrent: match[1], poles: match[2] };
  }
  if ((match = partNumber.match(/^E6-(\d+)\/(\d+)\/([A-Z])$/i))) {
    return {
      ...base,
      ratedCurrent: match[1],
      poles: match[2],
      releaseCharacteristic: match[3].toUpperCase()
    };
  }
  if ((match = partNumber.match(/^(E[L]?D6)-(\d+)\/(\d+)N\/([A-Z])\/(\d+)/i))) {
    return {
      ...base,
      ratedCurrent: match[2],
      poles: String(Number(match[3]) + 1),
      releaseCharacteristic: match[4].toUpperCase(),
      residualCurrent: eatonResidualCurrent(ratingCells[0], match[5])
    };
  }
  // Unknown family: still capture article + type code (+ a leading numeric current), never guess.
  return {
    ...base,
    ratedCurrent: ratingCells.find((cell) => /^\d+(?:[.,]\d+)?$/.test(cell))?.replace(",", ".")
  };
}

function eatonResidualCurrent(ratingCell: string | undefined, suffix: string): string | undefined {
  // Prefer the explicit "1/0.03" rating cell; fall back to the part-number suffix (003 -> 0.03 A).
  const fromCell = ratingCell?.match(/\/\s*(\d*\.\d+)/)?.[1];
  if (fromCell) return fromCell;
  const value = Number(suffix);
  return Number.isFinite(value) && value > 0 ? String(value / 100) : undefined;
}

function withEatonDiagnostics(
  result: ProductResult,
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes">
): ProductResult {
  const attemptedUrls = uniqueStrings([...(result.diagnostics?.attemptedUrls ?? []), ...(diagnostics.attemptedUrls ?? [])]).slice(0, 80);
  const discoveredCandidates = [
    ...(result.diagnostics?.discoveredCandidates ?? []),
    ...(diagnostics.discoveredCandidates ?? [])
  ].slice(0, 40);
  const notes = uniqueStrings([...(result.diagnostics?.notes ?? []), ...(diagnostics.notes ?? [])]).slice(0, 40);
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      ...(attemptedUrls.length ? { attemptedUrls } : {}),
      ...(discoveredCandidates.length ? { discoveredCandidates } : {}),
      ...(notes.length ? { notes } : {})
    }
  };
}

export function parseEatonProductPage(
  catalogNumber: string,
  fetched: FetchedText,
  officialUrl: string,
  localizedUrlTemplates?: LocalizedUrlTemplate[]
): ProductResult {
  const text = fetched.text;
  const htmlParsed = parseHtmlProductData(catalogNumber, fetched);
  if (isEatonNotFoundPage(fetched, htmlParsed.title, htmlParsed.description)) {
    return emptyResult("eaton", catalogNumber, "Eaton page returned a not-found page.");
  }
  if (!catalogTextMatches(text, catalogNumber)) {
    return emptyResult("eaton", catalogNumber, "Eaton page did not contain the catalog number.");
  }

  const shouldParseMarkdown = htmlParsed.attributes.length === 0;
  const lines = shouldParseMarkdown ? text.split(/\r?\n/).map(cleanMarkdownLine).filter(Boolean) : [];
  const markdownAttributes = shouldParseMarkdown ? extractMarkdownAttributes(lines, fetched.effectiveUrl) : [];
  const markdownDocuments = shouldParseMarkdown
    ? [
        ...extractMarkdownImages(text, catalogNumber, fetched.effectiveUrl),
        ...extractMarkdownLinks(text, catalogNumber, fetched.effectiveUrl)
      ]
    : [];
  const attributes = dedupeAttributes([...htmlParsed.attributes, ...markdownAttributes]).map((attr) => ({
    sourceType: "official-fallback" as const,
    parser: "eaton-product-page",
    stage: htmlParsed.attributes.length ? "static-html" : "reader",
    confidence: htmlParsed.attributes.length ? 0.9 : 0.84,
    ...attr
  }));
  const catalogNumberForUrls = preferredEatonCatalogNumber(catalogNumber, attributes);
  const productUrl = canonicalEatonEnglishProductUrl(officialUrl) ?? officialUrl;
  const documents = dedupeDocuments([
    ...htmlParsed.documents,
    ...markdownDocuments,
    ...(attributes.length ? buildEatonGeneratedSpecSheetDocuments(productUrl, catalogNumberForUrls) : [])
  ]).map((doc) => ({
    sourceType: "official-fallback" as const,
    parser: "eaton-product-page",
    stage: htmlParsed.attributes.length ? "static-html" : "reader",
    confidence: htmlParsed.attributes.length ? 0.9 : 0.84,
    ...doc
  }));
  const title = cleanText(htmlParsed.title || readMarkdownTitle(lines) || catalogNumber);
  const description = htmlParsed.description || readDescription(lines, catalogNumber);
  const normalized = normalizeFields(attributes, documents);
  const hasUsableProductData = hasUsableEatonProductData(attributes, documents);
  return {
    manufacturerId: "eaton",
    catalogNumber,
    status: hasUsableProductData ? "found" : "failed",
    confidence: hasUsableProductData ? 0.82 : 0,
    productUrl,
    localizedUrls: buildLocalizedProductUrls("eaton", catalogNumberForUrls, productUrl, localizedUrlTemplates),
    title,
    description,
    normalized,
    attributes,
    documents,
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType: "official-fallback",
        parser: "eaton-product-page",
        parserVersion: "eaton-v2",
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      } satisfies SourceRecord
    ],
    localizedDescriptions: isGermanEatonUrl(officialUrl) && (title || description)
      ? { de: { title: title || undefined, description: description || undefined } }
      : undefined,
    error: hasUsableProductData ? undefined : "No usable Eaton product data found."
  };
}

function isGermanEatonUrl(url: string): boolean {
  return /\/(?:de|at|ch)\/de-(?:de|at|ch)\/skuPage\./i.test(url);
}

function isEnglishEatonUrl(url: string): boolean {
  return /\/(?:us|gb|ca|au|ae)\/en-(?:us|gb|ca|au|ae)\/skuPage\./i.test(url);
}

function isChinaEatonUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^www\.eaton\.com\.cn$/i.test(parsed.hostname) && /\/cn\/zh-cn\/skuPage\./i.test(parsed.pathname);
  } catch {
    return /www\.eaton\.com\.cn\/cn\/zh-cn\/skuPage\./i.test(url);
  }
}

function hasUsableEatonProductData(attributes: AttributeRecord[], documents: DocumentRecord[]): boolean {
  if (documents.length > 0) return true;
  if (attributes.length >= 3) return true;
  return attributes.some((attr) => /^(?:catalog number|model code|product name|product type)$/i.test(attr.name));
}

function isEatonNotFoundPage(fetched: FetchedText, title?: string, description?: string): boolean {
  if (fetched.statusCode === 404) return true;
  const notFoundTitlePattern = /^(?:404|404\s+(?:error|errore|erreur|fehler)|(?:error|errore|erreur|fehler)\s+404)(?:\s*\|\s*Eaton)?$/i;
  if (notFoundTitlePattern.test(cleanText(title))) return true;
  const pageIntro = cleanText(`${title ?? ""} ${description ?? ""} ${fetched.text.slice(0, 2500)}`);
  return (
    /\btitle:\s*(?:404|404\s+(?:error|errore|erreur|fehler)|(?:error|errore|erreur|fehler)\s+404)(?:\s*\|\s*Eaton)?\b/i.test(pageIntro) ||
    /\b404\s+(?:error|errore|erreur|fehler)\b/i.test(pageIntro) ||
    /\b(?:error|errore|erreur|fehler)\s+404\b/i.test(pageIntro) ||
    /\bpage\s+not\s+found\b/i.test(pageIntro) ||
    /\bthe\s+page\s+you\s+requested\s+could\s+not\s+be\s+found\b/i.test(pageIntro)
  );
}

function preferredEatonCatalogNumber(requestedCatalogNumber: string, attributes: AttributeRecord[]): string {
  const pageCatalogNumber = attributes.find((attr) => /^catalog number$/i.test(attr.name) && /^[\w./(){} -]{2,80}$/i.test(attr.value))?.value;
  return cleanText(pageCatalogNumber) || requestedCatalogNumber;
}

async function enrichEatonLocalizedDescriptions(
  result: ProductResult,
  context: ScrapeContext,
  diagnostics: Pick<ScrapeDiagnostics, "attemptedUrls" | "discoveredCandidates" | "notes">
): Promise<ProductResult> {
  if (result.status === "failed" || result.localizedDescriptions?.de?.title || result.localizedDescriptions?.de?.description) return result;
  const germanUrl = result.localizedUrls?.de;
  if (!germanUrl || sameUrl(germanUrl, result.productUrl)) return result;
  diagnostics.attemptedUrls?.push(`localized-de:${germanUrl}`);
  const fetched =
    (await fetchEatonReader(germanUrl, context, { timeoutMs: 12000, waitForSelector: false })) ??
    (await fetchEatonDirectOptional(germanUrl, context));
  if (!fetched) return result;
  const parsed = parseEatonProductPage(result.catalogNumber, fetched, germanUrl, context.manufacturer.localizedUrlTemplates);
  if (parsed.status === "failed") return result;
  return mergeEatonResults(result, parsed);
}

function sameUrl(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin.toLowerCase() === rightUrl.origin.toLowerCase() && leftUrl.pathname.toLowerCase() === rightUrl.pathname.toLowerCase();
  } catch {
    return left.toLowerCase() === right.toLowerCase();
  }
}

function buildEatonGeneratedSpecSheetDocuments(officialUrl: string, catalogNumber: string): DocumentRecord[] {
  const pdfUrl = eatonGeneratedSpecSheetUrl(officialUrl);
  if (!pdfUrl) return [];
  return [
    {
      type: "datasheet",
      label: `Eaton Specification Sheet - ${catalogNumber}`,
      url: pdfUrl,
      sourceUrl: officialUrl
    }
  ];
}

function eatonGeneratedSpecSheetUrl(officialUrl: string): string | undefined {
  try {
    const parsed = new URL(officialUrl);
    if (!/eaton\.com$/i.test(parsed.hostname)) return undefined;
    if (!/\/skuPage\.[^/]+\.html$/i.test(parsed.pathname)) return undefined;
    parsed.pathname = parsed.pathname.replace(/\.html$/i, ".pdf");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseHtmlProductData(catalogNumber: string, fetched: FetchedText): {
  title?: string;
  description?: string;
  attributes: AttributeRecord[];
  documents: DocumentRecord[];
} {
  if (!/<(?:html|table|tr|div|meta)\b/i.test(fetched.text)) return { attributes: [], documents: [] };
  const $ = cheerio.load(fetched.text);
  const title = cleanText(
    $("meta[property='og:title']").attr("content") ||
      $("title").first().text() ||
      $(".module-product-detail-card-v2__title,h1").first().text()
  ).replace(/\s+\|\s+Eaton$/i, "");
  const description = cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content"));
  const attributes: AttributeRecord[] = [];
  const structured = extractHtmlStructuredProductData($, fetched.effectiveUrl);

  $(".product-specification-item").each((_, section) => {
    const group = cleanText($(section).find(".product-specification-item__title,h2,h3").first().text()) || "Product specifications";
    if (isIgnoredAttributeSection(group)) return;
    $(section).find("tr.specification-row").each((__, row) => {
      const name = cleanText($(row).find(".specification-title,strong,th").first().text());
      const valueCell = $(row).find(".specification-value,td").last();
      const value = cleanElementText(valueCell);
      if (!name || !value) return;
      attributes.push({ group, name, value, sourceUrl: fetched.effectiveUrl });
    });
  });

  if (attributes.length === 0) {
    $("tr").each((_, row) => {
      const cells = $(row)
        .find("th,td")
        .map((__, cell) => cleanElementText($(cell)))
        .get()
        .filter(Boolean);
      if (cells.length < 2) return;
      attributes.push({ group: "Product specifications", name: cells[0], value: cells.slice(1).join(" "), sourceUrl: fetched.effectiveUrl });
    });
  }

  return {
    title,
    description,
    attributes: [
      ...attributes,
      ...structured.attributes,
      ...extractHtmlDataLayerAttributes($, fetched.effectiveUrl),
      ...extractHtmlMetaAttributes($, fetched.effectiveUrl),
      ...extractHtmlBreadcrumbAttributes($, fetched.effectiveUrl),
      ...extractHtmlRelatedProductAttributes($, fetched.effectiveUrl)
    ],
    documents: [...extractHtmlDocuments($, catalogNumber, fetched.effectiveUrl), ...extractHtmlEmbeddedResourceDocuments($, catalogNumber, fetched.effectiveUrl), ...structured.documents]
  };
}

function cleanElementText(element: cheerio.Cheerio<any>): string {
  const html = element.html();
  if (!html) return cleanText(element.text());
  const normalizedHtml = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/li>/gi, "</li>\n");
  return cleanText(cheerio.load(`<div>${normalizedHtml}</div>`).text());
}

function extractHtmlStructuredProductData(
  $: cheerio.CheerioAPI,
  sourceUrl: string
): { attributes: AttributeRecord[]; documents: DocumentRecord[] } {
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const addAttribute = (name: string, value: unknown) => {
    const text = cleanText(structuredText(value));
    if (!text || text.length > 500) return;
    attributes.push({ group: "Structured Product Data", name, value: text, sourceUrl });
  };
  const addImage = (value: unknown, label = "Product image") => {
    for (const rawUrl of structuredImageUrls(value)) {
      const absolute = toAbsoluteUrl(rawUrl, sourceUrl);
      if (!absolute) continue;
      documents.push({ type: "image", label, url: normalizeEatonImageUrl(absolute), sourceUrl });
    }
  };

  $("script[type='application/ld+json']").each((_, script) => {
    const parsed = parseJsonLdScript($(script).text());
    if (!parsed) return;
    for (const product of findJsonLdProducts(parsed)) {
      addAttribute("Product Name", product.name);
      addAttribute("Description", product.description);
      addAttribute("SKU", product.sku);
      addAttribute("MPN", product.mpn);
      addAttribute("Model", product.model);
      addAttribute("GTIN", product.gtin ?? product.gtin8 ?? product.gtin12 ?? product.gtin13 ?? product.gtin14);
      addAttribute("Brand", structuredBrandName(product.brand));
      addAttribute("Category", product.category);
      addAttribute("Product URL", product.url);
      addImage(product.image, cleanText(structuredText(product.name)) || "Product image");
    }

    for (const breadcrumb of findJsonLdBreadcrumbs(parsed)) {
      if (breadcrumb.length >= 2) attributes.push({ group: "Product hierarchy", name: "Breadcrumb", value: breadcrumb.join(" > "), sourceUrl });
    }
  });

  return { attributes, documents };
}

function parseJsonLdScript(text: string): unknown | undefined {
  const cleaned = text.trim();
  if (!cleaned) return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function findJsonLdProducts(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(findJsonLdProducts);
  if (!isRecord(value)) return [];
  const direct = jsonLdTypeIncludes(value["@type"], "Product") ? [value] : [];
  const nested = Object.values(value).flatMap(findJsonLdProducts);
  return [...direct, ...nested];
}

function findJsonLdBreadcrumbs(value: unknown): string[][] {
  if (Array.isArray(value)) return value.flatMap(findJsonLdBreadcrumbs);
  if (!isRecord(value)) return [];
  const direct = jsonLdTypeIncludes(value["@type"], "BreadcrumbList") ? [readBreadcrumbList(value)] : [];
  const nested = Object.values(value).flatMap(findJsonLdBreadcrumbs);
  return [...direct, ...nested].filter((breadcrumb) => breadcrumb.length > 0);
}

function readBreadcrumbList(record: Record<string, unknown>): string[] {
  const items = Array.isArray(record.itemListElement) ? record.itemListElement : [];
  return items
    .map((item) => {
      if (!isRecord(item)) return structuredText(item);
      if (isRecord(item.item)) return structuredText(item.item.name);
      return structuredText(item.name);
    })
    .map(cleanText)
    .filter(Boolean);
}

function jsonLdTypeIncludes(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((item) => jsonLdTypeIncludes(item, expected));
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/^schema:/, "");
  return normalized === expected.toLowerCase();
}

function structuredBrandName(value: unknown): string | undefined {
  if (isRecord(value)) return structuredText(value.name);
  return structuredText(value);
}

function structuredText(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(structuredText).filter(Boolean).join("; ");
  if (isRecord(value)) return structuredText(value.name ?? value.value ?? value.url);
  return undefined;
}

function structuredImageUrls(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(structuredImageUrls);
  if (!isRecord(value)) return [];
  return [value.url, value.contentUrl, value.thumbnailUrl].flatMap(structuredImageUrls);
}

function extractHtmlMetaAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const labels: Record<string, string> = {
    "og:title": "Open Graph Title",
    "og:description": "Open Graph Description",
    "og:url": "Open Graph URL",
    "og:type": "Open Graph Type",
    "coveo:product_brand": "Product Brand",
    "coveo:product_core_group": "Product Core Group",
    "coveo:product_lines": "Product Lines",
    "coveo:product_categories": "Product Categories",
    "coveo:product_regions": "Product Regions",
    "product:brand": "Product Brand",
    "product:category": "Product Category",
    "product:retailer_item_id": "Retailer Item ID",
    "product:availability": "Product Availability"
  };
  const attributes: AttributeRecord[] = [];

  $("meta[name],meta[property]").each((_, element) => {
    const rawName = cleanText($(element).attr("name") || $(element).attr("property")).toLowerCase();
    const label = labels[rawName];
    const value = cleanText($(element).attr("content"));
    if (!label || !value) return;
    attributes.push({ group: "Page metadata", name: label, value, sourceUrl });
  });

  const canonical = toAbsoluteUrl($("link[rel='canonical']").first().attr("href") ?? "", sourceUrl);
  if (canonical) attributes.push({ group: "Page metadata", name: "Canonical URL", value: canonical, sourceUrl });

  return attributes;
}

function extractHtmlDataLayerAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const labels: Record<string, string> = {
    country: "Country",
    language: "Language",
    channel: "Channel",
    pageType: "Page Type",
    productFamily: "Product Family",
    productSku: "Product SKU",
    productName: "Product Name",
    domain: "Domain"
  };

  $("script").each((_, script) => {
    const text = $(script).text();
    if (!/dataLayerJson\s*=/.test(text)) return;
    for (const record of extractScriptObjectAssignments(text, "dataLayerJson")) {
      for (const [key, rawValue] of Object.entries(record)) {
        const label = labels[key];
        const value = cleanText(normalizeDataLayerValue(rawValue));
        if (!label || !value || value.length > 500) continue;
        attributes.push({ group: "Eaton data layer", name: label, value, sourceUrl });
      }
    }
  });

  return attributes;
}

function extractScriptObjectAssignments(text: string, variableName: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pattern = new RegExp(`${escapeRegExp(variableName)}\\s*=\\s*({[\\s\\S]*?})\\s*;`, "g");
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Ignore unrelated scripts or non-JSON JavaScript objects.
    }
  }
  return records;
}

function normalizeDataLayerValue(value: unknown): string | undefined {
  const text = structuredText(value);
  if (!text) return undefined;
  return text.includes("||") ? text.split("||").pop() : text;
}

function extractHtmlBreadcrumbAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const crumbs = uniqueStrings(
    $("nav.breadcrumb a,.breadcrumb a,.breadcrumb li,.cmp-breadcrumb__item a,.cmp-breadcrumb__item")
      .map((_, element) => cleanText($(element).text()))
      .get()
      .filter((value) => value && !/^(?:home|eaton|products?)$/i.test(value))
  );
  return crumbs.length >= 2 ? [{ group: "Product hierarchy", name: "Breadcrumb", value: crumbs.join(" > "), sourceUrl }] : [];
}

const MARKDOWN_ATTRIBUTE_VALUE_MAX_LENGTH = 500;
const MARKDOWN_ATTRIBUTE_NAME_DROP = /^(?:title|url\s+source|markdown\s+content|date|sku|description\s*label|descriptionlabel|product\s+pickup|distributor)$/i;

function extractMarkdownAttributes(lines: string[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const knownFields = knownMarkdownFields(lines);
  let group = "Eaton Page";
  let pending: AttributeRecord | undefined;
  let pendingAccumulatedLines = 0;

  const flushPending = () => {
    if (!pending) return;
    const value = cleanText(pending.value.replace(/^[*\s-]+/, ""));
    if (
      !isIgnoredAttributeSection(pending.group) &&
      !isIgnoredAttributeSection(pending.name) &&
      !MARKDOWN_ATTRIBUTE_NAME_DROP.test(pending.name) &&
      value &&
      !isJunkAttributeValue(value)
    ) {
      attributes.push({ ...pending, value: truncateAttributeValue(value) });
    }
    pending = undefined;
    pendingAccumulatedLines = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (isJinaMetadataLine(line)) {
      flushPending();
      continue;
    }

    const heading = line.match(/^#+\s*(.+)$/);
    if (heading) {
      flushPending();
      group = cleanText(heading[1].replace(/\s+\|\s+Eaton$/i, ""));
      continue;
    }

    if (isLikelyNavLine(line)) {
      flushPending();
      continue;
    }

    const boldPair = line.match(/^\*\*([^*]{2,140})\*\*\s*(.*)$/);
    if (boldPair) {
      const name = cleanText(boldPair[1]);
      const value = cleanText(boldPair[2].replace(/^[-*]\s*/, ""));
      flushPending();
      if (!value) {
        group = name;
        continue;
      }
      pending = { group, name, value, sourceUrl };
      continue;
    }

    const pipePair = line.match(/^\|?\s*([^|]{2,140})\s+\|\s+(.+?)\s*\|?$/);
    if (pipePair) {
      flushPending();
      const name = cleanText(pipePair[1]);
      const value = cleanText(pipePair[2]);
      if (
        !isIgnoredAttributeSection(group) &&
        !isIgnoredAttributeSection(name) &&
        !MARKDOWN_ATTRIBUTE_NAME_DROP.test(name) &&
        value &&
        !isJunkAttributeValue(value)
      ) {
        attributes.push({ group, name, value: truncateAttributeValue(value), sourceUrl });
      }
      continue;
    }

    const knownField = exactKnownFieldLine(line, knownFields);
    if (knownField) {
      const nextLine = lines[index + 1];
      if (isLikelyMarkdownValueLine(nextLine, knownFields)) {
        flushPending();
        pending = { group, name: knownField, value: cleanText(nextLine.replace(/^[-*]\s+/, "")), sourceUrl };
        index += 1;
        continue;
      }
    }

    const knownPair = splitKnownFieldLine(line, knownFields);
    if (knownPair) {
      flushPending();
      pending = { group, ...knownPair, sourceUrl };
      continue;
    }

    if (isLikelyEatonFieldLabel(line, lines[index + 1], group, knownFields)) {
      flushPending();
      pending = { group, name: cleanText(line.replace(/:$/, "")), value: cleanText(lines[index + 1].replace(/^[-*]\s+/, "")), sourceUrl };
      index += 1;
      continue;
    }

    if (pending && !isSectionBoundary(line) && pendingAccumulatedLines < 2 && !isLikelyNavLine(line)) {
      const append = cleanText(line.replace(/^[-*]\s+/, ""));
      const combined = cleanText(`${pending.value} ${append}`);
      if (combined.length <= MARKDOWN_ATTRIBUTE_VALUE_MAX_LENGTH * 1.5) {
        pending.value = combined;
        pendingAccumulatedLines += 1;
      } else {
        flushPending();
      }
    }
  }
  flushPending();
  return attributes;
}

function isJinaMetadataLine(line: string): boolean {
  return /^(?:title|url\s+source|markdown\s+content|published\s+time)\s*:/i.test(line);
}

function isLikelyNavLine(line: string): boolean {
  if (!line) return false;
  if (/^\s*!?\[[^\]]+\]\(https?:\/\//.test(line)) return true;
  // Bulleted nav/menu items: "*   [Foo](http...)" or "- [x] checkbox"
  if (/^\s*[-*]\s*\[/.test(line)) return true;
  if (/^\s*-\s*\[\s*x\s*\]/.test(line)) return true;
  // Lines that are mostly markdown image embeds or markdown link soup (3+ links)
  const linkCount = (line.match(/\]\(http/g) ?? []).length;
  if (linkCount >= 3) return true;
  // Common nav phrases anywhere in the line
  if (/\b(?:sign\s*in\s*\/\s*register|myeaton account|select your location|locate me|locate a (?:distributor|channel)|please sign in|keep me signed in|employee login|submit form in new tab|back to top|all rights reserved)\b/i.test(line)) {
    return true;
  }
  return false;
}

function isJunkAttributeValue(value: string): boolean {
  if (!value) return true;
  if (value.length > MARKDOWN_ATTRIBUTE_VALUE_MAX_LENGTH * 2) return true;
  if (/^[-*\s|]+$/.test(value)) return true; // table separator row
  if (/^\s*\[\s*x\s*\]/i.test(value)) return true;
  const imageCount = (value.match(/!\[/g) ?? []).length;
  if (imageCount >= 2) return true;
  const linkCount = (value.match(/\]\(http/g) ?? []).length;
  if (linkCount >= 4) return true;
  if (/^\s*(?:available qty\.|location type)/i.test(value)) return true;
  return false;
}

function truncateAttributeValue(value: string): string {
  if (value.length <= MARKDOWN_ATTRIBUTE_VALUE_MAX_LENGTH) return value;
  return `${value.slice(0, MARKDOWN_ATTRIBUTE_VALUE_MAX_LENGTH - 1).trimEnd()}…`;
}

function knownMarkdownFields(lines: string[]): string[] {
  const labels = new Set(KNOWN_FIELDS);
  for (const line of lines) {
    const match = line.match(/^\*\*([^*]{2,140})\*\*/);
    if (match) labels.add(cleanText(match[1]));
  }
  return [...labels].filter((label) => !isIgnoredAttributeSection(label)).sort((left, right) => right.length - left.length);
}

function splitKnownFieldLine(line: string, knownFields: string[]): { name: string; value: string } | undefined {
  // Two shapes show up in Jina-rendered Eaton markdown:
  //   "Field: value"         — typical, whitespace + optional colon separator
  //   "Field(Uimp)value"     — label and value rendered without separator (common when the label
  //                            ends with a parenthetical or other markup; Jina drops the styling)
  // We try the spaced form first, then accept a no-separator match when the captured value starts
  // with a digit / sign / quote so we don't accidentally chain into a longer field name.
  for (const field of knownFields) {
    const spaced = line.match(new RegExp(`^${escapeRegExp(field)}\\s*:?\\s+(.+)$`, "i"));
    if (spaced) return { name: field, value: cleanText(spaced[1]) };
    const glued = line.match(new RegExp(`^${escapeRegExp(field)}([<>±]?\\s*\\d[^\\n]*)$`, "i"));
    if (glued) return { name: field, value: cleanText(glued[1]) };
  }
  return undefined;
}

function exactKnownFieldLine(line: string, knownFields: string[]): string | undefined {
  const normalized = cleanText(line.replace(/:$/, ""));
  if (!normalized) return undefined;
  return knownFields.find((field) => field.toLowerCase() === normalized.toLowerCase());
}

function isLikelyMarkdownValueLine(line: string | undefined, knownFields: string[]): line is string {
  const cleaned = cleanText(line);
  if (/^add to list\s+download$/i.test(cleaned)) return false;
  if (!cleaned || isSectionBoundary(cleaned) || exactKnownFieldLine(cleaned, knownFields) || isIgnoredAttributeSection(cleaned)) return false;
  if (/^(?:download|add to list|clear selection|continue|submit|search|x|×|specifications|resources|support)$/i.test(cleaned)) return false;
  return true;
}

function isLikelyEatonFieldLabel(line: string, nextLine: string | undefined, group: string, knownFields: string[]): boolean {
  const cleaned = cleanText(line.replace(/:$/, ""));
  if (!isLikelyMarkdownValueLine(nextLine, knownFields) || isIgnoredAttributeSection(group) || /^eaton page$/i.test(group)) return false;
  if (!cleaned || cleaned.length < 2 || cleaned.length > 160 || isSectionBoundary(cleaned) || exactKnownFieldLine(cleaned, knownFields)) return false;
  if (/^[-*]|[|{}<>]|https?:\/\/|www\.|@/.test(cleaned)) return false;
  if (/:/.test(cleaned)) return false;
  if (isLikelyEatonValueLine(cleaned)) return false;
  if (/^(?:add to list|download|last ned|legg til|image|button|contact me|find|please|serial number|are you sure|cancel|sign out)$/i.test(cleaned)) {
    return false;
  }
  if (cleaned.split(/\s+/).length > 12) return false;
  if (/^\d+(?:\.\d+)+\s+\S/.test(cleaned)) return true;
  return /\b(?:actuator|air|ambient|analog|application|awg|battery|bezel|box|burst|bus|button|cable|capacity|catalog|category|certifications?|class|clearance|coil|color|communication|compliances?|conductors?|configuration|connection|connector|consumption|contact|continuous|cover|current|degree|design|diagnostics?|diameter|digital|discharge|dissipation|drop|ean|efficiency|electromagnetic|enclosure|environmental|explosion|features?|fall|frame|frequency|function|fuse|gland|height|horsepower|hp|humidity|illumination|immunity|impulse|input|insulation|interference|interrupt|isolation|jacket|length|lifespan|loss|material|method|model|mounting|nema|noise|number|operation|output|overvoltage|package|phase|plating|poles|pollution|position|power|pressure|product|protection|protocol|quantity|rating|receptacle|release|resistance|resolution|ripple|safety|sheath|shock|short-?circuit|size|software|standard|suitable|supply|surge|technology|temperature|terminal|thickness|thread|trip|type|upc|usb|used with|utili[sz]ation|vibration|voltage|warranty|weight|width|wire)\b/i.test(
    cleaned
  );
}

function isLikelyEatonValueLine(value: string): boolean {
  return /^(?:[<>≤≥]?\s*)?\d+(?:[.,]\d+)?\s*(?:(?:-|\.{2,3}|to)\s*\d+(?:[.,]\d+)?\s*)?(?:v(?:ac|dc)?|a|ma|ka|w|kw|va|hz|khz|mm|cm|m|in|lb|kg|g|%|°|db)\b/i.test(
    value
  );
}

function isSectionBoundary(line: string): boolean {
  return /^#+\s+/.test(line) || /^\*\*[^*]{2,140}\*\*/.test(line);
}

function isIgnoredAttributeSection(value: string | undefined): boolean {
  const text = value ?? "";
  if (!text) return false;
  // Eaton-internal material/SAP numbers (6-7 digits) sometimes appear as the page-level # heading
  // (e.g. "# 276550") because the platform alias-redirects ordered catalog numbers like
  // DILM7-10(230V50HZ,240V60HZ) onto their internal SKU. The group is meaningless for attributes.
  if (/^\d{5,8}$/.test(text)) return true;
  // Eaton Jina markdown often emits error modals, login prompts, and the page-level title
  // heading as group names. Treat all of these as junk so we don't emit attributes under them.
  if (
    /\b(serial number is (?:invalid|known suspect|unrecognised|unrecognized)|unexpected error|are you sure|sign\s*in|sign\s*out|myeaton|welcome back|please sign|enter your city|download document|locate me|let.?s talk big ideas|back to top|all rights reserved|eaton page)\b/i.test(
      text
    )
  ) {
    return true;
  }
  // The page-level # heading is often "{catalog} | Eaton {productType}" — ignore it because the
  // real spec groups (General specifications, Performance Ratings, …) come later.
  if (/\|\s*Eaton\b/i.test(text) && /\b(switch|breaker|relay|disconnect|contactor|drive|sensor|enclosure|capacitor|transformer|fuse|controller|module|panel|terminal)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(manuals and user guides|declarations of conformity|certification reports|warranty guides|time\/current curves|white papers|ecad model|mcad model|installation videos|installation instructions)\b/i.test(
      text
    )
  ) {
    return true;
  }
  return /\b(export product specification|authenticate product|contact us|contact me|how to buy|support|resources|specifications and datasheets|brochures|catalogs|drawings|manuals|application notes|multimedia|cross references|technical service bulletins|company|quick links|date)\b/i.test(
    text
  );
}

function extractHtmlDocuments($: cheerio.CheerioAPI, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("meta[property='og:image'],meta[name='twitter:image'],meta[name='image']").each((_, element) => {
    const rawUrl = $(element).attr("content");
    const absolute = rawUrl ? toAbsoluteUrl(rawUrl, sourceUrl) : undefined;
    if (!absolute) return;
    const context = `Product image ${absolute} ${$(element).attr("property") ?? ""} ${$(element).attr("name") ?? ""}`;
    if (!looksLikeEatonProductImage(context, catalogNumber)) return;
    documents.push({ type: "image", label: "Product image", url: normalizeEatonImageUrl(absolute), sourceUrl });
  });

  $("img[src],img[data-src],img[data-lazy-src],source[srcset]").each((_, element) => {
    const rawUrl =
      $(element).attr("src") ||
      $(element).attr("data-src") ||
      $(element).attr("data-lazy-src") ||
      firstSrcsetUrl($(element).attr("srcset"));
    const absolute = rawUrl ? toAbsoluteUrl(rawUrl, sourceUrl) : undefined;
    if (!absolute) return;
    const label = cleanText($(element).attr("alt") || $(element).attr("title") || "Product image");
    const ancestorContext = $(element)
      .parents()
      .slice(0, 7)
      .map((__, parent) => $(parent).attr("class") || (parent as { tagName?: string }).tagName || "")
      .get()
      .join(" ");
    const context = `${label} ${absolute} ${$(element).attr("class") ?? ""} ${$(element).parent().attr("class") ?? ""} ${ancestorContext}`;
    if (!looksLikeEatonProductImage(context, catalogNumber)) return;
    const normalizedUrl = normalizeEatonImageUrl(absolute);
    documents.push({
      type: "image",
      label: label || "Product image",
      url: normalizedUrl,
      ...(normalizedUrl !== absolute ? { candidateUrls: [absolute, normalizedUrl] } : {}),
      sourceUrl
    });
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const url = toAbsoluteUrl(href, sourceUrl);
    if (!url) return;
    const label = readEatonLinkLabel($, element, url);
    if (!isEatonDocumentLink(label, url, catalogNumber)) return;
    documents.push({ type: classifyEatonDocument(label, url), label, url, sourceUrl });
  });

  return documents;
}

function extractHtmlEmbeddedResourceDocuments($: cheerio.CheerioAPI, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  const seen = new Set<string>();

  $("script").each((_, script) => {
    const text = $(script).text();
    if (!/(?:content\/dam\/eaton|skuPage\.[^"'\\\s]+\.pdf|DA-C[ES]-ETN|\.(?:pdf|stp|step|dwg|dxf|zip|igs|iges)|documentId|docId|format=pdf|downloadUrl|documentUrl|resourceUrl)/i.test(text)) return;

    for (const match of text.matchAll(/["']((?:https?:\\?\/\\?\/|\\?\/|\/)[^"']+)["']/gi)) {
      const rawUrl = unescapeJsonUrl(match[1]);
      const url = toAbsoluteUrl(rawUrl, sourceUrl);
      if (!url) continue;
      const objectStart = text.lastIndexOf("{", match.index);
      const objectEnd = text.indexOf("}", match.index + match[0].length);
      const contextStart = objectStart >= 0 ? objectStart : Math.max(0, match.index - 700);
      const contextEnd = objectEnd >= 0 ? objectEnd + 1 : Math.min(text.length, match.index + match[0].length + 700);
      const context = text.slice(contextStart, contextEnd);
      const label = readEmbeddedEatonDocumentLabel(context, url, match[1]);
      const type = classifyEatonDocument(label, url);
      if (!documentUrlLooksDownloadable(url) && !documentUrlLooksRelevant(url, context, type) && !/\/content\/dam\/eaton\//i.test(url)) continue;
      if (!isEatonDocumentLink(label, url, catalogNumber)) continue;
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push({ type, label, url, sourceUrl });
    }
  });

  return documents;
}

function unescapeJsonUrl(value: string): string {
  return value.replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
}

function readEmbeddedEatonDocumentLabel(context: string, url: string, rawUrlToken: string): string {
  const labels: Array<{ label: string; score: number }> = [];
  const urlIndex = context.indexOf(rawUrlToken);
  for (const key of ["title", "resourceTitle", "documentTitle", "assetTitle", "name", "text", "documentType", "category"]) {
    const pattern = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']{2,180})["']`, "gi");
    for (const match of context.matchAll(pattern)) {
      const label = cleanText(match[1]);
      if (!label || /^https?:|^\/|^\d+$|^(?:download|view|pdf)$/i.test(label)) continue;
      const distance = urlIndex >= 0 && match.index !== undefined ? Math.abs(urlIndex - match.index) : 9999;
      const semanticBoost = /\b(?:data\s*sheet|datasheet|specification|manual|instruction|cad|model|drawing|certificate|declaration|conformity|curve|catalog|brochure)\b|\bDA-C[ES]-/i.test(label) ? 250 : 0;
      const titleBoost = /^(?:title|resourceTitle|documentTitle|assetTitle|name)$/i.test(key) ? 300 : 0;
      labels.push({ label, score: titleBoost + semanticBoost - distance });
    }
  }

  labels.sort((left, right) => right.score - left.score);
  const fallback = labels[0]?.label || url.split(/[/?#]/).filter(Boolean).pop() || "Document";
  return normalizeEatonDocumentLabel(cleanText(fallback), url);
}

function extractHtmlRelatedProductAttributes($: cheerio.CheerioAPI, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();

  $(".module-related-products a[href],.upsell-products a[href],.related-products-component__card a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const url = href ? toAbsoluteUrl(href, sourceUrl) : undefined;
    if (!url || !/\/skuPage\.[^/]+\.html/i.test(url)) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const catalogNumber = relatedCatalogNumberFromUrl(url) || cleanText($(element).text());
    const card = $(element).closest(".related-products-component__card,.slides,.col-xs-12");
    const description = cleanRelatedProductDescription(cleanElementText(card), catalogNumber);
    attributes.push({
      group: "Designed to work together",
      name: "Related Product",
      value: cleanText([catalogNumber, description].filter(Boolean).join(" - ") + ` (${url})`),
      sourceUrl
    });
  });

  return attributes.slice(0, 60);
}

function relatedCatalogNumberFromUrl(url: string): string | undefined {
  try {
    const match = new URL(url).pathname.match(/\/skuPage\.([^/]+?)\.html$/i);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function cleanRelatedProductDescription(value: string, catalogNumber: string | undefined): string | undefined {
  let cleaned = cleanText(value);
  if (catalogNumber) {
    const partPattern = escapeRegExp(catalogNumber);
    cleaned = cleanText(cleaned.replace(new RegExp(`^(?:${partPattern}\\s*){1,4}`, "i"), ""));
  }
  if (!cleaned || cleaned.toLowerCase() === catalogNumber?.toLowerCase()) return undefined;
  return cleaned;
}

function readEatonLinkLabel($: cheerio.CheerioAPI, element: any, url: string): string {
  const rawLabel =
    $(element).attr("data-title") ||
    $(element).attr("aria-label")?.replace(/^download\s+(?:pdf\s+)?for\s+/i, "") ||
    $(element).text() ||
    $(element).closest("[data-title]").attr("data-title") ||
    url.split("/").pop() ||
    "Document";
  const label = normalizeEatonDocumentLabel(cleanText(rawLabel), url);
  const category = cleanText($(element).closest(".resource-list-item").find(".resource-list-item__title").first().text());
  if (!category || new RegExp(`^${escapeRegExp(category)}\\s*:`, "i").test(label)) return label;
  if (/^(?:download|document)$/i.test(label)) return category;
  return label.toLowerCase().includes(category.toLowerCase()) ? label : cleanText(`${label} (${category})`);
}

function normalizeEatonDocumentLabel(label: string, url: string): string {
  const skuPdf = url.match(/\/skuPage\.([^/?#]+)\.pdf(?:[?#]|$)/i);
  if (skuPdf && /^(?:product specifications?|download|document)$/i.test(label)) {
    return `Eaton Specification Sheet - ${cleanText(decodeUrlPart(skuPdf[1]))}`;
  }
  return label;
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function firstSrcsetUrl(srcset: string | undefined): string | undefined {
  return srcset
    ?.split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .find(Boolean);
}

function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  if (!value || /^javascript:|^mailto:|^tel:|^data:/i.test(value)) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function looksLikeEatonProductImage(context: string, catalogNumber: string): boolean {
  const haystack = context.toLowerCase();
  if (/logo|icon|email|social|geolocation|cookie|support|knowledge|registration|myeaton|footer|spinner|loader|article-feature|getty|rol-byod|abstract/i.test(haystack)) return false;
  if (/resources\/siteconfig|siteconfig\/360|\/360\.png|characteristic-curve|curve-|schematic|diagram/i.test(haystack)) return false;
  if (/\b(?:related-products|upsell-products|cross-sell|card-product-tiles)\b/i.test(haystack)) return false;
  if (/\.spin(?:[?#\s]|$)/i.test(haystack)) return false;
  const compactPart = compactCatalogNumber(catalogNumber);
  const compactHaystack = compactCatalogNumber(context);
  if (compactPart && compactHaystack.includes(compactPart)) return true;
  return /\/mdmfiles\//i.test(haystack) && /product|sku|catalog|image|photo/i.test(haystack);
}

function isEatonDocumentLink(label: string, url: string, catalogNumber: string): boolean {
  const combined = `${label} ${url}`;
  if (documentUrlLooksDownloadable(url)) return true;
  if (/\.(pdf|zip|dwg|dxf|stp|step|igs|iges)(?:[?#]|$)/i.test(url)) return true;
  if (/\b(catalog|brochure|manual|guide|instruction|data\s*sheet|datasheet|technical|specification|drawing|cad|ecad|mcad|3d model|2d model|curve|certificate|declaration|application note|service bulletin)\b|\bda-c[es]-/i.test(combined)) {
    return /\/content\/dam\/eaton\//i.test(url) || catalogTextMatches(combined, catalogNumber);
  }
  return false;
}

function classifyEatonDocument(label: string, url: string): DocumentRecord["type"] {
  const combined = `${label} ${url}`;
  if (/\/skuPage\.[^/]+\.pdf(?:[?#]|$)/i.test(url)) return "datasheet";
  if (/\.(?:dwg|dxf|stp|step|zip)(?:[?#]|$)|\b(?:cad|ecad|mcad|3d|2d|drawing|3d model|2d model)\b|\bda-c[es]-/i.test(combined)) return "cad";
  if (/\b(?:manual|instruction|installation|user guide|service manual)\b/i.test(combined)) return "manual";
  if (/\b(?:warranty|guarantee|service plan|service option|service contract)\b/i.test(combined)) return "other";
  if (/\b(?:characteristic curve|curve|schematic|diagram)\b/i.test(combined)) return "other";
  if (/\b(?:certificate|certification|declaration|conformity|rohs|weee|reach|prop(?:osition)?\s*65)\b/i.test(combined)) return "certificate";
  if (/\.(?:pdf)(?:[?#]|$)/i.test(url)) return "datasheet";
  return classifyDocument(label, url);
}

function extractMarkdownImages(text: string, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const match of text.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const label = cleanText(match[1]) || "Product image";
    const originalUrl = match[2];
    const url = normalizeEatonImageUrl(originalUrl);
    const haystack = `${label} ${originalUrl} ${url}`.toLowerCase();
    if (!haystack.includes(catalogNumber.toLowerCase()) && !/\/mdmfiles\//i.test(originalUrl)) continue;
    if (/logo|icon|email|social|geolocation|cookie/i.test(haystack)) continue;
    documents.push({ type: "image", label, url, sourceUrl });
  }
  return documents.slice(0, 8);
}

function normalizeEatonImageUrl(url: string): string {
  const match = url.match(/\/mdmfiles\/[^/]+\/([^/?#]+)\/(?:\d+x\d+_[^/?#]+)/i);
  if (!match) return url;
  return `https://dynamicmedia.eaton.com/is/image/eaton/${encodeURIComponent(match[1])}?wid=500&hei=500`;
}

function extractMarkdownLinks(text: string, catalogNumber: string, sourceUrl: string): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  for (const link of readMarkdownLinks(text)) {
    const label = cleanText(link.label);
    const url = link.url;
    if (!/\.(pdf|zip|dwg|dxf|stp|step)(?:[?#]|$)/i.test(url) && !isEatonDocumentLink(label, url, catalogNumber)) continue;
    const type = classifyEatonDocument(label, url);
    if (type === "other" && !catalogTextMatches(`${label} ${url}`, catalogNumber) && !/\bwarranty\b/i.test(`${label} ${url}`)) continue;
    documents.push({ type, label, url, sourceUrl });
  }
  return documents;
}

function readMarkdownLinks(text: string): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  const linkStartPattern = /\[([^\]]+)\]\(/g;
  for (const match of text.matchAll(linkStartPattern)) {
    const urlStart = (match.index ?? 0) + match[0].length;
    const urlEnd = findMarkdownUrlEnd(text, urlStart);
    if (urlEnd <= urlStart) continue;
    const url = cleanText(text.slice(urlStart, urlEnd).replace(/^<|>$/g, ""));
    if (!/^https?:\/\//i.test(url)) continue;
    links.push({ label: match[1], url });
  }
  return links;
}

function findMarkdownUrlEnd(text: string, urlStart: number): number {
  let depth = 0;
  for (let index = urlStart; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") continue;
    if (depth === 0) return index;
    depth -= 1;
  }
  return -1;
}

function readDescription(lines: string[], catalogNumber: string): string | undefined {
  const descriptionLabel = lines.find((line) => /^\*?\*?descriptionLabel\*?\*?/i.test(line));
  if (descriptionLabel) {
    const text = cleanText(descriptionLabel.replace(/^\*?\*?descriptionLabel\*?\*?/i, ""));
    if (text && !isIgnoredAttributeSection(text)) return text;
  }
  const headingIndex = lines.findIndex((line) => line.replace(/^#+\s*/, "").toLowerCase().startsWith(catalogNumber.toLowerCase()));
  if (headingIndex >= 0) {
    return lines.slice(headingIndex + 1).find((line) => {
      const cleaned = cleanText(line);
      if (cleaned.length <= 20) return false;
      if (/^#+\s/.test(line)) return false;
      if (/^(?:specifications|resources|sku|serial number|unexpected error|please|welcome|enter your|×|x$|are you sure)/i.test(cleaned)) return false;
      if (isIgnoredAttributeSection(cleaned)) return false;
      if (isLikelyNavLine(line)) return false;
      if (/^\[/.test(cleaned)) return false; // markdown link line
      if (/^!?\[/.test(cleaned)) return false; // markdown image line
      return true;
    });
  }
  return undefined;
}

function readMarkdownTitle(lines: string[]): string | undefined {
  return cleanText(
    readPrefixedLine(lines, "Title:")?.replace(/\s+\|\s+Eaton$/i, "") ||
      lines.find((line) => line.startsWith("# "))?.replace(/^#+\s*/, "").replace(/\s+\|\s+Eaton$/i, "")
  );
}

function readPrefixedLine(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

function cleanMarkdownLine(value: string): string {
  return cleanText(value.replace(/^[-*]\s+/, "").replace(/\\_/g, "_"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return dedupeSharedDocuments(documents, {
    // For dynamicmedia.eaton.com images, fold _C / _L / _R / _T / _B camera-angle variants into
    // a single bucket so we don't emit 3 near-identical photos per product. The "center" view
    // (suffix _C) is preferred; we score by view rank in dynamicMediaViewRank.
    bucketKey: dynamicMediaImageBucketKey,
    compare: compareEatonDocumentCandidates
  });
}

const EATON_DYNAMIC_MEDIA_IMAGE_PATTERN = /\/is\/image\/eaton\/([^?#/]+?)(?:_(C|L|R|T|B|F))(?=[?#]|$)/i;

function dynamicMediaImageBucketKey(doc: DocumentRecord): string | undefined {
  if (doc.type !== "image") return undefined;
  const match = doc.url.match(EATON_DYNAMIC_MEDIA_IMAGE_PATTERN);
  if (!match) return undefined;
  return `image:dm:${match[1].toLowerCase()}`;
}

function dynamicMediaViewRank(url: string): number {
  const match = url.match(EATON_DYNAMIC_MEDIA_IMAGE_PATTERN);
  if (!match) return 50;
  switch (match[2].toUpperCase()) {
    case "C": return 100; // center view — preferred primary
    case "F": return 90; // front
    case "T": return 70; // top
    case "R": return 60;
    case "L": return 60;
    case "B": return 40; // back/bottom
    default: return 50;
  }
}

function compareEatonDocumentCandidates(a: DocumentRecord, b: DocumentRecord): number {
  if (a.type === "image" && b.type === "image") {
    const rankDiff = dynamicMediaViewRank(a.url) - dynamicMediaViewRank(b.url);
    if (rankDiff !== 0) return rankDiff;
  }
  return documentLabelScore(a) - documentLabelScore(b);
}

function documentLabelScore(doc: DocumentRecord): number {
  let score = doc.label.length;
  if (/\b(eaton specification sheet|data\s*sheet|datasheet|technical data|3d drawing|cad|manual|installation|catalog)\b/i.test(doc.label)) score += 80;
  if (/^(download|document|product specifications?)$/i.test(doc.label)) score -= 60;
  if (doc.type === "datasheet" || doc.type === "cad" || doc.type === "manual") score += 20;
  return score;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
