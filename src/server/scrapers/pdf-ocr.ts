import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OCR_TIMEOUT_MS = 120000;

export interface PdfOcrResult {
  text: string;
  pageCount: number;
  error?: string;
}

export async function readPdfWithOptionalOcr(filePath: string, options: { maxPages?: number } = {}): Promise<PdfOcrResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 6, 20));
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
    const texts: string[] = [];
    for (const image of images) {
      const imagePath = path.join(tempDir, image);
      const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "--psm", "6"], {
        timeout: OCR_TIMEOUT_MS,
        windowsHide: true
      });
      if (stdout.trim()) texts.push(stdout);
    }
    return { text: texts.join("\n"), pageCount: images.length };
  } catch (error) {
    return {
      text: "",
      pageCount: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
