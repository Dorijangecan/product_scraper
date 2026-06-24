import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { AttributeRecord, DocumentProcessingDiagnostic, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { cleanText, normalizeFields, splitNameValue } from "./normalizer.js";
import { catalogTextMatches } from "./catalog-number.js";
import { buildTightContextForCatalog, buildVariantColumnContext } from "./tight-context.js";
import { listTechnicalAttributeAliases } from "./technical-attribute-aliases.js";
import { readPdfWithOptionalOcr } from "./pdf-ocr.js";
import { isPdfLikeDocumentUrl } from "./document-url.js";
import { fieldMatchesLabel, FIELD_REGISTRY, listFieldRegistryDocumentLabels } from "./field-registry.js";
import { extractElectricalSpecAttributesFromText } from "./electrical-spec-miner.js";

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

const fullPdfTextCache = new Map<string, Promise<string>>();
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
  "Power dissipation in W",
  "Power dissipation per pole",
  "Power input",
  "Power input, max",
  "Power loss",
  "Power loss per pole",
  "Power loss Pv",
  "Program memory",
  "Product Weight",
  "Product net weight",
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
  "Tightening torque"
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
      const text = await readPdfText(doc.localPath!, result.catalogNumber, doc.url);
      // Multi-model PDFs need target scoping, but some catalogs keep shared technical
      // pages away from the catalog table. Keep both the target rows and global spec rows.
      const tightText = buildDocumentParseContext(text, result.catalogNumber);
      const attributes = extractDocumentTextAttributes({
        catalogNumber: result.catalogNumber,
        document: doc,
        text: tightText
      });
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
      documents.push({ ...doc, parseStatus: attributes.length > 1 ? "parsed" : "skipped", parseError: undefined });
      documentProcessing.push(documentProcessingRecord(
        doc,
        "downloaded-document-enrichment",
        attributes.length > 1 ? "parsed" : "skipped",
        attributes.length > 1 ? `Parsed ${attributes.length} attribute records from downloaded PDF.` : "Opened downloaded PDF, but no source-backed product attributes were extracted."
      ));
    } catch (error) {
      const parseError = error instanceof Error ? error.message : "PDF parse failed";
      documentParseFailures.push(`${doc.label || doc.url}: ${parseError}`);
      documents.push({ ...doc, parseStatus: "failed", parseError });
      documentProcessing.push(documentProcessingRecord(doc, "downloaded-document-enrichment", "failed", "Downloaded PDF parse failed.", parseError));
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
  const normalized = {
    ...normalizeFields(attributes, documents),
    ...nonEmptyNormalized(result.normalized)
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
      const text = await readPdfText(fetched.localPath, result.catalogNumber, parsedDoc.url);
      const tightText = buildDocumentParseContext(text, result.catalogNumber);
      const attributes = extractDocumentTextAttributes({
        catalogNumber: result.catalogNumber,
        document: parsedDoc,
        text: tightText
      });
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
      documents.push({ ...parsedDoc, parseStatus: attributes.length > 1 ? "parsed" : "skipped", parseError: undefined });
      documentProcessing.push(documentProcessingRecord(
        parsedDoc,
        "remote-document-enrichment",
        attributes.length > 1 ? "parsed" : "skipped",
        attributes.length > 1 ? `Fetched and parsed ${attributes.length} attribute records from remote PDF.` : "Fetched remote PDF, but no source-backed product attributes were extracted."
      ));
      parsedDocuments += 1;
    } catch (error) {
      const parseError = error instanceof Error ? error.message : "PDF parse failed";
      documentParseFailures.push(`${doc.label || doc.url}: ${parseError}`);
      documents.push({ ...doc, parseStatus: "failed", parseError });
      documentProcessing.push(documentProcessingRecord(doc, "remote-document-enrichment", "failed", "Remote PDF probe failed.", parseError));
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
  const normalized = {
    ...normalizeFields(attributes, documents),
    ...nonEmptyNormalized(result.normalized)
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
  parseError?: string
): DocumentProcessingDiagnostic {
  return {
    url: doc.url,
    label: doc.label,
    type: doc.type,
    action,
    stage,
    reason,
    localPath: doc.localPath,
    sourceUrl: doc.sourceUrl,
    parseError
  };
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
    ...(hasStructuredOrderingRow ? [] : extractCatalogDescriptionRows(lines, input.catalogNumber, sourceUrl)),
    ...extractCatalogSpecificRows(lines, input.catalogNumber, sourceUrl),
    ...(hasStructuredOrderingRow ? [] : extractCatalogFeatureAttributes(lines, input.catalogNumber, sourceUrl, input.document.type))
  ];

  return dedupeAttributes([...productSpecificAttributes, ...attributes]);
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
    ...extractLocalizedTechnicalRows(lines, sourceUrl),
    ...extractStackedDimensionTableRows(lines, sourceUrl),
    ...extractInlineDimensionText(lines, sourceUrl),
    ...extractContactRatingAttributes(lines, sourceUrl),
    ...extractQualifiedTemperatureAttributes(lines, sourceUrl)
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
  const scoped =
    buildVariantColumnContext(text, catalogNumber, { maxChars: MAX_PDF_TEXT_CHARS }) ??
    buildTightContextForCatalog(text, catalogNumber, { maxChars: MAX_PDF_TEXT_CHARS }) ??
    text;
  const globalTechnical = buildGlobalTechnicalContext(text);
  return mergePdfTextContexts([scoped, globalTechnical, scoped === text ? "" : undefined], MAX_PDF_TEXT_CHARS);
}

function buildGlobalTechnicalContext(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const kept = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanText(lines[index]);
    if (!line || !isGlobalTechnicalLine(line)) continue;
    kept.add(index);
    if (index > 0 && isGlobalTechnicalHeading(cleanText(lines[index - 1]))) kept.add(index - 1);
    const after = globalTechnicalContinuationWindow(line);
    for (let offset = 1; offset <= after && index + offset < lines.length; offset += 1) {
      const next = cleanText(lines[index + offset]);
      if (!isGlobalTechnicalContinuation(next) && !isPatternModelTableLine(next)) {
        if (offset > 2) break;
        continue;
      }
      kept.add(index + offset);
    }
  }
  if (kept.size === 0) return undefined;
  return [...kept].sort((left, right) => left - right).map((index) => lines[index]).join("\n");
}

