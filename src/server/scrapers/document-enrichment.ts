import { dedupeAttributes as dedupeAttributesBase, dedupeSources } from "./dedupe.js";
import { uniqueStrings as uniqueStringsBase } from "../text-util.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { TableArray } from "pdf-parse";
import type { AttributeRecord, DocumentProcessingDiagnostic, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { cleanText, normalizeFields, splitNameValue } from "./normalizer.js";
import { catalogTextMatches, findCatalogTextMatch, sameCatalogNumber, type CatalogMatchLevel } from "./catalog-number.js";
import { buildTightContextForCatalog, buildVariantColumnContext } from "./tight-context.js";
import { listTechnicalAttributeAliases } from "./technical-attribute-aliases.js";
import { inferOcrLanguage, pdfPagesNeedingOcr, readPdfWithOptionalOcr, type OcrPositionedItem } from "./pdf-ocr.js";
import { isPdfLikeDocumentUrl } from "./document-url.js";
import { fieldMatchesLabel, FIELD_REGISTRY, listFieldRegistryDocumentLabels, type RegistryFieldKey } from "./field-registry.js";
import { extractElectricalSpecAttributesFromText, extractOntologySpecAttributesFromText } from "./electrical-spec-miner.js";
import { extractComplianceMatrixAttributes, textHasComplianceMatrixGlyphs } from "./pdf-compliance-matrix.js";
import { extractPositionedTableRows, extractPositionedTableRowsFromPages, extractPositionedTableRowsFromPdf, positionedItemOrientationFromTransform, type PositionedTextItem } from "./pdf-positioned-table.js";
import { catalogTableKeyFor, isCatalogIdHeaderCell, isCatalogTableHeaderText } from "./catalog-table-vocabulary.js";
import { orderingCodeLegendValue } from "./ordering-code-legend.js";
import { inferEatonRapidLinkOrderingRows } from "./eaton-ordering-inference.js";
import { isPlausibleSpecLabel, isPlausibleSpecValue, looksLikeHeaderRowValue, specPlausibilityGateDisabled } from "./spec-plausibility.js";
import { looksLikeUnderstandableSpec } from "./ontology.js";

const MAX_PDF_PAGES = 30;
const MAX_PDF_TEXT_CHARS = 250_000;
// Large multi-model technical-data PDFs (e.g. Rockwell 1783-td002 covers every
// Stratix 2100 variant). Parsing only the first 30 pages can either miss the
// section for the requested catalog number or mix specs from other models. The
// targeted reader walks every page cheaply, locates the page range that mentions
// the catalog number, and returns just those pages plus a small neighbour window.
const TARGETED_PDF_MAX_PAGES = 200;
const TARGETED_PDF_NEIGHBOUR_PAGES = 1;
const TARGETED_PDF_MAX_SECTION_PAGES = 12;
const TARGETED_PDF_MAX_GLOBAL_TECHNICAL_PAGES = 6;
/** How far from our catalog's own pages a shared technical page may sit and still be considered part
 * of the same family section (see selectGlobalTechnicalPages). Kept tight on purpose: a family's own
 * spec page is normally 1-3 pages from its ordering table, while the NEXT family's spec page is only
 * a little further (Eaton's E6 catalogue: ours on 4, the next family's on 12, ordering table on 6).
 * Erring narrow leaves a field empty; erring wide fills it with another family's value. */
const TARGETED_PDF_TECHNICAL_PAGE_MAX_DISTANCE = 4;
const TARGETED_PDF_NEAR_TECHNICAL_PAGES = 3;
const PDF_TEXT_MIN_CHARS_FOR_PARSE = 80;
const FULL_PDF_TEXT_CACHE_MAX_FILE_BYTES = 8 * 1024 * 1024;
const FULL_PDF_TEXT_CACHE_MAX_ENTRIES = 16;

interface PdfDocumentText {
  text: string;
  tables: TableArray[];
  /** OCR bbox rows, preserved only when the OCR quality gate accepted the page. */
  ocrPositionedItems?: PositionedTextItem[];
  /** Page numbers the text was scoped to, for diagnostics. Undefined when the whole document was read. */
  pagesUsed?: number[];
  pageCount?: number;
  /** True when MAX_PDF_TEXT_CHARS cut the text — otherwise "not in this document" and "truncated away" look identical. */
  truncated?: boolean;
  /**
   * Native (non-OCR) positioned text items for EVERY page of the source document (never scoped to
   * `pagesUsed` — the positioned-table reader needs full-document page order for its
   * carried-header/new-table-boundary logic, the same as it always has). Only present when this
   * document went through the cached small/medium-file page-set path (`readCachedPdfPageSetIfEligible`);
   * lets `extractPositionedWeightDimensionsSafely` reuse the SAME pdfjs parse `pdf-parse` already did
   * instead of a second full `pdfjs.getDocument()` pass — confirmed live at ~30-45% of a document's
   * total processing time on real Saginaw/SCE accessory manuals. Undefined is a safe, silent
   * fallback to the old file-reopen behavior, never a correctness difference.
   */
  nativePositionedItemsByPage?: Map<number, PositionedTextItem[]>;
}

/**
 * One PDF parsed once per file: per-page text plus per-page vector-grid tables.
 *
 * This replaced a whole-document text cache that returned BEFORE the targeted page reader ran, which
 * made page targeting dead code for every PDF under 8 MB — i.e. for virtually every datasheet and
 * most family catalogs (a 57-page, 2.9 MB catalog was read as one 250k-char blob, so the only defence
 * against mixing variants was the line/column windows). Caching PAGES instead of joined text keeps
 * the one-parse-per-file saving the cache was added for AND lets each catalog number pick its own
 * pages out of the cached set.
 */
interface PdfPageSet {
  pages: Array<{ num: number; text: string }>;
  tablesByPage: Map<number, TableArray[]>;
  ocrPositionedItemsByPage: Map<number, PositionedTextItem[]>;
  /** See `PdfDocumentText.nativePositionedItemsByPage` — captured from the same pdfjs document
   * `pdf-parse` already loaded for this page set, when that document could be recovered. */
  nativePositionedItemsByPage?: Map<number, PositionedTextItem[]>;
  /** OCR output has no reliable page structure, so targeting is skipped for it. */
  fromOcr: boolean;
}

const pdfPageSetCache = new Map<string, Promise<PdfPageSet>>();
const normalizedPdfLinesCache = new Map<string, string[]>();
const globalPdfAttributeCache = new Map<string, AttributeRecord[]>();
const globalPdfTechnicalAttributeCache = new Map<string, AttributeRecord[]>();
const catalogOrderingTableCache = new Map<string, CatalogOrderingIndex>();
const patternModelPhysicalTableCache = new Map<string, PatternModelPhysicalIndex>();
const catalogMatchedRowsCache = new Map<string, CatalogMatchedRowsIndex>();

const BASE_KNOWN_LABELS = [
  // Packaging quantity, as printed in ordering tables ("Unit per package 12"). Real vocabulary, so
  // it is extracted rather than dropped — and it also completes the header-row detection in
  // spec-plausibility.ts, which can only recognise a header row when it knows EVERY cell in it.
  "Unit per package",
  "Units per package",
  "Packaging unit",
  "Package quantity",
  "Quantity per package",
  "Approximate shipping weight",
  "Approval/Conformity",
  "Cable jacket, material",
  "Cable length L",
  "Catalog Number",
  "Certifications",
  "Circuit breaker frame type",
  "Connection type",
  "Conditional rated short-circuit current Iq",
  "Current ratings",
  "Degree of protection",
  "Dimensions (HxWxD), approx.",
  "Dimensions HxWxD",
  "Dimensions/Weight",
  "Enclosure color",
  "Enclosure material",
  "Enclosure type rating",
  "Environmental rating",
  "External dimensions",
  "Frame size",
  "Frequency rating",
  "Gross weight",
  "Height",
  "Heat dissipation",
  "HP rating - max",
  "Housing material",
  "Input current",
  "Input current, max",
  "Input nominal current",
  "Input nominal voltage",
  "Input voltage",
  "Input voltage range",
  "Inrush current",
  "Interrupt rating",
  "Interrupt rating range",
  "Isolation voltage",
  "IP rating",
  "Length",
  "Mass",
  "Material",
  "Material contact carrier",
  "Material contacts",
  "Material cover nut",
  "Material grip",
  "Model Code",
  "Mounting Method",
  "NEMA rating",
  "Nominal current",
  "Nominal voltage",
  "Net weight",
  "Number of poles",
  "Operating current",
  "Operating temperature",
  "Operating voltage Ub",
  "Overall dimensions",
  "Output current",
  "Output current rating",
  "Output voltage",
  "Output voltage range",
  "Power consumption",
  "Power dissipation",
  "Power dissipation, typical",
  "Power dissipation in W",
  "Power dissipation per pole",
  "Power input",
  "Power input, max",
  "Power loss",
  "Power loss per pole",
  "Power loss Pv",
  "Program memory",
  "Product Weight",
  "Product Height",
  "Product Width",
  "Product Length/Depth",
  "Product net weight",
  "Produktgewicht",
  "Produkthöhe",
  "Produktbreite",
  "Produkt Länge/Tiefe",
  "Katalognummer",
  "Modellcode",
  "Produktname",
  "Oberflächenausführung",
  "Protection class",
  "Protection rating",
  "Rated conditional short-circuit current",
  "Rated conditional short-circuit current (Iq)",
  "Rated conditional short-circuit current Iq",
  "Rated current for power loss specification",
  "Rated impulse withstand voltage",
  "Rated insulation voltage",
  "Rated operation current (Ie)",
  "Rated operating current",
  "DC rated operating current Ie",
  "DC rated operating current",
  "Rated operating voltage",
  "Rated operational current",
  "Rated operational current for specified heat dissipation (In)",
  "Rated operational voltage",
  "Rated operational voltage (Ue) - max",
  "Rated current (40 °C)",
  "Rated current (40 Â°C)",
  "Rated output current",
  "Rated output voltage",
  "Removable terminal block power rating",
  "Rated supply voltage",
  "Rated service short-circuit breaking capacity",
  "Rated short-circuit breaking capacity",
  "Rated ultimate short-circuit breaking capacity",
  "Rated voltage",
  "SCCR",
  "Shipping weight",
  "Size",
  "Short Circuit Current Rating (SCCR)",
  "Standards, directives and approvals",
  "Approvals and certificates",
  "UL Certificate",
  "Storage temperature",
  "Static heat dissipation, non-current-dependent Pvs",
  "Supply voltage",
  "Supply voltage range",
  "Safety memory",
  "Memory",
  "Local I/O support",
  "Number of local I/O modules",
  "EtherNet/IP nodes",
  "OPC UA nodes",
  "Communication ports",
  "Ethernet ports",
  "USB port",
  "Field power voltage",
  "Field power voltage range",
  "Field power current",
  "Module power consumption",
  "Module power dissipation",
  "Backplane current",
  "Current draw",
  "Current draw at 24V DC",
  "Current draw @ 24V DC",
  "On-state voltage drop",
  "Off-state leakage current",
  "Off-state leakage",
  "Thermal dissipation",
  "Surface finishing",
  "Thermal dissipation",
  "Trip Type",
  "Unit weight",
  "Utilization category",
  "Voltage rating",
  "Voltage rating - max",
  "Voltage type",
  "Weight",
  "Weight, approx.",
  "Width",
  "Wire cross-section",
  "Wire size",
  "Tightening torque",
  // Doepke technical-data rows confirmed present in the datasheet but not reliably split into
  // clean attributes without an exact-prefix KNOWN_LABELS entry (found via a full field-coverage
  // audit across 340+ cached datasheets — see doepke-pdt-field-conventions memory).
  "Tripping characteristic curve",
  "Tripping characteristic",
  "Climate resistance",
  "Non-trip time",
  "Tripping frequency",
  "Internal consumption",
  "min. Contact opening",
  "Rated frequency",
  "Thermal Backup-fuse OCPD",
  "Short-circuit backup-fuse SCPD",
  "Back-up fuse type",
  "I2t strength",
  "Screw-type terminal",
  "Neutral conductor position",
  "Operating position",
  "mechanical endurance",
  "electrical endurance",
  "Shock resistance",
  "Fatigue limit",
  "sealable",
  "Module widths",
  "Degree of pollution",
  "Housing type",
  "Installation type"
];

const KNOWN_LABELS = uniqueKnownLabels([
  ...listFieldRegistryDocumentLabels(),
  ...BASE_KNOWN_LABELS,
  ...listTechnicalAttributeAliases()
    .map((alias) => alias.originalName)
    .filter(isUsefulTechnicalAliasPdfLabel)
]).sort((left, right) => right.length - left.length);

/**
 * Documents in a batch are independent, CPU-bound PDF parses (no shared mutable state, no network
 * side effects — that's remote document probing, handled separately). Real corpus evidence: a single
 * Saginaw enclosure catalog with 11 accessory-manual PDFs took 10.1s sequential (`_tmp-bench-docs.ts`,
 * `SCE-12EL1206LP`, none of them cross `shouldSkipAfterStrongDocumentEvidence`'s threshold, so all 11
 * genuinely need to run). Batching bounds the parallelism instead of firing every document at once —
 * catalogs already run with their own concurrency (default 3, up to 8), and each parallel catalog's
 * documents stacking unbounded on top would oversubscribe the machine instead of speeding runs up.
 */
const DOWNLOADED_DOCUMENT_BATCH_SIZE = 3;

interface DownloadedDocumentOutcome {
  doc: DocumentRecord;
  attributes: AttributeRecord[];
  source?: SourceRecord;
  processing: DocumentProcessingDiagnostic;
  parseFailure?: string;
}

async function processOneDownloadedDocument(doc: DocumentRecord, catalogNumber: string): Promise<DownloadedDocumentOutcome> {
  const started = Date.now();
  if (!shouldParsePdfDocument(doc)) {
    return {
      doc: { ...doc, parseStatus: doc.parseStatus ?? (doc.localPath ? "skipped" : undefined) },
      attributes: [],
      processing: documentProcessingRecord(doc, "downloaded-document-enrichment", "skipped", downloadedDocumentSkipReason(doc))
    };
  }
  try {
    const pdfText = await readPdfText(doc.localPath!, catalogNumber, doc.url);
    const { text, tables } = pdfText;
    // Multi-model PDFs need target scoping, but some catalogs keep shared technical
    // pages away from the catalog table. Keep both the target rows and global spec rows.
    const scope = buildDocumentParseScope(text, catalogNumber);
    // Balluff's exact product datasheets are addressed by a product-specific publication id,
    // but often contain only the full type code (not the short catalog number used by the PDP,
    // e.g. BIS00Z5). The URL is already selected from that exact official PDP, so allowing the
    // normal technical sweep here is safe and preserves dimensions/weight from the authoritative PDF.
    const balluffExactDatasheet = doc.type === "datasheet" && /(^|:)\/\/publications\.balluff\.com\/pdfengine\/pdf(?:[/?#]|$)/i.test(doc.url);
    let attributes = [
      ...extractDocumentTextAttributes({
        catalogNumber,
        document: doc,
        text: balluffExactDatasheet ? text : scope.text,
        tables,
          scopeUnresolved: !scope.resolved && !balluffExactDatasheet,
        matchLevel: scope.match?.level
      }),
      ...extractOcrPositionedTableAttributes(pdfText.ocrPositionedItems, catalogNumber, doc.url),
      ...(await extractComplianceMatrixAttributesSafely(text, doc.localPath!, catalogNumber, doc.url))
    ];
    const positionedAttributes = await extractPositionedWeightDimensionsSafely(doc.localPath!, catalogNumber, doc.url, attributes, looksLikeMultiVariantFamilyPage(text, catalogNumber), pdfText.nativePositionedItemsByPage);
    attributes.push(...positionedAttributes);
    attributes = discardUnscopedFamilyTableCandidates(attributes, catalogNumber, positionedAttributes);
    const substantive = documentAttributesAreSubstantive(attributes);
    return {
      doc: { ...doc, parseStatus: substantive ? "parsed" : "skipped", parseError: undefined },
      attributes,
      source: attributes.length > 0
        ? { url: doc.url, sourceType: "generated", parser: "pdf-table-extractor", stage: "enrich-documents", reason: doc.type, fetchedAt: new Date().toISOString() }
        : undefined,
      processing: documentProcessingRecord(
        doc,
        "downloaded-document-enrichment",
        substantive ? "parsed" : "skipped",
        (substantive
          ? `Parsed ${attributes.length} attribute records from downloaded PDF.`
          : "Opened downloaded PDF, but no source-backed product attributes were extracted.") +
          describePdfScope(pdfText) +
          (scope.resolved
            ? ""
            : " [multi-variant document; nothing in it locates this catalog number, so catalog-agnostic sweeps were suppressed]"),
        undefined,
        documentExtractionMetrics(attributes, [doc], Date.now() - started, pdfText)
      )
    };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : "PDF parse failed";
    return {
      doc: { ...doc, parseStatus: "failed", parseError },
      attributes: [],
      processing: documentProcessingRecord(doc, "downloaded-document-enrichment", "failed", "Downloaded PDF parse failed.", parseError, { elapsedMs: Date.now() - started }),
      parseFailure: `${doc.label || doc.url}: ${parseError}`
    };
  }
}

export async function enrichResultFromDownloadedDocuments(result: ProductResult): Promise<ProductResult> {
  const documentAttributes: AttributeRecord[] = [];
  const documentSources: SourceRecord[] = [];
  const documentParseFailures: string[] = [];
  const documentProcessing: DocumentProcessingDiagnostic[] = [];
  const documents: DocumentRecord[] = [];

  const prioritized = prioritizeDownloadedDocuments(result.documents);
  // Parse an authoritative datasheet on its own before launching large manuals in parallel. A
  // datasheet commonly contains the complete product specification; once it has supplied strong
  // evidence, lower-priority manuals are skipped by shouldSkipAfterStrongDocumentEvidence. Keeping
  // the first batch single-document preserves that optimization without slowing catalogs whose
  // first document is not a datasheet or whose datasheet is genuinely incomplete.
  let start = 0;
  let batchSize = prioritized[0]?.type === "datasheet" ? 1 : DOWNLOADED_DOCUMENT_BATCH_SIZE;
  while (start < prioritized.length) {
    const batch = prioritized.slice(start, start + batchSize);
    // The strong-evidence skip is a real optimization (datasheet already covers everything, don't
    // bother parsing ten accessory manuals) and stays evidence-so-far ordered: it is checked once per
    // batch member against everything FULLY COMPLETED in earlier batches, same as the old one-at-a-
    // time loop. The only behavior difference is bounded to inside a single batch: a document that
    // would have been skipped because an earlier document IN THE SAME BATCH just crossed the
    // threshold now still runs (parallel, so it cost no extra wall time) instead of being skipped —
    // never a correctness issue (extra corroborating evidence, not conflicting data), only ever a
    // few PDFs' worth of otherwise-idle CPU, bounded by DOWNLOADED_DOCUMENT_BATCH_SIZE.
    const toProcess: DocumentRecord[] = [];
    for (const doc of batch) {
      if (shouldSkipAfterStrongDocumentEvidence(doc, documentAttributes)) {
        documentProcessing.push(documentProcessingRecord(doc, "downloaded-document-enrichment", "skipped", "Skipped lower-priority document because a datasheet/catalog already supplied strong product attributes."));
        documents.push({ ...doc, parseStatus: doc.parseStatus ?? "skipped" });
      } else {
        toProcess.push(doc);
      }
    }
    if (!toProcess.length) {
      start += batchSize;
      batchSize = DOWNLOADED_DOCUMENT_BATCH_SIZE;
      continue;
    }
    const outcomes = await Promise.all(toProcess.map((doc) => processOneDownloadedDocument(doc, result.catalogNumber)));
    for (const outcome of outcomes) {
      documents.push(outcome.doc);
      documentProcessing.push(outcome.processing);
      if (outcome.parseFailure) documentParseFailures.push(outcome.parseFailure);
      if (outcome.attributes.length > 0) {
        documentAttributes.push(...stampDocumentAttributes(outcome.attributes));
        if (outcome.source) documentSources.push(outcome.source);
      }
    }
    start += batchSize;
    batchSize = DOWNLOADED_DOCUMENT_BATCH_SIZE;
  }

  if (!documentAttributes.length) {
    return {
      ...result,
      diagnostics: withDocumentDiagnostics(result, documentParseFailures, documentProcessing),
      documents
    };
  }

  const attributes = dedupeAttributes([...result.attributes, ...documentAttributes]);
  // normalizeFields(attributes, ...) already recomputes over attributes' FULL union (result.attributes
  // + the new document-derived ones), so its own confidence-aware field arbitration (see
  // normalizeFields in normalizer.ts) has already weighed a pre-existing value against anything the
  // documents just added. Spreading the STALE result.normalized last used to let it unconditionally
  // win over that recomputation whenever it was merely non-empty — confirmed live on Rockwell's
  // 1606-XLSBAT5: result.normalized.dimensions was already set (wrong, packaging-box dims from the
  // DPP) before document enrichment ran, so it kept overriding the freshly recomputed, CORRECT
  // dimensions the datasheet PDF's own catalog table just supplied, even though normalizeFields
  // itself had already picked the better one. Recomputed wins when it found something; the stale
  // value is now only a fallback for whichever fields recomputation still left empty (e.g. any field
  // set outside the `attributes` array entirely).
  const normalized = {
    ...nonEmptyNormalized(result.normalized),
    ...nonEmptyNormalized(normalizeFields(attributes, documents))
  };

  return {
    ...result,
    status: result.status === "failed" ? result.status : "found",
    diagnostics: withDocumentDiagnostics(result, documentParseFailures, documentProcessing),
    normalized,
    attributes,
    documents,
    sources: dedupeSources([...result.sources, ...documentSources])
  };
}

export async function enrichResultFromRemoteDocuments(
  result: ProductResult,
  fetchDocument: (document: DocumentRecord) => Promise<{ localPath: string; url?: string; cleanup?: () => Promise<void> }>,
  options: { maxDocuments?: number } = {}
): Promise<ProductResult> {
  const documentAttributes: AttributeRecord[] = [];
  const documentSources: SourceRecord[] = [];
  const documentParseFailures: string[] = [];
  const documentProcessing: DocumentProcessingDiagnostic[] = [];
  const documents: DocumentRecord[] = [];
  const maxDocuments = options.maxDocuments ?? 4;
  let parsedDocuments = 0;

  for (const doc of prioritizeRemoteProbeDocuments(result.documents)) {
    const started = Date.now();
    if (shouldSkipAfterStrongDocumentEvidence(doc, documentAttributes)) {
      documentProcessing.push(documentProcessingRecord(doc, "remote-document-enrichment", "skipped", "Skipped lower-priority remote document because a datasheet/catalog already supplied strong product attributes."));
      documents.push({ ...doc, parseStatus: doc.parseStatus ?? "skipped" });
      continue;
    }
    if (parsedDocuments >= maxDocuments) {
      documentProcessing.push(documentProcessingRecord(doc, "remote-document-enrichment", "skipped", `Skipped after parsing ${maxDocuments} remote document${maxDocuments === 1 ? "" : "s"} for this product.`));
      documents.push(doc);
      continue;
    }
    const probeDoc = remoteProbeDocumentCandidate(doc);
    if (!probeDoc) {
      documentProcessing.push(documentProcessingRecord(doc, "remote-document-enrichment", "skipped", remoteDocumentSkipReason(doc)));
      documents.push(doc);
      continue;
    }
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const fetched = await fetchDocument(probeDoc);
      cleanup = fetched.cleanup;
      const parsedDoc = fetched.url ? { ...probeDoc, url: fetched.url } : probeDoc;
      const pdfText = await readPdfText(fetched.localPath, result.catalogNumber, parsedDoc.url);
      const { text, tables } = pdfText;
      const scope = buildDocumentParseScope(text, result.catalogNumber);
      const balluffExactDatasheet = doc.type === "datasheet" && /(^|:)\/\/publications\.balluff\.com\/pdfengine\/pdf(?:[/?#]|$)/i.test(doc.url);
      let attributes = [
        ...extractDocumentTextAttributes({
          catalogNumber: result.catalogNumber,
          document: parsedDoc,
          text: balluffExactDatasheet ? text : scope.text,
          tables,
        scopeUnresolved: !scope.resolved && !balluffExactDatasheet,
          matchLevel: scope.match?.level
        }),
        ...extractOcrPositionedTableAttributes(pdfText.ocrPositionedItems, result.catalogNumber, parsedDoc.url),
        ...(await extractComplianceMatrixAttributesSafely(text, fetched.localPath, result.catalogNumber, parsedDoc.url))
      ];
      const positionedAttributes = await extractPositionedWeightDimensionsSafely(fetched.localPath, result.catalogNumber, parsedDoc.url, attributes, looksLikeMultiVariantFamilyPage(text, result.catalogNumber), pdfText.nativePositionedItemsByPage);
      attributes.push(...positionedAttributes);
      attributes = discardUnscopedFamilyTableCandidates(attributes, result.catalogNumber, positionedAttributes);
      if (attributes.length > 0) {
        documentAttributes.push(...stampDocumentAttributes(attributes));
        documentSources.push({
          url: parsedDoc.url,
          sourceType: "generated",
          parser: "pdf-table-extractor",
          stage: "probe-remote-documents",
          reason: doc.type,
          fetchedAt: new Date().toISOString()
        });
      }
      const substantive = documentAttributesAreSubstantive(attributes);
      documents.push({ ...parsedDoc, parseStatus: substantive ? "parsed" : "skipped", parseError: undefined });
      documentProcessing.push(documentProcessingRecord(
        parsedDoc,
        "remote-document-enrichment",
        substantive ? "parsed" : "skipped",
        substantive ? `Fetched and parsed ${attributes.length} attribute records from remote PDF.` : "Fetched remote PDF, but no source-backed product attributes were extracted.",
        undefined,
        documentExtractionMetrics(attributes, [parsedDoc], Date.now() - started)
      ));
      parsedDocuments += 1;
    } catch (error) {
      const parseError = error instanceof Error ? error.message : "PDF parse failed";
      documentParseFailures.push(`${doc.label || doc.url}: ${parseError}`);
      documents.push({ ...doc, parseStatus: "failed", parseError });
      documentProcessing.push(documentProcessingRecord(doc, "remote-document-enrichment", "failed", "Remote PDF probe failed.", parseError, { elapsedMs: Date.now() - started }));
    } finally {
      await cleanup?.().catch(() => undefined);
    }
  }

  if (!documentAttributes.length) {
    return {
      ...result,
      diagnostics: withDocumentDiagnostics(result, documentParseFailures, documentProcessing),
      documents
    };
  }

  const attributes = dedupeAttributes([...result.attributes, ...documentAttributes]);
  // normalizeFields(attributes, ...) already recomputes over attributes' FULL union (result.attributes
  // + the new document-derived ones), so its own confidence-aware field arbitration (see
  // normalizeFields in normalizer.ts) has already weighed a pre-existing value against anything the
  // documents just added. Spreading the STALE result.normalized last used to let it unconditionally
  // win over that recomputation whenever it was merely non-empty — confirmed live on Rockwell's
  // 1606-XLSBAT5: result.normalized.dimensions was already set (wrong, packaging-box dims from the
  // DPP) before document enrichment ran, so it kept overriding the freshly recomputed, CORRECT
  // dimensions the datasheet PDF's own catalog table just supplied, even though normalizeFields
  // itself had already picked the better one. Recomputed wins when it found something; the stale
  // value is now only a fallback for whichever fields recomputation still left empty (e.g. any field
  // set outside the `attributes` array entirely).
  const normalized = {
    ...nonEmptyNormalized(result.normalized),
    ...nonEmptyNormalized(normalizeFields(attributes, documents))
  };

  return {
    ...result,
    status: result.status === "failed" ? result.status : "found",
    diagnostics: {
      ...withDocumentDiagnostics(result, documentParseFailures, documentProcessing),
      fallbackStages: uniqueStrings([...(result.diagnostics?.fallbackStages ?? []), "remote-document-enrichment"]),
      notes: uniqueStrings([
        ...(result.diagnostics?.notes ?? []),
        `Remote document enrichment parsed ${parsedDocuments} datasheet/manual document${parsedDocuments === 1 ? "" : "s"} for missing data.`
      ]).slice(0, 50)
    },
    normalized,
    attributes,
    documents,
    sources: dedupeSources([...result.sources, ...documentSources])
  };
}

function withDocumentDiagnostics(
  result: ProductResult,
  documentParseFailures: string[],
  documentProcessing: DocumentProcessingDiagnostic[]
): ProductResult["diagnostics"] {
  return {
    ...result.diagnostics,
    ...(documentParseFailures.length
      ? {
          documentParseFailures: [
            ...(result.diagnostics?.documentParseFailures ?? []),
            ...documentParseFailures
          ].slice(0, 50)
        }
      : {}),
    ...(documentProcessing.length
      ? {
          documentProcessing: [
            ...(result.diagnostics?.documentProcessing ?? []),
            ...documentProcessing
          ].slice(-120)
        }
      : {})
  };
}

function documentProcessingRecord(
  doc: DocumentRecord,
  stage: DocumentProcessingDiagnostic["stage"],
  action: DocumentProcessingDiagnostic["action"],
  reason: string,
  parseError?: string,
  metrics: Partial<Pick<DocumentProcessingDiagnostic, "attributeCount" | "normalizedFields" | "pageCount" | "elapsedMs">> = {}
): DocumentProcessingDiagnostic {
  return {
    url: doc.url,
    label: doc.label,
    type: doc.type,
    action,
    stage,
    reason,
    ...metrics,
    localPath: doc.localPath,
    sourceUrl: doc.sourceUrl,
    parseError
  };
}

function documentExtractionMetrics(
  attributes: AttributeRecord[],
  documents: DocumentRecord[],
  elapsedMs?: number,
  pdfText?: PdfDocumentText
): Pick<DocumentProcessingDiagnostic, "attributeCount" | "normalizedFields" | "elapsedMs" | "pageCount"> {
  return {
    attributeCount: attributes.length,
    normalizedFields: normalizedFieldNames(normalizeFields(attributes, documents)),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(pdfText?.pageCount !== undefined ? { pageCount: pdfText.pageCount } : {})
  };
}

/**
 * Human-readable note about WHICH pages were read and whether text was cut.
 *
 * Without this, "the value isn't in this document" and "the value was on a page we never read" and
 * "the text was truncated at MAX_PDF_TEXT_CHARS before we got there" all look identical in the
 * diagnostics — three causes needing three completely different fixes.
 */
function describePdfScope(pdfText: PdfDocumentText): string {
  const parts: string[] = [];
  if (pdfText.pagesUsed?.length && pdfText.pageCount) {
    parts.push(
      pdfText.pagesUsed.length === pdfText.pageCount
        ? `read all ${pdfText.pageCount} pages`
        : `read ${pdfText.pagesUsed.length}/${pdfText.pageCount} pages (${summarizePageRanges(pdfText.pagesUsed)})`
    );
  }
  if (pdfText.truncated) parts.push(`text truncated at ${MAX_PDF_TEXT_CHARS} chars`);
  return parts.length ? ` [${parts.join("; ")}]` : "";
}

function summarizePageRanges(pages: number[]): string {
  const sorted = [...pages].sort((left, right) => left - right);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const page of sorted.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  if (start !== undefined) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(",");
}

function normalizedFieldNames(normalized: ProductResult["normalized"]): string[] {
  return Object.entries(normalized)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key]) => key)
    .sort();
}

function downloadedDocumentSkipReason(doc: DocumentRecord): string {
  if (doc.enrichable === false) return "Skipped because the connector marked this document non-enrichable (link kept, but its content is a multi-variant/multi-language catalog that would corrupt web-page facts).";
  if (doc.downloadStatus && doc.downloadStatus !== "downloaded") return `Skipped because downloadStatus is '${doc.downloadStatus}': ${doc.downloadError ?? "no downloaded PDF available"}.`;
  if (!doc.localPath) return "Skipped because no local downloaded file path is available.";
  if (!/\.pdf$/i.test(doc.localPath) && !isPdfLikeDocumentUrl(doc.url)) return "Skipped because the downloaded local file is not a PDF.";
  if (!["datasheet", "certificate", "manual", "other"].includes(doc.type)) return `Skipped because document type '${doc.type}' is not parsed by PDF enrichment.`;
  return "Skipped by PDF enrichment policy.";
}

function remoteDocumentSkipReason(doc: DocumentRecord): string {
  if (doc.enrichable === false) return "Skipped because the connector marked this document non-enrichable (link kept, but its content is a multi-variant/multi-language catalog that would corrupt web-page facts).";
  if (doc.localPath || doc.parseStatus === "parsed") return "Skipped because the document is already local or already parsed.";
  if (doc.downloadStatus === "failed") return `Skipped because the document download previously failed: ${doc.downloadError ?? "unknown error"}.`;
  if (!["datasheet", "manual", "other"].includes(doc.type)) return `Skipped because document type '${doc.type}' is not a remote PDF enrichment candidate.`;
  const text = `${doc.type} ${doc.label} ${doc.url}`;
  if (doc.type === "other" && !/\b(?:data\s*sheet|datasheet|technical|spec(?:ification)?|manual|installation|instruction)\b/i.test(text)) {
    return "Skipped because generic document did not look like a datasheet or manual.";
  }
  if (!isPdfLikeDocumentUrl(doc.url)) return "Skipped because URL was not recognized as a PDF-like document endpoint.";
  return "Skipped by remote PDF enrichment policy.";
}

export function extractDocumentTextAttributes(input: {
  catalogNumber: string;
  document: Pick<DocumentRecord, "label" | "type" | "url" | "localPath">;
  text: string;
  tables?: TableArray[];
  /**
   * Set when nothing in the document actually locates this catalog number (see buildDocumentParseScope).
   * The catalog-agnostic sweeps are then skipped: with no scope they attribute whatever the document
   * happens to say to whichever product was asked for.
   */
  scopeUnresolved?: boolean;
  /** A family prefix proves shared-document context, never a selected product row. */
  matchLevel?: CatalogMatchLevel;
}): AttributeRecord[] {
  const sourceUrl = input.document.url;
  const lines = cachedNormalizedPdfLines(input.text, sourceUrl);
  const orderingAttributes = extractCatalogOrderingTableRows(lines, input.catalogNumber, sourceUrl);
  const hasStructuredOrderingRow = orderingAttributes.some((attr) => attr.name === "Catalog Number");
  // With no resolved scope, the catalog-agnostic sweeps are the dangerous ones: they read the whole
  // document and hand everything to whichever catalog number was asked for. The catalog-VERIFIED readers
  // below still run — if one of them can find a row that is provably ours, that is exactly the evidence
  // that was missing, and it is welcome.
  const sweepsAllowed = !input.scopeUnresolved;
  const familyOnly = input.matchLevel === "family";
  const attributes =
    hasStructuredOrderingRow || !sweepsAllowed
      ? [parsedDocumentAttribute(input.document, sourceUrl)]
      : cachedGlobalPdfAttributes(input.document, input.text, lines, sourceUrl);

  const productSpecificAttributes = [
    ...(familyOnly ? [] : orderingAttributes),
    ...(sweepsAllowed ? cachedGlobalPdfTechnicalAttributes(input.text, lines, sourceUrl, input.catalogNumber) : []),
    ...(familyOnly ? [] : extractPatternModelPhysicalRows(lines, input.catalogNumber, sourceUrl)),
    // These two are NOT suppressed by a structured ordering row, unlike the sweeps below.
    //
    // `hasStructuredOrderingRow` only means the ordering reader recognised our catalog number — it does
    // not mean it extracted any SPECS. On Eaton's E6 catalogue it found the row
    // "1 | E6-1/1/B | CBE03319 | 12" and nothing else, yet it suppressed the one reader that maps the
    // header ("Rated current In (A) | Part number | Article number | Unit per package") onto that row's
    // cells and would have yielded the rated current of 1 A. The catalog number was found and the
    // specification next to it was thrown away.
    //
    // Suppressing them was never about contamination either: both verify that the cell the HEADER calls
    // the catalog number is actually ours (see extractGenericCatalogTableRows) before trusting the row,
    // so they are the precise readers, not the risky ones. The unscoped sweeps below stay suppressed.
    ...(familyOnly ? [] : extractGenericCatalogTableRows(lines, input.catalogNumber, sourceUrl)),
    ...(familyOnly ? [] : extractGetTableCatalogRows(input.tables ?? [], input.catalogNumber, sourceUrl)),
    ...(hasStructuredOrderingRow || familyOnly ? [] : extractCatalogDescriptionRows(lines, input.catalogNumber, sourceUrl)),
    // Suppressed too when the scope is unresolved. This reader keeps whole lines keyed by any
    // catalog-shaped token in them, so it is only "catalog-verified" in the weakest sense — on the
    // nVent multi-product sheet it matched the page FOOTERS (the only places the document number
    // appears) and emitted four of them as product rows. With no resolved scope it is as blind as a
    // sweep; the header-mapped table readers above are the ones that genuinely verify a row.
    ...(sweepsAllowed && !familyOnly ? extractCatalogSpecificRows(lines, input.catalogNumber, sourceUrl) : []),
    ...(hasStructuredOrderingRow || !sweepsAllowed || familyOnly
      ? []
      : extractCatalogFeatureAttributes(lines, input.catalogNumber, sourceUrl, input.document.type))
  ];

  const combined = dedupeAttributes([...productSpecificAttributes, ...attributes]);
  return familyOnly
    ? combined.filter(isFamilyInvariantAttribute).map((attribute) => ({ ...attribute, scope: "family", matchLevel: "family" }))
    : combined.map((attribute) => (input.matchLevel === "exact" ? { ...attribute, matchLevel: "exact" } : attribute));
}

/** Fields which can vary within a catalog family, even when their label also contains an invariant word.
 *
 * For example, the heading "Standard voltage ratings ..." contains "standard", but is still a
 * voltage rating and therefore must not escape a family-only document as a product fact.
 */
const FAMILY_VARIANT_SENSITIVE_FIELD_KEYS = [
  "weight",
  "dimensions",
  "wallThickness",
  "finish",
  "color",
  "voltage",
  "current",
  "protection",
  "operatingTemperature",
  "typeCode"
] as const satisfies readonly RegistryFieldKey[];

/** A family-wide compliance claim needs a real published reference, not just a table fragment
 * containing words such as "standard" or "approval". */
const FAMILY_COMPLIANCE_REFERENCE = /\b(?:IEC|EN|DIN|ISO|UL|CSA|VDE|CE|UKCA|EAC|RoHS|REACH|ATEX|NEMA|NFPA|CCC|T[ÜU]V)\b/i;

/** Family evidence may safely yield shared construction/compliance facts, never product ratings. */
function isFamilyInvariantAttribute(attribute: AttributeRecord): boolean {
  // Group names describe the PDF section, not this row. A material row under a "Dimensions"
  // section is still family-invariant; conversely, "Standard voltage" remains a voltage row.
  const name = cleanText(attribute.name);
  if (FAMILY_VARIANT_SENSITIVE_FIELD_KEYS.some((field) => fieldMatchesLabel(field, name))) return false;
  if (/\bmaterial\b/i.test(name)) return true;
  return /\b(?:standard|norm|certif(?:icate|ication)|approval|compliance)\b/i.test(name) &&
    FAMILY_COMPLIANCE_REFERENCE.test(cleanText(attribute.value));
}

/**
 * Same catalog-table concept as extractGenericCatalogTableRows, but sourced from getTable()'s
 * vector-grid table detection instead of guessing column boundaries from whitespace in linear
 * text — catches bordered ordering tables whose column widths vary enough to confuse the
 * whitespace heuristic.
 */
function extractGetTableCatalogRows(tables: TableArray[], catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string | undefined) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    const key = `${name}|${cleaned}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    // Same reasoning as extractGenericCatalogTableRows's confidence boost: this catalog is
    // verified against its own header-mapped column, so it should outrank a catalog-agnostic
    // text sweep (extractInlineDimensionText) that could otherwise win a confidence tie.
    attributes.push({ group: "PDF Table (Grid)", name, value: cleaned, sourceUrl, confidence: 0.75 });
  };

  for (const table of tables) {
    if (table.length < 2) continue;
    const headerRowIndex = table.findIndex((row) => looksLikeCatalogTableHeader(row));
    if (headerRowIndex < 0) continue;
    const header = table[headerRowIndex].map(cleanText);
    for (let rowIndex = headerRowIndex + 1; rowIndex < table.length; rowIndex += 1) {
      const row = table[rowIndex].map(cleanText);
      if (row.every((cell) => !cell)) continue;
      const rowText = row.join(" ");
      if (!catalogTextMatches(rowText, catalogNumber, { compact: true, ignoreCase: true })) continue;
      const mapped = mapHeaderCellsToRow(header, row);
      if (mapped.size < 2) continue;
      // Same cross-reference bug as extractGenericCatalogTableRows above: the row-level match
      // scans the WHOLE row including free-text description columns, so a sibling catalog
      // cross-referenced in THIS row's own description ("...replacement for 1606-XLSBATASSY1...")
      // would otherwise match a query for that sibling and inherit THIS row's values instead.
      if (!mappedCatalogCellMatches(mapped.get("catalogNumber"), catalogNumber)) continue;

      push("Catalog Number", ourCatalogCellValue(mapped.get("catalogNumber"), catalogNumber));
      push("Description", mapped.get("description"));
      push("Product Type", mapped.get("productType"));
      push("Material", mapped.get("material"));
      push("Weight", mapped.get("weight"));
      push("Voltage rating", mapped.get("voltage"));
      push("Current rating", mapped.get("current"));
      push("Dimensions", genericRowDimensions(mapped));
    }
  }
  return attributes.slice(0, 60);
}

function looksLikeCatalogTableHeader(row: string[]): boolean {
  const cells = row.map(cleanText).filter(Boolean);
  if (cells.length < 2) return false;
  return isCatalogTableHeaderText(cells.join(" "));
}

function parsedDocumentAttribute(
  document: Pick<DocumentRecord, "label" | "type" | "url" | "localPath">,
  sourceUrl: string
): AttributeRecord {
  return {
    group: "PDF Document",
    name: "Parsed document",
    value: cleanText(document.label || path.basename(document.localPath ?? document.url)),
    sourceUrl
  };
}

/**
 * True when extraction produced at least one real product attribute (not just the
 * "Parsed document" marker stub). Used to decide parsed-vs-skipped: the old `length > 1`
 * proxy mislabelled a document that yielded exactly one genuine attribute as "skipped".
 */
export function documentAttributesAreSubstantive(attributes: AttributeRecord[]): boolean {
  return attributes.some((attr) => !(attr.group === "PDF Document" && attr.name === "Parsed document"));
}

function cachedNormalizedPdfLines(text: string, sourceUrl: string): string[] {
  const cacheKey = documentTextCacheKey(text, sourceUrl);
  const cached = normalizedPdfLinesCache.get(cacheKey);
  if (cached) return cached;
  const lines = normalizePdfLines(text);
  normalizedPdfLinesCache.set(cacheKey, lines);
  trimMap(normalizedPdfLinesCache, 12);
  return lines;
}

function cachedGlobalPdfAttributes(
  document: Pick<DocumentRecord, "label" | "type" | "url" | "localPath">,
  text: string,
  lines: string[],
  sourceUrl: string
): AttributeRecord[] {
  const cacheKey = `${documentTextCacheKey(text, sourceUrl)}|${document.type}|${document.label}`;
  const cached = globalPdfAttributeCache.get(cacheKey);
  if (cached) return cached.map((attr) => ({ ...attr }));
  const attributes = extractGlobalPdfAttributes(document, lines, sourceUrl);
  globalPdfAttributeCache.set(cacheKey, attributes);
  trimMap(globalPdfAttributeCache, 12);
  return attributes.map((attr) => ({ ...attr }));
}

function extractGlobalPdfAttributes(
  document: Pick<DocumentRecord, "label" | "type" | "url" | "localPath">,
  lines: string[],
  sourceUrl: string
): AttributeRecord[] {
  const documentGroup = `PDF ${document.type}`;
  const attributes: AttributeRecord[] = [parsedDocumentAttribute(document, sourceUrl)];
  const sectionByLine = sectionTracker();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = cleanText(rawLine);
    if (!line || shouldSkipPdfLine(line)) continue;

    const section = sectionByLine(line);
    if (isPdfSectionHeading(line)) continue;
    const group = `${documentGroup}${section ? ` - ${section}` : ""}`;
    const tabPair = parseTabbedPair(rawLine);
    if (tabPair) {
      attributes.push({ group, ...tabPair, sourceUrl });
      continue;
    }

    const spacedPair = parseSpacedTablePair(rawLine);
    if (spacedPair) {
      attributes.push({ group, ...spacedPair, sourceUrl });
      continue;
    }

    if (isKnownLabelOnly(line)) {
      const value = nextPdfLabelValue(lines, index + 1);
      if (value) attributes.push({ group, name: line, value, sourceUrl });
      continue;
    }

    const knownPairs = parseMultipleKnownInlinePairs(line);
    if (knownPairs.length >= 2) {
      attributes.push(...knownPairs.map((pair) => ({ group, ...pair, sourceUrl })));
      continue;
    }

    const knownPair = parseKnownInlinePair(line);
    if (knownPair) {
      attributes.push({ group, ...knownPair, sourceUrl });
      continue;
    }

    const registryPair = parseRegistryAliasInlinePair(line);
    if (registryPair) {
      attributes.push({ group, ...registryPair, sourceUrl });
      continue;
    }

    const colonPair = splitNameValue(line);
    if (colonPair) attributes.push({ group, ...colonPair, sourceUrl });
  }
  return attributes;
}

function cachedGlobalPdfTechnicalAttributes(text: string, lines: string[], sourceUrl: string, catalogNumber: string): AttributeRecord[] {
  // Some readers below select a catalog-labelled row. Do not let another SKU's
  // result from the same family PDF leak through this otherwise document-level cache.
  const cacheKey = `${documentTextCacheKey(text, sourceUrl)}|${compact(catalogNumber)}`;
  const cached = globalPdfTechnicalAttributeCache.get(cacheKey);
  if (cached) return cached.map((attr) => ({ ...attr }));
  const attributes = [
    ...extractElectricalSpecAttributesFromText({
      text,
      sourceUrl,
      group: "PDF Electrical Text"
    }),
    ...extractOntologySpecAttributesFromText({
      text,
      sourceUrl,
      group: "PDF Ontology Spec Miner"
    }),
    ...extractLocalizedTechnicalRows(lines, sourceUrl),
    ...extractStackedDimensionTableRows(lines, sourceUrl, catalogNumber),
    ...extractInlineDimensionText(lines, sourceUrl),
    ...extractContactRatingAttributes(lines, sourceUrl, catalogNumber),
    ...extractQualifiedTemperatureAttributes(lines, sourceUrl),
    ...extractWrappedLabelValueAttributes(lines, sourceUrl)
  ];
  globalPdfTechnicalAttributeCache.set(cacheKey, attributes);
  trimMap(globalPdfTechnicalAttributeCache, 12);
  return attributes.map((attr) => ({ ...attr }));
}

function extractCatalogFeatureAttributes(lines: string[], catalogNumber: string, sourceUrl: string, documentType: DocumentRecord["type"]): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const sectionByLine = sectionTracker();
  for (const rawLine of lines) {
    const line = cleanText(rawLine);
    if (!line || shouldSkipPdfLine(line)) continue;
    const section = sectionByLine(line);
    if (isPdfSectionHeading(line) || isKnownLabelWithQualifierOnly(line)) continue;
    if (isUsefulFeatureLine(line, catalogNumber)) {
      attributes.push({ group: `PDF ${documentType}${section ? ` - ${section}` : ""}`, name: "Feature", value: line, sourceUrl });
    }
  }
  return attributes.slice(0, 40);
}

/**
 * FNV-1a over the whole string. Cheap (one pass, no allocation) and, unlike a length + first/last-120
 * fingerprint, it cannot collide for two texts that differ only in the middle.
 */
function textFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Cache identity for text-derived attribute lists.
 *
 * The text handed to these extractors is SCOPED PER CATALOG NUMBER (buildDocumentParseContext), and
 * the old key was `url | length | first120 | last120`. In a uniform ordering table that is not unique:
 * sibling rows have identical lengths ("1 E6-1/1/B CBE03319 12" vs "2 E6-2/1/B CBE03320 12") and their
 * scoped windows share the same surrounding header/footer lines, so two different catalog numbers
 * could produce the same key and one would be served the OTHER's attributes — a cross-catalog leak no
 * downstream guard can detect, because the values look perfectly well-formed.
 *
 * Hashing the full text keeps cross-catalog reuse when the text genuinely IS identical, so nothing is
 * lost by being correct here.
 */
function documentTextCacheKey(text: string, sourceUrl: string): string {
  return `${sourceUrl}|${text.length}|${textFingerprint(text)}`;
}

function trimMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/**
 * A running page header/footer, detected generically rather than by vendor.
 *
 * Two signals together, because either alone is unsafe: the line REPEATS across pages once page numbers
 * are stripped, AND it carries imprint-shaped content (a domain, a phone number, a copyright, a
 * legal disclaimer). A repeated spec line therefore cannot be mistaken for furniture, and a one-off
 * imprint line does not disqualify a real page.
 */
const PAGE_FURNITURE_MARKER = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|de|eu|co\.uk)\b|\b(?:ph|tel|phone|fax)\b\s*[:.]?\s*\+?[\d\s().-]{7,}|[©]|\ball rights reserved\b|\bsubject to change\b|\btechnische änderungen\b|\bsous r[ée]serve de modifications\b/i;
const PAGE_FURNITURE_MIN_REPEATS = 3;

function runningPageFurnitureForms(lines: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const form = pageFurnitureForm(line);
    if (!form) continue;
    counts.set(form, (counts.get(form) ?? 0) + 1);
  }
  const forms = new Set<string>();
  for (const [form, count] of counts) if (count >= PAGE_FURNITURE_MIN_REPEATS) forms.add(form);
  return forms;
}

/** Digit-stripped shape of a line, or undefined when the line carries no imprint marker. */
function pageFurnitureForm(line: string): string | undefined {
  const cleaned = cleanText(line);
  if (!cleaned || !PAGE_FURNITURE_MARKER.test(cleaned)) return undefined;
  return cleaned.replace(/\d+/g, "#").toLowerCase();
}

/**
 * True when EVERY mention of our catalog number sits in a running header/footer.
 *
 * A document number printed in the footer of every page ("… SUBJECT TO CHANGE … Spec-00583") makes
 * `catalogTextMatches` true and `buildTightContextForCatalog` return a window around each footer — on
 * nVent's SPEC-00583 that was 8 windows totalling 3.5 kB, i.e. most of an 8-page multi-product sheet.
 * The pipeline believed it had located the product eight times. It had located the document.
 *
 * Page furniture identifies the DOCUMENT, never the product, so a match there carries no scoping
 * information at all.
 */
function catalogAppearsOnlyInPageFurniture(text: string, catalogNumber: string): boolean {
  const lines = text.split(/\r?\n/);
  const furniture = runningPageFurnitureForms(lines);
  if (!furniture.size) return false;
  let sawMention = false;
  for (const line of lines) {
    if (!catalogTextMatches(line, catalogNumber, { compact: true, afterColon: true })) continue;
    sawMention = true;
    const form = pageFurnitureForm(line);
    if (!form || !furniture.has(form)) return false; // a real, non-furniture mention exists
  }
  return sawMention;
}

interface DocumentParseScope {
  text: string;
  /**
   * False when nothing in the document actually locates THIS catalog number. Callers must then skip the
   * catalog-agnostic sweeps: with no scope, those attribute whatever the document says to whichever
   * product was asked for.
   */
  resolved: boolean;
  match?: ReturnType<typeof findCatalogTextMatch>;
}

function buildDocumentParseScope(text: string, catalogNumber: string): DocumentParseScope {
  const match = findCatalogTextMatch(text, catalogNumber, { compact: true, afterColon: true });
  const contextText = buildDocumentParseContext(text, match?.candidate ?? catalogNumber);
  // Only multi-variant documents are dangerous when unscoped: on a single-product datasheet "the whole
  // document" IS the right scope, so widening there is correct and long-standing behaviour.
  const unscopeable =
    looksLikeMultiVariantFamilyPage(text, catalogNumber) && catalogAppearsOnlyInPageFurniture(text, catalogNumber);
  return { text: contextText, resolved: !unscopeable, match };
}

function buildDocumentParseContext(text: string, catalogNumber: string): string {
  // buildVariantColumnContext already reconstructed exactly this catalog's own column from a
  // multi-model comparison table (one column per catalog number). Trust it exclusively: merging
  // in buildGlobalTechnicalContext's UNSCOPED sweep below would reintroduce the very cross-model
  // contamination the column reconstruction exists to prevent — its "Dimensions"/"Weight"
  // continuation window is 28 lines wide (WRAPPED_LABEL_SPECS), wide enough to sweep in
  // neighboring, genuinely different models' dimensions/weight off the same shared page (e.g.
  // Rockwell's 1606-XLB60BH's row picking up 1606-XLB120E's "39 x 124 x 124 mm" from many lines
  // below, since both mention "Dimensions" and both are within the window).
  const variantScoped = buildVariantColumnContext(text, catalogNumber, { maxChars: MAX_PDF_TEXT_CHARS });
  if (variantScoped) return variantScoped;
  const scoped = buildTightContextForCatalog(text, catalogNumber, { maxChars: MAX_PDF_TEXT_CHARS }) ?? text;
  const globalTechnical = buildGlobalTechnicalContext(text, catalogNumber);
  return mergePdfTextContexts([scoped, globalTechnical, scoped === text ? "" : undefined], MAX_PDF_TEXT_CHARS);
}

/** A catalog/type-code-shaped token — digits plus a separator plus more alnum, or letters directly
 * followed by 3+ digits. Mirrors tight-context.ts's own pattern; kept local since this file has no
 * other need to import it and the two modules already use slightly different helper sets. */
const GLOBAL_CONTEXT_CATALOG_LIKE_PATTERN = /\b[A-Z0-9]{2,}(?:[-:\/.][A-Z0-9]+)+\b|\b[A-Z]{2,}[0-9]{3,}\b/i;
/**
 * A standards/norm reference, NOT a sibling catalog number.
 *
 * These are shaped exactly like catalog numbers to the pattern above ("IEC/EN60898.1" and
 * "GB/T10963.1" both compact to letters-then-digits), and a family's shared "Technical Data" page
 * essentially always cites a few. The ownership check below therefore used to conclude that such a
 * page belonged to a DIFFERENT catalog number and threw the whole block away — losing the family's
 * rated voltage, protection degree, temperature range and torque for every vendor that publishes a
 * family catalog. Confirmed on Eaton's E6 catalogue, where page 4's design-standard line alone
 * suppressed the entire technical table (fixtures/eaton-cbe03319-family-catalog).
 */
const STANDARD_REFERENCE_TOKEN_PATTERN =
  /^(?:iecen|iec|en|gbt|gb|ul|csa|din|iso|vde|ansi|nema|nfpa|jis|bs|ieee|eac|tuv|etl|cei|nf|sae|astm|asme|ieccb)\d{2,6}[a-z]{0,2}(?:\d{1,3})?$/;

export function isStandardReferenceToken(compactToken: string): boolean {
  return STANDARD_REFERENCE_TOKEN_PATTERN.test(compactToken);
}

/** Unit suffixes that mark a token as a measured VALUE. Kept deliberately short: only units that
 * realistically terminate an inline value, so a real catalog number ending in stray letters is not
 * mistaken for a quantity. */
const MEASUREMENT_UNIT_SUFFIX =
  "v|a|ma|ka|w|kw|mw|va|kva|hz|khz|mm|cm|m|km|in|kg|g|mg|lb|lbs|nm|ncm|bar|pa|kpa|mpa|s|ms|min|h|db|rpm|hp|j|l|ml|k|c|f|%";
/** digits/decimals joined by a separator ("230/400V", "50/60Hz", "1/0.03", "3x400") */
const MEASUREMENT_COMPOUND_TOKEN_PATTERN = new RegExp(
  `^[\\d.,]+(?:\\s*[\\/x×+±-]\\s*[\\d.,]+)+\\s*(?:°?\\s*(?:${MEASUREMENT_UNIT_SUFFIX}))?$`,
  "i"
);
/** a single number carrying a unit ("400V", "6kA", "2.5Nm") */
const MEASUREMENT_UNIT_TOKEN_PATTERN = new RegExp(`^[\\d.,]+\\s*°?\\s*(?:${MEASUREMENT_UNIT_SUFFIX})$`, "i");

/**
 * A measured value, NOT a sibling catalog number.
 *
 * `230/400V` and `50/60Hz` compact to "230400v" and "5060hz", which the catalog-like pattern happily
 * accepted — so the ownership check below concluded that a family's Technical Data page belonged to
 * some OTHER catalog number and discarded every block on it. A dual voltage and a dual frequency are
 * the two most ordinary electrical values there are, so this silently deleted the shared technical
 * table for essentially every vendor that publishes one. Confirmed on Eaton's E6 catalogue page 4
 * (fixtures/eaton-cbe03319-family-catalog).
 *
 * Tested on the RAW token, not the compacted one: compacting throws away exactly the separators and
 * unit letters that distinguish "230/400V" from a genuine code like "E6-1/1/B".
 *
 * A bare number with neither separator nor unit is deliberately NOT excluded — some vendors' catalog
 * numbers really are plain digits (nVent's 87920846), and the guard must still notice those.
 */
export function isMeasurementLikeToken(rawToken: string): boolean {
  const token = rawToken.trim();
  return MEASUREMENT_COMPOUND_TOKEN_PATTERN.test(token) || MEASUREMENT_UNIT_TOKEN_PATTERN.test(token);
}
/** Fallback ownership-check window (lines) for documents with no page-footer markers to bound by
 * (see pageBounds below) — narrower than a full page, but still enough to catch a nearby table. */
const GLOBAL_CONTEXT_OWNERSHIP_WINDOW = 15;
/** pdf-parse renders a page footer like "-- 33 of 42 --" between pages — used to bound the
 * ownership check to the WHOLE page a candidate block sits on, since Rockwell's 1606-td002 (and
 * similarly large multi-model datasheets) dedicates each page to one specific family/table; a
 * fixed line-count window is too narrow to reliably tell "just this one nearby table" from "the
 * network of tables covering this whole page", and too wide risks reaching into a DIFFERENT page's
 * unrelated family instead. */
const PDF_PAGE_FOOTER_PATTERN = /^--\s*\d+\s+of\s+\d+\s*--$/;

function pageBounds(lines: string[], index: number): { from: number; to: number } {
  let from = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (PDF_PAGE_FOOTER_PATTERN.test(lines[cursor].trim())) {
      from = cursor + 1;
      break;
    }
  }
  let to = lines.length - 1;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (PDF_PAGE_FOOTER_PATTERN.test(lines[cursor].trim())) {
      to = cursor - 1;
      break;
    }
  }
  return { from, to };
}

/** A weight/dimension-shaped cell: a leading number followed by a unit, optionally with a
 * parenthetical unit conversion — "930 g", "620 g (1.37 lb)", "39 x 124 x 117 mm". */
const MULTI_COLUMN_VALUE_CELL_PATTERN = /^-?\d+(?:[.,]\d+)?(?:\s*[x×]\s*-?\d+(?:[.,]\d+)?){0,3}\s*(?:g|kg|lb|lbs|mm|cm|in|inch|inches)\b(?:\s*\([^)]*\))?$/i;

/** Detects a table ROW with 2+ separate weight/dimension VALUE cells on one line (tab or 2+-space
 * separated) — several different models' values side by side, not one model's single measurement
 * plus its own unit conversion. */
function looksLikeMultiColumnDataRow(line: string): boolean {
  const cells = line
    .split(/\t+|\s{2,}/)
    .map((cell) => cell.trim())
    .filter(Boolean);
  const valueCellCount = cells.filter((cell) => MULTI_COLUMN_VALUE_CELL_PATTERN.test(cell)).length;
  return valueCellCount >= 2;
}

function buildGlobalTechnicalContext(text: string, catalogNumber: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const compactCatalog = compact(catalogNumber);
  const kept = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanText(lines[index]);
    if (!line || !isGlobalTechnicalLine(line)) continue;
    // A multi-column comparison-table ROW ("Weight \t930 g \t440 g \t620 g \t620 g \t900 g \t900 g")
    // has several DIFFERENT models' values on one line — this sweep has no column awareness at all,
    // so it would otherwise glue every value on the row into one string (that's the correct job of
    // buildVariantColumnContext / the positioned-table reader instead, both of which resolve the
    // ONE right column). The page-boundary ownership check above still lets this through whenever
    // our own catalog is ALSO a column on the same page — which it usually is, since our catalog
    // literally lives in the very table this row belongs to — so it needs its own, separate guard.
    if (looksLikeMultiColumnDataRow(line)) continue;
    const after = globalTechnicalContinuationWindow(line);
    const blockEnd = (() => {
      let end = index;
      for (let offset = 1; offset <= after && index + offset < lines.length; offset += 1) {
        const next = cleanText(lines[index + offset]);
        if (!isGlobalTechnicalContinuation(next) && !isPatternModelTableLine(next)) {
          if (offset > 2) break;
          continue;
        }
        end = index + offset;
      }
      return end;
    })();
    // Multi-model documents (e.g. Rockwell's 1606-td002, 42 pages, dozens of power-supply
    // families each with their own Dimensions/Weight rows) repeat these same keyword patterns for
    // EVERY model — an unscoped sweep like this one has no way to tell whose block it's looking
    // at, so it silently glued a totally unrelated model's Weight/Dimensions onto every OTHER
    // catalog's context (confirmed live: several genuinely different Rockwell catalogs all
    // resolved to the exact same "930 g / 440 g" and "90 x 106 x 70 mm" from one shared power-
    // supply comparison table nowhere near any of them). If a DIFFERENT catalog-shaped token
    // appears within this block or its immediate surroundings and OUR catalog does not, this
    // block belongs to that other model — skip it instead of risking cross-contamination.
    if (compactCatalog && blockOwnedByDifferentCatalog(lines, index, blockEnd, compactCatalog)) continue;
    kept.add(index);
    if (index > 0 && isGlobalTechnicalHeading(cleanText(lines[index - 1]))) kept.add(index - 1);
    for (let lineIndex = index + 1; lineIndex <= blockEnd; lineIndex += 1) kept.add(lineIndex);
  }
  if (kept.size === 0) return undefined;
  return [...kept].sort((left, right) => left - right).map((index) => lines[index]).join("\n");
}

function blockOwnedByDifferentCatalog(lines: string[], blockStart: number, blockEnd: number, compactCatalog: string): boolean {
  const page = pageBounds(lines, blockStart);
  // A real page boundary reliably scopes the check to "this whole page's family" (see
  // PDF_PAGE_FOOTER_PATTERN above); without one (no footer markers found at all — shorter, non-
  // paginated documents), fall back to a fixed line window around the block itself.
  const hasPageBounds = page.to - page.from < lines.length - 1;
  const from = hasPageBounds ? page.from : Math.max(0, blockStart - GLOBAL_CONTEXT_OWNERSHIP_WINDOW);
  const to = hasPageBounds ? page.to : Math.min(lines.length - 1, blockEnd + GLOBAL_CONTEXT_OWNERSHIP_WINDOW);
  let sawOurCatalog = false;
  let sawOtherCatalog = false;
  for (let index = from; index <= to; index += 1) {
    const tokens = lines[index].match(new RegExp(GLOBAL_CONTEXT_CATALOG_LIKE_PATTERN, "gi"));
    if (!tokens) continue;
    for (const token of tokens) {
      const compactToken = compact(token);
      if (compactToken.length < 4 || !/\d/.test(compactToken)) continue;
      // Our own catalog number is matched FIRST, so a catalog that happens to be standard-shaped
      // still registers as ours before the standards filter can discard it.
      if (compactToken === compactCatalog) sawOurCatalog = true;
      else if (!isStandardReferenceToken(compactToken) && !isMeasurementLikeToken(token)) sawOtherCatalog = true;
    }
  }
  return sawOtherCatalog && !sawOurCatalog;
}

// Weight/dimensions/width/height/depth are deliberately EXCLUDED from this sweep: they're
// per-model quantities that repeat, differently, for every family in a multi-model datasheet
// (confirmed live on Rockwell's 1606-td002 \u2014 an unscoped sweep has no column/table awareness and
// glued whichever OTHER model's row happened to be nearby onto every catalog's Weight attribute).
// Dedicated, catalog-scoped readers (buildVariantColumnContext, buildTightContextForCatalog, the
// positioned-table reader) already own these fields; this generic sweep is only safe for content
// that's genuinely shared/global across a family's page (electrical ratings, certifications, etc).
function isGlobalTechnicalLine(line: string): boolean {
  // The ontology first: it is multilingual and already knows 98 properties, whereas the keyword list
  // below is hand-maintained English and was silently deciding which lines even get read. Measured on
  // Eaton's E6 catalogue, the list missed "Casing protection degree", "Design standard", "Rated
  // breaking capacity Icn" and "Terminal screw fastening torque" — the ontology maps all four.
  // The list is kept as an additional path (it encodes whole-line shapes the ontology has no synonym
  // for, e.g. "selective true"), so this widens admission and never narrows it.
  if (looksLikeUnderstandableSpec(line)) return true;
  return (
    /\b(?:technical\s+(?:data|specifications?)|electrical\s+(?:data|ratings?)|input\s+voltage|output\s+voltage|operating\s+voltage|supply\s+voltage|rated\s+voltage|rated\s+(?:operating\s+|operational\s+)?current|operating\s+current|rated\s+current|rated\s+power|power\s+dissipation|power\s+loss|heat\s+loss|degree\s+of\s+protection|protection\s+class|operating\s+temperature|storage\s+temperature|ambient\s+temperature|approvals?\s+and\s+certificates|certifications?|ul\s+certificate|housing\s+material|cross[-\s]?section|tightening\s+torque|number\s+of\s+conductors|conductors?\s+per\s+terminal|neutral\s+conductor|direct\s+contact|tripping\s+characteristic|short-time\s+delayed|non-trip\s+time|tripping\s+frequency|disconnection\s+times?|internal\s+consumption|contact\s+opening|surge\s+current|switching\s+capacity|insulation\s+voltage|impulse\s+(?:withstand\s+)?voltage|withstand\s+voltage|rated\s+frequency|back[-\s]?up[-\s]?fuse|i2t\s+strength|dynamic\s+current\s+strength|screw[-\s]?type\s+terminal|degree\s+of\s+pollution|\bsealable\b|module\s+widths?|minimum\s+rated\s+operating\s+voltage|operating\s+altitude|operating\s+position|mechanical\s+endurance|electrical\s+endurance|shock\s+resistance|fatigue\s+limit|housing\s+type|installation\s+type)\b/i.test(line) ||
    /^selective\s+(?:true|false)\b/i.test(line) ||
    /\b[A-Z0-9]{1,8}\s*[=:]\s*.*?\bIP\s*\d{2}[A-Z]?\b/i.test(line) ||
    /(?:\u6280\u672f\u53c2\u6570|\u6280\u672f\u89c4\u683c|\u53d8\u9891\u5668|\u53d8\u9891\u9a71\u52a8|\u9891\u7387\u8f6c\u6362\u5668|\u8f93\u5165\u7535\u538b|\u8f93\u51fa\u7535\u538b|\u989d\u5b9a\u7535\u6d41|\u989d\u5b9a\u529f\u7387|\u9632\u62a4\u7b49\u7ea7|\u5de5\u4f5c\u6e29\u5ea6|\u73af\u5883\u6e29\u5ea6)/.test(line)
  );
}

function isGlobalTechnicalHeading(line: string): boolean {
  return /\b(?:technical|specifications?|electrical)\b/i.test(line) || /(?:\u6280\u672f|\u89c4\u683c)/.test(line);
}

function isGlobalTechnicalContinuation(line: string): boolean {
  return /(?:\b(?:V|A|W|kW|Hz|IP\s*\d|degC|\u00b0\s*C)\b|\u2103|\d)/i.test(line) && line.length <= 400;
}

function globalTechnicalContinuationWindow(line: string): number {
  // "max. Connection C1 Number of conductors" wraps its own label onto the next line ("per
  // terminal") before the value line \u2014 a window of 1 would only capture the label continuation
  // and miss the value itself. Same reach needed for every other label registered in
  // WRAPPED_LABEL_SPECS below (e.g. "max. Operating altitude above" / "MSL" / "2000 m").
  if (WRAPPED_LABEL_SPECS.some((spec) => spec.pattern.test(line))) return 3;
  return 1;
}

function isPatternModelTableLine(line: string): boolean {
  return /[A-Z]{2,}\d[A-Z0-9.-]*(?:\.{2,}|\u2026|x{2,}|X)[A-Z0-9.\-\u2026]*/i.test(line) || /(?:\bW\b\s+\bH\b\s+\bD\b|\u7c7b\u578b|\u8bf4\u660e)/.test(line);
}

function mergePdfTextContexts(parts: Array<string | undefined>, maxChars: number): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const line of part.split(/\r?\n/)) {
      const key = cleanText(line).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return lines.join("\n").slice(0, maxChars);
}

async function readPdfText(filePath: string, catalogNumber?: string, cacheIdentity?: string): Promise<PdfDocumentText> {
  // Small/medium PDFs (the common case): parse once into a cached page set, then scope PER CATALOG
  // NUMBER out of it. Large PDFs keep the streaming page-by-page walk below so we never hold a
  // hundred-megabyte document's every page in memory at once.
  const pageSet = await readCachedPdfPageSetIfEligible(filePath, cacheIdentity);
  if (pageSet) return selectPdfTextFromPageSet(pageSet, catalogNumber);

  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    let text = "";
    let tables: TableArray[] = [];
    if (catalogNumber) {
      const targeted = await readTargetedPdfText(parser, catalogNumber);
      if (targeted) {
        text = targeted.text;
        tables = targeted.tables;
      }
    }
    if (!text) {
      const parsed = await parser.getText({ first: MAX_PDF_PAGES });
      text = parsed.text;
      tables = await safeGetTables(parser, parsed.pages.map((page) => page.num));
    }
    if (text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) return { text: text.slice(0, MAX_PDF_TEXT_CHARS), tables };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  const ocr = await readPdfWithOptionalOcr(filePath, { maxPages: MAX_PDF_PAGES });
  if (ocr.quality?.accepted && ocr.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE)
    return { text: ocr.text.slice(0, MAX_PDF_TEXT_CHARS), tables: [] };
  throw new Error(ocr.error ? `PDF has no extractable text and OCR failed: ${ocr.error}` : "PDF has no extractable text and OCR returned no text.");
}

/**
 * Compliance-matrix certifications (checkmark glyphs, see pdf-compliance-matrix.ts) need the PDF's
 * raw positioned text items, which `pdf-parse` (used by `readPdfText` above) doesn't expose — so
 * this re-opens the file with `pdfjs-dist` directly. Gated behind a cheap plain-text scan first
 * (`textHasComplianceMatrixGlyphs`) so that second parse only happens for the rare PDF that
 * actually uses this layout; every other document pays no extra cost. Never throws — this is a
 * best-effort enhancement on top of the normal text-based extraction, not a required step.
 */
async function extractComplianceMatrixAttributesSafely(
  plainText: string,
  filePath: string,
  catalogNumber: string,
  sourceUrl: string
): Promise<AttributeRecord[]> {
  if (!textHasComplianceMatrixGlyphs(plainText)) return [];
  try {
    const data = new Uint8Array(await fs.readFile(filePath));
    return await extractComplianceMatrixAttributes(data, catalogNumber, sourceUrl);
  } catch {
    return [];
  }
}

/** Falls back to pdfjs-dist's raw positioned text items (see pdf-positioned-table.ts) ONLY when
 * the text-based extraction above didn't already find Weight/Dimensions — this is a genuinely
 * more expensive second PDF parse, so it's gated on actually being needed. Exists for tables where
 * several catalog names share one printed column via a merge that no text/tab heuristic can
 * reliably resolve (buildVariantColumnContext's sanity check now refuses to guess those rather
 * than risk a wrong value — see [[rockwell-xle120e-header-anchor-fix]] and
 * [[rockwell-positioned-table-reader]]); position clustering recovers the true column layout
 * directly instead of guessing from text. Once triggered, harvests every row this reads for the
 * catalog's column (Voltage, Current, Power, Efficiency, MTBF, Connection Terminals, ...), not
 * just Weight/Dimensions — verified against the real datasheet to reach the exact right column
 * for every field, including rows with per-model footnotes (e.g. Connection Terminals correctly
 * distinguishes "Screw (-XLB90E)" from a merged sibling's "Push-in (-XLB90EH)"). */
/** A single weight/dimensions measurement has ONE leading number (e.g. "270 g (0.60 lb)" —
 * the "(0.60 lb)" part is a unit conversion of the SAME measurement, not a second one). Several
 * genuinely different numbers glued together with "/" or "|" (e.g. "930 g / 440 g") indicates
 * multiple different models' values got swept in and joined rather than resolved to one.
 *
 * Also catches the electrical-spec counterpart of the same symptom: buildVariantColumnContext's
 * left-to-right cell counting misaligns a row whenever two ADJACENT data columns render an
 * identical value as one spanning cell (confirmed live on Rockwell's 1606-XLS480G/240F/240F-D/
 * 480F/960F/960FE table — every later column's positional read silently shifts by one once that
 * happens). A shifted-but-still-plausible single reading can't be told apart from a correct one by
 * shape alone (see the broadened trigger in extractPositionedWeightDimensionsSafely below, which
 * doesn't rely on this function to catch that case) — but the OTHER known failure mode, two
 * different rows' label/value text getting concatenated into one string (e.g. "Current 20 A
 * Current 480 watt"), always repeats an alphabetic word from its own label, which a genuine single
 * reading never does. */
export function isCleanSingleSpecValue(value: string): boolean {
  if (/[/|]/.test(value)) return false;
  const leadingNumbers = value.match(/\b\d+(?:\.\d+)?\s*(?:g|kg|lb|mm|cm|in)\b/gi) ?? [];
  if (leadingNumbers.length > 2) return false;
  const words = (value.match(/[a-z]{3,}/gi) ?? []).map((word) => word.toLowerCase());
  if (new Set(words).size < words.length) return false;
  return true;
}

/** Cheap, no-extra-parse signal that a PDF is a multi-model comparison/family page whose per-model
 * columns the positioned reader should own: some line prints OUR catalog next to at least one OTHER
 * distinct catalog-shaped model code (a comparison header or ordering row). Single-product
 * datasheets never match (only one catalog token), so the expensive positioned re-parse stays gated
 * off for them — this only force-runs it where the tab-text heuristics are known to fill wrong,
 * cross-model values that still LOOK clean. */
export function looksLikeMultiVariantFamilyPage(text: string, catalogNumber: string): boolean {
  const compactCatalog = compact(catalogNumber);
  if (!compactCatalog) return false;
  const catalogLike = /\b[A-Z0-9]{2,}(?:[-:\/.][A-Z0-9]+)+\b|\b[A-Z]{2,}[0-9]{3,}\b/gi;
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.match(catalogLike);
    if (!tokens) continue;
    const distinct = new Set(tokens.map(compact).filter((token) => token.length >= 4 && /\d/.test(token)));
    if (distinct.has(compactCatalog) && distinct.size >= 2) return true;
  }
  return false;
}

async function extractPositionedWeightDimensionsSafely(
  filePath: string,
  catalogNumber: string,
  sourceUrl: string,
  existingAttributes: AttributeRecord[],
  forceRun = false,
  nativePositionedItemsByPage?: Map<number, PositionedTextItem[]>
): Promise<AttributeRecord[]> {
  // A weight/dimensions attribute whose VALUE already looks like several different numbers
  // concatenated together (" / " or " | " joining multiple "NNN g"/"NN x NN x NN" fragments) is
  // itself a symptom of unscoped cross-model contamination (buildGlobalTechnicalContext sweeping
  // in several DIFFERENT models' rows from the same page — confirmed live on Rockwell's
  // multi-model families) — not a real, trustworthy value. Don't let its mere presence skip this
  // more expensive but catalog-scoped fallback; only a genuinely single, clean value counts.
  const hasWeight = existingAttributes.some((attr) => /\bweight\b/i.test(attr.name) && isCleanSingleSpecValue(attr.value));
  const hasDimensions = existingAttributes.some((attr) => /\bdimensions?\b/i.test(attr.name) && isCleanSingleSpecValue(attr.value));
  // Voltage/Current are produced by the SAME naive left-to-right cell counting that Weight/
  // Dimensions used to be, and are vulnerable to the identical merged-column misalignment (see
  // isCleanSingleSpecValue's doc comment) — except a shifted electrical reading still LOOKS clean
  // (it's shape-valid, just belongs to the wrong column), so shape alone can't gate this the way it
  // does for Weight/Dimensions. Run this fallback whenever a Voltage/Current attribute exists AT
  // ALL, regardless of how clean it looks, and let the normal attribute-ranking/confidence pipeline
  // (not this function) pick the winner between the two candidates.
  const hasVoltage = existingAttributes.some((attr) => /\bvoltage\b/i.test(attr.name));
  const hasCurrent = existingAttributes.some((attr) => /\bcurrent\b/i.test(attr.name));
  // On a detected multi-model family page, run the positioned reader even when Weight+Dimensions
  // already look clean and there's no Voltage/Current: the tab-text heuristics can fill a
  // cross-model value that passes the shape check while belonging to a DIFFERENT model's column
  // (confirmed on Rockwell 1606-XLS families). Position clustering owns the true per-model column,
  // so let it compete regardless. Non-family PDFs never set forceRun, so their gate is unchanged.
  if (!forceRun && hasWeight && hasDimensions && !hasVoltage && !hasCurrent) return [];
  try {
    // Reuse the caller's already-loaded per-page items when available (see
    // `nativePositionedItemsByPage`'s doc comment) instead of a second full pdfjs parse of the same
    // file. The map may be missing PAGES the reader would otherwise reach (a capture failure fails
    // the WHOLE map closed, never partial) — falling back to the file-reopen path there is always
    // safe, just slower.
    const rows = nativePositionedItemsByPage
      ? extractPositionedTableRowsFromPages(
          Array.from({ length: Math.max(0, ...nativePositionedItemsByPage.keys()) }, (_, index) => nativePositionedItemsByPage.get(index + 1) ?? []),
          catalogNumber
        )
      : await extractPositionedTableRowsFromPdf(new Uint8Array(await fs.readFile(filePath)), catalogNumber);
    if (!rows) return [];
    // Every row this reader returns is added as a COMPETING candidate — never gated behind "does an
    // existing, shape-clean attribute of the SAME NAME already exist" (that would block a correction
    // from ever competing at all). That existing-attribute gate used to apply to every label except
    // Voltage/Current (added unconditionally because a shifted-but-plausible
    // electrical reading still passes isCleanSingleSpecValue's shape check) — but the exact same
    // "shifted column still looks shape-valid" failure mode applies to EVERY row a merged-column
    // table can produce (Adjustment Range, Output Power, Output Current Range, Efficiency, Power
    // Losses, MTBF, Lifetime, Derating, ...), not just those two. Confirmed live on Rockwell's
    // 1606-XLS 100...240V AC/DC table (1606-XLS180B...1606-XLS240E-D, 10 catalog columns folded
    // into as few as 6 printed value cells per row): buildVariantColumnContext's naive left-to-right
    // cell counting silently shifted Adjustment Range/Output Power/Efficiency/MTBF onto the wrong
    // neighboring catalog for several columns past the first merge point, and every shifted value
    // still reads as a single clean number — the old skip let that WRONG value win by never letting
    // the correct positioned-table row compete for it at all. Safe to add unconditionally because
    // downstream ranking (bestAttribute/addAttributeFact in facts.ts) already sorts by confidence,
    // and a text-derived attribute from splitNameValue/parseKnownInlinePair carries no explicit
    // confidence (sorts as 0) — this reader's fixed 0.8 always wins the comparison already, so the
    // per-name skip was only ever suppressing the fix, never protecting a genuinely better value.
    // Confirmed live on the 1606-XLE120E-family table (1606-XLE120E/-EC/-EL/-EH/-ED genuinely share
    // ONE physical column): several rows in that shared column (DC Input Voltage, Power Factor Typ,
    // Connection Terminals, ...) carry FOOTNOTE-qualified sub-values that differ per sibling catalog
    // within that same column (e.g. "— (-XLE120E, -XLE120EC) DC 110…150V (-XLE120EL, -XLE120EH) DC
    // 110...300 V (-XLE120ED" — three siblings' distinct footnoted readings, all sitting in this
    // reader's VALUE_Y_WINDOW for the same label, concatenated into one string). This reader has no
    // way to tell which footnoted fragment belongs to THIS specific catalog, so the concatenation is
    // never trustworthy — unlike Weight/Dimensions/Voltage/Current (verified correct for this exact
    // table), which read as one clean measurement per column with no footnote branching. Reuse
    // isCleanSingleSpecValue's shape check (repeated word = multiple concatenated fragments) to drop
    // these rather than add a wrong value: silence beats a confidently wrong footnote-mangled string.
    const attributes: AttributeRecord[] = [];
    for (const [label, value] of Object.entries(rows)) {
      if (!isCleanSingleSpecValue(value)) continue;
      const name = /^w\s*x\s*h\s*x\s*d$/i.test(label) ? "Dimensions" : label;
      attributes.push({
        group: "PDF Positioned Table",
        name,
        value,
        sourceUrl,
        sourceType: "official",
        parser: "pdf-positioned-table",
        confidence: 0.8
      });
    }
    return attributes;
  } catch {
    return [];
  }
}

/**
 * A tab-text PDF reader cannot assign a left-to-right comparison row to one SKU: it may emit the
 * target code together with sibling codes (for example `Grey | 1492-J3 | 100 | 1492-J4`). Once
 * the positioned reader has proved a target column, keep neither that ambiguous row nor a weaker
 * generic duplicate of a label the positioned reader scoped. Omitting an unassignable family row
 * is safer than exposing a sibling value as the target's specification.
 */
function discardUnscopedFamilyTableCandidates(
  attributes: AttributeRecord[],
  catalogNumber: string,
  positionedAttributes: AttributeRecord[]
): AttributeRecord[] {
  if (!positionedAttributes.length) return attributes;
  const positionedNames = new Set(positionedAttributes.map((attribute) => compact(canonicalLabel(attribute.name))));
  return attributes.filter((attribute) => {
    if (attribute.group === "PDF Positioned Table" || attribute.group === "PDF OCR Positioned Table") return true;
    // Electrical text mining reads an entire comparison row without x-coordinate scope. Once a
    // positioned row proves this same label for our SKU, retaining that global electrical value
    // merely keeps a known sibling candidate alive for normalization.
    if (attribute.group === "PDF Electrical Text" && positionedNames.has(compact(canonicalLabel(attribute.name)))) return false;
    if (hasMoreMeasurementsThanPositioned(attribute, positionedAttributes)) return false;
    // `Feature` is the prose sweep's fallback name. If its text repeats a positioned table label,
    // that table row has no independent target scope and the positioned row is the only evidence
    // that may survive (e.g. a family-wide `Maximum Current ... 35 A ...` line).
    if (attribute.name === "Feature" && [...positionedNames].some((name) => name.length >= 4 && compact(attribute.value).includes(name))) return false;
    // Some catalog-row sweepers retain only the cell values (`Grey 100 1492-EAJ35`) and lose
    // every column label. It is still an unstructured duplicate once the exact target SKU and at
    // least two independently positioned values prove the same visual record.
    if (attribute.name === "Feature" && containsTargetCatalog(attribute.value, catalogNumber)) {
      const positionedValueHits = positionedAttributes.filter((positioned) => {
        const value = compact(positioned.value);
        return value.length >= 3 && compact(attribute.value).includes(value);
      }).length;
      if (positionedValueHits >= 2) return false;
    }
    return !containsTargetAndSiblingCatalog(`${attribute.name} ${attribute.value}`, catalogNumber);
  });
}

function containsTargetCatalog(value: string, catalogNumber: string): boolean {
  const compactTarget = compact(catalogNumber);
  return compactTarget.length >= 4 && compact(value).includes(compactTarget);
}

/**
 * A competing same-label candidate remains valuable when it is a single clean reading: it lets
 * downstream confidence ranking correct an extractor without hiding diagnostic evidence. Drop it
 * only when the generic reader flattened MORE measurements than the positioned target column — a
 * structural proof of a multi-column family row, not merely a disagreeing value.
 */
function hasMoreMeasurementsThanPositioned(attribute: AttributeRecord, positionedAttributes: AttributeRecord[]): boolean {
  const name = compact(canonicalLabel(attribute.name));
  const scopedValues = positionedAttributes
    .filter((positioned) => compact(canonicalLabel(positioned.name)) === name)
    .map((positioned) => measurementCount(positioned.value));
  if (!scopedValues.length) return false;
  return measurementCount(attribute.value) > Math.max(...scopedValues);
}

function measurementCount(value: string): number {
  return value.match(/\b\d+(?:[.,]\d+)?\s*(?:[kmunµ]?A|[kmunµ]?V|W|Hz|°[CF]|%|mm|cm|m|kg|g|lb)\b/gi)?.length ?? 0;
}

function containsTargetAndSiblingCatalog(value: string, catalogNumber: string): boolean {
  const catalogLike = /\b[A-Z0-9]{2,}(?:[-:\/.][A-Z0-9]+)+\b|\b[A-Z]{2,}[0-9]{3,}\b/gi;
  const candidates = value.match(catalogLike) ?? [];
  const compactCatalog = compact(catalogNumber);
  const targetPrefix = new RegExp(`^${catalogNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[-:\/.])`, "i");
  const catalogTokens = candidates.filter((candidate) => compact(candidate).length >= 4 && /\d/.test(candidate));
  const hasTarget = catalogTokens.some((candidate) => sameCatalogNumber(candidate, catalogNumber) || targetPrefix.test(candidate));
  return hasTarget && catalogTokens.some((candidate) => !sameCatalogNumber(candidate, catalogNumber) && !targetPrefix.test(candidate));
}

/** OCR bbox rows must prove the same SKU column as vector PDF rows before yielding any value. */
function extractOcrPositionedTableAttributes(
  items: PositionedTextItem[] | undefined,
  catalogNumber: string,
  sourceUrl: string
): AttributeRecord[] {
  if (!items?.length) return [];
  const rows = extractPositionedTableRows(items, catalogNumber);
  if (!rows) return [];
  return Object.entries(rows).flatMap(([label, value]) => {
    if (!isCleanSingleSpecValue(value)) return [];
    return [{
      group: "PDF OCR Positioned Table",
      name: /^w\s*x\s*h\s*x\s*d$/i.test(label) ? "Dimensions" : label,
      value,
      sourceUrl,
      sourceType: "official" as const,
      parser: "pdf-ocr-positioned-table",
      confidence: 0.7
    }];
  });
}

async function readCachedPdfPageSetIfEligible(filePath: string, cacheIdentity?: string): Promise<PdfPageSet | undefined> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > FULL_PDF_TEXT_CACHE_MAX_FILE_BYTES) return undefined;
  const cacheKey = cacheIdentity ? `source:${cacheIdentity}` : `${filePath}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  let cached = pdfPageSetCache.get(cacheKey);
  if (!cached) {
    cached = readPdfPageSet(filePath).catch((error) => {
      pdfPageSetCache.delete(cacheKey);
      throw error;
    });
    pdfPageSetCache.set(cacheKey, cached);
    trimPdfPageSetCache();
  }
  return cached;
}

