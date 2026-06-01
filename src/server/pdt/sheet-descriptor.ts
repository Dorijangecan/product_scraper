import type ExcelJS from "exceljs";

export interface PdtColumn {
  /** 1-based column index in the worksheet. */
  col: number;
  /** Value from the Priority row, e.g. "Must field" / "Optional field". */
  priority: string;
  /** Value from the PropertyId / "ECLASS property" row (e.g. "AAO677", "CNSORDERNO"). */
  code: string;
  /** Value from the "Variable name (CNS internal)" / PropertyName row. */
  propName: string;
  /** English description of the column, including any enum legend ("1 - AC 2 - DC"). */
  description: string;
  /** Value from the Unit row, when the PDT sheet declares a target unit. */
  unit: string;
}

export interface SheetDescriptor {
  propertyRow: number;
  propertyNameRow: number;
  firstBodyRow: number;
  columns: PdtColumn[];
}

/** Read any ExcelJS cell value down to a trimmed plain string. */
export function cellText(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const obj = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: string }>; hyperlink?: string };
    if (Array.isArray(obj.richText)) return obj.richText.map((part) => part.text ?? "").join("").trim();
    if (obj.text !== undefined && obj.text !== null) return String(obj.text).trim();
    if (obj.result !== undefined && obj.result !== null) return String(obj.result).trim();
    if (obj.hyperlink) return String(obj.hyperlink).trim();
  }
  return String(value).trim();
}

/**
 * Clear any existing body values (the template ships with sample data on some tabs) so freshly
 * written rows are not mixed with leftover example cells. The label column (A) is preserved.
 */
export function clearBody(ws: ExcelJS.Worksheet, firstBodyRow: number): void {
  const lastRow = ws.rowCount || 0;
  const lastCol = ws.columnCount || 0;
  for (let r = firstBodyRow; r <= lastRow; r++) {
    for (let c = 2; c <= lastCol; c++) {
      ws.getCell(r, c).value = null;
    }
  }
}

const PROPERTY_ID_LABELS = ["propertyid", "property id", "eclass property"];
const PROPERTY_NAME_LABELS = ["propertyname", "property name", "variable name (cns internal)", "variable name"];
const DESCRIPTION_LABELS = ["description", "english variable description"];
const UNIT_LABELS = ["unit", "units"];
const BODY_LABELS = ["body"];

/**
 * Detect a PDT tab's layout by reading the label column (A). PDT tabs are property-per-column:
 * a metadata header block describes each column (Priority / Type / PropertyId / PropertyName /
 * Description / Unit) and a "Body" region holds one row per product below it. Row positions vary
 * per tab, so we locate them dynamically instead of hard-coding cell references. Returns
 * `undefined` when the sheet does not look like a fillable PDT tab.
 */
export function describeSheet(ws: ExcelJS.Worksheet): SheetDescriptor | undefined {
  const scanRows = Math.min(ws.rowCount || 0, 16);
  let propertyRow = 0;
  let propertyNameRow = 0;
  let priorityRow = 0;
  let descriptionRow = 0;
  let unitRow = 0;
  let bodyRow = 0;
  for (let r = 1; r <= scanRows; r++) {
    const label = normalizeLabel(cellText(ws.getCell(r, 1).value));
    if (!label) continue;
    if (!priorityRow && label === "priority") priorityRow = r;
    else if (!propertyRow && PROPERTY_ID_LABELS.includes(label)) propertyRow = r;
    else if (!propertyNameRow && PROPERTY_NAME_LABELS.includes(label)) propertyNameRow = r;
    else if (!descriptionRow && DESCRIPTION_LABELS.includes(label)) descriptionRow = r;
    else if (!unitRow && UNIT_LABELS.includes(label)) unitRow = r;
    else if (!bodyRow && BODY_LABELS.includes(label)) bodyRow = r;
  }
  if (!propertyRow) return undefined;
  if (!propertyNameRow) propertyNameRow = propertyRow + 1;
  const firstBodyRow = bodyRow || (unitRow ? unitRow + 1 : propertyNameRow + 1);

  const columns: PdtColumn[] = [];
  const lastCol = ws.columnCount || 0;
  // Column A is the label column; data columns start at B.
  for (let c = 2; c <= lastCol; c++) {
    const code = cellText(ws.getCell(propertyRow, c).value);
    const propName = cellText(ws.getCell(propertyNameRow, c).value);
    if (!code && !propName) continue;
    const description = descriptionRow ? cellText(ws.getCell(descriptionRow, c).value) : "";
    const unit = unitRow ? cellText(ws.getCell(unitRow, c).value) : "";
    const priority = priorityRow ? cellText(ws.getCell(priorityRow, c).value) : "";
    if (isHeaderEchoColumn(code, propName, description, unit)) continue;
    columns.push({ col: c, priority, code, propName, description, unit });
  }
  return { propertyRow, propertyNameRow, firstBodyRow, columns };
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isHeaderEchoColumn(code: string, propName: string, description: string, unit: string): boolean {
  const labels = [code, propName, description, unit].map(normalizeLabel);
  return (
    PROPERTY_ID_LABELS.includes(labels[0]) &&
    PROPERTY_NAME_LABELS.includes(labels[1]) &&
    (DESCRIPTION_LABELS.includes(labels[2]) || !labels[2]) &&
    (UNIT_LABELS.includes(labels[3]) || !labels[3])
  );
}