function isGlobalTechnicalLine(line: string): boolean {
  return (
    /\b(?:technical\s+(?:data|specifications?)|electrical\s+(?:data|ratings?)|input\s+voltage|output\s+voltage|rated\s+current|rated\s+power|degree\s+of\s+protection|operating\s+temperature|dimensions?|weight)\b/i.test(line) ||
    /\b[A-Z0-9]{1,8}\s*[=:]\s*.*?\bIP\s*\d{2}[A-Z]?\b/i.test(line) ||
    /(?:\u6280\u672f\u53c2\u6570|\u6280\u672f\u89c4\u683c|\u53d8\u9891\u5668|\u53d8\u9891\u9a71\u52a8|\u9891\u7387\u8f6c\u6362\u5668|\u8f93\u5165\u7535\u538b|\u8f93\u51fa\u7535\u538b|\u989d\u5b9a\u7535\u6d41|\u989d\u5b9a\u529f\u7387|\u9632\u62a4\u7b49\u7ea7|\u5de5\u4f5c\u6e29\u5ea6|\u73af\u5883\u6e29\u5ea6|\u5c3a\u5bf8|\u91cd\u91cf)/.test(line)
  );
}

function isGlobalTechnicalHeading(line: string): boolean {
  return /\b(?:technical|specifications?|electrical|dimensions?|weight)\b/i.test(line) || /(?:\u6280\u672f|\u89c4\u683c|\u5c3a\u5bf8|\u91cd\u91cf)/.test(line);
}

function isGlobalTechnicalContinuation(line: string): boolean {
  return /(?:\b(?:V|A|W|kW|Hz|IP\s*\d|degC|\u00b0\s*C)\b|\u2103|\d)/i.test(line) && line.length <= 400;
}

