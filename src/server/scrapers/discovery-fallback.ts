import type { AttributeRecord, DocumentRecord, FallbackSourceConfig, ProductResult, ScrapeDiagnostics } from "../../shared/types.js";
import { dedupeDocuments } from "./dedupe.js";
import { discoverOfficialProductCandidates, type ProductDiscoveryResult } from "./discovery.js";
import { canonicalizeProductLocaleUrls } from "./localized-urls.js";
import { normalizeFields } from "./normalizer.js";
import type { ScrapeContext } from "./types.js";

export async function scrapeDiscoveredFallback(
  catalogNumber: string,
  context: ScrapeContext,
  options: { idPrefix?: string } = {}
): Promise<{ result?: ProductResult; discovery: ProductDiscoveryResult }> {
  const discovery = await discoverOfficialProductCandidates(catalogNumber, context);
  const discoveredSources = discoveryFallbackSources(discovery, context, options.idPrefix ?? context.manufacturer.id);
  const scraped = await context.fallback.scrape(catalogNumber, [
    ...discoveredSources,
    ...context.manufacturer.fallbackSources
  ]);
  const resolved = scraped && scraped.status !== "failed"
    ? scraped
    : discoveryDocumentFallbackResult(catalogNumber, context, discovery.documentCandidates, scraped);
  const result = resolved ? canonicalizeProductLocaleUrls(resolved) : resolved;
  return { result, discovery };
}

export function discoveryFallbackSources(
  discovery: ProductDiscoveryResult,
  context: ScrapeContext,
  idPrefix = context.manufacturer.id
): FallbackSourceConfig[] {
  return discovery.candidates.map((candidate, index) => ({
    id: `${idPrefix}-discovered-${index + 1}`,
    label: `${context.manufacturer.shortName} ${candidate.reason}`,
    enabled: true,
    sourceType: candidate.sourceType === "distributor" ? "distributor" : "official-fallback",
    directUrlTemplates: [candidate.url],
    confidence: Math.min(0.86, Math.max(0.48, candidate.score / 100))
  }));
}

export function withDiscoveryFallbackDiagnostics(
  result: ProductResult,
  discovery: ProductDiscoveryResult,
  limits: { candidates?: number; rejectedLinks?: number; notes?: number } = {}
): ProductResult {
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      attemptedUrls: uniqueStrings([...(result.diagnostics?.attemptedUrls ?? []), ...(discovery.diagnostics.attemptedUrls ?? [])]),
      discoveredCandidates: [
        ...(result.diagnostics?.discoveredCandidates ?? []),
        ...(discovery.diagnostics.discoveredCandidates ?? [])
      ].slice(0, limits.candidates ?? 40),
      rejectedLinks: [
        ...(result.diagnostics?.rejectedLinks ?? []),
        ...(discovery.diagnostics.rejectedLinks ?? [])
      ].slice(0, limits.rejectedLinks ?? 40),
      notes: uniqueStrings([...(result.diagnostics?.notes ?? []), ...(discovery.diagnostics.notes ?? [])]).slice(0, limits.notes ?? 60)
    } satisfies ScrapeDiagnostics
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function discoveryDocumentFallbackResult(
  catalogNumber: string,
  context: ScrapeContext,
  documents: DocumentRecord[],
  previous?: ProductResult
): ProductResult | undefined {
  const cleanDocuments = dedupeDocuments(documents).slice(0, 8);
  if (!cleanDocuments.length) return previous;
  const sourceUrl = cleanDocuments[0].sourceUrl ?? cleanDocuments[0].url;
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
    normalized: normalizeFields(attributes, cleanDocuments),
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
      ...previous?.diagnostics,
      fallbackStages: uniqueStrings([...(previous?.diagnostics?.fallbackStages ?? []), "official-document-discovery"]),
      notes: uniqueStrings([
        ...(previous?.diagnostics?.notes ?? []),
        `Official discovery found ${cleanDocuments.length} source document candidate(s) after product-page fallback failed.`
      ])
    }
  };
}
