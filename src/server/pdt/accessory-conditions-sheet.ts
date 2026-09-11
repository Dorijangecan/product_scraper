import ExcelJS from "exceljs";
import type { AccessoryMatrixCondition } from "./accessory-matrix.js";

/**
 * "Accessory Conditions" — the third output of the operator's macro: one `INLIST('mp1,mp2,...', PN)`
 * expression per connection point. It is not part of the PDT itself; it belongs in the products
 * workbook (the "everything we extracted" file) where the operator picks it up later.
 *
 * Two entry points, because the matrix can arrive at two different times:
 *  - attached when the run starts → `excel.ts` writes the sheet while building the workbook;
 *  - attached at PDT export time → `patchAccessoryConditionsIntoWorkbookFile` adds it to the
 *    products workbook that already exists on disk.
 */
export const ACCESSORY_CONDITIONS_SHEET = "Accessory Conditions";

export function writeAccessoryConditionsSheet(
  workbook: ExcelJS.Workbook,
  conditions: AccessoryMatrixCondition[]
): number {
  const existing = workbook.getWorksheet(ACCESSORY_CONDITIONS_SHEET);
  if (existing) workbook.removeWorksheet(existing.id);
  const ws = workbook.addWorksheet(ACCESSORY_CONDITIONS_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Point", key: "point", width: 24 },
    { header: "Condition", key: "condition", width: 120 }
  ];
  ws.getRow(1).font = { bold: true };
  for (const condition of conditions) {
    ws.addRow({ point: condition.point, condition: condition.condition });
  }
  return conditions.length;
}

/**
 * Add (or replace) the sheet in an existing workbook file. Returns the row count on success.
 * Callers treat failure as a warning: the PDT itself is already written by then.
 */
export async function patchAccessoryConditionsIntoWorkbookFile(
  filePath: string,
  conditions: AccessoryMatrixCondition[]
): Promise<number> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const written = writeAccessoryConditionsSheet(workbook, conditions);
  await workbook.xlsx.writeFile(filePath);
  return written;
}