function globalTechnicalContinuationWindow(line: string): number {
  return /(?:\bdimensions?\b|\bweight\b|\u5c3a\u5bf8|\u91cd\u91cf)/i.test(line) ? 28 : 1;
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

async function readPdfText(filePath: string, catalogNumber?: string, cacheIdentity?: string): Promise<string> {
  const cachedFullText = await readCachedFullPdfTextIfEligible(filePath, cacheIdentity);
  if (cachedFullText) return cachedFullText;

  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    let text = "";
    if (catalogNumber) {
      const targeted = await readTargetedPdfText(parser, catalogNumber);
      if (targeted) text = targeted;
    }
    if (!text) {
      const parsed = await parser.getText({ first: MAX_PDF_PAGES });
      text = parsed.text;
    }
    if (text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) return text.slice(0, MAX_PDF_TEXT_CHARS);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  const ocr = await readPdfWithOptionalOcr(filePath);
  if (ocr.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) return ocr.text.slice(0, MAX_PDF_TEXT_CHARS);
  throw new Error(ocr.error ? `PDF has no extractable text and OCR failed: ${ocr.error}` : "PDF has no extractable text and OCR returned no text.");
}

async function readCachedFullPdfTextIfEligible(filePath: string, cacheIdentity?: string): Promise<string | undefined> {
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

async function readFullPdfText(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const parsed = await parser.getText();
    if (parsed.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) return parsed.text.slice(0, MAX_PDF_TEXT_CHARS);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  const ocr = await readPdfWithOptionalOcr(filePath);
  if (ocr.text.trim().length >= PDF_TEXT_MIN_CHARS_FOR_PARSE) return ocr.text.slice(0, MAX_PDF_TEXT_CHARS);
  throw new Error(ocr.error ? `PDF has no extractable text and OCR failed: ${ocr.error}` : "PDF has no extractable text and OCR returned no text.");
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
async function readTargetedPdfText(parser: InstanceType<typeof PDFParse>, catalogNumber: string): Promise<string | undefined> {
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
  if (!matches.length) return undefined;
  const keepPages = expandWithNeighbours(matches, TARGETED_PDF_NEIGHBOUR_PAGES);
  for (const num of selectGlobalTechnicalPages(pages, keepPages)) keepPages.add(num);
  return pages
    .filter((page) => keepPages.has(page.num))
    .map((page) => page.text)
    .join("\n");
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
    confidence: attr.group?.includes("Matched Rows") ? 0.66 : 0.78
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
  const value = normalizePdfAttributeValue(joinUniquePipeCells(cells.slice(1)));
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
  return /\d|[A-Z]{2,}|steel|aluminum|aluminium|plastic|poly|powder|coating|paint|nema|ip\s*\d|ce|ul|csa|rohs|reach/i.test(value);
}

function isPdfLabelQualifierOnly(value: string): boolean {
  return /^(?:xt|standard|std|safety|nse|conformal(?:ly)? coated|coated|non[-\s]?safety)$/i.test(cleanText(value));
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

    const push = (name: string, value: string | undefined) => {
      const cleaned = cleanText(value);
      if (!cleaned) return;
      const key = `${name}|${cleaned}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      attributes.push({ group: "PDF Catalog Table Row", name, value: cleaned, sourceUrl });
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
  for (let index = rowIndex - 1; index >= Math.max(0, rowIndex - 8); index -= 1) {
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

function parseCatalogDescriptionRow(line: string, catalogNumber: string): { catalog: string; description: string } | undefined {
  const span = compactCatalogSpan(line, catalogNumber);
  if (!span) return undefined;
  const description = cleanText(line.slice(span.end)).replace(/^[-:;,|]\s*/, "");
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
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
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
  const seen = new Set<string>();
  return attributes.filter((attr) => {
    const key = `${attr.group ?? ""}|${attr.name}|${attr.value}|${attr.sourceUrl ?? ""}`.toLowerCase();
    if (!attr.name || !attr.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSources(sources: SourceRecord[]): SourceRecord[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.parser}|${source.url}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
