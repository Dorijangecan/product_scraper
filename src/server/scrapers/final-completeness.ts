import { uniqueStrings } from "../text-util.js";
import type {
  AttributeRecord,
  DocumentRecord,
  FinalCompletenessRecord,
  FinalCompletenessPolicyField,
  ManufacturerConfig,
  NormalizedProductFields,
  ProductResult,
  SourceRecord
} from "../../shared/types.js";
import { isFamilyOverviewResult, requiredElectricalFields } from "../../shared/product-requirements.js";
import { getManufacturerConfig } from "../config/manufacturers.js";
import { electricalFieldsForDeviceType, finalCompletenessFieldsForDeviceType } from "../pdt/device-type-profiles.js";
import { classifyDeviceType } from "./device-type.js";
import { dedupeAttributes as dedupeAttributesBase, dedupeDocuments as dedupeSharedDocuments, dedupeSources } from "./dedupe.js";
import { fieldMatchesLabel, type RegistryFieldKey } from "./field-registry.js";
import { cleanText, normalizeFields } from "./normalizer.js";
import { matchProperty } from "./ontology.js";
import { structuredIdentityConflict } from "./product-identity.js";
import { isPlausibleTemperatureCelsius, parseTemperatureRange } from "./quantity.js";

export type FinalCompletenessField = FinalCompletenessPolicyField;
type FinalCompletenessNormalizedField = Extract<FinalCompletenessField, keyof NormalizedProductFields>;
type FinalRequirement = FinalCompletenessRecord["requirement"];

export interface FinalCompletenessAudit {
  missing: FinalCompletenessField[];
  retryMissing: FinalCompletenessField[];
  notApplicable: FinalCompletenessField[];
  values: Partial<Record<FinalCompletenessField, string>>;
  requirements: Partial<Record<FinalCompletenessField, FinalRequirement>>;
}

export interface FinalCompletenessRepairResult {
  result: ProductResult;
  repairedFields: FinalCompletenessField[];
  records: Array<{ field: FinalCompletenessField; value: string; source?: string }>;
}

export interface FinalNetworkRetryDecision {
  shouldRetry: boolean;
  fields: FinalCompletenessField[];
  reason: string;
  triedStages: string[];
  untriedStages: string[];
}

export interface FinalCompletenessOptions {
  requireImage?: boolean;
}

const CORE_NORMALIZED_FIELDS: FinalCompletenessNormalizedField[] = ["weight", "dimensions", "material"];
const SECONDARY_NORMALIZED_FIELDS: FinalCompletenessNormalizedField[] = ["certificates"];
const BASE_FIELDS: FinalCompletenessField[] = ["image", "weight", "dimensions", "material", "certificates", "voltage", "current"];

const MATERIAL_PATTERN =
  /\b(stainless steel|carbon steel|mild steel|galvannealed steel|galvanized steel|steel|aluminum|aluminium|polycarbonate|polyester|fiberglass|fibreglass|plastic|pvc|pur|brass|copper|zinc|cast iron|polyamide|polypropylene|polyethylene|rubber|epdm|nylon)\b/i;
const TYPE_CODE_PATTERN =
  /\b(type\s*code|typecode|model\s*code|modellcode|extended\s+product\s+type|type\s+designation|product\s+main\s+type|main\s+type|catalog(?:ue)?\s+type|order\s+type|MLFB)\b/i;
const TYPE_CODE_REQUIRED_ATTRIBUTE =
  "type code|typecode|model code|modellcode|extended product type|type designation|product main type|main type|catalog(?:ue)? type|order type|MLFB";

export function evaluateFinalCompleteness(
  result: ProductResult,
  manufacturer: ManufacturerConfig,
  options: FinalCompletenessOptions = {}
): FinalCompletenessAudit {
  const missing: FinalCompletenessField[] = [];
  const retryMissing: FinalCompletenessField[] = [];
  const notApplicable: FinalCompletenessField[] = [];
  const values: Partial<Record<FinalCompletenessField, string>> = {
    image: firstImageValue(result),
    weight: result.normalized.weight,
    dimensions: result.normalized.dimensions,
    material: result.normalized.material,
    certificates: result.normalized.certificates,
    voltage: result.normalized.voltage,
    current: result.normalized.current,
    color: result.normalized.color,
    protection: result.normalized.protection,
    operatingTemperature: operatingTemperatureValue(result),
    typeCode: typeCodeValue(result, manufacturer)
  };
  const requirements: Partial<Record<FinalCompletenessField, FinalRequirement>> = {};
  const requireImage = options.requireImage ?? true;

  for (const field of finalCompletenessFields(result)) {
    const requirement = finalFieldRequirement(field, result, manufacturer, { requireImage });
    requirements[field] = requirement;
    if (requirement === "not-applicable") {
      if (!values[field]) notApplicable.push(field);
      continue;
    }
    if (values[field]) continue;
    missing.push(field);
    if (isRetryableField(field, requirement)) retryMissing.push(field);
  }

  return {
    missing: uniqueFields(missing),
    retryMissing: uniqueFields(retryMissing),
    notApplicable: uniqueFields(notApplicable),
    values,
    requirements
  };
}

