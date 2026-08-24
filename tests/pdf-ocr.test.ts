import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assessOcrTextQuality, inferOcrLanguage, ocrLinesToPositionedItems, pdfPagesNeedingOcr, readPdfWithOptionalOcr, unrefOcrWorker } from "../src/server/scrapers/pdf-ocr.js";

describe("readPdfWithOptionalOcr", () => {
  it("does not let an idle reusable OCR worker keep a one-shot process alive", () => {
    const unref = vi.fn();
    unrefOcrWorker({ worker: { unref } } as never);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("accepts readable technical OCR text but rejects symbol garbage before spec mining", () => {
    expect(assessOcrTextQuality("Rated current 16 A\nOperating voltage 24 V DC\nWeight 1.25 kg", 91).accepted).toBe(true);
    expect(assessOcrTextQuality("| | | 8B O0 lI @@ ## %%%", 32).accepted).toBe(false);
  });

  it("selects only sparse or glyph-noisy native pages for a partial OCR pass", () => {
    expect(pdfPagesNeedingOcr([
      { num: 1, text: "Rated current 16 A\nOperating voltage 24 V DC\nWeight 1.25 kg" },
      { num: 2, text: "" },
      { num: 3, text: "| | %% ##" }
    ])).toEqual([2, 3]);
  });

  it("selects an OCR language only from readable document context and falls back to English for ambiguous text", () => {
    expect(inferOcrLanguage("Technische Daten\nBemessungsstrom 16 A\nNennspannung 24 V")).toBe("deu");
    expect(inferOcrLanguage("Caractéristiques techniques\nTension nominale 24 V\nCourant assigné 16 A")).toBe("fra");
    expect(inferOcrLanguage("Technische Daten\nSpannung 24 V")).toBe("eng");
    expect(inferOcrLanguage("Operating Temperature\nAmbient temperature\nInternal temperature")).toBe("eng");
    expect(inferOcrLanguage("16 A\n24 V\nIP65")).toBe("eng");
  });

  it("turns confident OCR line boxes into the existing reader's y-up positioned items", () => {
    expect(ocrLinesToPositionedItems([
      { text: "Catalog Number", confidence: 92, bbox: { x0: 15, y0: 20, x1: 130, y1: 38 } },
      { text: "ABC-123", confidence: 88, bbox: { x0: 160, y0: 20, x1: 230, y1: 38 } },
      { text: "Weight", confidence: 91, bbox: { x0: 15, y0: 72, x1: 80, y1: 90 } },
      { text: "1.2 kg", confidence: 90, bbox: { x0: 160, y0: 72, x1: 215, y1: 90 } },
      { text: "noise", confidence: 31, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }
    ])).toEqual([
      { text: "Catalog Number", x: 15, y: -20, confidence: 92 },
      { text: "ABC-123", x: 160, y: -20, confidence: 88 },
      { text: "Weight", x: 15, y: -72, confidence: 91 },
      { text: "1.2 kg", x: 160, y: -72, confidence: 90 }
    ]);
  });

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
