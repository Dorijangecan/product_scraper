import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PDFParse } from "pdf-parse";
import Tesseract from "tesseract.js";

const execFileAsync = promisify(execFile);
const OCR_TIMEOUT_MS = 120000;
const OCR_PAGE_CONCURRENCY = 4;
const JS_OCR_WORKER_COUNT = 2;
// PDF units are 72 DPI at scale 1, so 2.5 matches the native path's `pdftoppm -r 180` (180/72),
// keeping OCR input resolution consistent regardless of which path actually ran.
const JS_OCR_RENDER_SCALE = 2.5;
// tesseract.js defaults to caching downloaded trained-data in process.cwd() (the project root
// for this app) when no cachePath is given. Point it at a stable per-user directory instead so
// repeated OCR runs don't drop `eng.traineddata` next to the source tree.
const JS_OCR_CACHE_DIR = path.join(os.homedir(), ".product-scraper", "ocr-cache");

export interface PdfOcrResult {
  text: string;
  pageCount: number;
  error?: string;
}

type TesseractWorker = Awaited<ReturnType<typeof Tesseract.createWorker>>;

/**
 * Negative cache: once we learn pdftoppm or tesseract isn't installed we stop re-attempting
 * the (futile) spawn for every subsequent PDF in the run and go straight to the JS OCR fallback.
 * Reset implicitly per process start.
 */
let externalOcrToolsUnavailableReason: string | undefined;

// Lazily created once per process and reused across every OCR call — worker startup (loading the
// WASM core + trained data) costs roughly a second, not worth paying per document.
let jsOcrWorkersPromise: Promise<TesseractWorker[]> | undefined;

function isMissingBinaryError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not recognized|no such file|command not found|cannot find/i.test(message);
}

export async function readPdfWithOptionalOcr(filePath: string, options: { maxPages?: number } = {}): Promise<PdfOcrResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 12, 30));
  if (!externalOcrToolsUnavailableReason) {
    const external = await readPdfWithExternalOcrTools(filePath, maxPages);
    if (external) return external;
  }
  return readPdfWithJsOcr(filePath, maxPages);
}

/**
 * First attempt: shell out to poppler's pdftoppm + the tesseract CLI, unchanged from before this
 * fallback was added. Fastest path when a user already has these installed and on PATH.
 * Returns undefined (not an error result) when the binaries are missing, so the caller falls
 * through to the JS OCR path instead of surfacing a hard failure.
 */
async function readPdfWithExternalOcrTools(filePath: string, maxPages: number): Promise<PdfOcrResult | undefined> {
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
      externalOcrToolsUnavailableReason =
        "pdftoppm/tesseract nisu na PATH-u — koristi se ugrađeni JS OCR fallback (tesseract.js).";
      return undefined;
    }
    return { text: "", pageCount: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Fallback when poppler/tesseract aren't installed: rasterize pages with pdf-parse's own
 * getScreenshot() (uses the @napi-rs/canvas dependency pdf-parse already bundles — no external
 * binary needed) and OCR each rendered page with tesseract.js (pure JS/WASM). Slower than the
 * native CLI path, but works out of the box on any machine with no OCR tools installed.
 */
async function readPdfWithJsOcr(filePath: string, maxPages: number): Promise<PdfOcrResult> {
  let parser: InstanceType<typeof PDFParse> | undefined;
  try {
    const data = await fs.readFile(filePath);
    parser = new PDFParse({ data });
    const info = await parser.getInfo();
    const pageCount = Math.min(maxPages, info.total || maxPages);
    const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
    const screenshots = await parser.getScreenshot({
      partial: pageNumbers,
      scale: JS_OCR_RENDER_SCALE,
      imageBuffer: true,
      imageDataUrl: false
    });
    if (!screenshots.pages.length) return { text: "", pageCount: 0, error: "No pages could be rendered for OCR." };

    const workers = await getJsOcrWorkers();
    const texts = await mapWithWorkerPool(screenshots.pages, workers, async (page, worker) => {
      const { data: recognized } = await worker.recognize(Buffer.from(page.data));
      return recognized.text?.trim() ? recognized.text : "";
    });
    return { text: texts.filter(Boolean).join("\n"), pageCount: screenshots.pages.length };
  } catch (error) {
    return { text: "", pageCount: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

async function getJsOcrWorkers(): Promise<TesseractWorker[]> {
  if (!jsOcrWorkersPromise) {
    jsOcrWorkersPromise = (async () => {
      await fs.mkdir(JS_OCR_CACHE_DIR, { recursive: true });
      return Promise.all(
        Array.from({ length: JS_OCR_WORKER_COUNT }, () =>
          Tesseract.createWorker("eng", undefined, { cachePath: JS_OCR_CACHE_DIR })
        )
      );
    })().catch((error) => {
      jsOcrWorkersPromise = undefined;
      throw error;
    });
  }
  return jsOcrWorkersPromise;
}

/** Like mapWithConcurrency, but pins each item to one of a fixed set of stateful workers
 * (a Tesseract worker processes jobs one at a time, so real parallelism needs separate workers,
 * not just concurrent calls into the same one). */
async function mapWithWorkerPool<T, W, R>(items: T[], workers: W[], fn: (item: T, worker: W) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const lanes = workers.map(async (worker) => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], worker);
    }
  });
  await Promise.all(lanes);
  return results;
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
