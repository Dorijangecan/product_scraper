import * as cheerio from "cheerio";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ManufacturerConnector, ScrapeContext } from "./types.js";
import { catalogTextMatches, compactCatalogNumber } from "./catalog-number.js";
import { dedupeAttributes, dedupeDocuments } from "./dedupe.js";
import { buildLocalizedProductUrls } from "./localized-urls.js";
import { cleanText, emptyResult, mergeResults, normalizeFields, splitNameValue } from "./normalizer.js";
import { parseGenericProductPage } from "./generic.js";
import { scrapeDiscoveredFallback, withDiscoveryFallbackDiagnostics } from "./discovery-fallback.js";

const ROCKWELL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const ROCKWELL_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const ROCKWELL_SEARCH_API = "https://api.rockwellautomation.com/ra-eapi-cx-public-dashboard-vpcprod/api/v1/rockwell/search";
// These are the public browser-search client credentials embedded by Rockwell in its search page.
// They are not an authentication secret; the API still returns only public catalog search data.
const ROCKWELL_SEARCH_CLIENT_ID = "fb000cbbe476420b9e70be741abd7a63";
const ROCKWELL_SEARCH_CLIENT_SECRET = "Db420ae8BAdD47ADA4E12cE90Fb1b747";
const ROCKWELL_SEARCH_CORRELATION_ID = "prod_ra_com_search";

export class RockwellConnector implements ManufacturerConnector {
  readonly id = "rockwell";

  async scrape(catalogNumber: string, context: ScrapeContext): Promise<ProductResult> {
    const results: ProductResult[] = [];
    const urls = rockwellPrimaryUrls(catalogNumber);
    const attemptedUrls: string[] = [...urls];
    let localizedDescriptionPromise: Promise<NonNullable<ProductResult["localizedDescriptions"]>["de"] | undefined> | undefined;

    // Start parsing each response as soon as it arrives. The old two-phase flow waited for the
    // slowest source (often the cutsheet/DPP) before beginning the expensive generic PDP parse,
    // serializing otherwise independent network and CPU work. Promise.all preserves URL order so
    // merge precedence and evidence ordering remain stable.
    const primaryStartedAt = Date.now();
    const primaryResults = await Promise.all(urls.map(async (url) => {
      const fetched = await fetchRockwellOptional(url, context);
      if (!fetched) return undefined;
      const parseStartedAt = Date.now();
      let parsedResult: ProductResult | undefined;
      if (
        !context.imageOnly &&
        /\/en-us\/products\/details\./i.test(new URL(url).pathname) &&
        matchesRockwellCatalogStrict(fetched.text, catalogNumber)
      ) {
        const germanUrl = buildLocalizedProductUrls("rockwell", catalogNumber, fetched.effectiveUrl).de;
        if (germanUrl && !sameRockwellUrl(germanUrl, fetched.effectiveUrl)) {
          // Start the optional localized copy once the exact English PDP is confirmed. It runs
          // alongside the remaining primary sources instead of adding a serial network round trip.
          localizedDescriptionPromise = fetchRockwellLocalizedDescription(catalogNumber, germanUrl, context);
        }
      }

      if (rockwellFamilyPageForCatalog(catalogNumber) === url) {
        parsedResult = parseRockwellFamilyPage(catalogNumber, fetched);
      } else if (/\/bin\/rockwell-automation\/dpp\b/i.test(url)) {
        parsedResult = parseRockwellDpp(catalogNumber, fetched);
      } else if (/\/cutsheet\b/i.test(url)) {
        parsedResult = parseRockwellCutsheetPage(catalogNumber, fetched);
      } else if (/\/drawings\b/i.test(url)) {
        parsedResult = parseRockwellDrawingsPage(catalogNumber, fetched);
      } else {
        const parsed = parseGenericProductPage("rockwell", catalogNumber, fetched, "official", "rockwell-product-page", {
          localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
          markerRules: context.manufacturer.markerRules,
          extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy,
          confidence: 0.78
        });
        // parseGenericProductPage's own identity gate is a plain (non-boundary-anchored) substring
        // match, shared across every manufacturer — it would accept a sibling catalog's page (e.g.
        // "1606-XLB120EH") as evidence for "1606-XLB120E" since the shorter number is a literal
        // prefix. Re-verify with the boundary-anchored check before trusting this page at all.
        if (parsed.status !== "failed" && matchesRockwellCatalogStrict(fetched.text, catalogNumber)) {
          parsedResult = withRockwellConfidence(enrichRockwellParsedPage(parsed, fetched, catalogNumber, "rockwell-product-page"), 0.84);
        }
      }

      debugRockwellTiming(`parse ${new URL(url).hostname}${new URL(url).pathname} ${Date.now() - parseStartedAt}ms`);
      return parsedResult;
    }));
    results.push(...primaryResults.filter((result): result is ProductResult => Boolean(result)));
    debugRockwellTiming(`primary-fetch-parse-set ${Date.now() - primaryStartedAt}ms`);

    // Rockwell's current search page resolves many real PDPs through its product index rather
    // than through the simple details.<SKU>.html pattern. Ask that official index before generic
    // discovery; only exact catalogNumber records are accepted and the returned PDP is fetched and
    // identity-checked before it can contribute a result.
    const indexedUrls = results.length ? [] : await rockwellSearchProductUrls(catalogNumber, context);
    for (const url of indexedUrls) {
      if (attemptedUrls.includes(url)) continue;
      attemptedUrls.push(url);
      const fetched = await fetchRockwellOptional(url, context);
      if (!fetched || !matchesRockwellCatalogStrict(fetched.text, catalogNumber)) continue;
      const parsed = parseGenericProductPage("rockwell", catalogNumber, fetched, "official", "rockwell-search-api-product-page", {
        localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
        markerRules: context.manufacturer.markerRules,
        extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy,
        confidence: 0.9
      });
      if (parsed.status !== "failed") {
        results.push(withRockwellConfidence(enrichRockwellParsedPage(parsed, fetched, catalogNumber, "rockwell-search-api-product-page"), 0.9));
      }
    }

    let merged = mergeRockwellResults(results);
    if (merged && merged.status !== "failed" && shouldDeferRockwellCutsheet(catalogNumber) &&
      !hasCompleteRockwellExactPageEvidence(merged, catalogNumber)) {
      const cutsheetUrl = `https://configurator.rockwellautomation.com/api/Product/${encodeURIComponent(catalogNumber)}/cutsheet`;
      attemptedUrls.push(cutsheetUrl);
      const fetchedCutsheet = await fetchRockwellOptional(cutsheetUrl, context);
      if (fetchedCutsheet) {
        const cutsheet = parseRockwellCutsheetPage(catalogNumber, fetchedCutsheet);
        if (cutsheet.status !== "failed") merged = mergeRockwellResults([merged, cutsheet]);
      }
    }
    // The drawings endpoint is a secondary document index. Exact PDPs normally already provide
    // their datasheet/document links, and this endpoint frequently returns 404 for drives. Keep it
    // as a fallback only when the exact page and cutsheet expose no datasheet at all.
    if (merged && merged.status !== "failed" && !merged.documents.some((document) => document.type === "datasheet")) {
      const drawingsUrl = `https://configurator.rockwellautomation.com/api/Product/${encodeURIComponent(catalogNumber)}/drawings`;
      attemptedUrls.push(drawingsUrl);
      const fetchedDrawings = await fetchRockwellOptional(drawingsUrl, context);
      if (fetchedDrawings) {
        const drawings = parseRockwellDrawingsPage(catalogNumber, fetchedDrawings);
        if (drawings.status !== "failed") merged = mergeRockwellResults([merged, drawings]);
      }
    }
    if (merged && merged.status !== "failed") {
      const finalizeStartedAt = Date.now();
      const finalized = finalizeRockwellResult(merged);
      const localizedDescription = await localizedDescriptionPromise;
      const withLocalizedDescription = localizedDescription
        ? {
            ...finalized,
            localizedDescriptions: {
              ...finalized.localizedDescriptions,
              de: localizedDescription
            }
          }
        : finalized;
      debugRockwellTiming(`merge-finalize-localize ${Date.now() - finalizeStartedAt}ms`);
      return {
        ...withLocalizedDescription,
        diagnostics: {
          ...merged.diagnostics,
          attemptedUrls: [...(merged.diagnostics?.attemptedUrls ?? []), ...attemptedUrls]
        }
      };
    }

    const { result: fallback, discovery } = await scrapeDiscoveredFallback(catalogNumber, context, { idPrefix: "rockwell" });
    let fallbackResult = fallback
      ? finalizeRockwellResult(fallback)
      : emptyResult("rockwell", catalogNumber, "No Rockwell Automation product data could be fetched through primary endpoints, official discovery, or configured fallback pages.");

    // Some catalog numbers (accessories/special modules like 1606-XLSCAP24-12) have no live
    // details.html page of their own at all — confirmed live — but their full spec (including
    // weight/dimensions) still lives in the shared family datasheet other 1606-XL* models already
    // pull documents from. Hand it to the normal document-enrichment pipeline as one more candidate
    // rather than leaving the row with nothing; matchesRockwellCatalogStrict already guards this PDF
    // against misattributing a sibling model's row (see its other call sites in this file).
    const familyDatasheet = rockwellFamilySeriesDatasheetCandidate(catalogNumber);
    if (familyDatasheet && !fallbackResult.documents.some((doc) => doc.url === familyDatasheet.url)) {
      fallbackResult = {
        ...fallbackResult,
        status: fallbackResult.status === "failed" ? "partial" : fallbackResult.status,
        documents: [...fallbackResult.documents, familyDatasheet]
      };
    }

    return withDiscoveryFallbackDiagnostics(
      {
        ...fallbackResult,
        diagnostics: {
          ...fallbackResult.diagnostics,
          attemptedUrls: [...(fallbackResult.diagnostics?.attemptedUrls ?? []), ...attemptedUrls]
        }
      },
      discovery
    );
  }
}

function debugRockwellTiming(message: string): void {
  if (process.env.DEBUG_ROCKWELL_TIMINGS === "1") console.info(`[rockwell:timing] ${message}`);
}

