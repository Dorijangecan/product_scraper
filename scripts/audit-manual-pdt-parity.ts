import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { cellText, describeSheet } from "../src/server/pdt/sheet-descriptor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manualRoot = path.join(rootDir, "primjeri PDTa");

interface WorkbookAudit {
  file: string;
  vendor: string;
  sheets: SheetAudit[];
  catalogNumbers: string[];
}

interface SheetAudit {
  name: string;
  nonEmptyCells: number;
  filledBodyCells: number;
  dataRows: number;
  articleNumbers: string[];
  sampleValues: string[];
}

const audits: WorkbookAudit[] = [];
for (const file of await listXlsx(manualRoot)) {
  audits.push(await auditWorkbook(file));
}

for (const audit of audits) {
  console.log(`\n${audit.vendor}\t${path.relative(rootDir, audit.file)}`);
  console.log(`catalogs (${audit.catalogNumbers.length}): ${audit.catalogNumbers.slice(0, 40).join(", ")}`);
  for (const sheet of audit.sheets.filter((item) => item.nonEmptyCells > 0)) {
    console.log(
      `  ${sheet.name}: rows=${sheet.dataRows} bodyCells=${sheet.filledBodyCells} cells=${sheet.nonEmptyCells} articles=${sheet.articleNumbers
        .slice(0, 12)
        .join(", ")} samples=${sheet.sampleValues.join(" | ")}`
    );
  }
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
  const sheets = workbook.worksheets.map(auditSheet);
  return {
    file,
    vendor: vendorFromPath(file),
    sheets,
    catalogNumbers: [...new Set((sheets.find((sheet) => sheet.name === "Material Master Data")?.articleNumbers ?? []).map(normalizeCatalogNumber))]
      .filter(isRealCatalogNumber)
      .sort()
  };
}

function auditSheet(ws: ExcelJS.Worksheet): SheetAudit {
  const descriptor = describeSheet(ws);
  const articleColumn = descriptor?.columns.find((column) => isArticleColumn(column.code, column.propName))?.col;
  let nonEmptyCells = 0;
  let filledBodyCells = 0;
  let dataRows = 0;
  const articleNumbers: string[] = [];
  const sampleValues: string[] = [];
  ws.eachRow((row) => {
    let rowHasData = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cellText(cell.value);
      if (!value) return;
      nonEmptyCells += 1;
      rowHasData = true;
      if (sampleValues.length < 80 && isUsefulSample(value)) sampleValues.push(value);
    });
    if (rowHasData) dataRows += 1;
  });
  if (descriptor) {
    dataRows = 0;
    for (let row = descriptor.firstBodyRow; row <= ws.rowCount; row += 1) {
      let bodyCellsInRow = 0;
      for (const column of descriptor.columns) {
        const value = cellText(ws.getCell(row, column.col).value);
        if (!value) continue;
        bodyCellsInRow += 1;
        filledBodyCells += 1;
      }
      const article = articleColumn ? normalizeCatalogNumber(cellText(ws.getCell(row, articleColumn).value)) : "";
      if (article && isRealCatalogNumber(article)) articleNumbers.push(article);
      if (bodyCellsInRow > 0) dataRows += 1;
    }
  }
  return {
    name: ws.name,
    nonEmptyCells,
    filledBodyCells,
    dataRows,
    articleNumbers: [...new Set(articleNumbers)],
    sampleValues: [...new Set(sampleValues)]
  };
}

function vendorFromPath(file: string): string {
  const relative = path.relative(manualRoot, file).toLowerCase();
  if (relative.includes("rockwel")) return "rockwell";
  if (relative.includes("eaton")) return "eaton";
  if (relative.includes("abb")) return "abb";
  return "unknown";
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isUsefulSample(value: string): boolean {
  if (value.length < 3 || value.length > 90) return false;
  if (/^(classid|priority|type|propertyid|propertyname|description|unit|body)$/i.test(value)) return false;
  return /[A-Z0-9][A-Z0-9_.:/ -]{2,}/.test(value);
}

function isArticleColumn(code: string, propName: string): boolean {
  return [code, propName].some((value) => value.trim().toUpperCase() === "AAO676");
}

function normalizeCatalogNumber(value: string): string {
  return clean(value).replace(/\.$/, "");
}

function isRealCatalogNumber(value: string): boolean {
  return (
    value.length >= 4 &&
    /[0-9]/.test(value) &&
    !/^(0000|ABA671|ABC244|AA[A-Z0-9]{3}|BA[A-Z0-9]{3}|CNS|IEC_|IE[1-4]$)/i.test(value)
  );
}
