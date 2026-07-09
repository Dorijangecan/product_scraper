import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPdfWithOptionalOcr } from "../src/server/scrapers/pdf-ocr.js";

describe("readPdfWithOptionalOcr", () => {
  // This exercises whichever OCR path is actually available on the machine running the test:
  // the native pdftoppm+tesseract CLI when installed, or the tesseract.js/getScreenshot()
  // fallback otherwise (this repo's dev machine has neither binary installed, so running this
  // suite here specifically covers the fallback). Both must produce real recognized text — the
  // point of the fallback is that OCR works either way, without requiring any install.
  it(
    "produces recognizable text from a real PDF page (native OCR tools if installed, JS fallback otherwise)",
    async () => {
      const fixturePath = path.resolve("benchmarks", "live-check", "nvent-docs", "spec-00583.pdf");
      const result = await readPdfWithOptionalOcr(fixturePath, { maxPages: 1 });

      expect(result.error).toBeUndefined();
      expect(result.pageCount).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(50);
    },
    60_000
  );

  it("returns a diagnostic error instead of throwing for a file that can't be read", async () => {
    const result = await readPdfWithOptionalOcr("D:/does-not-exist/nothing.pdf", { maxPages: 1 });

    expect(result.text).toBe("");
    expect(result.pageCount).toBe(0);
    expect(result.error).toBeTruthy();
  });
});
