import type { EvidenceRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { normalizeTechnicalAttributes } from "./technical-attributes.js";

export function attachEvidence(result: ProductResult): ProductResult {
  const technicalAttributes = normalizeTechnicalAttributes(result.manufacturerId, result.attributes, result.sources);
  const evidence = dedupeEvidence([
    ...(result.evidence ?? []),
    ...result.attributes.map((attr): EvidenceRecord => ({
      kind: "attribute",
      name: attr.name,
      value: attr.value,
      sourceUrl: attr.sourceUrl,
      sourceType: attr.sourceType ?? sourceTypeForUrl(result.sources, attr.sourceUrl),
      parser: attr.parser ?? parserForUrl(result.sources, attr.sourceUrl),
      stage: attr.stage ?? stageForUrl(result.sources, attr.sourceUrl),
      confidence: attr.confidence
    })),
    ...result.documents.map((doc): EvidenceRecord => ({
      kind: "document",
      name: `${doc.type}: ${doc.label}`,
      value: doc.localPath,
      url: doc.url,
      sourceUrl: doc.sourceUrl,
      sourceType: doc.sourceType ?? sourceTypeForUrl(result.sources, doc.sourceUrl),
      parser: doc.parser ?? parserForUrl(result.sources, doc.sourceUrl),
      stage: doc.stage ?? stageForUrl(result.sources, doc.sourceUrl),
      confidence: doc.confidence,
      reason: [doc.downloadStatus === "failed" ? doc.downloadError : doc.downloadStatus, doc.parseStatus, doc.parseError]
        .filter(Boolean)
        .join("; ")
    })),
    ...Object.entries(result.normalized).flatMap(([name, value]): EvidenceRecord[] =>
      value
        ? [
            {
              kind: "normalized",
              name,
              value,
              sourceUrl: normalizedSourceUrl(result, name, value),
              sourceType: sourceTypeForUrl(result.sources, normalizedSourceUrl(result, name, value)),
              parser: parserForUrl(result.sources, normalizedSourceUrl(result, name, value)),
              stage: "normalize",
              confidence: result.confidence
            }
          ]
        : []
    ),
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
    ...result.sources.map((source): EvidenceRecord => ({
      kind: "source",
      name: source.parser,
      url: source.url,
      sourceUrl: source.url,
      sourceType: source.sourceType,
      parser: source.parser,
      stage: source.stage,
      reason: source.reason,
      confidence: result.confidence
    }))
  ]);

  return { ...result, technicalAttributes, evidence };
}

function normalizedSourceUrl(result: ProductResult, fieldName: string, normalizedValue: string): string | undefined {
  return (
    result.attributes.find((attr) => attr.value === normalizedValue || normalizedValue.includes(attr.value) || attr.value.includes(normalizedValue)) ??
    result.attributes.find((attr) => labelLooksLikeField(attr.name, fieldName))
  )?.sourceUrl;
}

function labelLooksLikeField(label: string, fieldName: string): boolean {
  const text = label.toLowerCase();
  if (fieldName === "weight") return /weight|mass|gewicht|peso/.test(text);
  if (fieldName === "dimensions") return /dimension|height|width|depth|length|abmess/.test(text);
  if (fieldName === "material") return /material|werkstoff/.test(text);
  if (fieldName === "voltage") return /voltage|spannung|napon/.test(text);
  if (fieldName === "current") return /current|strom|amperage|struja/.test(text);
  if (fieldName === "protection") return /ip|nema|protection|schutzart/.test(text);
  if (fieldName === "certificates") return /cert|approval|conformity|standard/.test(text);
  return false;
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
