import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Bundled default PDT template, committed to the repo. */
export const DEFAULT_PDT_TEMPLATE = path.resolve(__dirname, "../../../templates/master_pdt.xlsx");

/**
 * Pick which Master PDT template to use. An explicit override path wins when it points at an
 * existing file; otherwise fall back to the bundled default. Throws if neither is available so
 * the caller can surface a clear error instead of producing an empty workbook.
 */
export function resolveTemplatePath(override?: string): string {
  const candidate = override?.trim();
  if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  if (fs.existsSync(DEFAULT_PDT_TEMPLATE)) return DEFAULT_PDT_TEMPLATE;
  throw new Error(`PDT template not found (override: ${candidate ?? "none"}, default: ${DEFAULT_PDT_TEMPLATE}).`);
}

export async function loadTemplateWorkbook(templatePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  return workbook;
}
