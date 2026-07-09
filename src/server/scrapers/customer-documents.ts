import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { parse } from "csv-parse/sync";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";
import type {
  AttributeRecord,
  CustomerDocumentRecord,
  DocumentProcessingDiagnostic,
  DocumentRecord,
  ProductResult,
  SourceRecord
} from "../../shared/types.js";
import { catalogTextMatches } from "./catalog-number.js";
import { extractDocumentTextAttributes } from "./document-enrichment.js";
import { extractInlineNameplateSpecAttributes, extractNameplateVoltageClassSpecAttributes } from "./electrical-spec-miner.js";
import { fieldMatchesLabel, FIELD_REGISTRY, type RegistryFieldKey } from "./field-registry.js";
import { cleanText, normalizeFields } from "./normalizer.js";
import { readPdfWithOptionalOcr } from "./pdf-ocr.js";
import { identityAttributeLabelStrength } from "./product-identity.js";
import { buildTightContextForCatalog } from "./tight-context.js";

const MAX_CUSTOMER_PDF_PAGES = 400;
const MAX_CUSTOMER_PDF_TEXT_CHARS = 400_000;
const CUSTOMER_DOC_CONFIDENCE = 0.97;
// 2 pages of context on each side — Eaton-style spec tables routinely span across a page
// break, and the normalizer needs the label / value pair on the same chunk of text to
// recognize "Rated voltage: 230 V". One neighbour was too tight and dropped many specs.
const TARGETED_NEIGHBOUR_PAGES = 2;
const TARGETED_MAX_SECTION_PAGES = 20;
const SMALL_UNMATCHED_PDF_FALLBACK_MAX_PAGES = 12;
const PDF_TEXT_MIN_CHARS_FOR_PARSE = 80; // anything below this is effectively a scanned image — warn the user.

export type CustomerDocumentProgressEvent =
  | { kind: "start"; documentIndex: number; documentTotal: number; document: CustomerDocumentRecord }
  | { kind: "scan-pdf-page"; document: CustomerDocumentRecord; pageNumber: number; totalPages?: number; matchesSoFar: number }
  | { kind: "ocr-pdf"; document: CustomerDocumentRecord; message: string }
  | { kind: "matched"; document: CustomerDocumentRecord; attributeCount: number }
  | { kind: "no-match"; document: CustomerDocumentRecord }
  | { kind: "parse-error"; document: CustomerDocumentRecord; message: string };

export type CustomerDocumentProgress = (event: CustomerDocumentProgressEvent) => void;

interface CustomerDocumentExtraction {
  attributes: AttributeRecord[];
  sources: SourceRecord[];
  documents: DocumentRecord[];
  parseFailures: string[];
  documentProcessing: DocumentProcessingDiagnostic[];
  titleSuggestion?: string;
}

