import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import type { ManufacturerConfig, ManufacturerId } from "../src/shared/types.js";
import { initializeManufacturerConfig, getManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { RunManager } from "../src/server/run-manager.js";
import { exportRunPdt } from "../src/server/pdt/exporter.js";
import { resolveTemplatePath } from "../src/server/pdt/template.js";
import { cellText, describeSheet } from "../src/server/pdt/sheet-descriptor.js";
import { comparePdtValues, type PdtCellDiff, type PdtValueCell } from "../src/server/pdt/pdt-compare.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manualRoot = path.join(rootDir, "primjeri PDTa");
const appPaths = createAppPaths(rootDir);
const IGNORED_PARITY_SHEETS = new Set(["Connection Point Information"]);

interface ManualCase {
  vendor: ManufacturerId;
  file: string;
  catalogNumbers: string[];
  manualAudit: WorkbookAudit;
}

interface WorkbookAudit {
  file: string;
  sheets: SheetAudit[];
  catalogNumbers: string[];
}

interface SheetAudit {
  name: string;
  dataRows: number;
  filledBodyCells: number;
  articleNumbers: string[];
}

interface ParityReport {
  generatedAt: string;
  outputDir: string;
  cases: CaseReport[];
  summary: {
    cases: number;
    passed: number;
    failed: number;
    totalManualCatalogs: number;
    totalGeneratedCatalogs: number;
  };
}

interface CaseReport {
  vendor: ManufacturerId;
  manualFile: string;
  generatedFile?: string;
  runId: string;
  passed: boolean;
  manualCatalogs: number;
  generatedCatalogs: number;
  missingCatalogs: string[];
  failedCatalogs: string[];
  manualSheets: Record<string, number>;
  generatedSheets: Record<string, number>;
  sheetGaps: Array<{ sheet: string; manualCells: number; generatedCells: number }>;
  /** Value-level precision vs the human gold (workstream A). */
  valuePrecision: number;
  comparableCells: number;
  valueMismatches: number;
  manualOnlyCells: number;
  generatedOnlyCells: number;
  topDiffs: PdtCellDiff[];
}

const args = parseArgs(process.argv.slice(2));
initializeManufacturerConfig(appPaths.dataDir);
await fs.mkdir(appPaths.outputDir, { recursive: true });

const reuseRunIds = args.reuseReport ? await readReuseRunIds(args.reuseReport) : new Map<string, string>();
const selectedCases = (await discoverManualCases()).filter((manualCase) => {
  if (args.vendor && manualCase.vendor !== args.vendor) return false;
  if (args.file && !path.basename(manualCase.file).toLowerCase().includes(args.file.toLowerCase())) return false;
  if (args.reuseReport && !reuseRunIds.has(path.resolve(manualCase.file))) return false;
  return true;
});

if (selectedCases.length === 0) throw new Error("No manual PDT cases matched the requested filters.");

const limitedCases = args.maxCases ? selectedCases.slice(0, args.maxCases) : selectedCases;
const auditRoot = path.join(appPaths.outputDir, "_manual_pdt_parity", timestamp());
await fs.mkdir(auditRoot, { recursive: true });

const db = new ScraperDb(appPaths);
const runManager = new RunManager(db, appPaths);
const reports: CaseReport[] = [];

try {
  for (const manualCase of limitedCases) {
    reports.push(await runCase(manualCase, reuseRunIds.get(path.resolve(manualCase.file))));
  }
} finally {
  db.close();
}

const report: ParityReport = {
  generatedAt: new Date().toISOString(),
  outputDir: auditRoot,
  cases: reports,
  summary: {
    cases: reports.length,
    passed: reports.filter((item) => item.passed).length,
    failed: reports.filter((item) => !item.passed).length,
    totalManualCatalogs: reports.reduce((sum, item) => sum + item.manualCatalogs, 0),
    totalGeneratedCatalogs: reports.reduce((sum, item) => sum + item.generatedCatalogs, 0)
  }
};

const reportPath = path.join(auditRoot, "manual-pdt-parity-report.json");
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

console.log(`Manual PDT parity cases: ${report.summary.cases}`);
console.log(`Passed: ${report.summary.passed} | Failed: ${report.summary.failed}`);
console.log(`Manual catalogs: ${report.summary.totalManualCatalogs} | Generated catalogs: ${report.summary.totalGeneratedCatalogs}`);
console.log(`Report: ${reportPath}`);
for (const item of reports) {
  console.log(
    `${item.passed ? "PASS" : "FAIL"} ${item.vendor} ${path.basename(item.manualFile)} catalogs ${item.generatedCatalogs}/${item.manualCatalogs}` +
      ` precision ${(item.valuePrecision * 100).toFixed(0)}% (mismatch ${item.valueMismatches}/${item.comparableCells}, missed ${item.manualOnlyCells}, extra ${item.generatedOnlyCells})` +
      ` gaps ${item.sheetGaps.map((gap) => `${gap.sheet}:${gap.generatedCells}/${gap.manualCells}`).join(", ")}`
  );
}

if (report.summary.failed > 0) process.exitCode = 1;

async function runCase(manualCase: ManualCase, reuseRunId?: string): Promise<CaseReport> {
  const manufacturer = getManufacturerConfig(manualCase.vendor);
  if (!manufacturer) throw new Error(`Missing manufacturer config: ${manualCase.vendor}`);

  const runId = reuseRunId ?? `manual-pdt-${manualCase.vendor}-${safePart(path.basename(manualCase.file, ".xlsx"))}-${timestamp()}`;
  if (reuseRunId) {
    console.log(`\nRe-exporting ${manualCase.vendor} ${path.basename(manualCase.file)} from ${reuseRunId}`);
  } else {
    const run = db.createRun({
      id: runId,
      manufacturerId: manualCase.vendor,
      inputFileName: path.basename(manualCase.file),
      catalogNumbers: manualCase.catalogNumbers,
      options: { downloadDocuments: true, downloadImages: true, generateExcel: true, forceFinalRetry: args.forceFinalRetry }
    });
    console.log(`\nRunning ${manualCase.vendor} ${path.basename(manualCase.file)} (${manualCase.catalogNumbers.length} catalogs)`);
    await runManager.processRun(run.id);
  }

  const finalRun = db.getRun(runId);
  if (!finalRun) throw new Error(`Run not found: ${runId}`);
  const items = db.getRunItems(runId);
  const caseDir = path.join(auditRoot, manualCase.vendor, safePart(path.basename(manualCase.file, ".xlsx")));
  await fs.mkdir(caseDir, { recursive: true });
  const generatedFile = path.join(caseDir, `${runId}_PDT.xlsx`);
  await exportRunPdt({
    manufacturer,
    items,
    templatePath: resolveTemplatePath(),
    outputPath: generatedFile
  });
  const generatedAudit = await auditWorkbook(generatedFile);
  const failedCatalogs = items.filter((item) => item.status !== "found" && item.status !== "partial").map((item) => item.catalogNumber);
  const missingCatalogs = manualCase.catalogNumbers.filter((catalog) => !generatedAudit.catalogNumbers.includes(catalog));
  const manualSheets = sheetScoreMap(manualCase.manualAudit);
  const generatedSheets = sheetScoreMap(generatedAudit);
  const sheetGaps = Object.entries(manualSheets)
    .filter(([sheet]) => !IGNORED_PARITY_SHEETS.has(sheet))
    .filter(([, manualCells]) => manualCells > 0)
    .map(([sheet, manualCells]) => ({ sheet, manualCells, generatedCells: generatedSheets[sheet] ?? 0 }))
    .filter((gap) => gap.generatedCells < gap.manualCells);

  // Value-level precision: of cells both the human gold and our output filled, do they agree?
  const comparison = comparePdtValues(await collectValueCells(manualCase.file), await collectValueCells(generatedFile));

  return {
    vendor: manualCase.vendor,
    manualFile: manualCase.file,
    generatedFile,
    runId,
    passed: finalRun?.status === "completed" && failedCatalogs.length === 0 && missingCatalogs.length === 0 && sheetGaps.length === 0,
    manualCatalogs: manualCase.catalogNumbers.length,
    generatedCatalogs: generatedAudit.catalogNumbers.length,
    missingCatalogs,
    failedCatalogs,
    manualSheets,
    generatedSheets,
    sheetGaps,
    valuePrecision: comparison.precision,
    comparableCells: comparison.comparable,
    valueMismatches: comparison.mismatch,
    manualOnlyCells: comparison.manualOnly,
    generatedOnlyCells: comparison.generatedOnly,
    topDiffs: comparison.diffs.slice(0, 20)
  };
}

async function collectValueCells(file: string): Promise<PdtValueCell[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const cells: PdtValueCell[] = [];
  for (const ws of workbook.worksheets) {
    if (ws.name === "Help") continue;
    if (IGNORED_PARITY_SHEETS.has(ws.name)) continue;
    const descriptor = describeSheet(ws);
    if (!descriptor) continue;
    const articleColumn = descriptor.columns.find((column) =>
      [column.code, column.propName].some((value) => value.trim().toUpperCase() === "AAO676")
    )?.col;
    if (!articleColumn) continue;
    for (let row = descriptor.firstBodyRow; row <= ws.rowCount; row += 1) {
      const article = normalizeCatalogNumber(cellText(ws.getCell(row, articleColumn).value));
      if (!article || !isRealCatalogNumber(article)) continue;
      for (const column of descriptor.columns) {
        if (column.col === articleColumn) continue;
        const value = cellText(ws.getCell(row, column.col).value);
        if (!value) continue;
        cells.push({ article, sheet: ws.name, column: column.code || column.propName, value });
      }
    }
  }
  return cells;
}

async function discoverManualCases(): Promise<ManualCase[]> {
  const files = await listXlsx(manualRoot);
  const cases: ManualCase[] = [];
  for (const file of files) {
    const vendor = vendorFromPath(file);
    if (!vendor) continue;
    const manualAudit = await auditWorkbook(file);
    if (manualAudit.catalogNumbers.length === 0) continue;
    cases.push({ vendor, file, catalogNumbers: manualAudit.catalogNumbers, manualAudit });
  }
  return cases;
}

async function listXlsx(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listXlsx(fullPath)));
    else if (/\.xlsx$/i.test(entry.name) && !entry.name.startsWith("~$")) files.push(fullPath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function auditWorkbook(file: string): Promise<WorkbookAudit> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheets = workbook.worksheets.map(auditSheet).filter((sheet) => sheet.dataRows > 0 || sheet.filledBodyCells > 0);
  const material = sheets.find((sheet) => sheet.name === "Material Master Data");
  return {
    file,
    sheets,
    catalogNumbers: [...new Set(material?.articleNumbers ?? [])].sort()
  };
}

