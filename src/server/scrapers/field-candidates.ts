import type {
  AttributeRecord,
  DocumentRecord,
  FieldCandidateRecord,
  FieldResolutionRecord,
  NormalizedProductFields,
  ProductResult,
  SourceRecord
} from "../../shared/types.js";
import { FIELD_REGISTRY, fieldAttributeLabel, fieldMatchesLabel, type RegistryFieldKey } from "./field-registry.js";
import { evidenceConfidence } from "./evidence-score.js";
import { catalogTextMatches } from "./catalog-number.js";
import { cleanText, isSchneiderM221OutputCurrent, isSchneiderPendantStation, isSchneiderSafetyLightCurtain, normalizeFields } from "./normalizer.js";
import { applyRockwellNormalizedOverrides } from "./rockwell.js";
import { isQuantityPlausible, parseQuantities, type QuantityKind } from "./quantity.js";

const NORMALIZED_FIELDS = new Set<keyof NormalizedProductFields>([
  "weight",
  "dimensions",
  "material",
  "wallThickness",
  "finish",
  "color",
  "voltage",
  "current",
  "protection",
  "certificates",
  "operatingTemperatureMin",
  "operatingTemperatureMax"
]);

export function applyFieldCandidateResolution(result: ProductResult): ProductResult {
  const candidates = buildFieldCandidates(result);
  const resolutions = buildFieldResolutions(candidates);
  const normalized = { ...result.normalized };
  if (normalized.weight && /\b(?:CO2|carbon\s+footprint)\b/i.test(normalized.weight)) delete normalized.weight;
  if (result.manufacturerId === "schneider" && isSchneiderSurgeProtector(result)) delete normalized.current;
  if (result.manufacturerId === "schneider" && isSchneiderSafetyLightCurtain(result.attributes)) delete normalized.current;
  if (result.manufacturerId === "schneider" && isSchneiderSafetyControllerOutputRating(result.attributes)) delete normalized.current;
  if (result.manufacturerId === "schneider" && isSchneiderM221OutputCurrent(result.attributes)) delete normalized.current;
  if (result.manufacturerId === "schneider" && isSchneiderPendantStation(result.attributes)) delete normalized.dimensions;
  if (result.manufacturerId === "schneider" && isSchneiderBusPoweredInputModule(result.attributes)) delete normalized.voltage;
  const eatonElectrical = result.manufacturerId === "eaton"
    ? normalizeFields(result.attributes, result.documents, "eaton")
    : undefined;
  if (eatonElectrical) {
    if (eatonElectrical.voltage) normalized.voltage = eatonElectrical.voltage;
    else delete normalized.voltage;
    if (eatonElectrical.current) normalized.current = eatonElectrical.current;
    else delete normalized.current;
  }
  const previousPenalty = result.diagnostics?.confidencePenalty ?? 0;
  const conflictPenalty = Math.min(0.15, resolutions.reduce((sum, resolution) => sum + resolution.conflictCount * 0.02, 0));
  // Resolution is invoked at multiple pipeline stages. Persist the largest known penalty so the
  // same unresolved conflict cannot erode confidence again on every pass.
  const confidencePenalty = Math.max(previousPenalty, conflictPenalty);
  const confidence = Math.max(0, Math.round((result.confidence - (confidencePenalty - previousPenalty)) * 10_000) / 10_000);

  for (const resolution of resolutions) {
    if (!resolution.selectedValue || !isNormalizedField(resolution.field)) continue;
    const key = resolution.field as keyof NormalizedProductFields;
    if (key === "weight" && /\b(?:CO2|carbon\s+footprint)\b/i.test(resolution.selectedValue)) continue;
    // Preserve SPD ratings as named evidence (Iimp, In and Imax), without flattening
    // their surge current into the general operating-current field.
    if (result.manufacturerId === "schneider" && key === "current" && isSchneiderSurgeProtector(result)) continue;
    if (result.manufacturerId === "schneider" && key === "current" && isSchneiderSafetyLightCurtain(result.attributes)) continue;
    if (result.manufacturerId === "schneider" && key === "current" && isSchneiderSafetyControllerOutputRating(result.attributes)) continue;
    if (result.manufacturerId === "schneider" && key === "current" && isSchneiderM221OutputCurrent(result.attributes)) continue;
    if (result.manufacturerId === "schneider" && key === "dimensions" && isSchneiderPendantStation(result.attributes)) continue;
    if (result.manufacturerId === "schneider" && key === "voltage" && isSchneiderBusPoweredInputModule(result.attributes)) continue;
    // ABB material/color are normalized from official product attributes only. Loose PDF table
    // fragments such as "Graphic color: display" are not product finish/material data and must
    // not be reintroduced after the manufacturer-specific normalizer rejected them.
    if (result.manufacturerId === "abb" && (key === "material" || key === "color")) continue;
    // Siemens dimensions can be packaging measurements or HMI display/cutout values; material and
    // color candidates also contain product-code fragments. The Siemens connector normalizer is
    // authoritative for these fields, so unresolved values stay blank rather than being restored
    // from a weaker raw candidate.
    if (result.manufacturerId === "siemens" && (key === "dimensions" || key === "material" || key === "color")) continue;
    // Mechanical position switches may expose insulation or impulse withstand ratings and
    // contact-load rows, but those do not establish a general supply voltage/current field.
    if (result.manufacturerId === "siemens" && (key === "voltage" || key === "current") &&
      /\b(?:limit switch|position switch)\b/i.test(`${result.title} ${result.description}`)) continue;
    // Eaton's generic field candidates flatten component scope (for example, a built-in LED's
    // voltage) and broad PDF tables into product-level values. Electrical fields must instead be
    // supported by the evidence-scoped normalizer above.
    if (eatonElectrical && (key === "voltage" || key === "current") && !eatonElectrical[key]) continue;
    // Phoenix signal conditioners publish input-signal current ranges (for example ±1 mA) as
    // signal characteristics, not as the product's operating-current rating. The Phoenix
    // normalizer intentionally leaves this field blank; do not reintroduce the raw row here.
    if (result.manufacturerId === "phoenix" && key === "current" && isPhoenixSignalConditioner(result.attributes)) continue;
    if (normalized[key]) continue;
    // Field candidates are raw evidence. Do not let a winning candidate bypass the canonical
    // field validator just because it won a source-priority comparison (e.g. "24VDC" → "24 V DC").
    const validated = normalizeFields([
      {
        // "Field candidate resolution" contains the word "resolution", which the voltage
        // normalizer correctly treats as an unrelated electrical qualifier. Keep this synthetic
        // group neutral so the selected label/value is evaluated on its own evidence.
        group: "Resolved candidate",
        name: resolution.label,
        value: resolution.selectedValue,
        sourceUrl: resolution.selectedSourceUrl,
        sourceType: "generated",
        parser: resolution.selectedParser ?? "field-candidate-resolution",
        stage: resolution.selectedStage ?? "field-candidate-resolution",
        confidence: resolution.confidence
      }
    ], [], result.manufacturerId)[key];
    if (validated) normalized[key] = validated;
  }
  if (result.manufacturerId === "schneider") {
    const dualRangeVoltage = schneiderLexiumDualRangeVoltage(result.attributes);
    if (dualRangeVoltage) normalized.voltage = dualRangeVoltage;
    applyExactSchneiderDescriptionFields(result, normalized);
    if (hasSchneiderNetPackageWeightConflict(result.attributes)) delete normalized.weight;
  }
  if (result.manufacturerId === "rockwell") {
    applyRockwellNormalizedOverrides(normalized, result.catalogNumber, result.attributes);
  }

  return {
    ...result,
    confidence,
    normalized,
    diagnostics: {
      ...result.diagnostics,
      fieldCandidates: candidates.slice(0, 300),
      fieldResolutions: resolutions,
      confidencePenalty
    }
  };
}