interface PdfPageEntry {
  num: number;
  text: string;
  compactText?: string;
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
): Promise<CustomerDocumentExtraction> {
  const cache = options.cache ?? new CustomerDocumentParseCache();
  const onProgress = options.onProgress ?? (() => undefined);
  const attributes: AttributeRecord[] = [];
  const sources: SourceRecord[] = [];
  const documents: DocumentRecord[] = [];
  const parseFailures: string[] = [];
  const documentProcessing: DocumentProcessingDiagnostic[] = [];
  let titleSuggestion: string | undefined;
  const identifierAliases = await collectIdentifierAliases(catalogNumber, customerDocuments, cache);

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
      let documentPageCount: number | undefined;
      if (extension === ".pdf") {
        const pdfOutcome = await extractFromPdf(catalogNumber, doc, cache, onProgress);
        extracted = pdfOutcome.attributes;
        docTitleHint = pdfOutcome.titleHint;
        documentPageCount = pdfOutcome.pageCount;
        if (pdfOutcome.scannedImageOnly) {
          const message = `PDF looks like a scanned image and OCR did not return enough usable text, so customer data from this file cannot be used.`;
          parseFailures.push(`${doc.originalName}: ${message}`);
          documentProcessing.push(customerDocumentProcessingRecord(doc, sourceUrl, "failed", message, message, undefined, { pageCount: documentPageCount, attributeCount: 0 }));
          onProgress({ kind: "parse-error", document: doc, message });
          continue;
        }
      } else if (extension === ".xlsx" || extension === ".xls") {
        extracted = await extractFromWorkbook(catalogNumber, doc, cache);
      } else if (extension === ".csv" || extension === ".tsv") {
        extracted = await extractFromCsv(catalogNumber, doc, cache);
        if (extracted.length === 0) extracted = await extractFromTextDocument(catalogNumber, doc, extension, { requireCatalogMatch: true });
      } else if (extension === ".docx") {
        extracted = await extractFromDocxDocument(catalogNumber, doc);
      } else if (extension === ".doc") {
        const message = `legacy Word .doc files are not supported yet; save this document as .docx, PDF, or plain text and attach it again.`;
        parseFailures.push(`${doc.originalName}: ${message}`);
        documentProcessing.push(customerDocumentProcessingRecord(doc, sourceUrl, "failed", message, message));
        onProgress({ kind: "parse-error", document: doc, message });
        continue;
      } else if (isFreeTextCustomerDocumentExtension(extension)) {
        extracted = await extractFromTextDocument(catalogNumber, doc, extension);
      } else {
        const message = `unsupported file type "${extension || "(unknown)"}"`;
        parseFailures.push(`${doc.originalName}: ${message}`);
        documentProcessing.push(customerDocumentProcessingRecord(doc, sourceUrl, "failed", message, message));
        onProgress({ kind: "parse-error", document: doc, message });
        continue;
      }

      // The requested catalog number may be an order/SKU number that this document never
      // mentions at all — manufacturers often print a separate model/type code instead
      // (see IDENTIFIER_ALIAS_HEADER_PATTERN). Retry with whatever aliases a sibling
      // spreadsheet exposed for this same product before giving up on the document.
      if (extracted.length === 0 && identifierAliases.length > 0) {
        for (const alias of identifierAliases) {
          const retried = await extractByAliasCatalogNumber(alias, doc, extension, cache);
          if (retried.attributes.length > 0) {
            extracted = retried.attributes;
            docTitleHint ??= retried.titleHint;
            break;
          }
        }
      }
      if (!titleSuggestion && docTitleHint) titleSuggestion = docTitleHint;

      if (extracted.length === 0) {
        documentProcessing.push(customerDocumentProcessingRecord(
          doc,
          sourceUrl,
          "skipped",
          `Customer document was parsed, but no usable attributes for catalog ${catalogNumber} were found.`,
          undefined,
          undefined,
          { pageCount: documentPageCount, attributeCount: 0, normalizedFields: [] }
        ));
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
      documentProcessing.push(customerDocumentProcessingRecord(
        doc,
        sourceUrl,
        "parsed",
        `Parsed ${stamped.length} customer-document attribute record${stamped.length === 1 ? "" : "s"} for catalog ${catalogNumber}.`,
        undefined,
        customerDocumentType(extension, doc.originalName, extracted),
        customerExtractionMetrics(stamped, documentPageCount)
      ));
      onProgress({ kind: "matched", document: doc, attributeCount: stamped.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Customer document parse failed";
      parseFailures.push(`${doc.originalName}: ${message}`);
      documentProcessing.push(customerDocumentProcessingRecord(doc, sourceUrl, "failed", "Customer document parse failed.", message));
      onProgress({ kind: "parse-error", document: doc, message });
    }
  }

  return { attributes, sources, documents, parseFailures, documentProcessing, titleSuggestion };
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
  extraction: CustomerDocumentExtraction
): ProductResult {
  const hasCustomerData = extraction.attributes.length > 0 || extraction.documents.length > 0;
  if (!hasCustomerData && extraction.parseFailures.length === 0 && extraction.documentProcessing.length === 0) return result;

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
    if (status === "partial" && hasEnoughCustomerFieldCoverage(normalized, extraction.attributes)) status = "found";
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
    diagnostics: extraction.parseFailures.length || extraction.documentProcessing.length
      ? {
          ...result.diagnostics,
          ...(extraction.parseFailures.length
            ? {
                documentParseFailures: [
                  ...(result.diagnostics?.documentParseFailures ?? []),
                  ...extraction.parseFailures.map((entry) => `(customer) ${entry}`)
                ].slice(0, 50)
              }
            : {}),
          ...(extraction.documentProcessing.length
            ? {
                documentProcessing: [
                  ...(result.diagnostics?.documentProcessing ?? []),
                  ...extraction.documentProcessing
                ].slice(-100)
              }
            : {})
        }
      : result.diagnostics,
    error: hasCustomerData && status !== "failed" ? undefined : result.error
  };
}

function customerDocumentProcessingRecord(
  doc: CustomerDocumentRecord,
  sourceUrl: string,
  action: DocumentProcessingDiagnostic["action"],
  reason: string,
  parseError?: string,
  type?: DocumentRecord["type"],
  metrics: Partial<Pick<DocumentProcessingDiagnostic, "attributeCount" | "normalizedFields" | "pageCount" | "elapsedMs">> = {}
): DocumentProcessingDiagnostic {
  return {
    url: sourceUrl,
    label: `Customer document: ${doc.originalName}`,
    type: type ?? customerDocumentType(path.extname(doc.originalName || doc.storedPath).toLowerCase(), doc.originalName),
    action,
    stage: "customer-document-enrichment",
    reason,
    ...metrics,
    localPath: doc.storedPath,
    sourceUrl,
    ...(parseError ? { parseError } : {})
  };
}

function hasEnoughCustomerFieldCoverage(
  normalized: ProductResult["normalized"],
  customerAttributes: AttributeRecord[]
): boolean {
  const filledFields = customerFilledRegistryFields(normalized, customerAttributes);
  return filledFields.size >= 3 || ["weight", "dimensions", "material"].some((field) => filledFields.has(field as RegistryFieldKey));
}

