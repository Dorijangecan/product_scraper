import type { EvidenceRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { applyFieldCandidateResolution } from "./field-candidates.js";
import { buildFieldHealth, FIELD_REGISTRY, findFieldSourceAttribute, type RegistryFieldKey } from "./field-registry.js";
import { normalizeTechnicalAttributes } from "./technical-attributes.js";

export function attachEvidence(result: ProductResult): ProductResult {
  const resolvedResult = applyFieldCandidateResolution(result);
  const technicalAttributes = normalizeTechnicalAttributes(resolvedResult.manufacturerId, resolvedResult.attributes, resolvedResult.sources);
  const evidence = dedupeEvidence([
    ...(resolvedResult.evidence ?? []),
    ...resolvedResult.attributes.map((attr): EvidenceRecord => ({
      kind: "attribute",
      name: attr.name,
      value: attr.value,
      sourceUrl: attr.sourceUrl,
      sourceType: attr.sourceType ?? sourceTypeForUrl(resolvedResult.sources, attr.sourceUrl),
      parser: attr.parser ?? parserForUrl(resolvedResult.sources, attr.sourceUrl),
      stage: attr.stage ?? stageForUrl(resolvedResult.sources, attr.sourceUrl),
      confidence: attr.confidence
    })),
    ...resolvedResult.documents.map((doc): EvidenceRecord => ({
      kind: "document",
      name: `${doc.type}: ${doc.label}`,
      value: doc.localPath,
      url: doc.url,
      sourceUrl: doc.sourceUrl,
      sourceType: doc.sourceType ?? sourceTypeForUrl(resolvedResult.sources, doc.sourceUrl),
      parser: doc.parser ?? parserForUrl(resolvedResult.sources, doc.sourceUrl),
      stage: doc.stage ?? stageForUrl(resolvedResult.sources, doc.sourceUrl),
      confidence: doc.confidence,
      reason: [doc.downloadStatus === "failed" ? doc.downloadError : doc.downloadStatus, doc.parseStatus, doc.parseError]
        .filter(Boolean)
        .join("; ")
    })),
    ...Object.entries(resolvedResult.normalized).flatMap(([name, value]): EvidenceRecord[] => {
      if (!value) return [];
      const sourceAttribute = normalizedSourceAttribute(resolvedResult, name, value);
      const sourceUrl = sourceAttribute?.sourceUrl;
      return [
        {
          kind: "normalized",
          name,
          value,
          sourceUrl,
          sourceType: sourceAttribute?.sourceType ?? sourceTypeForUrl(resolvedResult.sources, sourceUrl),
          parser: sourceAttribute?.parser ?? parserForUrl(resolvedResult.sources, sourceUrl),
          stage: sourceAttribute?.stage ?? "normalize",
          confidence: sourceAttribute?.confidence ?? resolvedResult.confidence
        }
      ];
    }),
    ...technicalAttributes.map((attribute): EvidenceRecord => ({
      kind: "technical-attribute",
      name: attribute.canonicalKey,
      value: `${attribute.originalName}: ${attribute.originalValue}`,
      sourceUrl: attribute.sourceUrl,
      sourceType: attribute.sourceType,
      parser: attribute.parser,
      stage: attribute.stage ?? "technical-normalize",
      confidence: attribute.confidence,
      reason: attribute.reason
    })),
    ...resolvedResult.sources.map((source): EvidenceRecord => ({
      kind: "source",
      name: source.parser,
      url: source.url,
      sourceUrl: source.url,
      sourceType: source.sourceType,
      parser: source.parser,
      stage: source.stage,
      reason: source.reason,
      confidence: resolvedResult.confidence
    }))
  ]);

  return {
    ...resolvedResult,
    technicalAttributes,
    evidence,
    diagnostics: {
      ...resolvedResult.diagnostics,
      fieldHealth: buildFieldHealth(result)
    }
  };
}

function normalizedSourceAttribute(result: ProductResult, fieldName: string, normalizedValue: string): ProductResult["attributes"][number] | undefined {
  if (!isRegistryFieldKey(fieldName)) return undefined;
  return findFieldSourceAttribute(result.attributes, fieldName, normalizedValue);
}

function isRegistryFieldKey(fieldName: string): fieldName is RegistryFieldKey {
  return FIELD_REGISTRY.some((field) => field.key === fieldName);
}

function sourceTypeForUrl(sources: SourceRecord[], sourceUrl: string | undefined): SourceRecord["sourceType"] | undefined {
  return sourceForUrl(sources, sourceUrl)?.sourceType;
}

function parserForUrl(sources: SourceRecord[], sourceUrl: string | undefined): string | undefined {
  return sourceForUrl(sources, sourceUrl)?.parser;
}

function stageForUrl(sources: SourceRecord[], sourceUrl: string | undefined): string | undefined {
  return sourceForUrl(sources, sourceUrl)?.stage;
}

function sourceForUrl(sources: SourceRecord[], sourceUrl: string | undefined): SourceRecord | undefined {
  if (!sourceUrl) return undefined;
  return sources.find((source) => source.url === sourceUrl) ?? sources.find((source) => sameUrlOriginAndPath(source.url, sourceUrl));
}

function sameUrlOriginAndPath(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}

function dedupeEvidence(records: EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = [record.kind, record.name, record.value ?? "", record.url ?? "", record.sourceUrl ?? "", record.parser ?? "", record.stage ?? ""]
      .join("|")
      .toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(record.name || record.value || record.url);
  });
}