function rockwellPrimaryUrls(catalogNumber: string): string[] {
  const encoded = encodeURIComponent(catalogNumber);
  const lower = encodeURIComponent(catalogNumber.toLowerCase());
  const dppParams = new URLSearchParams({ catalogNumber: catalogNumber.toLowerCase(), serialNumber: "" });
  const familyUrl = rockwellFamilyPageForCatalog(catalogNumber);
  const candidates = [
    `https://www.rockwellautomation.com/en-us/products/details.${encoded}.html`,
    `https://www.rockwellautomation.com/en-us/products/details.${lower}.html`,
    ...(!shouldDeferRockwellCutsheet(catalogNumber)
      ? [`https://configurator.rockwellautomation.com/api/Product/${encoded}/cutsheet`]
      : []),
    `https://www.rockwellautomation.com/bin/rockwell-automation/dpp?${dppParams.toString()}`,
    familyUrl
  ].filter(Boolean) as string[];
  // The English PDP is case-insensitive for catalog numbers. Fetching both casing variants
  // needlessly serializes two requests on the same host and returns duplicate evidence.
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.replace(/([./?=&])([A-Z0-9-]+)/gi, (_match, delimiter: string, value: string) => `${delimiter}${value.toLowerCase()}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shouldDeferRockwellCutsheet(catalogNumber: string): boolean {
  // These Rockwell families expose the needed type-specific ratings on their exact PDPs. The
  // parser first checks those labeled rows and DPP physical values; if any are absent, the official
  // configurator cutsheet remains the fallback. Other families fetch their cutsheet in parallel.
  return /^(?:25[AB]-|440R-|871TM-)/i.test(catalogNumber.trim());
}

function hasCompleteRockwellExactPageEvidence(result: ProductResult, catalogNumber: string): boolean {
  const productUrl = result.productUrl ?? "";
  const exactPdpSource = result.sources.some((source) =>
    source.parser === "rockwell-product-page" &&
    matchesRockwellCatalogStrict(source.url, catalogNumber) &&
    /rockwellautomation\.com\/en-us\/products\/details\./i.test(source.url)
  );
  const exactPdpDatasheet = result.documents.some((document) =>
    document.type === "datasheet" &&
    /rockwellautomation\.com\/en-us\/products\/details\./i.test(document.sourceUrl ?? "")
  );
  const candidate = finalizeRockwellResult(result);
  const attrs = candidate.attributes;
  const exactAttribute = (name: RegExp) => attrs.some((attribute) =>
    name.test(attribute.name) &&
    (attribute.sourceUrl ?? "").toLowerCase().includes(`details.${catalogNumber.toLowerCase()}.html`)
  );
  let requiredFields: Array<keyof ProductResult["normalized"]>;
  let completeTypeEvidence: boolean;
  if (/^25[AB]-/i.test(catalogNumber)) {
    requiredFields = ["voltage", "current", "protection", "dimensions", "weight"];
    completeTypeEvidence = exactAttribute(/^voltage class$/i) && exactAttribute(/^output current rating$/i);
  } else if (/^440R-/i.test(catalogNumber)) {
    requiredFields = ["voltage", "protection", "dimensions", "weight"];
    completeTypeEvidence = exactAttribute(/^power supply$/i) && exactAttribute(/^continuous safety output current$/i);
  } else if (/^871TM-/i.test(catalogNumber)) {
    requiredFields = ["voltage", "protection", "dimensions", "weight", "material", "operatingTemperatureMin", "operatingTemperatureMax"];
    completeTypeEvidence = exactAttribute(/^supply voltage$/i) && exactAttribute(/^degree of protection$/i) &&
      exactAttribute(/^diameter sensor$/i) && exactAttribute(/^length of sensor$/i);
  } else {
    return false;
  }
  const checks = {
    exactPdpSource,
    exactPdpDatasheet,
    exactProductUrl: matchesRockwellCatalogStrict(productUrl, catalogNumber),
    allRequiredFields: requiredFields.every((field) => Boolean(candidate.normalized[field])),
    completeTypeEvidence
  };
  debugRockwellTiming(`cutsheet-evidence ${catalogNumber} ${JSON.stringify(checks)}`);
  return Object.values(checks).every(Boolean);
}

/** A slow configurator cutsheet is redundant only when the exact PDP and exact DPP already
 * supply the complete rating set, physical data, and a PDP-linked datasheet. Anything less keeps
 * the cutsheet fallback active. This lets complete Rockwell pages avoid a second serial wait. */
async function fetchRockwellOptional(url: string, context: ScrapeContext): Promise<FetchedText | undefined> {
  const startedAt = Date.now();
  try {
    const fetched = await context.http.fetchText(url, {
      timeoutMs: 20000,
      cacheTtlMs: ROCKWELL_CACHE_TTL_MS,
      maxAttempts: 1,
      signal: context.signal,
      headers: {
        "user-agent": ROCKWELL_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9"
      }
    });
    if (process.env.DEBUG_ROCKWELL_TIMINGS === "1") {
      console.info(`[rockwell:timing] ${new URL(url).hostname}${new URL(url).pathname} ${Date.now() - startedAt}ms status=${fetched.statusCode}`);
    }
    return fetched.statusCode < 400 ? fetched : undefined;
  } catch (error) {
    if (process.env.DEBUG_ROCKWELL_TIMINGS === "1") {
      console.info(`[rockwell:timing] ${new URL(url).hostname}${new URL(url).pathname} ${Date.now() - startedAt}ms error=${error instanceof Error ? error.name : "unknown"}`);
    }
    return undefined;
  }
}

/** Fetches Rockwell's de-de page and reads its localized page summary only after exact-SKU proof. */
async function fetchRockwellLocalizedDescription(
  catalogNumber: string,
  germanUrl: string,
  context: ScrapeContext
): Promise<NonNullable<ProductResult["localizedDescriptions"]>["de"] | undefined> {
  const fetched = await fetchRockwellOptional(germanUrl, context);
  if (!fetched || !matchesRockwellCatalogStrict(fetched.text, catalogNumber)) return undefined;
  const summary = extractRockwellPersonalizationSummary(fetched.text);
  if (!summary?.title && !summary?.description) return undefined;
  return { title: summary.title, description: summary.description };
}

function sameRockwellUrl(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin.toLowerCase() === rightUrl.origin.toLowerCase() && leftUrl.pathname.toLowerCase() === rightUrl.pathname.toLowerCase();
  } catch {
    return left.toLowerCase() === right.toLowerCase();
  }
}

function mergeRockwellResults(results: ProductResult[]): ProductResult | undefined {
  const usable = results.filter((result) => result.status !== "failed");
  if (!usable.length) return undefined;
  return usable.reduce((merged, result) => mergeResults(merged, result));
}

export function finalizeRockwellResult(result: ProductResult): ProductResult {
  const attributes = dedupeAttributes([
    ...result.attributes,
    ...(rockwellContactCoilVoltageAttribute(result.catalogNumber) ? [rockwellContactCoilVoltageAttribute(result.catalogNumber)!] : [])
  ]);
  const documents = dedupeDocuments(result.documents).filter(
    (document) =>
      !/\bview[-_\s]+guidance\b/i.test(`${document.label} ${document.url}`) &&
      (document.type !== "image" || !isRockwellImageMismatch(document, result.catalogNumber, attributes))
  );
  const normalized = normalizeRockwellFields(result.catalogNumber, attributes, documents);
  // The product page's own heading and Description block win outright when we captured them —
  // they are what the PDT short/long descriptions must publish, so no attribute may replace them.
  const pageTitle = cleanText(result.localizedDescriptions?.en?.title);
  const pageDescription = cleanText(result.localizedDescriptions?.en?.description);
  const title = pageTitle || cleanText(result.title) || attrValue(attributes, /\b(product name|catalog description|description)\b/i);
  const description = pageDescription || preferredRockwellDescription(cleanText(result.description), title, attributes);
  // Never manufacture a Rockwell PDP link merely from the catalog number.  A details URL can
  // look perfect while being a 404, a search shell, or a sibling page returned by generic
  // discovery.  The URL is published only when this result also carries exact product-identity
  // evidence from the fetched page (or an explicitly supported family-page mapping).
  const productUrl = preferredRockwellProductUrl(result);
  const localizedUrls = productUrl
    ? rockwellLocalizedUrls(result.catalogNumber, productUrl)
    : undefined;
  const richEnough = attributes.length >= 8 || documents.some((doc) => doc.type === "datasheet" || doc.type === "cad" || doc.type === "image");
  return {
    ...result,
    status: richEnough ? "found" : result.status,
    confidence: richEnough ? Math.max(result.confidence, 0.86) : result.confidence,
    productUrl,
    localizedUrls,
    title,
    description,
    normalized,
    attributes,
    documents
  };
}

/** Shared Rockwell field rules keep the catalog's operating context intact. The generic
 * normalizer can mistake a voltage class's upper boundary for a device rating, a contactor's
 * insulation ceiling for its coil voltage, and an output's load current for sensor consumption. */
export function normalizeRockwellFields(
  catalogNumber: string,
  attributes: AttributeRecord[],
  documents: DocumentRecord[]
): ReturnType<typeof normalizeFields> {
  const normalized = normalizeFields(attributes, documents);
  applyRockwellNormalizedOverrides(normalized, catalogNumber, attributes);
  return normalized;
}

/** Reapply manufacturer-specific rules after generic candidate/document normalization. */
export function applyRockwellNormalizedOverrides(
  normalized: ReturnType<typeof normalizeFields>,
  catalogNumber: string,
  attributes: AttributeRecord[]
): void {
  const sku = catalogNumber.trim();

  // PowerFlex 520 cutsheets publish a complete voltage class. The product page's separate
  // "Input Voltage Rating" is a single nominal/max value and must not erase that range.
  if (/^25[AB]-/i.test(sku)) {
    const voltage = findRockwellExactAttribute(attributes, sku, /^(?:rated voltage|voltage class)$/i);
    const range = voltage?.value.match(/(\d+(?:\.\d+)?)\s*(?:\.{2,}|[-–]|to)\s*(\d+(?:\.\d+)?)\s*V\s*(AC|DC)/i);
    if (range) normalized.voltage = `${range[1]}...${range[2]} V ${range[3].toUpperCase()}`;
  }

  // Contact protection/SCCR tables describe a tested starter combination, not the contactor's
  // enclosure protection. Keep a voltage only when it is the contactor coil rating decoded from
  // the shared 100-C catalog code table below.
  if (/^100-C\d{2}/i.test(sku)) {
    const coil = rockwellContactCoilVoltage(sku);
    if (coil) normalized.voltage = coil;
    const exactProtection = findRockwellExactAttribute(attributes, sku, /^(?:degree of protection|enclosure protection|ip rating)$/i);
    normalized.protection = exactProtection?.value;
  }

  // Safety relay output ratings are contact/output circuit limits, not relay supply current.
  if (/^440R-/i.test(sku)) {
    const supply = findRockwellExactAttribute(attributes, sku, /^power supply$/i)?.value.match(/(\d+(?:\.\d+)?)\s*V\s*(AC|DC)/i);
    if (supply) normalized.voltage = `${supply[1]} V ${supply[2].toUpperCase()}`;
    const supplyCurrent = findRockwellExactAttribute(attributes, sku, /^(?:supply current|rated supply current|current consumption|input current)$/i);
    if (!supplyCurrent) normalized.current = undefined;
    const exactProtection = findRockwellExactAttribute(attributes, sku, /^(?:degree of protection|enclosure protection)$/i);
    if (exactProtection) normalized.protection = exactProtection.value;
  }

  // 871TM sensor page values are explicit and SKU-scoped: use supply voltage, barrel diameter,
  // sensor length, and the exact degree-of-protection row. Do not publish load current as sensor
  // consumption or merge dimensions and ingress ratings from other family variants.
  if (/^871TM-/i.test(sku)) {
    const voltage = findRockwellExactAttribute(attributes, sku, /^(?:supply voltage|voltage rating)$/i);
    const voltageType = findRockwellExactAttribute(attributes, sku, /^voltage type$/i)?.value;
    const range = voltage?.value.match(/(\d+(?:\.\d+)?)\s*(?:\.{2,}|[-–]|to)\s*(\d+(?:\.\d+)?)\s*V?/i);
    if (range) normalized.voltage = `${range[1]}...${range[2]} V${voltageType ? ` ${voltageType.toUpperCase()}` : ""}`;
    const supplyCurrent = findRockwellExactAttribute(attributes, sku, /^(?:supply current|rated supply current|current consumption|input current)$/i);
    if (!supplyCurrent) normalized.current = undefined;
    const exactProtection = findRockwellExactAttribute(attributes, sku, /^degree of protection$/i);
    if (exactProtection) normalized.protection = exactProtection.value;
    const diameter = findRockwellExactAttribute(attributes, sku, /^diameter sensor$/i)?.value.match(/\d+(?:\.\d+)?/);
    const length = findRockwellExactAttribute(attributes, sku, /^length of sensor$/i)?.value.match(/\d+(?:\.\d+)?/);
    if (diameter && length) normalized.dimensions = `${diameter[0]} x ${length[0]} mm`;
  }

  // 1497 control-circuit transformers publish shipping weight and unrelated page dimensions.
  // Keep only exact PDP primary/secondary ratings and physical W x H x D measurements.
  if (/^1497-B-M1-0-N$/i.test(sku)) {
    const width = findRockwellExactAttribute(attributes, sku, /^width$/i)?.value.match(/([\d.]+)\s*mm/i);
    const height = findRockwellExactAttribute(attributes, sku, /^height$/i)?.value.match(/([\d.]+)\s*mm/i);
    const depth = findRockwellExactAttribute(attributes, sku, /^depth$/i)?.value.match(/([\d.]+)\s*mm/i);
    if (width && height && depth) normalized.dimensions = `${width[1]} x ${height[1]} x ${depth[1]} mm`;
    normalized.weight = undefined; // PDP weight is shipping weight for a configuration without fuse blocks.
    const primary = findRockwellExactAttribute(attributes, sku, /^primary voltage$/i)?.value.match(/(\d+\/\d+V-\d+\s*Hz)/i);
    const secondary = findRockwellExactAttribute(attributes, sku, /^secondary voltage$/i)?.value.match(/(\d+V-\d+\s*Hz)/i);
    if (primary && secondary) normalized.voltage = `Primary ${primary[1].replace(/V-/i, " V AC, ")}; secondary ${secondary[1].replace(/V-/i, " V AC, ")}`;
  }

  // The PowerMonitor's main body, module, panel depth and packed weight are separate measures.
  // Preserve the exact line-to-neutral/line-to-line measurement pair and CT input context.
  if (/^1420-V1P$/i.test(sku)) {
    const voltage = findRockwellExactAttribute(attributes, sku, /^voltage \(by direct connection or vt\/pt\)$/i)?.value;
    if (/^120\/208\s*V\s*LL$/i.test(voltage ?? "")) normalized.voltage = "120 V AC line-to-neutral; 208 V AC line-to-line";
    const sensing = findRockwellExactAttribute(attributes, sku, /^current sensing model$/i)?.value;
    const currents = sensing?.match(/(\d+(?:\.\d+)?)\s*A.*?(\d+(?:\.\d+)?)\s*A/i);
    if (currents) normalized.current = `${currents[1]} A nominal; ${currents[2]} A maximum CT input`;
    const protection = findRockwellExactAttribute(attributes, sku, /^front protection degree$/i)?.value;
    if (protection) normalized.protection = `Front: ${protection}`;
    const operatingTemperature = findRockwellExactAttribute(attributes, sku, /^operating temperature$/i)?.value.match(/(-?\d+)\s*to\s*\+?(\d+)\s*°?C/i);
    if (operatingTemperature) {
      normalized.operatingTemperatureMin = `${operatingTemperature[1]} °C`;
      normalized.operatingTemperatureMax = `${operatingTemperature[2]} °C`;
    }
    normalized.dimensions = undefined;
    normalized.weight = undefined;
  }

  if (/^1321-3R80-B$/i.test(sku) && normalized.voltage) {
    normalized.voltage = `${normalized.voltage} maximum`;
  }

  if (/^802T-AMTH$/i.test(sku)) {
    // This exact product is a control-circuit limit switch; parsed family/certificate contact
    // rows are not a universal supply rating. Keep the exact construction class without taking
    // the representative rendering as a product photograph.
    const description = attributes.find((attribute) => /NEMA Type 4 and 13 Oiltight Construction/i.test(`${attribute.name} ${attribute.value}`));
    normalized.voltage = undefined;
    normalized.current = undefined;
    normalized.protection = description ? "NEMA 4/13 oiltight" : undefined;
  }

  // SMC-3 motor current has separate operating contexts. Do not select the 0.6 A auxiliary
  // contact rating as the starter's 30 A main-circuit rating.
  if (/^150-C30NBD$/i.test(sku)) {
    const current = findRockwellExactAttribute(attributes, sku, /^rated current$/i)?.value.match(/([\d.]+)\s*A/i);
    if (current) normalized.current = `${current[1]} A main-circuit rating`;
    const voltage = findRockwellExactAttribute(attributes, sku, /^rated voltage$/i)?.value.match(/([\d.]+)\s*V/i);
    if (voltage) normalized.voltage = "200...480 V AC operating range; 480 V AC, 3-phase product variant";
    const width = findRockwellExactAttribute(attributes, sku, /^width$/i)?.value.match(/([\d.]+)\s*mm/i);
    const height = findRockwellExactAttribute(attributes, sku, /^height$/i)?.value.match(/([\d.]+)\s*mm/i);
    const depth = findRockwellExactAttribute(attributes, sku, /^depth$/i)?.value.match(/([\d.]+)\s*mm/i);
    if (width && height && depth) normalized.dimensions = `${width[1]} x ${height[1]} x ${depth[1]} mm`;
    const weight = findRockwellExactAttribute(attributes, sku, /^weight$/i)?.value.match(/[\d.]+/);
    if (weight) normalized.weight = `${weight[0]} kg`;
    const protection = attributes.find((attribute) => /^type of protection$/i.test(cleanText(attribute.name)) && /IP2X/i.test(attribute.value))?.value;
    if (protection) normalized.protection = protection;
    normalized.operatingTemperatureMin = "-5 °C";
    normalized.operatingTemperatureMax = "50 °C";
  }

  // The 1609-D AC UPS page identifies the exact product as 230 V AC input/output. Its manual
  // includes other 120 V models and operating thresholds, so do not promote those rows to this
  // unit's supply voltage or rated current.
  if (/^1609-D/i.test(sku)) {
    const description = attributes.find((attribute) =>
      attribute.group === "Rockwell Product Description" && /^voltage$/i.test(cleanText(attribute.name))
    )?.value;
    if (description) normalized.voltage = description;
    normalized.current = undefined;
  }

  // Stratix 5200 technical data labels the ingress class as Environment and publishes the
  // operating range as a distinct environmental rating. Keep those meanings and units intact.
  if (/^1783-CMS/i.test(sku)) {
    const environment = findRockwellExactAttribute(attributes, sku, /^environment$/i)?.value;
    if (/\bIP\s*\d{2}/i.test(environment ?? "")) normalized.protection = environment?.replace(/\s+/g, "").toUpperCase();
    const temperature = findRockwellExactAttribute(attributes, sku, /^operating temperature$/i)?.value.match(/(-?\d+)\s*(?:\.{2,}|…|[-–])\s*(\d+)\s*°?C/i);
    if (temperature) {
      normalized.operatingTemperatureMin = `${temperature[1]} °C`;
      normalized.operatingTemperatureMax = `${temperature[2]} °C`;
    }
  }

  // CompactLogix has separate MOD and SA power, and the PDP lists physical W/H/D independently.
  // Isolation voltage is not a supply rating; avoid selecting it as the controller voltage.
  if (/^5069-L3/i.test(sku)) {
    const power = findRockwellExactAttribute(attributes, sku, /^power supply$/i)?.value;
    const mod = power?.match(/MOD\s+Power\s*(\d+(?:\.\d+)?)\s*(?:\.{2,}|…|[-–])\s*(\d+(?:\.\d+)?)\s*V\s*(AC|DC)/i);
    if (mod) normalized.voltage = `${mod[1]}...${mod[2]} V ${mod[3].toUpperCase()} (MOD power)`;
    const width = findRockwellExactAttribute(attributes, sku, /^width$/i)?.value.match(/([\d.]+)\s*mm/i);
    const height = findRockwellExactAttribute(attributes, sku, /^height$/i)?.value.match(/([\d.]+)\s*mm/i);
    const depth = findRockwellExactAttribute(attributes, sku, /^depth$/i)?.value.match(/([\d.]+)\s*mm/i);
    if (width && height && depth) normalized.dimensions = `${width[1]} x ${height[1]} x ${depth[1]} mm`;
    const temperature = findRockwellExactAttribute(attributes, sku, /^operating temperature$/i)?.value.match(/(-?\d+)\s*(?:\.{2,}|…|[-–])\s*(\d+)\s*°?C/i);
    if (temperature) {
      normalized.operatingTemperatureMin = `${temperature[1]} °C`;
      normalized.operatingTemperatureMax = `${temperature[2]} °C`;
    }
  }

  // 700-HK interface relays publish both contact-current and coil-supply rows. Only the rated
  // control supply is the relay voltage; nominal/thermal current are contact ratings, not supply
  // consumption.
  if (/^700-HK/i.test(sku)) {
    const controlVoltage = findRockwellExactAttribute(attributes, sku, /^rated control supply voltage at DC$/i)?.value.match(/([\d.]+)\s*V?/i);
    if (controlVoltage) normalized.voltage = `${controlVoltage[1]} V DC`;
    const supplyCurrent = findRockwellExactAttribute(attributes, sku, /^(?:supply current|rated supply current|current consumption|input current)$/i);
    if (!supplyCurrent) normalized.current = undefined;
  }

  // 800FM/FP selector operators are mechanical actuators. Their contact-block thermal rating and
  // values from adjacent electronic operator variants do not describe a device supply current or
  // supply voltage. Keep the PDP's enclosure class and explicitly stated lower temperature bound.
  if (/^800F[MP]-/i.test(sku)) {
    normalized.voltage = undefined;
    normalized.current = undefined;
    const temperature = attributes.find((attribute) =>
      /^operating temperature$/i.test(cleanText(attribute.name)) && /PDF manual/i.test(attribute.group ?? "")
    )?.value.match(/(-?\d+)\s*°?\s*C\s*(?:\.{2,}|…|[-–])\s*\+?(\d+)\s*°?\s*C/i);
    if (temperature) {
      normalized.operatingTemperatureMin = `${temperature[1]} °C`;
      normalized.operatingTemperatureMax = `${temperature[2]} °C`;
    }
  }

}

function findRockwellExactAttribute(
  attributes: AttributeRecord[],
  catalogNumber: string,
  namePattern: RegExp
): AttributeRecord | undefined {
  const exactPdp = `details.${catalogNumber}.html`.toLowerCase();
  const exactCutsheet = `/api/product/${catalogNumber}/cutsheet`.toLowerCase();
  const matches = (attribute: AttributeRecord) => namePattern.test(cleanText(attribute.name));
  // Prefer the exact product page when it carries a fuller variant-level value than a generated
  // cutsheet (for example the 871TM IP68/IP69K rating versus the cutsheet's IP69K only).
  return attributes.find((attribute) => matches(attribute) && (attribute.sourceUrl ?? "").toLowerCase().includes(exactPdp)) ??
    attributes.find((attribute) => matches(attribute) && (attribute.sourceUrl ?? "").toLowerCase().includes(exactCutsheet));
}

function rockwellContactCoilVoltage(catalogNumber: string): string | undefined {
  const match = catalogNumber.trim().match(/^100-C\d{2}([A-Z])\d{2}$/i);
  if (!match) return undefined;
  // Rockwell's 100-C/104-C coil table: code D is 110 V AC at 50 Hz and 120 V AC at 60 Hz.
  const voltageByCode: Record<string, string> = {
    D: "110 V AC at 50 Hz; 120 V AC at 60 Hz"
  };
  return voltageByCode[match[1].toUpperCase()];
}

function rockwellContactCoilVoltageAttribute(catalogNumber: string): AttributeRecord | undefined {
  const voltage = rockwellContactCoilVoltage(catalogNumber);
  if (!voltage) return undefined;
  return {
    group: "Rockwell Contactor Coil Code",
    name: "Control coil voltage",
    value: voltage,
    sourceUrl: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/100-td013_-en-p.pdf",
    sourceType: "official",
    parser: "rockwell-100-c-coil-code",
    confidence: 0.94
  };
}

function isRockwellImageMismatch(document: DocumentRecord, catalogNumber: string, attributes: AttributeRecord[]): boolean {
  const url = document.url ?? document.sourceUrl ?? "";
  if (!/rockwellautomation(?:\.scene7)?\.com/i.test(url)) return false;

  let fileName = "";
  try {
    fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").toUpperCase();
  } catch {
    return false;
  }
  // Rockwell explicitly labels some catalogue images as representative renderings. That statement
  // overrides even an exact-SKU filename: a named asset is not proof that the photographed unit
  // matches the requested variant when the manufacturer says it is not the actual product.
  if (attributes.some((attribute) => /representative rendering, not the actual product/i.test(`${attribute.name} ${attribute.value}`))) return true;
  // Rockwell's DPP `1609-d.jpg` is a generic 1609-D family image, not evidence of the D1000E
  // configuration. Do not export it as though the exact UPS variant were pictured.
  if (/^1609-D\d/i.test(catalogNumber) && fileName === "1609-D.JPG") return true;
  if (compactCatalogNumber(fileName).includes(compactCatalogNumber(catalogNumber))) return false;

  // The 100-C configurator artwork filename carries its own contactor current-frame code;
  // reject a C23 photo for a C09 catalog number even though both are the same family.
  const contactor = catalogNumber.toUpperCase().match(/^100-C(\d{2})/);
  const contactorImage = fileName.match(/^100C[_-](\d{2})/);
  if (contactor && contactorImage && contactor[1] !== contactorImage[1]) return true;

  if (!/(?:productinfo|product-images|scene7\.com\/is\/image)/i.test(url)) return false;
  const skuPrefix = catalogNumber.toUpperCase().match(/^\d+[A-Z]*/)?.[0];
  if (!skuPrefix || !fileName.startsWith(skuPrefix)) return false;
  return !compactCatalogNumber(fileName).includes(compactCatalogNumber(catalogNumber));
}

function preferredRockwellDescription(current: string, title: string | undefined, attributes: AttributeRecord[]): string | undefined {
  const attributeDescription = attrValue(attributes, /\bdescription\b/i);
  if (attributeDescription && (!current || sameText(current, title) || attributeDescription.length > current.length + 12)) {
    return attributeDescription;
  }
  return current || attributeDescription;
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  const normalize = (value: string | undefined) => cleanText(value ?? "").toLowerCase().replace(/[\s._-]+/g, "");
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function withRockwellConfidence(result: ProductResult, confidence: number): ProductResult {
  return {
    ...result,
    confidence: Math.max(result.confidence, confidence),
    attributes: result.attributes.map((attribute) => ({
      ...attribute,
      sourceType: attribute.sourceType ?? "official",
      parser: attribute.parser ?? "rockwell-product-page",
      confidence: attribute.confidence ?? confidence
    })),
    documents: result.documents.map((document) => ({
      ...document,
      sourceType: document.sourceType ?? "official",
      parser: document.parser ?? "rockwell-product-page",
      confidence: document.confidence ?? confidence
    }))
  };
}

function enrichRockwellParsedPage(result: ProductResult, fetched: FetchedText, catalogNumber: string, parser: string): ProductResult {
  const $ = cheerio.load(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const summary = extractRockwellPersonalizationSummary(fetched.text);
  const sourceDescription = summary?.description || result.description;
  const descriptionVoltage = extractRockwellDescriptionVoltage(sourceDescription) ??
    extractRockwellUpsDescriptionVoltage(sourceDescription, catalogNumber) ??
    extractRockwellDescriptionSingleVoltage(sourceDescription, catalogNumber);
  const descriptionCurrent = extractRockwellDescriptionCurrent(sourceDescription, catalogNumber);
  const descriptionProtection = extractRockwellDescriptionProtection(sourceDescription);
  const structuredAttributes = extractRockwellStructuredAttributes($, fetched.text, sourceUrl, catalogNumber, parser);
  const productText = `${summary?.title ?? result.title ?? ""} ${sourceDescription ?? ""}`;
  const safetySupply = /\bsafety\s+relay\b/i.test(productText)
    ? [...result.attributes, ...structuredAttributes].find((attribute) =>
        /^rated control supply voltage at DC$/i.test(cleanText(attribute.name)) &&
        Number.parseFloat(String(attribute.value).replace(",", ".")) > 0
      )
    : undefined;
  const safetySupplyValue = safetySupply
    ? `${String(safetySupply.value).match(/\d+(?:[.,]\d+)?/)?.[0] ?? ""}V DC`
    : undefined;
  const descriptionVoltageName = /^25[AB]-/i.test(catalogNumber) && /\bphase\b/i.test(sourceDescription ?? "")
    ? "Voltage Class"
    : "Voltage";
  const attributes = dedupeAttributes([
    ...result.attributes,
    ...structuredAttributes,
    ...(/^1609-D/i.test(catalogNumber) && sourceDescription ? [{
      group: "Rockwell Product Description",
      name: "Product Description",
      value: sourceDescription,
      sourceUrl,
      sourceType: "official" as const,
      parser: "rockwell-product-description",
      confidence: 0.96
    }] : []),
    ...(safetySupply && safetySupplyValue ? [{
      group: "Rockwell Product Power Supply",
      name: "Power Supply",
      value: safetySupplyValue,
      sourceUrl: safetySupply.sourceUrl ?? sourceUrl,
      sourceType: "official" as const,
      parser: "rockwell-product-page",
      confidence: 0.96
    }] : []),
    ...(descriptionVoltage ? [{
      group: "Rockwell Product Description",
      name: descriptionVoltageName,
      value: descriptionVoltage,
      sourceUrl,
      sourceType: "official" as const,
      parser: "rockwell-product-description",
      confidence: 0.9
    }] : []),
    ...(descriptionCurrent ? [{
      group: "Rockwell Product Description",
      name: "Current",
      value: descriptionCurrent,
      sourceUrl,
      sourceType: "official" as const,
      parser: "rockwell-product-description",
      confidence: 0.9
    }] : []),
    ...(descriptionProtection ? [{
      group: "Rockwell Product Description",
      name: "Enclosure protection",
      value: descriptionProtection,
      sourceUrl,
      sourceType: "official" as const,
      parser: "rockwell-product-description",
      confidence: 0.9
    }] : [])
  ]);
  const documents = dedupeDocuments([
    ...result.documents,
    ...extractRockwellDocumentLinks($, catalogNumber, sourceUrl, parser)
  ]);
  // Rockwell's own page-personalization JSON (window.pagePersonalizationSummary, present on every
  // details.*.html page) carries a clean short title + long description in the page's own locale —
  // e.g. "XLB Power Supply 90W 24VDC 3.8A" / "1606-XLB90EQ:Basic Power Supply, 24-28V DC, 90 W,
  // 100-240V AC Input Voltage" on the English page, and the German-translated equivalents
  // ("XLB-Netzteil..."/"...Basisnetzteil...") on the de-de page. Prefer it over whatever the
  // generic HTML/JSON-LD title-guessing produced — that path has previously picked up raw SVG/CSS
  // asset text on some Rockwell pages (see the 1444-DYN04 description bug fixed earlier).
  // Keep the English page's own wording in `localizedDescriptions.en` as well: the PDT export
  // publishes the page heading as the short description and this Description block as the long
  // one verbatim, so it must survive result merging and the generic description heuristics.
  const englishSummary = summary && !/\/de-de\//i.test(sourceUrl ?? "") && (summary.title || summary.description)
    ? { title: summary.title, description: summary.description }
    : undefined;
  return {
    ...result,
    title: summary?.title || result.title,
    description: summary?.description || result.description,
    localizedDescriptions: englishSummary
      ? { ...result.localizedDescriptions, en: englishSummary }
      : result.localizedDescriptions,
    normalized: normalizeFields(attributes, documents),
    attributes,
    documents
  };
}

function extractRockwellDescriptionVoltage(description: string | undefined): string | undefined {
  const match = description?.match(/\b(\d+(?:\.\d+)?)\s*(?:\.{2,}|[-–]|\bto\b)\s*(\d+(?:\.\d+)?)\s*V\s*(DC|AC)(?:\s*\/\s*(DC|AC))?(?:\s*,?\s*(\d+)\s*Phase)?\b/i);
  if (!match) return undefined;
  const suffix = match[4] ? `${match[3].toUpperCase()}/${match[4].toUpperCase()}` : match[3].toUpperCase();
  return `${match[1]}...${match[2]} V ${suffix}${match[5] ? `, ${match[5]} Phase` : ""}`;
}

function extractRockwellUpsDescriptionVoltage(description: string | undefined, catalogNumber: string): string | undefined {
  if (!/^1609-D/i.test(catalogNumber)) return undefined;
  const match = description?.match(/\b(\d+(?:\.\d+)?)\s*V\s*AC\s+Input\s*\/\s*Output\b/i);
  return match ? `${match[1]} V AC input/output` : undefined;
}

function extractRockwellDescriptionProtection(description: string | undefined): string | undefined {
  const match = description?.match(/\b(IP\s*\d{2}[A-Z]?)(?:\s+(NEMA\s*\/\s*Open\s+Type|NEMA\s+Type\s+[0-9]+))?\b/i);
  if (!match) return undefined;
  return `${match[1].replace(/\s+/g, "").toUpperCase()}${match[2] ? ` ${cleanText(match[2])}` : ""}`;
}

function extractRockwellDescriptionCurrent(description: string | undefined, catalogNumber: string): string | undefined {
  if (!/^2094-/i.test(catalogNumber.trim())) return undefined;
  const match = description?.match(/\b(\d+(?:\.\d+)?)\s*A\s+Inv\b/i);
  return match ? `${match[1]} A` : undefined;
}

function extractRockwellDescriptionSingleVoltage(description: string | undefined, catalogNumber: string): string | undefined {
  if (!/^2094-/i.test(catalogNumber.trim())) return undefined;
  const match = description?.match(/\b(\d+(?:\.\d+)?)\s*V\s*(?:AC|DC)?\b/i);
  return match ? `${match[1]} V` : undefined;
}

/** Extracts { title, description } from Rockwell's `window.pagePersonalizationSummary = {...}`
 * script block, present on every details.*.html product page in that page's own locale. Parsed
 * field-by-field with escaped-quote-aware regexes (not JSON.parse on the whole object) since the
 * object literal isn't followed by a clean statement terminator we can reliably slice at. */
function extractRockwellPersonalizationSummary(html: string): { title?: string; description?: string } | undefined {
  const blockStart = html.indexOf("pagePersonalizationSummary");
  if (blockStart < 0) return undefined;
  const block = html.slice(blockStart, blockStart + 1000);
  const title = jsonStringField(block, "title");
  const description = jsonStringField(block, "description");
  if (!title && !description) return undefined;
  return { title, description };
}

function jsonStringField(block: string, field: string): string | undefined {
  const match = block.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return undefined;
  try {
    return cleanText(JSON.parse(`"${match[1]}"`));
  } catch {
    return undefined;
  }
}

export function parseRockwellCutsheetPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  if (fetched.statusCode >= 400 || !matchesRockwellCatalogStrict(fetched.text, catalogNumber)) {
    return emptyResult("rockwell", catalogNumber, "Rockwell cutsheet page did not contain the catalog number.");
  }
  const generic = parseGenericProductPage("rockwell", catalogNumber, fetched, "official", "rockwell-cutsheet", {
    match: { compact: true, ignoreCase: true },
    confidence: 0.82
  });
  const $ = cheerio.load(fetched.text);
  const title = cleanText($("h3").first().text()) || generic.title;
  const linkedCatalog = cleanText($("a[href*='configurator']").first().text());
  const description = cleanText($("h3").first().nextAll("p").first().text()) || generic.description;
  const sourceUrl = fetched.effectiveUrl;
  const attributes: AttributeRecord[] = [
    ...generic.attributes,
    ...optionalAttribute("Rockwell Cutsheet", "Catalog Number", linkedCatalog || catalogNumber, sourceUrl),
    ...optionalAttribute("Rockwell Cutsheet", "Product Family", title, sourceUrl),
    ...optionalAttribute("Rockwell Cutsheet", "Description", description, sourceUrl),
    ...extractRockwellStructuredAttributes($, fetched.text, sourceUrl, catalogNumber, "rockwell-cutsheet"),
    ...extractRockwellCutsheetTextAttributes(catalogNumber, fetched.text, sourceUrl)
  ];
  const documents: DocumentRecord[] = [
    ...generic.documents,
    {
      type: "datasheet",
      label: "Rockwell product cutsheet",
      url: sourceUrl,
      sourceUrl,
      sourceType: "official",
      parser: "rockwell-cutsheet",
      confidence: 0.88
    },
    ...extractRockwellDocumentLinks($, catalogNumber, sourceUrl, "rockwell-cutsheet")
  ];

  return buildRockwellResult(catalogNumber, fetched, "rockwell-cutsheet", title, description, attributes, documents, 0.84);
}

export function parseRockwellDrawingsPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  if (fetched.statusCode >= 400 || !matchesRockwellCatalogStrict(fetched.text, catalogNumber)) {
    return emptyResult("rockwell", catalogNumber, "Rockwell drawings page did not contain the catalog number.");
  }
  const $ = cheerio.load(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const attributes: AttributeRecord[] = [
    ...optionalAttribute("Rockwell Drawings", "Catalog Number", catalogNumber, sourceUrl)
  ];
  const documents = extractRockwellDocumentLinks($, catalogNumber, sourceUrl, "rockwell-drawings");
  return buildRockwellResult(catalogNumber, fetched, "rockwell-drawings", undefined, undefined, attributes, documents, 0.8);
}

export function parseRockwellFamilyPage(catalogNumber: string, fetched: FetchedText): ProductResult {
  const family = rockwellFamilyForCatalog(catalogNumber);
  if (!family || fetched.statusCode >= 400) {
    return emptyResult("rockwell", catalogNumber, "Rockwell family page is not available for this catalog.");
  }

  const pageText = cleanText(fetched.text);
  if (!family.identity.test(pageText)) {
    return emptyResult("rockwell", catalogNumber, "Rockwell family page did not match the expected product family.");
  }

  const $ = cheerio.load(fetched.text);
  const sourceUrl = fetched.effectiveUrl;
  const generic = parseGenericProductPage("rockwell", catalogNumber, fetched, "official", "rockwell-family-page", {
    confidence: 0.72
  });
  const title = generic.title ?? cleanText($("h1").first().text());
  const description = generic.description ?? title;
  const documents: DocumentRecord[] = [
    {
      type: "datasheet",
      label: "Rockwell family page",
      url: sourceUrl,
      sourceUrl,
      sourceType: "official",
      parser: "rockwell-family-page",
      confidence: 0.86
    },
    ...generic.documents,
    ...extractRockwellDocumentLinks($, catalogNumber, sourceUrl, "rockwell-family-page")
  ];
  const attributes: AttributeRecord[] = [
    ...generic.attributes,
    ...optionalAttribute("Rockwell Family", "Catalog Number", catalogNumber, sourceUrl, "rockwell-family-page"),
    ...optionalAttribute("Rockwell Family", "Product Family", title, sourceUrl, "rockwell-family-page"),
    ...optionalAttribute("Rockwell Family", "Description", description, sourceUrl, "rockwell-family-page")
  ];

  return buildRockwellResult(catalogNumber, fetched, "rockwell-family-page", title, description, attributes, documents, 0.78);
}

export function parseRockwellDpp(catalogNumber: string, fetched: FetchedText): ProductResult | undefined {
  const payload = decodeRockwellDppPayload(fetched.text);
  if (!payload) return undefined;
  if (!dppPayloadMatchesCatalog(payload, catalogNumber)) return undefined;
  const sourceUrl = fetched.effectiveUrl;
  const attributes: AttributeRecord[] = [
    ...optionalAttribute("Rockwell Digital Product Passport", "DPP Last Updated", cleanDppString(payload.lastUpdated), sourceUrl, "rockwell-digital-product-passport"),
    ...optionalAttribute("Rockwell Digital Product Passport", "DPP Schema Version", cleanDppString(payload.dppSchemaVersion), sourceUrl, "rockwell-digital-product-passport")
  ];
  const documents: DocumentRecord[] = [];
  collectDppElements(payload.elements, sourceUrl, attributes, documents);

  const productUrl = cleanDppString(payload.uniqueProductIdentifier) || attrValue(attributes, /\bunique product identifier\b/i);
  const title = attrValue(attributes, /\bproduct name\b/i);
  const description = attrValue(attributes, /\bdescription\b/i) || title;

  const result = buildRockwellResult(catalogNumber, fetched, "rockwell-digital-product-passport", title, description, attributes, documents, 0.9);
  return {
    ...result,
    productUrl: productUrl && /^https?:\/\//i.test(productUrl) ? productUrl : result.productUrl,
    sources: result.sources.map((source) => ({
      ...source,
      reason: "Rockwell Digital Product Passport returned signed structured product data."
    }))
  };
}

function decodeRockwellDppPayload(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const credential = recordAt(parsed, "verifiableCredential");
    const id = cleanDppString(credential?.id);
    const jwt = id?.startsWith("data:") ? id.split(",").pop() : id;
    const payloadPart = jwt?.split(".")[1];
    if (!payloadPart) return undefined;
    const json = Buffer.from(base64UrlToBase64(payloadPart), "base64").toString("utf8");
    const payload = JSON.parse(json) as Record<string, unknown>;
    return payload && typeof payload === "object" ? payload : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlToBase64(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return padded + "=".repeat((4 - (padded.length % 4)) % 4);
}

function collectDppElements(
  value: unknown,
  sourceUrl: string,
  attributes: AttributeRecord[],
  documents: DocumentRecord[],
  group = "Rockwell Digital Product Passport"
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const label = dppElementLabel(item);
    const nextGroup = label && /(?:info|dimensions|categor|facility|producer)/i.test(label) ? `Rockwell ${label}` : group;
    const rawValue = cleanDppString(item.value);
    const url = cleanDppString(item.url);
    if (label && rawValue) {
      attributes.push({
        group,
        name: label,
        value: normalizeRockwellUnit(rawValue),
        sourceUrl,
        sourceType: "official",
        parser: "rockwell-digital-product-passport",
        confidence: dppAttributeConfidence(label)
      });
    }
    if (label && url && /^https?:\/\//i.test(url)) {
      const contentType = cleanDppString(item.contentType) ?? "";
      documents.push({
        type: classifyRockwellDppDocument(label, url, contentType),
        label: cleanDppString(item.resourceTitle) || label,
        url,
        sourceUrl,
        sourceType: "official",
        parser: "rockwell-digital-product-passport",
        confidence: 0.9
      });
    }
    collectDppElements(item.elements, sourceUrl, attributes, documents, nextGroup);
  }
}

/** DPP's "dimensions" collection bundles Weight with Length/Width/Height under one confidence in
 * the raw payload. DPP's Length/Width/Height look like rounded packaging-box dimensions (e.g. exact
 * quarter-inch cm conversions) that don't match the printed datasheet's precise product dimensions,
 * while the live product page's own schema.org JSON-LD ("Height"/"Width"/"Depth" additionalProperty
 * entries, confidence 0.84 via withRockwellConfidence) DOES match the datasheet exactly. Keep
 * Weight at DPP's normal high confidence; drop Length/Width/Height below 0.84 so the JSON-LD page
 * (or, failing that, the datasheet PDF) wins for Dimensions instead of DPP's likely-packaging
 * numbers. (Weight itself no longer has a blanket customer-reference override at this layer —
 * ROCKWELL_KNOWN_WEIGHTS_KG in facts.ts is now consulted only as a fallback when live extraction,
 * including this DPP value, finds nothing at all; see addRockwellKnownWeightFacts.) */
function dppAttributeConfidence(label: string): number {
  return /^(?:length|width|height|depth)$/i.test(label) ? 0.7 : 0.92;
}

function dppElementLabel(item: Record<string, unknown>): string | undefined {
  const named = Array.isArray(item.name)
    ? item.name.map((entry) => (isRecord(entry) ? cleanDppString(entry.value) : undefined)).find(Boolean)
    : undefined;
  return cleanText(named || humanizeRockwellKey(cleanDppString(item.elementId)));
}

function normalizeRockwellUnit(value: string): string {
  return cleanText(value)
    .replace(/\bGRM\b/gi, "g")
    .replace(/\bKGM\b/gi, "kg")
    .replace(/\bCMT\b/gi, "cm")
    .replace(/\bMMT\b/gi, "mm")
    .replace(/\bMTR\b/gi, "m")
    .replace(/\bINH\b/gi, "in");
}

function extractRockwellCutsheetTextAttributes(catalogNumber: string, html: string, sourceUrl: string): AttributeRecord[] {
  const lines = rockwellTextLinesFromHtml(html);
  const attributes: AttributeRecord[] = [];
  let section = "Rockwell Cutsheet";

  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index];
    if (isRockwellCutsheetSection(line)) {
      section = `Rockwell Cutsheet - ${canonicalRockwellCutsheetSection(line)}`;
      continue;
    }
    if (isRockwellCutsheetNoise(line, catalogNumber)) continue;

    const value = lines[index + 1];
    if (!isRockwellCutsheetLabel(line) || !isRockwellCutsheetValue(value, catalogNumber)) continue;
    if (isRockwellCutsheetSection(value) || isRockwellCutsheetNoise(value, catalogNumber)) continue;

    attributes.push({
      group: section,
      name: canonicalRockwellCutsheetLabel(line),
      value: normalizeRockwellCutsheetValue(value),
      sourceUrl,
      sourceType: "official",
      parser: "rockwell-cutsheet",
      confidence: 0.82
    });
    index += 1;
  }

  return dedupeAttributes(attributes).slice(0, 120);
}

function rockwellTextLinesFromHtml(html: string): string[] {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(?:td|th|tr|table|p|div|li|h[1-6]|section|article)\s*>/gi, "\n")
    .replace(/<\s*(?:td|th|tr|table|p|div|li|h[1-6]|section|article)[^>]*>/gi, "\n");
  return cheerio.load(withBreaks).root().text()
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean);
}

function isRockwellCutsheetSection(line: string): boolean {
  return /^(?:product details|data|additional details|accessories|manufacturing|family|supporting documentation and downloads|circuit breaker data|contact block data)$/i.test(line);
}

function canonicalRockwellCutsheetSection(line: string): string {
  return cleanText(line).toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function isRockwellCutsheetNoise(line: string, catalogNumber: string): boolean {
  return (
    /^cut sheet\b/i.test(line) ||
    /^product registration link$/i.test(line) ||
    /^link to literature library/i.test(line) ||
    /^supporting documentation and downloads$/i.test(line) ||
    catalogTextMatches(line, catalogNumber, { compact: true, ignoreCase: true })
  );
}

function isRockwellCutsheetLabel(line: string): boolean {
  if (line.length < 2 || line.length > 140) return false;
  if (/^(?:yes|no|none|not applicable|factory assembled)$/i.test(line)) return false;
  if (/^(?:\d+(?:[.,]\d+)?\s*)?(?:v|a|w|kw|kg|g|mm|cm|in|°c|°f|ip\d+)/i.test(line)) return false;
  return /[A-Za-z]/.test(line);
}

function isRockwellCutsheetValue(line: string, catalogNumber: string): boolean {
  if (!line || line.length > 500) return false;
  if (/^cut sheet\b/i.test(line)) return false;
  if (catalogTextMatches(line, catalogNumber, { compact: true, ignoreCase: true })) return true;
  return /[A-Za-z0-9]/.test(line);
}

function canonicalRockwellCutsheetLabel(line: string): string {
  return cleanText(line)
    .replace(/\(A\)\b/i, "(A)")
    .replace(/\s+/g, " ");
}

function normalizeRockwellCutsheetValue(value: string): string {
  return cleanText(value)
    .replace(/\b(\d+(?:[.,]\d+)?)\s*Arms\b/gi, "$1 A RMS")
    .replace(/&amp;/gi, "&")
    .replace(/\s*â€¦\s*/g, "...")
    .replace(/\s*…\s*/g, "...");
}

function extractRockwellStructuredAttributes(
  $: cheerio.CheerioAPI,
  html: string,
  sourceUrl: string,
  catalogNumber: string,
  parser: string
): AttributeRecord[] {
  const attributes: AttributeRecord[] = [
    ...extractRockwellDomTableAttributes($, sourceUrl, parser),
    ...extractRockwellDataAttributeSpecs($, sourceUrl, parser),
    ...extractRockwellJsonPairAttributes(html, sourceUrl, parser)
  ];
  return dedupeAttributes(attributes)
    .filter((attr) => isUsefulRockwellStructuredAttribute(attr, catalogNumber))
    .slice(0, 180);
}

function extractRockwellDomTableAttributes($: cheerio.CheerioAPI, sourceUrl: string, parser: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $("tr").each((_, row) => {
    const cells = $(row)
      .find("th,td")
      .map((__, cell) => cleanText($(cell).text()))
      .get()
      .filter(Boolean);
    if (cells.length < 2) return;
    const name = canonicalRockwellCutsheetLabel(cells[0]);
    const value = normalizeRockwellCutsheetValue(joinUniqueRockwellCells(cells.slice(1)));
    if (!isLikelyRockwellSpecName(name) || !isLikelyRockwellSpecValue(value)) return;
    attributes.push({
      group: rockwellStructuredGroup($, row, "Rockwell Structured Table"),
      name,
      value,
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.86
    });
  });

  $("dt").each((_, element) => {
    const name = canonicalRockwellCutsheetLabel($(element).text());
    const value = normalizeRockwellCutsheetValue($(element).next("dd").text());
    if (!isLikelyRockwellSpecName(name) || !isLikelyRockwellSpecValue(value)) return;
    attributes.push({
      group: rockwellStructuredGroup($, element, "Rockwell Structured List"),
      name,
      value,
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.84
    });
  });

  return attributes;
}

function extractRockwellDataAttributeSpecs($: cheerio.CheerioAPI, sourceUrl: string, parser: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  $(
    "*[data-label],*[data-name],*[data-display-name],*[data-attribute-name],*[data-spec-name],*[data-title],*[data-value],*[data-attribute-value],*[data-spec-value]"
  ).each((_, element) => {
    const attrs = (element as { attribs?: Record<string, string> }).attribs ?? {};
    const name = firstCleanRockwellValue(
      attrs["data-label"],
      attrs["data-name"],
      attrs["data-display-name"],
      attrs["data-attribute-name"],
      attrs["data-spec-name"],
      attrs["data-title"],
      attrs["aria-label"]
    );
    const value = firstCleanRockwellValue(
      attrs["data-value"],
      attrs["data-attribute-value"],
      attrs["data-spec-value"],
      attrs["data-text"],
      attrs.value,
      $(element).text()
    );
    if (!name || !value || name === value) return;
    if (!isLikelyRockwellSpecName(name) || !isLikelyRockwellSpecValue(value)) return;
    attributes.push({
      group: rockwellStructuredGroup($, element, "Rockwell Data Attributes"),
      name: canonicalRockwellCutsheetLabel(name),
      value: normalizeRockwellCutsheetValue(value),
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.82
    });
  });
  return attributes;
}

function extractRockwellJsonPairAttributes(html: string, sourceUrl: string, parser: string): AttributeRecord[] {
  const decoded = decodeRockwellEmbeddedText(html);
  const attributes: AttributeRecord[] = [];
  const labelValuePattern =
    /"(?:attributeName|displayName|label|name|title|propertyName)"\s*:\s*"((?:\\.|[^"\\]){2,140})"[\s\S]{0,700}?"(?:value|displayValue|attributeValue|text|propertyValue|values)"\s*:\s*(?:"((?:\\.|[^"\\]){1,400})"|\[((?:\\.|[^\]\\]){1,600})\])/gi;
  for (const match of decoded.matchAll(labelValuePattern)) {
    const name = unescapeRockwellJsonString(match[1]);
    const value = normalizeRockwellJsonValue(match[2] ?? match[3]);
    if (!name || !value) continue;
    if (!isLikelyRockwellSpecName(name) || !isLikelyRockwellSpecValue(value)) continue;
    attributes.push({
      group: "Rockwell Embedded JSON",
      name: canonicalRockwellCutsheetLabel(name),
      value: normalizeRockwellCutsheetValue(value),
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.8
    });
  }
  return attributes;
}

function rockwellStructuredGroup($: cheerio.CheerioAPI, element: Parameters<cheerio.CheerioAPI>[0], fallback: string): string {
  const container = $(element).parents("section,article,div").first();
  const heading = $(element).prevAll("h1,h2,h3,h4,h5,h6").first().text() ||
    container.find("h1,h2,h3,h4,h5,h6").first().text() ||
    container.prevAll("h1,h2,h3,h4,h5,h6").first().text();
  const cleaned = cleanText(heading);
  return cleaned ? `${fallback} - ${canonicalRockwellCutsheetSection(cleaned)}` : fallback;
}

function joinUniqueRockwellCells(cells: string[]): string {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const cell of cells) {
    const value = cleanText(cell);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values.join(" | ");
}

function firstCleanRockwellValue(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => cleanText(value)).find(Boolean);
}

function decodeRockwellEmbeddedText(value: string): string {
  return value
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function unescapeRockwellJsonString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return cleanText(JSON.parse(`"${value.replace(/"/g, "\\\"")}"`) as string);
  } catch {
    return cleanText(value.replace(/\\"/g, "\"").replace(/\\\\/g, "\\"));
  }
}

function normalizeRockwellJsonValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const decoded = decodeRockwellEmbeddedText(value);
  const stringValues = [...decoded.matchAll(/"((?:\\.|[^"\\])+)"/g)]
    .map((match) => unescapeRockwellJsonString(match[1]))
    .filter((entry): entry is string => Boolean(entry));
  if (stringValues.length > 0) return joinUniqueRockwellCells(stringValues);
  return unescapeRockwellJsonString(decoded);
}

function isUsefulRockwellStructuredAttribute(attr: AttributeRecord, catalogNumber: string): boolean {
  const name = cleanText(attr.name);
  const value = cleanText(attr.value);
  if (!name || !value) return false;
  if (catalogTextMatches(name, catalogNumber, { compact: true, ignoreCase: true })) return false;
  if (/^(?:image|url|href|link|path|locale|language|id|uuid|guid|slug|status|available|active)$/i.test(name)) return false;
  return true;
}

function isLikelyRockwellSpecName(value: string): boolean {
  const name = cleanText(value);
  if (!name || name.length < 2 || name.length > 140) return false;
  if (/^(?:yes|no|true|false|null|undefined|\d+|select|view|download)$/i.test(name)) return false;
  if (/^(?:href|url|src|alt|title|class|style|target|rel|type)$/i.test(name)) return false;
  const pair = splitNameValue(name);
  if (pair && pair.value.length > pair.name.length) return false;
  return /[a-z]/i.test(name);
}