function auditSheet(ws: ExcelJS.Worksheet): SheetAudit {
  const descriptor = describeSheet(ws);
  if (!descriptor) return auditNonUniformSheet(ws);
  const articleColumn = descriptor.columns.find((column) => [column.code, column.propName].some((value) => value.trim().toUpperCase() === "AAO676"))?.col;
  let dataRows = 0;
  let filledBodyCells = 0;
  const articleNumbers: string[] = [];
  for (let row = descriptor.firstBodyRow; row <= ws.rowCount; row += 1) {
    let cellsInRow = 0;
    for (const column of descriptor.columns) {
      if (!cellText(ws.getCell(row, column.col).value)) continue;
      cellsInRow += 1;
      filledBodyCells += 1;
    }
    const article = articleColumn ? normalizeCatalogNumber(cellText(ws.getCell(row, articleColumn).value)) : "";
    if (article && isRealCatalogNumber(article)) articleNumbers.push(article);
    if (cellsInRow > 0) dataRows += 1;
  }
  return {
    name: ws.name,
    dataRows,
    filledBodyCells,
    articleNumbers: [...new Set(articleNumbers)]
  };
}

function auditNonUniformSheet(ws: ExcelJS.Worksheet): SheetAudit {
  let dataRows = 0;
  let filledBodyCells = 0;
  const articleNumbers: string[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 8) return;
    let cellsInRow = 0;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = normalizeCatalogNumber(cellText(cell.value));
      if (!value) return;
      cellsInRow += 1;
      if (isRealCatalogNumber(value)) articleNumbers.push(value);
    });
    if (cellsInRow > 0) {
      dataRows += 1;
      filledBodyCells += cellsInRow;
    }
  });
  return { name: ws.name, dataRows, filledBodyCells, articleNumbers: [...new Set(articleNumbers)] };
}

