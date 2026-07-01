import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OCR_TIMEOUT_MS = 120000;
const OCR_PAGE_CONCURRENCY = 4;

export interface PdfOcrResult {
  text: string;
  pageCount: number;
  error?: string;
}

/**
 * Negative cache: once we learn pdftoppm or tesseract isn't installed we stop re-attempting
 * the (futile) spawn for every subsequent PDF in the run and return a single clear diagnostic.
 * Reset implicitly per process start.
 */
let ocrToolsUnavailableReason: string | undefined;

function isMissingBinaryError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not recognized|no such file|command not found|cannot find/i.test(message);
}

export async function readPdfWithOptionalOcr(filePath: string, options: { maxPages?: number } = {}): Promise<PdfOcrResult> {
  if (ocrToolsUnavailableReason) {
    return { text: "", pageCount: 0, error: ocrToolsUnavailableReason };
  }
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 12, 30));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "product-scraper-ocr-"));
  try {
    const imagePrefix = path.join(tempDir, "page");
    await execFileAsync("pdftoppm", ["-r", "180", "-png", "-f", "1", "-l", String(maxPages), filePath, imagePrefix], {
      timeout: OCR_TIMEOUT_MS,
      windowsHide: true
    });
    const images = (await fs.readdir(tempDir))
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    // OCR each rendered page concurrently (bounded) — tesseract is single-threaded per call,
    // so running a few pages in parallel cuts wall-clock on multi-page datasheets sharply.
    const texts = await mapWithConcurrency(images, OCR_PAGE_CONCURRENCY, async (image) => {
      const imagePath = path.join(tempDir, image);
      const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "--psm", "6"], {
        timeout: OCR_TIMEOUT_MS,
        windowsHide: true
      });
      return stdout.trim() ? stdout : "";
    });
    return { text: texts.filter(Boolean).join("\n"), pageCount: images.length };
  } catch (error) {
    if (isMissingBinaryError(error)) {
      ocrToolsUnavailableReason =
        "OCR alati (pdftoppm/poppler i tesseract) nisu instalirani ili nisu na PATH-u — OCR preskočen za sve PDF-ove u ovom runu.";
      return { text: "", pageCount: 0, error: ocrToolsUnavailableReason };
    }
    return {
      text: "",
      pageCount: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(Math.max(1, limit), items.length || 1)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
