/**
 * Cross-record statistical outlier detection within one run.
 *
 * Every existing quality check (quality-gate.ts, spec-plausibility.ts, evidence.ts) judges a value
 * in isolation: does THIS number look like a plausible weight/voltage/current. That structurally
 * cannot catch a value that looks perfectly plausible on its own but is wrong relative to its own
 * siblings — e.g. one row's weight is 100x the rest of the same device-type family in the same run,
 * the classic signature of cross-model table contamination, a wrong PDF column, or a unit mix-up.
 * A batch scrape of one manufacturer's product family is exactly the context that makes this catchable
 * (a generic single-page scraper never sees the sibling rows to compare against).
 *
 * Flags for human review only — never mutates, rejects, or blanks a value. "Silence beats wrong
 * data" (the project's own deterministic principle) applies here too: a flag with a weak statistical
 * basis is worse than no flag, so every code path below prefers not flagging over a shaky guess.
 */
import type { ProductResult } from "../../shared/types.js";
import { classifyDeviceType } from "./device-type.js";
import { parseQuantities } from "./quantity.js";
import { POUND_TO_KILOGRAM, OUNCE_TO_KILOGRAM } from "../unit-conversion.js";

export type CohortAnomalyField = "weight" | "voltage" | "current" | "operatingTemperatureMin" | "operatingTemperatureMax";

export interface CohortAnomalyFlag {
  catalogNumber: string;
  field: CohortAnomalyField;
  value: number;
  unit: string;
  cohortMedian: number;
  cohortSize: number;
  /** MAD-based robust z-score, or (for cohorts too small/uniform for MAD) the value/median ratio. */
  robustZScore: number;
  deviceType: string;
  reason: string;
}

const MASS_SCALE_TO_KG: Record<string, number> = { kg: 1, g: 0.001, mg: 0.000001, lb: POUND_TO_KILOGRAM, oz: OUNCE_TO_KILOGRAM };
// SI prefix scaling only (k/m) — unambiguous, unlike the imperial factors in unit-conversion.ts
// which needed a single source of truth after a historical truncation bug.
const ELECTRICAL_SCALE: Record<string, number> = { v: 1, kv: 1000, mv: 0.001, a: 1, ka: 1000, ma: 0.001 };

function firstQuantityValue(text: string | undefined, kind: "mass" | "voltage" | "current" | "temperature"): { value: number; unit?: string } | undefined {
  if (!text) return undefined;
  const [quantity] = parseQuantities(text, { kind });
  if (!quantity) return undefined;
  const value = quantity.value ?? quantity.min ?? quantity.values?.[0];
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return { value, unit: quantity.unit };
}

function scaledValue(parsed: { value: number; unit?: string } | undefined, scale: Record<string, number>): number | undefined {
  if (!parsed?.unit) return undefined;
  const factor = scale[parsed.unit.toLowerCase()];
  return factor === undefined ? undefined : parsed.value * factor;
}

interface FieldConfig {
  extract: (result: ProductResult) => number | undefined;
  unit: string;
  /** Ratio-based small-cohort fallback only makes sense for fields that are always > 0. */
  strictlyPositive: boolean;
}

const FIELD_CONFIGS: Record<CohortAnomalyField, FieldConfig> = {
  weight: {
    extract: (result) => scaledValue(firstQuantityValue(result.normalized.weight, "mass"), MASS_SCALE_TO_KG),
    unit: "kg",
    strictlyPositive: true
  },
  voltage: {
    extract: (result) => scaledValue(firstQuantityValue(result.normalized.voltage, "voltage"), ELECTRICAL_SCALE),
    unit: "V",
    strictlyPositive: true
  },
  current: {
    extract: (result) => scaledValue(firstQuantityValue(result.normalized.current, "current"), ELECTRICAL_SCALE),
    unit: "A",
    strictlyPositive: true
  },
  operatingTemperatureMin: {
    extract: (result) => firstQuantityValue(result.normalized.operatingTemperatureMin, "temperature")?.value,
    unit: "°C",
    strictlyPositive: false
  },
  operatingTemperatureMax: {
    extract: (result) => firstQuantityValue(result.normalized.operatingTemperatureMax, "temperature")?.value,
    unit: "°C",
    strictlyPositive: false
  }
};