function isSchneiderSafetyControllerOutputRating(attributes: AttributeRecord[]): boolean {
  const text = attributes.map((attribute) => `${attribute.group ?? ""} ${attribute.name} ${attribute.value}`).join(" ");
  const hasSafetyControllerAndOssd = /\b(?:safety controller|safe controller)\b/i.test(text) && /\bOSSD\b/i.test(text);
  const hasSupplyCurrent = attributes.some((attribute) =>
    /^(?:rated\s+(?:supply\s+)?current|supply current|input current|current consumption)$/i.test(attribute.name.trim())
  );
  return hasSafetyControllerAndOssd && !hasSupplyCurrent;
}

function isSchneiderBusPoweredInputModule(attributes: AttributeRecord[]): boolean {
  const text = attributes.map((attribute) => `${attribute.group ?? ""} ${attribute.name} ${attribute.value}`).join(" ");
  const isInputModule = /\b(?:discrete|digital) input module\b/i.test(text);
  const busPowered = /\bpower supply type\b[^.]{0,80}\b(?:internal bus|bus connector)\b/i.test(text);
  const hasRatedSupplyVoltage = attributes.some((attribute) => /\b(?:rated|nominal)\s+supply voltage\b/i.test(attribute.name));
  return isInputModule && busPowered && !hasRatedSupplyVoltage;
}

