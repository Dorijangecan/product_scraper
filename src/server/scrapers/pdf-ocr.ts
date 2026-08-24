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
  /** Per-page OCR is retained so a partly scanned PDF need not discard its native text pages. */
  pages?: PdfOcrPageResult[];
  /** Mean Tesseract page confidence when the JS worker supplied it (0–100). */
  confidence?: number;
  quality?: OcrTextQuality;
  error?: string;
}

export interface PdfOcrPageResult {
  num: number;
  text: string;
  confidence?: number;
  /** OCR line baselines in y-up coordinates, ready for the shared positioned-table reader. */
  positionedItems?: OcrPositionedItem[];
  quality?: OcrTextQuality;
}

export interface OcrBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLineWithBox {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
}

export interface OcrPositionedItem {
  text: string;
  x: number;
  y: number;
  confidence: number;
}

export interface OcrTextQuality {
  accepted: boolean;
  score: number;
  reasons: string[];
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
const jsOcrWorkersByLanguage = new Map<string, Promise<TesseractWorker[]>>();
let activeJsOcrCalls = 0;

function isMissingBinaryError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not recognized|no such file|command not found|cannot find/i.test(message);
}

export async function readPdfWithOptionalOcr(
  filePath: string,
  options: { maxPages?: number; pageNumbers?: number[]; language?: string } = {}
): Promise<PdfOcrResult> {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 12, 30));
  const pageNumbers = normalizePageNumbers(options.pageNumbers, maxPages);
  const language = normalizeOcrLanguage(options.language);
  if (!externalOcrToolsUnavailableReason) {
    const external = await readPdfWithExternalOcrTools(filePath, maxPages, pageNumbers, language);
    if (external) return withOcrQuality(external);
  }
  return withOcrQuality(await readPdfWithJsOcr(filePath, maxPages, pageNumbers, language));
}

/**
 * Uses only readable native PDF context to pick an installed Tesseract language for sparse pages.
 * A fully scanned document has no trustworthy language evidence, so it deliberately stays on the
 * universal English model instead of guessing a language from product numbers or OCR noise.
 */
export function inferOcrLanguage(text: string): "eng" | "deu" | "fra" | "ita" | "spa" {
  const normalized = ` ${text.toLocaleLowerCase()} `;
  const scores: Array<["deu" | "fra" | "ita" | "spa", number]> = [
    ["deu", countLanguageSignals(normalized, [/\btechnische\s+daten\b/g, /\bbemessungs\w*/g, /\bnennspannung\b/g, /\bschutzart\b/g])],
    ["fra", countLanguageSignals(normalized, [/\bcaract[eé]ristiques?\b/g, /\btension\s+nominale\b/g, /\bcourant\s+assign[eé]\b/g, /\bindice\s+de\s+protection\b/g])],
    ["ita", countLanguageSignals(normalized, [/\bdati\s+tecnici\b/g, /\btensione\s+nominale\b/g, /\bcorrente\s+nominale\b/g, /\bgrado\s+di\s+protezione\b/g])],
    ["spa", countLanguageSignals(normalized, [/\bdatos\s+t[eé]cnicos\b/g, /\btensi[oó]n\s+nominal\b/g, /\bcorriente\s+nominal\b/g, /\bgrado\s+de\s+protecci[oó]n\b/g])]
  ];
  const [language, score] = scores.reduce((best, candidate) => candidate[1] > best[1] ? candidate : best, ["deu", 0]);
  // Signals must be language-specific technical phrases; generic words such as “temperature” are
  // shared by English/French and previously sent an English Saginaw manual through French OCR.
  // Two independent specific labels are enough for a real localized datasheet.
  return score >= 2 ? language : "eng";
}

/** Pages whose native text is too sparse/noisy to be trustworthy candidates for text mining. */
export function pdfPagesNeedingOcr(pages: Array<{ num: number; text: string }>): number[] {
  return pages.filter((page) => {
    const text = page.text.trim();
    const compact = text.replace(/\s/g, "");
    const readable = (compact.match(/[\p{L}\p{N}]/gu) ?? []).length;
    const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
    return text.length < 40 || words.length < 5 || (compact.length > 0 && readable / compact.length < 0.55);
  }).map((page) => page.num);
}

function normalizePageNumbers(pageNumbers: number[] | undefined, maxPages: number): number[] {
  const cleaned = [...new Set((pageNumbers ?? Array.from({ length: maxPages }, (_, index) => index + 1))
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= maxPages))].sort((left, right) => left - right);
  return cleaned.length ? cleaned : [1];
}

