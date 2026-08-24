import { describe, expect, it } from "vitest";
import { summarizeRunDiagnostics } from "../src/shared/run-diagnostics.js";

describe("run diagnostic aggregation", () => {
  it("groups causal field blockers and operational failures across item summaries", () => {
    const summary = summarizeRunDiagnostics([
      { coverage: { fields: {}, criticalMissing: [], fieldHealth: { found: 0, missing: 2, lowConfidence: 0, conflicting: 0, reviewFields: [], reasonCodes: { "document-not-parsed": 2 } }, documentProcessing: { parsed: 0, skipped: 1, failed: 1, reviewDocuments: [] }, discovery: { attempted: 3, discovered: 1, rejected: 2, documentCandidatesAccepted: 0, documentCandidatesRejected: 1, attemptedUrls: [], topCandidates: [], rejectedLinks: [], rejectedDocuments: [] } } },
      { coverage: { fields: {}, criticalMissing: [], fieldHealth: { found: 1, missing: 1, lowConfidence: 0, conflicting: 0, reviewFields: [], reasonCodes: { "no-source-discovered": 1 } }, documentProcessing: { parsed: 1, skipped: 0, failed: 0, reviewDocuments: [] } } }
    ]);

    expect(summary.fieldBlockers).toEqual([
      { reasonCode: "document-not-parsed", count: 2 },
      { reasonCode: "no-source-discovered", count: 1 }
    ]);
    expect(summary.documents).toEqual({ parsed: 1, skipped: 1, failed: 1 });
    expect(summary.discovery).toEqual({ attempted: 3, discovered: 1, rejected: 2, rejectedDocuments: 1 });
  });
});