function schneiderLexiumDualRangeVoltage(attributes: AttributeRecord[]): string | undefined {
  const text = attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(" ");
  if (!/\bLexium\s*32\b/i.test(text)) return undefined;
  const match = text.match(/rated supply voltage of\s*(\d+(?:\.\d+)?)\s*V\s*to\s*(\d+(?:\.\d+)?)\s*V,\s*(\d+(?:\.\d+)?)\s*V\s*to\s*(\d+(?:\.\d+)?)\s*V\s*\(single phase\)/i);
  return match ? `${match[1]}...${match[2]} V AC; ${match[3]}...${match[4]} V AC` : undefined;
}

function applyExactSchneiderDescriptionFields(
  result: ProductResult,
  normalized: NormalizedProductFields
): void {
  const exactUrl = result.productUrl ?? result.localizedUrls?.en;
  if (!exactUrl || !catalogTextMatches(exactUrl, result.catalogNumber)) return;
  const description = result.attributes.find((attribute) =>
    attribute.parser === "schneider-product-page" &&
    Boolean(attribute.sourceUrl && catalogTextMatches(attribute.sourceUrl, result.catalogNumber)) &&
    /^description$/i.test(attribute.name.trim())
  )?.value;
  if (!description) return;

  if (normalized.weight && /\b(?:CO2|carbon\s+footprint)\b/i.test(normalized.weight)) delete normalized.weight;
  const weight = description.match(/\bweighs?\s+(\d+(?:[.,]\d+)?)\s*kg\b/i);
  if (weight) normalized.weight = `${weight[1].replace(",", ".")} kg`;

  const depthHeightWidth = description.match(/\bdimensions?\s+(?:are|is)\s+(\d+(?:[.,]\d+)?)\s*mm\s*\(Depth\),\s*(\d+(?:[.,]\d+)?)\s*mm\s*\(Height\)\s+and\s+(\d+(?:[.,]\d+)?)\s*mm\s*\(Width\)/i);
  const widthDepthHeight = description.match(/\bdimensions?\s+(?:are|is)\s+(\d+(?:[.,]\d+)?)\s*mm\s*\(Width\)\s*x\s*(\d+(?:[.,]\d+)?)\s*mm\s*\(Depth\)\s*x\s*(\d+(?:[.,]\d+)?)\s*mm\s*\(Height\)/i);
  if (depthHeightWidth) {
    normalized.dimensions = `D ${depthHeightWidth[1]} mm x H ${depthHeightWidth[2]} mm x W ${depthHeightWidth[3]} mm`;
  } else if (widthDepthHeight) {
    normalized.dimensions = `H ${widthDepthHeight[3]} mm x W ${widthDepthHeight[1]} mm x D ${widthDepthHeight[2]} mm`;
  }

  const protection = description.match(/\b(IP\s*\d{2})\s+rated product\b/i);
  if (protection) normalized.protection = protection[1].replace(/\s+/g, "").toUpperCase();
}

