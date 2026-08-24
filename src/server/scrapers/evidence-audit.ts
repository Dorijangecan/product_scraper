import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { sameUrlOriginAndPath } from "../url-util.js";
import { evidenceConfidence, evidenceTier, type EvidenceTier } from "./evidence-score.js";

export interface EvidenceAuditRecord {
  kind: "attribute" | "document" | "source";
  name: string;
  sourceType: SourceRecord["sourceType"] | "generated";
  parser?: string;
  stage?: string;
  tier: EvidenceTier;
  score: number;
  provenance: "direct" | "inferred" | "defaulted";
}

export interface EvidenceAuditIssue {
  kind: "unresolved-source-url" | "raw-confidence-out-of-range" | "source-without-type";
  kindOfEvidence: EvidenceAuditRecord["kind"];
  name: string;
  detail: string;
}

export interface EvidenceAuditResult {
  records: EvidenceAuditRecord[];
  issues: EvidenceAuditIssue[];
  provenance: Record<EvidenceAuditRecord["provenance"], number>;
  tiers: Record<EvidenceTier, number>;
}

type AuditedItem = Pick<AttributeRecord, "name" | "sourceUrl" | "sourceType" | "parser" | "stage" | "confidence">
  | Pick<DocumentRecord, "label" | "sourceUrl" | "url" | "sourceType" | "parser" | "stage" | "confidence">
  | Pick<SourceRecord, "parser" | "url" | "sourceType" | "stage">;

/**
 * Audits a persisted connector result using the same provenance derivation that attachEvidence
 * uses. It deliberately does not judge whether a fact is semantically correct: this detector
 * proves that every emitted fact has a comparable evidence tier before field arbitration begins.
 */
export function auditResultEvidence(result: Pick<ProductResult, "attributes" | "documents" | "sources">): EvidenceAuditResult {
  const records: EvidenceAuditRecord[] = [];
  const issues: EvidenceAuditIssue[] = [];
  const provenance: EvidenceAuditResult["provenance"] = { direct: 0, inferred: 0, defaulted: 0 };
  const tiers: EvidenceAuditResult["tiers"] = {
    "official-document": 0,
    "official-page": 0,
    "official-fallback": 0,
    generated: 0,
    cache: 0,
    distributor: 0
  };

  for (const attribute of result.attributes) addItem("attribute", attribute.name, attribute, attribute.sourceUrl);
  for (const document of result.documents) addItem("document", document.label, document, document.sourceUrl ?? document.url);
  for (const source of result.sources) addItem("source", source.parser, source, source.url);

  return { records, issues, provenance, tiers };

  function addItem(kind: EvidenceAuditRecord["kind"], name: string, item: AuditedItem, sourceUrl: string | undefined): void {
    const directSourceType = item.sourceType;
    // A document's URL is evidence in its own right. Older persisted runs occasionally kept the
    // product-view referrer in `sourceUrl` while their `url` and SourceRecord correctly identify
    // the downloaded datasheet; attributes do not get this fallback because their value belongs to
    // the explicit page/source URL only.
    const documentUrl = kind === "document" && "url" in item ? item.url : undefined;
    const matchedSource = directSourceType
      ? undefined
      : sourceForUrl(result.sources, sourceUrl) ?? sourceForUrl(result.sources, documentUrl);
    const sourceType = directSourceType ?? matchedSource?.sourceType ?? "generated";
    const parser = item.parser ?? matchedSource?.parser;
    const stage = item.stage ?? matchedSource?.stage;
    const itemProvenance: EvidenceAuditRecord["provenance"] = directSourceType
      ? "direct"
      : matchedSource
        ? "inferred"
        : "defaulted";

    if (kind !== "source" && sourceUrl && !directSourceType && !matchedSource) {
      issues.push({
        kind: "unresolved-source-url",
        kindOfEvidence: kind,
        name,
        detail: `No source record matches ${sourceUrl}`
      });
    }
    if (kind === "source" && !directSourceType) {
      issues.push({ kind: "source-without-type", kindOfEvidence: kind, name, detail: "Source record has no sourceType." });
    }
    if ("confidence" in item && item.confidence !== undefined && (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)) {
      issues.push({
        kind: "raw-confidence-out-of-range",
        kindOfEvidence: kind,
        name,
        detail: `Raw confidence ${String(item.confidence)} is outside 0..1.`
      });
    }

    const tier = evidenceTier({ sourceType, parser, stage });
    records.push({
      kind,
      name,
      sourceType,
      parser,
      stage,
      tier,
      score: evidenceConfidence({ sourceType, parser, stage, confidence: "confidence" in item ? item.confidence : undefined }),
      provenance: itemProvenance
    });
    provenance[itemProvenance] += 1;
    tiers[tier] += 1;
  }
}

function sourceForUrl(sources: SourceRecord[], sourceUrl: string | undefined): SourceRecord | undefined {
  if (!sourceUrl) return undefined;
  return sources.find((source) => source.url === sourceUrl) ?? sources.find((source) => sameUrlOriginAndPath(source.url, sourceUrl));
}
