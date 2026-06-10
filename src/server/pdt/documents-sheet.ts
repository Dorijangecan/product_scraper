import type ExcelJS from "exceljs";
import type { RunItemRecord } from "../../shared/types.js";
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
  const ruleRows = localizedPdtDocumentUrlRules({
    manufacturerId: item.result?.manufacturerId,
    catalogNumber: item.catalogNumber
  }).map((rule) => rule.value);
  if (ruleRows.length > 0) return ruleRows;

  const localized = item.result?.localizedUrls;
  const en = localized?.en ?? item.result?.productUrl ?? item.productUrl;
  const de = localized?.de;
  const rows: DocRow[] = [];
  if (en) rows.push({ url: en, language: "english", description: "Datasheet(EN)" });
  if (de) rows.push({ url: de, language: "german", description: "Datenblatt" });
  return rows;
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