/** Conservative text-level last line of defence when a renderer cannot provide per-word boxes.
 * A short run of OCR glyph noise must not become a plausible-looking electrical value downstream.
 * When Tesseract supplies confidence, low-confidence text is rejected even if it happens to have
 * enough letters and digits; native CLI OCR still receives the structural text checks. */
export function assessOcrTextQuality(text: string, confidence?: number): OcrTextQuality {
  const trimmed = text.trim();
  const printable = trimmed.replace(/\s/g, "");
  const alphaNumeric = (printable.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const alphaNumericRatio = printable.length ? alphaNumeric / printable.length : 0;
  const words = trimmed.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
  const reasons: string[] = [];
  if (trimmed.length < 40) reasons.push("OCR text is too short");
  if (words.length < 5) reasons.push("OCR text has too few readable tokens");
  if (alphaNumericRatio < 0.55) reasons.push("OCR text is dominated by symbols");
  if (confidence !== undefined && confidence < 55) reasons.push(`OCR confidence ${Math.round(confidence)} is below 55`);
  const confidenceScore = confidence === undefined ? 20 : Math.max(0, Math.min(30, confidence * 0.3));
  const score = Math.round(Math.min(35, alphaNumericRatio * 35) + Math.min(35, words.length * 3.5) + confidenceScore);
  return { accepted: reasons.length === 0, score, reasons };
}

/**
 * Tesseract's image coordinates grow downward, while pdf-positioned-table uses y-up PDF-style
 * coordinates. Preserve only confident complete lines — individual low-confidence words must not
 * become a plausible SKU or electrical value in a reconstructed table.
 */
export function ocrLinesToPositionedItems(lines: readonly OcrLineWithBox[]): OcrPositionedItem[] {
  return lines.flatMap((line) => {
    const text = line.text.trim();
    if (!text || !Number.isFinite(line.confidence) || line.confidence < 55) return [];
    if (!Number.isFinite(line.bbox.x0) || !Number.isFinite(line.bbox.y0)) return [];
    return [{ text, x: line.bbox.x0, y: -line.bbox.y0, confidence: line.confidence }];
  });
}

function withOcrQuality(result: PdfOcrResult): PdfOcrResult {
  return {
    ...result,
    ...(result.pages ? { pages: result.pages.map((page) => ({ ...page, quality: assessOcrTextQuality(page.text, page.confidence) })) } : {}),
    quality: assessOcrTextQuality(result.text, result.confidence)
  };
}

/**
 * First attempt: shell out to poppler's pdftoppm + the tesseract CLI, unchanged from before this
 * fallback was added. Fastest path when a user already has these installed and on PATH.
 * Returns undefined (not an error result) when the binaries are missing, so the caller falls
 * through to the JS OCR path instead of surfacing a hard failure.
 */
async function readPdfWithExternalOcrTools(
  filePath: string,
  maxPages: number,
  pageNumbers: number[],
  language: string
): Promise<PdfOcrResult | undefined> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "product-scraper-ocr-"));
  try {
    const imagePrefix = path.join(tempDir, "page");
    const firstPage = Math.min(...pageNumbers);
    const lastPage = Math.max(...pageNumbers);
    await execFileAsync("pdftoppm", ["-r", "180", "-png", "-f", String(firstPage), "-l", String(lastPage), filePath, imagePrefix], {
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
      const stdout = await recognizeWithExternalTesseract(imagePath, language);
      return { image, text: stdout.trim() ? stdout : "" };
    });
    const pages = texts.flatMap(({ image, text }) => {
      const num = Number(/(\d+)\.png$/i.exec(image)?.[1]);
      return Number.isFinite(num) && pageNumbers.includes(num) ? [{ num, text }] : [];
    });
    return { text: pages.map((page) => page.text).filter(Boolean).join("\n"), pageCount: pages.length, pages };
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
async function readPdfWithJsOcr(filePath: string, maxPages: number, pageNumbers: number[], language: string): Promise<PdfOcrResult> {
  let parser: InstanceType<typeof PDFParse> | undefined;
  try {
    const data = await fs.readFile(filePath);
    parser = new PDFParse({ data });
    const info = await parser.getInfo();
    const pageCount = Math.min(maxPages, info.total || maxPages);
    const requestedPageNumbers = pageNumbers.filter((page) => page <= pageCount);
    const screenshots = await parser.getScreenshot({
      partial: requestedPageNumbers,
      scale: JS_OCR_RENDER_SCALE,
      imageBuffer: true,
      imageDataUrl: false
    });
    if (!screenshots.pages.length) return { text: "", pageCount: 0, error: "No pages could be rendered for OCR." };

    const workers = await getJsOcrWorkers(language);
    retainOcrWorkers(workers);
    try {
      const texts = await mapWithWorkerPool(screenshots.pages, workers, async (page, worker) => {
        const { data: recognized } = await worker.recognize(Buffer.from(page.data), {}, { blocks: true });
        return {
          text: recognized.text?.trim() ? recognized.text : "",
          confidence: recognized.confidence,
          positionedItems: ocrLinesToPositionedItems(tesseractLines(recognized.blocks))
        };
      });
      const pages = texts.map((result, index) => ({ num: requestedPageNumbers[index] ?? index + 1, ...result }));
      const recognized = pages.filter((result) => result.text);
      const confidences = recognized.map((result) => result.confidence).filter((value): value is number => Number.isFinite(value));
      return {
        text: recognized.map((result) => result.text).join("\n"),
        pageCount: pages.length,
        pages,
        ...(confidences.length ? { confidence: confidences.reduce((sum, value) => sum + value, 0) / confidences.length } : {})
      };
    } finally {
      releaseOcrWorkers(workers);
    }
  } catch (error) {
    return { text: "", pageCount: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

async function getJsOcrWorkers(language: string): Promise<TesseractWorker[]> {
  const existing = jsOcrWorkersByLanguage.get(language);
  if (existing) return existing;
  const workers = (async () => {
      await fs.mkdir(JS_OCR_CACHE_DIR, { recursive: true });
      return Promise.all(
        Array.from({ length: JS_OCR_WORKER_COUNT }, () =>
          Tesseract.createWorker(language, undefined, { cachePath: JS_OCR_CACHE_DIR })
        )
      );
    })();
  jsOcrWorkersByLanguage.set(language, workers);
  try {
    return await workers;
  } catch (error) {
    jsOcrWorkersByLanguage.delete(language);
    // A language pack is an optional optimization. Never lose a scanned page merely because the
    // local Tesseract install only includes English.
    if (language !== "eng") return getJsOcrWorkers("eng");
    throw error;
  }
}

type RefableOcrWorker = { worker?: { ref?: () => void; unref?: () => void } };

function refOcrWorker(value: unknown): void {
  const worker = (value as RefableOcrWorker).worker;
  worker?.ref?.();
}

/** A cached tesseract worker is useful in the server, but must not pin a one-shot CLI after its OCR
 * promise settled. Node's Worker exposes unref; browser-backed worker shims simply omit it. */
export function unrefOcrWorker(value: unknown): void {
  const worker = (value as RefableOcrWorker).worker;
  worker?.unref?.();
}

function retainOcrWorkers(workers: TesseractWorker[]): void {
  activeJsOcrCalls += 1;
  if (activeJsOcrCalls === 1) workers.forEach(refOcrWorker);
}

function releaseOcrWorkers(workers: TesseractWorker[]): void {
  activeJsOcrCalls = Math.max(0, activeJsOcrCalls - 1);
  if (activeJsOcrCalls === 0) workers.forEach(unrefOcrWorker);
}

async function recognizeWithExternalTesseract(imagePath: string, language: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "-l", language, "--psm", "6"], {
      timeout: OCR_TIMEOUT_MS,
      windowsHide: true
    });
    return stdout;
  } catch (error) {
    if (language === "eng" || !isMissingOcrLanguageError(error)) throw error;
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "-l", "eng", "--psm", "6"], {
      timeout: OCR_TIMEOUT_MS,
      windowsHide: true
    });
    return stdout;
  }
}

