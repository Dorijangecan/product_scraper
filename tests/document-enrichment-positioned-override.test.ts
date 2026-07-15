import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProductResult } from "../src/shared/types.js";

// This suite mocks `pdf-parse` and the positioned-table reader in isolation from the rest of
// document-enrichment.test.ts (which relies on REAL pdf-parse output against a real fixture PDF) —
// vi.mock is file-scoped, so keeping it in its own file avoids breaking those other tests.

const FIXTURE_TEXT = [
  "1606-XLS Switched Mode Power Supply Specifications",
  "Catalog Number\tCAT-A\tCAT-B\tCAT-C\tCAT-D\tCAT-E",
  "Output Voltage, Nom\t12V\t24V\t24V\t24V\t24V",
  // 5 catalog columns, only 4 value cells: CAT-B and CAT-C happen to share the identical reading
  // and print as ONE merged cell (exactly the Rockwell 1606-td002 pattern already fixed for
  // Weight/Dimensions/Voltage/Current — this reproduces the SAME shift for a non-electrical row).
  // Naive left-to-right cell counting hands CAT-D the cell that actually belongs to CAT-E.
  "Efficiency, Typ\t90.0%\t92.0%\t93.0%\t94.0%",
  "DC OK Relay Contact\tYes\tYes\tYes\tYes\tYes"
].join("\n");

vi.mock("pdf-parse", () => {
  class PDFParse {
    async getText(options: { partial?: number[]; first?: number } = {}) {
      if (options.partial) {
        return { pages: [{ num: options.partial[0], text: options.partial[0] === 1 ? FIXTURE_TEXT : "" }], total: 1 };
      }
      return { text: FIXTURE_TEXT, pages: [{ num: 1, text: FIXTURE_TEXT }], total: 1 };
    }
    async getTable() {
      return { mergedTables: [] };
    }
    async destroy() {
      return undefined;
    }
  }
  return { PDFParse };
});

vi.mock("../src/server/scrapers/pdf-positioned-table.js", () => ({
  extractPositionedTableRowsFromPdf: async (_data: Uint8Array, catalogNumber: string) => {
    // Simulates the pdfjs-dist x-position-clustering reader correctly resolving CAT-D's own
    // column even though the linear text merged it with a neighbor for the Efficiency row.
    if (catalogNumber === "CAT-D") return { "Efficiency, Typ": "93.0%" };
    // Simulates a shared column (several sibling catalogs genuinely printed in ONE physical PDF
    // column, e.g. Rockwell's 1606-XLE120E/-EC/-EL/-EH/-ED) where a footnote-qualified row lists
    // EACH sibling's own distinct reading stacked in the same column — this reader has no way to
    // tell which footnoted fragment belongs to THIS specific catalog, so it reads back as one
    // value with a repeated catalog-prefix word. Weight is a normal single clean reading from the
    // same column (verified correct live for this exact table shape).
    if (catalogNumber === "CAT-FOOTNOTE") {
      return {
        Weight: "440 g (0.97 lb)",
        "DC Input Voltage": "— (-CAT-FOOTNOTE, -CAT-OTHER) DC 110…150V (-CAT-THIRD)"
      };
    }
    return undefined;
  },
  extractPositionedWeightAndDimensionsFromPdf: async () => undefined
}));

const { enrichResultFromRemoteDocuments } = await import("../src/server/scrapers/document-enrichment.js");

function product(overrides: Partial<ProductResult>): ProductResult {
  return {
    manufacturerId: "test",
    catalogNumber: "CAT-D",
    status: "found",
    confidence: 0.9,
    productUrl: "https://example.test/products/CAT-D",
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    ...overrides
  };
}

describe("extractPositionedWeightDimensionsSafely (non-electrical field override)", () => {
  it("adds the positioned-table's correct reading for a non-electrical field even when a shape-clean but wrong text-derived value already exists", async () => {
    const fixturePath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const result = await enrichResultFromRemoteDocuments(
      product({
        documents: [
          {
            type: "datasheet",
            label: "1606-td002",
            url: "https://example.test/1606-td002.pdf",
            downloadStatus: "skipped",
            downloadError: "PDF downloads disabled for this run."
          }
        ]
      }),
      async () => ({ localPath: fixturePath })
    );

    // The naive text-based reader (buildVariantColumnContext) silently shifted CAT-E's "94.0%"
    // reading onto CAT-D's column — that value alone passes isCleanSingleSpecValue's shape check
    // (single number, no repeated words), so it used to be the ONLY "Efficiency, Typ" candidate:
    // the old code's `!isElectrical && cleanExistingNames.has(...)` skip meant the positioned
    // reader's row was never even added when a same-named clean value already existed.
    expect(result.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "PDF Positioned Table",
          name: "Efficiency, Typ",
          value: "93.0%"
        })
      ])
    );
    // Both candidates now coexist as competing attributes; downstream ranking (bestAttribute in
    // facts.ts, sorting by confidence) must pick the positioned reader's value over the wrong
    // text-derived reading. stampDocumentAttributes (which runs on every document-sourced
    // attribute right before this point, overwriting `parser` to a shared "pdf-table-extractor"
    // label for all of them) has to keep "PDF Positioned Table" attributes at a distinctly higher
    // confidence tier than the generic default for this to work — otherwise both attributes tie at
    // the same flat confidence and whichever was pushed first (always the wrong text-derived one)
    // wins by stable-sort order.
    const efficiencyAttrs = result.attributes.filter((attr) => attr.name === "Efficiency, Typ");
    expect(efficiencyAttrs.length).toBeGreaterThanOrEqual(2);
    const positioned = efficiencyAttrs.find((attr) => attr.group === "PDF Positioned Table");
    const textDerived = efficiencyAttrs.find((attr) => attr.group !== "PDF Positioned Table");
    expect(positioned?.value).toBe("93.0%");
    expect(textDerived?.value).toBe("94.0%");
    expect((positioned?.confidence ?? 0) > (textDerived?.confidence ?? 0)).toBe(true);
  });
});

describe("extractPositionedWeightDimensionsSafely (footnote-garbled shared-column rows)", () => {
  it("keeps a clean single reading from a shared column but drops a footnote-qualified row that concatenates multiple siblings' values", async () => {
    const fixturePath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
    const result = await enrichResultFromRemoteDocuments(
      product({
        catalogNumber: "CAT-FOOTNOTE",
        productUrl: "https://example.test/products/CAT-FOOTNOTE",
        documents: [
          {
            type: "datasheet",
            label: "1606-td002",
            url: "https://example.test/1606-td002.pdf",
            downloadStatus: "skipped",
            downloadError: "PDF downloads disabled for this run."
          }
        ]
      }),
      async () => ({ localPath: fixturePath })
    );

    // Weight reads back as one clean measurement from the shared column (confirmed live: this is
    // exactly how Rockwell's 1606-XLE120E/-EC/-EL/-EH/-ED shared column reads for Weight/
    // Dimensions/Voltage/Current) — it must still be added.
    expect(result.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "PDF Positioned Table", name: "Weight", value: "440 g (0.97 lb)" })
      ])
    );
    // "DC Input Voltage" concatenates THREE siblings' own footnoted readings from the same shared
    // column ("-CAT-FOOTNOTE", "-CAT-OTHER", "-CAT-THIRD" all appear) — this reader can't tell
    // which fragment is actually this catalog's own value, so silence beats guessing: no
    // "PDF Positioned Table" / "DC Input Voltage" attribute should be added at all.
    expect(result.attributes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ group: "PDF Positioned Table", name: "DC Input Voltage" })])
    );
  });
});
