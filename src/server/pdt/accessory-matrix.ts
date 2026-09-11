import ExcelJS from "exceljs";
import { cellText } from "./sheet-descriptor.js";

/**
 * Accessory matrix — an operator-authored workbook that says which accessory sits on which
 * mounting/connection point of which main product. It replaces the manual VBA macro
 * (`Skripte_V2.txt`) that used to build three staging sheets ("final", "conn point",
 * "Condition") which were then copy/pasted into the PDT by hand.
 *
 * Sheet layout (first worksheet of the workbook, name irrelevant):
 *
 * ```
 *  A            B            C            D          <- column
 *  MAIN         ACC          ACC          ACC        row 1: markers (ignored)
 *               <point 1>    <point 2>    <point 3>  row 2: connection/mounting point names
 *               <descr 1>    <descr 2>    <descr 3>  row 3: point descriptions
 *  <main part>  <accessory>  <accessory>             row 4+: one row per main part
 * ```
 *
 * Nothing about the sizes is fixed: the point columns are whatever row 2 names (the last named
 * column wins), and the rows are however many main parts column A lists. Empty cells simply mean
 * "no accessory on that point". Values are never rewritten, only copied.
 *
 * Everything here is deterministic — the plan is a pure function of the sheet. Values are copied
 * verbatim; nothing is inferred or guessed.
 */

export interface AccessoryMatrixPoint {
  /** Connection/mounting point name from row 2, e.g. "MP_B_2" — whatever the sheet calls it. */
  name: string;
  /** Point description from row 3 (may be empty). */
  description: string;
  /** 1-based worksheet column the point lives in. */
  column: number;
}

export interface AccessoryMatrixSource {
  points: AccessoryMatrixPoint[];
  /** One entry per data row, in sheet order. `accessories` is keyed by worksheet column. */
  rows: Array<{ mainPart: string; accessories: Map<number, string> }>;
  /** Observations made while reading the sheet, merged into the plan's warnings. */
  warnings?: string[];
}

/** A blank spacer row: the macro separates main-part groups with one empty row. */
export interface AccessoryMatrixSeparator {
  kind: "separator";
}

export interface AccessoryMatrixAccessoryEntry {
  kind: "accessory";
  mainPart: string;
  point: string;
  accessory: string;
  /** PDT "Part relation to the main device" — always 1 (= accessory), as in the macro. */
  relation: number;
  /** PDT "Accessory variant name / usage info" — the number after the point name's last "_". */
  variantIndex: number;
}

export interface AccessoryMatrixConnectionPointEntry {
  kind: "point";
  mainPart: string;
  point: string;
  description: string;
  /** "User supplementary point N", numbered per main part. */
  supplementaryLabel: string;
}

export interface AccessoryMatrixCondition {
  point: string;
  /** `INLIST('mp1,mp2,...', PN)` over every main part that uses the point. */
  condition: string;
}

export interface AccessoryMatrixPlan {
  points: AccessoryMatrixPoint[];
  mainParts: string[];
  accessoryRows: Array<AccessoryMatrixAccessoryEntry | AccessoryMatrixSeparator>;
  connectionPointRows: Array<AccessoryMatrixConnectionPointEntry | AccessoryMatrixSeparator>;
  conditions: AccessoryMatrixCondition[];
  /** Non-fatal observations (unnamed point columns, non-contiguous repeats of a main part). */
  warnings: string[];
}

const POINT_ROW = 2;
const DESCRIPTION_ROW = 3;
const FIRST_DATA_ROW = 4;

/** Read the workbook's first worksheet into a plan. Throws when it does not look like a matrix. */
export async function loadAccessoryMatrix(filePath: string): Promise<AccessoryMatrixPlan> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return planFromWorkbook(workbook);
}

/** Same as `loadAccessoryMatrix` for an in-memory upload that has not been stored yet. */
export async function parseAccessoryMatrixBuffer(buffer: Uint8Array): Promise<AccessoryMatrixPlan> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS types the parameter as the ambient `Buffer`; a Node Buffer/Uint8Array is what it reads.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return planFromWorkbook(workbook);
}

function planFromWorkbook(workbook: ExcelJS.Workbook): AccessoryMatrixPlan {
  const ws = workbook.worksheets[0];
  if (!ws) throw new Error("The accessory matrix workbook has no worksheets.");
  return buildAccessoryMatrixPlan(readAccessoryMatrixSheet(ws));
}

export function readAccessoryMatrixSheet(ws: ExcelJS.Worksheet): AccessoryMatrixSource {
  const lastColumn = lastNonEmptyColumn(ws, POINT_ROW);
  const lastRow = lastNonEmptyRowInFirstColumn(ws);

  const warnings: string[] = [];
  const points: AccessoryMatrixPoint[] = [];
  const unnamedColumns: number[] = [];
  for (let col = 2; col <= lastColumn; col++) {
    const name = cellText(ws.getCell(POINT_ROW, col).value);
    if (!name) {
      // A column with accessories but no point name cannot be written to the PDT (the point name
      // is a must-field). Skip it rather than emit a nameless connection point.
      if (columnHasAnyValue(ws, col, FIRST_DATA_ROW, lastRow)) unnamedColumns.push(col);
      continue;
    }
    points.push({ name, description: cellText(ws.getCell(DESCRIPTION_ROW, col).value), column: col });
  }
  if (unnamedColumns.length > 0) {
    warnings.push(
      `Skipped ${unnamedColumns.length} matrix column(s) that hold accessories but have no point name in row 2 (column${unnamedColumns.length > 1 ? "s" : ""} ${unnamedColumns.join(", ")}).`
    );
  }
  if (points.length === 0) {
    throw new Error(
      "The accessory matrix's first sheet has no connection point names in row 2. Expected row 2 = point names, row 3 = descriptions, main parts in column A from row 4."
    );
  }

  const rows: AccessoryMatrixSource["rows"] = [];
  for (let row = FIRST_DATA_ROW; row <= lastRow; row++) {
    const mainPart = cellText(ws.getCell(row, 1).value);
    if (!mainPart) continue; // the macro skips blank main-part rows
    const accessories = new Map<number, string>();
    for (const point of points) {
      const accessory = cellText(ws.getCell(row, point.column).value);
      if (accessory) accessories.set(point.column, accessory);
    }
    rows.push({ mainPart, accessories });
  }
  if (rows.length === 0) {
    throw new Error("The accessory matrix's first sheet has no main part numbers in column A from row 4 down.");
  }

  return { points, rows, warnings };
}

