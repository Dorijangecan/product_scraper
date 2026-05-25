import type { ProductResult, RunCoverageField, RunCoverageState, RunItemCoverageSummary, RunItemRecord } from "../shared/types.js";
import { requiredElectricalFields } from "../shared/product-requirements.js";

const CRITICAL_FIELDS: RunCoverageField[] = ["image", "weight", "dimensions", "material", "voltage", "current"];

export function summarizeRunItem(item: RunItemRecord): RunItemRecord {
  if (!item.result) return item;
  return {
    ...item,
    coverage: buildCoverageSummary(item),
    result: undefined
  };
}

function buildCoverageSummary(item: RunItemRecord): RunItemCoverageSummary {
  const result = item.result!;
  const fields: Partial<Record<RunCoverageField, RunCoverageState>> = {
    enUrl: coverageState(result, "enUrl"),
    deUrl: coverageState(result, "deUrl"),
    image: coverageState(result, "image"),
    weight: coverageState(result, "weight"),
    certificates: coverageState(result, "certificates"),
    dimensions: coverageState(result, "dimensions"),
    material: coverageState(result, "material"),
    voltage: coverageState(result, "voltage"),
    current: coverageState(result, "current")
  };
  const criticalMissing = CRITICAL_FIELDS.filter((field) => fields[field] === "missing");
  return {
    fields,
    criticalMissing,
    reason: itemReason(item, criticalMissing),
    qualityPassed: result.qualityGate?.passed,
    qualityMissing: result.qualityGate?.missing ?? [],
    finalCompletenessAfterMissing: result.diagnostics?.finalCompleteness?.afterMissing,
    attributeCount: result.attributes.length,
    documentCount: result.documents.length,
    evidenceCount: result.evidence?.length ?? 0
  };
}

function coverageState(result: ProductResult, field: RunCoverageField): RunCoverageState {
  if (hasCoverageValue(result, field)) return "present";
  if (field === "deUrl" && isGermanUrlNotApplicable(result)) return "not-applicable";
  if ((field === "voltage" || field === "current") && !requiredElectricalFields(result).includes(field)) return "not-applicable";
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

function itemReason(item: RunItemRecord, criticalMissing: RunCoverageField[]): string {
  const result = item.result;
  if (!result) return item.stageMessage ?? item.error ?? "";
  if (criticalMissing.length) return `Missing ${criticalMissing.map(coverageLabel).join(", ")}`;
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

function sameUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin.toLowerCase() === rightUrl.origin.toLowerCase() &&
      leftUrl.pathname.replace(/\/+$/, "").toLowerCase() === rightUrl.pathname.replace(/\/+$/, "").toLowerCase() &&
      leftUrl.searchParams.toString() === rightUrl.searchParams.toString()
    );
  } catch {
    return left.replace(/\/+$/, "").toLowerCase() === right.replace(/\/+$/, "").toLowerCase();
  }
}
