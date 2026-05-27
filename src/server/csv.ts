import { parse } from "csv-parse/sync";
import type ExcelJS from "exceljs";
import type { CsvPreview } from "../shared/types.js";

export async function previewCsv(buffer: Buffer): Promise<CsvPreview> {
  const { columns, rows } = await parseRows(buffer);
  const detectedColumn = detectCatalogColumn(columns, rows);
  const warnings: string[] = [];
  if (rows.length === 0) warnings.push("File has no data rows.");
  if (!detectedColumn) warnings.push("Could not confidently detect a catalog-number column.");
  return {
    columns,
    detectedColumn,
    rowCount: rows.length,
    previewRows: rows.slice(0, 10),
    warnings
  };
}

export async function extractCatalogNumbers(buffer: Buffer, columnName: string): Promise<string[]> {
  const { rows } = await parseRows(buffer);
  const seen = new Set<string>();
  const values: string[] = [];
  for (const row of rows) {
    const raw = String(row[columnName] ?? "").trim();
    if (!raw) continue;
    const normalized = raw.replace(/\s+/g, " ").trim();
    const key = normalized.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(normalized);
  }
  return values;
}

async function parseRows(buffer: Buffer): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  if (looksLikeXlsx(buffer)) return parseWorkbookRows(buffer);
  return parseTextRows(buffer);
}

function parseTextRows(buffer: Buffer): { columns: string[]; rows: Record<string, string>[] } {
  const text = buffer.toString("utf8");
  const records = parse(text, {
    bom: true,
    delimiter: [",", ";", "\t"],
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  }) as string[][];
  if (records.length === 0) return { columns: [], rows: [] };

  const firstRow = records[0].map((cell) => String(cell ?? "").trim());
  const hasHeader = looksLikeHeader(firstRow, records[1]);
  const columns = hasHeader
    ? firstRow.map((column, index) => column || `Column ${index + 1}`)
    : firstRow.length === 1
      ? ["Catalog Number"]
      : firstRow.map((_, index) => (index === 0 ? "Catalog Number" : `Column ${index + 1}`));
  const dataRows = hasHeader ? records.slice(1) : records;
  const rows = dataRows.map((record) => {
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = String(record[index] ?? "").trim();
    });
    return row;
  });
  return { columns, rows };
}

async function parseWorkbookRows(buffer: Buffer): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { columns: [], rows: [] };
  const matrix: string[][] = [];
  sheet.eachRow((row) => {
    const values: string[] = [];
    for (let index = 1; index <= row.cellCount; index += 1) {
      values.push(cellText(row.getCell(index).value));
    }
    if (values.some(Boolean)) matrix.push(trimTrailingEmpty(values));
  });
  if (matrix.length === 0) return { columns: [], rows: [] };

  const firstRow = matrix[0].map((cell) => cell.trim());
  const hasHeader = looksLikeHeader(firstRow, matrix[1]);
  const columns = hasHeader
    ? firstRow.map((column, index) => column || `Column ${index + 1}`)
    : firstRow.length === 1
      ? ["Catalog Number"]
      : firstRow.map((_, index) => (index === 0 ? "Catalog Number" : `Column ${index + 1}`));
  const dataRows = hasHeader ? matrix.slice(1) : matrix;
  const rows = dataRows.map((record) => {
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column] = String(record[index] ?? "").trim();
    });
    return row;
  });
  return { columns, rows };
}

function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("text" in value && value.text) return String(value.text);
    if ("result" in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
    if ("hyperlink" in value && value.hyperlink) return String(value.text ?? value.hyperlink);
  }
  return String(value);
}

function trimTrailingEmpty(values: string[]): string[] {
  let end = values.length;
  while (end > 0 && !values[end - 1].trim()) end -= 1;
  return values.slice(0, end);
}

function detectCatalogColumn(columns: string[], rows: Record<string, string>[]): string | undefined {
  if (columns.length === 0) return undefined;
  const preferred = columns.find((column) => /catalog|part|sku|item|katalo|sifra|šifra|broj|number/i.test(column));
  if (preferred) return preferred;

  let best: { column: string; score: number } | undefined;
  for (const column of columns) {
    const values = rows.slice(0, 50).map((row) => String(row[column] ?? "").trim()).filter(Boolean);
    if (values.length === 0) continue;
    const score = values.filter((value) => /[A-Z0-9][A-Z0-9._/-]{2,}/i.test(value) && /\d/.test(value)).length / values.length;
    if (!best || score > best.score) best = { column, score };
  }
  return best && best.score >= 0.6 ? best.column : columns[0];
}

function looksLikeHeader(firstRow: string[], secondRow?: string[]): boolean {
  if (firstRow.some((cell) => /catalog|part|sku|item|katalo|sifra|šifra|broj|number/i.test(cell))) {
    return true;
  }
  if (firstRow.length === 1 && looksLikeCatalogNumber(firstRow[0])) {
    return false;
  }
  if (secondRow && firstRow.length === secondRow.length) {
    const firstLooksData = firstRow.filter(looksLikeCatalogNumber).length;
    const secondLooksData = secondRow.filter(looksLikeCatalogNumber).length;
    if (secondLooksData > firstLooksData) return true;
  }
  return false;
}

function looksLikeCatalogNumber(value: string): boolean {
  const clean = value.trim();
  return /^[A-Z0-9][A-Z0-9._/-]{2,}$/i.test(clean) && /\d/.test(clean);
}