function customerFilledRegistryFields(
  normalized: ProductResult["normalized"],
  customerAttributes: AttributeRecord[]
): Set<RegistryFieldKey> {
  const filled = new Set<RegistryFieldKey>();
  for (const attr of customerAttributes) {
    const label = `${attr.group ?? ""} ${attr.name}`;
    for (const field of FIELD_REGISTRY) {
      if (!isCustomerDatasheetTechnicalField(field.key)) continue;
      if (!fieldMatchesLabel(field.key, label)) continue;
      if (normalizedKeysForRegistryField(field.key).some((key) => Boolean(normalized[key]))) {
        filled.add(field.key);
      }
    }
  }
  return filled;
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

function customerTouchedFields(customerAttributes: AttributeRecord[]): Set<string> {
  const touched = new Set<string>();
  for (const attr of customerAttributes) {
    if ((attr.confidence ?? CUSTOMER_DOC_CONFIDENCE) < 0.9) continue;
    const label = `${attr.group ?? ""} ${attr.name}`;
    for (const field of FIELD_REGISTRY) {
      if (!isCustomerOverrideField(field.key) || !fieldMatchesLabel(field.key, label)) continue;
      for (const normalizedKey of normalizedKeysForRegistryField(field.key)) touched.add(normalizedKey);
    }
  }
  return touched;
}

function isCustomerOverrideField(field: RegistryFieldKey): boolean {
  return !["image", "datasheetUrl", "manualUrl", "certificateUrl", "typeCode"].includes(field);
}

function normalizedKeysForRegistryField(field: RegistryFieldKey): Array<keyof ProductResult["normalized"]> {
  if (field === "operatingTemperature") return ["operatingTemperatureMin", "operatingTemperatureMax"];
  return [field as keyof ProductResult["normalized"]];
}

/**
 * Re-runs extraction for one document using an alias identifier instead of the originally
 * requested catalog number — mirrors the main dispatch in `extractCustomerDocumentAttributes`
 * for the extension kinds that can match on free text (PDF/workbook/CSV/docx/plain text).
 * No onProgress: this only fires as a fallback after the primary pass already reported
 * progress for the document, and scanned-image PDFs are treated as a plain no-match here
 * since the OCR fallback already ran (or was skipped) during the primary pass.
 */
async function extractByAliasCatalogNumber(
  alias: string,
  doc: CustomerDocumentRecord,
  extension: string,
  cache: CustomerDocumentParseCache
): Promise<{ attributes: AttributeRecord[]; titleHint?: string }> {
  const outcome = await extractByAliasCatalogNumberRaw(alias, doc, extension, cache);
  return { attributes: stripAliasIdentityEcho(outcome.attributes, alias), titleHint: outcome.titleHint };
}

async function extractByAliasCatalogNumberRaw(
  alias: string,
  doc: CustomerDocumentRecord,
  extension: string,
  cache: CustomerDocumentParseCache
): Promise<{ attributes: AttributeRecord[]; titleHint?: string }> {
  if (extension === ".pdf") {
    const outcome = await extractFromPdf(alias, doc, cache, () => undefined);
    return outcome.scannedImageOnly ? { attributes: [] } : { attributes: outcome.attributes, titleHint: outcome.titleHint };
  }
  if (extension === ".xlsx" || extension === ".xls") {
    return { attributes: await extractFromWorkbook(alias, doc, cache) };
  }
  if (extension === ".csv" || extension === ".tsv") {
    let attributes = await extractFromCsv(alias, doc, cache);
    if (attributes.length === 0) attributes = await extractFromTextDocument(alias, doc, extension, { requireCatalogMatch: true });
    return { attributes };
  }
  if (extension === ".docx") {
    return { attributes: await extractFromDocxDocument(alias, doc) };
  }
  if (isFreeTextCustomerDocumentExtension(extension)) {
    return { attributes: await extractFromTextDocument(alias, doc, extension) };
  }
  return { attributes: [] };
}

/**
 * Drops attributes that free-text/table extraction mislabeled as an identity field (a name
 * matching STRONG/WEAK_IDENTITY_LABEL, e.g. "Catalog Number") but whose value is really just
 * an echo of the ALIAS we searched with — not the customer's actually-requested catalog
 * number. Left alone, `structuredIdentityConflict` reads that as a second, conflicting
 * product identity and fails the whole item. The alias itself is already recorded correctly
 * elsewhere under a non-identity label (e.g. the sibling spreadsheet's "Product Model" column).
 */
function stripAliasIdentityEcho(attributes: AttributeRecord[], alias: string): AttributeRecord[] {
  return attributes.filter((attr) => {
    const strength = identityAttributeLabelStrength(`${attr.group ?? ""} ${attr.name}`);
    if (!strength) return true;
    return !catalogTextMatches(attr.value, alias);
  });
}

interface PdfExtractionOutcome {
  attributes: AttributeRecord[];
  titleHint?: string;
  scannedImageOnly: boolean;
  pageCount?: number;
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
    return { attributes: [], scannedImageOnly: pages.length === 0, pageCount: pages.length };
  }
  // Detect a fully-scanned PDF, leave a clear progress trail, and try OCR before giving up.
  const totalTextChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (totalTextChars < PDF_TEXT_MIN_CHARS_FOR_PARSE) {
    onProgress({ kind: "ocr-pdf", document: doc, message: "PDF has no extractable text; trying OCR fallback." });
    const ocr = await readPdfWithOptionalOcr(doc.storedPath, { maxPages: Math.min(12, pages.length || 12) });
    if (ocr.text.trim().length < PDF_TEXT_MIN_CHARS_FOR_PARSE) {
      if (ocr.error) onProgress({ kind: "ocr-pdf", document: doc, message: `OCR failed: ${ocr.error}` });
      return { attributes: [], scannedImageOnly: true, pageCount: ocr.pageCount || pages.length };
    }
    onProgress({ kind: "ocr-pdf", document: doc, message: `OCR extracted text from ${ocr.pageCount || "some"} page(s).` });
    return { ...extractFromOcrText(catalogNumber, doc, ocr.text), pageCount: ocr.pageCount || pages.length };
  }
  const matches: number[] = [];
  for (const page of pages) {
    page.compactText ??= compactKey(page.text);
    if (page.compactText.includes(compactCatalog) || catalogTextMatches(page.text, catalogNumber)) {
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
  if (!matches.length) {
    const familyFallback = extractFamilyPdf(catalogNumber, doc, pages);
    if (familyFallback) return familyFallback;
    return extractFromUnmatchedCustomerPdf(catalogNumber, doc, pages);
  }
  const keepPages = expandWithNeighbours(matches, TARGETED_NEIGHBOUR_PAGES);
  const widePagesText = pages
    .filter((page) => keepPages.has(page.num))
    .map((page) => page.text)
    .join("\n")
    .slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS);
  if (!widePagesText) return { attributes: [], scannedImageOnly: false, pageCount: pages.length };
  // Scope to the line block around each catalog match: stop expanding at any line that
  // looks like a DIFFERENT product's catalog number. This avoids "row pollution" where
  // a customer PDF's spec table for CBE04417 sits next to CBE04418, and the loose page-
  // wide window otherwise drags CBE04418's voltage/current into CBE04417's attribute set.
  const tightText = buildTightContextForCatalog(widePagesText, catalogNumber, { maxChars: MAX_CUSTOMER_PDF_TEXT_CHARS }) ?? widePagesText;
  const proseAttributes = extractDocumentTextAttributes({
    catalogNumber,
    document: { label: doc.originalName, type: "other", url: pathToFileUrl(doc.storedPath), localPath: doc.storedPath },
    text: tightText
  });
  // Manufacturer PDFs (catalog-number selection tables, dimension tables) often print a
  // genuine header + data-row table that pdf-parse preserves as tab-separated lines.
  // The line-by-line prose extractor above reads those rows as noisy free text (a jumble
  // of "Matched product row" / "Feature" attributes); running the same header-aware matrix
  // parser used for customer Excel sheets against the tab-delimited blocks recovers clean,
  // correctly-named attributes instead. Table-derived attributes go first so the normalizer's
  // tie-breaker prefers them over the noisier prose attributes for the same field.
  const tableAttributes = extractCustomerPdfTableAttributes(
    catalogNumber,
    doc.originalName,
    pathToFileUrl(doc.storedPath),
    widePagesText
  );
  // Shared page-level facts (e.g. a "three-phase 380V class machine" wiring-section header
  // that applies to every model row in that page's table) sit further from a specific model's
  // own row than the tight per-row line window reaches for anything but the first row in the
  // table. Pull them from the exact pages where THIS catalog/alias's own row was matched
  // (never a neighbour-only page) so every row in a multi-model table gets the shared fact,
  // without risking borrowing a different page's different-family voltage class.
  const matchedPagesText = pages
    .filter((page) => matches.includes(page.num))
    .map((page) => page.text)
    .join("\n");
  const namePlateVoltageAttributes = extractNameplateVoltageClassSpecAttributes(matchedPagesText, pathToFileUrl(doc.storedPath));
  const attributes = dedupeCustomerAttributes([...tableAttributes, ...namePlateVoltageAttributes, ...proseAttributes]);
  const titleHint = guessTitleFromPdfText(widePagesText, catalogNumber);
  return {
    attributes: hasSubstantiveDocumentAttributes(attributes) ? attributes : [],
    titleHint,
    scannedImageOnly: false,
    pageCount: pages.length
  };
}

const MIN_TAB_TABLE_ROWS = 2;

/**
 * Finds tab-delimited "matrix" tables (catalog-number selection tables, dimension
 * tables) inside PDF page text and extracts clean per-column attributes for whichever
 * row matches the requested catalog number, using the same header-aware parser as
 * customer Excel/CSV sheets. Exported for direct text-based testing, mirroring
 * `extractCustomerFamilyPdfAttributes` above.
 */
export function extractCustomerPdfTableAttributes(
  catalogNumber: string,
  documentName: string,
  sourceUrl: string,
  text: string
): AttributeRecord[] {
  return extractTabDelimitedMatrices(text).flatMap((matrix) =>
    attributesFromMatrix(matrix, catalogNumber, documentName, sourceUrl)
  );
}

/**
 * Carves contiguous runs of tab-separated lines with a stable column count out of PDF
 * page text. pdf-parse keeps the original column tabs for real tables (catalog-number
 * selection tables, dimension tables), so a run of same-width tab-delimited lines is a
 * strong signal of a real table — as opposed to prose, which pdf-parse never emits with
 * embedded tabs. Each run is handed to the same `attributesFromMatrix` parser used for
 * customer Excel/CSV sheets so a header row like "Product number\tRated power (kW)"
 * produces clean per-column attributes instead of one blob of free text.
 */
function extractTabDelimitedMatrices(text: string): string[][][] {
  const matrices: string[][][] = [];
  let current: string[][] = [];
  let currentColumnCount = 0;
  const flush = () => {
    if (current.length >= MIN_TAB_TABLE_ROWS) matrices.push(current);
    current = [];
    currentColumnCount = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("\t")) {
      flush();
      continue;
    }
    const cells = line.split("\t").map((cell) => cleanText(cell));
    const nonEmptyCount = cells.filter(Boolean).length;
    if (cells.length < 2 || nonEmptyCount < 2) {
      flush();
      continue;
    }
    if (current.length > 0 && cells.length !== currentColumnCount) flush();
    currentColumnCount = cells.length;
    current.push(cells);
  }
  flush();
  return matrices;
}

