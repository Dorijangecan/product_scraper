import type { ProductResult, SourceRecord } from "../../shared/types.js";
import type { FetchedText } from "./http-client.js";
import { applyFieldCandidateResolution } from "./field-candidates.js";
import { minePage, type PageMiningResult } from "./page-mining.js";
import { shouldRunAdaptiveMining } from "./mission-control.js";
import { dedupeAttributes, dedupeDocuments, dedupeSources } from "./dedupe.js";
import { normalizeFields } from "./normalizer.js";
import type { ScrapeContext } from "./types.js";

export async function runAdaptivePageIntelligence(
  result: ProductResult,
  catalogNumber: string,
  context: ScrapeContext
): Promise<ProductResult> {
  const decision = shouldRunAdaptiveMining(result, context);
  const targetHealth = context.targetHealth?.get(context.manufacturer.id, "official-source");
  const initialAction: "mined" | "skipped" = decision.shouldMine ? "mined" : "skipped";
  let current: ProductResult = {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      ...(targetHealth ? { targetHealth } : {}),
      ...(decision.drift ? { drift: decision.drift } : {}),
      pageIntelligence: [
        ...(result.diagnostics?.pageIntelligence ?? []),
        {
          stage: "adaptive-page-intelligence",
          url: result.productUrl,
          action: initialAction,
          reason: decision.reason,
          scoreBefore: result.qualityGate?.score
        }
      ].slice(-40)
    }
  };
  if (!decision.shouldMine) return applyFieldCandidateResolution(current);

  const url = officialCandidateUrl(current, context);
  if (!url) {
    return applyFieldCandidateResolution({
      ...current,
      diagnostics: {
        ...current.diagnostics,
        pageIntelligence: [
          ...(current.diagnostics?.pageIntelligence ?? []),
          {
            stage: "adaptive-page-intelligence",
            action: "skipped" as const,
            reason: "No official product URL was available for static page mining."
          }
        ].slice(-40)
      }
    });
  }

  try {
    const learned = context.learnedExtractors?.list(context.manufacturer.id, hostFromUrl(url) ?? "", 8) ?? [];
    const fetched = await context.http.fetchText(url, {
      timeoutMs: context.manufacturer.fetchPolicy?.timeoutMs ?? 25000,
      cacheTtlMs: context.manufacturer.fetchPolicy?.cacheTtlMs,
      maxAttempts: context.manufacturer.fetchPolicy?.maxAttempts ?? 2,
      retryBackoffMs: context.manufacturer.fetchPolicy?.retryBackoffMs,
      signal: context.signal
    });
    current = mergeFetchedPageMining(current, fetched, catalogNumber, context, {
      stage: "adaptive-static-page-mining",
      method: "static-html",
      sourceType: "official-fallback"
    });
    if (learned.length) {
      current = {
        ...current,
        diagnostics: {
          ...current.diagnostics,
          pageIntelligence: [
            ...(current.diagnostics?.pageIntelligence ?? []),
            {
              stage: "learned-extractor-replay",
              url,
              action: "replayed" as const,
              reason: `Loaded ${learned.length} learned extractor pattern(s) for this host.`
            }
          ].slice(-40)
        }
      };
    }
  } catch (error) {
    current = {
      ...current,
      diagnostics: {
        ...current.diagnostics,
        pageIntelligence: [
          ...(current.diagnostics?.pageIntelligence ?? []),
          {
            stage: "adaptive-static-page-mining",
            url,
            action: "failed" as const,
            reason: error instanceof Error ? error.message : String(error)
          }
        ].slice(-40)
      }
    };
  }

  return applyFieldCandidateResolution(current);
}

export function mergeFetchedPageMining(
  result: ProductResult,
  fetched: FetchedText,
  catalogNumber: string,
  context: ScrapeContext,
  input: {
    stage: string;
    method: "static-html" | "rendered-dom" | "browser-network" | "learned-extractor";
    sourceType?: SourceRecord["sourceType"];
  }
): ProductResult {
  const mining = minePage(fetched, {
    manufacturerId: context.manufacturer.id,
    catalogNumber,
    stage: input.stage,
    method: input.method,
    sourceType: input.sourceType ?? "official-fallback"
  });
  const next = mergeMiningResult(result, fetched, mining, context, input.stage);
  learnFromMining(context, fetched.effectiveUrl, mining, input.stage);
  context.targetHealth?.record({
    manufacturerId: context.manufacturer.id,
    host: hostFromUrl(fetched.effectiveUrl),
    stage: input.stage,
    status: mining.attributes.length || mining.documents.length ? "partial" : "failed",
    attributeCount: mining.attributes.length,
    documentCount: mining.documents.length,
    elapsedMs: mining.record.elapsedMs
  });
  return applyFieldCandidateResolution(next);
}

export function mergeNetworkPageMining(
  result: ProductResult,
  networkTexts: FetchedText[],
  catalogNumber: string,
  context: ScrapeContext,
  limit = 12
): ProductResult {
  let current = result;
  const ranked = rankNetworkTexts(networkTexts, catalogNumber).slice(0, limit);
  for (const fetched of ranked) {
    current = mergeFetchedPageMining(current, fetched, catalogNumber, context, {
      stage: "adaptive-network-page-mining",
      method: "browser-network",
      sourceType: "official-fallback"
    });
  }
  if (!ranked.length) return current;
  return {
    ...current,
    diagnostics: {
      ...current.diagnostics,
      notes: uniqueStrings([
        ...(current.diagnostics?.notes ?? []),
        `Adaptive network mining parsed ${ranked.length} ranked browser payload(s).`
      ]).slice(0, 50)
    }
  };
}