function sheetScoreMap(audit: WorkbookAudit): Record<string, number> {
  const entries: Array<[string, number]> = [];
  for (const sheet of audit.sheets) {
    if (sheet.name === "Help") continue;
    entries.push([sheet.name, sheet.filledBodyCells]);
  }
  return Object.fromEntries(entries);
}

function vendorFromPath(file: string): ManufacturerId | undefined {
  const relative = path.relative(manualRoot, file).toLowerCase();
  if (relative.includes("rockwel")) return "rockwell";
  if (relative.includes("eaton")) return "eaton";
  if (relative.includes("abb")) return "abb";
  if (relative.includes("saginaw")) return "sce";
  return undefined;
}

async function readReuseRunIds(reportPath: string): Promise<Map<string, string>> {
  const parsed = JSON.parse(await fs.readFile(path.resolve(reportPath), "utf8")) as ParityReport;
  return new Map(parsed.cases.map((item) => [path.resolve(item.manualFile), item.runId]));
}

function parseArgs(values: string[]): { vendor?: ManufacturerId; file?: string; maxCases?: number; reuseReport?: string; forceFinalRetry?: boolean } {
  const parsed: { vendor?: ManufacturerId; file?: string; maxCases?: number; reuseReport?: string; forceFinalRetry?: boolean } = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--vendor") parsed.vendor = values[++index] as ManufacturerId;
    else if (value === "--file") parsed.file = values[++index];
    else if (value === "--max-cases") parsed.maxCases = Number(values[++index]);
    else if (value === "--reuse-report") parsed.reuseReport = values[++index];
    else if (value === "--force-final-retry") parsed.forceFinalRetry = true;
  }
  return parsed;
}

function normalizeCatalogNumber(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\.$/, "");
}

function isRealCatalogNumber(value: string): boolean {
  return (
    value.length >= 4 &&
    /[0-9]/.test(value) &&
    !/^(0000|ABA671|ABC244|AA[A-Z0-9]{3}|BA[A-Z0-9]{3}|CNS|IEC_|IE[1-4]$)/i.test(value)
  );
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function safePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "case";
}
