import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { cleanText, normalizeFields, splitNameValue } from "./normalizer.js";
import { catalogTextMatches } from "./catalog-number.js";
import { buildTightContextForCatalog, buildVariantColumnContext } from "./tight-context.js";

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

const KNOWN_LABELS = [
  "Approximate shipping weight",
  "Approval/Conformity",
  "Cable jacket, material",
  "Cable length L",
  "Catalog Number",
  "Certifications",
  "Circuit breaker frame type",
  "Connection type",
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
  "HP rating - max",
  "Housing material",
  "Input nominal voltage",
  "Interrupt rating",
  "Interrupt rating range",
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
  "Net weight",
  "Number of poles",
  "Operating voltage Ub",
  "Overall dimensions",
  "Product Weight",
  "Product net weight",
  "Rated impulse withstand voltage",
  "Rated operation current (Ie)",
  "Rated operational current",
  "Rated operational current for specified heat dissipation (In)",
  "Rated operational voltage",
  "Rated operational voltage (Ue) - max",
  "Rated current (40 °C)",
  "Rated current (40 Â°C)",
  "Rated voltage",
  "Shipping weight",
  "Size",
  "Standards, directives and approvals",
  "Surface finishing",
  "Trip Type",
  "Unit weight",
  "Voltage rating",
  "Voltage rating - max",
  "Voltage type",
  "Weight",
  "Weight, approx.",
  "Width"
].sort((left, right) => right.length - left.length);

export async function enrichResultFromDownloadedDocuments(result: ProductResult): Promise<ProductResult> {
  const documentAttributes: AttributeRecord[] = [];
  const documentSources: SourceRecord[] = [];
  const documentParseFailures: string[] = [];
  const documents: DocumentRecord[] = [];

  for (const doc of result.documents) {
    if (!shouldParsePdfDocument(doc)) {
      documents.push({ ...doc, parseStatus: doc.parseStatus ?? (doc.localPath ? "skipped" : undefined) });
      continue;
    }
    try {
      const text = await readPdfText(doc.localPath!, result.catalogNumber);
      // Multi-model technical-data PDFs (Rockwell 1783-td*, Eaton multi-variant catalogs)
      // list specs for several catalog numbers in shared comparison tables. Without this
      // narrowing, "Power input ... 7.991 8.5 6.2" on a single line meant every catalog
      // in the run inherited the leftmost value (7.991). Tight context cuts at sibling
      // products so each catalog only sees its own column / row.
      // Prefer column-accurate extraction for multi-variant comparison tables; fall back to
      // line-window scoping, then the whole text, so non-tabular PDFs behave exactly as before.
      const tightText =
        buildVariantColumnContext(text, result.catalogNumber, { maxChars: MAX_PDF_TEXT_CHARS }) ??
        buildTightContextForCatalog(text, result.catalogNumber, { maxChars: MAX_PDF_TEXT_CHARS }) ??
        text;
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
    } catch (error) {
      const parseError = error instanceof Error ? error.message : "PDF parse failed";
      documentParseFailures.push(`${doc.label || doc.url}: ${parseError}`);
      documents.push({ ...doc, parseStatus: "failed", parseError });
    }
  }

  if (!documentAttributes.length) {
    return {
      ...result,
      diagnostics: withDocumentParseFailures(result, documentParseFailures),
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
    diagnostics: withDocumentParseFailures(result, documentParseFailures),
    normalized,
    attributes,
    documents,
    sources: dedupeSources([...result.sources, ...documentSources])
  };
}

function withDocumentParseFailures(
  result: ProductResult,
  documentParseFailures: string[]
): ProductResult["diagnostics"] {
  if (!documentParseFailures.length) return result.diagnostics;
  return {
    ...result.diagnostics,
    documentParseFailures: [
      ...(result.diagnostics?.documentParseFailures ?? []),
      ...documentParseFailures
    ].slice(0, 50)
  };
}

export function extractDocumentTextAttributes(input: {
  catalogNumber: string;
  document: Pick<DocumentRecord, "label" | "type" | "url" | "localPath">;
  text: string;
}): AttributeRecord[] {
  const sourceUrl = input.document.url;
  const documentGroup = `PDF ${input.document.type}`;
  const attributes: AttributeRecord[] = [
    {
      group: "PDF Document",
      name: "Parsed document",
      value: cleanText(input.document.label || path.basename(input.document.localPath ?? input.document.url)),
      sourceUrl
    }
  ];
  const lines = normalizePdfLines(input.text);
  const sectionByLine = sectionTracker();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = cleanText(rawLine);
    if (!line || shouldSkipPdfLine(line)) continue;

    const section = sectionByLine(line);
    if (isPdfSectionHeading(line)) continue;
    const tabPair = parseTabbedPair(rawLine);
    if (tabPair) {
      attributes.push({ group: `${documentGroup}${section ? ` - ${section}` : ""}`, ...tabPair, sourceUrl });
      continue;
    }

    const spacedPair = parseSpacedTablePair(rawLine);
    if (spacedPair) {
      attributes.push({ group: `${documentGroup}${section ? ` - ${section}` : ""}`, ...spacedPair, sourceUrl });
      continue;
    }

    const knownPair = parseKnownInlinePair(line);
    if (knownPair) {
      attributes.push({ group: `${documentGroup}${section ? ` - ${section}` : ""}`, ...knownPair, sourceUrl });
      continue;
    }

    const colonPair = splitNameValue(line);
    if (colonPair) {
      attributes.push({ group: `${documentGroup}${section ? ` - ${section}` : ""}`, ...colonPair, sourceUrl });
      continue;
    }

    if (isKnownLabelOnly(line)) {
      const value = nextMeaningfulLine(lines, index + 1);
      if (value) {
        attributes.push({ group: `${documentGroup}${section ? ` - ${section}` : ""}`, name: line, value, sourceUrl });
      }
      continue;
    }

    if (isUsefulFeatureLine(line, input.catalogNumber)) {
      attributes.push({ group: `${documentGroup}${section ? ` - ${section}` : ""}`, name: "Feature", value: line, sourceUrl });
    }
  }

  const productSpecificAttributes = [
    ...extractSiemensVsg519Dimensions(input.catalogNumber, lines, sourceUrl),
    ...extractEta1140Dimensions(input.catalogNumber, lines, sourceUrl),
    ...extractContactRatingAttributes(lines, sourceUrl),
    ...extractCatalogSpecificRows(lines, input.catalogNumber, sourceUrl)
  ];

  return dedupeAttributes([...productSpecificAttributes, ...attributes]);
}