/**
 * Reaches into `pdf-parse`'s `PDFParse` instance for the `pdfjs-dist` document it already loaded, so
 * the positioned-table reader can reuse it instead of a second full `pdfjs.getDocument()` parse of
 * the same file (confirmed live at ~30-45% of a document's total processing time on real Saginaw/SCE
 * accessory manuals). `doc` is a TypeScript-only `private` field — a plain runtime property, not a
 * true ECMAScript `#private` field — so this is inherently coupled to pdf-parse's current internals.
 * A future pdf-parse upgrade that renames or truly hides it fails CLOSED (returns undefined here),
 * which safely falls back to the old file-reopen path: only ever a lost speed win, never a
 * correctness risk, since every caller already handles "no cached items" today.
 */
async function capturePositionedPagesFromParser(parser: PDFParse, pageNumbers: number[]): Promise<Map<number, PositionedTextItem[]> | undefined> {
  const doc = (parser as unknown as { doc?: { getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): void }> } }).doc;
  if (!doc) return undefined;
  const byPage = new Map<number, PositionedTextItem[]>();
  try {
    for (const pageNumber of pageNumbers) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const items: PositionedTextItem[] = [];
        for (const item of content.items) {
          if (typeof (item as { str?: unknown }).str !== "string") continue;
          const textItem = item as { str: string; transform: number[] };
          items.push({ text: textItem.str, x: textItem.transform[4], y: textItem.transform[5], orientation: positionedItemOrientationFromTransform(textItem.transform) });
        }
        byPage.set(pageNumber, items);
      } finally {
        page.cleanup();
      }
    }
  } catch {
    // Fail closed on the WHOLE capture, not just the failing page: a partial map would silently
    // under-scan for whichever pages didn't make it in, which is worse than no cache at all.
    return undefined;
  }
  return byPage;
}