function extractFromOcrText(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  text: string
): PdfExtractionOutcome {
  const tightText = buildTightContextForCatalog(text, catalogNumber, { maxChars: MAX_CUSTOMER_PDF_TEXT_CHARS }) ?? text.slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS);
  const attributes = extractDocumentTextAttributes({
    catalogNumber,
    document: { label: doc.originalName, type: "other", url: pathToFileUrl(doc.storedPath), localPath: doc.storedPath },
    text: tightText
  });
  return {
    attributes: hasSubstantiveDocumentAttributes(attributes) ? attributes : [],
    titleHint: guessTitleFromPdfText(text, catalogNumber),
    scannedImageOnly: false
  };
}

function extractFamilyPdf(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  pages: PdfPageEntry[]
): PdfExtractionOutcome | undefined {
  const text = pages.map((page) => page.text).join("\n").slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS);
  const sourceUrl = pathToFileUrl(doc.storedPath);
  const attributes = extractCustomerFamilyPdfAttributes(catalogNumber, doc.originalName, sourceUrl, text);
  if (!hasSubstantiveDocumentAttributes(attributes)) return undefined;
  // Same page-scoped nameplate-voltage recovery as the exact-match path (see there for why):
  // find the pages that actually mention the matched FAMILY key (never merely neighbouring
  // pages, which could belong to a sibling family with a different voltage class) and mine
  // those for a shared "N-phase NNNV class machine" fact.
  const family = inferCatalogFamilyEvidence(catalogNumber, text);
  const familyMatchedPagesText = family
    ? pages
        .filter((page) => {
          page.compactText ??= compactKey(page.text);
          return page.compactText.includes(family.key);
        })
        .map((page) => page.text)
        .join("\n")
    : "";
  const namePlateVoltageAttributes = familyMatchedPagesText
    ? extractNameplateVoltageClassSpecAttributes(familyMatchedPagesText, sourceUrl)
    : [];
  const mergedAttributes = namePlateVoltageAttributes.length
    ? dedupeCustomerAttributes([...attributes, ...namePlateVoltageAttributes])
    : attributes;
  return {
    attributes: mergedAttributes,
    titleHint: guessTitleFromPdfText(text, catalogNumber) ?? familyTitleFromText(text),
    scannedImageOnly: false,
    pageCount: pages.length
  };
}