const MIN_ENTRIES_TO_CONSIDER = 3;
const MIN_ENTRIES_FOR_MAD = 8;
const MAD_Z_THRESHOLD = 3.5;
const ORDER_OF_MAGNITUDE_RATIO = 10;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface CohortEntry {
  catalogNumber: string;
  value: number;
}

function orderOfMagnitudeFallback(entries: CohortEntry[], med: number): Array<CohortEntry & { score: number }> {
  if (med <= 0) return [];
  return entries
    .filter((entry) => entry.value / med >= ORDER_OF_MAGNITUDE_RATIO || entry.value / med <= 1 / ORDER_OF_MAGNITUDE_RATIO)
    .map((entry) => ({ ...entry, score: entry.value / med }));
}

/**
 * MAD (median absolute deviation) robust z-score: `(x - median) / (1.4826 * MAD)`. Unlike a
 * mean/stdev z-score, MAD has a 50% breakdown point — a single contaminated value can't drag the
 * cohort's own threshold along with it the way it drags a mean. 1.4826 is the constant that makes
 * MAD a consistent estimator of standard deviation under normality (Iglewicz & Hoaglin).
 *
 * Below `MIN_ENTRIES_FOR_MAD` samples, or when MAD is 0 (every value identical, or one dominant
 * repeated rating in the family), the estimator isn't trustworthy — fall back to a coarse
 * order-of-magnitude check for strictly-positive fields, or skip flagging entirely otherwise.
 */
function cohortAnomalies(entries: CohortEntry[], strictlyPositive: boolean): Array<CohortEntry & { score: number }> {
  const values = entries.map((entry) => entry.value);
  const med = median(values);

  if (entries.length < MIN_ENTRIES_FOR_MAD) {
    return strictlyPositive ? orderOfMagnitudeFallback(entries, med) : [];
  }

  const mad = median(values.map((value) => Math.abs(value - med)));
  if (mad === 0) {
    return strictlyPositive ? orderOfMagnitudeFallback(entries, med) : [];
  }

  return entries
    .map((entry) => ({ ...entry, score: (entry.value - med) / (1.4826 * mad) }))
    .filter((entry) => Math.abs(entry.score) >= MAD_Z_THRESHOLD);
}

/**
 * Groups a run's results by device type (the natural "family" boundary already computed
 * elsewhere in the pipeline) and flags per-field outliers within each group. Pure/offline —
 * no I/O, safe to call at run finalization over the run's own in-memory or freshly-loaded results.
 */
export function detectCohortAnomalies(results: ProductResult[]): CohortAnomalyFlag[] {
  const byDeviceType = new Map<string, ProductResult[]>();
  for (const result of results) {
    const deviceType = classifyDeviceType(result).type ?? "Unclassified";
    const bucket = byDeviceType.get(deviceType);
    if (bucket) bucket.push(result);
    else byDeviceType.set(deviceType, [result]);
  }

  const flags: CohortAnomalyFlag[] = [];
  for (const [deviceType, cohort] of byDeviceType) {
    for (const field of Object.keys(FIELD_CONFIGS) as CohortAnomalyField[]) {
      const config = FIELD_CONFIGS[field];
      const entries = cohort
        .map((result) => ({ catalogNumber: result.catalogNumber, value: config.extract(result) }))
        .filter((entry): entry is CohortEntry => entry.value !== undefined && Number.isFinite(entry.value) && (!config.strictlyPositive || entry.value > 0));
      if (entries.length < MIN_ENTRIES_TO_CONSIDER) continue;

      const med = median(entries.map((entry) => entry.value));
      for (const anomaly of cohortAnomalies(entries, config.strictlyPositive)) {
        flags.push({
          catalogNumber: anomaly.catalogNumber,
          field,
          value: anomaly.value,
          unit: config.unit,
          cohortMedian: med,
          cohortSize: entries.length,
          robustZScore: anomaly.score,
          deviceType,
          reason: `${field} (${anomaly.value} ${config.unit}) is far from this run's ${deviceType} cohort median (${med} ${config.unit}, n=${entries.length})`
        });
      }
    }
  }
  return flags;
}
