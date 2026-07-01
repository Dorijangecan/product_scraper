import { sameNormalizedUrl as sameUrl } from "./url-util.js";
import type {
  CustomCoverageField,
  ProductResult,
  RunCoverageField,
  RunCoverageState,
  RunItemCoverageSummary,
  RunItemCustomCoverageResult,
  RunItemRecord
} from "../shared/types.js";
import { requiredElectricalFields } from "../shared/product-requirements.js";
import { electricalFieldsForDeviceType } from "./pdt/device-type-profiles.js";
import { classifyDeviceType } from "./scrapers/device-type.js";

const CRITICAL_FIELDS: RunCoverageField[] = ["image", "weight", "dimensions", "material", "voltage", "current"];

export function summarizeRunItem(
  item: RunItemRecord,
  options: { customCoverageFields?: CustomCoverageField[]; includeImages?: boolean } = {}
): RunItemRecord {
  if (!item.result) return item;
  return {
    ...item,
    coverage: buildCoverageSummary(item, options.customCoverageFields ?? [], options.includeImages ?? true),
    result: undefined
  };
}

function buildCoverageSummary(item: RunItemRecord, customFieldDefs: CustomCoverageField[], includeImages: boolean): RunItemCoverageSummary {
  const result = item.result!;
  const fields: Partial<Record<RunCoverageField, RunCoverageState>> = {
    enUrl: coverageState(result, "enUrl"),
    deUrl: coverageState(result, "deUrl"),
    image: includeImages ? coverageState(result, "image") : "not-applicable",
    weight: coverageState(result, "weight"),
    certificates: coverageState(result, "certificates"),
    dimensions: coverageState(result, "dimensions"),
    material: coverageState(result, "material"),
    voltage: coverageState(result, "voltage"),
    current: coverageState(result, "current")
  };
  const criticalFields = includeImages ? CRITICAL_FIELDS : CRITICAL_FIELDS.filter((field) => field !== "image");
  const criticalMissing = criticalFields.filter((field) => fields[field] === "missing");
  const customFields = evaluateCustomFields(result, customFieldDefs);
  return {
    fields,
    ...(customFields.length ? { customFields } : {}),
    criticalMissing,
    reason: itemReason(item, criticalMissing, customFields),
    qualityPassed: result.qualityGate?.passed,
    qualityMissing: result.qualityGate?.missing ?? [],
    finalCompletenessAfterMissing: result.diagnostics?.finalCompleteness?.afterMissing,
    fieldHealth: fieldHealthSummary(result),
    documentProcessing: documentProcessingSummary(result),
    discovery: discoverySummary(result),
    pageMining: pageMiningSummary(result),
    attributeCount: result.attributes.length,
    documentCount: result.documents.length,
    evidenceCount: result.evidence?.length ?? 0
  };
}

function pageMiningSummary(result: ProductResult): RunItemCoverageSummary["pageMining"] | undefined {
  const records = result.diagnostics?.pageMining ?? [];
  const driftSuspected = result.diagnostics?.drift?.suspected ?? result.diagnostics?.targetHealth?.driftSuspected;
  if (!records.length && !driftSuspected) return undefined;
  return {
    stages: records.length,
    attributes: records.reduce((sum, record) => sum + record.attributeCount, 0),
    documents: records.reduce((sum, record) => sum + record.documentCount, 0),
    signals: [...new Set(records.flatMap((record) => record.signals ?? []))].slice(0, 12),
    driftSuspected
  };
}

function fieldHealthSummary(result: ProductResult): RunItemCoverageSummary["fieldHealth"] | undefined {
  const records = result.diagnostics?.fieldHealth;
  if (!records?.length) return undefined;
  const found = records.filter((record) => record.status === "found").length;
  const missing = records.filter((record) => record.status === "missing").length;
  const lowConfidence = records.filter((record) => record.status === "low-confidence").length;
  const conflicting = records.filter((record) => record.status === "conflicting").length;
  const reviewFields = records
    .filter((record) => record.status === "missing" || record.status === "low-confidence" || record.status === "conflicting")
    .map((record) => record.label || record.field)
    .slice(0, 12);
  return { found, missing, lowConfidence, conflicting, reviewFields };
}

function documentProcessingSummary(result: ProductResult): RunItemCoverageSummary["documentProcessing"] | undefined {
  const records = result.diagnostics?.documentProcessing;
  if (!records?.length) return undefined;
  const parsed = records.filter((record) => record.action === "parsed").length;
  const skipped = records.filter((record) => record.action === "skipped").length;
  const failed = records.filter((record) => record.action === "failed").length;
  const attributeCount = records.reduce((sum, record) => sum + (record.attributeCount ?? 0), 0);
  const normalizedFields = [...new Set(records.flatMap((record) => record.normalizedFields ?? []))].sort();
  const reviewDocuments = records
    .filter((record) => record.action === "skipped" || record.action === "failed")
    .map((record) => {
      const label = record.label || record.type || record.url;
      return `${label}: ${record.action}${record.reason ? ` (${record.reason})` : ""}`;
    })
    .slice(0, 12);
  return { parsed, skipped, failed, attributeCount, normalizedFields, reviewDocuments };
}

