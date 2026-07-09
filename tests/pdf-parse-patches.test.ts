import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PDFParse } from "pdf-parse";

/**
 * Canary for patches/pdf-parse+2.4.5.patch. Upstream pdf-parse's getTable() can throw
 * "Cannot read properties of undefined (reading 'from')" when a page's vector-drawn lines form
 * an incomplete/malformed grid (Table.getRow() indexes hLines[-1] without checking for it) — see
 * the patch for the root cause and fix. If this test ever fails, either the patch stopped being
 * applied (check `npm run postinstall` / `patches/`) or a pdf-parse upgrade changed this code path
 * and the patch needs to be regenerated against the new version.
 */
describe("pdf-parse patches", () => {
  it("getTable() does not throw on a real PDF with an incomplete vector grid", async () => {
    const fixturePath = path.resolve(
      "benchmarks",
      "output",
      "20260529115444",
      "documents",
      "SCE-12EL1206LP-manual-Sub-Plate-Layout-&-Grounding-for-3-8-16.pdf"
    );
    const data = await fs.readFile(fixturePath);
    const parser = new PDFParse({ data });
    try {
      const parsed = await parser.getText({ first: 5 });
      const result = await parser.getTable({ partial: parsed.pages.map((page) => page.num) });
      expect(result).toBeDefined();
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  });
});
