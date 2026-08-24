import type { DriftDiagnostic, ProductResult, TargetHealthRecord } from "../../shared/types.js";
import type { ScrapeContext } from "./types.js";
import { CATASTROPHIC_BOOTSTRAP_SAMPLE_MINIMUM, DRIFT_SAMPLE_MINIMUM, isCatastrophicTargetHealthBootstrap, isTargetHealthDriftSuspected } from "./target-health-policy.js";

export interface AdaptiveMiningDecision {
  shouldMine: boolean;
  reason: string;
  drift?: DriftDiagnostic;
}

export function shouldRunAdaptiveMining(result: ProductResult, context: ScrapeContext): AdaptiveMiningDecision {
  if (context.imageOnly) {
    return { shouldMine: false, reason: "Skipped adaptive mining in images-only fast path." };
  }
  const health = context.targetHealth?.get(context.manufacturer.id, "official-source");
  const drift = driftFromTargetHealth(health);
  if (drift.suspected) {
    return { shouldMine: true, reason: drift.reason, drift };
  }
  if (!result.qualityGate?.passed) {
    return { shouldMine: true, reason: result.qualityGate?.reason ?? "Quality gate did not pass." };
  }
  if ((result.qualityGate?.score ?? 100) < 82) {
    return { shouldMine: true, reason: `Quality score ${result.qualityGate?.score} is below adaptive mining threshold.` };
  }
  if (result.attributes.length < 4) {
    return { shouldMine: true, reason: "Low attribute yield from primary scrape." };
  }
  if (!result.documents.some((document) => document.type === "image" || document.type === "datasheet")) {
    return { shouldMine: true, reason: "Primary scrape found no product image or datasheet candidate." };
  }
  return { shouldMine: false, reason: "Primary scrape is healthy enough; adaptive mining not needed." };
}

export function driftFromTargetHealth(health: TargetHealthRecord | undefined): DriftDiagnostic {
  if (!health || health.sampleCount < CATASTROPHIC_BOOTSTRAP_SAMPLE_MINIMUM) {
    return {
      suspected: false,
      reason: "Not enough target health samples for drift detection.",
      manufacturerId: health?.manufacturerId,
      stage: health?.stage
    };
  }
  // A new vendor should not have to fail eight complete items before the adaptive path is allowed
  // to investigate. This deliberately catches only an unambiguous outage: three or more attempts
  // with no confirmed success and no usable quality. Mixed early data remains below the normal
  // statistical threshold, so a single imperfect onboarding run cannot manufacture drift.
  if (isCatastrophicTargetHealthBootstrap(health)) {
    return {
      suspected: true,
      reason: `Target health bootstrap: ${health.sampleCount} consecutive outcomes had no success or usable quality.`,
      manufacturerId: health.manufacturerId,
      stage: health.stage,
      successRate: health.successRate,
      avgQualityScore: health.avgQualityScore
    };
  }
  if (health.sampleCount < DRIFT_SAMPLE_MINIMUM) {
    return {
      suspected: false,
      reason: "Not enough target health samples for drift detection.",
      manufacturerId: health.manufacturerId,
      stage: health.stage
    };
  }
  const suspected = isTargetHealthDriftSuspected(health);
  return {
    suspected,
    reason: suspected
      ? `Target health degraded: success ${(health.successRate * 100).toFixed(0)}%, average quality ${Math.round(health.avgQualityScore ?? 0)}.`
      : "Target health is within expected bounds.",
    manufacturerId: health.manufacturerId,
    stage: health.stage,
    successRate: health.successRate,
    avgQualityScore: health.avgQualityScore
  };
}
