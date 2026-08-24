import type { TargetHealthRecord } from "../../shared/types.js";

export const DRIFT_SAMPLE_MINIMUM = 8;
export const CATASTROPHIC_BOOTSTRAP_SAMPLE_MINIMUM = 3;

/**
 * A small new-vendor bootstrap, intentionally much stricter than normal drift detection.
 * It only reacts to repeated total failure, never to an ordinary mixed onboarding sample.
 */
export function isCatastrophicTargetHealthBootstrap(health: Pick<TargetHealthRecord, "sampleCount" | "successRate" | "avgQualityScore">): boolean {
  return health.sampleCount >= CATASTROPHIC_BOOTSTRAP_SAMPLE_MINIMUM &&
    health.sampleCount < DRIFT_SAMPLE_MINIMUM &&
    health.successRate === 0 &&
    (health.avgQualityScore ?? 0) <= 0;
}

export function isTargetHealthDriftSuspected(health: Pick<TargetHealthRecord, "sampleCount" | "successRate" | "avgQualityScore">): boolean {
  if (isCatastrophicTargetHealthBootstrap(health)) return true;
  return health.sampleCount >= DRIFT_SAMPLE_MINIMUM &&
    (health.successRate < 0.45 || (health.avgQualityScore ?? 100) < 45);
}
