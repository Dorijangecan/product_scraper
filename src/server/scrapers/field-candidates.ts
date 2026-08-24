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
import { cleanText, normalizeFields } from "./normalizer.js";
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
  const previousPenalty = result.diagnostics?.confidencePenalty ?? 0;
  const conflictPenalty = Math.min(0.15, resolutions.reduce((sum, resolution) => sum + resolution.conflictCount * 0.02, 0));
  // Resolution is invoked at multiple pipeline stages. Persist the largest known penalty so the
  // same unresolved conflict cannot erode confidence again on every pass.
  const confidencePenalty = Math.max(previousPenalty, conflictPenalty);
  const confidence = Math.max(0, Math.round((result.confidence - (confidencePenalty - previousPenalty)) * 10_000) / 10_000);

  for (const resolution of resolutions) {
    if (!resolution.selectedValue || !isNormalizedField(resolution.field)) continue;
    const key = resolution.field as keyof NormalizedProductFields;
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
    ], [])[key];
    if (validated) normalized[key] = validated;
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

export function buildFieldCandidates(result: ProductResult): FieldCandidateRecord[] {
  const candidates: FieldCandidateRecord[] = [];
  for (const field of FIELD_REGISTRY) {
    candidates.push(...attributeCandidates(result.attributes, field.key, field.label));
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

function attributeCandidates(attributes: AttributeRecord[], field: RegistryFieldKey, label: string): FieldCandidateRecord[] {
  if (field === "image" || field === "datasheetUrl" || field === "manualUrl" || field === "certificateUrl") return [];
  const requiresNumeric = NUMERIC_FIELDS.has(field);
  return attributes
    .filter((attribute) => !isNonSpecEvidenceAttribute(attribute))
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