export function repairFinalCompletenessFromEvidence(
  result: ProductResult,
  manufacturer: ManufacturerConfig,
  audit: FinalCompletenessAudit = evaluateFinalCompleteness(result, manufacturer)
): FinalCompletenessRepairResult {
  if (structuredIdentityConflict(result, result.catalogNumber, manufacturer)) {
    return { result, repairedFields: [], records: [] };
  }

  const repairFields = uniqueFields([...audit.retryMissing, ...audit.missing]).filter((field) => field !== "image" || !audit.notApplicable.includes(field));
  const attributes: AttributeRecord[] = [];
  const documents: DocumentRecord[] = [];
  const records: FinalCompletenessRepairResult["records"] = [];

  for (const field of repairFields) {
    const repair = repairFieldFromAttributes(result, field);
    if (repair?.attribute) {
      attributes.push(repair.attribute);
      records.push({ field, value: repair.attribute.value, source: repair.attribute.sourceUrl });
      continue;
    }
    if (field === "image") {
      const document = repairImageDocument(result, manufacturer);
      if (document) {
        documents.push(document);
        records.push({ field, value: document.url, source: document.sourceUrl });
      }
    }
  }

  if (!attributes.length && !documents.length) {
    return { result, repairedFields: [], records: [] };
  }

  const nextAttributes = dedupeAttributes([...result.attributes, ...attributes]);
  const nextDocuments = dedupeDocuments([...result.documents, ...documents]);
  const normalized = {
    ...normalizeFields(nextAttributes, nextDocuments),
    ...nonEmptyNormalized(result.normalized)
  };
  const sources = dedupeSources([
    ...result.sources,
    {
      url: result.productUrl ?? result.sources[0]?.url ?? `generated:final-completeness:${result.catalogNumber}`,
      sourceType: "generated",
      parser: "final-field-repair",
      stage: "final-completeness-repair",
      reason: `Filled ${records.map((record) => record.field).join(", ")} from existing evidence`,
      fetchedAt: new Date().toISOString()
    }
  ]);

  return {
    result: {
      ...result,
      normalized,
      attributes: nextAttributes,
      documents: nextDocuments,
      sources,
      diagnostics: {
        ...result.diagnostics,
        fallbackStages: uniqueStrings([...(result.diagnostics?.fallbackStages ?? []), "final-field-repair"]),
        notes: uniqueStrings([
          ...(result.diagnostics?.notes ?? []),
          `Final field repair filled ${uniqueFields(records.map((record) => record.field)).join(", ")} from existing evidence.`
        ]).slice(0, 50)
      }
    },
    repairedFields: uniqueFields(records.map((record) => record.field)),
    records
  };
}

export function finalNetworkRetryDecision(
  result: ProductResult,
  manufacturer: ManufacturerConfig,
  audit: FinalCompletenessAudit,
  options: { exhaustedFields?: Set<string>; force?: boolean } = {}
): FinalNetworkRetryDecision {
  let fields = audit.retryMissing;
  const exhausted = options.exhaustedFields;
  const force = options.force ?? false;

  // Final network retry is the expensive tail of the run. By this point the main scrape,
  // document enrichment, quality fallback, and existing-evidence repair have already had a
  // chance to find product media and identity labels. Do not start another discovery/reader/
  // browser round only for these final-export conveniences; keep them visible as missing and
  // let the row finish quickly. Force retry keeps the old exhaustive behavior for manual audits.
  if (!force) {
    const networkFields = fields.filter(isNetworkRetryField);
    if (networkFields.length === 0 && fields.length > 0) {
      return {
        shouldRetry: false,
        fields,
        reason: `Skipped network retry for final-only fields (${fields.join(", ")}); existing evidence repair already ran.`,
        triedStages: triedFinalStages(result),
        untriedStages: []
      };
    }
    fields = networkFields;
  }

  // Honor the persisted "exhausted" cache: if a prior run already proved this catalog
  // number doesn't publish this field, don't burn time looking again. The user can
  // override with the forceFinalRetry run option.
  if (!force && exhausted && exhausted.size) {
    const filtered = fields.filter((field) => !exhausted.has(field));
    if (filtered.length === 0) {
      return {
        shouldRetry: false,
        fields,
        reason: `Skipped network retry: every missing field (${fields.join(", ")}) was previously marked as not published for this catalog number. Toggle "Force final retry" to override.`,
        triedStages: triedFinalStages(result),
        untriedStages: []
      };
    }
    fields = filtered;
  }

  if (!fields.length) {
    return { shouldRetry: false, fields: [], reason: "No retryable final completeness fields are missing.", triedStages: triedFinalStages(result), untriedStages: [] };
  }

  // Performance: skip expensive network retry when either the manufacturer data profile
  // documents that preferred-only final retries are unproductive, or quality already passed.
  // Required fields still retry unless they are cached as exhausted.
  const allPreferred = fields.every((field) => audit.requirements[field] === "preferred");
  if (allPreferred && manufacturer.scrapeRecipe?.fallbackPolicy?.skipPreferredFinalCompletenessRetry && !force) {
    return {
      shouldRetry: false,
      fields,
      reason: `Skipped network retry for preferred-only missing fields (${fields.join(", ")}) because the manufacturer profile marks these final retries as unproductive.`,
      triedStages: triedFinalStages(result),
      untriedStages: []
    };
  }
  if (allPreferred && result.qualityGate?.passed && !force) {
    const triedStages = triedFinalStages(result);
    return {
      shouldRetry: false,
      fields,
      reason: `Skipped network retry for preferred-only missing fields (${fields.join(", ")}) because quality gate already passed.`,
      triedStages,
      untriedStages: []
    };
  }

  const possibleStages = possibleFinalNetworkStages(result, manufacturer);
  const triedStages = triedFinalStages(result);
  const untriedStages = possibleStages.filter((stage) => !triedStages.includes(stage));
  if (untriedStages.length > 0) {
    return {
      shouldRetry: true,
      fields,
      reason: `Untried final fallback stages remain: ${untriedStages.join(", ")}.`,
      triedStages,
      untriedStages
    };
  }

  return {
    shouldRetry: false,
    fields,
    reason: possibleStages.length
      ? `Skipped duplicate final fallback; already tried ${possibleStages.join(", ")}.`
      : "Skipped final fallback; no official product URL or configured network fallback stage is available.",
    triedStages,
    untriedStages
  };
}

