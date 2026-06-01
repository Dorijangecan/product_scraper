import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { PDFParse } from "pdf-parse";
import type {
  AttributeRecord,
  CustomerDocumentRecord,
  DocumentRecord,
  ProductResult,
  SourceRecord
} from "../../shared/types.js";
import { catalogTextMatches } from "./catalog-number.js";
import { extractDocumentTextAttributes } from "./document-enrichment.js";
import { cleanText, normalizeFields } from "./normalizer.js";

const MAX_CUSTOMER_PDF_PAGES = 400;
const MAX_CUSTOMER_PDF_TEXT_CHARS = 400_000;
const CUSTOMER_DOC_CONFIDENCE = 0.97;
const TARGETED_NEIGHBOUR_PAGES = 1;
const TARGETED_MAX_SECTION_PAGES = 20;

export type CustomerDocumentProgressEvent =
  | { kind: "start"; documentIndex: number; documentTotal: number; document: CustomerDocumentRecord }
  | { kind: "scan-pdf-page"; document: CustomerDocumentRecord; pageNumber: number; totalPages?: number; matchesSoFar: number }
  | { kind: "matched"; document: CustomerDocumentRecord; attributeCount: number }
  | { kind: "no-match"; document: CustomerDocumentRecord }
  | { kind: "parse-error"; document: CustomerDocumentRecord; message: string };

export type CustomerDocumentProgress = (event: CustomerDocumentProgressEvent) => void;

interface PdfPageEntry {
  num: number;
  text: string;
}

/**
 * Caches the heavy parse work for each customer document so every catalog-number lookup
 * within a run reuses the same parsed pages / rows. PDFs in particular are expensive
 * (one getText call per page) — without caching we re-walk the same 60-page Eaton
 * catalogue once per catalog number.
 */
export class CustomerDocumentParseCache {
  private pdfPages = new Map<string, PdfPageEntry[]>();
  private workbookMatrices = new Map<string, Array<{ sheet: string; rows: string[][] }>>();
  private csvMatrices = new Map<string, string[][]>();

  async getPdfPages(doc: CustomerDocumentRecord): Promise<PdfPageEntry[]> {
    const cached = this.pdfPages.get(doc.storedPath);
    if (cached) return cached;
    const pages = await readAllPdfPages(doc.storedPath);
    this.pdfPages.set(doc.storedPath, pages);
    return pages;
  }