function mergeMiningResult(
  result: ProductResult,
  fetched: FetchedText,
  mining: PageMiningResult,
  context: ScrapeContext,
  stage: string
): ProductResult {
  const attributes = dedupeAttributes([...result.attributes, ...mining.attributes]);
  const documents = dedupeDocuments([...result.documents, ...mining.documents]);
  const source: SourceRecord = {
    url: fetched.effectiveUrl,
    sourceType: "official-fallback",
    parser: "page-mining",
    parserVersion: "page-mining-v1",
    stage,
    reason: mining.record.reason,
    fetchedAt: fetched.fetchedAt,
    statusCode: fetched.statusCode
  };
  const sourceKey = `${source.parser}|${source.url}|${source.stage}`.toLowerCase();
  const sources = dedupeSources([
    ...result.sources,
    ...(mining.attributes.length || mining.documents.length || !result.sources.some((entry) => `${entry.parser}|${entry.url}|${entry.stage}`.toLowerCase() === sourceKey)
      ? [source]
      : [])
  ]);
  return {
    ...result,
    confidence: Math.max(result.confidence, mining.attributes.length || mining.documents.length ? 0.68 : 0),
    normalized: normalizeFields(attributes, documents),
    attributes,
    documents,
    sources,
    diagnostics: {
      ...result.diagnostics,
      pageMining: [
        ...(result.diagnostics?.pageMining ?? []),
        mining.record
      ].slice(-80),
      pageIntelligence: [
        ...(result.diagnostics?.pageIntelligence ?? []),
        {
          stage,
          url: fetched.effectiveUrl,
          action: "mined" as const,
          reason: mining.record.reason ?? "Page mining completed.",
          attributeCount: mining.attributes.length,
          documentCount: mining.documents.length
        }
      ].slice(-40),
      notes: uniqueStrings([
        ...(result.diagnostics?.notes ?? []),
        mining.attributes.length || mining.documents.length
          ? `Adaptive page mining added ${mining.attributes.length} attribute(s) and ${mining.documents.length} document(s).`
          : undefined
      ]).slice(0, 50)
    }
  };
}

function officialCandidateUrl(result: ProductResult, context: ScrapeContext): string | undefined {
  const candidates = [
    result.productUrl,
    result.localizedUrls?.en,
    ...result.sources
      .filter((source) => source.sourceType === "official" || source.sourceType === "official-fallback")
      .map((source) => source.url)
  ].filter((url): url is string => Boolean(url));
  return candidates.find((url) => isOfficialUrl(url, context) && !isAssetUrl(url));
}

function rankNetworkTexts(networkTexts: FetchedText[], catalogNumber: string): FetchedText[] {
  return networkTexts
    .map((fetched, index) => ({ fetched, index, score: networkScore(fetched, catalogNumber) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.fetched);
}

function networkScore(fetched: FetchedText, catalogNumber: string): number {
  const sample = fetched.text.slice(0, 120_000);
  const combined = `${fetched.effectiveUrl} ${fetched.contentType}`;
  let score = 0;
  if (/json|graphql|api|javascript/i.test(combined)) score += 30;
  if (new RegExp(escapeRegExp(catalogNumber), "i").test(`${combined} ${sample}`)) score += 120;
  if (/\b(?:product|sku|catalog|article|part|pim|details?|spec|technical|attribute|characteristic|document|download|asset|image)\b/i.test(`${combined} ${sample}`)) score += 70;
  if (/^\s*</.test(sample) && !/technical|spec|download|datasheet|product/i.test(sample)) score -= 40;
  if (fetched.statusCode >= 400) score -= 100;
  if (fetched.text.length > 750_000) score -= 40;
  return score;
}

function learnFromMining(context: ScrapeContext, url: string, mining: PageMiningResult, stage: string) {
  if (!context.learnedExtractors || (!mining.attributes.length && !mining.documents.length)) return;
  const host = hostFromUrl(url);
  if (!host) return;
  for (const signal of mining.record.signals ?? []) {
    context.learnedExtractors.upsert({
      manufacturerId: context.manufacturer.id,
      host,
      kind: learnedKind(signal),
      pattern: signal,
      sourceUrl: url,
      parserKind: stage
    });
  }
}

function learnedKind(signal: string): "dom-pattern" | "json-path" | "network-payload" | "interaction" | "document-pattern" {
  if (/json/i.test(signal)) return "json-path";
  if (/network/i.test(signal)) return "network-payload";
  if (/image|url|document/i.test(signal)) return "document-pattern";
  if (/tab|accordion|modal|hidden|drawer/i.test(signal)) return "interaction";
  return "dom-pattern";
}

function isOfficialUrl(url: string, context: ScrapeContext): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return context.manufacturer.officialBaseUrls.some((baseUrl) => {
      const baseHost = hostFromUrl(baseUrl);
      return Boolean(baseHost && (hostname === baseHost || hostname.endsWith(`.${baseHost}`) || (hostname === "r.jina.ai" && url.includes(baseHost))));
    });
  } catch {
    return false;
  }
}

function isAssetUrl(url: string): boolean {
  return /\.(?:pdf|zip|dwg|dxf|stp|step|png|jpe?g|webp|gif|svg)(?:[?#]|$)/i.test(url) ||
    /\/(?:download|downloads|documents?|cad|assets?)\//i.test(url);
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