async function readPdfPageSet(filePath: string): Promise<PdfPageSet> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const parsed = await parser.getText();
    if (parsed.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) {
      const nativePages = parsed.pages.map((page) => ({ num: page.num, text: page.text }));
      const pagesToOcr = pdfPagesNeedingOcr(nativePages).filter((page) => page <= MAX_PDF_PAGES);
      let pages = nativePages;
      const ocrPositionedItemsByPage = new Map<number, PositionedTextItem[]>();
      if (pagesToOcr.length) {
        const ocr = await readPdfWithOptionalOcr(filePath, {
          maxPages: MAX_PDF_PAGES,
          pageNumbers: pagesToOcr,
          // Operational A/B valve: force a locally installed OCR language while investigating a
          // document, but leave production on context-based selection. Invalid overrides safely
          // fall back to English inside readPdfWithOptionalOcr.
          language: process.env.PRODUCT_SCRAPER_OCR_LANGUAGE?.trim() || inferOcrLanguage(nativePages.map((page) => page.text).join("\n"))
        });
        const acceptedOcr = new Map((ocr.pages ?? [])
          .filter((page) => page.quality?.accepted && page.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE)
          .map((page) => [page.num, page]));
        for (const page of acceptedOcr.values()) {
          if (page.positionedItems?.length) ocrPositionedItemsByPage.set(page.num, page.positionedItems);
        }
        if (acceptedOcr.size) pages = nativePages.map((page) => ({ ...page, text: acceptedOcr.get(page.num)?.text ?? page.text }));
      }
      const tablesByPage = await safeGetTablesByPage(parser, pages.slice(0, MAX_PDF_PAGES).map((page) => page.num));
      // Full page range, not capped to MAX_PDF_PAGES: extractPositionedTableRowsFromPdf's own
      // per-page loop has no such cap (a family catalog's target table can sit well past page 30 —
      // confirmed on the 57-page eaton-cbe03319 catalog), and this capture must cover everything
      // that reader would have scanned itself, or it would silently narrow coverage instead of just
      // saving time.
      const nativePositionedItemsByPage = await capturePositionedPagesFromParser(parser, nativePages.map((page) => page.num));
      return { pages, tablesByPage, ocrPositionedItemsByPage, nativePositionedItemsByPage, fromOcr: false };
    }
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  const ocr = await readPdfWithOptionalOcr(filePath, { maxPages: MAX_PDF_PAGES });
  if (ocr.quality?.accepted && ocr.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) {
    return {
      pages: [{ num: 1, text: ocr.text }],
      tablesByPage: new Map(),
      ocrPositionedItemsByPage: new Map((ocr.pages ?? []).flatMap((page) => page.positionedItems?.length ? [[page.num, page.positionedItems]] : [])),
      fromOcr: true
    };
  }
  throw new Error(ocr.error ? `PDF has no extractable text and OCR failed: ${ocr.error}` : "PDF has no extractable text and OCR returned no text.");
}