function hasSchneiderNetPackageWeightConflict(attributes: AttributeRecord[]): boolean {
  const productWeight = attributes
    .filter((attribute) => /^net weight$/i.test(attribute.name.trim()))
    .map((attribute) => weightInKilograms(attribute.value))
    .find((value): value is number => value !== undefined);
  const packageWeight = attributes
    .filter((attribute) => /^package weight(?:\s*\([^)]*\))?$/i.test(attribute.name.trim()))
    .map((attribute) => weightInKilograms(attribute.value))
    .find((value): value is number => value !== undefined);
  return productWeight !== undefined && packageWeight !== undefined && Math.max(productWeight, packageWeight) / Math.min(productWeight, packageWeight) > 2;
}

function weightInKilograms(value: string): number | undefined {
  const match = value.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
  if (!match) return undefined;
  const quantity = Number(match[1].replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) return undefined;
  return match[2].toLowerCase() === "g" ? quantity / 1000 : quantity;
}

function isSchneiderSurgeProtector(result: ProductResult): boolean {
  return result.attributes.some((attribute) =>
    /^(?:product or component type|product type|title)$/i.test(attribute.name.trim()) &&
    /\bsurge arrester\b|\bsurge protective device\b/i.test(attribute.value)
  );
}

function isPhoenixSignalConditioner(attributes: AttributeRecord[]): boolean {
  return attributes.some((attribute) =>
    /^(?:title|product type|product name|catalog description)$/i.test(attribute.name.trim()) &&
    /\b(?:input signal conditioner|signal conditioner)\b/i.test(attribute.value)
  );
}

export function buildFieldCandidates(result: ProductResult): FieldCandidateRecord[] {
  const candidates: FieldCandidateRecord[] = [];
  for (const field of FIELD_REGISTRY) {
    candidates.push(...attributeCandidates(result.attributes, field.key, field.label, result.manufacturerId));
    candidates.push(...documentCandidates(result.documents, field.key, field.label));
    const normalized = normalizedFieldValue(result.normalized, field.key);
    if (normalized) {
      const source = bestMatchingAttribute(result.attributes, field.key, normalized);
      candidates.push(toCandidate({
        field: field.key,
        label: field.label,
        value: normalized,
        sourceUrl: source?.sourceUrl,
        sourceType: source?.sourceType ?? "generated",
        parser: source?.parser ?? "normalizer",
        stage: source?.stage ?? "normalize",
        confidence: source?.confidence ?? result.confidence
      }));
    }
  }
  const selectedKeys = new Set(buildFieldResolutions(candidates).map((resolution) => `${resolution.field}|${comparable(resolution.selectedValue ?? "")}`));
  return dedupeCandidates(candidates).map((candidate) => ({
    ...candidate,
    selected: selectedKeys.has(`${candidate.field}|${comparable(candidate.value)}`)
  }));
}

export function buildFieldResolutions(candidates: FieldCandidateRecord[]): FieldResolutionRecord[] {
  const byField = new Map<string, FieldCandidateRecord[]>();
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const list = byField.get(candidate.field) ?? [];
    list.push(candidate);
    byField.set(candidate.field, list);
  }
  const resolutions: FieldResolutionRecord[] = [];
  for (const [field, records] of byField.entries()) {
    const sorted = dedupeCandidates(records).sort((left, right) => right.priority - left.priority || (right.confidence ?? 0) - (left.confidence ?? 0));
    const selected = sorted[0];
    const distinctValues = new Set(sorted.map((candidate) => comparable(candidate.value)).filter(Boolean));
    resolutions.push({
      field,
      label: selected.label,
      selectedValue: selected.value,
      selectedSourceUrl: selected.sourceUrl,
      selectedParser: selected.parser,
      selectedStage: selected.stage,
      confidence: selected.confidence,
      candidateCount: sorted.length,
      conflictCount: Math.max(0, distinctValues.size - 1),
      reason: distinctValues.size > 1
        ? `Selected ${selected.priorityReason}; retained ${distinctValues.size - 1} conflicting value(s) for review.`
        : `Selected ${selected.priorityReason}.`
    });
  }
  return resolutions.sort((left, right) => left.field.localeCompare(right.field));
}