export function extractCustomerFamilyPdfAttributes(
  catalogNumber: string,
  documentName: string,
  sourceUrl: string,
  text: string
): AttributeRecord[] {
  const family = inferCatalogFamilyEvidence(catalogNumber, text);
  if (!family) return [];
  // The family match is a loose substring hit, not an exact catalog match — feeding the
  // WHOLE document (up to 400k chars of safety warnings, table of contents, wiring-diagram
  // labels) to the free-text extractor drowns the few genuinely relevant rows in hundreds of
  // "Feature: <sentence>" attributes. Scope down to the lines that actually mention the
  // matched family key first, same as the exact-match path does for the real catalog number.
  // Narrower than the exact-match window (6/18): a family hit is a loose substring match, not
  // a confirmed catalog mention, so we lean tighter to keep the free-text extractor away from
  // unrelated prose that happens to fall within a wider line window.
  const scopedText = buildTightContextForCatalog(text, family.displayKey, { maxChars: MAX_CUSTOMER_PDF_TEXT_CHARS, before: 2, after: 6 }) ?? text;
  // Table extraction stays scoped to the matched ROW regardless of window size (attributesFromMatrix
  // only ever emits the row that matches), so it can safely run against the full document — which
  // matters here because the line-window above stops expanding at the very first sibling model's
  // row, usually cutting off the column header a genuine selection table prints once at the top.
  const tableAttributes = extractCustomerPdfTableAttributes(family.displayKey, documentName, sourceUrl, text);
  const proseAttributes = extractDocumentTextAttributes({
    catalogNumber,
    document: { label: documentName, type: "other", url: sourceUrl },
    text: scopedText
  });
  const familyTitle = familyTitleFromText(text);
  const attributes: AttributeRecord[] = [
    { group: "PDF Document", name: "Parsed document", value: cleanText(documentName), sourceUrl },
    // No "Requested catalog number" echo here (unlike other stages): this function's
    // `catalogNumber` argument can be an ALIAS from a sibling document rather than the
    // customer's actually-requested catalog number (see extractByAliasCatalogNumber), and
    // restating it under a strong-identity label ("... catalog number ...") would make
    // structuredIdentityConflict treat the manufacturer's own model code as a mismatched,
    // conflicting product. The value itself is already visible on every attribute's sourceUrl.
    {
      group: "Customer / Family document",
      name: "Matched catalog family",
      value: family.displayKey,
      sourceUrl,
      sourceType: "generated",
      parser: "customer-family-pdf-inference",
      stage: "customer-document-enrichment",
      confidence: 0.58
    }
  ];
  return dedupeCustomerAttributes([...attributes, ...tableAttributes, ...proseAttributes]);
}

function inferCatalogFamilyEvidence(catalogNumber: string, text: string): { key: string; displayKey: string } | undefined {
  const compactText = compactKey(text);
  if (!compactText) return undefined;
  return catalogFamilyKeys(catalogNumber)
    .map((key) => ({ key: compactKey(key), displayKey: key }))
    .filter((entry) => isUsefulFamilyKey(entry.key))
    .sort((left, right) => right.key.length - left.key.length)
    .find((entry) => compactText.includes(entry.key));
}