/**
 * Pick the pages relevant to ONE catalog number out of an already-parsed page set. Mirrors the
 * page selection `readTargetedPdfText` does for oversized documents (catalog pages + a neighbour
 * window + the technically densest shared pages), so both readers scope identically.
 *
 * The shared-technical-page part matters more than it looks: in a family catalog the per-variant
 * ordering row and the family's "Technical Data" table are on different pages, and the technical
 * page never names our catalog number — so without it, a correctly-scoped read returns the ordering
 * row and nothing else.
 */
function selectPdfTextFromPageSet(pageSet: PdfPageSet, catalogNumber?: string): PdfDocumentText {
  const { pages } = pageSet;
  const pageCount = pages.length;
  let keptPages: number[] | undefined;

  if (!pageSet.fromOcr) {
    const compactCatalog = catalogNumber ? compactKey(catalogNumber) : "";
    const matches = compactCatalog
      ? pages.filter((page) => compactKey(page.text).includes(compactCatalog)).map((page) => page.num).slice(0, TARGETED_PDF_MAX_SECTION_PAGES)
      : [];
    if (matches.length) {
      const keep = expandWithNeighbours(matches, TARGETED_PDF_NEIGHBOUR_PAGES);
      for (const num of selectGlobalTechnicalPages(pages, keep, matches)) keep.add(num);
      keptPages = pages.filter((page) => keep.has(page.num)).map((page) => page.num);
    } else if (pageCount > MAX_PDF_PAGES) {
      // No page names the catalog number and the document is long: its first pages are usually a
      // cover/TOC/intro, so read the technically densest pages rather than reading blind.
      const technical = selectGlobalTechnicalPages(pages, new Set<number>());
      if (technical.length) keptPages = technical;
    }
  }

  const selected = keptPages
    ? pages.filter((page) => keptPages!.includes(page.num) && !isUnrelatedCatalogTablePage(page, catalogNumber))
    : pages.slice(0, MAX_PDF_PAGES);
  const joined = selected.map((page) => page.text).join("\n");
  const tables: TableArray[] = [];
  const ocrPositionedItems = selected.flatMap((page) => pageSet.ocrPositionedItemsByPage.get(page.num) ?? []);
  for (const page of selected) {
    const pageTables = pageSet.tablesByPage.get(page.num);
    if (pageTables?.length) tables.push(...pageTables);
  }

  return {
    text: joined.slice(0, MAX_PDF_TEXT_CHARS),
    tables,
    ...(ocrPositionedItems.length ? { ocrPositionedItems } : {}),
    pagesUsed: selected.map((page) => page.num),
    pageCount,
    truncated: joined.length > MAX_PDF_TEXT_CHARS,
    // Deliberately the FULL per-page map from the page set, not scoped to `selected`: the
    // positioned-table reader needs every page in original document order for its own
    // carried-header/new-table-boundary logic, exactly as it does when it opens the file itself.
    ...(pageSet.nativePositionedItemsByPage ? { nativePositionedItemsByPage: pageSet.nativePositionedItemsByPage } : {})
  };
}

