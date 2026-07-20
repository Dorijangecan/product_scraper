import { dedupeAttributes as dedupeAttributesBase, dedupeSources } from "./dedupe.js";
import { uniqueStrings as uniqueStringsBase } from "../text-util.js";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { TableArray } from "pdf-parse";
import type { AttributeRecord, DocumentProcessingDiagnostic, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { cleanText, normalizeFields, splitNameValue } from "./normalizer.js";
import { catalogTextMatches, sameCatalogNumber } from "./catalog-number.js";
import { buildTightContextForCatalog, buildVariantColumnContext } from "./tight-context.js";
import { listTechnicalAttributeAliases } from "./technical-attribute-aliases.js";
import { readPdfWithOptionalOcr } from "./pdf-ocr.js";
import { isPdfLikeDocumentUrl } from "./document-url.js";
import { fieldMatchesLabel, FIELD_REGISTRY, listFieldRegistryDocumentLabels } from "./field-registry.js";
import { extractElectricalSpecAttributesFromText, extractOntologySpecAttributesFromText } from "./electrical-spec-miner.js";
import { extractComplianceMatrixAttributes, textHasComplianceMatrixGlyphs } from "./pdf-compliance-matrix.js";
import { extractPositionedTableRowsFromPdf } from "./pdf-positioned-table.js";

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
const PDF_TEXT_MIN_CHARS_FOR_PARSE = 80;
const FULL_PDF_TEXT_CACHE_MAX_FILE_BYTES = 8 * 1024 * 1024;
const FULL_PDF_TEXT_CACHE_MAX_ENTRIES = 16;

interface PdfDocumentText {
  text: string;
  tables: TableArray[];
}

const fullPdfTextCache = new Map<string, Promise<PdfDocumentText>>();
const normalizedPdfLinesCache = new Map<string, string[]>();
const globalPdfAttributeCache = new Map<string, AttributeRecord[]>();
const globalPdfTechnicalAttributeCache = new Map<string, AttributeRecord[]>();
const catalogOrderingTableCache = new Map<string, CatalogOrderingIndex>();
const patternModelPhysicalTableCache = new Map<string, PatternModelPhysicalIndex>();
const catalogMatchedRowsCache = new Map<string, CatalogMatchedRowsIndex>();

const BASE_KNOWN_LABELS = [
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

export async function enrichResultFromDownloadedDocuments(result: ProductResult): Promise<ProductResult> {
  const documentAttributes: AttributeRecord[] = [];
  const documentSources: SourceRecord[] = [];
  const documentParseFailures: string[] = [];
  const documentProcessing: DocumentProcessingDiagnostic[] = [];
  const documents: DocumentRecord[] = [];

  for (const doc of prioritizeDownloadedDocuments(result.documents)) {
    const started = Date.now();
    if (shouldSkipAfterStrongDocumentEvidence(doc, documentAttributes)) {
      documentProcessing.push(documentProcessingRecord(doc, "downloaded-document-enrichment", "skipped", "Skipped lower-priority document because a datasheet/catalog already supplied strong product attributes."));
      documents.push({ ...doc, parseStatus: doc.parseStatus ?? "skipped" });
      continue;
    }
    if (!shouldParsePdfDocument(doc)) {
      documentProcessing.push(documentProcessingRecord(doc, "downloaded-document-enrichment", "skipped", downloadedDocumentSkipReason(doc)));
      documents.push({ ...doc, parseStatus: doc.parseStatus ?? (doc.localPath ? "skipped" : undefined) });
      continue;
    }
    try {
      const { text, tables } = await readPdfText(doc.localPath!, result.catalogNumber, doc.url);
      // Multi-model PDFs need target scoping, but some catalogs keep shared technical
      // pages away from the catalog table. Keep both the target rows and global spec rows.
      const tightText = buildDocumentParseContext(text, result.catalogNumber);
      const attributes = [
        ...extractDocumentTextAttributes({
          catalogNumber: result.catalogNumber,
          document: doc,
          text: tightText,
          tables
        }),
        ...(await extractComplianceMatrixAttributesSafely(text, doc.localPath!, result.catalogNumber, doc.url))
      ];
      attributes.push(...(await extractPositionedWeightDimensionsSafely(doc.localPath!, result.catalogNumber, doc.url, attributes)));
      if (attributes.length > 0) {
        documentAttributes.push(...stampDocumentAttributes(attributes));
        documentSources.push({
          url: doc.url,
          sourceType: "generated",
          parser: "pdf-table-extractor",
          stage: "enrich-documents",
          reason: doc.type,
          fetchedAt: new Date().toISOString()
        });
      }
      const substantive = documentAttributesAreSubstantive(attributes);
      documents.push({ ...doc, parseStatus: substantive ? "parsed" : "skipped", parseError: undefined });
      documentProcessing.push(documentProcessingRecord(
        doc,
        "downloaded-document-enrichment",
        substantive ? "parsed" : "skipped",
        substantive ? `Parsed ${attributes.length} attribute records from downloaded PDF.` : "Opened downloaded PDF, but no source-backed product attributes were extracted.",
        undefined,
        documentExtractionMetrics(attributes, [doc], Date.now() - started)
      ));
    } catch (error) {
      const parseError = error instanceof Error ? error.message : "PDF parse failed";
      documentParseFailures.push(`${doc.label || doc.url}: ${parseError}`);
      documents.push({ ...doc, parseStatus: "failed", parseError });
      documentProcessing.push(documentProcessingRecord(doc, "downloaded-document-enrichment", "failed", "Downloaded PDF parse failed.", parseError, { elapsedMs: Date.now() - started }));
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
      const { text, tables } = await readPdfText(fetched.localPath, result.catalogNumber, parsedDoc.url);
      const tightText = buildDocumentParseContext(text, result.catalogNumber);
      const attributes = [
        ...extractDocumentTextAttributes({
          catalogNumber: result.catalogNumber,
          document: parsedDoc,
          text: tightText,
          tables
        }),
        ...(await extractComplianceMatrixAttributesSafely(text, fetched.localPath, result.catalogNumber, parsedDoc.url))
      ];
      attributes.push(...(await extractPositionedWeightDimensionsSafely(fetched.localPath, result.catalogNumber, parsedDoc.url, attributes)));
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
  elapsedMs?: number
): Pick<DocumentProcessingDiagnostic, "attributeCount" | "normalizedFields" | "elapsedMs"> {
  return {
    attributeCount: attributes.length,
    normalizedFields: normalizedFieldNames(normalizeFields(attributes, documents)),
    ...(elapsedMs !== undefined ? { elapsedMs } : {})
  };
}

function normalizedFieldNames(normalized: ProductResult["normalized"]): string[] {
  return Object.entries(normalized)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key]) => key)
    .sort();
}

function downloadedDocumentSkipReason(doc: DocumentRecord): string {
  if (doc.downloadStatus && doc.downloadStatus !== "downloaded") return `Skipped because downloadStatus is '${doc.downloadStatus}': ${doc.downloadError ?? "no downloaded PDF available"}.`;
  if (!doc.localPath) return "Skipped because no local downloaded file path is available.";
  if (!/\.pdf$/i.test(doc.localPath) && !isPdfLikeDocumentUrl(doc.url)) return "Skipped because the downloaded local file is not a PDF.";
  if (!["datasheet", "certificate", "manual", "other"].includes(doc.type)) return `Skipped because document type '${doc.type}' is not parsed by PDF enrichment.`;
  return "Skipped by PDF enrichment policy.";
}

function remoteDocumentSkipReason(doc: DocumentRecord): string {
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
}): AttributeRecord[] {
  const sourceUrl = input.document.url;
  const lines = cachedNormalizedPdfLines(input.text, sourceUrl);
  const orderingAttributes = extractCatalogOrderingTableRows(lines, input.catalogNumber, sourceUrl);
  const hasStructuredOrderingRow = orderingAttributes.some((attr) => attr.name === "Catalog Number");
  const attributes = hasStructuredOrderingRow
    ? [parsedDocumentAttribute(input.document, sourceUrl)]
    : cachedGlobalPdfAttributes(input.document, input.text, lines, sourceUrl);

  const productSpecificAttributes = [
    ...orderingAttributes,
    ...cachedGlobalPdfTechnicalAttributes(input.text, lines, sourceUrl),
    ...extractPatternModelPhysicalRows(lines, input.catalogNumber, sourceUrl),
    ...(hasStructuredOrderingRow ? [] : extractGenericCatalogTableRows(lines, input.catalogNumber, sourceUrl)),
    ...(hasStructuredOrderingRow ? [] : extractGetTableCatalogRows(input.tables ?? [], input.catalogNumber, sourceUrl)),
    ...(hasStructuredOrderingRow ? [] : extractCatalogDescriptionRows(lines, input.catalogNumber, sourceUrl)),
    ...extractCatalogSpecificRows(lines, input.catalogNumber, sourceUrl),
    ...(hasStructuredOrderingRow ? [] : extractCatalogFeatureAttributes(lines, input.catalogNumber, sourceUrl, input.document.type))
  ];

  return dedupeAttributes([...productSpecificAttributes, ...attributes]);
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
      const mappedCatalogNumber = mapped.get("catalogNumber");
      if (mappedCatalogNumber && !sameCatalogNumber(mappedCatalogNumber, catalogNumber, { compact: true, ignoreCase: true })) continue;

      push("Catalog Number", mapped.get("catalogNumber") ?? catalogNumber);
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
  const headerText = cells.join(" ");
  return /\b(?:catalog|cat(?:alog)?\.?\s*no|part\s*(?:number|no)|order\s*(?:number|no)|mlfb|type\s*code|description|material|weight|mass|width|height|depth|dimensions?|voltage|current)\b/i.test(
    headerText
  );
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

function cachedGlobalPdfTechnicalAttributes(text: string, lines: string[], sourceUrl: string): AttributeRecord[] {
  const cacheKey = documentTextCacheKey(text, sourceUrl);
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
    ...extractStackedDimensionTableRows(lines, sourceUrl),
    ...extractInlineDimensionText(lines, sourceUrl),
    ...extractContactRatingAttributes(lines, sourceUrl),
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

function documentTextCacheKey(text: string, sourceUrl: string): string {
  return `${sourceUrl}|${text.length}|${compact(text.slice(0, 120))}|${compact(text.slice(-120))}`;
}

function trimMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
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
      if (compactToken === compactCatalog) sawOurCatalog = true;
      else sawOtherCatalog = true;
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
  const cachedFullText = await readCachedFullPdfTextIfEligible(filePath, cacheIdentity);
  if (cachedFullText) return cachedFullText;

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
  if (ocr.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) return { text: ocr.text.slice(0, MAX_PDF_TEXT_CHARS), tables: [] };
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

async function extractPositionedWeightDimensionsSafely(
  filePath: string,
  catalogNumber: string,
  sourceUrl: string,
  existingAttributes: AttributeRecord[]
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
  if (hasWeight && hasDimensions && !hasVoltage && !hasCurrent) return [];
  try {
    const data = new Uint8Array(await fs.readFile(filePath));
    const rows = await extractPositionedTableRowsFromPdf(data, catalogNumber);
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

async function readCachedFullPdfTextIfEligible(filePath: string, cacheIdentity?: string): Promise<PdfDocumentText | undefined> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > FULL_PDF_TEXT_CACHE_MAX_FILE_BYTES) return undefined;
  const cacheKey = cacheIdentity ? `source:${cacheIdentity}` : `${filePath}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  let cached = fullPdfTextCache.get(cacheKey);
  if (!cached) {
    cached = readFullPdfText(filePath).catch((error) => {
      fullPdfTextCache.delete(cacheKey);
      throw error;
    });
    fullPdfTextCache.set(cacheKey, cached);
    trimFullPdfTextCache();
  }
  return cached;
}

async function readFullPdfText(filePath: string): Promise<PdfDocumentText> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const parsed = await parser.getText();
    if (parsed.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) {
      const tables = await safeGetTables(parser, parsed.pages.slice(0, MAX_PDF_PAGES).map((page) => page.num));
      return { text: parsed.text.slice(0, MAX_PDF_TEXT_CHARS), tables };
    }
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  const ocr = await readPdfWithOptionalOcr(filePath, { maxPages: MAX_PDF_PAGES });
  if (ocr.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) return { text: ocr.text.slice(0, MAX_PDF_TEXT_CHARS), tables: [] };
  throw new Error(ocr.error ? `PDF has no extractable text and OCR failed: ${ocr.error}` : "PDF has no extractable text and OCR returned no text.");
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

function trimFullPdfTextCache(): void {
  while (fullPdfTextCache.size > FULL_PDF_TEXT_CACHE_MAX_ENTRIES) {
    const oldest = fullPdfTextCache.keys().next().value;
    if (!oldest) return;
    fullPdfTextCache.delete(oldest);
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
  for (const num of selectGlobalTechnicalPages(pages, keepPages)) keepPages.add(num);
  const keepPageNumbers = [...keepPages];
  return {
    text: pages.filter((page) => keepPages.has(page.num)).map((page) => page.text).join("\n"),
    tables: await safeGetTables(parser, keepPageNumbers)
  };
}

function selectGlobalTechnicalPages(pages: Array<{ num: number; text: string }>, alreadyKept: Set<number>): number[] {
  const candidates = pages
    .filter((page) => !alreadyKept.has(page.num))
    .map((page) => ({ num: page.num, score: globalTechnicalPageScore(page.text) }))
    .filter((page) => page.score >= 6)
    .sort((left, right) => right.score - left.score || left.num - right.num);
  return candidates.slice(0, TARGETED_PDF_MAX_GLOBAL_TECHNICAL_PAGES).map((page) => page.num);
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
  if (doc.downloadStatus && doc.downloadStatus !== "downloaded") return false;
  if (!doc.localPath) return false;
  if (!/\.pdf$/i.test(doc.localPath) && !isPdfLikeDocumentUrl(doc.url)) return false;
  return ["datasheet", "certificate", "manual", "other"].includes(doc.type);
}

function shouldProbeRemotePdfDocument(doc: DocumentRecord): boolean {
  return Boolean(remoteProbeDocumentCandidate(doc));
}

function remoteProbeDocumentCandidate(doc: DocumentRecord): DocumentRecord | undefined {
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

function stampDocumentAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  return attributes.map((attr) => ({
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
    return inferEatonRapidLink512CatalogRows(lines, catalogNumber, sourceUrl).slice(0, 60);
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

function catalogOrderingCacheKey(lines: string[], sourceUrl: string): string {
  return `${sourceUrl}|${lines.length}|${compact(lines[0] ?? "")}|${compact(lines.at(-1) ?? "")}`;
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

function inferEatonRapidLink512CatalogRows(lines: string[], catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  if (!eatonRapidLinkTextMentionsHanQ5(lines)) return [];
  const match = cleanText(catalogNumber).match(/^CDVRL(\d{5})$/i);
  if (!match) return [];
  const targetNumber = Number(match[1]);
  if (!Number.isFinite(targetNumber) || targetNumber <= 48) return [];
  return inferEatonRapidLinkCatalogOffset(lines, catalogNumber, sourceUrl, {
    offset: 48,
    baseInference: false,
    transformModel: (model) => model.replace(/-412/i, "-512"),
    canTransformModel: (model) => /-412/i.test(model),
    transformAttribute: (attr) => attr,
    basis: (baseCatalog) => `Derived from ${baseCatalog} ordering row and Eaton RASP5X type-code legend: 512 = HAN Q5 lower entrance.`
  }) ?? inferEatonRapidLinkCatalogOffset(lines, catalogNumber, sourceUrl, {
    offset: 144,
    baseInference: true,
    applies: (targetNumber) => (targetNumber >= 20217 && targetNumber <= 20240) || (targetNumber >= 20649 && targetNumber <= 20672),
    transformModel: (model) => model.replace(/-412/i, "-512"),
    canTransformModel: (model) => /-412/i.test(model),
    transformAttribute: (attr) => attr,
    basis: (baseCatalog) => `Derived from ${baseCatalog} ordering row and Eaton RASP5X type-code legend: 512 = HAN Q5 lower entrance in the C2 option sub-block.`
  }) ?? inferEatonRapidLinkCatalogOffset(lines, catalogNumber, sourceUrl, {
    offset: 168,
    baseInference: true,
    applies: (targetNumber) =>
      (targetNumber >= 20169 && targetNumber <= 20288) ||
      (targetNumber >= 20601 && targetNumber <= 20720),
    transformModel: (model) => model.replace(/-412/i, "-512"),
    canTransformModel: (model) => /-412/i.test(model),
    transformAttribute: (attr) => attr,
    basis: (baseCatalog) => `Derived from ${baseCatalog} ordering row and Eaton RASP5X type-code legend: 512 = HAN Q5 lower entrance in the C2 option block.`
  }) ?? inferEatonRapidLinkCatalogOffset(lines, catalogNumber, sourceUrl, {
    offset: 10000,
    baseInference: true,
    transformModel: (model) => model.replace(/^RASP5G-/i, "RASP5A-"),
    canTransformModel: (model) => /^RASP5G-[^-]+PNT-/i.test(model),
    transformAttribute: (attr) => attr.name === "Degree of protection" ? { ...attr, value: "IP65" } : attr,
    basis: (baseCatalog) => `Derived from ${baseCatalog} ordering row and Eaton RASP5X type-code legend: 5A = advanced IP65 variant of 5G PROFINET.`
  }) ?? inferEatonRapidLinkCatalogOffset(lines, catalogNumber, sourceUrl, {
    offset: 10000,
    baseInference: true,
    transformModel: (model) => model.replace(/(-(?:412|512)[R0][012])[01]([01]S1-)/i, (_match, prefix: string, suffix: string) => `${prefix}2${suffix}`),
    canTransformModel: (model) => /^RASP5A-/i.test(model) && /-(?:412|512)[R0][012][01][01]S1-/i.test(model),
    transformAttribute: (attr) => attr.name === "Degree of protection" ? { ...attr, value: "IP65" } : attr,
    basis: (baseCatalog) => `Derived from ${baseCatalog} ordering row and Eaton RASP5X type-code legend: EMC option 2 = C2 filter variant.`
  }) ?? [];
}

function inferEatonRapidLinkCatalogOffset(
  lines: string[],
  catalogNumber: string,
  sourceUrl: string,
  rule: {
    offset: number;
    baseInference: boolean;
    applies?: (targetNumber: number) => boolean;
    canTransformModel: (model: string) => boolean;
    transformModel: (model: string) => string;
    transformAttribute: (attr: AttributeRecord) => AttributeRecord;
    basis: (baseCatalog: string) => string;
  }
): AttributeRecord[] | undefined {
  const match = cleanText(catalogNumber).match(/^CDVRL(\d{5})$/i);
  if (!match) return undefined;
  const targetNumber = Number(match[1]);
  if (rule.applies && !rule.applies(targetNumber)) return undefined;
  const baseNumber = targetNumber - rule.offset;
  if (!Number.isFinite(baseNumber) || baseNumber <= 0) return undefined;
  const baseCatalog = `CDVRL${String(baseNumber).padStart(5, "0")}`;
  const baseAttributes = extractCatalogOrderingTableRows(lines, baseCatalog, sourceUrl, { allowInference: rule.baseInference });
  const baseModel = baseAttributes.find((attr) => attr.name === "Model Code")?.value;
  if (!baseModel || !rule.canTransformModel(baseModel)) return undefined;
  const inferredModel = rule.transformModel(baseModel);
  return baseAttributes.map((baseAttr) => {
    const attr = rule.transformAttribute(baseAttr);
    if (attr.name === "Catalog Number") {
      return { ...attr, group: "PDF Catalog Ordering Table Inferred", value: catalogNumber };
    }
    if (attr.name === "Model Code") {
      return { ...attr, group: "PDF Catalog Ordering Table Inferred", value: inferredModel };
    }
    return { ...attr, group: "PDF Catalog Ordering Table Inferred" };
  }).concat([
    {
      group: "PDF Catalog Ordering Table Inferred",
      name: "Inference basis",
      value: rule.basis(baseCatalog),
      sourceUrl
    }
  ]);
}

function eatonRapidLinkTextMentionsHanQ5(lines: string[]): boolean {
  const text = lines.slice(0, 220).map(cleanText).join(" ");
  return /\b512\s*=\s*HAN\s*Q5\b/i.test(text) && /\b412\s*=\s*HAN\s*Q4\/2\b/i.test(text);
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
    const mappedCatalogNumber = mapped.get("catalogNumber");
    if (mappedCatalogNumber && !sameCatalogNumber(mappedCatalogNumber, catalogNumber, { compact: true, ignoreCase: true })) continue;

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

    push("Catalog Number", mapped.get("catalogNumber") ?? catalogNumber);
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
    const headerText = header.join(" ");
    if (!/\b(?:catalog|cat(?:alog)?\.?\s*no|part\s*(?:number|no)|order\s*(?:number|no)|mlfb|type\s*code|description|material|weight|mass|width|height|depth|dimensions?|voltage|current)\b/i.test(headerText)) {
      continue;
    }
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

function genericCatalogTableKey(header: string): string | undefined {
  const label = cleanText(header);
  if (/\b(?:catalog|cat(?:alog)?\.?\s*no|part\s*(?:number|no)|order\s*(?:number|no)|mlfb|type\s*code)\b/i.test(label)) return "catalogNumber";
  if (/\b(?:description|product\s+(?:short\s+)?text|name)\b/i.test(label)) return "description";
  if (/\b(?:product\s+type|device\s+type|type\s+description)\b/i.test(label)) return "productType";
  if (/\bmaterial\b/i.test(label)) return "material";
  if (/\b(?:weight|mass|wgt)\b|^\s*w\s*(?:\[|\(|$)/i.test(label)) return "weight";
  // A bare "Dimensions" column header (as opposed to separate Width/Height/Depth columns) holds
  // one already-combined "W x H x D" value per row — e.g. Rockwell's 1606-td002 "Battery Modules
  // for DC-UPS" table ("Description | Dimensions | Catalog Number"). Checked before the width/
  // height/depth cases below since "dimensions" doesn't match any of those individually.
  if (/\bdimensions?\b/i.test(label)) return "dimensions";
  if (/\b(?:voltage|supply|input|output)\b/i.test(label) && /\b(?:v|voltage|supply)\b/i.test(label)) return "voltage";
  if (/\b(?:current|amp|load)\b/i.test(label)) return "current";
  if (/\b(?:width|breite)\b|^\s*w(?:idth)?\s*(?:\[|\(|$)/i.test(label)) return "width";
  if (/\b(?:height|hoehe|höhe)\b|^\s*h(?:eight)?\s*(?:\[|\(|$)/i.test(label)) return "height";
  if (/\b(?:depth|tiefe)\b|^\s*d(?:epth)?\s*(?:\[|\(|$)/i.test(label)) return "depth";
  if (/\b(?:length|lange|länge)\b|^\s*l(?:ength)?\s*(?:\[|\(|$)/i.test(label)) return "length";
  if (/\b(?:diameter|dia\.?)\b|ø|^\s*d[ia]*\s*(?:\[|\()/i.test(label)) return "diameter";
  if (/^dn\b/i.test(label)) return "dn";
  return undefined;
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

function extractStackedDimensionTableRows(lines: string[], sourceUrl: string): AttributeRecord[] {
  const attributes: AttributeRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const row = splitStackedDataCells(lines[index]);
    if (row.length < 4) continue;
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
    attributes.push(...extractStackedDimensionSectionFallback(lines, sourceUrl));
  }
  return attributes.slice(0, 40);
}

function extractStackedDimensionSectionFallback(lines: string[], sourceUrl: string): AttributeRecord[] {
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

function extractContactRatingAttributes(lines: string[], sourceUrl: string): AttributeRecord[] {
  const voltageRanges: string[] = [];
  const currents: string[] = [];
  let contactRatingWindow = 0;

  for (const rawLine of lines) {
    const line = cleanText(rawLine);
    if (/contact rating/i.test(line)) contactRatingWindow = 35;
    if (contactRatingWindow <= 0) continue;
    contactRatingWindow -= 1;

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