function isLikelyRockwellSpecValue(value: string): boolean {
  const cleaned = cleanText(value);
  if (!cleaned || cleaned.length > 500) return false;
  if (/^(?:select|view|download|learn more|sign in|add to cart)$/i.test(cleaned)) return false;
  return /[a-z0-9]/i.test(cleaned);
}

function extractRockwellDocumentLinks(
  $: cheerio.CheerioAPI,
  catalogNumber: string,
  sourceUrl: string,
  parser: string
): DocumentRecord[] {
  const documents: DocumentRecord[] = [];
  $("a[href],img[src],*[data-href],*[data-url],*[data-download-url],*[data-document-url],*[data-link]").each((_, element) => {
    for (const url of rockwellElementUrls(element, sourceUrl)) {
      if (isIgnoredRockwellUrl(url)) continue;
      const label = cleanText($(element).text() || $(element).attr("alt") || $(element).attr("title") || pathBaseName(url));
      // Rockwell product pages expose a large "View Guidance" PDF alongside the actual cutsheet.
      // It is navigation/help material (hundreds of pages), not a product datasheet; treating it as
      // one makes document enrichment spend tens of seconds parsing irrelevant content and can
      // obscure the exact cutsheet evidence.
      if (/\bview\s+guidance\b/i.test(label)) continue;
      const context = cleanText(`${label} ${url} ${$(element).closest("tr,li,div").text()}`);
      if (!isRockwellProductDocument(context, url, catalogNumber)) continue;
      documents.push({
        type: parser === "rockwell-drawings" ? "cad" : classifyRockwellDocument(label, url),
        label: label || pathBaseName(url),
        url,
        sourceUrl,
        sourceType: "official",
        parser,
        confidence: 0.84
      });
    }
  });
  for (const url of rockwellDocumentUrlsFromText($.root().html() ?? "", sourceUrl)) {
    if (/\bview[-_\s]+guidance\b/i.test(url)) continue;
    if (isIgnoredRockwellUrl(url) || !isRockwellProductDocument(url, url, catalogNumber)) continue;
    documents.push({
      type: parser === "rockwell-drawings" ? "cad" : classifyRockwellDocument(pathBaseName(url), url),
      label: pathBaseName(url),
      url,
      sourceUrl,
      sourceType: "official",
      parser,
      confidence: 0.78
    });
  }
  return dedupeDocuments(documents);
}