function normalizeOcrLanguage(value: string | undefined): string {
  return ["eng", "deu", "fra", "ita", "spa"].includes(value ?? "") ? value! : "eng";
}

function isMissingOcrLanguageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed loading language|error opening data file|couldn.t initialize tesseract/i.test(message);
}

function countLanguageSignals(text: string, patterns: RegExp[]): number {
  return patterns.reduce((score, pattern) => score + (text.match(pattern)?.length ?? 0), 0);
}

function tesseractLines(blocks: unknown): OcrLineWithBox[] {
  if (!Array.isArray(blocks)) return [];
  const lines: OcrLineWithBox[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const paragraphs = (block as { paragraphs?: unknown }).paragraphs;
    if (!Array.isArray(paragraphs)) continue;
    for (const paragraph of paragraphs) {
      if (!paragraph || typeof paragraph !== "object") continue;
      const paragraphLines = (paragraph as { lines?: unknown }).lines;
      if (!Array.isArray(paragraphLines)) continue;
      for (const line of paragraphLines) {
        if (!line || typeof line !== "object") continue;
        const candidate = line as Partial<OcrLineWithBox>;
        if (typeof candidate.text !== "string" || typeof candidate.confidence !== "number" || !candidate.bbox) continue;
        lines.push({ text: candidate.text, confidence: candidate.confidence, bbox: candidate.bbox });
      }
    }
  }
  return lines;
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