/**
 * A one-page neighbour is useful when a target table continues without repeating its header, but
 * it must not pull in the next (or previous) complete ordering/comparison table for other SKUs.
 * Such a page is independently self-identifying: it starts a fresh catalog table and never names
 * our catalog. Letting its raw tab-separated rows into the generic text pass turns a sibling's
 * values into target attributes before the catalog-aware positioned reader can correct them.
 */
function isUnrelatedCatalogTablePage(page: { text: string }, catalogNumber?: string): boolean {
  const target = compactKey(catalogNumber ?? "");
  if (!target || compactKey(page.text).includes(target)) return false;
  return page.text
    .split(/\r?\n/)
    .some((line) => line.split(/\t+/).map(cleanText).some((cell) => isCatalogIdHeaderCell(cell)));
}

const GET_TABLE_MAX_CONSECUTIVE_ERRORS = 3;
let getTableConsecutiveErrors = 0;
// Negative cache, same idea as pdf-ocr.ts's externalOcrToolsUnavailableReason: pdf-parse's
// getTable() has real unguarded array-index bugs for some vector-drawing edge cases (confirmed
// against real-world datasheets across several manufacturers — it throws "Cannot read
// properties of undefined (reading 'from')" on documents whose grid geometry it can't normalize).
// A THROWN error trips this; a legitimate empty result (most datasheets have no vector-grid
// table at all) does not, since that's a valid outcome and must not disable the feature.
let getTableDisabledReason: string | undefined;

/**
 * getTable() detects tables from vector-drawn grid lines (bordered ordering/catalog tables),
 * independent of the whitespace/tab heuristics the rest of this file uses on linear text. Some
 * PDFs have no such vector grid (most datasheets don't) — that's not an error, just no tables.
 */
async function safeGetTables(parser: InstanceType<typeof PDFParse>, pageNumbers: number[]): Promise<TableArray[]> {
  if (!pageNumbers.length || getTableDisabledReason) return [];
  try {
    const result = await parser.getTable({ partial: pageNumbers });
    getTableConsecutiveErrors = 0;
    return result.mergedTables ?? [];
  } catch (error) {
    getTableConsecutiveErrors += 1;
    if (getTableConsecutiveErrors >= GET_TABLE_MAX_CONSECUTIVE_ERRORS) {
      getTableDisabledReason = `pdf-parse getTable() threw ${GET_TABLE_MAX_CONSECUTIVE_ERRORS}x in a row (${error instanceof Error ? error.message : String(error)}) — disabled for the rest of this run.`;
    }
    return [];
  }
}

/**
 * Same call as `safeGetTables`, but keeps pdf-parse's per-page attribution instead of the flattened
 * `mergedTables`. Needed so a page-scoped read hands the extractors only the tables that live on the
 * pages it kept — passing every table from the first 30 pages alongside text scoped to pages 4-7
 * would smuggle other variants' rows back in through the table channel.
 */
async function safeGetTablesByPage(
  parser: InstanceType<typeof PDFParse>,
  pageNumbers: number[]
): Promise<Map<number, TableArray[]>> {
  const byPage = new Map<number, TableArray[]>();
  if (!pageNumbers.length || getTableDisabledReason) return byPage;
  try {
    const result = await parser.getTable({ partial: pageNumbers });
    getTableConsecutiveErrors = 0;
    for (const page of result.pages ?? []) {
      if (page?.tables?.length) byPage.set(page.num, page.tables);
    }
    return byPage;
  } catch (error) {
    getTableConsecutiveErrors += 1;
    if (getTableConsecutiveErrors >= GET_TABLE_MAX_CONSECUTIVE_ERRORS) {
      getTableDisabledReason = `pdf-parse getTable() threw ${GET_TABLE_MAX_CONSECUTIVE_ERRORS}x in a row (${error instanceof Error ? error.message : String(error)}) — disabled for the rest of this run.`;
    }
    return byPage;
  }
}

function trimPdfPageSetCache(): void {
  while (pdfPageSetCache.size > FULL_PDF_TEXT_CACHE_MAX_ENTRIES) {
    const oldest = pdfPageSetCache.keys().next().value;
    if (!oldest) return;
    pdfPageSetCache.delete(oldest);
  }
}

/**
 * Multi-model technical-data PDFs (Rockwell 1783-td***, Eaton catalogs, etc.) inline
 * spec tables for many catalog numbers. Reading the first 30 pages either misses the
 * requested model or mixes its specs with others. This walks pages one at a time, finds
 * pages that mention the catalog number (compact-matched, like the rest of the pipeline),
 * and returns those pages plus a small neighbour window — typically a handful of pages
 * even for a 100+ page document.
 *
 * Returns undefined when the catalog number isn't found anywhere in the first
 * TARGETED_PDF_MAX_PAGES pages, letting the caller fall back to the first-N-pages reader.
 */
async function readTargetedPdfText(parser: InstanceType<typeof PDFParse>, catalogNumber: string): Promise<PdfDocumentText | undefined> {
  const compactCatalog = compactKey(catalogNumber);
  if (!compactCatalog) return undefined;
  const matches: number[] = [];
  const pages: Array<{ num: number; text: string }> = [];
  // pdf-parse exposes getText({partial:[n]}) for single-page reads; we walk pages until we
  // either run out, hit our budget, or have collected enough matches to be confident the
  // requested model's section has been captured.
  for (let pageNum = 1; pageNum <= TARGETED_PDF_MAX_PAGES; pageNum += 1) {
    let pageResult;
    try {
      pageResult = await parser.getText({ partial: [pageNum] });
    } catch {
      break;
    }
    const pageText = pageResult.pages?.[0]?.text;
    if (typeof pageText !== "string") break;
    pages.push({ num: pageNum, text: pageText });
    if (compactKey(pageText).includes(compactCatalog)) {
      matches.push(pageNum);
      if (matches.length >= TARGETED_PDF_MAX_SECTION_PAGES) break;
    }
    if (pageResult.total && pageNum >= pageResult.total) break;
  }
  if (!matches.length) {
    // No page names the catalog number. For a SMALL document, fall back (undefined) to the
    // first-N-pages reader — that's the whole doc anyway and keeps the title/description page.
    // For a LARGE document, the first N pages are usually a cover/TOC/intro, so instead return
    // the technically densest pages we already walked rather than reading blind.
    if (pages.length <= MAX_PDF_PAGES) return undefined;
    const technicalPages = new Set(selectGlobalTechnicalPages(pages, new Set<number>()));
    if (!technicalPages.size) return undefined;
    const keptPageNumbers = [...technicalPages];
    return {
      text: pages.filter((page) => technicalPages.has(page.num)).map((page) => page.text).join("\n"),
      tables: await safeGetTables(parser, keptPageNumbers)
    };
  }
  const keepPages = expandWithNeighbours(matches, TARGETED_PDF_NEIGHBOUR_PAGES);
  for (const num of selectGlobalTechnicalPages(pages, keepPages, matches)) keepPages.add(num);
  const keepPageNumbers = pages
    .filter((page) => keepPages.has(page.num) && !isUnrelatedCatalogTablePage(page, catalogNumber))
    .map((page) => page.num);
  return {
    text: pages.filter((page) => keepPageNumbers.includes(page.num)).map((page) => page.text).join("\n"),
    tables: await safeGetTables(parser, keepPageNumbers)
  };
}

/**
 * Pages carrying shared technical data worth reading alongside our catalog's own pages.
 *
 * With `nearPages` set (we DID find our catalog), candidates are ranked by distance to the nearest
 * of those pages and capped to a nearby window. This matters in a multi-family catalog: ranking the
 * whole document by keyword density picks the OTHER families' technical pages, since they score just
 * as high as ours. Confirmed on Eaton's E6 catalogue — reading the globally densest pages pulled in
 * pages 12/26/30 (E6 Industry Standard, ED6, ELD6) and produced "6...40 A" as the rated current of a
 * 1 A breaker. A family's shared spec page sits next to its own ordering table; a page twenty pages
 * away belongs to somebody else.
 *
 * Without `nearPages` (catalog not found anywhere in a long document) the old behaviour stands: read
 * the densest technical pages rather than reading blind.
 */
function selectGlobalTechnicalPages(
  pages: Array<{ num: number; text: string }>,
  alreadyKept: Set<number>,
  nearPages?: number[]
): number[] {
  const anchors = nearPages?.length ? nearPages : undefined;
  const distanceTo = (num: number): number =>
    anchors ? Math.min(...anchors.map((anchor) => Math.abs(anchor - num))) : 0;

  const candidates = pages
    .filter((page) => !alreadyKept.has(page.num))
    .map((page) => ({ num: page.num, score: globalTechnicalPageScore(page.text), distance: distanceTo(page.num) }))
    .filter((page) => page.score >= 6 && (!anchors || page.distance <= TARGETED_PDF_TECHNICAL_PAGE_MAX_DISTANCE))
    .sort((left, right) =>
      anchors
        ? left.distance - right.distance || right.score - left.score || left.num - right.num
        : right.score - left.score || left.num - right.num
    );

  const limit = anchors ? TARGETED_PDF_NEAR_TECHNICAL_PAGES : TARGETED_PDF_MAX_GLOBAL_TECHNICAL_PAGES;
  return candidates.slice(0, limit).map((page) => page.num);
}

function globalTechnicalPageScore(text: string): number {
  const cleaned = cleanText(text);
  if (!cleaned) return 0;
  let score = 0;
  if (/\b(?:technical\s+(?:data|specifications?)|specifications?|electrical\s+(?:data|ratings?))\b/i.test(cleaned)) score += 5;
  if (/[\u6280\u672f]\s*[\u53c2\u6570]|\u89c4\u683c|\u6280\u672f\u89c4\u683c/.test(cleaned)) score += 5;
  if (/\b(?:input|output|rated|supply|operating)\s+voltage\b/i.test(cleaned) || /\u7535\u538b/.test(cleaned)) score += 3;
  if (/\b(?:rated|output|input)\s+current\b/i.test(cleaned) || /\u7535\u6d41/.test(cleaned)) score += 2;
  if (/\b(?:power|kw|w)\b/i.test(cleaned) || /\u529f\u7387/.test(cleaned)) score += 2;
  if (/\bIP\s*\d{2}\b/i.test(cleaned) || /\u9632\u62a4\u7b49\u7ea7/.test(cleaned)) score += 2;
  if (/\b(?:dimensions?|weight)\b/i.test(cleaned)) score += 2;
  if (/(?:\u5c3a\u5bf8|\u91cd\u91cf)/.test(cleaned)) score += 4;
  if (/(?:\u5c3a\u5bf8|\u91cd\u91cf)[\s\S]{0,500}\bW\b[\s\S]{0,80}\bH\b[\s\S]{0,80}\bD\b/i.test(cleaned)) score += 4;
  if (/(?:\u5c3a\u5bf8|\u91cd\u91cf)[\s\S]{0,500}\bkg\b/i.test(cleaned)) score += 3;
  if (/\b(?:warranty|terms|company|copyright|contents)\b/i.test(cleaned)) score -= 4;
  return score;
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

function shouldParsePdfDocument(doc: DocumentRecord): boolean {
  if (doc.enrichable === false) return false;
  if (doc.downloadStatus && doc.downloadStatus !== "downloaded") return false;
  if (!doc.localPath) return false;
  if (!/\.pdf$/i.test(doc.localPath) && !isPdfLikeDocumentUrl(doc.url)) return false;
  return ["datasheet", "certificate", "manual", "other"].includes(doc.type);
}

function shouldProbeRemotePdfDocument(doc: DocumentRecord): boolean {
  return Boolean(remoteProbeDocumentCandidate(doc));
}

function remoteProbeDocumentCandidate(doc: DocumentRecord): DocumentRecord | undefined {
  if (doc.enrichable === false) return undefined;
  if (doc.localPath || doc.parseStatus === "parsed") return undefined;
  if (doc.downloadStatus === "failed") return undefined;
  if (!["datasheet", "manual", "other"].includes(doc.type)) return undefined;
  const urls = [doc.url, ...(doc.candidateUrls ?? [])];
  const text = `${doc.type} ${doc.label} ${urls.join(" ")}`;
  if (doc.type === "other" && !/\b(?:data\s*sheet|datasheet|technical|spec(?:ification)?|manual|installation|instruction)\b/i.test(text)) {
    return undefined;
  }
  const url = urls.find((candidate) => isPdfLikeDocumentUrl(candidate));
  if (!url) return undefined;
  return {
    ...doc,
    url,
    candidateUrls: urls.filter((candidate) => candidate !== url)
  };
}

function prioritizeRemoteProbeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return [...documents].sort((left, right) => remoteProbeDocumentScore(right) - remoteProbeDocumentScore(left));
}

function prioritizeDownloadedDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return [...documents].sort((left, right) => remoteProbeDocumentScore(right) - remoteProbeDocumentScore(left));
}

function shouldSkipAfterStrongDocumentEvidence(doc: DocumentRecord, attributes: AttributeRecord[]): boolean {
  if (doc.type === "datasheet" || doc.type === "certificate") return false;
  if (attributes.length < 8) return false;
  const text = attributes.map((attr) => `${attr.group} ${attr.name} ${attr.value}`).join("\n");
  let score = 0;
  if (/\b(?:catalog number|model code|type code)\b/i.test(text)) score += 1;
  if (/\b(?:rated voltage|input voltage|voltage)\b/i.test(text)) score += 1;
  if (/\b(?:rated current|current)\b/i.test(text)) score += 1;
  if (/\b(?:rated power|power)\b/i.test(text)) score += 1;
  if (/\b(?:dimensions?|weight)\b/i.test(text)) score += 1;
  if (/\bIP\s*\d{2}/i.test(text)) score += 1;
  return score >= 4;
}

function remoteProbeDocumentScore(doc: DocumentRecord): number {
  const text = `${doc.type} ${doc.label} ${doc.url}`.toLowerCase();
  let score = 0;
  // The generated Eaton SKU PDF is the only document guaranteed to describe this exact
  // catalog number. Prefer it over broad product-family catalogs and manuals.
  if (/^https:\/\/www\.eaton\.com(?:\.cn)?\/[^?#]+\/skuPage\.[^/?#]+\.pdf(?:[?#]|$)/i.test(doc.url)) score += 500;
  if (doc.type === "datasheet") score += 90;
  if (doc.type === "manual") score += 70;
  if (/\b(?:data\s*sheet|datasheet|technical\s+data|technical\s+datasheet|spec(?:ification)?\s+sheet|cutsheet)\b/i.test(text)) score += 35;
  if (/\b(?:installation|install|instruction|user\s+manual|manual)\b/i.test(text)) score += 25;
  if (/\b(?:certificate|declaration|conformity|rohs|reach|weee|warranty)\b/i.test(text)) score -= 45;
  if (isPdfLikeDocumentUrl(doc.url)) score += 8;
  if (doc.parseStatus === "failed") score -= 80;
  return score;
}

function uniqueKnownLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const label of labels) {
    const cleaned = cleanText(label);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }
  return unique;
}

function isUsefulTechnicalAliasPdfLabel(value: string): boolean {
  const label = cleanText(value);
  if (/^SCCR$/i.test(label)) return true;
  if (label.length < 4 || label.length > 140) return false;
  if (!/[a-z]/i.test(label)) return false;
  if (/^(?:Ue|Us|Ub|Un|Ur|Uc|Ie|In|Iu|Ith|Inm|Inom|IN|Icu|Ics|Icw|Icm|Icn|Iq|AIC|Pv|Pvs|Pls|Ple|PlIp|P2|Pm|P_N)$/i.test(label)) {
    return false;
  }
  return /[\s,\/()[\]_-]/.test(label) || label.length >= 8;
}

/**
 * Single choke point for everything the PDF readers produce, so the plausibility gate lives in ONE
 * place instead of in each of the dozen extractors above. A pair that is prose, boilerplate, a
 * table-of-contents leader run, control-character garbage from a broken font cmap, or the table's own
 * header row parsed as data is dropped here rather than shipped to the Attributes sheet and PDT.
 */
function keepPlausibleDocumentAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  if (specPlausibilityGateDisabled()) return attributes;
  return attributes.filter((attr) => {
    const value = String(attr.value ?? "");
    // "Parsed document" is internal bookkeeping, not vendor data: its value IS the document's label by
    // design, so the download-decoration rule fired on it ("CERT 00045 655.6 KB English") and quietly
    // removed the marker. Exempt it entirely — the plausibility gate exists to judge extracted CONTENT.
    if (/^Parsed document$/i.test(attr.name)) return true;
    if (!isPlausibleSpecValue(value)) return false;
    // "Feature" rows carry free text by design and have no label/value shape, so only their VALUE is
    // gated — a label check would reject them wholesale.
    if (!/^Feature$/i.test(attr.name) && !isPlausibleSpecLabel(attr.name)) return false;
    return !looksLikeHeaderRowValue(value, isKnownDocumentLabel);
  });
}

/**
 * Is this cell a column LABEL? Used by the header-row test.
 *
 * Consults the ontology as well as the local list, because header-row detection can only fire when it
 * recognises EVERY cell in the row: an Eaton ordering header survived as a bogus attribute purely
 * because `Part number` and `Article number` are missing from `KNOWN_LABELS` — while the ontology maps
 * both to `partNumber`. Padding the list per vendor is the pattern that caused the problem; asking the
 * engine that already knows is the fix.
 *
 * Safe to widen: `looksLikeHeaderRowValue` additionally requires the row to carry no value digits and
 * to consist of at least three labels, so a real data row cannot be mistaken for a header.
 *
 * The word cap on the ontology path is load-bearing. `matchProperty` matches a synonym ANYWHERE in the
 * string, so without it a 5-word slice like "Rated current In Part number" matches on "Rated current"
 * alone and the greedy segmentation in `looksLikeHeaderRowValue` swallows words belonging to the next
 * label — which is exactly how the Eaton header row kept escaping detection. A header CELL is a short
 * noun phrase; the exact-list path above still handles longer known labels.
 */