// Heading-less loose key/value pairs the generic parser could not attribute to a real spec table
// (locale switchers, breadcrumbs, "Current Selected Country", …). They must never be promoted into
// a normalized field — they bypass the value validation normalizeFields applies and inject chrome
// like "Bahamas | English" into electrical fields.
function isNonSpecEvidenceAttribute(attribute: AttributeRecord): boolean {
  return (attribute.group ?? "").trim().toLowerCase() === "page evidence";
}

// Quantitative fields require a numeric value. Field candidates use the RAW attribute value with no
// normalization, so without this guard a label match alone lets non-numeric prose (a certificate's
// "Maximum)" tail, a country name) populate voltage/current/weight/dimensions when normalizeFields
// correctly left them blank.
const NUMERIC_FIELDS = new Set<string>([
  "weight",
  "dimensions",
  "wallThickness",
  "voltage",
  "current",
  "operatingTemperature",
  "operatingTemperatureMin",
  "operatingTemperatureMax"
]);

// The expected physical-quantity kind(s) for each numeric field. A raw candidate must parse into a
// plausible quantity of one of these kinds — a bare digit isn't enough ("24-month warranty",
// "REACH 1907/2006", "5. Small equipment" all contain a digit but are not a rated value).
const NUMERIC_FIELD_KINDS: Record<string, QuantityKind[]> = {
  weight: ["mass"],
  dimensions: ["length"],
  wallThickness: ["length"],
  voltage: ["voltage"],
  current: ["current"],
  operatingTemperature: ["temperature"],
  operatingTemperatureMin: ["temperature"],
  operatingTemperatureMax: ["temperature"]
};

function numericCandidateValueLooksValid(field: RegistryFieldKey, value: string | undefined): boolean {
  const text = cleanText(value);
  if (!text || !/\d/.test(text)) return false;
  const kinds = NUMERIC_FIELD_KINDS[field];
  if (!kinds) return true; // numeric field with no kind mapping — keep the loose digit check
  return parseQuantities(text).some((quantity) => kinds.includes(quantity.kind) && isQuantityPlausible(quantity));
}

function attributeCandidates(attributes: AttributeRecord[], field: RegistryFieldKey, label: string, manufacturerId: ProductResult["manufacturerId"]): FieldCandidateRecord[] {
  if (field === "image" || field === "datasheetUrl" || field === "manualUrl" || field === "certificateUrl") return [];
  const requiresNumeric = NUMERIC_FIELDS.has(field);
  return attributes
    .filter((attribute) => !isNonSpecEvidenceAttribute(attribute))
    // Rittal family descriptions and linked manuals often mention values for the installed system
    // (e.g. copper busbars, fan IP ratings, or the UI label "Farbe: Status"). Keep those raw rows,
    // but do not promote them into product-level fields without an official PDP attribute.
    .filter((attribute) => manufacturerId !== "rittal" || !["material", "color", "finish", "protection", "current"].includes(field) || attribute.sourceType === "official" || attribute.sourceType === "official-fallback")
    .filter((attribute) => manufacturerId !== "rittal" || field !== "current" || !/\b\d[\d.,]*\s*kA\b/i.test(attribute.value))
    .filter((attribute) => manufacturerId !== "eaton" || field !== "wallThickness" || !/\bbusbar\b/i.test(`${attribute.group ?? ""} ${attribute.name}`))
    // Siemens catalogs also label installation-panel and mounting plate dimensions as "Thickness".
    // Those are not enclosure wall measurements; promote only explicitly named wall thickness.
    .filter((attribute) => manufacturerId !== "siemens" || field !== "wallThickness" || /\b(?:wall|housing|enclosure)\s+thickness\b/i.test(`${attribute.group ?? ""} ${attribute.name}`))
    .filter((attribute) => !requiresNumeric || numericCandidateValueLooksValid(field, attribute.value))
    .filter((attribute) => fieldMatchesLabel(field, fieldAttributeLabel(attribute)))
    .filter((attribute) => cleanText(attribute.value))
    .map((attribute) => toCandidate({
      field,
      label,
      value: attribute.value,
      sourceUrl: attribute.sourceUrl,
      sourceType: attribute.sourceType,
      parser: attribute.parser,
      stage: attribute.stage,
      confidence: attribute.confidence
    }));
}