export function withFinalCompletenessPolicy(
  manufacturer: ManufacturerConfig,
  missing: FinalCompletenessField[]
): ManufacturerConfig {
  const normalizedMissing = missing.flatMap((field): Array<keyof NormalizedProductFields> => {
    if (field === "operatingTemperature") return ["operatingTemperatureMin", "operatingTemperatureMax"];
    return isNormalizedCompletenessField(field) ? [field] : [];
  });
  const needsImage = missing.includes("image");
  const needsTypeCode = missing.includes("typeCode");
  const existingRecipe = manufacturer.scrapeRecipe ?? {};
  const existingQualityPolicy = existingRecipe.qualityPolicy ?? {};
  return {
    ...manufacturer,
    scrapeRecipe: {
      ...existingRecipe,
      requiredAttributes: needsTypeCode
        ? uniqueStrings([...(existingRecipe.requiredAttributes ?? []), TYPE_CODE_REQUIRED_ATTRIBUTE])
        : existingRecipe.requiredAttributes,
      requiredDocuments: needsImage
        ? uniqueStrings([...(existingRecipe.requiredDocuments ?? []).map(String), "image"])
        : existingRecipe.requiredDocuments,
      qualityPolicy: {
        ...existingQualityPolicy,
        requiredNormalizedFields: uniqueStrings([
          ...(existingQualityPolicy.requiredNormalizedFields ?? []),
          ...normalizedMissing
        ]) as Array<keyof NormalizedProductFields>
      }
    }
  };
}

export function withFinalCompletenessDiagnostics(
  result: ProductResult,
  before: FinalCompletenessAudit,
  after: FinalCompletenessAudit,
  options: {
    repairedFields?: FinalCompletenessField[];
    networkRetry?: FinalNetworkRetryDecision & { attempted: boolean };
  } = {}
): ProductResult {
  const repairedFields = uniqueFields(options.repairedFields ?? []);
  const retryLabel = before.retryMissing.length ? `Final completeness retry fields: ${before.retryMissing.join(", ")}` : undefined;
  const repairLabel = repairedFields.length ? `Final field repair filled: ${repairedFields.join(", ")}` : undefined;
  const remainingLabel = after.missing.length
    ? `Final completeness still missing: ${after.missing.join(", ")}`
    : before.retryMissing.length || repairedFields.length
      ? "Final completeness passed after repair."
      : "Final completeness passed.";
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      finalCompleteness: {
        checkedAt: new Date().toISOString(),
        beforeMissing: before.missing,
        retryMissing: before.retryMissing,
        afterMissing: after.missing,
        notApplicable: after.notApplicable,
        repairedFields,
        networkRetry: options.networkRetry
          ? {
              attempted: options.networkRetry.attempted,
              fields: options.networkRetry.fields,
              reason: options.networkRetry.reason,
              triedStages: options.networkRetry.triedStages,
              untriedStages: options.networkRetry.untriedStages
            }
          : undefined,
        records: finalCompletenessRecords(before, after, repairedFields, options.networkRetry)
      },
      notes: uniqueStrings([
        ...(result.diagnostics?.notes ?? []),
        retryLabel,
        repairLabel,
        options.networkRetry?.reason,
        remainingLabel
      ]).slice(0, 50)
    }
  };
}

