import { sameUrlOriginAndPath } from "../url-util.js";
import type {
  AttributeRecord,
  ManufacturerId,
  SourceRecord,
  TechnicalAttributeQuantity,
  TechnicalAttributeRecord
} from "../../shared/types.js";
import { cleanText } from "./normalizer.js";
import { matchTechnicalAttributeAlias, type TechnicalAttributeAliasMatch } from "./technical-attribute-aliases.js";
import { matchProperty, PROPERTY_ONTOLOGY, type CanonicalProperty } from "./ontology.js";
import { parseQuantities, type ParsedQuantity, type QuantityKind } from "./quantity.js";

export function normalizeTechnicalAttributes(
  manufacturerId: ManufacturerId,
  attributes: AttributeRecord[],
  sources: SourceRecord[] = []
): TechnicalAttributeRecord[] {
  return dedupeTechnicalAttributes(
    attributes.flatMap((attribute) => {
      const label = attributeLabel(attribute);
      const exactAlias =
        matchTechnicalAttributeAlias(manufacturerId, attribute.name, { includeFuzzy: false }) ??
        matchTechnicalAttributeAlias(manufacturerId, label, { includeFuzzy: false });
      const ontologyProperty = matchProperty(label);
      const fuzzyAlias = exactAlias
        ? undefined
        : matchTechnicalAttributeAlias(manufacturerId, attribute.name) ?? matchTechnicalAttributeAlias(manufacturerId, label);
      const aliasMatch = exactAlias ?? (shouldPreferFuzzyAlias(fuzzyAlias, ontologyProperty) ? fuzzyAlias : undefined);
      const property = propertyForKnownAlias(aliasMatch?.alias.canonicalKey) ?? ontologyProperty;
      if (!property) return [];
      const matchType = technicalAttributeMatchType(aliasMatch, ontologyProperty);
      const quantityText = quantityTextWithUnitHint(attribute, property.unitKind);
      const quantities = parseQuantities(quantityText, property.unitKind ? { kind: property.unitKind } : {}).map(toTechnicalQuantity);
      return [
        {
          manufacturerId,
          canonicalKey: property.key,
          canonicalLabel: property.label,
          unitKind: property.unitKind,
          matchType,
          matchedAlias: aliasMatch?.alias.originalName,
          matchedAliasManufacturerId: aliasMatch?.alias.manufacturerId,
          matchScore: aliasMatch?.score,
          originalGroup: attribute.group,
          originalName: attribute.name,
          originalValue: attribute.value,
          originalUnit: attribute.unit,
          quantities: quantities.length ? quantities : undefined,
          sourceUrl: attribute.sourceUrl,
          sourceType: attribute.sourceType ?? sourceTypeForUrl(sources, attribute.sourceUrl),
          parser: attribute.parser ?? parserForUrl(sources, attribute.sourceUrl),
          stage: attribute.stage ?? stageForUrl(sources, attribute.sourceUrl),
          confidence: technicalAttributeConfidence(attribute, property.unitKind, quantities.length, matchType, aliasMatch?.score),
          reason: technicalAttributeReason(attribute, property.key, property.unitKind, quantities.length, aliasMatch, matchType)
        }
      ];
    })
  ).sort(compareTechnicalAttributes);
}

function propertyForKnownAlias(canonicalKey: string | undefined): CanonicalProperty | undefined {
  if (!canonicalKey) return undefined;
  return PROPERTY_ONTOLOGY.find((property) => property.key === canonicalKey);
}

function shouldPreferFuzzyAlias(
  aliasMatch: TechnicalAttributeAliasMatch | undefined,
  ontologyProperty: CanonicalProperty | undefined
): boolean {
  if (!aliasMatch) return false;
  if (!ontologyProperty) return true;
  if (aliasMatch.alias.canonicalKey === ontologyProperty.key) return false;
  return ontologyProperty.key === "power" && aliasMatch.alias.canonicalKey === "powerLoss" && aliasMatch.score >= 0.84;
}

function technicalAttributeMatchType(
  aliasMatch: TechnicalAttributeAliasMatch | undefined,
  ontologyProperty: CanonicalProperty | undefined
): TechnicalAttributeRecord["matchType"] {
  return aliasMatch?.matchType ?? (ontologyProperty ? "ontology" : undefined);
}

function attributeLabel(attribute: AttributeRecord): string {
  return cleanText(`${attribute.group ?? ""} ${attribute.name}`.trim());
}

function quantityTextWithUnitHint(attribute: AttributeRecord, kind: QuantityKind | undefined): string {
  const value = cleanText(attribute.value);
  if (!value || !kind || parseQuantities(value, { kind }).length > 0) return value;
  if (!/-?\d/.test(value)) return value;
  const hint = explicitUnitHint(attribute, kind);
  return hint ? `${value} ${hint}` : value;
}