function documentCandidates(documents: DocumentRecord[], field: RegistryFieldKey, label: string): FieldCandidateRecord[] {
  const type = documentTypeForField(field);
  if (field !== "image" && !type) return [];
  return documents
    .filter((document) => field === "image" ? document.type === "image" : document.type === type)
    .map((document) => toCandidate({
      field,
      label,
      value: document.localPath ?? document.url,
      sourceUrl: document.sourceUrl ?? document.url,
      sourceType: document.sourceType,
      parser: document.parser,
      stage: document.stage,
      confidence: document.confidence
    }));
}

function toCandidate(input: {
  field: string;
  label: string;
  value: string;
  sourceUrl?: string;
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
}): FieldCandidateRecord {
  const priority = sourcePriority(input);
  return {
    ...input,
    value: cleanText(input.value),
    priority: priority.priority,
    priorityReason: priority.reason
  };
}

function sourcePriority(candidate: {
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
}): { priority: number; reason: string } {
  const parser = candidate.parser ?? "";
  const stage = candidate.stage ?? "";
  let priority = Math.round(evidenceConfidence(candidate) * 1000);
  let reason = "lowest-priority source";
  if (/customer-document/i.test(parser) || /customer/i.test(stage)) {
    priority = 1000;
    reason = "customer document priority";
  } else if (candidate.sourceType === "official" && /pdf|document|datasheet|manual/i.test(`${parser} ${stage}`)) {
    reason = "official parsed document priority";
  } else if (candidate.sourceType === "official") {
    reason = "official source priority";
  } else if (candidate.sourceType === "official-fallback" && /browser-network|api|json/i.test(`${parser} ${stage}`)) {
    reason = "official network/API priority";
  } else if (candidate.sourceType === "official-fallback") {
    reason = "official fallback priority";
  } else if (candidate.sourceType === "generated") {
    reason = "generated normalizer priority";
  } else if (candidate.sourceType === "cache") {
    reason = "cache priority";
  } else if (candidate.sourceType === "distributor") {
    reason = "distributor fallback priority";
  }
  return { priority, reason };
}

function bestMatchingAttribute(attributes: AttributeRecord[], field: RegistryFieldKey, value: string): AttributeRecord | undefined {
  const matches = attributes.filter((attribute) => fieldMatchesLabel(field, fieldAttributeLabel(attribute)));
  return matches.find((attribute) => comparable(attribute.value) === comparable(value)) ?? matches[0];
}

function normalizedFieldValue(normalized: NormalizedProductFields, field: RegistryFieldKey): string | undefined {
  if (field === "image" || field === "datasheetUrl" || field === "manualUrl" || field === "certificateUrl" || field === "typeCode") return undefined;
  if (field === "operatingTemperature") {
    const min = normalized.operatingTemperatureMin;
    const max = normalized.operatingTemperatureMax;
    if (min && max) return `${min}..${max} C`;
    if (min) return `>= ${min} C`;
    if (max) return `<= ${max} C`;
    return undefined;
  }
  return normalized[field];
}

function documentTypeForField(field: RegistryFieldKey): DocumentRecord["type"] | undefined {
  if (field === "datasheetUrl") return "datasheet";
  if (field === "manualUrl") return "manual";
  if (field === "certificateUrl") return "certificate";
  return undefined;
}

function isNormalizedField(field: string): field is keyof NormalizedProductFields {
  return NORMALIZED_FIELDS.has(field as keyof NormalizedProductFields);
}

function dedupeCandidates(candidates: FieldCandidateRecord[]): FieldCandidateRecord[] {
  const seen = new Set<string>();
  const result: FieldCandidateRecord[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.field}|${comparable(candidate.value)}|${candidate.sourceUrl ?? ""}|${candidate.parser ?? ""}`.toLowerCase();
    if (!candidate.value || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function comparable(value: string): string {
  return cleanText(value).toLowerCase().replace(/\s+/g, " ").trim();
}
