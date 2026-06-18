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
import { buildTightContextForCatalog } from "./tight-context.js";

const MAX_CUSTOMER_PDF_PAGES = 400;
const MAX_CUSTOMER_PDF_TEXT_CHARS = 400_000;
const CUSTOMER_DOC_CONFIDENCE = 0.97;
// 2 pages of context on each side — Eaton-style spec tables routinely span across a page
// break, and the normalizer needs the label / value pair on the same chunk of text to
// recognize "Rated voltage: 230 V". One neighbour was too tight and dropped many specs.
const TARGETED_NEIGHBOUR_PAGES = 2;
const TARGETED_MAX_SECTION_PAGES = 20;
const PDF_TEXT_MIN_CHARS_FOR_PARSE = 80; // anything below this is effectively a scanned image — warn the user.

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
    const delimiter = detectDelimitedTextDelimiter(text);
    const matrix = parse(text, {
      bom: true,
      delimiter,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true
    }) as string[][];
    this.csvMatrices.set(doc.storedPath, matrix);
    return matrix;
  }
}

function detectDelimitedTextDelimiter(text: string): "," | ";" | "\t" {
  const header = text.split(/\r?\n/).find((line) => cleanText(line).length > 0) ?? "";
  const scores: Array<{ delimiter: "," | ";" | "\t"; count: number }> = [
    { delimiter: "\t", count: countDelimiterOutsideQuotes(header, "\t") },
    { delimiter: ",", count: countDelimiterOutsideQuotes(header, ",") },
    { delimiter: ";", count: countDelimiterOutsideQuotes(header, ";") }
  ];
  scores.sort((left, right) => right.count - left.count);
  return scores[0]?.count ? scores[0].delimiter : ",";
}

