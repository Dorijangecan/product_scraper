import type { ProductResult, ScrapeAttemptRecord } from "../../shared/types.js";
import type { ScrapeContext } from "./types.js";

export function recordTargetObservation(
  context: ScrapeContext,
  result: ProductResult,
  input: { stage: string; startedAt?: number; error?: string }
) {
  const host = hostFromResult(result);
  const status: ScrapeAttemptRecord["status"] = result.qualityGate?.passed
    ? "passed"
    : result.status === "failed"
      ? "failed"
      : "partial";
  context.targetHealth?.record({
    manufacturerId: context.manufacturer.id,
    host,
    stage: input.stage,
    status,
    qualityScore: result.qualityGate?.score,
    attributeCount: result.attributes.length,
    documentCount: result.documents.length,
    elapsedMs: input.startedAt ? Date.now() - input.startedAt : undefined,
    error: input.error ?? result.error
  });
}

function hostFromResult(result: ProductResult): string | undefined {
  const url = result.productUrl ?? result.sources[0]?.url;
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}
