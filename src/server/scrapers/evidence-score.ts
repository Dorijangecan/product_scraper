import type { SourceRecord } from "../../shared/types.js";

export type EvidenceTier = "official-document" | "official-page" | "official-fallback" | "generated" | "cache" | "distributor";

/** Classify source provenance before applying small extractor-specific refinements. */
export function evidenceTier(input: Pick<Parameters<typeof evidenceConfidence>[0], "sourceType" | "parser" | "stage">): EvidenceTier {
  const source = input.sourceType ?? "generated";
  const parser = `${input.parser ?? ""} ${input.stage ?? ""}`.toLowerCase();
  if (source === "official" && /pdf|document|datasheet|manual/.test(parser)) return "official-document";
  if (source === "official") return "official-page";
  if (source === "official-fallback") return "official-fallback";
  if (source === "cache") return "cache";
  if (source === "distributor") return "distributor";
  return "generated";
}

/** One comparable 0..1 confidence for source-backed facts. Explicit extractor confidence refines
 * source trust but cannot let a distributor outrank an official source. Field-specific label/value
 * fitness remains at its caller; this module answers only “how trustworthy is this evidence?”. */
export function evidenceConfidence(input: {
  sourceType?: SourceRecord["sourceType"];
  parser?: string;
  stage?: string;
  confidence?: number;
}): number {
  const source = input.sourceType ?? "generated";
  const parser = `${input.parser ?? ""} ${input.stage ?? ""}`.toLowerCase();
  const tier = evidenceTier(input);
  let score = tier === "official-document" ? 0.92 : tier === "official-page" ? 0.82 : tier === "official-fallback" ? 0.72 : tier === "generated" ? 0.58 : tier === "cache" ? 0.45 : 0.25;
  if (source === "official-fallback" && /browser-network|api|json/.test(parser)) score += 0.05;
  if (/catalog variant|exact.*catalog/.test(parser)) score += 0.06;
  if (/meta|structured data/.test(parser)) score -= 0.03;
  if (input.confidence !== undefined && Number.isFinite(input.confidence)) score += (Math.max(0, Math.min(1, input.confidence)) - 0.5) * 0.12;
  return Math.max(0, Math.min(1, score));
}
