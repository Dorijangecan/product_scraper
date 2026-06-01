import type {
  AttributeRecord,
  DocumentRecord,
  FinalCompletenessRecord,
  ManufacturerConfig,
  NormalizedProductFields,
  ProductResult,
  SourceRecord
} from "../../shared/types.js";
import { requiredElectricalFields } from "../../shared/product-requirements.js";
import { cleanText, normalizeFields } from "./normalizer.js";

export type FinalCompletenessField = "image" | keyof Pick<
  NormalizedProductFields,
  "weight" | "dimensions" | "material" | "certificates" | "voltage" | "current"
>;
type FinalCompletenessNormalizedField = Exclude<FinalCompletenessField, "image">;
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

const CORE_NORMALIZED_FIELDS: FinalCompletenessNormalizedField[] = ["weight", "dimensions", "material"];
const SECONDARY_NORMALIZED_FIELDS: FinalCompletenessNormalizedField[] = ["certificates"];
const ALL_FIELDS: FinalCompletenessField[] = ["image", "weight", "dimensions", "material", "certificates", "voltage", "current"];

const MATERIAL_PATTERN =
  /\b(stainless steel|carbon steel|mild steel|galvannealed steel|galvanized steel|steel|aluminum|aluminium|polycarbonate|polyester|fiberglass|fibreglass|plastic|pvc|pur|brass|copper|zinc|cast iron|polyamide|polypropylene|polyethylene|rubber|epdm|nylon)\b/i;

export function evaluateFinalCompleteness(result: ProductResult, manufacturer: ManufacturerConfig): FinalCompletenessAudit {
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
    current: result.normalized.current
  };
  const requirements: Partial<Record<FinalCompletenessField, FinalRequirement>> = {};

  for (const field of ALL_FIELDS) {
    const requirement = finalFieldRequirement(field, result, manufacturer);
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

  // Performance: skip expensive network retry when quality gate already passed and only
  // preferred (not required) fields are missing. These retries cost ~5-10s per item but
  // rarely find values that weren't already published on the primary page.
  const allPreferred = fields.every((field) => audit.requirements[field] === "preferred");
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
  const normalizedMissing = missing.filter((field): field is FinalCompletenessNormalizedField => field !== "image");
  const needsImage = missing.includes("image");
  const existingRecipe = manufacturer.scrapeRecipe ?? {};
  const existingQualityPolicy = existingRecipe.qualityPolicy ?? {};
  return {
    ...manufacturer,
    scrapeRecipe: {
      ...existingRecipe,
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
  return ALL_FIELDS.map((field) => {
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

function finalFieldRequirement(field: FinalCompletenessField, result: ProductResult, manufacturer: ManufacturerConfig): FinalRequirement {
  if (field === "voltage" || field === "current") {
    return requiredElectricalFields(result).includes(field) ? "required" : "not-applicable";
  }
  if (field === "certificates") return "preferred";
  if (field === "image") return "required";
  if (manufacturer.id === "sce") return "required";
  if (field === "material" && manufacturer.id === "abb" && requiredElectricalFields(result).length > 0) return "preferred";
  if (isPassiveMechanicalProduct(result)) return "required";
  if (field === "weight" && isCompactSensorOrElectronics(result)) return "preferred";
  return CORE_NORMALIZED_FIELDS.includes(field) ? "preferred" : "preferred";
}

function isRetryableField(field: FinalCompletenessField, requirement: FinalRequirement): boolean {
  if (requirement === "not-applicable") return false;
  if (field === "certificates") return false;
  return true;
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
  return field === "dimensions" || field === "voltage" || field === "current";
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
  switch (field) {
    case "weight":
      return /\b(weight|mass|gewicht|peso|shipping weight|unit weight|net weight|gross weight)\b/i.test(label);
    case "dimensions":
      return /\b(dimensions?|size|height|width|depth|length|hxwxd|h x w x d|overall)\b/i.test(label);
    case "material":
      return /\b(material|housing|body|enclosure|construction)\b/i.test(label);
    case "certificates":
      return /\b(approval|conformity|certificate|certification|standard|compliance|ul|ce|rohs|weee|reach)\b/i.test(label);
    case "voltage":
      return /\b(voltage|volt|vac|vdc|rated operational voltage|supply voltage|input power)\b/i.test(label);
    case "current":
      return /\b(current|amp|amps|amperage|switching capacity|max\.? current|rated current)\b/i.test(label);
    case "image":
      return /\b(image|picture|photo|media)\b/i.test(label);
  }
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
  const seen = new Set<string>();
  return attributes.filter((attr) => {
    const key = `${attr.group ?? ""}|${attr.name}|${attr.value}|${attr.sourceUrl ?? ""}`.toLowerCase();
    if (!attr.name || !attr.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const seen = new Set<string>();
  return documents.filter((doc) => {
    const key = doc.url.toLowerCase();
    if (!doc.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSources(sources: SourceRecord[]): SourceRecord[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.parser}|${source.url}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueFields(values: FinalCompletenessField[]): FinalCompletenessField[] {
  return [...new Set(values)];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