function explicitUnitHint(attribute: AttributeRecord, kind: QuantityKind): string | undefined {
  const unit = cleanText(attribute.unit);
  if (unit && parseQuantities(`1 ${unit}`, { kind }).length > 0) return unit;
  const label = cleanText(`${attribute.group ?? ""} ${attribute.name}`);
  for (const candidate of unitCandidatesForKind(kind)) {
    const escaped = escapeRegExp(candidate);
    if (new RegExp(`(?:^|[\\s\\[\\]()/,-])${escaped}(?:$|[\\s\\[\\]()/,-])`, "i").test(label)) return candidate;
  }
  return undefined;
}

function unitCandidatesForKind(kind: QuantityKind): string[] {
  if (kind === "voltage") return ["VAC", "VDC", "kV", "mV", "V"];
  if (kind === "current") return ["kA", "mA", "A"];
  if (kind === "power") return ["kW", "mW", "W"];
  if (kind === "frequency") return ["MHz", "kHz", "Hz"];
  if (kind === "temperature") return ["degC"];
  if (kind === "mass") return ["kg", "mg", "g", "lb", "oz"];
  if (kind === "length") return ["mm", "cm"];
  if (kind === "torque") return ["Nm"];
  if (kind === "pressure") return ["MPa", "kPa", "mbar", "bar", "psi", "Pa"];
  if (kind === "flowRate") return ["Nl/min", "l/min", "m3/h", "m3/min", "dm3/min", "gpm", "cfm"];
  if (kind === "area") return ["mm2", "cm2"];
  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTechnicalQuantity(quantity: ParsedQuantity): TechnicalAttributeQuantity {
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

function technicalAttributeConfidence(
  attribute: AttributeRecord,
  unitKind: string | undefined,
  quantityCount: number,
  matchType: TechnicalAttributeRecord["matchType"],
  matchScore: number | undefined
): number {
  let confidence = confidenceBaseForMatchType(matchType);
  if (unitKind && quantityCount > 0) confidence += 0.08;
  if (!unitKind) confidence += 0.04;
  if (matchType?.startsWith("fuzzy_") && matchScore !== undefined) confidence += Math.max(0, (matchScore - 0.84) * 0.12);
  if (attribute.sourceType === "official") confidence += 0.06;
  else if (attribute.sourceType === "official-fallback") confidence += 0.04;
  else if (attribute.sourceType === "distributor") confidence -= 0.12;
  else if (attribute.sourceType === "generated") confidence -= 0.04;
  if (attribute.confidence !== undefined) confidence = (confidence + attribute.confidence) / 2;
  return Math.max(0.1, Math.min(0.99, Number(confidence.toFixed(2))));
}

function confidenceBaseForMatchType(matchType: TechnicalAttributeRecord["matchType"]): number {
  if (matchType === "manufacturer_alias") return 0.88;
  if (matchType === "global_alias") return 0.87;
  if (matchType === "fuzzy_manufacturer_alias") return 0.78;
  if (matchType === "fuzzy_global_alias") return 0.76;
  if (matchType === "fuzzy_cross_manufacturer_alias") return 0.72;
  return 0.82;
}

function technicalAttributeReason(
  attribute: AttributeRecord,
  canonicalKey: string,
  unitKind: string | undefined,
  quantityCount: number,
  aliasMatch: TechnicalAttributeAliasMatch | undefined,
  matchType: TechnicalAttributeRecord["matchType"]
): string {
  const parts = aliasMatch
    ? [technicalAliasReason(aliasMatch, canonicalKey)]
    : [`Label matched ontology key '${canonicalKey}'`];
  if (unitKind) parts.push(quantityCount ? `value parsed as ${unitKind}` : `expected ${unitKind} value not parsed`);
  if (matchType) parts.push(`match type ${matchType}`);
  if (attribute.sourceType) parts.push(`source ${attribute.sourceType}`);
  return parts.join("; ");
}

function technicalAliasReason(aliasMatch: TechnicalAttributeAliasMatch, canonicalKey: string): string {
  if (aliasMatch.matchType === "manufacturer_alias") {
    return `Known manufacturer alias from ${aliasMatch.alias.evidenceLabel} mapped to '${canonicalKey}'`;
  }
  if (aliasMatch.matchType === "global_alias") {
    return `Global alias '${aliasMatch.alias.originalName}' mapped to '${canonicalKey}'`;
  }
  return `Fuzzy alias '${aliasMatch.alias.originalName}' (${aliasMatch.score}) mapped to '${canonicalKey}'`;
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