export function applyFinalCompletenessStatus(
  result: ProductResult,
  audit: FinalCompletenessAudit,
  manufacturer: ManufacturerConfig
): ProductResult {
  if (result.status === "failed") return result;
  const requiredMissing = audit.missing.filter((field) => audit.requirements[field] === "required");
  if (!requiredMissing.length) return result;

  const recipe = manufacturer.scrapeRecipe;
  const partialCap = recipe?.qualityPolicy?.partialConfidenceCap ?? recipe?.confidenceRules?.partialMaxConfidence ?? 0.74;
  const note = `Final required fields missing: ${requiredMissing.join(", ")}`;

  return {
    ...result,
    status: "partial",
    confidence: Math.min(result.confidence, partialCap),
    error: result.error ?? note,
    diagnostics: {
      ...result.diagnostics,
      notes: uniqueStrings([...(result.diagnostics?.notes ?? []), note]).slice(0, 50)
    }
  };
}

function finalCompletenessRecords(
  before: FinalCompletenessAudit,
  after: FinalCompletenessAudit,
  repairedFields: FinalCompletenessField[],
  networkRetry: (FinalNetworkRetryDecision & { attempted: boolean }) | undefined
): FinalCompletenessRecord[] {
  return auditRecordFields(before, after).map((field) => {
    const requirement = after.requirements[field] ?? before.requirements[field] ?? "preferred";
    const beforeMissing = before.missing.includes(field);
    const afterMissing = after.missing.includes(field);
    const beforeValue = before.values[field];
    const afterValue = after.values[field];
    if (requirement === "not-applicable") {
      return {
        field,
        status: "not-applicable",
        requirement,
        beforeValue,
        afterValue,
        action: "Skipped",
        reason: notApplicableReason(field)
      };
    }
    if (!beforeMissing && !afterMissing) {
      return { field, status: "present", requirement, beforeValue, afterValue, action: "None", reason: "Value was present before final audit." };
    }
    if (beforeMissing && !afterMissing) {
      const repaired = repairedFields.includes(field);
      return {
        field,
        status: repaired ? "found-after-repair" : "found-after-retry",
        requirement,
        beforeValue,
        afterValue,
        action: repaired ? "Parsed from existing evidence" : "Final network retry",
        reason: repaired ? "Filled from already collected attributes or parsed documents." : "Filled after an untried fallback stage."
      };
    }
    if (afterMissing && networkRetry && !networkRetry.attempted) {
      // Distinguish "we deliberately skipped the retry this run" from "the retry ran and
      // came back empty". retry-skipped is RETRY-eligible on future runs; not-published is
      // the conclusion after we actually tried.
      return {
        field,
        status: "retry-skipped",
        requirement,
        beforeValue,
        afterValue,
        action: "Skipped duplicate retry",
        reason: networkRetry.reason
      };
    }
    if (afterMissing && networkRetry?.attempted) {
      return {
        field,
        status: "not-published",
        requirement,
        beforeValue,
        afterValue,
        action: "Final network retry",
        reason: "Final retry did not find a published value."
      };
    }
    return {
      field,
      status: "missing",
      requirement,
      beforeValue,
      afterValue,
      action: "Needs manual check",
      reason: "No final repair action was available."
    };
  });
}

function finalFieldRequirement(
  field: FinalCompletenessField,
  result: ProductResult,
  manufacturer: ManufacturerConfig,
  options: FinalCompletenessOptions = {}
): FinalRequirement {
  if (field === "image" && options.requireImage === false) return "not-applicable";
  const profileRequirement = profileFinalFieldRequirement(field, manufacturer);
  if (profileRequirement) return profileRequirement;
  const classification = classifyDeviceType(result);
  const electricalContext = {
    deviceType: classification.type,
    deviceTypeConfidence: classification.confidence,
    deviceTypeElectricalFields: electricalFieldsForDeviceType(classification.type)
  };
  if (field === "voltage" || field === "current") {
    return requiredElectricalFields(result, electricalContext).includes(field) ? "required" : "not-applicable";
  }
  if (isFamilyOverviewResult(result) && ["image", "dimensions", "material", "color", "operatingTemperature"].includes(field)) return "not-applicable";
  if (field === "color" || field === "operatingTemperature" || field === "protection" || field === "typeCode") return "preferred";
  if (field === "certificates") return "preferred";
  if (field === "image") return "required";
  if (isPassiveMechanicalProduct(result)) return "required";
  if (field === "weight" && isCompactSensorOrElectronics(result)) return "preferred";
  return CORE_NORMALIZED_FIELDS.includes(field) ? "preferred" : "preferred";
}

