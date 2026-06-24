import { describe, expect, it } from "vitest";
import { summarizeRunItem } from "../src/server/run-item-summary.js";
import type { RunItemRecord } from "../src/shared/types.js";

describe("run item summaries", () => {
  it("strips heavy result payload while preserving coverage signals", () => {
    const summary = summarizeRunItem({
      id: 1,
      runId: "run-1",
      rowIndex: 1,
      catalogNumber: "ABC-123",
      status: "partial",
      updatedAt: "2026-05-24T00:00:00.000Z",
      result: {
        manufacturerId: "test",
        catalogNumber: "ABC-123",
        status: "partial",
        confidence: 0.6,
        productUrl: "https://example.test/products/ABC-123",
        normalized: { weight: "1 kg", dimensions: "10 x 20 x 30 mm", material: "steel" },
        attributes: [{ name: "Material", value: "steel" }],
        documents: [{ type: "image", label: "Product image", url: "https://example.test/ABC-123.png", downloadStatus: "failed" }],
        sources: [{ url: "https://example.test/products/ABC-123", sourceType: "official", parser: "fixture", fetchedAt: "2026-05-24T00:00:00.000Z" }],
        qualityGate: {
          passed: false,
          identityConfirmed: true,
          score: 65,
          missing: ["document:datasheet"],
          reason: "Missing datasheet.",
          attempts: []
        },
        diagnostics: {
          attemptedUrls: [
            "https://example.test/products/ABC-123",
            "https://example.test/search?q=ABC-123"
          ],
          discoveredCandidates: [
            {
              url: "https://example.test/nonstandard/detail/ABC-123",
              score: 92,
              reason: "manufacturer search result matched catalog",
              stage: "manufacturer-search"
            },
            {
              url: "https://example.test/products/ABC-123",
              score: 75,
              reason: "template URL fetched",
              stage: "template"
            }
          ],
          rejectedLinks: [
            {
              url: "https://example.test/support",
              score: 12,
              reason: "catalog number not present"
            }
          ],
          documentCandidates: [
            {
              url: "https://example.test/ABC-123.pdf?download=1",
              label: "Datasheet",
              type: "datasheet",
              status: "accepted",
              reason: "Recognized product document link.",
              sourceUrl: "https://example.test/products/ABC-123"
            },
            {
              url: "https://example.test/privacy.pdf",
              label: "Privacy policy",
              type: "other",
              status: "rejected",
              reason: "Rejected unrelated policy/legal document.",
              sourceUrl: "https://example.test/products/ABC-123"
            }
          ],
          documentProcessing: [
            {
              url: "https://example.test/ABC-123.pdf",
              label: "Datasheet",
              type: "datasheet",
              action: "parsed",
              stage: "downloaded-document-enrichment",
              reason: "extracted text from downloaded PDF"
            },
            {
              url: "https://example.test/manual",
              label: "Manual",
              type: "manual",
              action: "skipped",
              stage: "remote-document-enrichment",
              reason: "download disabled"
            },
            {
              url: "https://example.test/broken.pdf",
              label: "Broken datasheet",
              type: "datasheet",
              action: "failed",
              stage: "downloaded-document-enrichment",
              reason: "parser failed",
              parseError: "bad xref"
            }
          ],
          fieldHealth: [
            { field: "weight", label: "Weight", status: "found", value: "1 kg" },
            { field: "material", label: "Material", status: "conflicting", value: "steel" },
            { field: "voltage", label: "Voltage", status: "low-confidence", value: "24 V" },
            { field: "current", label: "Current", status: "missing" }
          ]
        }
      }
    } satisfies RunItemRecord);

    expect(summary.result).toBeUndefined();
    expect(summary.coverage?.fields.image).toBe("missing");
    expect(summary.coverage?.fields.weight).toBe("present");
    expect(summary.coverage?.criticalMissing).toContain("image");
    expect(summary.coverage?.reason).toContain("Images");
    expect(summary.coverage?.fieldHealth).toMatchObject({
      found: 1,
      missing: 1,
      lowConfidence: 1,
      conflicting: 1,
      reviewFields: ["Material", "Voltage", "Current"]
    });
    expect(summary.coverage?.documentProcessing).toMatchObject({
      parsed: 1,
      skipped: 1,
      failed: 1,
      reviewDocuments: ["Manual: skipped (download disabled)", "Broken datasheet: failed (parser failed)"]
    });
    expect(summary.coverage?.discovery).toMatchObject({
      attempted: 2,
      discovered: 2,
      rejected: 1,
      documentCandidatesAccepted: 1,
      documentCandidatesRejected: 1,
      attemptedUrls: ["https://example.test/products/ABC-123", "https://example.test/search?q=ABC-123"],
      topCandidates: [
        "https://example.test/nonstandard/detail/ABC-123: score 92 (manufacturer search result matched catalog)",
        "https://example.test/products/ABC-123: score 75 (template URL fetched)"
      ],
      rejectedLinks: ["https://example.test/support: catalog number not present (score 12)"],
      rejectedDocuments: ["Privacy policy: Rejected unrelated policy/legal document."]
    });
  });

  it("marks image coverage not applicable when image downloads are disabled", () => {
    const summary = summarizeRunItem(
      {
        id: 2,
        runId: "run-2",
        rowIndex: 1,
        catalogNumber: "SCE-N68C4018",
        status: "partial",
        updatedAt: "2026-06-23T00:00:00.000Z",
        result: {
          manufacturerId: "sce",
          catalogNumber: "SCE-N68C4018",
          status: "partial",
          confidence: 0.7,
          normalized: { weight: "348 lb", dimensions: "68 x 40 x 18 in", material: "carbon steel" },
          attributes: [],
          documents: [],
          sources: []
        }
      } satisfies RunItemRecord,
      { includeImages: false }
    );

    expect(summary.coverage?.fields.image).toBe("not-applicable");
    expect(summary.coverage?.criticalMissing).not.toContain("image");
    expect(summary.coverage?.reason).not.toContain("Images");
  });
});