const ONTOLOGY_HEADER_CELL_MAX_WORDS = 3;

function isKnownDocumentLabel(candidate: string): boolean {
  const normalized = canonicalLabel(candidate).toLowerCase();
  if (!normalized) return false;
  if (KNOWN_LABELS.some((label) => label.toLowerCase() === normalized)) return true;
  if (isCatalogTableHeaderText(candidate)) return true;
  const wordCount = candidate.trim().split(/\s+/).filter(Boolean).length;
  return wordCount <= ONTOLOGY_HEADER_CELL_MAX_WORDS && looksLikeUnderstandableSpec(candidate);
}

function stampDocumentAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return keepPlausibleDocumentAttributes(attributes).map((attr) => ({
    ...attr,
    sourceType: "generated",
    parser: "pdf-table-extractor",
    stage: "enrich-documents",
    // Real bug: this used to overwrite EVERY attribute's confidence to the same flat value
    // regardless of source, silently erasing the very distinction extractGenericCatalogTableRows/
    // extractGetTableCatalogRows rely on to outrank extractInlineDimensionText's catalog-agnostic
    // text sweep (both ended up at 0.78, so whichever happened to be earlier in array order won
    // ties — Rockwell's "Battery Modules" table kept several sibling rows in one scope, so the
    // WRONG sibling's dimensions won for 1606-XLSBATASSY1 even after its own row was correctly,
    // separately verified and extracted). Catalog-verified table-row attributes now keep a
    // distinctly higher tier than the generic default.
    // "PDF Positioned Table" (extractPositionedWeightDimensionsSafely, pdf-positioned-table.ts)
    // needs the SAME distinct tier for the SAME reason: this stamping step used to flatten its
    // 0.8 confidence down to the generic 0.78 as well, tying it with the very text-derived reading
    // it exists to override — with a tie, Array#sort's stability in bestAttribute (facts.ts) let
    // whichever was pushed first win, and the wrong buildVariantColumnContext-derived value is
    // always pushed before this fallback runs. Confirmed live: a merged-identical-adjacent-value
    // column shifts non-Weight/Dimensions/Voltage/Current rows (Efficiency, Adjustment Range,
    // Output Power, MTBF, ...) exactly like it used to for those four fields, and the shifted
    // reading still passes isCleanSingleSpecValue's shape check — so only a genuinely higher
    // confidence tier, not just "being added as a candidate", makes the correct value win.
    confidence: attr.group?.includes("Matched Rows")
      ? 0.66
      : attr.group === "PDF Positioned Table"
        ? 0.88
        : attr.group === "PDF Catalog Table Row" || attr.group === "PDF Table (Grid)"
          ? 0.85
          : 0.78
  }));
}

function normalizePdfLines(text: string): string[] {
  return text
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/Â°C/g, "°C")
    .replace(/ǻ/g, "Δ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => cleanText(line));
}

function shouldSkipPdfLine(line: string): boolean {
  return (
    /^--\s*\d+\s+of\s+\d+\s*--$/i.test(line) ||
    /^\d+\s*\/\s*\d+$/.test(line) ||
    /^www\./i.test(line) ||
    /^subject to change without notice/i.test(line) ||
    /^all dimensions without tolerances/i.test(line) ||
    line.length > 700
  );
}

function parseTabbedPair(rawLine: string): { name: string; value: string } | undefined {
  if (!rawLine.includes("\t")) return undefined;
  const cells = rawLine
    .split(/\t+/)
    .map(cleanText)
    .filter(Boolean);
  if (cells.length < 2) return undefined;
  const name = cells[0];
  const values = cells.slice(1);
  // A multi-column comparison-table ROW ("Weight \t930 g \t440 g \t620 g \t620 g \t900 g \t900 g")
  // has one DIFFERENT model's value per cell — joinUniquePipeCells below is meant for a field with
  // several genuinely valid values (e.g. a Feature listing multiple options), not several
  // different products' measurements smashed into one "Weight: 930 g | 440 g | 620 g" string
  // (confirmed live on several Rockwell multi-model families, see looksLikeMultiColumnDataRow).
  if (values.length >= 2 && values.filter((cell) => MULTI_COLUMN_VALUE_CELL_PATTERN.test(cell)).length >= 2) return undefined;
  const value = normalizePdfAttributeValue(joinUniquePipeCells(values));
  if (!isLikelyAttributeName(name) || !value) return undefined;
  return { name, value };
}

function parseSpacedTablePair(rawLine: string): { name: string; value: string } | undefined {
  const cells = rawLine
    .split(/\s{2,}/)
    .map(cleanText)
    .filter(Boolean);
  if (cells.length < 2) return undefined;
  const [name, ...values] = cells;
  // Same multi-column-row guard as parseTabbedPair above.
  if (values.length >= 2 && values.filter((cell) => MULTI_COLUMN_VALUE_CELL_PATTERN.test(cell)).length >= 2) return undefined;
  const value = normalizePdfAttributeValue(joinUniquePipeCells(values));
  if (!isLikelyAttributeName(name) || !value || /^[-–—]+$/.test(value)) return undefined;
  if (!/[a-z]/i.test(name) || value.length > 300) return undefined;
  return { name, value };
}

function joinUniquePipeCells(cells: string[]): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const cell of cells) {
    const trimmed = cleanText(cell);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique.join(" | ");
}

function parseKnownInlinePair(line: string): { name: string; value: string } | undefined {
  for (const label of KNOWN_LABELS) {
    const pattern = new RegExp(`^${escapeRegExp(label)}\\s+(.+)$`, "i");
    const match = line.match(pattern);
    if (!match) continue;
    const value = normalizePdfAttributeValue(match[1]);
    if (!value || value.toLowerCase() === label.toLowerCase()) continue;
    if (isPdfLabelQualifierOnly(value)) continue;
    return { name: canonicalLabel(label), value };
  }
  return undefined;
}

function parseRegistryAliasInlinePair(line: string): { name: string; value: string } | undefined {
  const tokens = cleanText(line).split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return undefined;
  const maxLabelTokens = Math.min(8, tokens.length - 1);
  for (let tokenCount = 1; tokenCount <= maxLabelTokens; tokenCount += 1) {
    const name = tokens.slice(0, tokenCount).join(" ");
    const rawValue = tokens.slice(tokenCount).join(" ");
    if (!isLikelyRegistryInlineLabel(name)) continue;
    if (!FIELD_REGISTRY.some((field) => fieldMatchesLabel(field.key, name))) continue;
    const value = normalizePdfAttributeValue(rawValue);
    if (!value || value.toLowerCase() === name.toLowerCase()) continue;
    if (isPdfLabelQualifierOnly(value)) continue;
    if (!isLikelyInlineKnownValue(value)) continue;
    return { name: canonicalLabel(name), value };
  }
  return undefined;
}

function isLikelyRegistryInlineLabel(value: string): boolean {
  const label = cleanText(value);
  if (label.length < 4 || label.length > 80) return false;
  if (/^(?:figure|table|page|section|catalog|part|order|type|model)$/i.test(label)) return false;
  if (/^(?:IP\s*\d+|NEMA|RAL)$/i.test(label)) return true;
  return label.split(/\s+/).length >= 2;
}

function parseMultipleKnownInlinePairs(line: string): Array<{ name: string; value: string }> {
  const matches: Array<{ label: string; index: number; end: number }> = [];
  for (const label of KNOWN_LABELS) {
    const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(label)}(?=\\s+\\S)`, "ig");
    for (const match of line.matchAll(pattern)) {
      const rawIndex = match.index ?? 0;
      const prefixLength = match[0].length - label.length;
      const index = rawIndex + prefixLength;
      if (matches.some((existing) => rangesOverlap(index, index + label.length, existing.index, existing.end))) continue;
      matches.push({ label, index, end: index + label.length });
    }
  }
  const ordered = matches.sort((left, right) => left.index - right.index);
  if (ordered.length < 2) return [];

  const pairs: Array<{ name: string; value: string }> = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const value = normalizePdfAttributeValue(line.slice(current.end, next?.index ?? line.length));
    if (!value || value.toLowerCase() === current.label.toLowerCase()) continue;
    if (!isLikelyInlineKnownValue(value)) continue;
    pairs.push({ name: canonicalLabel(current.label), value });
  }
  return pairs;
}

function normalizePdfAttributeValue(value: string): string {
  const cleaned = cleanText(value)
    .replace(/\s*\|\s*/g, " | ")
    .trim();
  const unitPrefix = cleaned.match(/^(?:\[|\()?\s*(V\s?AC|V\s?DC|VAC|VDC|V|mA|kA|A|kW|W|VA|Hz|kg|g|lbs?|mm|cm|m|in|Nm|N\s*m|Â°C|°C|degC|%)(?:\s*(?:\]|\)))?\s*(?:\|\s*)?(.+)$/i);
  if (!unitPrefix) return cleaned;
  const unit = canonicalPdfUnit(unitPrefix[1]);
  const rest = cleanText(unitPrefix[2]).replace(/^\|\s*/, "");
  if (!/^[-+]?\d/.test(rest)) return cleaned;
  if (new RegExp(`\\b${escapeRegExp(unit)}\\b`, "i").test(rest)) return rest;
  return cleanText(`${rest} ${unit}`);
}

function canonicalPdfUnit(unit: string): string {
  const compact = unit.replace(/\s+/g, "").toLowerCase();
  if (compact === "vac") return "V AC";
  if (compact === "vdc") return "V DC";
  if (compact === "lb" || compact === "lbs") return "lb";
  if (compact === "nm") return "N m";
  if (compact === "degc" || compact === "â°c" || compact === "°c") return "Â°C";
  return cleanText(unit);
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function isLikelyInlineKnownValue(value: string): boolean {
  if (value.length > 180) return false;
  if (/^(?:-|n\/?a|not available|none)$/i.test(value)) return false;
  // `parseMultipleKnownInlinePairs` matches a known label ANYWHERE in a line, not just at its
  // start — a marketing sentence that happens to repeat the label mid-prose ("...offer protection
  // over the entire tripping frequency range up to 20 kHz...") then gets the text up to the next
  // matched label sliced out as if it were that label's value. A prose fragment starting with a
  // lowercase grammatical continuation word is never a real spec value even if it contains a
  // digit further in ("range up to 20 kHz"), unlike a real value that starts directly with the
  // number/enum ("0 Hz ... 150 kHz", "type B").
  if (/^(?:range|up|over|the|of|and|with|in|on|for|or|was|are|to|a|an|this|that|which|therefore|however|since|because|respectively)\b/i.test(value)) {
    return false;
  }
  return /\d|[A-Z]{2,}|steel|aluminum|aluminium|plastic|poly|powder|coating|paint|nema|ip\s*\d|ce|ul|csa|rohs|reach/i.test(value);
}

function isPdfLabelQualifierOnly(value: string): boolean {
  // "with" catches a real Doepke case: "Cross section AWG, flexible with ferrule" sometimes wraps
  // as "Cross section AWG, flexible with" / "ferrule" / value — the shorter registered label
  // "Cross section AWG, flexible" then prefix-matches that first line with "with" left over as a
  // dangling connector word, not a real value (WRAPPED_LABEL_SPECS handles the actual fact).
  return /^(?:xt|standard|std|safety|nse|conformal(?:ly)? coated|coated|non[-\s]?safety|with)$/i.test(cleanText(value));
}

function isKnownLabelWithQualifierOnly(line: string): boolean {
  for (const label of KNOWN_LABELS) {
    const pattern = new RegExp(`^${escapeRegExp(label)}\\s+(.+)$`, "i");
    const match = line.match(pattern);
    if (match && isPdfLabelQualifierOnly(match[1])) return true;
  }
  return false;
}

function isKnownLabelOnly(line: string): boolean {
  return KNOWN_LABELS.some((label) => line.toLowerCase() === label.toLowerCase());
}

function isLikelyAttributeName(value: string): boolean {
  return value.length >= 2 && value.length <= 100 && !/^(image|figure|table|page|\d+)$/.test(value.toLowerCase());
}

function nextMeaningfulLine(lines: string[], start: number): string | undefined {
  for (let index = start; index < Math.min(lines.length, start + 4); index += 1) {
    const line = cleanText(lines[index]);
    if (!line || shouldSkipPdfLine(line) || isKnownLabelOnly(line)) continue;
    return line;
  }
  return undefined;
}

function nextPdfLabelValue(lines: string[], start: number): string | undefined {
  const first = nextMeaningfulLine(lines, start);
  if (!first) return undefined;
  if (!isStandalonePdfUnit(first)) return normalizePdfAttributeValue(first);
  const second = nextMeaningfulLine(lines, start + 1);
  if (!second || !/^[-+]?\d/.test(cleanText(second))) return normalizePdfAttributeValue(first);
  return normalizePdfAttributeValue(`${first} ${second}`);
}

function isStandalonePdfUnit(value: string): boolean {
  if (/^(?:\[|\()?\s*inches?\s*(?:\]|\))?$/i.test(cleanText(value))) return true;
  return /^(?:\[|\()?\s*(V\s?AC|V\s?DC|VAC|VDC|V|mA|kA|A|kW|W|VA|Hz|kg|g|lbs?|mm|cm|m|in|Nm|N\s*m|Â°C|°C|degC|%)(?:\s*(?:\]|\)))?$/i.test(cleanText(value));
}

function isUsefulFeatureLine(line: string, catalogNumber: string): boolean {
  if (catalogTextMatches(line, catalogNumber)) return true;
  return /\b(ce|ul|csa|vde|rohs|reach|weee|nema|ip\s*\d+|stainless|steel|cast iron|brass|copper|aluminium|aluminum|polycarbonate|polyester|pvc|pur|epdm|voltage|current|pressure|temperature|rating)\b/i.test(
    line
  );
}

function extractLocalizedTechnicalRows(lines: string[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string | undefined) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    const key = `${name}|${cleaned}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attributes.push({ group: "PDF Localized Technical Data", name, value: cleaned, sourceUrl });
  };

  for (const rawLine of lines) {
    const line = cleanText(rawLine);
    if (!line || line.length > 500) continue;
    if (/(?:\u53d8\u9891\u5668|\u53d8\u9891\u9a71\u52a8|\u9891\u7387\u8f6c\u6362\u5668)/.test(line)) {
      push("Product Type", "Variable frequency drive");
      push("Product family", line);
    }
    if (/(?:\u8f93\u5165\u7535\u538b|\u7535\u6e90\u7535\u538b|\u4f9b\u7535\u7535\u538b|\u989d\u5b9a\u7535\u538b)/.test(line)) {
      push("Input voltage", localizedVoltageValue(line));
    }
    if (/(?:\u989d\u5b9a\u7535\u6d41|\u8f93\u51fa\u7535\u6d41|\u8f93\u5165\u7535\u6d41)/.test(line)) {
      push("Rated current", localizedCurrentValue(line));
    }
    if (/(?:\u989d\u5b9a\u529f\u7387|\u8f93\u51fa\u529f\u7387|\u529f\u7387)/.test(line)) {
      push("Rated power", localizedPowerValue(line));
    }
    if (/(?:\u9632\u62a4\u7b49\u7ea7|\u4fdd\u62a4\u7b49\u7ea7|\u5916\u58f3\u9632\u62a4)/.test(line)) {
      push("Degree of protection", localizedProtectionValue(line));
    }
    if (/(?:\u5de5\u4f5c\u6e29\u5ea6|\u73af\u5883\u6e29\u5ea6|\u8fd0\u884c\u6e29\u5ea6)/.test(line)) {
      push("Operating temperature", localizedTemperatureValue(line));
    }
    if (/(?:\u5c3a\u5bf8)/.test(line)) {
      push("Dimensions", inlineDimensionValue(line));
    }
    if (/(?:\u91cd\u91cf)/.test(line)) {
      push("Weight", localizedWeightValue(line));
    }
  }

  return attributes.slice(0, 40);
}

function localizedVoltageValue(line: string): string | undefined {
  if (/\b0\s*V\b.*\u8f93\u5165\u7535\u538b/i.test(line)) return undefined;
  const range = line.match(/(\d+(?:[.,]\d+)?)\s*(?:-|~|\u2013|\u2014|\uff5e|\u81f3)\s*(\d+(?:[.,]\d+)?)\s*(mV|kV|V)\b/i);
  if (range) return cleanText(`${range[1].replace(",", ".")}...${range[2].replace(",", ".")} ${range[3].toUpperCase()}`);
  const point = line.match(/(\d+(?:[.,]\d+)?)\s*(mV|kV|V)\s*(AC|DC)?\b/i);
  if (!point) return undefined;
  return cleanText(`${point[1].replace(",", ".")} ${point[2].toUpperCase()} ${point[3]?.toUpperCase() ?? ""}`);
}

function localizedCurrentValue(line: string): string | undefined {
  const match = line.match(/(\d+(?:[.,]\d+)?)\s*(mA|kA|A)\b/i);
  if (!match) return undefined;
  return cleanText(`${match[1].replace(",", ".")} ${match[2]}`);
}

function localizedPowerValue(line: string): string | undefined {
  const match = line.match(/(\d+(?:[.,]\d+)?)\s*(mW|kW|W)\b/i);
  if (!match) return undefined;
  return cleanText(`${match[1].replace(",", ".")} ${match[2]}`);
}

function localizedProtectionValue(line: string): string | undefined {
  const values = line.match(/\bIP\s*\d{2}[A-Z]?\b/gi);
  return values?.length ? [...new Set(values.map((value) => value.replace(/\s+/g, "").toUpperCase()))].join("; ") : undefined;
}

function localizedTemperatureValue(line: string): string | undefined {
  const range = line.match(/([+-]?\d+(?:[.,]\d+)?)\s*(?:-|~|\u2013|\u2014|\uff5e|\u81f3)\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:\u2103|degC|\u00b0\s*C|C)\b/i);
  if (range) return `${range[1].replace(",", ".")}...${range[2].replace(",", ".")} degC`;
  const point = line.match(/([+-]?\d+(?:[.,]\d+)?)\s*(?:\u2103|degC|\u00b0\s*C|C)\b/i);
  return point ? `${point[1].replace(",", ".")} degC` : undefined;
}

function localizedWeightValue(line: string): string | undefined {
  const match = line.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|lb|lbs)\b/i);
  if (!match) return undefined;
  return cleanText(`${match[1].replace(",", ".")} ${match[2]}`);
}

function extractCatalogOrderingTableRows(lines: string[], catalogNumber: string, sourceUrl: string, options: { allowInference?: boolean } = {}): AttributeRecord[] {
  const compactCatalog = compact(catalogNumber);
  if (!compactCatalog) return [];
  const index = catalogOrderingIndex(lines, sourceUrl);
  const indexed = index.byCatalog.get(compactCatalog);
  if (indexed?.length) return indexed.map((attr) => ({ ...attr })).slice(0, 60);

  if (!indexed?.length && options.allowInference !== false) {
    return inferEatonRapidLinkOrderingRows(lines, catalogNumber, sourceUrl, (baseCatalog, baseOptions) =>
      extractCatalogOrderingTableRows(lines, baseCatalog, sourceUrl, baseOptions)
    ).slice(0, 60);
  }

  return [];
}

interface CatalogOrderingIndex {
  byCatalog: Map<string, AttributeRecord[]>;
}

function catalogOrderingIndex(lines: string[], sourceUrl: string): CatalogOrderingIndex {
  const cacheKey = catalogOrderingCacheKey(lines, sourceUrl);
  const cached = catalogOrderingTableCache.get(cacheKey);
  if (cached) return cached;
  const tableIndex: CatalogOrderingIndex = { byCatalog: new Map() };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const catalogCells = splitPdfTableCells(lines[lineIndex]);
    if (catalogCells.length < 2) continue;
    const catalogPositions = catalogCells
      .map((cell, cellIndex) => (isCatalogOrderingToken(cell) ? cellIndex : -1))
      .filter((cellIndex) => cellIndex >= 0);
    if (catalogPositions.length < 2) continue;

    const modelRow = nearestOrderingModelRow(lines, lineIndex, catalogPositions.length);
    const context = orderingTableContext(lines, lineIndex);
    for (const [ordinal, position] of catalogPositions.entries()) {
      const catalog = catalogCells[position];
      const compactCatalog = compact(catalog);
      if (!compactCatalog) continue;
      const model = modelRow?.models[ordinal];
      const attributes = compactOrderingAttributes([
        { group: "PDF Catalog Ordering Table", name: "Catalog Number", value: catalog, sourceUrl },
        { group: "PDF Catalog Ordering Table", name: "Model Code", value: model ?? "", sourceUrl },
        { group: "PDF Catalog Ordering Table", name: "I/O configuration", value: modelRow?.io ?? "", sourceUrl },
        { group: "PDF Catalog Ordering Table", name: "Rated current", value: valueWithInferredUnit(modelRow?.current, "A") ?? "", sourceUrl },
        { group: "PDF Catalog Ordering Table", name: "Rated power", value: valueWithInferredUnit(modelRow?.power, "kW") ?? "", sourceUrl },
        { group: "PDF Catalog Ordering Table", name: "Control voltage", value: voltageLikeValue(modelRow?.controlVoltage) ?? "", sourceUrl },
        { group: "PDF Catalog Ordering Table", name: "Degree of protection", value: protectionFromModelLegend(lines, model) ?? context.protection ?? "", sourceUrl }
      ]);
      if (attributes.length) tableIndex.byCatalog.set(compactCatalog, attributes);
    }
  }
  catalogOrderingTableCache.set(cacheKey, tableIndex);
  trimCatalogOrderingTableCache();
  return tableIndex;
}

/**
 * Cache identity for the three whole-document indexes (`catalogOrderingIndex`,
 * `patternModelPhysicalIndex`, `catalogMatchedRowsIndex`). Those are keyed BY CATALOG internally, so
 * sharing them across catalog numbers is correct by design — but only if the key really identifies the
 * text, and `lineCount | firstLine | lastLine` does not: two catalogs' scoped windows routinely share
 * the same first and last line and have the same line count, while differing in the middle. A stale
 * index then simply lacks the row we ask for, so the symptom is a silently MISSING value.
 */
function catalogOrderingCacheKey(lines: string[], sourceUrl: string): string {
  return `${sourceUrl}|${lines.length}|${textFingerprint(lines.join("\n"))}`;
}

function trimCatalogOrderingTableCache(): void {
  while (catalogOrderingTableCache.size > 8) {
    const oldest = catalogOrderingTableCache.keys().next().value;
    if (!oldest) return;
    catalogOrderingTableCache.delete(oldest);
  }
}

function compactOrderingAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  const seen = new Set<string>();
  const output: AttributeRecord[] = [];
  for (const attr of attributes) {
    const cleaned = cleanText(attr.value);
    if (!cleaned || /^[-\u2013\u2014]+$/.test(cleaned)) continue;
    const key = `${attr.name}|${cleaned}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...attr, value: cleaned });
  }
  return output;
}

interface OrderingModelRow {
  models: string[];
  io?: string;
  current?: string;
  power?: string;
  controlVoltage?: string;
}

function nearestOrderingModelRow(lines: string[], catalogRowIndex: number, expectedModelCount: number): OrderingModelRow | undefined {
  for (let index = catalogRowIndex - 1; index >= Math.max(0, catalogRowIndex - 4); index -= 1) {
    const parsed = parseOrderingModelRow(lines[index], expectedModelCount);
    if (parsed) return completeOrderingModelRow(parsed, lines, index, expectedModelCount);
  }
  return undefined;
}

function completeOrderingModelRow(row: OrderingModelRow, lines: string[], rowIndex: number, expectedModelCount: number): OrderingModelRow {
  if (row.current && row.power) return row;
  for (let index = rowIndex - 1; index >= Math.max(0, rowIndex - 8); index -= 1) {
    const parent = parseOrderingModelRow(lines[index], expectedModelCount);
    if (!parent?.current || !parent.power) continue;
    return {
      ...row,
      io: row.io ?? parent.io,
      current: row.current ?? parent.current,
      power: row.power ?? parent.power
    };
  }
  return row;
}

function parseOrderingModelRow(line: string, expectedModelCount: number): OrderingModelRow | undefined {
  const cells = splitPdfTableCells(line);
  if (cells.length < expectedModelCount + 1) return undefined;
  const modelPositions = cells
    .map((cell, index) => (isOrderingModelToken(cell) ? index : -1))
    .filter((index) => index >= 0);
  if (modelPositions.length < Math.min(2, expectedModelCount)) return undefined;
  const firstModel = modelPositions[0];
  const prefix = cells.slice(0, firstModel).join(" ");
  const prefixTokens = prefix.split(/\s+/).map(cleanText).filter(Boolean);
  const io = prefix.match(/\b\d+\s*DI\s*\/\s*\d+\s*DO\b/i)?.[0];
  const controlVoltage = prefixTokens.find((token) => voltageLikeValue(token)) ?? cells.slice(0, firstModel).find((cell) => voltageLikeValue(cell));
  const numbers = prefixTokens.filter((token) => /^-?\d+(?:[.,]\d+)?$/.test(token));
  return {
    models: modelPositions.map((position) => cells[position]),
    io,
    current: numbers[0],
    power: numbers[1],
    controlVoltage
  };
}

function orderingTableContext(lines: string[], catalogRowIndex: number): { protection?: string } {
  const window = lines.slice(Math.max(0, catalogRowIndex - 18), catalogRowIndex + 1).map(cleanText).join(" ");
  return {
    protection: localizedProtectionValue(window)
  };
}

function protectionFromModelLegend(lines: string[], model: string | undefined): string | undefined {
  const genericLegendValue = orderingCodeLegendValue(lines, model ?? "", /(?:degree of )?protection|enclosure/i);
  const genericProtection = genericLegendValue?.match(/\bIP\s*\d{2}[A-Z]?\b/i)?.[0];
  if (genericProtection) return genericProtection.replace(/\s+/g, "").toUpperCase();
  const compactModel = compact(model ?? "");
  if (!compactModel) return undefined;
  const candidates: Array<{ code: string; protection: string }> = [];
  for (const rawLine of lines) {
    const line = cleanText(rawLine);
    if (!/\bIP\s*\d{2}/i.test(line) || !/[=:]/.test(line)) continue;
    const match = line.match(/\b([A-Z0-9]{1,8})\s*[=:]\s*.*?\b(IP\s*\d{2}[A-Z]?)\b/i);
    if (!match) continue;
    const code = compact(match[1]);
    if (code.length < 2 || !compactModel.includes(code)) continue;
    candidates.push({ code, protection: match[2].replace(/\s+/g, "").toUpperCase() });
  }
  candidates.sort((left, right) => right.code.length - left.code.length);
  return candidates[0]?.protection;
}

function isCatalogOrderingToken(value: string): boolean {
  const cleaned = cleanText(value);
  return /^[A-Z]{2,}[A-Z0-9-]{4,}$/i.test(cleaned) && /\d/.test(cleaned);
}

function isOrderingModelToken(value: string): boolean {
  const cleaned = cleanText(value);
  return /^[A-Z0-9]+(?:-[A-Z0-9]+){2,}$/i.test(cleaned) && /\d/.test(cleaned);
}

function valueWithInferredUnit(value: string | undefined, unit: "A" | "kW"): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned || !/^-?\d+(?:[.,]\d+)?$/.test(cleaned)) return undefined;
  return `${cleaned.replace(",", ".")} ${unit}`;
}

function voltageLikeValue(value: string | undefined): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned || /^[-\u2013\u2014]+$/.test(cleaned)) return undefined;
  const match = cleaned.match(/(\d+(?:[.,]\d+)?)\s*(mV|kV|V)\s*(AC|DC)?|(?:AC|DC)\s*(\d+(?:[.,]\d+)?)\s*(mV|kV|V)?/i);
  if (!match) return undefined;
  if (match[1]) return cleanText(`${match[1].replace(",", ".")} ${match[2].toUpperCase()} ${match[3]?.toUpperCase() ?? ""}`);
  return cleanText(`${match[4]?.replace(",", ".")} ${(match[5] ?? "V").toUpperCase()} ${cleaned.match(/(?:^|[^A-Z])(AC|DC)\s*\d/i)?.[1].toUpperCase() ?? ""}`);
}

function extractPatternModelPhysicalRows(lines: string[], catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const ordering = extractCatalogOrderingTableRows(lines, catalogNumber, sourceUrl);
  const model = ordering.find((attr) => attr.name === "Model Code")?.value;
  const ratedPower = ordering.find((attr) => attr.name === "Rated power")?.value;
  if (!model) return [];

  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string | undefined) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    const key = `${name}|${cleaned}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attributes.push({ group: "PDF Model Pattern Table", name, value: cleaned, sourceUrl });
  };

  for (const row of patternModelPhysicalIndex(lines, sourceUrl).rows) {
    const { powerCell, pattern, numeric, rowText, window } = row;
    if (!patternMatchesModelCode(pattern, model)) continue;
    if (ratedPower && !powerCellMatchesRatedPower(powerCell, ratedPower)) continue;

    if (numeric.length >= 3 && /(?:\bW\b[\s\S]{0,80}\bH\b[\s\S]{0,80}\bD\b|\u5c3a\u5bf8|\bdimensions?\b)/i.test(window)) {
      push("Dimensions", `${numeric[0].replace(",", ".")} x ${numeric[1].replace(",", ".")} x ${numeric[2].replace(",", ".")} mm`);
      continue;
    }
    if (numeric.length >= 1 && (/(?:\bkg\b|\u91cd\u91cf)/i.test(window) || /\u91cd\u91cf/.test(rowText))) {
      push("Weight", `${numeric[0].replace(",", ".")} kg`);
    }
  }

  return attributes.slice(0, 12);
}

interface PatternModelPhysicalIndex {
  rows: PatternModelPhysicalRow[];
}

interface PatternModelPhysicalRow {
  powerCell: string;
  pattern: string;
  numeric: string[];
  rowText: string;
  window: string;
}

function patternModelPhysicalIndex(lines: string[], sourceUrl: string): PatternModelPhysicalIndex {
  const cacheKey = catalogOrderingCacheKey(lines, sourceUrl);
  const cached = patternModelPhysicalTableCache.get(cacheKey);
  if (cached) return cached;
  const rows: PatternModelPhysicalRow[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const cells = splitPdfTableCells(rawLine);
    if (cells.length < 4) continue;
    const patternIndex = cells.findIndex((cell) => modelPatternLooksLikeTypeCode(cell));
    if (patternIndex <= 0) continue;
    const values = cells.slice(patternIndex + 1);
    const firstNumberIndex = values.findIndex((cell) => /^-?\d+(?:[.,]\d+)?$/.test(cleanText(cell)));
    if (firstNumberIndex < 0) continue;
    const numeric = values.slice(firstNumberIndex).filter((cell) => /^-?\d+(?:[.,]\d+)?$/.test(cleanText(cell)));
    if (!numeric.length) continue;
    const windowStart = Math.max(0, lineIndex - 8);
    const windowEnd = Math.min(lines.length, lineIndex + 2);
    rows.push({
      powerCell: cells[patternIndex - 1],
      pattern: cells[patternIndex],
      numeric,
      rowText: cleanText(rawLine),
      window: lines.slice(windowStart, windowEnd).map(cleanText).join(" ")
    });
  }
  const index = { rows };
  patternModelPhysicalTableCache.set(cacheKey, index);
  trimMap(patternModelPhysicalTableCache, 8);
  return index;
}

function modelPatternLooksLikeTypeCode(value: string): boolean {
  const cleaned = cleanText(value);
  return /[A-Z]{2,}\d/i.test(cleaned) && /(?:\.{2,}|\u2026|x{2,}|X)/.test(cleaned);
}

function powerCellMatchesRatedPower(powerCell: string, ratedPower: string): boolean {
  const rated = Number((ratedPower.match(/-?\d+(?:[.,]\d+)?/)?.[0] ?? "").replace(",", "."));
  if (!Number.isFinite(rated)) return false;
  const values = cleanText(powerCell)
    .split(/\s*\/\s*|\s*,\s*|\s+or\s+/i)
    .map((value) => Number(value.replace(",", ".")))
    .filter((value) => Number.isFinite(value));
  return values.some((value) => Math.abs(value - rated) < 0.0001);
}

function patternMatchesModelCode(pattern: string, model: string): boolean {
  const cleanedPattern = cleanText(pattern).replace(/\u2026/g, "...");
  const cleanedModel = cleanText(model);
  if (!cleanedPattern || !cleanedModel) return false;
  const regex = new RegExp(`^${escapeRegExp(cleanedPattern)
    .replace(/\\\.\\\.\\\./g, ".*")
    .replace(/[xX]/g, "[A-Z0-9]")
    .replace(/\\\*/g, ".*")}$`, "i");
  return regex.test(cleanedModel);
}

function patternModelTableWindow(lines: string[], rawLine: string): string {
  const index = lines.indexOf(rawLine);
  const start = index >= 0 ? Math.max(0, index - 8) : 0;
  const end = index >= 0 ? Math.min(lines.length, index + 2) : lines.length;
  return lines.slice(start, end).map(cleanText).join(" ");
}

function extractGenericCatalogTableRows(lines: string[], catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const row = splitPdfTableCells(lines[index]);
    if (row.length < 3) continue;
    const rowText = row.join(" ");
    if (!catalogTextMatches(rowText, catalogNumber, { compact: true, ignoreCase: true })) continue;
    const header = nearestCatalogTableHeader(lines, index, row.length);
    if (!header) continue;
    const mapped = mapHeaderCellsToRow(header, row);
    if (mapped.size < 2) continue;
    // The row-level match above scans the WHOLE row text, including free-text description columns
    // — Rockwell's battery-accessory rows cross-reference a DIFFERENT sibling catalog right in
    // their own description ("...battery replacement for 1606-XLSBATASSY1..." on 1606-XLSBAT1's
    // own row), so a query for that sibling would otherwise match here and silently inherit THIS
    // row's dimensions instead. Once the header tells us which cell IS the catalog number, require
    // that specific cell to actually be ours before trusting the row.
    if (!mappedCatalogCellMatches(mapped.get("catalogNumber"), catalogNumber)) continue;

    const push = (name: string, value: string | undefined) => {
      const cleaned = cleanText(value);
      if (!cleaned) return;
      const key = `${name}|${cleaned}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      // Explicit confidence, not just the default: extractInlineDimensionText's catalog-agnostic
      // sweep (elsewhere in this file) scores identically to an attribute with no confidence set,
      // and being earlier in the combined attribute list let it silently win ties — e.g. it picked
      // up a DIFFERENT accessory's dimensions from the same multi-row scoped text (Rockwell's
      // "Battery Modules" table keeps several sibling rows in one scope). This row's own catalog
      // number is verified above, so it's more trustworthy than an unscoped text sweep.
      attributes.push({ group: "PDF Catalog Table Row", name, value: cleaned, sourceUrl, confidence: 0.75 });
    };

    push("Catalog Number", ourCatalogCellValue(mapped.get("catalogNumber"), catalogNumber));
    push("Description", mapped.get("description"));
    push("Product Type", mapped.get("productType"));
    push("Material", mapped.get("material"));
    push("Weight", mapped.get("weight"));
    push("Voltage rating", mapped.get("voltage"));
    push("Current rating", mapped.get("current"));
    push("Dimensions", genericRowDimensions(mapped));
  }
  return attributes.slice(0, 60);
}

function nearestCatalogTableHeader(lines: string[], rowIndex: number, rowCellCount: number): string[] | undefined {
  // Wide enough to reach a table's header from its LAST data row, not just early ones — Rockwell's
  // 1606-td002 "Battery Modules for DC-UPS" table has 13 data rows between its header and its last
  // entry (1606-XLSBATSEN), well past the previous 8-line limit that only ever found the header for
  // the first few rows of any such table.
  for (let index = rowIndex - 1; index >= Math.max(0, rowIndex - 20); index -= 1) {
    const header = splitPdfTableCells(lines[index]);
    if (header.length < 3) continue;
    if (Math.abs(header.length - rowCellCount) > 2) continue;
    if (!isCatalogTableHeaderText(header.join(" "))) continue;
    return header;
  }
  return undefined;
}

function splitPdfTableCells(line: string): string[] {
  if (!cleanText(line)) return [];
  const separator = line.includes("\t") ? /\t+/ : line.includes("|") ? /\s*\|\s*/ : /\s{2,}/;
  const cells = line.split(separator).map((cell) => cleanText(cell)).filter(Boolean);
  return cells.length > 1 ? cells : [];
}

function mapHeaderCellsToRow(header: string[], row: string[]): Map<string, string> {
  const mapped = new Map<string, string>();
  const count = Math.min(header.length, row.length);
  for (let index = 0; index < count; index += 1) {
    const key = genericCatalogTableKey(header[index]);
    if (!key) continue;
    const value = valueWithHeaderUnit(row[index], header[index]);
    if (!value) continue;
    if (mapped.has(key)) {
      mapped.set(key, `${mapped.get(key)}; ${value}`);
    } else {
      mapped.set(key, value);
    }
  }
  return mapped;
}

/**
 * Ordering tables routinely carry TWO identifier columns — an internal type code and the orderable
 * article number ("Part number" + "Article number", "Typ" + "Bestell-Nr.") — and both map to the same
 * `catalogNumber` key, so `mapHeaderCellsToRow` merges them into one "A; B" cell.
 *
 * The row-trust check then compared that merged cell against our catalog number and failed:
 * `sameCatalogNumber("E6-1/1/B; CBE03319", "CBE03319")` is false. The correct row was found and then
 * discarded — on Eaton's E6 catalogue that silently cost the rated current sitting in the same row.
 *
 * Any one identifier column matching is enough: they identify the same product by construction.
 */
function mappedCatalogCellMatches(mergedCell: string | undefined, catalogNumber: string): boolean {
  if (!mergedCell) return true; // the header named no identifier column — the row-level match stands
  return splitMergedCatalogCell(mergedCell).some((part) =>
    sameCatalogNumber(part, catalogNumber, { compact: true, ignoreCase: true })
  );
}

/** The identifier from a merged cell that is actually ours, so exports show it rather than "A; B". */
function ourCatalogCellValue(mergedCell: string | undefined, catalogNumber: string): string {
  if (!mergedCell) return catalogNumber;
  const parts = splitMergedCatalogCell(mergedCell);
  return parts.find((part) => sameCatalogNumber(part, catalogNumber, { compact: true, ignoreCase: true })) ?? mergedCell;
}

function splitMergedCatalogCell(cell: string): string[] {
  return cell
    .split(/\s*;\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function genericCatalogTableKey(header: string): string | undefined {
  // Delegates to the shared, multilingual vocabulary (catalog-table-vocabulary.ts) — kept as a
  // thin local alias so this file's call sites read unchanged.
  return catalogTableKeyFor(header);
}

function valueWithHeaderUnit(value: string, header: string): string {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  if (/[a-zA-Z%°]/.test(cleaned)) return cleaned;
  const unit = header.match(/[\[(]\s*(mm|cm|m|in|inch|inches|kg|g|lb|lbs|v|vac|vdc|a|ma|ka|w|kw)\s*[\])]/i)?.[1];
  return unit ? `${cleaned} ${canonicalPdfUnit(unit)}` : cleaned;
}

function genericRowDimensions(mapped: Map<string, string>): string | undefined {
  const combined = mapped.get("dimensions");
  if (combined) return combined;
  const ordered = [
    ["dn", "DN"],
    ["width", "W"],
    ["height", "H"],
    ["depth", "D"],
    ["length", "L"],
    ["diameter", "Diameter"]
  ] as const;
  const pieces = ordered
    .map(([key, label]) => {
      const value = mapped.get(key);
      return value ? `${label} ${value}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (pieces.length >= 2) return pieces.join(" x ");
  if (pieces.length === 1 && /\bDN\b/i.test(pieces[0])) return pieces[0];
  return undefined;
}

interface StackedPdfColumn {
  label: string;
  unit?: string;
}

function extractStackedDimensionTableRows(lines: string[], sourceUrl: string, catalogNumber: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const row = splitStackedDataCells(lines[index]);
    if (row.length < 4) continue;
    // A stacked dimension table can have an explicit type/article cell in front
    // of the numeric cells. If it names a different SKU, this row is evidence
    // about that sibling only. Rows with no catalog-looking token retain the
    // legacy single-product behaviour (e.g. Siemens' DN/D/B/L/W table).
    if (stackedRowNamesDifferentCatalog(lines[index], catalogNumber)) continue;
    const columns = nearestStackedDimensionHeader(lines, index, row.length);
    if (!columns) continue;
    const values = alignStackedTableRow(columns, row);
    if (!values) continue;

    const dimensions: string[] = [];
    let weight: string | undefined;
    for (const [column, value] of values) {
      const key = stackedDimensionKey(column);
      const cleaned = valueWithHeaderUnit(value, stackedHeaderLabel(column));
      if (!cleaned) continue;
      if (key === "weight") {
        weight = cleaned;
      } else if (key === "dimension") {
        dimensions.push(`${cleanStackedDimensionLabel(column.label)} ${cleaned}`);
      }
    }

    const push = (name: string, value: string | undefined) => {
      const cleaned = cleanText(value);
      if (!cleaned) return;
      const key = `${name}|${cleaned}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      attributes.push({ group: "PDF Dimension Table Row", name, value: cleaned, sourceUrl });
    };
    if (dimensions.length >= 2) push("Dimensions", dimensions.join("; "));
    if (weight) push("Weight", weight);
  }
  if (!attributes.length) {
    attributes.push(...extractStackedDimensionSectionFallback(lines, sourceUrl, catalogNumber));
  }
  return attributes.slice(0, 40);
}

function stackedRowNamesDifferentCatalog(line: string, catalogNumber: string): boolean {
  const tokens = cleanText(line).match(/\b[A-Z]{2,}[A-Z0-9]*(?:[-/:.][A-Z0-9]+)+\b|\b[A-Z]{2,}\d{3,}[A-Z0-9-]*\b/gi) ?? [];
  const candidates = tokens.filter((token) => !isStandardReferenceToken(compact(token)) && !isMeasurementLikeToken(token));
  return candidates.length > 0 && !candidates.some((token) => sameCatalogNumber(token, catalogNumber, { compact: true, afterColon: true }));
}

function extractStackedDimensionSectionFallback(lines: string[], sourceUrl: string, catalogNumber: string): AttributeRecord[] {
  const headingIndex = lines.findIndex((line) => /\bdimensions?\b/i.test(cleanText(line)));
  if (headingIndex >= 0) {
    const labelledPrefix = lines
      .slice(Math.max(0, headingIndex - 8), headingIndex)
      .filter((line) => /\b(?:product|catalog(?:ue)?|article|order(?:ing)?|model|part|sku|type)\b/i.test(cleanText(line)));
    const section = lines.slice(headingIndex, Math.min(lines.length, headingIndex + 32));
    const context = [...labelledPrefix, ...section].join("\n");
    if (stackedSectionNamesDifferentCatalog(context, catalogNumber)) return [];
  }
  const joined = lines.map(cleanText).join("\n");
  const block = joined.match(/\bDimensions\b[\s\S]{0,500}?\bDN\s+D\b[\s\S]{0,500}?\bW\s*\n\s*\[kg\]\s*\n\s*(\d+(?:[.,]\d+)?)\s+([A-Z])\s+([0-9ÂĽÂ˝Âľ\/]+)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)/i);
  if (!block) return [];
  const [, dn, threadPrefix, threadSize, b, l1, l3, h, weight] = block;
  return [
    {
      group: "PDF Dimension Table Row",
      name: "Dimensions",
      value: `DN ${dn.replace(",", ".")}; D ${threadPrefix} ${threadSize}; B ${b.replace(",", ".")} mm; L1 ${l1.replace(",", ".")} mm; L3 ${l3.replace(",", ".")} mm; H ${h.replace(",", ".")} mm`,
      sourceUrl
    },
    {
      group: "PDF Dimension Table Row",
      name: "Weight",
      value: `${weight.replace(",", ".")} kg`,
      sourceUrl
    }
  ];
}

function nearestStackedDimensionHeader(lines: string[], rowIndex: number, rowCellCount: number): StackedPdfColumn[] | undefined {
  const start = Math.max(0, rowIndex - 18);
  const window = lines.slice(start, rowIndex).map(cleanText).filter(Boolean);
  const headingIndex = lastIndexMatching(window, (line) => /\b(?:dimensions?|dimensional|abmessungen?|technical\s+data)\b/i.test(line));
  const headerLines = (headingIndex >= 0 ? window.slice(headingIndex + 1) : window).slice(-14);
  const columns = stackedColumnsFromHeaderLines(headerLines);
  if (columns.length < 3 || columns.length > rowCellCount) return undefined;
  if (rowCellCount - columns.length > 2) return undefined;
  const dimensionCount = columns.filter((column) => stackedDimensionKey(column) === "dimension").length;
  const hasWeight = columns.some((column) => stackedDimensionKey(column) === "weight" || /^(?:weight|mass|w)$/i.test(cleanStackedDimensionLabel(column.label)));
  if (dimensionCount < 2 || !hasWeight) return undefined;
  return columns;
}

function lastIndexMatching(values: string[], predicate: (value: string) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}

function stackedColumnsFromHeaderLines(lines: string[]): StackedPdfColumn[] {
  const columns: StackedPdfColumn[] = [];
  for (const line of lines) {
    if (isStandalonePdfUnit(line)) {
      const last = columns[columns.length - 1];
      if (last) last.unit = cleanStackedUnit(line);
      continue;
    }
    if (!/^[A-Z][A-Z0-9/ -]{0,18}$/i.test(line)) continue;
    for (const token of line.split(/\s+/).map(cleanText).filter(Boolean)) {
      if (!/^(?:DN|D|B|W|H|L\d*|T|X|Y|Z|Height|Width|Depth|Length|Weight|Mass)$/i.test(token)) continue;
      columns.push({ label: token });
    }
  }
  return columns;
}

function splitStackedDataCells(line: string): string[] {
  const cleaned = cleanText(line);
  if (!/^\d/.test(cleaned)) return [];
  const cells = cleaned.split(/\s+/).map(cleanText).filter(Boolean);
  return cells.length >= 4 && cells.some((cell) => /^\d+(?:[.,]\d+)?$/.test(cell)) ? cells : [];
}

function alignStackedTableRow(columns: StackedPdfColumn[], row: string[]): Array<[StackedPdfColumn, string]> | undefined {
  if (row.length < columns.length) return undefined;
  const output: Array<[StackedPdfColumn, string]> = [];
  let rowIndex = 0;
  const surplus = row.length - columns.length;
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const column = columns[columnIndex];
    let take = 1;
    if (surplus > 0 && columnIndex > 0 && rowIndex + (columns.length - columnIndex) < row.length && shouldAbsorbStackedSurplus(column, row[rowIndex])) {
      take += surplus;
    }
    const value = row.slice(rowIndex, rowIndex + take).join(" ");
    rowIndex += take;
    output.push([column, value]);
  }
  return rowIndex === row.length ? output : undefined;
}

function shouldAbsorbStackedSurplus(column: StackedPdfColumn, firstValue: string): boolean {
  return /^d$/i.test(cleanStackedDimensionLabel(column.label)) && !/^\d+(?:[.,]\d+)?$/.test(firstValue);
}

function stackedDimensionKey(column: StackedPdfColumn): "dimension" | "weight" | undefined {
  const label = cleanStackedDimensionLabel(column.label);
  const unit = column.unit?.toLowerCase() ?? "";
  if (/^(?:weight|mass|w)$/i.test(label) && (/\b(?:kg|g|lb|lbs)\b/i.test(unit) || unit === "")) return "weight";
  if (/^(?:dn|d|b|w|h|l\d*|t|x|y|z|height|width|depth|length)$/i.test(label)) return "dimension";
  return undefined;
}

function stackedHeaderLabel(column: StackedPdfColumn): string {
  return [column.label, column.unit ? `[${column.unit}]` : ""].filter(Boolean).join(" ");
}

function cleanStackedDimensionLabel(value: string): string {
  return cleanText(value).replace(/[^a-z0-9]+$/gi, "");
}

function cleanStackedUnit(value: string): string {
  return cleanText(value).replace(/^[[(]\s*/, "").replace(/\s*[\])]$/, "");
}

function extractCatalogSpecificRows(lines: string[], catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const values = new Set<string>();
  const compactPart = compact(catalogNumber);
  const afterColon = catalogNumber.includes(":") ? catalogNumber.split(":").pop() ?? catalogNumber : catalogNumber;
  const compactAfterColon = compact(afterColon);
  const index = catalogMatchedRowsIndex(lines, sourceUrl);
  if (compactPart) for (const value of index.byCatalog.get(compactPart) ?? []) values.add(value);
  if (compactAfterColon && compactAfterColon !== compactPart) {
    for (const value of index.byCatalog.get(compactAfterColon) ?? []) values.add(value);
  }
  return [...values].slice(0, 20).map((value) => ({
    group: "PDF Matched Rows",
    name: "Matched product row",
    value,
    sourceUrl
  }));
}

interface CatalogMatchedRowsIndex {
  byCatalog: Map<string, string[]>;
}

function catalogMatchedRowsIndex(lines: string[], sourceUrl: string): CatalogMatchedRowsIndex {
  const cacheKey = catalogOrderingCacheKey(lines, sourceUrl);
  const cached = catalogMatchedRowsCache.get(cacheKey);
  if (cached) return cached;
  const byCatalog = new Map<string, string[]>();
  for (const line of lines) {
    const cleaned = cleanText(line);
    if (!cleaned || cleaned.length > 500) continue;
    // A multi-column comparison-table ROW ("Weight \t930 g \t440 g \t620 g \t620 g \t900 g \t900 g")
    // stores fine as a "matched row" for whichever catalogs are literally named in it — but this
    // whole line, unparsed, becomes a candidate value elsewhere for a text-derived Weight/
    // Dimensions fallback that has no column awareness, so several DIFFERENT models' values ended
    // up joined into one field for the catalog that's genuinely one of this row's own columns
    // (confirmed live on several Rockwell multi-model families). Skip storing these verbatim.
    if (looksLikeMultiColumnDataRow(cleaned)) continue;
    const tokens = cleaned.match(/[A-Z]{2,}[A-Z0-9-]{4,}/gi);
    if (!tokens) continue;
    for (const token of tokens) {
      const key = compact(token);
      if (!key || key.length < 5) continue;
      const rows = byCatalog.get(key) ?? [];
      if (!rows.includes(cleaned)) rows.push(cleaned);
      byCatalog.set(key, rows);
    }
  }
  const index = { byCatalog };
  catalogMatchedRowsCache.set(cacheKey, index);
  trimMap(catalogMatchedRowsCache, 8);
  return index;
}

interface WrappedLabelSpec {
  // Matched anywhere in a line (not anchored) unless the pattern itself anchors with ^.
  pattern: RegExp;
  group: string;
  // Fixed output name for facts with one physical meaning per datasheet. Omit for facts that
  // repeat with a distinguishing qualifier baked into the label itself (e.g. "(Type A/AC
  // operation)" vs "(Type B operation)") — those must use the joined raw label text instead, or
  // the qualifier that makes each occurrence distinct would be lost.
  canonicalName?: string;
}

/**
 * Several Doepke datasheet labels wrap across a variable, inconsistent number of physical PDF
 * lines depending on the surrounding page layout (device variant text elsewhere on the page
 * shifts word-wrap points) — the exact same fact renders as "Number of conductors" / "per
 * terminal" / value on one datasheet and "number of conductors per" / "terminal" / value on
 * another; "max. operating altitude above MSL" sometimes stays on one line and sometimes splits
 * "max. Operating altitude above" / "MSL" / value. Exact-string known-label matching
 * (`isKnownLabelOnly`/`technical-attribute-aliases.ts`) only recognizes ONE specific wrap point per
 * alias, so it silently missed every other wrap variant, and the generic per-line splitters treat
 * a label's own trailing continuation fragment as if it were the value (producing garbage like
 * name="Minimum rated operating voltage" value="(Type A/AC"). This scans loosely for each spec's
 * anchor phrase anywhere in a line, then walks forward past short label-continuation fragments to
 * the first line that actually starts with a digit (the real value), regardless of how many lines
 * the label itself was split across.
 */
const WRAPPED_LABEL_SPECS: WrappedLabelSpec[] = [
  {
    pattern: /number\s+of\s+conductors/i,
    group: "PDF Terminal Data",
    canonicalName: "max. Connection C1 Number of conductors per terminal"
  },
  // No canonicalName: "(Type A/AC operation)" vs "(Type B operation)" are two distinct facts that
  // must keep their own qualifier in the name.
  { pattern: /^minimum\s+rated\s+operating\s+voltage\b/i, group: "PDF Terminal Data" },
  { pattern: /operating\s+altitude/i, group: "PDF Environmental Data", canonicalName: "max. operating altitude above MSL" },
  // "Cross section AWG, flexible with ferrule" — the wrap point sometimes lands mid-phrase
  // ("...flexible with" / "ferrule" / value) instead of the whole label staying on one line.
  { pattern: /awg,?\s*flexible\s+with\b/i, group: "PDF Terminal Data", canonicalName: "Cross section AWG, flexible with ferrule" }
];

function extractWrappedLabelValueAttributes(lines: string[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanText(lines[index]);
    const spec = WRAPPED_LABEL_SPECS.find((candidateSpec) => candidateSpec.pattern.test(line));
    if (!spec) continue;

    // Not every occurrence wraps — the same label/value sometimes stays on one line ("max.
    // operating altitude above MSL 2000 m") depending on how much other page content shifted the
    // word wrap. If a digit-starting token already appears on the anchor line itself, that's the
    // value; only fall through to the multi-line walk when the line is label-only.
    const tokens = line.split(/\s+/);
    const sameLineValueIndex = tokens.findIndex((token) => /^-?\d/.test(token));
    if (sameLineValueIndex > 0) {
      attributes.push({
        group: spec.group,
        name: spec.canonicalName ?? cleanText(tokens.slice(0, sameLineValueIndex).join(" ")),
        value: cleanText(tokens.slice(sameLineValueIndex).join(" ")),
        sourceUrl
      });
      continue;
    }

    let label = line;
    let value: string | undefined;
    for (let offset = 1; offset <= 3 && index + offset < lines.length; offset += 1) {
      const candidate = cleanText(lines[index + offset]);
      if (!candidate) continue;
      if (/^-?\d/.test(candidate)) {
        value = candidate;
        break;
      }
      // A real label continuation is a short fragment ("per terminal", "MSL"); anything longer is
      // unrelated prose the value walk should not reach past.
      if (candidate.split(/\s+/).length > 6) break;
      label += ` ${candidate}`;
    }
    if (!value) continue;
    attributes.push({ group: spec.group, name: spec.canonicalName ?? cleanText(label), value, sourceUrl });
  }
  return attributes;
}

function extractQualifiedTemperatureAttributes(lines: string[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const label = cleanText(lines[index]);
    const match = label.match(/^(Operating|Storage)\s+temperature(?:\s+(.+))?$/i);
    if (!match) continue;
    const qualifier = cleanText(match[2] ?? "");
    if (!qualifier) continue;
    if (qualifier && !/^(?:xt|standard|std|safety|nse|conformal(?:ly)? coated|coated|non[-\s]?safety)$/i.test(qualifier)) {
      continue;
    }
    const value = nextPdfLabelValue(lines, index + 1);
    if (!value || isPdfLabelQualifierOnly(value)) continue;
    const baseLabel = canonicalLabel(`${match[1]} temperature`);
    attributes.push({
      group: "PDF Qualified Specifications",
      name: qualifier ? `${baseLabel} ${qualifier}` : baseLabel,
      value,
      sourceUrl
    });
  }
  return attributes;
}

function extractCatalogDescriptionRows(lines: string[], catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const compactCatalog = compact(catalogNumber);
  if (!compactCatalog) return [];
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const cleaned = cleanText(line);
    if (!cleaned || cleaned.length > 300) continue;
    const row = parseCatalogDescriptionRow(cleaned, catalogNumber);
    if (!row) continue;
    const candidates: AttributeRecord[] = [
      { group: "PDF Catalog Description Row", name: "Catalog Number", value: row.catalog, sourceUrl },
      { group: "PDF Catalog Description Row", name: "Description", value: row.description, sourceUrl },
      ...catalogDescriptionAttributes(row.description, sourceUrl)
    ];
    for (const attr of candidates) {
      const key = `${attr.group}|${attr.name}|${attr.value}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      attributes.push(attr);
    }
  }
  return attributes.slice(0, 20);
}