function discoverySummary(result: ProductResult): RunItemCoverageSummary["discovery"] | undefined {
  const diagnostics = result.diagnostics;
  if (!diagnostics) return undefined;

  const attemptedUrls = diagnostics.attemptedUrls ?? [];
  const discoveredCandidates = diagnostics.discoveredCandidates ?? [];
  const rejectedLinks = diagnostics.rejectedLinks ?? [];
  const documentCandidates = diagnostics.documentCandidates ?? [];
  if (!attemptedUrls.length && !discoveredCandidates.length && !rejectedLinks.length && !documentCandidates.length) {
    return undefined;
  }

  const acceptedDocumentCandidates = documentCandidates.filter((candidate) => candidate.status === "accepted");
  const rejectedDocumentCandidates = documentCandidates.filter((candidate) => candidate.status === "rejected");
  return {
    attempted: attemptedUrls.length,
    discovered: discoveredCandidates.length,
    rejected: rejectedLinks.length,
    documentCandidatesAccepted: acceptedDocumentCandidates.length,
    documentCandidatesRejected: rejectedDocumentCandidates.length,
    attemptedUrls: attemptedUrls.slice(0, 12),
    topCandidates: discoveredCandidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((candidate) => `${candidate.url}: score ${candidate.score}${candidate.reason ? ` (${candidate.reason})` : ""}`)
      .slice(0, 8),
    rejectedLinks: rejectedLinks
      .map((link) => `${link.url}: ${link.reason}${typeof link.score === "number" ? ` (score ${link.score})` : ""}`)
      .slice(0, 8),
    rejectedDocuments: rejectedDocumentCandidates
      .map((candidate) => {
        const label = candidate.label || candidate.type || candidate.url;
        return `${label}: ${candidate.reason}`;
      })
      .slice(0, 8)
  };
}

function evaluateCustomFields(
  result: ProductResult,
  defs: CustomCoverageField[]
): RunItemCustomCoverageResult[] {
  if (!defs.length) return [];
  return defs
    .filter((def) => def.id && def.label && def.pattern)
    .map((def) => {
      const regex = compileCustomFieldRegex(def.pattern);
      // A `null` regex means the user typed an invalid pattern — we surface the field as
      // "missing" rather than silently dropping it, so they notice and fix the recipe.
      const match = regex
        ? result.attributes.find((attr) => regex.test(attr.name) && attr.value && attr.value.trim().length > 0)
        : undefined;
      return {
        id: def.id,
        label: def.label,
        state: (match ? "present" : "missing") as RunCoverageState,
        ...(match ? { matchedValue: match.value } : {})
      };
    });
}

function compileCustomFieldRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return undefined;
  }
}

function coverageState(result: ProductResult, field: RunCoverageField): RunCoverageState {
  if (hasCoverageValue(result, field)) return "present";
  if (field === "deUrl" && isGermanUrlNotApplicable(result)) return "not-applicable";
  if (field === "voltage" || field === "current") {
    const classification = classifyDeviceType(result);
    if (!requiredElectricalFields(result, {
      deviceType: classification.type,
      deviceTypeConfidence: classification.confidence,
      deviceTypeElectricalFields: electricalFieldsForDeviceType(classification.type)
    }).includes(field)) return "not-applicable";
  }
  return "missing";
}

function hasCoverageValue(result: ProductResult, field: RunCoverageField): boolean {
  switch (field) {
    case "enUrl":
      return Boolean(result.localizedUrls?.en || result.productUrl);
    case "deUrl":
      return hasDistinctGermanUrl(result);
    case "image":
      return result.documents.some(
        (doc) => doc.type === "image" && Boolean(doc.localPath || doc.downloadStatus === "downloaded" || doc.downloadStatus === undefined)
      );
    case "weight":
      return Boolean(result.normalized.weight);
    case "certificates":
      return Boolean(result.normalized.certificates);
    case "dimensions":
      return Boolean(result.normalized.dimensions);
    case "material":
      return Boolean(result.normalized.material);
    case "voltage":
      return Boolean(result.normalized.voltage);
    case "current":
      return Boolean(result.normalized.current);
  }
}

function itemReason(
  item: RunItemRecord,
  criticalMissing: RunCoverageField[],
  customFields: RunItemCustomCoverageResult[]
): string {
  const result = item.result;
  if (!result) return item.stageMessage ?? item.error ?? "";
  const missingCustom = customFields.filter((field) => field.state === "missing").map((field) => field.label);
  if (criticalMissing.length || missingCustom.length) {
    const all = [...criticalMissing.map(coverageLabel), ...missingCustom];
    return `Missing ${all.join(", ")}`;
  }
  if (result.qualityGate?.passed) return "quality ok";
  if (result.qualityGate?.missing.length) return result.qualityGate.missing.slice(0, 4).join("; ");
  return result.error ?? item.error ?? result.qualityGate?.reason ?? "";
}

function coverageLabel(field: RunCoverageField): string {
  switch (field) {
    case "enUrl":
      return "EN link";
    case "deUrl":
      return "DE link";
    case "image":
      return "Images";
    case "weight":
      return "Weight";
    case "certificates":
      return "Certificates";
    case "dimensions":
      return "Dimensions";
    case "material":
      return "Material";
    case "voltage":
      return "Voltage";
    case "current":
      return "Current";
  }
}

function hasDistinctGermanUrl(result: ProductResult): boolean {
  const germanUrl = result.localizedUrls?.de;
  if (!germanUrl) return false;
  return ![result.localizedUrls?.en, result.productUrl]
    .filter((url): url is string => Boolean(url))
    .some((url) => sameUrl(url, germanUrl));
}

function isGermanUrlNotApplicable(result: ProductResult): boolean {
  if (result.manufacturerId === "sce") return true;
  const germanUrl = result.localizedUrls?.de;
  return Boolean(
    germanUrl &&
      [result.localizedUrls?.en, result.productUrl]
        .filter((url): url is string => Boolean(url))
        .some((url) => sameUrl(url, germanUrl))
  );
}