function profileFinalFieldRequirement(field: FinalCompletenessField, manufacturer: ManufacturerConfig): FinalRequirement | undefined {
  const policy = manufacturer.scrapeRecipe?.qualityPolicy;
  if (!policy?.requiredFinalFields?.length) {
    return policy?.preferredFinalFields?.includes(field) ? "preferred" : undefined;
  }
  if (policy.requiredFinalFields.includes(field)) return "required";
  if (policy.preferredFinalFields?.includes(field)) return "preferred";
  return "not-applicable";
}

function isRetryableField(field: FinalCompletenessField, requirement: FinalRequirement): boolean {
  if (requirement === "not-applicable") return false;
  if (field === "certificates") return false;
  return true;
}

function isNetworkRetryField(field: FinalCompletenessField): boolean {
  return field !== "image" && field !== "typeCode";
}

function finalCompletenessFields(result: ProductResult): FinalCompletenessField[] {
  const classified = classifyDeviceType(result);
  const profileFields = finalCompletenessFieldsForDeviceType(classified.confidence && classified.confidence >= 0.78 ? classified.type : undefined);
  return uniqueFields([...BASE_FIELDS, ...profileFields]);
}

function isNormalizedCompletenessField(field: FinalCompletenessField): field is FinalCompletenessNormalizedField {
  return field !== "image" && field !== "operatingTemperature" && field !== "typeCode";
}

function auditRecordFields(before: FinalCompletenessAudit, after: FinalCompletenessAudit): FinalCompletenessField[] {
  return uniqueFields([
    ...Object.keys(before.requirements),
    ...Object.keys(after.requirements)
  ] as FinalCompletenessField[]);
}

function repairFieldFromAttributes(
  result: ProductResult,
  field: FinalCompletenessField
): { attribute: AttributeRecord } | undefined {
  if (field === "image") return undefined;
  const extractor = valueExtractor(field);
  const candidates = result.attributes
    .map((attr) => {
      const label = `${attr.group ?? ""} ${attr.name}`;
      const matchedFieldEvidence = fieldLabelMatches(field, `${label} ${attr.value}`);
      if (!matchedFieldEvidence && requiresFieldEvidenceForRepair(field)) return undefined;
      const text = `${attr.name}: ${attr.value}`;
      const value = extractor(matchedFieldEvidence ? attr.value : text, label);
      return value ? { attr, value, score: repairAttributeScore(field, attr) } : undefined;
    })
    .filter((candidate): candidate is { attr: AttributeRecord; value: string; score: number } => Boolean(candidate))
    .sort((left, right) => right.score - left.score);
  const candidate = candidates[0];
  if (!candidate) return undefined;
  return {
    attribute: {
      group: "Final Field Repair",
      name: canonicalFieldLabel(field),
      value: candidate.value,
      sourceUrl: candidate.attr.sourceUrl,
      sourceType: "generated",
      parser: "final-field-repair",
      stage: "final-completeness-repair",
      confidence: Math.min(candidate.attr.confidence ?? 0.72, 0.78)
    }
  };
}

function requiresFieldEvidenceForRepair(field: FinalCompletenessField): boolean {
  return field !== "material" && field !== "certificates";
}

function valueExtractor(field: FinalCompletenessField): (value: string, label: string) => string | undefined {
  switch (field) {
    case "weight":
      return (value) => extractWeight(value);
    case "dimensions":
      return (value, label) => (/package|packing|packaging/i.test(label) ? undefined : extractDimensions(value));
    case "material":
      return (value) => extractMaterial(value);
    case "certificates":
      return (value) => extractCertificates(value);
    case "voltage":
      return (value) => extractVoltage(value);
    case "current":
      return (value) => extractCurrent(value);
    case "color":
      return (value) => extractColor(value);
    case "protection":
      return (value) => extractProtection(value);
    case "operatingTemperature":
      return (value, label) => extractOperatingTemperature(`${label}: ${value}`);
    case "typeCode":
      return (value) => extractTypeCode(value);
    case "image":
      return () => undefined;
  }
}

function repairImageDocument(result: ProductResult, manufacturer: ManufacturerConfig): DocumentRecord | undefined {
  const candidates = uniqueStrings(
    result.attributes.flatMap((attr) => {
      const text = `${attr.name} ${attr.value} ${attr.sourceUrl ?? ""}`;
      return imageUrlsFromText(text, attr.sourceUrl);
    })
  );
  const url = candidates.find((candidate) => productImageUrlLooksRelevant(candidate, result, manufacturer));
  if (!url) return undefined;
  return {
    type: "image",
    label: "Product image (final repair)",
    url,
    sourceUrl: result.productUrl ?? result.sources[0]?.url,
    sourceType: "generated",
    parser: "final-field-repair",
    stage: "final-completeness-repair",
    confidence: 0.62
  };
}