  async getWorkbookMatrices(doc: CustomerDocumentRecord): Promise<Array<{ sheet: string; rows: string[][] }>> {
    const cached = this.workbookMatrices.get(doc.storedPath);
    if (cached) return cached;
    const { default: ExcelJS } = await import("exceljs");
    const buffer = await fs.readFile(doc.storedPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const result: Array<{ sheet: string; rows: string[][] }> = [];
    for (const sheet of workbook.worksheets) {
      const rows: string[][] = [];
      sheet.eachRow((row) => {
        const cells: string[] = [];
        for (let index = 1; index <= row.cellCount; index += 1) {
          cells.push(cellToString(row.getCell(index).value));
        }
        rows.push(cells);
      });
      result.push({ sheet: sheet.name, rows });
    }
    this.workbookMatrices.set(doc.storedPath, result);
    return result;
  }

  async getCsvMatrix(doc: CustomerDocumentRecord): Promise<string[][]> {
    const cached = this.csvMatrices.get(doc.storedPath);
    if (cached) return cached;
    const text = await fs.readFile(doc.storedPath, "utf8");
    const matrix = parse(text, {
      bom: true,
      delimiter: [",", ";", "\t"],
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true
    }) as string[][];
    this.csvMatrices.set(doc.storedPath, matrix);
    return matrix;
  }
}

async function readAllPdfPages(filePath: string): Promise<PdfPageEntry[]> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  const pages: PdfPageEntry[] = [];
  try {
    for (let pageNum = 1; pageNum <= MAX_CUSTOMER_PDF_PAGES; pageNum += 1) {
      let pageResult;
      try {
        pageResult = await parser.getText({ partial: [pageNum] });
      } catch {
        break;
      }
      const pageText = pageResult.pages?.[0]?.text;
      if (typeof pageText !== "string") break;
      pages.push({ num: pageNum, text: pageText });
      if (pageResult.total && pageNum >= pageResult.total) break;
    }
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  return pages;
}

/**
 * Reads every customer-provided document attached to the run and returns the attributes,
 * documents and sources that mention the given catalog number. The caller is expected
 * to splice the result onto the website-scrape so customer data wins normalization.
 *
 * Files that don't mention the catalog number contribute nothing for that product — we
 * don't want random rows from an unrelated section leaking into the output.
 */
export async function extractCustomerDocumentAttributes(
  catalogNumber: string,
  customerDocuments: CustomerDocumentRecord[],
  options: { cache?: CustomerDocumentParseCache; onProgress?: CustomerDocumentProgress } = {}
): Promise<{ attributes: AttributeRecord[]; sources: SourceRecord[]; documents: DocumentRecord[]; parseFailures: string[] }> {
  const cache = options.cache ?? new CustomerDocumentParseCache();
  const onProgress = options.onProgress ?? (() => undefined);
  const attributes: AttributeRecord[] = [];
  const sources: SourceRecord[] = [];
  const documents: DocumentRecord[] = [];
  const parseFailures: string[] = [];

  for (let documentIndex = 0; documentIndex < customerDocuments.length; documentIndex += 1) {
    const doc = customerDocuments[documentIndex];
    if (!doc.storedPath) continue;
    onProgress({ kind: "start", documentIndex, documentTotal: customerDocuments.length, document: doc });
    let extension = path.extname(doc.originalName || doc.storedPath).toLowerCase();
    if (!extension) extension = path.extname(doc.storedPath).toLowerCase();
    const sourceUrl = pathToFileUrl(doc.storedPath);
    try {
      let extracted: AttributeRecord[] = [];
      if (extension === ".pdf") {
        extracted = await extractFromPdf(catalogNumber, doc, cache, onProgress);
      } else if (extension === ".xlsx" || extension === ".xls") {
        extracted = await extractFromWorkbook(catalogNumber, doc, cache);
      } else if (extension === ".csv" || extension === ".tsv" || extension === ".txt") {
        extracted = await extractFromCsv(catalogNumber, doc, cache);
      } else {
        const message = `unsupported file type "${extension || "(unknown)"}"`;
        parseFailures.push(`${doc.originalName}: ${message}`);
        onProgress({ kind: "parse-error", document: doc, message });
        continue;
      }

      if (extracted.length === 0) {
        onProgress({ kind: "no-match", document: doc });
        continue;
      }

      const stamped = stampCustomerAttributes(extracted, sourceUrl);
      attributes.push(...stamped);
      sources.push({
        url: sourceUrl,
        sourceType: "official",
        parser: "customer-document",
        stage: "customer-override",
        reason: doc.originalName,
        fetchedAt: doc.uploadedAt ?? new Date().toISOString()
      });
      documents.push({
        type: customerDocumentType(extension),
        label: `Customer document: ${doc.originalName}`,
        url: sourceUrl,
        localPath: doc.storedPath,
        downloadStatus: "downloaded",
        parseStatus: "parsed",
        sourceUrl,
        sourceType: "official",
        parser: "customer-document",
        stage: "customer-override",
        confidence: CUSTOMER_DOC_CONFIDENCE
      });
      onProgress({ kind: "matched", document: doc, attributeCount: stamped.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Customer document parse failed";
      parseFailures.push(`${doc.originalName}: ${message}`);
      onProgress({ kind: "parse-error", document: doc, message });
    }
  }

  return { attributes, sources, documents, parseFailures };
}

/**
 * Splices customer-document attributes onto the scrape result and re-runs the normalizer
 * so customer data wins for every field it touches. Customer-derived values are placed
 * FIRST in the attribute list, which is what the normalizer's "best attribute" pickers
 * use as a tie-breaker — plus customer attributes carry the highest confidence stamp.
 *
 * Even when the website found nothing (status = "failed"), a populated customer payload
 * is enough to promote the item to "found" / "partial".
 */
export function applyCustomerDocumentOverride(
  result: ProductResult,
  extraction: { attributes: AttributeRecord[]; sources: SourceRecord[]; documents: DocumentRecord[]; parseFailures: string[] }
): ProductResult {
  const hasCustomerData = extraction.attributes.length > 0 || extraction.documents.length > 0;
  if (!hasCustomerData && extraction.parseFailures.length === 0) return result;

  // Customer attributes ride at the front so normalization tie-breaks in their favor.
  const mergedAttributes = hasCustomerData
    ? [...extraction.attributes, ...result.attributes]
    : result.attributes;
  const mergedDocuments = hasCustomerData ? [...extraction.documents, ...result.documents] : result.documents;
  const normalized = hasCustomerData
    ? overrideNormalized(result.normalized, normalizeFields(mergedAttributes, mergedDocuments), extraction.attributes)
    : result.normalized;

  // If we picked up customer data the item is at minimum "partial" — the website may
  // have returned nothing but the customer's source-of-truth is now part of the record.
  let status = result.status;
  if (hasCustomerData) {
    if (status === "failed") status = "partial";
    if (status === "partial" && hasAllCoreFields(normalized)) status = "found";
  }

  return {
    ...result,
    status,
    confidence: Math.max(result.confidence, hasCustomerData ? CUSTOMER_DOC_CONFIDENCE : result.confidence),
    normalized,
    attributes: mergedAttributes,
    documents: mergedDocuments,
    sources: hasCustomerData ? [...extraction.sources, ...result.sources] : result.sources,
    diagnostics: extraction.parseFailures.length
      ? {
          ...result.diagnostics,
          documentParseFailures: [
            ...(result.diagnostics?.documentParseFailures ?? []),
            ...extraction.parseFailures.map((entry) => `(customer) ${entry}`)
          ].slice(0, 50)
        }
      : result.diagnostics,
    error: hasCustomerData && status !== "failed" ? undefined : result.error
  };
}

function hasAllCoreFields(normalized: ProductResult["normalized"]): boolean {
  return Boolean(normalized.weight || normalized.dimensions || normalized.material);
}

function overrideNormalized(
  previous: ProductResult["normalized"],
  reNormalized: ProductResult["normalized"],
  customerAttributes: AttributeRecord[]
): ProductResult["normalized"] {
  // Each field is replaced if the customer's attribute list contained any matching
  // attribute name — i.e. the customer "spoke" on that field. Otherwise we keep what
  // the website previously had so we don't accidentally erase a perfectly good value.
  const next: ProductResult["normalized"] = { ...previous };
  const fieldsCustomerTouched = customerTouchedFields(customerAttributes);
  for (const [key, value] of Object.entries(reNormalized)) {
    if (!fieldsCustomerTouched.has(key) && previous[key as keyof ProductResult["normalized"]]) continue;
    if (value !== undefined && value !== "") next[key as keyof ProductResult["normalized"]] = value;
  }
  return next;
}

const FIELD_LABEL_HINTS: Record<keyof ProductResult["normalized"], RegExp> = {
  weight: /weight|mass|gewicht/i,
  dimensions: /dimension|size|abmessungen|height|width|depth|length|cable length/i,
  material: /material|werkstoff|housing|enclosure|body/i,
  wallThickness: /thickness|gauge/i,
  finish: /finish|coating|paint/i,
  color: /colou?r|farbe/i,
  voltage: /voltage|volt|spannung/i,
  current: /current|amp|amper|strom/i,
  protection: /\bip\b|nema|protection|schutzart/i,
  certificates: /approval|certificat|conformity|standards|marking|\b(ul|ce|rohs|weee|reach)\b/i
};

function customerTouchedFields(customerAttributes: AttributeRecord[]): Set<string> {
  const touched = new Set<string>();
  for (const attr of customerAttributes) {
    const label = `${attr.group ?? ""} ${attr.name}`.toLowerCase();
    for (const [field, pattern] of Object.entries(FIELD_LABEL_HINTS)) {
      if (pattern.test(label)) touched.add(field);
    }
  }
  return touched;
}

async function extractFromPdf(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  cache: CustomerDocumentParseCache,
  onProgress: CustomerDocumentProgress
): Promise<AttributeRecord[]> {
  const pages = await cache.getPdfPages(doc);
  const compactCatalog = compactKey(catalogNumber);
  if (!compactCatalog || pages.length === 0) return [];
  const matches: number[] = [];
  for (const page of pages) {
    if (compactKey(page.text).includes(compactCatalog) || catalogTextMatches(page.text, catalogNumber)) {
      matches.push(page.num);
      onProgress({
        kind: "scan-pdf-page",
        document: doc,
        pageNumber: page.num,
        totalPages: pages.length,
        matchesSoFar: matches.length
      });
      if (matches.length >= TARGETED_MAX_SECTION_PAGES) break;
    }
  }
  if (!matches.length) return [];
  const keepPages = expandWithNeighbours(matches, TARGETED_NEIGHBOUR_PAGES);
  const text = pages
    .filter((page) => keepPages.has(page.num))
    .map((page) => page.text)
    .join("\n")
    .slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS);
  if (!text) return [];
  return extractDocumentTextAttributes({
    catalogNumber,
    document: { label: doc.originalName, type: "other", url: pathToFileUrl(doc.storedPath), localPath: doc.storedPath },
    text
  });
}

async function extractFromWorkbook(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  cache: CustomerDocumentParseCache
): Promise<AttributeRecord[]> {
  const sheets = await cache.getWorkbookMatrices(doc);
  const attributes: AttributeRecord[] = [];
  for (const sheet of sheets) {
    attributes.push(...attributesFromMatrix(sheet.rows, catalogNumber, `${doc.originalName} / ${sheet.sheet}`, pathToFileUrl(doc.storedPath)));
  }
  return attributes;
}

async function extractFromCsv(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  cache: CustomerDocumentParseCache
): Promise<AttributeRecord[]> {
  const matrix = await cache.getCsvMatrix(doc);
  return attributesFromMatrix(matrix, catalogNumber, doc.originalName, pathToFileUrl(doc.storedPath));
}

function attributesFromMatrix(matrix: string[][], catalogNumber: string, group: string, sourceUrl: string): AttributeRecord[] {
  if (matrix.length === 0) return [];
  const header = matrix[0].map((cell) => cleanText(cell || ""));
  const headerLooksLikeHeader = header.some((cell) => /[A-Za-z]/.test(cell)) && !header.every((cell) => catalogTextMatches(cell, catalogNumber));
  const dataStartIndex = headerLooksLikeHeader ? 1 : 0;
  const attributes: AttributeRecord[] = [];

  for (let rowIndex = dataStartIndex; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex];
    if (!row || !row.some((cell) => cleanText(cell || "").length > 0)) continue;
    if (!row.some((cell) => catalogTextMatches(cell || "", catalogNumber))) continue;
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      const value = cleanText(row[colIndex] || "");
      if (!value) continue;
      const columnName = headerLooksLikeHeader ? header[colIndex] || `Column ${colIndex + 1}` : `Column ${colIndex + 1}`;
      if (catalogTextMatches(value, catalogNumber)) continue;
      if (value.length > 600) continue;
      attributes.push({ group: `Customer / ${group}`, name: columnName, value, sourceUrl });
    }
  }

