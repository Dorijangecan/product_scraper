import ExcelJS from "exceljs";
import path from "node:path";
import { writeAiCleanedInputSheet } from "./ai-cleaned-input-sheet.js";
import type { PdtCleanupAudit } from "./ai-cleanup.js";

export function cleanedInputPathForPdt(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}_cleaned-input.xlsx`);
}

export async function writeCleanedInputWorkbook(outputPath: string, audit: PdtCleanupAudit): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Product Scraper";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.views = [{ x: 0, y: 0, width: 12000, height: 16000, firstSheet: 0, activeTab: 0, visibility: "visible" }];

  const sheet = workbook.addWorksheet("Cleaned PDT Input", { views: [{ state: "frozen", ySplit: 11 }] });
  writeAiCleanedInputSheet(sheet, audit, {
    title: "Cleaned PDT Input",
    purpose: "Import-ready cleaned scraped data used to populate the Master PDT workbook."
  });

  const cleanedPath = cleanedInputPathForPdt(outputPath);
  await workbook.xlsx.writeFile(cleanedPath);
  return cleanedPath;
}
