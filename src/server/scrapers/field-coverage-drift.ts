/**
 * Shape-level drift detection: compares this run's per-field fill rate against a rolling baseline
 * of the same manufacturer's recent completed runs. A per-item quality gate only ever sees ONE run
 * at a time, so a site redesign that silently breaks extraction for a whole field (parser targets a
 * selector/column that moved) looks, from inside a single run, like "these products just don't
 * publish that field" — indistinguishable from normal variation without something to compare against.
 *
 * Deliberately conservative: needs a real historical baseline (>= MIN_BASELINE_RUNS runs with a
 * usable sample size) and only flags a field that was previously well-populated
 * (>= MIN_BASELINE_FILL_RATE) and has now dropped by a wide margin. A field that was always sparse,
 * or a run too small to mean anything, produces no flags — silence over a shaky guess.
 */
import type { FieldCoverageMatrixRow, ProductResult } from "../../shared/types.js";

export type TrackedCoverageField =
  | "image"
  | "weight"
  | "dimensions"
  | "material"
  | "certificates"
  | "voltage"
  | "current"
  | "color"
  | "protection"
  | "operatingTemperature";

export const TRACKED_COVERAGE_FIELDS: TrackedCoverageField[] = [
  "image",
  "weight",
  "dimensions",
  "material",
  "certificates",
  "voltage",
  "current",
  "color",
  "protection",
  "operatingTemperature"
];

function fieldIsPresent(result: ProductResult, field: TrackedCoverageField): boolean {
  if (field === "image") return result.documents.some((doc) => doc.type === "image" && Boolean(doc.url || doc.localPath));
  if (field === "operatingTemperature") return Boolean(result.normalized.operatingTemperatureMin || result.normalized.operatingTemperatureMax);
  return Boolean(result.normalized[field]);
}

export interface FieldCoverageSnapshot {
  fillRate: Record<TrackedCoverageField, number>;
  sampleSize: number;
}

export function fieldCoverageSnapshot(results: ProductResult[]): FieldCoverageSnapshot {
  const fillRate = {} as Record<TrackedCoverageField, number>;
  for (const field of TRACKED_COVERAGE_FIELDS) {
    fillRate[field] = results.length ? results.filter((result) => fieldIsPresent(result, field)).length / results.length : 0;
  }
  return { fillRate, sampleSize: results.length };
}

export interface FieldCoverageDriftFlag {
  field: TrackedCoverageField;
  currentFillRate: number;
  baselineFillRate: number;
  baselineRunCount: number;
  reason: string;
}

const MIN_CURRENT_SAMPLE_SIZE = 3;
const MIN_BASELINE_SAMPLE_SIZE = 3;
const MIN_BASELINE_RUNS = 2;
const MIN_BASELINE_FILL_RATE = 0.3;
const MIN_DROP = 0.25;

/**
 * `historical` should be recent completed runs for the SAME manufacturer, most-recent-first or in
 * any order — every run is weighted equally regardless of order. Runs with too few items to trust
 * are excluded from the baseline rather than diluting it.
 */
export function detectFieldCoverageDrift(current: FieldCoverageSnapshot, historical: FieldCoverageSnapshot[]): FieldCoverageDriftFlag[] {
  const usableHistory = historical.filter((run) => run.sampleSize >= MIN_BASELINE_SAMPLE_SIZE);
  if (current.sampleSize < MIN_CURRENT_SAMPLE_SIZE || usableHistory.length < MIN_BASELINE_RUNS) return [];

  const flags: FieldCoverageDriftFlag[] = [];
  for (const field of TRACKED_COVERAGE_FIELDS) {
    const baselineFillRate = usableHistory.reduce((sum, run) => sum + run.fillRate[field], 0) / usableHistory.length;
    if (baselineFillRate < MIN_BASELINE_FILL_RATE) continue;
    const currentFillRate = current.fillRate[field];
    if (baselineFillRate - currentFillRate < MIN_DROP) continue;
    flags.push({
      field,
      currentFillRate,
      baselineFillRate,
      baselineRunCount: usableHistory.length,
      reason: `${field} coverage dropped to ${Math.round(currentFillRate * 100)}% from a ${usableHistory.length}-run baseline of ${Math.round(baselineFillRate * 100)}% for this manufacturer — check whether the site changed before assuming products stopped publishing it`
    });
  }
  return flags;
}

/**
 * One row of the cross-manufacturer field-coverage health matrix (see `run-manager.ts`
 * `buildFieldCoverageMatrix` for the DB-querying caller): `current` is the manufacturer's most
 * recent completed run, `historical` the completed runs immediately before it. Reuses
 * `detectFieldCoverageDrift` for which fields to flag so the matrix and the per-run Excel warning
 * agree on the same thresholds.
 */
export function buildFieldCoverageMatrixRow(
  manufacturerId: string,
  canonicalName: string,
  lastRunId: string,
  lastRunAt: string,
  current: FieldCoverageSnapshot,
  historical: FieldCoverageSnapshot[]
): FieldCoverageMatrixRow {
  const usableHistory = historical.filter((run) => run.sampleSize >= MIN_BASELINE_SAMPLE_SIZE);
  const baselineFillRate = {} as Record<TrackedCoverageField, number>;
  for (const field of TRACKED_COVERAGE_FIELDS) {
    baselineFillRate[field] = usableHistory.length ? usableHistory.reduce((sum, run) => sum + run.fillRate[field], 0) / usableHistory.length : 0;
  }
  return {
    manufacturerId,
    canonicalName,
    lastRunId,
    lastRunAt,
    sampleSize: current.sampleSize,
    baselineRunCount: usableHistory.length,
    fillRate: current.fillRate,
    baselineFillRate,
    driftFields: detectFieldCoverageDrift(current, historical).map((flag) => flag.field)
  };
}
