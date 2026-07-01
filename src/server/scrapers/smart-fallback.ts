import { uniqueStrings } from "../text-util.js";
import type { ManufacturerConfig, ProductResult, ScrapeAttemptRecord, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import type { ScrapeContext } from "./types.js";
import { parseGenericProductPage } from "./generic.js";
import { mergeResults } from "./normalizer.js";
import { mergeFetchedPageMining } from "./page-intelligence.js";
import { applyQualityGate, evaluateQualityGate } from "./quality-gate.js";
import { renderProductPage } from "./browser-renderer.js";
import { learnEndpointFromNetworkFetch } from "./learned-endpoints.js";
import { catalogTextMatches, compactCatalogNumber } from "./catalog-number.js";

export async function runSmartFallbackPipeline(
  result: ProductResult,
  catalogNumber: string,
  context: ScrapeContext
): Promise<ProductResult> {
  const manufacturer = context.manufacturer;
  const recipe = manufacturer.scrapeRecipe;
  const attempts: ScrapeAttemptRecord[] = [];
  let current = applyQualityGate(result, manufacturer, evaluateQualityGate(result, manufacturer, catalogNumber, attempts));
  if (current.qualityGate?.passed) return current;

  const productUrl = officialProductUrl(current, manufacturer);
  if (!productUrl) return current;

  if (shouldUseReader(current, manufacturer)) {
    current = await tryReaderFallback(current, productUrl, catalogNumber, context, attempts);
    if (current.qualityGate?.passed) return current;
  }

  if (shouldUseBrowser(current, manufacturer)) {
    current = await tryBrowserFallback(current, productUrl, catalogNumber, context, attempts);
  }

  if (isDistributorOnly(current)) {
    const cap = recipe?.fallbackPolicy?.distributorConfidenceCap ?? recipe?.confidenceRules?.distributorMaxConfidence ?? 0.45;
    current = { ...current, confidence: Math.min(current.confidence, cap) };
  }

  return applyQualityGate(current, manufacturer, evaluateQualityGate(current, manufacturer, catalogNumber, attempts));
}

function shouldUseReader(result: ProductResult, manufacturer: ManufacturerConfig): boolean {
  // The reader fallback proxies the target URL through r.jina.ai (a third party). For a tool
  // that is otherwise fully local, this must be explicit opt-in — mirrors the PDT_AI_CLEANUP
  // pattern. Off unless PRODUCT_SCRAPER_ALLOW_EXTERNAL_READER is set.
  if (!externalReaderAllowed()) return false;
  const policy = manufacturer.scrapeRecipe?.fallbackPolicy;
  if (policy?.readerOnQualityFailure === false) return false;
  if (result.sources.some((source) => /reader|r\.jina/i.test(`${source.parser} ${source.url}`))) return false;
  return !result.qualityGate?.passed && !isDistributorOnly(result);
}

function externalReaderAllowed(): boolean {
  const flag = process.env.PRODUCT_SCRAPER_ALLOW_EXTERNAL_READER;
  return flag === "1" || /^(?:true|yes|on)$/i.test(flag ?? "");
}

function shouldUseBrowser(result: ProductResult, manufacturer: ManufacturerConfig): boolean {
  const policy = manufacturer.scrapeRecipe?.fallbackPolicy;
  if (policy?.browserOnQualityFailure === false) return false;
  if (policy?.maxBrowserAttempts === 0) return false;
  if (result.sources.some((source) => /browser/i.test(source.parser))) return false;
  return !result.qualityGate?.passed && !isDistributorOnly(result);
}

async function tryReaderFallback(
  current: ProductResult,
  productUrl: string,
  catalogNumber: string,
  context: ScrapeContext,
  attempts: ScrapeAttemptRecord[]
): Promise<ProductResult> {
  const readerUrl = toReaderUrl(productUrl);
  try {
    const fetched = await context.http.fetchText(readerUrl, {
      timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 30000,
      cacheTtlMs: context.manufacturer.fetchPolicy?.cacheTtlMs,
      headers: { accept: "text/plain,text/markdown,text/html;q=0.8,*/*;q=0.5" },
      signal: context.signal
    });
    const parsed = parseGenericProductPage(context.manufacturer.id, catalogNumber, fetched, "official-fallback", "reader-fallback", {
      match: context.manufacturer.match,
      localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
      confidence: Math.min(current.confidence + 0.04, 0.82),
      markerRules: context.manufacturer.markerRules,
      extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy
    });
    attempts.push(attemptFromFetched("reader", fetched, parsed));
    const mined = mergeFetchedPageMining(parsed, fetched, catalogNumber, context, {
      stage: "adaptive-reader-page-mining",
      method: "static-html",
      sourceType: "official-fallback"
    });
    const merged = mergeResults(current, mined);
    return withFallbackStage(
      applyQualityGate(merged, context.manufacturer, evaluateQualityGate(merged, context.manufacturer, catalogNumber, attempts)),
      "reader"
    );
  } catch (error) {
    attempts.push({
      stage: "reader",
      url: readerUrl,
      status: "failed",
      reason: error instanceof Error ? error.message : "Reader fallback failed",
      error: error instanceof Error ? error.message : String(error)
    });
    return withFallbackStage(current, "reader-failed");
  }
}

async function tryBrowserFallback(
  current: ProductResult,
  productUrl: string,
  catalogNumber: string,
  context: ScrapeContext,
  attempts: ScrapeAttemptRecord[]
): Promise<ProductResult> {
  const rendered = context.browserRenderer
    ? await context.browserRenderer.renderProductPage(productUrl, context.manufacturer.scrapeRecipe, context.signal)
    : await renderProductPage(productUrl, context.manufacturer.scrapeRecipe, context.signal);
  let merged = current;
  if (rendered.fetched) {
    const parsed = parseGenericProductPage(context.manufacturer.id, catalogNumber, rendered.fetched, "official-fallback", "browser-render", {
      match: context.manufacturer.match,
      localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
      confidence: Math.min(current.confidence + 0.08, 0.86),
      markerRules: context.manufacturer.markerRules,
      extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy
    });
    attempts.push(attemptFromFetched("browser-render", rendered.fetched, parsed));
    const mined = mergeFetchedPageMining(parsed, rendered.fetched, catalogNumber, context, {
      stage: "adaptive-rendered-page-mining",
      method: "rendered-dom",
      sourceType: "official-fallback"
    });
    merged = mergeResults(merged, mined);
  }

  const rankedNetworkTexts = rankBrowserNetworkTexts(rendered.networkTexts, rendered.networkDiagnostics, catalogNumber);
  for (const fetched of rankedNetworkTexts) {
    const networkRecord = rendered.networkDiagnostics.find((entry) => entry.url === fetched.effectiveUrl);
    const parsed = parseGenericProductPage(context.manufacturer.id, catalogNumber, fetched, "official-fallback", "browser-network", {
      match: context.manufacturer.match,
      localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
      confidence: Math.min(current.confidence + 0.06, 0.84),
      markerRules: context.manufacturer.markerRules,
      extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy
    });
    if (parsed.status === "failed") continue;
    attempts.push(attemptFromFetched("browser-network", fetched, parsed));
    const beforeGate = evaluateQualityGate(merged, context.manufacturer, catalogNumber, attempts);
    const mined = mergeFetchedPageMining(parsed, fetched, catalogNumber, context, {
      stage: "adaptive-network-page-mining",
      method: "browser-network",
      sourceType: "official-fallback"
    });
    merged = mergeResults(merged, mined);
    const afterGate = evaluateQualityGate(merged, context.manufacturer, catalogNumber, attempts);
    if (networkRecord?.category === "product-api" && qualityImproved(beforeGate, afterGate)) {
      const learned = learnEndpointFromNetworkFetch({
        manufacturer: context.manufacturer,
        catalogNumber,
        fetched,
        discoveredFromUrl: productUrl,
        parserKind: "browser-network",
        store: context.learnedEndpoints
      });
      if (learned) {
        merged = {
          ...merged,
          diagnostics: {
            ...merged.diagnostics,
            notes: uniqueStrings([...(merged.diagnostics?.notes ?? []), `Learned API endpoint from ${fetched.effectiveUrl}`]).slice(0, 50)
          }
        };
      }
    }
  }

  if (rendered.error) {
    attempts.push({
      stage: "browser-render",
      url: productUrl,
      status: "failed",
      reason: rendered.error,
      error: rendered.error
    });
  }

  return withFallbackStage(
    applyQualityGate(
      {
        ...merged,
        diagnostics: {
          ...merged.diagnostics,
          browserNetwork: [
            ...(merged.diagnostics?.browserNetwork ?? []),
            ...rendered.networkDiagnostics
          ].slice(-80),
          suggestedApiEndpoints: uniqueStrings([
            ...(merged.diagnostics?.suggestedApiEndpoints ?? []),
            ...rendered.networkDiagnostics
              .filter((entry) => entry.category === "product-api")
              .map((entry) => entry.url)
          ]).slice(0, 20),
          notes: uniqueStrings([
            ...(merged.diagnostics?.notes ?? []),
            rankedNetworkTexts.length < rendered.networkTexts.length
              ? `Ranked ${rendered.networkTexts.length} browser network payloads and parsed top ${rankedNetworkTexts.length}.`
              : undefined
          ].filter((value): value is string => Boolean(value))).slice(0, 50)
        }
      },
      context.manufacturer,
      evaluateQualityGate(merged, context.manufacturer, catalogNumber, attempts)
    ),
    rendered.error ? "browser-failed" : "browser"
  );
}

function rankBrowserNetworkTexts(
  networkTexts: FetchedText[],
  diagnostics: Array<{ url: string; category?: string; contentType?: string; statusCode?: number }>,
  catalogNumber: string
): FetchedText[] {
  const chronologicalKeep = networkTexts.slice(0, 4);
  const ranked = networkTexts
    .map((fetched, index) => ({
      fetched,
      index,
      score: browserNetworkPayloadScore(
        fetched,
        diagnostics.find((entry) => entry.url === fetched.effectiveUrl),
        catalogNumber
      )
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.fetched);
  return uniqueFetchedTexts([...ranked.slice(0, 24), ...chronologicalKeep]).slice(0, 24);
}

function browserNetworkPayloadScore(
  fetched: FetchedText,
  diagnostic: { category?: string; contentType?: string; statusCode?: number } | undefined,
  catalogNumber: string
): number {
  const url = fetched.effectiveUrl || fetched.requestedUrl;
  const contentType = `${diagnostic?.contentType ?? ""} ${fetched.contentType ?? ""}`;
  const category = diagnostic?.category ?? "";
  const textSample = fetched.text.slice(0, 80_000);
  const combined = `${url} ${contentType}`;
  let score = 0;

  if (category === "product-api") score += 90;
  else if (category === "document-api") score += 60;
  else if (category === "search-api") score += 45;
  else if (category === "html" || category === "text") score += 12;

  if (/json|graphql|api|javascript/i.test(combined)) score += 24;
  if (/\b(?:product|sku|catalog|article|part|pim|detail|details|spec|technical|attribute|document|download|resource)\b/i.test(url)) score += 22;
  if (catalogTextMatches(url, catalogNumber, { compact: true, ignoreCase: true, afterColon: true })) score += 80;
  if (catalogTextMatches(textSample, catalogNumber, { compact: true, ignoreCase: true, afterColon: true })) score += 110;
  else {
    const compact = compactCatalogNumber(catalogNumber).toLowerCase();
    if (compact && compactCatalogNumber(textSample).toLowerCase().includes(compact)) score += 60;
  }

  if (/"(?:sku|mpn|catalogNumber|catalogNo|partNumber|productId|articleNumber)"\s*:/i.test(textSample)) score += 28;
  if (/"(?:specifications?|technicalData|attributes?|properties|characteristics?|parameters?)"\s*:/i.test(textSample)) score += 35;
  if (/"(?:documents?|downloads?|resources?|datasheetUrl|manualUrl|pdfUrl|assetUrl)"\s*:/i.test(textSample)) score += 24;
  if (/\b(?:rated voltage|supply voltage|rated current|material|weight|degree of protection|ip rating|datasheet|manual)\b/i.test(textSample)) score += 20;
  if (/^\s*</.test(textSample) && !/\b(?:product|catalog|sku|technical|spec|download|datasheet)\b/i.test(textSample)) score -= 30;
  if (diagnostic?.statusCode && diagnostic.statusCode >= 400) score -= 80;
  if (fetched.text.length > 500_000) score -= 20;

  return score;
}

function uniqueFetchedTexts(values: FetchedText[]): FetchedText[] {
  const seen = new Set<string>();
  const unique: FetchedText[] = [];
  for (const fetched of values) {
    const key = `${fetched.effectiveUrl || fetched.requestedUrl}|${fetched.contentType ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(fetched);
  }
  return unique;
}

function qualityImproved(
  before: ReturnType<typeof evaluateQualityGate>,
  after: ReturnType<typeof evaluateQualityGate>
): boolean {
  return after.identityConfirmed && (after.passed || after.score > before.score || after.missing.length < before.missing.length);
}

function officialProductUrl(result: ProductResult, manufacturer: ManufacturerConfig): string | undefined {
  const candidates = [
    result.productUrl,
    ...result.sources
      .filter((source) => source.sourceType === "official" || source.sourceType === "official-fallback")
      .map((source) => source.url)
  ].filter((url): url is string => Boolean(url));
  return candidates.find((url) => isOfficialUrl(url, manufacturer) && !isAbbPartcommunityCadUrl(url, manufacturer));
}

function isOfficialUrl(url: string, manufacturer: ManufacturerConfig): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return manufacturer.officialBaseUrls.some((baseUrl) => {
      try {
        const baseHostname = new URL(baseUrl).hostname.replace(/^www\./, "");
        return hostname === baseHostname || hostname.endsWith(`.${baseHostname}`);
      } catch {
        return false;
      }
    }) || (hostname === "r.jina.ai" && manufacturer.officialBaseUrls.some((baseUrl) => url.includes(new URL(baseUrl).hostname.replace(/^www\./, ""))));
  } catch {
    return false;
  }
}

function isAbbPartcommunityCadUrl(url: string, manufacturer: ManufacturerConfig): boolean {
  if (manufacturer.id !== "abb") return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase() === "abb-control-products.partcommunity.com";
  } catch {
    return false;
  }
}

function toReaderUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return `https://r.jina.ai/http://${parsed.host}${parsed.pathname}${parsed.search}`;
}

function attemptFromFetched(stage: string, fetched: FetchedText, result: ProductResult): ScrapeAttemptRecord {
  return {
    stage,
    url: fetched.effectiveUrl,
    status: result.status === "failed" ? "failed" : "partial",
    reason: result.error,
    parser: result.sources[0]?.parser,
    sourceType: result.sources[0]?.sourceType,
    statusCode: fetched.statusCode,
    attributeCount: result.attributes.length,
    documentCount: result.documents.length
  };
}

function withFallbackStage(result: ProductResult, stage: string): ProductResult {
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      fallbackStages: uniqueStrings([...(result.diagnostics?.fallbackStages ?? []), stage])
    }
  };
}

function isDistributorOnly(result: ProductResult): boolean {
  return result.sources.length > 0 && result.sources.every((source: SourceRecord) => source.sourceType === "distributor");
}