  return attributes;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: unknown }>; hyperlink?: unknown };
    if (record.text) return String(record.text);
    if (record.result !== undefined) return cellToString(record.result);
    if (Array.isArray(record.richText)) return record.richText.map((part) => String(part?.text ?? "")).join("");
    if (record.hyperlink) return String(record.hyperlink);
  }
  return String(value);
}

function stampCustomerAttributes(attributes: AttributeRecord[], sourceUrl: string): AttributeRecord[] {
  return attributes.map((attr) => ({
    ...attr,
    sourceUrl: attr.sourceUrl ?? sourceUrl,
    sourceType: "official",
    parser: "customer-document",
    stage: "customer-override",
    confidence: CUSTOMER_DOC_CONFIDENCE
  }));
}

function customerDocumentType(extension: string): DocumentRecord["type"] {
  if (extension === ".pdf") return "datasheet";
  return "other";
}

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  return resolved.startsWith("/") ? `file://${resolved}` : `file:///${resolved}`;
}

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function expandWithNeighbours(pages: number[], window: number): Set<number> {
  const set = new Set<number>();
  for (const num of pages) {
    for (let offset = -window; offset <= window; offset += 1) {
      const neighbour = num + offset;
      if (neighbour >= 1) set.add(neighbour);
    }
  }
  return set;
}