export function buildAccessoryMatrixPlan(source: AccessoryMatrixSource): AccessoryMatrixPlan {
  const { points, rows } = source;
  const warnings: string[] = [...(source.warnings ?? [])];

  const accessoryRows: Array<AccessoryMatrixAccessoryEntry | AccessoryMatrixSeparator> = [];
  const connectionPointRows: Array<AccessoryMatrixConnectionPointEntry | AccessoryMatrixSeparator> = [];
  const mainParts: string[] = [];
  const seenMainParts = new Set<string>();

  // Conditions: point -> ordered, de-duplicated list of the main parts that use it.
  const conditionParts = new Map<string, string[]>();

  let previousMainPart = "";
  // Per main-part group, as in the macro: the connection point sheet lists each point once and
  // numbers it "User supplementary point N", restarting for every main part.
  let groupPoints = new Set<string>();
  let supplementaryCount = 0;

  for (const row of rows) {
    const { mainPart } = row;
    if (mainPart !== previousMainPart) {
      if (previousMainPart) {
        accessoryRows.push({ kind: "separator" });
        connectionPointRows.push({ kind: "separator" });
      }
      groupPoints = new Set<string>();
      supplementaryCount = 0;
      if (seenMainParts.has(mainPart)) {
        warnings.push(
          `Main part "${mainPart}" appears in more than one block of rows; its supplementary point numbering restarts at each block.`
        );
      }
    }
    if (!seenMainParts.has(mainPart)) {
      seenMainParts.add(mainPart);
      mainParts.push(mainPart);
    }

    for (const point of points) {
      const accessory = row.accessories.get(point.column);
      if (!accessory) continue;

      accessoryRows.push({
        kind: "accessory",
        mainPart,
        point: point.name,
        accessory,
        relation: 1,
        variantIndex: pointVariantIndex(point.name)
      });

      const parts = conditionParts.get(point.name);
      if (!parts) conditionParts.set(point.name, [mainPart]);
      else if (!parts.includes(mainPart)) parts.push(mainPart);

      if (!groupPoints.has(point.name)) {
        groupPoints.add(point.name);
        supplementaryCount += 1;
        connectionPointRows.push({
          kind: "point",
          mainPart,
          point: point.name,
          description: point.description,
          supplementaryLabel: `User supplementary point ${supplementaryCount}`
        });
      }
    }

    previousMainPart = mainPart;
  }

  const conditions = [...conditionParts].map(([point, parts]) => ({
    point,
    condition: `INLIST('${parts.join(",")}', PN)`
  }));

  return { points, mainParts, accessoryRows, connectionPointRows, conditions, warnings };
}

/**
 * The number after the point name's last "_", else 1 — the macro's `PointSuffix`.
 * "MP_PS_3" → 3 · "MP_PS" → 1 · "MP_PS_fix" → 1.
 */
export function pointVariantIndex(pointName: string): number {
  const underscore = pointName.lastIndexOf("_");
  if (underscore < 0) return 1;
  const suffix = pointName.slice(underscore + 1).trim();
  if (!suffix || !/^[0-9]+$/.test(suffix)) return 1;
  const parsed = Number(suffix);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

/**
 * The matrix's main parts as catalog numbers to scrape — a matrix can stand in for the catalog
 * CSV. Normalized exactly like `extractCatalogNumbers` (collapsed whitespace, case-insensitive
 * de-duplication) so both inputs behave the same. The plan's own rows keep the verbatim spelling.
 */
export function accessoryMatrixCatalogNumbers(plan: AccessoryMatrixPlan): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const mainPart of plan.mainParts) {
    const normalized = mainPart.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(normalized);
  }
  return values;
}

/** Main parts referenced by the matrix that were not scraped in this run (likely typos). */
export function accessoryMatrixMainPartsNotInRun(plan: AccessoryMatrixPlan, runCatalogNumbers: string[]): string[] {
  const known = new Set(runCatalogNumbers.map((value) => value.trim().toUpperCase()));
  return plan.mainParts.filter((mainPart) => !known.has(mainPart.trim().toUpperCase()));
}

function columnHasAnyValue(ws: ExcelJS.Worksheet, col: number, firstRow: number, lastRow: number): boolean {
  for (let row = firstRow; row <= lastRow; row++) {
    if (cellText(ws.getCell(row, col).value)) return true;
  }
  return false;
}

function lastNonEmptyColumn(ws: ExcelJS.Worksheet, row: number): number {
  let last = 1;
  const limit = ws.columnCount || 0;
  for (let col = 1; col <= limit; col++) {
    if (cellText(ws.getCell(row, col).value)) last = col;
  }
  return last;
}

function lastNonEmptyRowInFirstColumn(ws: ExcelJS.Worksheet): number {
  let last = 0;
  const limit = ws.rowCount || 0;
  for (let row = 1; row <= limit; row++) {
    if (cellText(ws.getCell(row, 1).value)) last = row;
  }
  return last;
}
