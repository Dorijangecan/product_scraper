import type { RunItemRecord } from "./types.js";

export interface RunDiagnosticSummary {
  fieldBlockers: Array<{ reasonCode: string; count: number }>;
  documents: { parsed: number; skipped: number; failed: number };
  discovery: { attempted: number; discovered: number; rejected: number; rejectedDocuments: number };
}

/** Compact, deterministic run-level view built solely from the existing item summary payload. */
export function summarizeRunDiagnostics(items: ReadonlyArray<Pick<RunItemRecord, "coverage">>): RunDiagnosticSummary {
  const blockerCounts = new Map<string, number>();
  const documents = { parsed: 0, skipped: 0, failed: 0 };
  const discovery = { attempted: 0, discovered: 0, rejected: 0, rejectedDocuments: 0 };
  for (const item of items) {
    for (const [reasonCode, count] of Object.entries(item.coverage?.fieldHealth?.reasonCodes ?? {})) {
      blockerCounts.set(reasonCode, (blockerCounts.get(reasonCode) ?? 0) + (count ?? 0));
    }
    const documentProcessing = item.coverage?.documentProcessing;
    if (documentProcessing) {
      documents.parsed += documentProcessing.parsed;
      documents.skipped += documentProcessing.skipped;
      documents.failed += documentProcessing.failed;
    }
    const itemDiscovery = item.coverage?.discovery;
    if (itemDiscovery) {
      discovery.attempted += itemDiscovery.attempted;
      discovery.discovered += itemDiscovery.discovered;
      discovery.rejected += itemDiscovery.rejected;
      discovery.rejectedDocuments += itemDiscovery.documentCandidatesRejected;
    }
  }
  return {
    fieldBlockers: [...blockerCounts.entries()]
      .filter(([, count]) => count > 0)
      .map(([reasonCode, count]) => ({ reasonCode, count }))
      .sort((left, right) => right.count - left.count || left.reasonCode.localeCompare(right.reasonCode)),
    documents,
    discovery
  };
}
