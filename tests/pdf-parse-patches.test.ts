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
 *
 * The PDF lives in `fixtures/_assets/` (committed). It used to be read out of `benchmarks/output/`,
 * which is gitignored — so this canary silently failed for anyone who cloned the repo, i.e. exactly
 * the people who needed to know the patch was missing.
 */
describe("pdf-parse patches", () => {
  it("getTable() does not throw on a real PDF with an incomplete vector grid", async () => {
    const fixturePath = path.resolve("fixtures", "_assets", "sce-incomplete-vector-grid.pdf");
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
