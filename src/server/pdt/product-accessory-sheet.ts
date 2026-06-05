import ExcelJS from "exceljs";
import type { AttributeRecord, RunItemRecord } from "../../shared/types.js";
import { getManufacturerConfig } from "../config/manufacturers.js";
import { cellText, clearBody, describeSheet } from "./sheet-descriptor.js";

interface AccessoryRow {
  parentCatalog: string;
  accessoryCatalog: string;
  relationType: string;
  /** Populated when the accessory's own RunItemRecord was loaded in this run. */
  accessoryItem?: RunItemRecord;
}

export function writeProductAccessorySheet(ws: ExcelJS.Worksheet, items: RunItemRecord[]): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  clearBody(ws, descriptor.firstBodyRow);

  const itemsByCatalog = new Map<string, RunItemRecord>();
  for (const item of items) {
    itemsByCatalog.set(item.catalogNumber.trim().toUpperCase(), item);
  }

  const rows = uniqueAccessoryRows(items.flatMap(accessoryRowsForItem)).map((row) => ({
    ...row,
    accessoryItem: itemsByCatalog.get(row.accessoryCatalog.trim().toUpperCase())
  }));
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

  // Rockwell product pages list many family siblings (every 5069-*, 1756-*, etc.) on every page
  // via cross-sell widgets — matching the family prefix produces dozens of false accessories per
  // product. Manual Rockwell PDTs leave the Product Accessory tab empty for all 10 reference cases,
  // so we skip the loose family-prefix heuristic for Rockwell and only emit specifically curated
  // accessories (e.g. the 852C/852D ABVM bracket below).
  const skipFamilyPrefixHeuristic = result.manufacturerId === "rockwell";

  if (familyPrefix && !skipFamilyPrefixHeuristic) {
    const familyPattern = new RegExp(`\\b${escapeRegExp(familyPrefix)}-[A-Z0-9]{3,}\\b`, "gi");
    for (const match of evidence.matchAll(familyPattern)) {
      const accessoryCatalog = match[0].toUpperCase();
      if (accessoryCatalog !== parentCatalog.toUpperCase()) rows.push({ parentCatalog, accessoryCatalog, relationType: "accessory" });
    }
  }

  return rows;
}

function valueForColumn(
  column: { col: number; code: string; propName: string; description?: string },
  row: AccessoryRow
): string | undefined {
  const keys = [column.code, column.propName].map((key) => key.trim().toUpperCase());
  const description = (column.description ?? "").trim().toLowerCase();
  if (keys.includes("AAO676") || keys.includes("000059001")) return row.accessoryCatalog;
  if (keys.includes("AAN350") || keys.includes("000054001")) return row.relationType;
  if (column.col === 2 || keys.includes("CNS_PARENT_CLS_ID_INST_ID")) return row.parentCatalog;

  // Accessory-specific lookups: GTIN/EAN, manufacturer name, designation come from the
  // accessory's own scraped RunItemRecord. If the accessory wasn't loaded in this run we leave
  // the cell blank rather than guess.
  const accessoryResult = row.accessoryItem?.result;
  if (!accessoryResult) return undefined;

  // GTIN / EAN: column code AAO676 already matched above; look for dedicated GTIN columns.
  if (
    keys.includes("AAO663") ||
    keys.includes("GTIN") ||
    keys.includes("EAN") ||
    /\b(gtin|ean)\b/.test(description)
  ) {
    return findAttribute(accessoryResult.attributes ?? [], /\b(ean|gtin)\b/i);
  }

  // Manufacturer name: PDT AAO677, or column described as "manufacturer".
  if (
    keys.includes("AAO677") ||
    keys.includes("MANUFACTURER") ||
    /\bmanufacturer\b/.test(description)
  ) {
    const manufacturerId = accessoryResult.manufacturerId;
    if (!manufacturerId) return undefined;
    return getManufacturerConfig(manufacturerId)?.canonicalName;
  }

  // Designation: PDT AAW338 / "designation".
  if (
    keys.includes("AAW338") ||
    keys.includes("DESIGNATION") ||
    /\bdesignation\b/.test(description)
  ) {
    const title = accessoryResult.title?.trim();
    return title || undefined;
  }

  return undefined;
}

function findAttribute(attributes: AttributeRecord[], pattern: RegExp): string | undefined {
  for (const attr of attributes) {
    if (pattern.test(`${attr.group ?? ""} ${attr.name}`) && attr.value?.trim()) {
      return attr.value.trim();
    }
  }
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