function catalogFamilyKeys(catalogNumber: string): string[] {
  const cleaned = cleanText(catalogNumber).toUpperCase();
  const keys: string[] = [];
  const parts = cleaned.split(/[^A-Z0-9]+/).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const alphaNumeric = part.match(/^([A-Z]+)(\d{2,})/);
    if (alphaNumeric) {
      keys.push(`${alphaNumeric[1]}${alphaNumeric[2].slice(0, 3)}`);
    }
    const numericAlpha = part.match(/^(\d{3,})([A-Z]+)(\d*)/);
    if (numericAlpha) {
      keys.push(`${numericAlpha[1]}${numericAlpha[2]}`);
      if (numericAlpha[3]) keys.push(`${numericAlpha[1]}${numericAlpha[2]}${numericAlpha[3][0]}`);
    }
    const next = parts[index + 1];
    if (!next) continue;
    const nextAlphaNumeric = next.match(/^([A-Z]+)(\d{1,})/);
    if (nextAlphaNumeric && /\d/.test(part)) {
      keys.push(`${part}${nextAlphaNumeric[1]}`);
      keys.push(`${part}${nextAlphaNumeric[1]}${nextAlphaNumeric[2][0]}`);
      if (nextAlphaNumeric[2].length >= 2) keys.push(`${part}${nextAlphaNumeric[1]}${nextAlphaNumeric[2].slice(0, 2)}`);
    }
  }
  return [...new Set(keys)];
}

function isUsefulFamilyKey(value: string): boolean {
  return value.length >= 5 && /[a-z]/i.test(value) && /\d/.test(value);
}

function familyTitleFromText(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .find((line) =>
      line.length >= 8 &&
      line.length <= 120 &&
      /\b(?:controller|module|switch|drive|sensor|terminal|relay|breaker|contactor|datasheet|technical data)\b/i.test(line) &&
      /[A-Za-z]/.test(line)
    );
}

function extractFromUnmatchedCustomerPdf(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  pages: PdfPageEntry[]
): PdfExtractionOutcome {
  if (pages.length > SMALL_UNMATCHED_PDF_FALLBACK_MAX_PAGES) {
    return { attributes: [], scannedImageOnly: false, pageCount: pages.length };
  }
  const text = pages
    .slice(0, SMALL_UNMATCHED_PDF_FALLBACK_MAX_PAGES)
    .map((page) => page.text)
    .join("\n")
    .slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS);
  if (!text) return { attributes: [], scannedImageOnly: false, pageCount: pages.length };

  const attributes = extractDocumentTextAttributes({
    catalogNumber,
    document: { label: doc.originalName, type: "other", url: pathToFileUrl(doc.storedPath), localPath: doc.storedPath },
    text
  }).map((attr) => ({
    ...attr,
    parser: attr.parser ?? "customer-unmatched-pdf-fallback",
    confidence: Math.min(attr.confidence ?? 0.72, 0.72)
  }));
  if (!hasSubstantiveDocumentAttributes(attributes)) {
    return { attributes: [], scannedImageOnly: false, pageCount: pages.length };
  }

  return {
    attributes,
    titleHint: guessTitleFromPdfText(text, catalogNumber),
    scannedImageOnly: false,
    pageCount: pages.length
  };
}

function customerExtractionMetrics(
  attributes: AttributeRecord[],
  pageCount?: number
): Pick<DocumentProcessingDiagnostic, "attributeCount" | "normalizedFields" | "pageCount"> {
  return {
    attributeCount: attributes.length,
    normalizedFields: Object.entries(normalizeFields(attributes, []))
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key]) => key)
      .sort(),
    ...(pageCount !== undefined ? { pageCount } : {})
  };
}

function hasSubstantiveDocumentAttributes(attributes: AttributeRecord[]): boolean {
  return attributes.some((attr) => !(attr.group === "PDF Document" && attr.name === "Parsed document"));
}

function dedupeCustomerAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  const seen = new Set<string>();
  return attributes.filter((attr) => {
    const key = `${attr.group ?? ""}|${attr.name}|${attr.value}|${attr.sourceUrl ?? ""}`.toLowerCase();
    if (!attr.name || !attr.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  cache: CustomerDocumentParseCache,
  aliasSink?: Set<string>
): Promise<AttributeRecord[]> {
  const sheets = await cache.getWorkbookMatrices(doc);
  const attributes: AttributeRecord[] = [];
  for (const sheet of sheets) {
    attributes.push(...attributesFromMatrix(sheet.rows, catalogNumber, `${doc.originalName} / ${sheet.sheet}`, pathToFileUrl(doc.storedPath), aliasSink));
  }
  return attributes;
}

async function extractFromCsv(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  cache: CustomerDocumentParseCache,
  aliasSink?: Set<string>
): Promise<AttributeRecord[]> {
  const matrix = await cache.getCsvMatrix(doc);
  return attributesFromMatrix(matrix, catalogNumber, doc.originalName, pathToFileUrl(doc.storedPath), aliasSink);
}

async function extractFromTextDocument(
  catalogNumber: string,
  doc: CustomerDocumentRecord,
  extension: string,
  options: { requireCatalogMatch?: boolean } = {}
): Promise<AttributeRecord[]> {
  const raw = await fs.readFile(doc.storedPath, "utf8");
  const text = customerTextDocumentToPlainText(raw, extension).slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS);
  if (!cleanText(text)) return [];
  const textMentionsCatalog = catalogTextMatches(text, catalogNumber) || compactKey(text).includes(compactKey(catalogNumber));
  if (options.requireCatalogMatch && !textMentionsCatalog) return [];
  const scoped = textMentionsCatalog
    ? buildTightContextForCatalog(text, catalogNumber, { maxChars: MAX_CUSTOMER_PDF_TEXT_CHARS }) ?? text
    : text;
  const attributes = extractDocumentTextAttributes({
    catalogNumber,
    document: { label: doc.originalName, type: "other", url: pathToFileUrl(doc.storedPath), localPath: doc.storedPath },
    text: scoped
  });
  return hasSubstantiveDocumentAttributes(attributes) ? attributes : [];
}

async function extractFromDocxDocument(
  catalogNumber: string,
  doc: CustomerDocumentRecord
): Promise<AttributeRecord[]> {
  const buffer = await fs.readFile(doc.storedPath);
  const text = await customerDocxToPlainText(buffer);
  if (!cleanText(text)) return [];
  const textMentionsCatalog = catalogTextMatches(text, catalogNumber) || compactKey(text).includes(compactKey(catalogNumber));
  const scoped = textMentionsCatalog
    ? buildTightContextForCatalog(text, catalogNumber, { maxChars: MAX_CUSTOMER_PDF_TEXT_CHARS }) ?? text
    : text;
  const attributes = extractDocumentTextAttributes({
    catalogNumber,
    document: { label: doc.originalName, type: "other", url: pathToFileUrl(doc.storedPath), localPath: doc.storedPath },
    text: scoped.slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS)
  });
  return hasSubstantiveDocumentAttributes(attributes) ? attributes : [];
}

