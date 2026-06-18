import type ExcelJS from "exceljs";
import type { DocumentRecord, RunItemRecord } from "../../shared/types.js";
import { clearBody, describeSheet, type PdtColumn } from "./sheet-descriptor.js";
import { localizedPdtDocumentUrlRules } from "./rules.js";

function findCol(columns: PdtColumn[], match: (key: string) => boolean): number | undefined {
  const hit = columns.find((c) => match(c.code.toLowerCase()) || match(c.propName.toLowerCase()));
  return hit?.col;
}

interface DocRow {
  url: string;
  language: string;
  description: string;
  documentType?: string;
}

/**
 * Additional Documents is generic by default: use official localized URLs found by
 * the scraper. Manual-PDT formatting exceptions live in localizedPdtDocumentUrlRules.
 */
function documentRowsFor(item: RunItemRecord): DocRow[] {
  if (item.result?.manufacturerId === "eaton") {
    const directDocuments = eatonDirectDocumentRows(item.result.documents);
    if (directDocuments.length > 0) return directDocuments;
  }

  const ruleRows = localizedPdtDocumentUrlRules({
    manufacturerId: item.result?.manufacturerId,
    catalogNumber: item.catalogNumber
  }).map((rule) => rule.value);
  if (ruleRows.length > 0) return ruleRows;

  if (item.result?.manufacturerId === "rockwell") {
    const directDocuments = rockwellDirectDocumentRows(item.result.documents);
    if (directDocuments.length > 0) return directDocuments;
  }

  const localized = item.result?.localizedUrls;
  const en = localized?.en ?? item.result?.productUrl ?? item.productUrl;
  const de = localized?.de;
  const rows: DocRow[] = [];
  if (en) rows.push({ url: en, language: "english", description: "Datasheet(EN)" });
  if (de) rows.push({ url: de, language: "german", description: "Datenblatt" });
  return rows;
}

function eatonDirectDocumentRows(documents: DocumentRecord[]): DocRow[] {
  const direct = documents
    .filter((doc) => doc.type === "datasheet" && /^https:\/\/www\.eaton\.com\/.+\/skuPage\.[^/?#]+\.pdf(?:[?#].*)?$/i.test(doc.url))
    .sort((left, right) => eatonDocumentRank(right) - eatonDocumentRank(left));
  return direct.slice(0, 2).map((doc) => ({
    url: doc.url,
    language: eatonDocumentLanguage(doc.url),
    description: eatonDocumentDescription(doc.url),
    documentType: "pdf"
  }));
}

function eatonDocumentRank(doc: DocumentRecord): number {
  const localeRank = /\/gb\/en-gb\/|\/us\/en-us\//i.test(doc.url) ? 20 : /\/de\/de-de\//i.test(doc.url) ? 10 : 0;
  const sourceRank = doc.sourceType === "official" ? 10 : doc.sourceType === "official-fallback" ? 5 : 0;
  return localeRank + sourceRank + (doc.confidence ?? 0);
}

function eatonDocumentLanguage(url: string): string {
  return /\/de\/de-de\//i.test(url) ? "german" : "english";
}

function eatonDocumentDescription(url: string): string {
  return /\/de\/de-de\//i.test(url) ? "Datenblatt" : "Datasheet(EN)";
}

function rockwellDirectDocumentRows(documents: DocumentRecord[]): DocRow[] {
  const direct = documents
    .filter((doc) => isDirectRockwellPdf(doc.url))
    .sort((left, right) => rockwellDocumentRank(right) - rockwellDocumentRank(left));
  const bestDatasheet = direct.find((doc) => doc.type === "datasheet");
  const chosen = bestDatasheet ? [bestDatasheet] : direct.slice(0, 1);
  return chosen.map((doc) => ({
    url: doc.url,
    language: "english",
    description: rockwellDocumentDescription(doc),
    documentType: "pdf"
  }));
}

function isDirectRockwellPdf(url: string): boolean {
  return /^https:\/\/literature\.rockwellautomation\.com\/.+\.pdf(?:[?#].*)?$/i.test(url);
}

function rockwellDocumentRank(doc: DocumentRecord): number {
  const typeRank = doc.type === "datasheet" ? 50 : doc.type === "manual" ? 30 : doc.type === "certificate" ? 20 : 10;
  const labelRank = /\btechnical\s+(?:data|detail|datasheet)|datasheet|data\s+sheet\b/i.test(doc.label) ? 20 : 0;
  const sourceRank = doc.sourceType === "official" ? 10 : doc.sourceType === "official-fallback" ? 5 : 0;
  return typeRank + labelRank + sourceRank + (doc.confidence ?? 0);
}

function rockwellDocumentDescription(doc: DocumentRecord): string {
  if (doc.type === "datasheet") return "Technical Datasheet (EN)";
  if (doc.type === "manual") return "Manual (EN)";
  if (doc.type === "certificate") return "Certificate (EN)";
  return doc.label || "Document (EN)";
}

/**
 * Fill "Additional Documents" with localized product/document links per product.
 * Columns are located by header label since this is a repeating document table.
 */
export function writeDocumentsSheet(ws: ExcelJS.Worksheet, items: RunItemRecord[]): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  const cols = {
    article: findCol(descriptor.columns, (k) => k.includes("articlenumber") || k.includes("article number")),
    docId: findCol(descriptor.columns, (k) => k.includes("document id")),
    type: findCol(descriptor.columns, (k) => k.includes("document type")),
    path: findCol(descriptor.columns, (k) => k.includes("document path")),
    language: findCol(descriptor.columns, (k) => k === "document" || k.includes("document language")),
    description: findCol(
      descriptor.columns,
      (k) => k === "description" || (k.includes("description") && !k.includes("document type"))
    )
  };
  if (!cols.article || !cols.path) return 0;

  clearBody(ws, descriptor.firstBodyRow);
  let row = descriptor.firstBodyRow;
  let written = 0;
  const documentedItems = items
    .map((item) => ({ item, docs: documentRowsFor(item) }))
    .filter(({ docs }) => docs.length > 0);

  documentedItems.forEach(({ item, docs }, itemIndex) => {
    docs.forEach((doc, index) => {
      ws.getCell(row, cols.article!).value = item.catalogNumber;
      if (cols.docId) ws.getCell(row, cols.docId).value = index + 1;
      if (cols.type && doc.documentType) ws.getCell(row, cols.type).value = doc.documentType;
      ws.getCell(row, cols.path!).value = { text: doc.url, hyperlink: doc.url };
      if (cols.language) ws.getCell(row, cols.language).value = doc.language;
      if (cols.description) ws.getCell(row, cols.description).value = doc.description;
      row++;
      written++;
    });
    if (itemIndex < documentedItems.length - 1) row++;
  });

  removeTemplateLabelColumn(ws);
  return written;
}

function removeTemplateLabelColumn(ws: ExcelJS.Worksheet): void {
  const labels = ["classid", "priority", "type", "propertyid", "propertyname", "description"];
  const hasLabelColumn = labels.every((label, index) => {
    const value = ws.getCell(index + 1, 1).value;
    return typeof value === "string" && value.trim().toLowerCase() === label;
  });
  if (hasLabelColumn) ws.spliceColumns(1, 1);
}
