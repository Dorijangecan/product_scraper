import type { AttributeRecord, DocumentRecord, ProductResult, ScrapeAttemptRecord } from "../../shared/types.js";
import { dedupeDocuments } from "./dedupe.js";
import { discoverOfficialProductCandidates } from "./discovery.js";
import { isUnresolvedSearchResultPage, parseGenericProductPage } from "./generic.js";
import type { FetchedText } from "./http-client.js";
import { mergeResults } from "./normalizer.js";
import { applyQualityGate, evaluateQualityGate } from "./quality-gate.js";
import { runSmartFallbackPipeline } from "./smart-fallback.js";
import type { ScrapeContext } from "./types.js";

export async function runDeterministicScrapePipeline(
  result: ProductResult,
  catalogNumber: string,
  context: ScrapeContext
): Promise<ProductResult> {
  const attempts: ScrapeAttemptRecord[] = [...(result.qualityGate?.attempts ?? [])];
  const initial = repairProductUrlFromSources(result);
  let current = applyQualityGate(
    initial,
    context.manufacturer,
    evaluateQualityGate(initial, context.manufacturer, catalogNumber, attempts)
  );
  if (current.qualityGate?.passed && !needsOfficialProductLinkRepair(current)) return promoteQualityPassedOfficialResult(current);

  const discovery = await discoverOfficialProductCandidates(catalogNumber, context);
  current = withDiscoveryDiagnostics(current, discovery);

  for (const candidate of discovery.candidates) {
    if (current.qualityGate?.passed && !needsOfficialProductLinkRepair(current)) break;
    if (alreadyTried(current, candidate.url)) continue;
    try {
      const fetched = await fetchOfficialCandidate(candidate.url, context);
      const parsed = parseGenericProductPage(context.manufacturer.id, catalogNumber, fetched, candidate.sourceType, `discovery-${candidate.stage}`, {
        match: context.manufacturer.match,
        localizedUrlTemplates: context.manufacturer.localizedUrlTemplates,
        confidence: Math.min(0.88, Math.max(0.55, candidate.score / 100)),
        markerRules: context.manufacturer.markerRules,
        extractionPolicy: context.manufacturer.scrapeRecipe?.extractionPolicy
      });
      const staged = stampResult(parsed, candidate.stage, candidate.reason);
      if (isUnresolvedSearchResultPage(fetched.effectiveUrl, staged.title, false)) {
        attempts.push({
          stage: candidate.stage,
          url: fetched.effectiveUrl,
          status: "failed",
          score: candidate.score,
          reason: "Search results page did not resolve to a catalog-confirmed product page.",
          sourceType: candidate.sourceType,
          parser: `discovery-${candidate.stage}`,
          statusCode: fetched.statusCode,
          attributeCount: 0,
          documentCount: 0
        });
        continue;
      }
      attempts.push(attemptFromFetched(candidate.stage, fetched, staged, candidate.reason, candidate.score));
      const merged = preferDiscoveredProductUrl(mergeResults(current, staged), current, staged);
      current = applyQualityGate(
        merged,
        context.manufacturer,
        evaluateQualityGate(merged, context.manufacturer, catalogNumber, attempts)
      );
    } catch (error) {
      attempts.push({
        stage: candidate.stage,
        url: candidate.url,
        status: "failed",
        score: candidate.score,
        reason: candidate.reason,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (!current.qualityGate?.passed && discovery.documentCandidates.length) {
    const documentResult = discoveryDocumentResult(catalogNumber, context, discovery.documentCandidates);
    const merged = mergeResults(current, documentResult);
    current = applyQualityGate(
      merged,
      context.manufacturer,
      evaluateQualityGate(merged, context.manufacturer, catalogNumber, attempts)
    );
  }

  if (!current.qualityGate?.passed) {
    current = await runSmartFallbackPipeline(
      applyQualityGate(current, context.manufacturer, evaluateQualityGate(current, context.manufacturer, catalogNumber, attempts)),
      catalogNumber,
      context
    );
  }

  return promoteQualityPassedOfficialResult(
    applyQualityGate(current, context.manufacturer, evaluateQualityGate(current, context.manufacturer, catalogNumber, attempts))
  );
}

function discoveryDocumentResult(catalogNumber: string, context: ScrapeContext, documents: DocumentRecord[]): ProductResult {
  const cleanDocuments = dedupeDocuments(documents).slice(0, 8);
  const sourceUrl = cleanDocuments[0]?.sourceUrl ?? cleanDocuments[0]?.url ?? `generated:official-document-discovery:${catalogNumber}`;
  const attributes: AttributeRecord[] = [
    {
      group: "Official Document Discovery",
      name: "Catalog Number",
      value: catalogNumber,
      sourceUrl,
      sourceType: "official-fallback",
      parser: "official-discovery",
      stage: "document-discovery",
      confidence: 0.68
    }
  ];
  return {
    manufacturerId: context.manufacturer.id,
    catalogNumber,
    status: "partial",
    confidence: 0.58,
    productUrl: sourceUrl,
    title: `${catalogNumber} - ${context.manufacturer.canonicalName} source documents`,
    description: `${context.manufacturer.canonicalName} discovery found source documents for ${catalogNumber}.`,
    normalized: {},
    attributes,
    documents: cleanDocuments,
    sources: [
      {
        url: sourceUrl,
        sourceType: "official-fallback",
        parser: "official-discovery",
        parserVersion: "document-discovery-v1",
        stage: "document-discovery",
        fetchedAt: new Date().toISOString()
      }
    ],
    diagnostics: {
      fallbackStages: ["official-document-discovery"],
      notes: [`Official discovery found ${cleanDocuments.length} source document candidate(s).`]
    }
  };
}

function promoteQualityPassedOfficialResult(result: ProductResult): ProductResult {
  if (!result.qualityGate?.passed || result.status !== "partial") return result;
  if (result.sources.length > 0 && result.sources.every((source) => source.sourceType === "distributor")) return result;
  return { ...result, status: "found" };
}

function repairProductUrlFromSources(result: ProductResult): ProductResult {
  if (!isSuspiciousProductUrl(result.productUrl)) return result;
  const sourceUrl = [result.localizedUrls?.en, ...result.sources.map((source) => source.url)].find((url) => !isSuspiciousProductUrl(url));
  if (!sourceUrl) return result;
  return {
    ...result,
    productUrl: sourceUrl
  };
}

function preferDiscoveredProductUrl(merged: ProductResult, current: ProductResult, discovered: ProductResult): ProductResult {
  if (!needsOfficialProductLinkRepair(current) || isSuspiciousProductUrl(discovered.productUrl)) return merged;
  return {
    ...merged,
    productUrl: discovered.productUrl,
    diagnostics: {
      ...merged.diagnostics,
      notes: uniqueStrings([...(merged.diagnostics?.notes ?? []), "Repaired product URL from official discovery."])
    }
  };
}

function needsOfficialProductLinkRepair(result: ProductResult): boolean {
  return isSuspiciousProductUrl(result.productUrl);
}

function isSuspiciousProductUrl(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const full = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase();
    if (/\/(?:site-)?search(?:\/|$)|[?&](?:s|q|query|search|term|text|keyword|searchterm)=/i.test(full)) return true;
    if (/partcommunity|3d-cad-models|\/cad(?:\/|$)|\/download(?:\/|$)|\/documents?(?:\/|$)/i.test(full)) return true;
    if (/\.(?:pdf|zip|dwg|dxf|stp|step|png|jpe?g|webp)(?:[?#]|$)/i.test(full)) return true;
    return false;
  } catch {
    return /\b(?:search|query|keyword)=|\/(?:site-)?search\/|partcommunity|3d-cad-models|\.(?:pdf|zip|dwg|dxf|stp|step|png|jpe?g|webp)\b/i.test(url);
  }
}

async function fetchOfficialCandidate(url: string, context: ScrapeContext): Promise<FetchedText> {
  const policy = context.manufacturer.fetchPolicy ?? {};
  return context.http.fetchText(url, {
    timeoutMs: policy.timeoutMs ?? 20000,
    cacheTtlMs: policy.cacheTtlMs,
    maxAttempts: policy.maxAttempts ?? 2,
    retryBackoffMs: policy.retryBackoffMs,
    headers: {
      ...(policy.userAgent ? { "user-agent": policy.userAgent } : {}),
      ...(policy.acceptLanguage ? { "accept-language": policy.acceptLanguage } : {}),
      ...(policy.referer ? { referer: policy.referer } : {})
    },
    signal: context.signal
  });
}

function stampResult(result: ProductResult, stage: string, reason: string): ProductResult {
  return {
    ...result,
    attributes: result.attributes.map((attr) => ({
      ...attr,
      sourceType: attr.sourceType ?? result.sources[0]?.sourceType,
      parser: attr.parser ?? result.sources[0]?.parser,
      stage: attr.stage ?? stage
    })),
    documents: result.documents.map((doc) => ({
      ...doc,
      sourceType: doc.sourceType ?? result.sources[0]?.sourceType,
      parser: doc.parser ?? result.sources[0]?.parser,
      stage: doc.stage ?? stage
    })),
    sources: result.sources.map((source) => ({ ...source, stage, reason })),
    diagnostics: {
      ...result.diagnostics,
      fallbackStages: [...(result.diagnostics?.fallbackStages ?? []), stage]
    }
  };
}

function withDiscoveryDiagnostics(
  result: ProductResult,
  discovery: Awaited<ReturnType<typeof discoverOfficialProductCandidates>>
): ProductResult {
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      fallbackStages: uniqueStrings([...(result.diagnostics?.fallbackStages ?? []), "discovery"]),
      attemptedUrls: uniqueStrings([...(result.diagnostics?.attemptedUrls ?? []), ...(discovery.diagnostics.attemptedUrls ?? [])]),
      discoveredCandidates: [
        ...(result.diagnostics?.discoveredCandidates ?? []),
        ...(discovery.diagnostics.discoveredCandidates ?? [])
      ].slice(0, 40),
      rejectedLinks: [
        ...(result.diagnostics?.rejectedLinks ?? []),
        ...(discovery.diagnostics.rejectedLinks ?? [])
      ].slice(0, 50),
      notes: uniqueStrings([...(result.diagnostics?.notes ?? []), ...(discovery.diagnostics.notes ?? [])]).slice(0, 50)
    }
  };
}

function alreadyTried(result: ProductResult, url: string): boolean {
  return result.sources.some((source) => canonicalUrl(source.url) === canonicalUrl(url));
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function attemptFromFetched(
  stage: string,
  fetched: FetchedText,
  result: ProductResult,
  reason: string,
  score: number
): ScrapeAttemptRecord {
  return {
    stage,
    url: fetched.effectiveUrl,
    status: result.status === "failed" ? "failed" : "partial",
    score,
    missing: result.qualityGate?.missing,
    reason: result.error ?? reason,
    sourceType: result.sources[0]?.sourceType,
    parser: result.sources[0]?.parser,
    statusCode: fetched.statusCode,
    attributeCount: result.attributes.length,
    documentCount: result.documents.length
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