function imageUrlsFromText(value: string, baseUrl?: string): string[] {
  const urls = [...value.matchAll(/(?:https?:\/\/|\/)[^\s"'<>]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>]*)?/gi)]
    .map((match) => toAbsoluteUrl(match[0], baseUrl))
    .filter((url): url is string => Boolean(url));
  return urls;
}

function productImageUrlLooksRelevant(url: string, result: ProductResult, manufacturer?: ManufacturerConfig): boolean {
  const text = url.toLowerCase();
  if (/logo|icon|sprite|placeholder|loading/i.test(text)) return false;
  const compactPart = result.catalogNumber.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compactPart && text.replace(/[^a-z0-9]/g, "").includes(compactPart)) return true;
  // Tightened: only trust generic product/image/cdn keywords when the URL is hosted on a
  // known official manufacturer domain. Random CDN URLs without catalog-number context were
  // sneaking through and getting written as product images.
  if (manufacturer && /product|image|gallery|zoom|media|assets|cdn/i.test(text)) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
      return manufacturer.officialBaseUrls.some((baseUrl) => {
        const baseHost = officialHostname(baseUrl);
        return baseHost ? host === baseHost || host.endsWith(`.${baseHost}`) : false;
      });
    } catch {
      return false;
    }
  }
  return false;
}

function fieldLabelMatches(field: FinalCompletenessField, label: string): boolean {
  if (fieldMatchesLabel(field as RegistryFieldKey, label)) return true;
  return matchProperty(label)?.key === field || (field === "typeCode" && TYPE_CODE_PATTERN.test(label));
}

function repairAttributeScore(field: FinalCompletenessField, attr: AttributeRecord): number {
  const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
  let score = attr.sourceType === "official" ? 100 : attr.sourceType === "official-fallback" ? 85 : attr.sourceType === "generated" ? 75 : 45;
  if (/pdf|document/.test(`${attr.parser ?? ""} ${attr.stage ?? ""} ${attr.group ?? ""}`.toLowerCase())) score += 25;
  if (field === "weight" && /\b(product net weight|net weight|unit weight|product weight|mass)\b/.test(label)) score += 35;
  if (field === "weight" && /\b(package|packing|packaging|shipping|gross)\b/.test(label)) score -= 15;
  if (field === "dimensions" && /\b(package|packing|packaging)\b/.test(label)) score -= 60;
  if (field === "material" && /\b(housing|enclosure|body|base material)\b/.test(label)) score += 30;
  if (attr.confidence !== undefined) score += Math.round(attr.confidence * 10);
  return score;
}

function extractWeight(value: string): string | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|lb|lbs|pound|pounds|oz|ounce|ounces)\b/i);
  return match ? cleanText(match[0]) : undefined;
}

function extractDimensions(value: string): string | undefined {
  const cleaned = cleanText(value);
  if (!/\d/.test(cleaned)) return undefined;
  if (/\b\d+(?:[.,]\d+)?\s*(?:x|X|\*)\s*\d+(?:[.,]\d+)?(?:\s*(?:x|X|\*)\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm|m)\s*(?:²|2)/i.test(cleaned)) return undefined;
  const labeled = cleaned.match(/\b(?:H|Height)\s*[:=]?\s*\d+(?:[.,]\d+)?\s*(?:mm|cm|m|in|inch|inches|")?.{0,80}\b(?:W|Width)\s*[:=]?\s*\d+(?:[.,]\d+)?/i);
  if (labeled) return compactRepairValue(labeled[0]);
  const sequence = cleaned.match(/\b\d+(?:[.,]\d+)?\s*(?:x|X|\*)\s*\d+(?:[.,]\d+)?(?:\s*(?:x|X|\*)\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm|m|in|inch|inches|")\b/i);
  return sequence ? compactRepairValue(sequence[0]) : undefined;
}

function extractMaterial(value: string): string | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(MATERIAL_PATTERN);
  return match ? cleanText(match[1]).replace(/^aluminium$/i, "aluminum") : undefined;
}

function extractCertificates(value: string): string | undefined {
  const cleaned = cleanText(value);
  const tokens = uniqueStrings([
    ...(cleaned.match(/\bcULus\b/g) ?? []),
    ...(cleaned.match(/\bcUL\b/g) ?? []),
    ...(cleaned.match(/\bUL\b/g) ?? []),
    ...(cleaned.match(/\bCSA\b/g) ?? []),
    ...(cleaned.match(/\bCE\b/g) ?? []),
    ...(cleaned.match(/\bUKCA\b/g) ?? []),
    ...(cleaned.match(/\bRoHS\b/gi) ?? []),
    ...(cleaned.match(/\bREACH\b/gi) ?? []),
    ...(cleaned.match(/\bWEEE\b/gi) ?? []),
    ...(cleaned.match(/\bIEC\s+\d+(?:[.-]\d+)*/g) ?? []),
    ...(cleaned.match(/\bNEMA\s+(?:Type\s*)?[0-9][0-9A-Z, ]*/gi) ?? [])
  ].map((token) => cleanText(token).replace(/^reach$/i, "REACH").replace(/^rohs$/i, "RoHS").replace(/^weee$/i, "WEEE")));
  return tokens.join("; ") || undefined;
}

function extractVoltage(value: string): string | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/\b\d+(?:[.,]\d+)?(?:\s*(?:\.{2,3}|-|to)\s*\d+(?:[.,]\d+)?)?\s*V\s*(?:AC|DC|AC\/DC)?(?:\s*\d+\/?\d*\s*Hz)?\b/i);
  return match ? cleanText(match[0].replace(/\s+/g, " ")) : undefined;
}

function extractCurrent(value: string): string | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/\b(?:<=|>=|<|>)?\s*\d+(?:[.,]\d+)?(?:\s*(?:\.{2,3}|-|to)\s*\d+(?:[.,]\d+)?)?\s*(?:A|mA|amp|amps|amperes?)\b/i);
  return match ? cleanText(match[0].replace(/\s+/g, " ")) : undefined;
}