function isFreeTextCustomerDocumentExtension(extension: string): boolean {
  return [".txt", ".md", ".markdown", ".html", ".htm", ".json"].includes(extension);
}

function customerTextDocumentToPlainText(raw: string, extension: string): string {
  if (extension === ".json") {
    try {
      return flattenCustomerJsonText(JSON.parse(raw) as unknown).join("\n");
    } catch {
      return raw;
    }
  }
  if (extension === ".html" || extension === ".htm") {
    const withBreaks = raw
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(?:p|div|li|tr|td|th|section|article|h[1-6]|dt|dd)\s*>/gi, "\n");
    const $ = cheerio.load(withBreaks);
    $("script,style,noscript,template,svg").remove();
    return $.root().text();
  }
  return raw;
}

async function customerDocxToPlainText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const partNames = [
    "word/document.xml",
    ...Object.keys(zip.files)
      .filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  ];
  const parts: string[] = [];
  for (const name of partNames) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("string");
    const text = docxXmlToPlainText(xml);
    if (text) parts.push(text);
  }
  return parts.join("\n").slice(0, MAX_CUSTOMER_PDF_TEXT_CHARS);
}

function docxXmlToPlainText(xml: string): string {
  const chunks: string[] = [];
  let textDepth = 0;
  for (const token of xml.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith("<")) {
      const tagName = token.match(/^<\/?\s*([A-Za-z0-9_:.-]+)/)?.[1]?.toLowerCase() ?? "";
      const closing = /^<\//.test(token);
      const selfClosing = /\/\s*>$/.test(token);
      if (tagName === "w:t") {
        if (closing) textDepth = Math.max(0, textDepth - 1);
        else if (!selfClosing) textDepth += 1;
      }
      if (!closing && (tagName === "w:tab" || tagName === "w:br" || tagName === "w:cr")) {
        chunks.push(tagName === "w:tab" ? "\t" : "\n");
      }
      if (closing && tagName === "w:tc") chunks.push("\t");
      if (closing && (tagName === "w:p" || tagName === "w:tr")) chunks.push("\n");
      continue;
    }
    if (textDepth > 0) chunks.push(decodeXmlText(token));
  }
  return normalizeExtractedDocxText(chunks.join(""));
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeExtractedDocxText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/[ ]+/g, " ").replace(/[ \t]*\t+[ \t]*/g, "\t").trim())
    .filter(Boolean)
    .join("\n");
}

function flattenCustomerJsonText(value: unknown, prefix = ""): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => flattenCustomerJsonText(entry, prefix));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const label = cleanText([prefix, key].filter(Boolean).join(" "));
      if (entry === null || entry === undefined || typeof entry === "object") return flattenCustomerJsonText(entry, label);
      return [`${label} ${cleanText(String(entry))}`];
    });
  }
  const text = cleanText(String(value));
  return text ? [prefix ? `${prefix} ${text}` : text] : [];
}

function attributesFromMatrix(
  matrix: string[][],
  catalogNumber: string,
  group: string,
  sourceUrl: string,
  aliasSink?: Set<string>
): AttributeRecord[] {
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
    if (aliasSink) collectRowIdentifierAliases(row, header, headerLooksLikeHeader, catalogNumber, aliasSink);

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
      const rawValue = cleanText(row[colIndex] || "");
      if (!rawValue) continue;
      const columnName = headerLooksLikeHeader ? header[colIndex] || `Column ${colIndex + 1}` : `Column ${colIndex + 1}`;
      if (catalogTextMatches(rawValue, catalogNumber)) continue;
      if (rawValue.length > 600) continue;
      const value = headerLooksLikeHeader ? attachHeaderUnitToBareNumber(rawValue, unitFromColumnHeader(columnName)) : rawValue;
      attributes.push({ group: `Customer / ${group}`, name: columnName, value, sourceUrl });
      // Description cells routinely carry the product's nameplate ratings inline with no
      // label — "3AC 230V, 5.5kW, 20A, Profibus DP". The column attribute above keeps that
      // as one opaque blob ("Product Description"), which no field mapper can read, so the
      // customer's own current/power silently vanished from the output. Mine the cell for
      // pure unit-tagged segments and emit them as properly named spec attributes too.
      attributes.push(...extractInlineNameplateSpecAttributes(rawValue, sourceUrl, `Customer / ${group}`));
    }
  }

  return dedupeCustomerAttributes(attributes);
}

