import ExcelJS from "exceljs";
import type { AttributeRecord, RunItemRecord } from "../../shared/types.js";
import { getManufacturerConfig } from "../config/manufacturers.js";
import type { AccessoryMatrixPlan } from "./accessory-matrix.js";
import { cellText, clearBody, describeSheet, firstDataRow, type PdtColumn, type SheetDescriptor } from "./sheet-descriptor.js";

interface AccessoryRow {
  parentCatalog: string;
  accessoryCatalog: string;
  relationType: string;
  /** Populated when the accessory's own RunItemRecord was loaded in this run. */
  accessoryItem?: RunItemRecord;
}

export interface CuratedAccessoryRule {
  name: string;
  manufacturerId: string;
  catalogPattern: RegExp;
  accessoryCatalog: string;
  rationale: string;
}

export const CURATED_ACCESSORY_RULES: CuratedAccessoryRule[] = [
  {
    name: "rockwell-852c-abvm-accessory",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*852C-/i,
    accessoryCatalog: "852C-ABVM",
    rationale: "Manual Rockwell PDT Product Accessory examples use the curated 852C-ABVM vertical mounting bracket for 852C LED indicator variants."
  },
  {
    name: "rockwell-852d-abvm-accessory",
    manufacturerId: "rockwell",
    catalogPattern: /^\s*852D-/i,
    accessoryCatalog: "852D-ABVM",
    rationale: "Manual Rockwell PDT Product Accessory examples use the curated 852D-ABVM vertical mounting bracket for 852D LED indicator variants."
  }
];

/**
 * Fill the Product Accessory tab.
 *
 * With an accessory matrix attached the matrix is the only source: it is operator-authored and
 * authoritative, so scraped and curated accessory rows are not mixed in (see the module docs of
 * `accessory-matrix.ts`). Without one, behaviour is unchanged.
 */
export function writeProductAccessorySheet(
  ws: ExcelJS.Worksheet,
  items: RunItemRecord[],
  matrix?: AccessoryMatrixPlan
): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  clearBody(ws, descriptor.firstBodyRow);

  if (matrix) {
    const written = writeMatrixAccessoryRows(ws, descriptor, matrix);
    removeTemplateLabelColumn(ws);
    return written;
  }

  const itemsByCatalog = new Map<string, RunItemRecord>();
  for (const item of items) {
    itemsByCatalog.set(item.catalogNumber.trim().toUpperCase(), item);
  }

  const rows = uniqueAccessoryRows(items.flatMap(accessoryRowsForItem)).map((row) => ({
    ...row,
    accessoryItem: itemsByCatalog.get(row.accessoryCatalog.trim().toUpperCase())
  }));
  let rowNumber = firstDataRow(descriptor);
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

interface MatrixAccessoryColumns {
  mainPart: number;
  point: number;
  accessory: number;
  relation: number;
  variant: number;
}

function writeMatrixAccessoryRows(
  ws: ExcelJS.Worksheet,
  descriptor: SheetDescriptor,
  matrix: AccessoryMatrixPlan
): number {
  const columns = resolveMatrixAccessoryColumns(descriptor);
  let rowNumber = firstDataRow(descriptor);
  let written = 0;
  for (const entry of matrix.accessoryRows) {
    if (entry.kind === "separator") {
      // Mirror the manual sheet: one blank row between main-part groups.
      rowNumber += 1;
      continue;
    }
    ws.getCell(rowNumber, columns.mainPart).value = entry.mainPart;
    ws.getCell(rowNumber, columns.point).value = entry.point;
    ws.getCell(rowNumber, columns.accessory).value = entry.accessory;
    ws.getCell(rowNumber, columns.relation).value = entry.relation;
    ws.getCell(rowNumber, columns.variant).value = entry.variantIndex;
    rowNumber += 1;
    written += 1;
  }
  return written;
}

/**
 * Locate the five matrix target columns by their PDT property ids rather than by position, so a
 * template that gains or loses a column keeps working. A missing column means the template no
 * longer matches this writer — fail loudly instead of writing the matrix into the wrong cells.
 */
