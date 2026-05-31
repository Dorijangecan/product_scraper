import ExcelJS from "exceljs";
import type { RunItemRecord } from "../../shared/types.js";
import { cellText, clearBody, describeSheet } from "./sheet-descriptor.js";

interface AccessoryRow {
  parentCatalog: string;
  accessoryCatalog: string;
  relationType: string;
}

export function writeProductAccessorySheet(ws: ExcelJS.Worksheet, items: RunItemRecord[]): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  clearBody(ws, descriptor.firstBodyRow);

  const rows = uniqueAccessoryRows(items.flatMap(accessoryRowsForItem));
  let rowNumber = descriptor.firstBodyRow;
  for (const row of rows) {
    for (const column of descriptor.columns) {
      const value = valueForColumn(column, row);
      if (value) ws.getCell(rowNumber, column.col).value = value;
    }
    rowNumber += 1;
  }
  removeTemplateLabelColumn(ws);
  return rows.length;
}

function accessoryRowsForItem(item: RunItemRecord): AccessoryRow[] {
  const result = item.result;
  if (!result) return [];
  const parentCatalog = item.catalogNumber;
  const familyPrefix = parentCatalog.match(/^[A-Z0-9]+(?=-)/i)?.[0];
  const rows: AccessoryRow[] = [];
  const evidence = [result.title, result.description, ...result.attributes.flatMap((attr) => [attr.name, attr.value])].filter(Boolean).join("\n");

  if (familyPrefix) {
    const familyPattern = new RegExp(`\\b${escapeRegExp(familyPrefix)}-[A-Z0-9]{3,}\\b`, "gi");
    for (const match of evidence.matchAll(familyPattern)) {
      const accessoryCatalog = match[0].toUpperCase();
      if (accessoryCatalog !== parentCatalog.toUpperCase()) rows.push({ parentCatalog, accessoryCatalog, relationType: "accessory" });
    }
  }

  // Rockwell 852C/852D light indicators publish "AVM = Vertical bracket" in the public
  // technical-data PDF, while the PDT accessory article is encoded as <family>-ABVM.
  if (familyPrefix && /\b852[CD]\b/i.test(familyPrefix) && /\bvertical mounting brackets?\b|\bAVM\b.*\bvertical bracket\b/i.test(evidence)) {
    rows.push({ parentCatalog, accessoryCatalog: `${familyPrefix.toUpperCase()}-ABVM`, relationType: "accessory" });
  }

  return rows;
}

function valueForColumn(column: { col: number; code: string; propName: string }, row: AccessoryRow): string | undefined {
  const keys = [column.code, column.propName].map((key) => key.trim().toUpperCase());
  if (keys.includes("AAO676") || keys.includes("000059001")) return row.accessoryCatalog;
  if (keys.includes("AAN350") || keys.includes("000054001")) return row.relationType;
  if (column.col === 2 || keys.includes("CNS_PARENT_CLS_ID_INST_ID")) return row.parentCatalog;
  return undefined;
}

function uniqueAccessoryRows(rows: AccessoryRow[]): AccessoryRow[] {
  const seen = new Set<string>();
  const unique: AccessoryRow[] = [];
  for (const row of rows) {
    const key = `${row.parentCatalog}\t${row.accessoryCatalog}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function removeTemplateLabelColumn(ws: ExcelJS.Worksheet): void {
  const labels = ["classid", "descr", "prio", "cnsattr", "text", "data type", "body"];
  const values = labels.map((_, index) => cellText(ws.getCell(index + 1, 1).value).trim().toLowerCase());
  if (labels.every((label, index) => values[index] === label)) ws.spliceColumns(1, 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
