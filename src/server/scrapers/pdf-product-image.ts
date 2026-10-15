import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import type { DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";

const ETA_PRODUCT_PAGE = /^https:\/\/(?:global\.|www\.)?e-t-a\.com\/products\/.+\/p\/[^/]+\/?$/i;
const ETA_PRODUCT_PDF = /^https:\/\/(?:global\.|www\.)?e-t-a\.com\/fileadmin\/.+\.pdf(?:[?#]|$)/i;
const SCREENSHOT_SCALE = 2;

/**
 * Some exact E-T-A PDPs expose only a sibling image, while their linked exact datasheet contains
 * an embedded product photo. If no usable PDP image exists, extract the largest embedded raster
 * image from page 1 only when that page itself names the requested catalog number.
 */
export async function extractEtaProductImageFromExactDatasheet(
  result: ProductResult,
  imagesDir: string
): Promise<ProductResult> {
  if (result.manufacturerId !== "eta" || result.documents.some((document) => document.type === "image")) return result;

  const candidate = result.documents.find((document) =>
    (document.type === "datasheet" || document.type === "manual") &&
    Boolean(document.localPath) &&
    ETA_PRODUCT_PAGE.test(document.sourceUrl ?? "") &&
    ETA_PRODUCT_PDF.test(document.url)
  );
  if (!candidate?.localPath) return result;

  try {
    const pdfBytes = await fs.readFile(candidate.localPath);
    const pdfParser = new PDFParse({ data: pdfBytes });
    let screenshotBytes: Buffer | undefined;
    let pdfjsDocument: Awaited<ReturnType<Awaited<ReturnType<typeof importPdfJs>>["getDocument"]>["promise"]> | undefined;
    try {
      const textResult = await pdfParser.getText({ partial: [1] });
      const firstPageText = textResult.pages[0]?.text ?? "";
      if (!containsExactCatalogNumber(firstPageText, result.catalogNumber)) return result;

      const screenshots = await pdfParser.getScreenshot({
        partial: [1],
        scale: SCREENSHOT_SCALE,
        imageBuffer: true,
        imageDataUrl: false
      });
      const screenshot = screenshots.pages[0];
      if (!screenshot?.data) return result;
      screenshotBytes = Buffer.from(screenshot.data);

      const pdfjs = await importPdfJs();
      pdfjsDocument = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes), verbosity: 0 }).promise;
      const page = await pdfjsDocument.getPage(1);
      const viewport = page.getViewport({ scale: SCREENSHOT_SCALE });
      const operatorList = await page.getOperatorList();
      const imageBounds = largestEmbeddedImageBounds(pdfjs.OPS, operatorList, viewport.transform);
      if (!imageBounds) return result;

      const meta = await sharp(screenshotBytes).metadata();
      if (!meta.width || !meta.height) return result;
      const left = Math.max(0, Math.floor(imageBounds.left));
      const top = Math.max(0, Math.floor(imageBounds.top));
      const right = Math.min(meta.width, Math.ceil(imageBounds.right));
      const bottom = Math.min(meta.height, Math.ceil(imageBounds.bottom));
      const width = right - left;
      const height = bottom - top;
      if (width < 80 || height < 60 || width * height < 10_000) return result;

      await fs.mkdir(imagesDir, { recursive: true });
      const imagePath = path.join(imagesDir, `${safeFilePart(result.catalogNumber)}.datasheet-page-1.png`);
      await sharp(screenshotBytes).extract({ left, top, width, height }).png().toFile(imagePath);

      const imageDocument: DocumentRecord = {
        type: "image",
        label: "Product photo from exact datasheet (page 1)",
        url: `${candidate.url}#page=1`,
        sourceUrl: candidate.url,
        sourceType: "generated",
        parser: "pdf-product-image-extractor",
        stage: "document-enrichment",
        confidence: 0.9,
        localPath: imagePath,
        downloadStatus: "downloaded"
      };
      const source: SourceRecord = {
        url: candidate.url,
        sourceType: "generated",
        parser: "pdf-product-image-extractor",
        stage: "document-enrichment",
        reason: `Page 1 contains the exact catalog number ${result.catalogNumber}; the image is the largest embedded raster on that page.`,
        fetchedAt: new Date().toISOString()
      };

      return {
        ...result,
        documents: [...result.documents, imageDocument],
        sources: [...result.sources, source]
      };
    } finally {
      await pdfParser.destroy();
      await pdfjsDocument?.destroy();
    }
  } catch {
    // An absent or unsupported embedded image is a missing image, never a reason to lose the
    // already verified exact product result and datasheet.
    return result;
  }
}

function containsExactCatalogNumber(text: string, catalogNumber: string): boolean {
  const compactText = compact(text);
  const compactSku = compact(catalogNumber);
  return compactSku.length >= 4 && compactText.includes(compactSku);
}

function compact(value: string): string {
  return value.normalize("NFKC").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function safeFilePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "product";
}

async function importPdfJs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

type PdfJsModule = Awaited<ReturnType<typeof importPdfJs>>;

function largestEmbeddedImageBounds(
  ops: PdfJsModule["OPS"],
  operatorList: { fnArray: number[]; argsArray: unknown[][] },
  viewportTransform: number[]
): { left: number; top: number; right: number; bottom: number } | undefined {
  let transform = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const candidates: Array<{ left: number; top: number; right: number; bottom: number; area: number }> = [];

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operator = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (operator === ops.save) {
      stack.push([...transform]);
      continue;
    }
    if (operator === ops.restore) {
      transform = stack.pop() ?? transform;
      continue;
    }
    if (operator === ops.transform) {
      const next = args.map(Number).slice(0, 6);
      if (next.length === 6 && next.every(Number.isFinite)) {
        transform = multiplyTransforms(transform, next);
      }
      continue;
    }
    if (operator !== ops.paintImageXObject) continue;

    const viewportMatrix = multiplyTransforms(viewportTransform, transform);
    const points = [
      applyTransform(viewportMatrix, 0, 0),
      applyTransform(viewportMatrix, 1, 0),
      applyTransform(viewportMatrix, 0, 1),
      applyTransform(viewportMatrix, 1, 1)
    ];
    const left = Math.min(...points.map(([x]) => x));
    const top = Math.min(...points.map(([, y]) => y));
    const right = Math.max(...points.map(([x]) => x));
    const bottom = Math.max(...points.map(([, y]) => y));
    const width = right - left;
    const height = bottom - top;
    const area = width * height;
    if (width >= 80 && height >= 60 && area >= 10_000 && Number.isFinite(area)) {
      candidates.push({ left, top, right, bottom, area });
    }
  }

  return candidates.sort((left, right) => right.area - left.area)[0];
}

function multiplyTransforms(left: number[], right: number[]): number[] {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [a! * g! + c! * h!, b! * g! + d! * h!, a! * i! + c! * j!, b! * i! + d! * j!, a! * k! + c! * l! + e!, b! * k! + d! * l! + f!];
}

function applyTransform(matrix: number[], x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = matrix;
  return [a! * x + c! * y + e!, b! * x + d! * y + f!];
}
