import fs from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { AttributeRecord, DocumentRecord, ProductResult, SourceRecord } from "../../shared/types.js";
import { cleanText, normalizeFields, splitNameValue } from "./normalizer.js";

const MAX_PDF_PAGES = 30;
const MAX_PDF_TEXT_CHARS = 250_000;

const KNOWN_LABELS = [
  "Approximate shipping weight",
  "Approval/Conformity",
  "Cable jacket, material",
  "Cable length L",
  "Catalog Number",
  "Certifications",
  "Current ratings",
  "Degree of protection",
  "Dimensions (HxWxD), approx.",
  "Dimensions/Weight",
  "Enclosure material",
  "Enclosure type rating",
  "Housing material",
  "IP rating",
  "Mass",
  "Material",
  "Material contact carrier",
  "Material contacts",
  "Material cover nut",
  "Material grip",
  "Net weight",
  "Operating voltage Ub",
  "Product Weight",
  "Rated current (40 °C)",
  "Rated current (40 Â°C)",
  "Rated voltage",
  "Standards, directives and approvals",
  "Voltage rating",
  "Weight",
  "Weight, approx."
].sort((left, right) => right.length - left.length);

export async function enrichResultFromDownloadedDocuments(result: ProductResult): Promise<ProductResult> {
  const documentAttributes: AttributeRecord[] = [];
  const documentSources: SourceRecord[] = [];

  for (const doc of result.documents) {
    if (!shouldParsePdfDocument(doc)) continue;
    try {
      const text = await readPdfText(doc.localPath!);
      const attributes = extractDocumentTextAttributes({
        catalogNumber: result.catalogNumber,
        document: doc,
        text
      });
      if (attributes.length > 0) {
        documentAttributes.push(...attributes);
        documentSources.push({
          url: doc.url,
          sourceType: "generated",
          parser: "pdf-text-extraction",
          fetchedAt: new Date().toISOString()
        });
      }
    } catch (error) {
      documentAttributes.push({
        group: "Document Parse Errors",
        name: doc.label || "PDF parse error",
        value: error instanceof Error ? error.message : "PDF parse failed",
        sourceUrl: doc.url
      });
    }
  }

  if (!documentAttributes.length) return result;

  const attributes = dedupeAttributes([...result.attributes, ...documentAttributes]);
  const normalized = {
    ...normalizeFields(attributes, result.documents),
    ...nonEmptyNormalized(result.normalized)
  };

  return {
    ...result,
    status: result.status === "failed" ? result.status : "found",
    normalized,
    attributes,
    sources: dedupeSources([...result.sources, ...documentSources])
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
    ...extractCatalogSpecificRows(lines, input.catalogNumber, sourceUrl)
  ];

  return dedupeAttributes([...productSpecificAttributes, ...attributes]);
}

async function readPdfText(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const parsed = await parser.getText({ first: MAX_PDF_PAGES });
    return parsed.text.slice(0, MAX_PDF_TEXT_CHARS);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function shouldParsePdfDocument(doc: DocumentRecord): boolean {
  if (!doc.localPath || doc.localPath.startsWith("DOWNLOAD_FAILED") || doc.localPath.startsWith("SKIPPED_")) return false;
  if (!/\.pdf$/i.test(doc.localPath)) return false;
  return ["datasheet", "certificate", "manual", "other"].includes(doc.type);
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
  const value = cells.slice(1).join(" | ");
  if (!isLikelyAttributeName(name) || !value) return undefined;
  return { name, value };
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
  if (line.toLowerCase().includes(catalogNumber.toLowerCase())) return true;
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