function resolveMatrixAccessoryColumns(descriptor: SheetDescriptor): MatrixAccessoryColumns {
  const point = findColumn(descriptor, ["CNS_PARENT_CLS_ID_INST_ID", "00004D001"], /connection point name/);
  const accessory = findColumn(descriptor, ["AAO676", "000059001"], /articlenumber accessory/);
  const relation = findColumn(descriptor, ["AAN350", "000054001"], /part relation to the main device/);
  const variant = findColumn(descriptor, ["AAN553", "CNS_ASSOCIATED_PART_VARIANT_NAME"], /accessory variant name/);
  const mainPart =
    findColumn(descriptor, [], /^articlenumber main product/) ??
    descriptor.columns.find((column) => column.col === 2)?.col;

  const missing = Object.entries({ mainPart, point, accessory, relation, variant })
    .filter(([, col]) => !col)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `The PDT template's Product Accessory tab is missing the accessory matrix target column(s): ${missing.join(", ")}.`
    );
  }
  return { mainPart: mainPart!, point: point!, accessory: accessory!, relation: relation!, variant: variant! };
}

function findColumn(descriptor: SheetDescriptor, codes: string[], description: RegExp): number | undefined {
  const wanted = codes.map((code) => code.trim().toUpperCase());
  const matches = (column: PdtColumn): boolean => {
    const keys = [column.code, column.propName].map((key) => key.trim().toUpperCase());
    if (wanted.some((code) => keys.includes(code))) return true;
    return description.test(column.description.trim().toLowerCase());
  };
  return descriptor.columns.find(matches)?.col;
}

function accessoryRowsForItem(item: RunItemRecord): AccessoryRow[] {
  const result = item.result;
  if (!result) return [];
  const parentCatalog = item.catalogNumber;
  const rows: AccessoryRow[] = [];

  for (const accessoryCatalog of sourceBackedAccessoryCatalogs(result.attributes, parentCatalog)) {
    rows.push({ parentCatalog, accessoryCatalog, relationType: "accessory" });
  }

  const curatedRockwellAccessory = rockwell852Accessory(parentCatalog, result.manufacturerId);
  if (curatedRockwellAccessory) rows.push({ parentCatalog, accessoryCatalog: curatedRockwellAccessory, relationType: "accessory" });

  return rows;
}

function sourceBackedAccessoryCatalogs(attributes: AttributeRecord[], parentCatalog: string): string[] {
  const familyPrefix = parentCatalog.match(/^[A-Z0-9]+(?=-)/i)?.[0];
  if (!familyPrefix) return [];
  const familyPattern = new RegExp(`\\b${escapeRegExp(familyPrefix)}-[A-Z0-9]{3,}\\b`, "gi");
  const parentKey = parentCatalog.trim().toUpperCase();
  const catalogs: string[] = [];

  for (const attr of attributes) {
    if (!isAccessoryAttribute(attr)) continue;
    for (const match of attr.value.matchAll(familyPattern)) {
      const accessoryCatalog = match[0].toUpperCase();
      if (accessoryCatalog !== parentKey) catalogs.push(accessoryCatalog);
    }
  }

  return [...new Set(catalogs)];
}

function isAccessoryAttribute(attr: AttributeRecord): boolean {
  const label = `${attr.group ?? ""} ${attr.name}`;
  return /\b(accessor(?:y|ies)|related\s+(?:products?|items?)|recommended\s+(?:products?|items?)|optional\s+(?:products?|items?)|spare\s+parts?)\b/i.test(label);
}

function rockwell852Accessory(parentCatalog: string, manufacturerId: string | undefined): string | undefined {
  if (manufacturerId !== "rockwell") return undefined;
  const catalog = parentCatalog.trim().toUpperCase();
  return CURATED_ACCESSORY_RULES.find((rule) => rule.manufacturerId === manufacturerId && rule.catalogPattern.test(catalog))?.accessoryCatalog;
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

  if (
    keys.includes("AAO663") ||
    keys.includes("GTIN") ||
    keys.includes("EAN") ||
    /\b(gtin|ean)\b/.test(description)
  ) {
    return findAttribute(accessoryResult.attributes ?? [], /\b(ean|gtin)\b/i);
  }

  if (
    keys.includes("AAO677") ||
    keys.includes("MANUFACTURER") ||
    /\bmanufacturer\b/.test(description)
  ) {
    const manufacturerId = accessoryResult.manufacturerId;
    if (!manufacturerId) return undefined;
    return getManufacturerConfig(manufacturerId)?.canonicalName;
  }

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