/** A row/table-cell shaped like a real catalog or type code — digits plus a separator plus more
 * alnum, or letters directly followed by 3+ digits. Reused here only to detect a LATER mention on
 * the same line (see parseCatalogDescriptionRow), not to validate the target catalog itself. */
const DESCRIPTION_ROW_CATALOG_LIKE_PATTERN = /\b[A-Z0-9]{2,}(?:[-:\/.][A-Z0-9]+)+\b|\b[A-Z]{2,}[0-9]{3,}\b/i;

function parseCatalogDescriptionRow(line: string, catalogNumber: string): { catalog: string; description: string } | undefined {
  const span = compactCatalogSpan(line, catalogNumber);
  if (!span) return undefined;
  // Real bug: Rockwell's "1606-XLSBAT1" accessory row reads "...battery replacement for
  // 1606-XLSBATASSY1, -XLSBATASSY1W, and -XLSBATASSY3 [dims] 1606-XLSBAT1" — querying for
  // "1606-XLSBATASSY1" matched the cross-reference embedded in THIS row's own description, then
  // took whatever followed (including a totally different accessory's dimensions) as if it
  // described XLSBATASSY1 itself. When another catalog-shaped token follows our match on the same
  // line, that later one is the row's real subject in this table style — treat our match here as
  // an unreliable cross-reference and skip rather than misattribute.
  const remainder = line.slice(span.end);
  if (DESCRIPTION_ROW_CATALOG_LIKE_PATTERN.test(remainder)) return undefined;
  const description = cleanText(remainder).replace(/^[-:;,|]\s*/, "");
  if (!description || description.length < 4 || !/[a-z]/i.test(description)) return undefined;
  return { catalog: catalogNumber, description };
}

function compactCatalogSpan(line: string, catalogNumber: string): { start: number; end: number } | undefined {
  const target = compact(catalogNumber);
  if (!target) return undefined;
  let compacted = "";
  const positions: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (!/[a-z0-9]/i.test(char)) continue;
    compacted += char.toLowerCase();
    positions.push(index);
  }
  const start = compacted.indexOf(target);
  if (start < 0) return undefined;
  const end = start + target.length - 1;
  return { start: positions[start] ?? 0, end: (positions[end] ?? line.length - 1) + 1 };
}

function catalogDescriptionAttributes(description: string, sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const memory = description.match(/\b(\d+(?:[.,]\d+)?)\s*(KB|MB|GB)\b/i);
  if (memory) {
    attributes.push({
      group: "PDF Catalog Description Row",
      name: "Memory",
      value: `${memory[1].replace(",", ".")} ${memory[2].toUpperCase()}`,
      sourceUrl
    });
  }
  const voltage = description.match(/\b(\d+(?:[.,]\d+)?)\s*(mV|V|kV)\s*(AC|DC)?\b/i);
  if (voltage) {
    attributes.push({
      group: "PDF Catalog Description Row",
      name: "Voltage rating",
      value: cleanText(`${voltage[1].replace(",", ".")} ${voltage[2].toUpperCase()} ${voltage[3]?.toUpperCase() ?? ""}`),
      sourceUrl
    });
  }
  const variants = genericCatalogDescriptionVariants(description);
  if (variants.length) {
    attributes.push({
      group: "PDF Catalog Description Row",
      name: "Variant",
      value: variants.join(", "),
      sourceUrl
    });
  }
  return attributes;
}

function genericCatalogDescriptionVariants(description: string): string[] {
  const variants = new Set<string>();
  for (const match of description.matchAll(/\b[A-Z][A-Z0-9-]{1,8}\b/g)) {
    const token = match[0].toUpperCase();
    if (/^(?:AC|DC|VAC|VDC|V|MV|KV|A|MA|KA|W|KW|KB|MB|GB|TB|IP\d*|IEC|UL|CE|CSA|CPU|PLC|I\/O|IO)$/.test(token)) continue;
    variants.add(token);
  }
  for (const match of description.matchAll(/\b(?:Safety|Conformal(?:ly)? coated|Coated|Non[-\s]?safety)\b/gi)) {
    variants.add(canonicalCatalogVariant(match[0]));
  }
  return [...variants].slice(0, 8);
}

function canonicalCatalogVariant(value: string): string {
  const cleaned = cleanText(value).toLowerCase();
  if (/^conformal/.test(cleaned)) return "Conformal coated";
  if (/^non/.test(cleaned)) return "Non-safety";
  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractInlineDimensionText(lines: string[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanText(lines[index]);
    if (!line || line.length > 300) continue;
    const window = lines
      .slice(Math.max(0, index - 3), Math.min(lines.length, index + 2))
      .map(cleanText)
      .join(" ");
    if (!/\b(?:dimensions?|dimensional|drawing|outline|overall|size|abmessungen?|ma(?:sse|\u00dfe))\b/i.test(window)) continue;
    const value = inlineDimensionValue(line);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    attributes.push({
      group: "PDF Dimension Text",
      name: "Dimensions",
      value,
      sourceUrl
    });
  }
  return attributes.slice(0, 6);
}

function inlineDimensionValue(line: string): string | undefined {
  const cleaned = cleanText(line);
  if (/^all dimensions\b/i.test(cleaned) || /\b(?:tolerance|unless otherwise specified)\b/i.test(cleaned)) return undefined;
  const match = cleaned.match(
    /((?:approx(?:\.|imately)?\s*)?(?:ø|Ø|dia\.?\s*)?\d+(?:[.,]\d+)?(?:\s*(?:mm|cm|m|inches|inch|in))?(?:\s*[x×]\s*(?:ø|Ø|dia\.?\s*)?\d+(?:[.,]\d+)?(?:\s*(?:mm|cm|m|inches|inch|in))?){1,4})/i
  );
  if (!match) return undefined;
  const value = cleanText(match[1])
    .replace(/^(?:approx(?:\.|imately)?)\s*/i, "")
    .replace(/×/g, "x")
    .replace(/,/g, ".");
  const hasUnit = /\b(?:mm|cm|m|in|inch|inches)\b/i.test(value);
  const hasTwoNumbers = (value.match(/\d+(?:\.\d+)?/g) ?? []).length >= 2;
  return hasUnit && hasTwoNumbers ? value : undefined;
}

function extractContactRatingAttributes(lines: string[], sourceUrl: string, catalogNumber: string): AttributeRecord[] {
  const voltageRanges: string[] = [];
  const currents: string[] = [];
  let contactRatingWindow = 0;
  let contactRatingOwned = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = cleanText(rawLine);
    if (/contact rating/i.test(line)) {
      contactRatingWindow = 35;
      contactRatingOwned = contactRatingBelongsToCatalog(lines, index, catalogNumber);
    }
    if (contactRatingWindow <= 0) continue;
    contactRatingWindow -= 1;
    if (!contactRatingOwned) continue;

    const tabbed = line.split(/\t+/).map(cleanText).filter(Boolean);
    if (tabbed.length >= 2) {
      const voltage = contactRatingVoltageRange(tabbed[0]);
      const current = contactRatingCurrent(tabbed.slice(1).join(" "));
      if (voltage && current) {
        voltageRanges.push(voltage);
        currents.push(current);
        continue;
      }
    }

    const voltage = contactRatingVoltageRange(line);
    if (voltage) {
      voltageRanges.push(voltage);
      continue;
    }
    const current = contactRatingCurrent(line);
    if (current) currents.push(current);
  }

  const uniqueVoltages = uniqueInOrder(voltageRanges).slice(0, 8);
  const uniqueCurrents = uniqueInOrder(currents).slice(0, 8);
  const attributes: AttributeRecord[] = [];
  if (uniqueVoltages.length) {
    attributes.push({
      group: "PDF Contact Rating",
      name: "Voltage rating",
      value: uniqueVoltages.map((value) => `${value} V DC`).join(" / "),
      sourceUrl
    });
  }
  if (uniqueCurrents.length) {
    attributes.push({
      group: "PDF Contact Rating",
      name: "Current rating",
      value: uniqueCurrents.join(" / "),
      sourceUrl
    });
  }
  return attributes;
}

function stackedSectionNamesDifferentCatalog(context: string, catalogNumber: string): boolean {
  const tokens = context.match(/\b[A-Z]{2,}[A-Z0-9]*(?:[-/:.][A-Z0-9]+)+\b|\b[A-Z]{2,}\d{3,}[A-Z0-9-]*\b/gi) ?? [];
  const candidates = tokens.filter((token) => !isStandardReferenceToken(compact(token)) && !isMeasurementLikeToken(token));
  return candidates.length > 0 && !candidates.every((token) => sameCatalogNumber(token, catalogNumber, { compact: true, afterColon: true }));
}

/**
 * A contact-rating heading has no product key of its own.  If its nearby context
 * names a catalogue-shaped sibling, the numerical rows belong to that sibling,
 * not to whichever SKU asked for this family PDF.  With no product-shaped token
 * nearby we retain the established single-product/family-sheet behaviour.
 */
function contactRatingBelongsToCatalog(lines: string[], headingIndex: number, catalogNumber: string): boolean {
  const context = lines.slice(Math.max(0, headingIndex - 30), Math.min(lines.length, headingIndex + 4)).join("\n");
  const catalogTokens = [...context.matchAll(/\b[A-Z0-9]{2,}(?:[-:/.][A-Z0-9]+)+\b|\b[A-Z]{2,}\d{3,}\b/gi)]
    .map((match) => match[0])
    .filter((token) => /[a-z]/i.test(token) && /\d/.test(token) && !isStandardReferenceToken(compact(token)) && !isMeasurementLikeToken(token));
  if (!catalogTokens.length) return true;
  return catalogTokens.every((token) => Boolean(findCatalogTextMatch(token, catalogNumber, { compact: true, afterColon: true })));
}

function contactRatingVoltageRange(value: string): string | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/^(\d+(?:[.,]\d+)?\s*(?:\.{2,3}|\u2026|\u2013|\u2014|-|to)\s*\d+(?:[.,]\d+)?)$/);
  return match ? cleanText(match[1]).replace(/\s*(?:\u2026|\u2013|\u2014|-|to)\s*/i, "...") : undefined;
}

function contactRatingCurrent(value: string): string | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/\b(\d+(?:[.,]\d+)?)\s*(mA|A|kA|amps?|amperes?)\b/i);
  if (!match) return undefined;
  const unit = /^mA$/i.test(match[2]) ? "mA" : /^kA$/i.test(match[2]) ? "kA" : "A";
  return `${match[1]} ${unit}`;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return uniqueStringsBase(values, { normalize: "trim" });
}

function sectionTracker(): (line: string) => string | undefined {
  let current: string | undefined;
  return (line: string) => {
    if (isPdfSectionHeading(line)) {
      current = line;
    }
    return current;
  };
}

function isPdfSectionHeading(line: string): boolean {
  return /^(approvals|basic features|compliances|construction|dimensions|electrical connection|electrical data|electrical ratings|electrical specifications|enclosure|environmental conditions|environmental specifications|general specifications|interface|material|mechanical data|mechanical specifications|product data|product details|product specifications|ratings|short-circuit ratings|specifications|technical data|technical specifications)$/i.test(
    line
  );
}

function canonicalLabel(value: string): string {
  if (/^mass$/i.test(value)) return "Weight";
  return value;
}

function nonEmptyNormalized(normalized: ProductResult["normalized"]): ProductResult["normalized"] {
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined && value !== "")) as ProductResult["normalized"];
}

function dedupeAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return dedupeAttributesBase(attributes, { includeSourceUrl: true });
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