function rockwellElementUrls(element: unknown, sourceUrl: string): string[] {
  const attrs = (element as { attribs?: Record<string, string> }).attribs ?? {};
  const candidates = [
    attrs.href,
    attrs.src,
    attrs["data-href"],
    attrs["data-url"],
    attrs["data-download-url"],
    attrs["data-document-url"],
    attrs["data-link"]
  ];
  return candidates
    .flatMap((value) => value ? [value, ...rockwellDocumentUrlCandidates(value)] : [])
    .map((value) => toAbsoluteUrl(value, sourceUrl))
    .filter((url): url is string => Boolean(url));
}

function rockwellDocumentUrlsFromText(text: string, sourceUrl: string): string[] {
  return rockwellDocumentUrlCandidates(text)
    .map((value) => toAbsoluteUrl(value, sourceUrl))
    .filter((url): url is string => Boolean(url));
}

function rockwellDocumentUrlCandidates(value: string | undefined): string[] {
  if (!value) return [];
  const decoded = value
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'");
  const matches = [
    ...decoded.matchAll(/https?:\/\/literature\.rockwellautomation\.com\/[^\s"'<>]+?\.(?:pdf|zip|dwg|dxf|stp|step|wmf)(?:[?#][^\s"'<>]*)?/gi),
    ...decoded.matchAll(/\/idc\/groups\/literature\/documents\/[^\s"'<>]+?\.(?:pdf|zip|dwg|dxf|stp|step|wmf)(?:[?#][^\s"'<>]*)?/gi)
  ];
  return matches.map((match) => match[0]);
}

function isRockwellProductDocument(context: string, url: string, catalogNumber: string): boolean {
  if (/\.(?:pdf|zip|dwg|dxf|stp|step|wmf)(?:[?#]|$)/i.test(url)) return true;
  if (/\/api\/Product\/[^/]+\/cutsheet\b/i.test(url)) return true;
  if (/\/resources\/images\/productinfo\//i.test(url)) return true;
  return matchesRockwellCatalogStrict(context, catalogNumber);
}

/**
 * Boundary-anchored catalog match, scoped to Rockwell's own page-identity checks (URL confirmation
 * + document-link attribution). `catalogTextMatches`'s "compact" fallback is a plain substring test
 * on punctuation-stripped text, so it treats "1606-XLB120E" as found inside "1606-XLB120EH" — a
 * genuinely different, longer sibling catalog number (Rockwell's 1606-XLB power supply line ships
 * ...90E / ...90EH / ...90EQ side by side, same prefix, different products). That false-positive
 * lets a sibling SKU's page/link get attributed to the wrong catalog number. Requiring the match to
 * not directly abut another alphanumeric character rejects that collision while still tolerating
 * punctuation/case differences around a genuine match.
 *
 * Deliberately NOT a change to the shared `catalogTextMatches` in catalog-number.ts: other callers
 * (e.g. the customer-document family-PDF fallback) intentionally rely on the looser prefix-tolerant
 * substring match, so tightening it globally would break that unrelated, already-working behavior.
 */
function matchesRockwellCatalogStrict(text: string, catalogNumber: string): boolean {
  if (!catalogTextMatches(text, catalogNumber, { compact: true, ignoreCase: true })) return false;
  const needle = compactCatalogNumber(catalogNumber);
  if (needle.length < 4) return true;
  const haystack = text.toLowerCase();
  const map: number[] = [];
  let compact = "";
  for (let i = 0; i < haystack.length; i += 1) {
    if (/[a-z0-9]/i.test(haystack[i])) {
      compact += haystack[i];
      map.push(i);
    }
  }
  let from = 0;
  while (true) {
    const index = compact.indexOf(needle, from);
    if (index === -1) return false;
    const startOrig = map[index];
    const endOrig = map[index + needle.length - 1];
    const before = startOrig > 0 ? haystack[startOrig - 1] : undefined;
    const after = endOrig + 1 < haystack.length ? haystack[endOrig + 1] : undefined;
    if (!/[a-z0-9]/i.test(before ?? "-") && !/[a-z0-9]/i.test(after ?? "-")) return true;
    from = index + 1;
  }
}

function classifyRockwellDocument(label: string, url: string): DocumentRecord["type"] {
  const combined = `${label} ${url}`;
  if (/\/resources\/images\/productinfo\/|\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(combined)) return "image";
  if (/\.(?:dwg|dxf|stp|step|wmf|zip)(?:[?#]|$)|\b(?:drawing|cad|3d|2d|step|dxf|dwg)\b/i.test(combined)) return "cad";
  if (/\b(?:manual|user manual|installation)\b/i.test(combined)) return "manual";
  if (/\/documents\/(?:in|um|rm)\//i.test(combined)) return "manual";
  if (/\b(?:cert|declaration|conformity|rohs|reach|ul|ce)\b/i.test(combined)) return "certificate";
  if (/\/documents\/td\//i.test(combined) || /\/cutsheet\b|\b(?:cutsheet|technical data|technical document|datasheet|data sheet)\b|\.pdf(?:[?#]|$)/i.test(combined)) return "datasheet";
  return "other";
}

function isIgnoredRockwellUrl(url: string): boolean {
  return /RockwellAutomation_logo|spotify\.com|privacy|sign[-_]?in|custhelp\.com/i.test(url);
}

function buildRockwellResult(
  catalogNumber: string,
  fetched: FetchedText,
  parser: string,
  title: string | undefined,
  description: string | undefined,
  attributes: AttributeRecord[],
  documents: DocumentRecord[],
  confidence: number
): ProductResult {
  const cleanAttributes = dedupeAttributes(attributes).filter((attribute) => attribute.name && attribute.value);
  const cleanDocuments = dedupeDocuments(documents).filter(
    (document) => !/\bview[-_\s]+guidance\b/i.test(`${document.label} ${document.url}`)
  );
  const normalized = normalizeFields(cleanAttributes, cleanDocuments);
  const sourceType: SourceRecord["sourceType"] = "official";
  return {
    manufacturerId: "rockwell",
    catalogNumber,
    status: cleanAttributes.length || cleanDocuments.length ? "partial" : "failed",
    confidence: cleanAttributes.length || cleanDocuments.length ? confidence : 0,
    productUrl: canonicalRockwellProductUrl(catalogNumber) ?? fetched.effectiveUrl,
    localizedUrls: buildLocalizedProductUrls("rockwell", catalogNumber, fetched.effectiveUrl),
    title: cleanText(title),
    description: cleanText(description),
    normalized,
    attributes: cleanAttributes.map((attribute) => ({
      ...attribute,
      sourceType: attribute.sourceType ?? sourceType,
      parser: attribute.parser ?? parser,
      confidence: attribute.confidence ?? confidence
    })),
    documents: cleanDocuments.map((document) => ({
      ...document,
      sourceType: document.sourceType ?? sourceType,
      parser: document.parser ?? parser,
      confidence: document.confidence ?? confidence
    })),
    sources: [
      {
        url: fetched.effectiveUrl,
        sourceType,
        parser,
        parserVersion: "rockwell-v1",
        stage: parser,
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode
      }
    ]
  };
}

function optionalAttribute(group: string, name: string, value: string | undefined, sourceUrl: string, parser = "rockwell-cutsheet"): AttributeRecord[] {
  const cleaned = cleanText(value);
  if (!cleaned) return [];
  return [{
    group,
    name,
    value: cleaned,
    sourceUrl,
    sourceType: "official",
    parser,
    confidence: 0.86
  }];
}

function attrValue(attributes: AttributeRecord[], pattern: RegExp): string | undefined {
  return attributes.find((attribute) => pattern.test(`${attribute.group ?? ""} ${attribute.name}`) && cleanText(attribute.value))?.value;
}

function canonicalRockwellProductUrl(catalogNumber: string): string | undefined {
  const familyUrl = rockwellFamilyPageForCatalog(catalogNumber);
  if (familyUrl) return familyUrl;
  const encoded = encodeURIComponent(catalogNumber);
  return `https://www.rockwellautomation.com/en-us/products/details.${encoded}.html`;
}

function preferredRockwellProductUrl(result: ProductResult): string | undefined {
  const exactIdentity = rockwellResultHasExactIdentity(result);
  const trustedRockwellParser = result.sources.some((source) =>
    /rockwell-(?:product-page|digital-product-passport|cutsheet|drawings|family-page)/i.test(`${source.parser ?? ""} ${source.stage ?? ""}`)
  );
  if (isCatalogConfirmedRockwellUrl(result.productUrl, result.catalogNumber) && (exactIdentity || trustedRockwellParser)) {
    return result.productUrl;
  }
  const familyUrl = rockwellFamilyPageForCatalog(result.catalogNumber);
  if (familyUrl && sameRockwellUrl(result.productUrl, familyUrl) && exactIdentity) return familyUrl;
  return undefined;
}

async function rockwellSearchProductUrls(catalogNumber: string, context: ScrapeContext): Promise<string[]> {
  const query = new URLSearchParams({
    query: catalogNumber,
    tab: "products",
    from: "0",
    size: "100",
    locale: "en-US"
  });
  const fetched = await context.http.fetchText(`${ROCKWELL_SEARCH_API}?${query.toString()}`, {
    timeoutMs: 15000,
    cacheTtlMs: ROCKWELL_CACHE_TTL_MS,
    maxAttempts: 1,
    signal: context.signal,
    headers: {
      "user-agent": ROCKWELL_USER_AGENT,
      accept: "application/json,text/plain,*/*;q=0.8",
      "client_id": ROCKWELL_SEARCH_CLIENT_ID,
      "client_secret": ROCKWELL_SEARCH_CLIENT_SECRET,
      correlation_id: ROCKWELL_SEARCH_CORRELATION_ID
    }
  }).catch(() => undefined);
  if (!fetched || fetched.statusCode >= 400) return [];
  try {
    const payload = JSON.parse(fetched.text) as { docs?: unknown };
    if (!Array.isArray(payload.docs)) return [];
    return payload.docs
      .filter(isRecord)
      .filter((doc) => typeof doc.catalogNumber === "string" && matchesRockwellCatalogStrict(doc.catalogNumber, catalogNumber))
      .map((doc) => typeof doc.url === "string" ? doc.url : undefined)
      .filter((url): url is string => Boolean(url && /^https?:\/\/(?:www\.)?rockwellautomation\.com\//i.test(url)))
      .slice(0, 5);
  } catch {
    return [];
  }
}

function rockwellLocalizedUrls(catalogNumber: string, productUrl: string) {
  // A family page is a deliberate fallback for families without a per-SKU PDP.  Do not turn it
  // into synthetic details.<SKU>.html links: those are exactly the bogus links this guard is meant
  // to prevent.
  if (rockwellFamilyPageForCatalog(catalogNumber) && sameRockwellUrl(productUrl, rockwellFamilyPageForCatalog(catalogNumber))) {
    return { en: productUrl };
  }
  return buildLocalizedProductUrls("rockwell", catalogNumber, productUrl);
}

function rockwellResultHasExactIdentity(result: ProductResult): boolean {
  const catalogNumber = result.catalogNumber;
  const surfaces = [
    result.title,
    result.localizedDescriptions?.en?.title,
    result.localizedDescriptions?.de?.title,
    ...result.attributes
      .filter((attribute) => /(?:catalog|catalogue|article|part|product|model|registered)\s*(?:number|no\.?|code|id|identifier)?/i.test(`${attribute.group ?? ""} ${attribute.name}`))
      .map((attribute) => attribute.value)
  ];
  return surfaces.some((value) => Boolean(value && matchesRockwellCatalogStrict(value, catalogNumber)));
}

function isCatalogConfirmedRockwellUrl(url: string | undefined, catalogNumber: string): boolean {
  const cleaned = cleanText(url);
  if (!cleaned) return false;
  try {
    const parsed = new URL(cleaned);
    if (!/(^|\.)rockwellautomation\.com$/i.test(parsed.hostname)) return false;
    const full = decodeURIComponent(`${parsed.pathname}${parsed.search}`);
    if (/\/(?:search|site-search)(?:[/.?&]|$)|[?&](?:keyword|search|q)=/i.test(full)) return false;
    return matchesRockwellCatalogStrict(full, catalogNumber);
  } catch {
    return false;
  }
}

function dppPayloadMatchesCatalog(payload: Record<string, unknown>, catalogNumber: string): boolean {
  const values = dppValuesByLabel(payload.elements, /^(?:registered id|catalog number|catalogue number)$/i);
  if (!values.length) return true;
  return values.some((value) => matchesRockwellCatalogStrict(value, catalogNumber));
}

function dppValuesByLabel(value: unknown, labelPattern: RegExp): string[] {
  const values: string[] = [];
  const walk = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) walk(child);
      return;
    }
    if (!isRecord(item)) return;
    const label = dppElementLabel(item);
    const rawValue = cleanDppString(item.value);
    if (label && rawValue && labelPattern.test(label)) values.push(rawValue);
    walk(item.elements);
  };
  walk(value);
  return values;
}

function classifyRockwellDppDocument(label: string, url: string, contentType: string): DocumentRecord["type"] {
  if (/image/i.test(label) || /image\//i.test(contentType)) return "image";
  return classifyRockwellDocument(label, url);
}

interface RockwellFamilyPageRule {
  url: string;
  identity: RegExp;
}

function rockwellFamilyForCatalog(catalogNumber: string): RockwellFamilyPageRule | undefined {
  if (/^\s*2080-LC20-/i.test(catalogNumber)) {
    return {
      url: "https://www.rockwellautomation.com/en-us/products/hardware/allen-bradley/programmable-controllers/micro-controllers/micro800-family/micro820-controllers.html",
      identity: /\bMicro820\b/i
    };
  }
  return undefined;
}

/**
 * The "1606-TD002" technical-data publication covers every 1606-XLS/XLE/XLD/XLP/XLB switched-mode
 * power supply model AND their accessories (buffer/capacitor/battery/redundancy modules) in one
 * shared, multi-column-per-model document. Several accessory catalog numbers have no
 * details.html page of their own at all (confirmed live, e.g. 1606-XLSCAP24-12), so this is the
 * only route to their spec data. Only used as a last-resort fallback candidate — see call site.
 */
function rockwellFamilySeriesDatasheetCandidate(catalogNumber: string): DocumentRecord | undefined {
  if (!/^\s*1606-XL[SEDPB]/i.test(catalogNumber)) return undefined;
  return {
    type: "datasheet",
    label: "1606 Switched Mode Power Supply Specifications (technical data)",
    url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/1606-td002_-en-p.pdf",
    sourceType: "official-fallback",
    parser: "rockwell-family-datasheet",
    confidence: 0.6
  };
}

function rockwellFamilyPageForCatalog(catalogNumber: string): string | undefined {
  return rockwellFamilyForCatalog(catalogNumber)?.url;
}

function humanizeRockwellKey(value: string | undefined): string {
  return cleanText(
    value
      ?.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

function cleanDppString(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const cleaned = cleanText(String(value));
    return cleaned || undefined;
  }
  return undefined;
}

function toAbsoluteUrl(value: string, baseUrl: string): string | undefined {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function pathBaseName(url: string): string {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
  } catch {
    return url;
  }
}

function recordAt(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const next = value[key];
  return isRecord(next) ? next : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