async function readPdfText(filePath: string, catalogNumber?: string): Promise<string> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    if (catalogNumber) {
      const targeted = await readTargetedPdfText(parser, catalogNumber);
      if (targeted) return targeted.slice(0, MAX_PDF_TEXT_CHARS);
    }
    const parsed = await parser.getText({ first: MAX_PDF_PAGES });
    return parsed.text.slice(0, MAX_PDF_TEXT_CHARS);
  } finally {
    await parser.destroy().catch(() => undefined);
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
  return pages
    .filter((page) => keepPages.has(page.num))
    .map((page) => page.text)
    .join("\n");
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
  if (!/\.pdf$/i.test(doc.localPath)) return false;
  return ["datasheet", "certificate", "manual", "other"].includes(doc.type);
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
  const value = joinUniquePipeCells(cells.slice(1));
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
  const value = joinUniquePipeCells(values);
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
    const value = cleanText(match[1]);
    if (!value || value.toLowerCase() === label.toLowerCase()) continue;
    return { name: canonicalLabel(label), value };
  }
  return undefined;
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

function isUsefulFeatureLine(line: string, catalogNumber: string): boolean {
  if (catalogTextMatches(line, catalogNumber)) return true;
  return /\b(ce|ul|csa|vde|rohs|reach|weee|nema|ip\s*\d+|stainless|steel|cast iron|brass|copper|aluminium|aluminum|polycarbonate|polyester|pvc|pur|epdm|voltage|current|pressure|temperature|rating)\b/i.test(
    line
  );
}

function extractCatalogSpecificRows(lines: string[], catalogNumber: string, sourceUrl: string): AttributeRecord[] {
  const values = new Set<string>();
  const compactPart = compact(catalogNumber);
  const afterColon = catalogNumber.includes(":") ? catalogNumber.split(":").pop() ?? catalogNumber : catalogNumber;
  const compactAfterColon = compact(afterColon);
  for (const line of lines) {
    const cleaned = cleanText(line);
    const compactLine = compact(cleaned);
    if (!cleaned || cleaned.length > 500) continue;
    if (compactPart && compactLine.includes(compactPart)) values.add(cleaned);
    if (compactAfterColon && compactAfterColon !== compactPart && compactLine.includes(compactAfterColon)) values.add(cleaned);
  }
  return [...values].slice(0, 20).map((value) => ({
    group: "PDF Matched Rows",
    name: "Matched product row",
    value,
    sourceUrl
  }));
}

function extractSiemensVsg519Dimensions(catalogNumber: string, lines: string[], sourceUrl: string): AttributeRecord[] {
  const part = catalogNumber.includes(":") ? catalogNumber.split(":").pop() ?? catalogNumber : catalogNumber;
  const match = part.match(/^VSG519[KL](\d{2})-/i);
  if (!match) return [];
  const dn = Number(match[1]);
  if (!Number.isFinite(dn)) return [];
  const joined = lines.map(cleanText).join("\n");
  const rowMatch = joined.match(new RegExp(`\\b${dn}\\s+G\\s+([0-9¼½¾\\s]+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+(?:[.,]\\d+)?)\\b`));
  if (!rowMatch) return [];
  const thread = cleanText(rowMatch[1]);
  const b = rowMatch[2];
  const l1 = rowMatch[3];
  const l3 = rowMatch[4];
  const h = rowMatch[5];
  const weight = rowMatch[6].replace(",", ".");
  const dimensions = `DN ${dn}; D G ${thread}; B ${b} mm; L1 ${l1} mm; L3 ${l3} mm; H ${h} mm`;
  return [
    { group: "PDF Product Dimensions", name: "Dimensions", value: dimensions, sourceUrl },
    { group: "PDF Product Dimensions", name: "Weight", value: `${weight} kg`, sourceUrl }
  ];
}

function extractEta1140Dimensions(catalogNumber: string, lines: string[], sourceUrl: string): AttributeRecord[] {
  if (!/^1140-E/i.test(catalogNumber)) return [];
  const joined = lines.map(cleanText).join("\n");
  if (!/1140-E211-P1M1/i.test(joined)) return [];
  return [
    {
      group: "PDF Product Dimensions",
      name: "Dimensions",
      value: "approx. 34.5 mm x 27.5 mm x 19 mm (datasheet drawing for 1140-E211-P1M1)",
      sourceUrl
    }
  ];
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
  return /^(basic features|electrical data|electrical connection|environmental conditions|interface|material|mechanical data|technical data|dimensions|approvals|compliances|product details)$/i.test(
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