function extractColor(value: string): string | undefined {
  const cleaned = cleanText(value);
  const ansi = cleaned.match(/\bANSI[-\s]?61\s+gr[ae]y\b/i);
  if (ansi) return "ANSI-61 gray";
  const ral = cleaned.match(/\bRAL\s*(\d{4})\b/i);
  if (ral) return `RAL ${ral[1]}`;
  const match = cleaned.match(/\b(?:black|white|gr[ae]y|red|blue|green|yellow|orange|silver|natural|beige|cream)\b/i);
  return match ? cleanText(match[0].toLowerCase().replace(/^grey$/, "gray")) : undefined;
}

function extractProtection(value: string): string | undefined {
  const cleaned = cleanText(value);
  const tokens = [
    ...(cleaned.match(/\bIP\s*\d{2}[A-Z]?\b/gi) ?? []),
    ...(cleaned.match(/\bIK\s*\d{2}\b/gi) ?? []),
    ...(cleaned.match(/\bNEMA\s*(?:Type\s*)?\d+[A-Z]?\b/gi) ?? [])
  ];
  for (const match of cleaned.matchAll(/\bType\s+\d+[A-Z]?\b/gi)) {
    const prefix = cleaned.slice(Math.max(0, match.index - 8), match.index);
    if (!/NEMA\s*$/i.test(prefix)) tokens.push(match[0]);
  }
  const normalized = uniqueStrings(
    tokens.map((token) => cleanText(token).replace(/\s+/g, "").replace(/^NEMAType/i, "NEMA Type ").replace(/^NEMA/i, "NEMA ").replace(/^type/i, "Type"))
  );
  return normalized.join("; ") || undefined;
}

function extractOperatingTemperature(value: string): string | undefined {
  if (/\b(storage|transport|color\s+temp|colou?r\s+temp)\b/i.test(value)) return undefined;
  const range = parseTemperatureRange(value);
  if (range.min === undefined && range.max === undefined) return undefined;
  if (range.min !== undefined && !isPlausibleTemperatureCelsius(range.min)) return undefined;
  if (range.max !== undefined && !isPlausibleTemperatureCelsius(range.max)) return undefined;
  return formatOperatingTemperature(range.min, range.max);
}

function extractTypeCode(value: string): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned || cleaned.length > 120) return undefined;
  return cleaned;
}

function possibleFinalNetworkStages(result: ProductResult, manufacturer: ManufacturerConfig): string[] {
  const stages = ["discovery"];
  if (hasOfficialProductUrl(result, manufacturer)) {
    const policy = manufacturer.scrapeRecipe?.fallbackPolicy;
    if (policy?.readerOnQualityFailure !== false) stages.push("reader");
    if (policy?.browserOnQualityFailure !== false && policy?.maxBrowserAttempts !== 0) stages.push("browser");
  }
  return stages;
}

function triedFinalStages(result: ProductResult): string[] {
  const text = [
    ...(result.diagnostics?.fallbackStages ?? []),
    ...(result.qualityGate?.attempts?.map((attempt) => attempt.stage) ?? []),
    ...result.sources.flatMap((source) => [source.stage, source.parser])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const stages: string[] = [];
  if (/discovery|discovered/.test(text) || result.diagnostics?.discoveredCandidates?.length || result.diagnostics?.rejectedLinks?.length) stages.push("discovery");
  if (/reader|r\.jina/.test(text)) stages.push("reader");
  if (/browser/.test(text)) stages.push("browser");
  return uniqueStrings(stages);
}

function hasOfficialProductUrl(result: ProductResult, manufacturer: ManufacturerConfig): boolean {
  const candidates = [
    result.productUrl,
    ...result.sources.filter((source) => source.sourceType === "official" || source.sourceType === "official-fallback").map((source) => source.url)
  ].filter((url): url is string => Boolean(url));
  return candidates.some((url) => isOfficialUrl(url, manufacturer));
}

function isOfficialUrl(url: string, manufacturer: ManufacturerConfig): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return manufacturer.officialBaseUrls.some((baseUrl) => {
      const baseHostname = officialHostname(baseUrl);
      if (!baseHostname) return false;
      return hostname === baseHostname || hostname.endsWith(`.${baseHostname}`) || (hostname === "r.jina.ai" && url.toLowerCase().includes(baseHostname));
    });
  } catch {
    return false;
  }
}