const MAX_IDENTIFIER_ALIASES = 6;
// Manufacturers routinely give one product two identifiers: an order/SKU number (what the
// customer's spreadsheet and the official website key on) and a separate "product model" /
// type code (what's printed on the device and inside PDF manuals/catalogs). A row that
// matched on the requested catalog number is exactly where we can read off that product's
// OTHER identifier, so later documents that never mention the requested number at all
// (e.g. a manual keyed purely by model) can still be searched using the alias.
const IDENTIFIER_ALIAS_HEADER_PATTERN = /\b(?:product\s*model|model(?:\s*(?:number|no\.?|code))?|type(?:\s*code)?|part\s*number|article(?:\s*number)?|catalog(?:ue)?\s*(?:number|no\.?)|order\s*number|sku)\b/i;

function collectRowIdentifierAliases(
  row: string[],
  header: string[],
  headerLooksLikeHeader: boolean,
  catalogNumber: string,
  sink: Set<string>
): void {
  for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
    if (sink.size >= MAX_IDENTIFIER_ALIASES) return;
    const value = cleanText(row[colIndex] || "");
    if (!value || catalogTextMatches(value, catalogNumber)) continue;
    const headerLabel = headerLooksLikeHeader ? header[colIndex] || "" : "";
    if (headerLooksLikeHeader && !IDENTIFIER_ALIAS_HEADER_PATTERN.test(headerLabel)) continue;
    if (!looksLikeIdentifierValue(value)) continue;
    sink.add(value);
  }
}

function looksLikeIdentifierValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 40) return false;
  if (/\s/.test(trimmed)) return false; // model/part numbers don't contain spaces
  return /[A-Za-z]/.test(trimmed) && /\d/.test(trimmed);
}

/**
 * Pre-scans every structured (workbook/CSV) customer document for a row matching the
 * requested catalog number, and collects any sibling identifier values found on that row
 * (see `IDENTIFIER_ALIAS_HEADER_PATTERN`). Cheap: matrices are cache-backed, so this reuses
 * whatever the main extraction pass loads. PDFs/docx/text documents are not scanned here —
 * they're the ones that benefit FROM the aliases, not the ones that produce them.
 */
async function collectIdentifierAliases(
  catalogNumber: string,
  customerDocuments: CustomerDocumentRecord[],
  cache: CustomerDocumentParseCache
): Promise<string[]> {
  const aliases = new Set<string>();
  for (const doc of customerDocuments) {
    if (!doc.storedPath || aliases.size >= MAX_IDENTIFIER_ALIASES) continue;
    let extension = path.extname(doc.originalName || doc.storedPath).toLowerCase();
    if (!extension) extension = path.extname(doc.storedPath).toLowerCase();
    try {
      if (extension === ".xlsx" || extension === ".xls") {
        await extractFromWorkbook(catalogNumber, doc, cache, aliases);
      } else if (extension === ".csv" || extension === ".tsv") {
        await extractFromCsv(catalogNumber, doc, cache, aliases);
      }
    } catch {
      // Ignore here — the main extraction pass will surface a proper parse-failure diagnostic.
    }
  }
  return [...aliases];
}

// Customer sheets routinely put the unit in the column header ("Weight (kg)",
// "Maximum Power Loss (W)") and leave the cell as a bare number ("0.89"). The
// normalizer's unit-aware parsers (normalizeWeightValue etc.) require the unit next to
// the number and silently drop bare numbers, so without this the customer's cleanest,
// most structured data (an explicit Excel column) was being discarded entirely.
const HEADER_UNIT_PATTERN = /\(([^()]{1,8})\)\s*$/;
const UNIT_TOKEN_CHARS = /^[a-zA-Zµ°%²³Ω/·-]+$/;
const BARE_NUMBER_PATTERN = /^-?\d+(?:[.,]\d+)?$/;

function unitFromColumnHeader(header: string): string | undefined {
  const match = header.match(HEADER_UNIT_PATTERN);
  if (!match) return undefined;
  const token = match[1].trim();
  if (!token || /\s/.test(token) || !UNIT_TOKEN_CHARS.test(token)) return undefined;
  return token;
}

function attachHeaderUnitToBareNumber(value: string, unit: string | undefined): string {
  if (!unit || !BARE_NUMBER_PATTERN.test(value)) return value;
  return `${value} ${unit}`;
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
    sourceType: attr.sourceType ?? "official",
    parser: attr.parser ?? "customer-document",
    stage: attr.stage ?? "customer-override",
    confidence: attr.confidence ?? CUSTOMER_DOC_CONFIDENCE
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
  const technicalFields = new Set<RegistryFieldKey>();
  let identityHits = 0;
  for (const attr of attributes) {
    const label = cleanText(`${attr.group ?? ""} ${attr.name}`);
    if (isCustomerDocumentIdentityLabel(label)) identityHits += 1;
    for (const field of FIELD_REGISTRY) {
      if (!isCustomerDatasheetTechnicalField(field.key)) continue;
      if (fieldMatchesLabel(field.key, label)) technicalFields.add(field.key);
    }
  }
  return identityHits >= 1 && technicalFields.size >= 3;
}

function isCustomerDatasheetTechnicalField(field: RegistryFieldKey): boolean {
  return isCustomerOverrideField(field) && field !== "typeCode";
}

function isCustomerDocumentIdentityLabel(label: string): boolean {
  return fieldMatchesLabel("typeCode", label) || /\b(?:product\s+(?:type|name|short\s+text)|description|designation|model)\b/i.test(label);
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
