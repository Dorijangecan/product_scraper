import type {
  AttributeRecord,
  ManufacturerId,
  SourceRecord,
  TechnicalAttributeQuantity,
  TechnicalAttributeRecord
} from "../../shared/types.js";
import { cleanText } from "./normalizer.js";
import { findTechnicalAttributeAlias } from "./technical-attribute-aliases.js";
import { matchProperty, PROPERTY_ONTOLOGY, understand, type CanonicalProperty } from "./ontology.js";

export function normalizeTechnicalAttributes(
  manufacturerId: ManufacturerId,
  attributes: AttributeRecord[],
  sources: SourceRecord[] = []
): TechnicalAttributeRecord[] {
  return dedupeTechnicalAttributes(
    attributes.flatMap((attribute) => {
      const label = attributeLabel(attribute);
      const knownAlias = findTechnicalAttributeAlias(manufacturerId, attribute.name) ?? findTechnicalAttributeAlias(manufacturerId, label);
      const property = propertyForKnownAlias(knownAlias?.canonicalKey) ?? matchProperty(label);
      if (!property) return [];
      const understood = understand(label, attribute.value);
      const quantities = understood.quantities.map(toTechnicalQuantity);
      return [
        {
          manufacturerId,
          canonicalKey: property.key,
          canonicalLabel: property.label,
          unitKind: property.unitKind,
          originalGroup: attribute.group,
          originalName: attribute.name,
          originalValue: attribute.value,
          originalUnit: attribute.unit,
          quantities: quantities.length ? quantities : undefined,
          sourceUrl: attribute.sourceUrl,
          sourceType: attribute.sourceType ?? sourceTypeForUrl(sources, attribute.sourceUrl),
          parser: attribute.parser ?? parserForUrl(sources, attribute.sourceUrl),
          stage: attribute.stage ?? stageForUrl(sources, attribute.sourceUrl),
          confidence: technicalAttributeConfidence(attribute, property.unitKind, quantities.length, Boolean(knownAlias)),
          reason: technicalAttributeReason(attribute, property.key, property.unitKind, quantities.length, knownAlias?.evidenceLabel)
        }
      ];
    })
  ).sort(compareTechnicalAttributes);
}

function propertyForKnownAlias(canonicalKey: string | undefined): CanonicalProperty | undefined {
  if (!canonicalKey) return undefined;
  return PROPERTY_ONTOLOGY.find((property) => property.key === canonicalKey);
}

function attributeLabel(attribute: AttributeRecord): string {
  return cleanText(`${attribute.group ?? ""} ${attribute.name}`.trim());
}

function toTechnicalQuantity(quantity: ReturnType<typeof understand>["quantities"][number]): TechnicalAttributeQuantity {
  return {
    kind: quantity.kind,
    unit: quantity.unit,
    value: quantity.value,
    min: quantity.min,
    max: quantity.max,
    values: quantity.values,
    qualifier: quantity.qualifier,
    currentType: quantity.currentType,
    condition: quantity.condition,
    raw: quantity.raw
  };
}

function technicalAttributeConfidence(attribute: AttributeRecord, unitKind: string | undefined, quantityCount: number, knownAlias: boolean): number {
  let confidence = 0.82;
  if (knownAlias) confidence += 0.05;
  if (unitKind && quantityCount > 0) confidence += 0.08;
  if (!unitKind) confidence += 0.04;
  if (attribute.sourceType === "official") confidence += 0.06;
  else if (attribute.sourceType === "official-fallback") confidence += 0.04;
  else if (attribute.sourceType === "distributor") confidence -= 0.12;
  else if (attribute.sourceType === "generated") confidence -= 0.04;
  if (attribute.confidence !== undefined) confidence = (confidence + attribute.confidence) / 2;
  return Math.max(0.1, Math.min(0.99, Number(confidence.toFixed(2))));
}

function technicalAttributeReason(
  attribute: AttributeRecord,
  canonicalKey: string,
  unitKind: string | undefined,
  quantityCount: number,
  aliasEvidenceLabel: string | undefined
): string {
  const parts = aliasEvidenceLabel
    ? [`Known manufacturer alias from ${aliasEvidenceLabel} mapped to '${canonicalKey}'`]
    : [`Label matched ontology key '${canonicalKey}'`];
  if (unitKind) parts.push(quantityCount ? `value parsed as ${unitKind}` : `expected ${unitKind} value not parsed`);
  if (attribute.sourceType) parts.push(`source ${attribute.sourceType}`);
  return parts.join("; ");
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

function dedupeTechnicalAttributes(records: TechnicalAttributeRecord[]): TechnicalAttributeRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = [
      record.manufacturerId,
      record.canonicalKey,
      record.originalGroup ?? "",
      record.originalName,
      record.originalValue,
      record.sourceUrl ?? ""
    ].join("|").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(record.originalName && record.originalValue);
  });
}

function compareTechnicalAttributes(left: TechnicalAttributeRecord, right: TechnicalAttributeRecord): number {
  return (
    left.canonicalKey.localeCompare(right.canonicalKey) ||
    left.originalName.localeCompare(right.originalName) ||
    (left.sourceUrl ?? "").localeCompare(right.sourceUrl ?? "")
  );
}
