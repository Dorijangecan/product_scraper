import type ExcelJS from "exceljs";
import type { RunItemRecord } from "../../shared/types.js";
import { clearBody, describeSheet, type PdtColumn } from "./sheet-descriptor.js";

function findCol(columns: PdtColumn[], match: (key: string) => boolean): number | undefined {
  const hit = columns.find((c) => match(c.code.toLowerCase()) || match(c.propName.toLowerCase()));
  return hit?.col;
}

interface DocRow {
  url: string;
  language: string;
  description: string;
}

function abbDocumentUrl(catalogNumber: string, language: "en" | "de"): string {
  // Match the manual PDT format: bare catalog number, no "ABB" prefix.
  const bare = catalogNumber.replace(/^ABB/i, "");
  const encoded = encodeURIComponent(bare);
  return language === "de" ? `https://new.abb.com/products/de/${encoded}` : `https://new.abb.com/products/${encoded}`;
}

function eatonDocumentUrl(catalogNumber: string, language: "en" | "de"): string {
  // Manual Eaton PDTs use SKU pages with an "EP-" prefix on the catalog number.
  // EN uses the gb/en-gb locale (international English), DE uses de/de-de.
  const withPrefix = /^EP-/i.test(catalogNumber) ? catalogNumber : `EP-${catalogNumber}`;
  const encoded = encodeURIComponent(withPrefix);
  return language === "de"
    ? `https://www.eaton.com/de/de-de/skuPage.${encoded}.html`
    : `https://www.eaton.com/gb/en-gb/skuPage.${encoded}.html`;
}

function sagDocumentUrl(catalogNumber: string): string {
  return `https://www.saginawcontrol.com/partnumber_info/?n=${encodeURIComponent(catalogNumber)}`;
}

/**
 * Localized product links per product: English first, then German when the manufacturer publishes
 * a German page. Manufacturers with no localized DE site (e.g. Saginaw) get only the EN row.
 * Intentionally does NOT include extra datasheets or "Product page" rows — the manual PDT keeps
 * exactly the two language links and nothing else.
 */
function documentRowsFor(item: RunItemRecord): DocRow[] {
  if (item.result?.manufacturerId === "abb") {
    // ABB exposes a deterministic DE mirror (/products/de/...) for every catalog number.
    return [
      { url: abbDocumentUrl(item.catalogNumber, "en"), language: "english", description: "Datasheet(EN)" },
      { url: abbDocumentUrl(item.catalogNumber, "de"), language: "german", description: "Datenblatt" }
    ];
  }
  if (item.result?.manufacturerId === "eaton") {
    return [
      { url: eatonDocumentUrl(item.catalogNumber, "en"), language: "english", description: "Datasheet(EN)" },
      { url: eatonDocumentUrl(item.catalogNumber, "de"), language: "german", description: "Datenblatt" }
    ];
  }
  if (item.result?.manufacturerId === "sce") {
    // Saginaw publishes a single English partnumber_info page — match the manual PDT (EN only).
    return [
      { url: sagDocumentUrl(item.catalogNumber), language: "english", description: "Datasheet(EN)" }
    ];
  }

  const localized = item.result?.localizedUrls;
  const en = localized?.en ?? item.result?.productUrl ?? item.productUrl;
  const de = localized?.de;
  const rows: DocRow[] = [];
  if (en) rows.push({ url: en, language: "english", description: "Datasheet(EN)" });
  if (de) rows.push({ url: de, language: "german", description: "Datenblatt" });
  return rows;
}

/**
 * Fill "Additional Documents" to mirror the manual PDT: exactly the localized product links per
 * product — one English row and one German row — with Document ID, language and description set.
 * Columns are located by header label since this is a repeating document table.
 */
export function writeDocumentsSheet(ws: ExcelJS.Worksheet, items: RunItemRecord[]): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  const cols = {
    article: findCol(descriptor.columns, (k) => k.includes("articlenumber") || k.includes("article number")),
    docId: findCol(descriptor.columns, (k) => k.includes("document id")),
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