function countDelimiterOutsideQuotes(line: string, delimiter: "," | ";" | "\t"): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) count += 1;
  }
  return count;
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
): Promise<{ attributes: AttributeRecord[]; sources: SourceRecord[]; documents: DocumentRecord[]; parseFailures: string[]; titleSuggestion?: string }> {
  const cache = options.cache ?? new CustomerDocumentParseCache();
  const onProgress = options.onProgress ?? (() => undefined);
  const attributes: AttributeRecord[] = [];
  const sources: SourceRecord[] = [];
  const documents: DocumentRecord[] = [];
  const parseFailures: string[] = [];
  let titleSuggestion: string | undefined;

  for (let documentIndex = 0; documentIndex < customerDocuments.length; documentIndex += 1) {
    const doc = customerDocuments[documentIndex];
    if (!doc.storedPath) continue;
    onProgress({ kind: "start", documentIndex, documentTotal: customerDocuments.length, document: doc });
    let extension = path.extname(doc.originalName || doc.storedPath).toLowerCase();
    if (!extension) extension = path.extname(doc.storedPath).toLowerCase();
    const sourceUrl = pathToFileUrl(doc.storedPath);
    try {
      let extracted: AttributeRecord[] = [];
      let docTitleHint: string | undefined;
      if (extension === ".pdf") {
        const pdfOutcome = await extractFromPdf(catalogNumber, doc, cache, onProgress);
        extracted = pdfOutcome.attributes;
        docTitleHint = pdfOutcome.titleHint;
        if (pdfOutcome.scannedImageOnly) {
          const message = `PDF looks like a scanned image (no extractable text) — OCR not yet supported, so customer data from this file cannot be used.`;
          parseFailures.push(`${doc.originalName}: ${message}`);
          onProgress({ kind: "parse-error", document: doc, message });
          continue;
        }
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
      if (!titleSuggestion && docTitleHint) titleSuggestion = docTitleHint;

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
        type: customerDocumentType(extension, doc.originalName, extracted),
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

  return { attributes, sources, documents, parseFailures, titleSuggestion };
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
  extraction: { attributes: AttributeRecord[]; sources: SourceRecord[]; documents: DocumentRecord[]; parseFailures: string[]; titleSuggestion?: string }
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

  // Promote the customer's title only when the website didn't supply one — the official
  // catalog page is always preferred when present, but a blank title is worse than the
  // heading we extracted from the customer's PDF section.
  const title = result.title?.trim() ? result.title : extraction.titleSuggestion;

  return {
    ...result,
    status,
    title,
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
  certificates: /approval|certificat|conformity|standards|marking|\b(ul|ce|rohs|weee|reach)\b/i,
  operatingTemperatureMin: /operating temperature|operational temperature|ambient temperature|umgebungstemperatur|betriebstemperatur|temperature range/i,
  operatingTemperatureMax: /operating temperature|operational temperature|ambient temperature|umgebungstemperatur|betriebstemperatur|temperature range/i
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

interface PdfExtractionOutcome {
  attributes: AttributeRecord[];
  titleHint?: string;
  scannedImageOnly: boolean;
}

async function extractFromPdf(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  cache: CustomerDocumentParseCache,
  onProgress: CustomerDocumentProgress
): Promise<PdfExtractionOutcome> {
  const pages = await cache.getPdfPages(doc);
  const compactCatalog = compactKey(catalogNumber);
  if (!compactCatalog || pages.length === 0) {
    return { attributes: [], scannedImageOnly: pages.length === 0 };
  }
  // Detect a fully-scanned PDF: every page has near-zero extractable text. Caller turns
  // this into a clear user-visible warning so the user knows OCR (not yet implemented)
  // would be required to use this file.
  const totalTextChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (totalTextChars < PDF_TEXT_MIN_CHARS_FOR_PARSE) {
    return { attributes: [], scannedImageOnly: true };
  }
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
  if (!matches.length) return { attributes: [], scannedImageOnly: false };
  const keepPages = expandWithNeighbours(matches, TARGETED_NEIGHBOUR_PAGES);
  const widePagesText = pages
    .filter((page) => keepPages.has(page.num))
    .map((page) => page.text)
    .join("\n")
    .slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS);
  if (!widePagesText) return { attributes: [], scannedImageOnly: false };
  // Scope to the line block around each catalog match: stop expanding at any line that
  // looks like a DIFFERENT product's catalog number. This avoids "row pollution" where
  // a customer PDF's spec table for CBE04417 sits next to CBE04418, and the loose page-
  // wide window otherwise drags CBE04418's voltage/current into CBE04417's attribute set.
  const tightText = buildTightContextForCatalog(widePagesText, catalogNumber, { maxChars: MAX_CUSTOMER_PDF_TEXT_CHARS }) ?? widePagesText;
  const attributes = extractDocumentTextAttributes({
    catalogNumber,
    document: { label: doc.originalName, type: "other", url: pathToFileUrl(doc.storedPath), localPath: doc.storedPath },
    text: tightText
  });
  const titleHint = guessTitleFromPdfText(widePagesText, catalogNumber);
  return { attributes, titleHint, scannedImageOnly: false };
}


/**
 * Pick a plausible product title from the customer PDF text. We look at lines on the
 * matched pages near (above and below) the catalog number — most catalogs print a
 * product name as a heading just above the spec table that contains the catalog code.
 * Fallback: longest single-line phrase under 120 chars that doesn't look like a label
 * row, isn't the catalog number itself, and doesn't read as a section header.
 */
function guessTitleFromPdfText(text: string, catalogNumber: string): string | undefined {
  const compactCatalog = compactKey(catalogNumber);
  if (!compactCatalog) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter((line) => line.length > 0);
  let bestNeighbour: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (!compactKey(lines[index]).includes(compactCatalog) && !catalogTextMatches(lines[index], catalogNumber)) continue;
    for (let offset = 1; offset <= 4; offset += 1) {
      const before = lines[index - offset];
      if (before && looksLikeTitleLine(before, catalogNumber)) {
        bestNeighbour = before;
        break;
      }
    }
    if (bestNeighbour) break;
    for (let offset = 1; offset <= 2; offset += 1) {
      const after = lines[index + offset];
      if (after && looksLikeTitleLine(after, catalogNumber)) {
        bestNeighbour = after;
        break;
      }
    }
    if (bestNeighbour) break;
  }
  return bestNeighbour;
}

function looksLikeTitleLine(line: string, catalogNumber: string): boolean {
  if (line.length < 8 || line.length > 140) return false;
  if (catalogTextMatches(line, catalogNumber)) return false;
  if (compactKey(line).includes(compactKey(catalogNumber))) return false;
  // Reject lines that are clearly tables/labels (lots of colons, mostly digits/units).
  const colonCount = (line.match(/:/g) || []).length;
  if (colonCount > 1) return false;
  const digitRatio = (line.replace(/[^0-9]/g, "").length) / line.length;
  if (digitRatio > 0.4) return false;
  // Title-like: has 2+ alphabetic words, mixed case OK, no trailing colon.
  const wordCount = line.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word)).length;
  if (wordCount < 2) return false;
  if (/^(page|chapter|section|table|figure)\b/i.test(line)) return false;
  return true;
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

  // Detect "long-format" sheets like [Catalog, Attribute, Value] — common in customer-
  // supplied spec dumps. Without this, the value column ends up as an attribute named
  // "Value" with value="230V", which the normalizer can't map to voltage. With it, we
  // emit { name: "Voltage", value: "230V" } pairs that normalize correctly.
  const longFormat = headerLooksLikeHeader ? detectLongFormatColumns(header) : null;

  for (let rowIndex = dataStartIndex; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex];
    if (!row || !row.some((cell) => cleanText(cell || "").length > 0)) continue;
    if (!row.some((cell) => catalogTextMatches(cell || "", catalogNumber))) continue;

    if (longFormat) {
      const name = cleanText(row[longFormat.nameCol] || "");
      const value = cleanText(row[longFormat.valueCol] || "");
      if (!name || !value) continue;
      if (catalogTextMatches(value, catalogNumber)) continue;
      if (value.length > 600) continue;
      attributes.push({ group: `Customer / ${group}`, name, value, sourceUrl });
      continue;
    }

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

/**
 * Detect three-column long-format sheets: one catalog column, one attribute-name column,
 * one value column. Returns the {nameCol, valueCol} indices when the header looks like
 * one — null otherwise (so we fall back to wide-format row scanning).
 */
function detectLongFormatColumns(header: string[]): { nameCol: number; valueCol: number } | null {
  if (header.length < 3 || header.length > 6) return null;
  const namePattern = /^(attribute|attr|name|property|prop|parameter|param|feature|characteristic|spec(?:ification)?|field)$/i;
  const valuePattern = /^(value|val|spec(?:ification)? ?value|measurement|content|data)$/i;
  let nameCol = -1;
  let valueCol = -1;
  for (let index = 0; index < header.length; index += 1) {
    const cell = header[index];
    if (nameCol < 0 && namePattern.test(cell)) nameCol = index;
    else if (valueCol < 0 && valuePattern.test(cell)) valueCol = index;
  }
  if (nameCol < 0 || valueCol < 0 || nameCol === valueCol) return null;
  return { nameCol, valueCol };
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

function customerDocumentType(extension: string, originalName = "", attributes: AttributeRecord[] = []): DocumentRecord["type"] {
  const label = originalName.toLowerCase();
  if (/\b(data\s*sheet|datasheet|technical\s*data|spec(?:ification)?\s*sheet)\b/.test(label)) return "datasheet";
  if (/\b(certificate|certification|declaration|approval)\b/.test(label)) return "certificate";
  if (/\b(manual|instruction|installation|user\s*guide)\b/.test(label)) return "manual";
  if (extension === ".pdf") return "datasheet";
  if (looksLikeStructuredDatasheet(attributes)) return "datasheet";
  return "other";
}

function looksLikeStructuredDatasheet(attributes: AttributeRecord[]): boolean {
  if (attributes.length < 4) return false;
  const names = new Set(attributes.map((attr) => cleanText(attr.name).toLowerCase()));
  const technicalHits = [
    ["material"],
    ["dimensions", "size"],
    ["weight", "mass"],
    ["voltage"],
    ["current"],
    ["pressure"],
    ["flow rate", "flow"],
    ["power"],
    ["certificates", "certifications", "standards"]
  ].filter((aliases) => aliases.some((alias) => names.has(alias))).length;
  const identityHits = ["product type", "description", "product short text", "product name"].filter((name) => names.has(name)).length;
  return identityHits >= 1 && technicalHits >= 3;
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