function officialHostname(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function firstImageValue(result: ProductResult): string | undefined {
  const image = result.documents.find((doc) => {
    if (doc.type !== "image") return false;
    if (doc.downloadStatus === "failed" || doc.downloadStatus === "skipped") return false;
    return Boolean(doc.localPath || doc.downloadStatus === "downloaded" || doc.downloadStatus === undefined);
  });
  return image?.localPath ?? image?.url;
}

function operatingTemperatureValue(result: ProductResult): string | undefined {
  const min = numberFromString(result.normalized.operatingTemperatureMin);
  const max = numberFromString(result.normalized.operatingTemperatureMax);
  return formatOperatingTemperature(min, max);
}

function formatOperatingTemperature(min: number | undefined, max: number | undefined): string | undefined {
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined) return `${formatTemperatureBound(min)}..${formatTemperatureBound(max)} °C`;
  if (min !== undefined) return `>= ${formatTemperatureBound(min)} °C`;
  if (max !== undefined) return `<= ${formatTemperatureBound(max)} °C`;
  return undefined;
}

function formatTemperatureBound(value: number): string {
  return String(Number(value.toFixed(6)));
}

function numberFromString(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function typeCodeValue(result: ProductResult, manufacturer: ManufacturerConfig): string | undefined {
  const attr = result.attributes.find((candidate) => {
    const label = `${candidate.group ?? ""} ${candidate.name}`;
    return matchProperty(label)?.key === "typeCode" || TYPE_CODE_PATTERN.test(label);
  });
  if (attr?.value) return cleanText(attr.value);
  if (manufacturerPolicyForResult(result, manufacturer).scrapeRecipe?.qualityPolicy?.typeCodeFallback === "catalogNumber") {
    return cleanText(result.catalogNumber);
  }
  return undefined;
}

function manufacturerPolicyForResult(result: ProductResult, manufacturer: ManufacturerConfig): ManufacturerConfig {
  if (!result.manufacturerId || result.manufacturerId === manufacturer.id) return manufacturer;
  return getManufacturerConfig(result.manufacturerId) ?? manufacturer;
}

function isPassiveMechanicalProduct(result: ProductResult): boolean {
  return /\b(enclosure|cabinet|box|junction box|panel|subpanel|mounting plate|door|cover|bracket|plate|wireway)\b/i.test(primaryProductText(result));
}

function isCompactSensorOrElectronics(result: ProductResult): boolean {
  return /\b(sensor|photoelectric|proximity|rfid|camera|io-link|module|controller|plc|relay|interface)\b/i.test(primaryProductText(result));
}

function primaryProductText(result: ProductResult): string {
  return [
    result.catalogNumber,
    result.title,
    result.description,
    ...result.attributes
      .filter((attr) => /\b(product|description|type|family|group|catalog)\b/i.test(`${attr.group ?? ""} ${attr.name}`))
      .slice(0, 30)
      .map((attr) => `${attr.name} ${attr.value}`)
  ]
    .filter(Boolean)
    .join(" ");
}

function notApplicableReason(field: FinalCompletenessField): string {
  if (field === "voltage" || field === "current") return "Product type does not require this electrical rating.";
  return "Field is not applicable for this product.";
}

function canonicalFieldLabel(field: FinalCompletenessField): string {
  switch (field) {
    case "image":
      return "Product image";
    case "weight":
      return "Weight";
    case "dimensions":
      return "Dimensions";
    case "material":
      return "Material";
    case "certificates":
      return "Certificates";
    case "voltage":
      return "Voltage";
    case "current":
      return "Current";
    case "color":
      return "Color";
    case "protection":
      return "Protection";
    case "operatingTemperature":
      return "Operating Temperature";
    case "typeCode":
      return "Type Code";
  }
}

function compactRepairValue(value: string): string {
  return cleanText(value).slice(0, 220);
}

function toAbsoluteUrl(value: string, baseUrl?: string): string | undefined {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function nonEmptyNormalized(normalized: ProductResult["normalized"]): ProductResult["normalized"] {
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && value !== "")) as ProductResult["normalized"];
}

function dedupeAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return dedupeAttributesBase(attributes, { includeSourceUrl: true });
}

const dedupeDocuments = dedupeSharedDocuments;

function uniqueFields(values: FinalCompletenessField[]): FinalCompletenessField[] {
  return [...new Set(values)];
}

