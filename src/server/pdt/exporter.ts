import ExcelJS from "exceljs";
import type { ManufacturerConfig, RunItemRecord } from "../../shared/types.js";
import { classifyDeviceType } from "../scrapers/device-type.js";
import { loadTemplateWorkbook } from "./template.js";
import { clearBody, describeSheet } from "./sheet-descriptor.js";
import { CONSTANT_SHEETS, targetSheets } from "./device-sheet-map.js";
import { resolveProperty, type ResolveContext } from "./eclass-resolvers.js";
import { writeDocumentsSheet } from "./documents-sheet.js";
import { encodeEnum, isEnumColumn } from "./enum-encode.js";
import { buildPdtRepairResult, type PdtCleanupAudit, type PdtRepair } from "./ai-cleanup.js";

const DOCUMENTS_SHEET = "Additional Documents";
/** Always kept even when empty (the manual PDT keeps this tab as a placeholder). */
const ALWAYS_KEPT_SHEETS = ["Connection Point Information"];

export interface PdtExportResult {
  outputPath: string;
  productCount: number;
  documentRows: number;
  filledSheets: Record<string, number>;
  missingSheets: string[];
  unmappedDeviceTypes: string[];
  /** Tabs retained in the final workbook (unused template tabs are removed). */
  keptSheets: string[];
  removedSheetCount: number;
  cleanup: PdtCleanupSummary;
  cleanedInputPath: string;
}

export type PdtCleanupSummary = Omit<PdtCleanupAudit, "products"> & { productRows: number };

export async function exportRunPdt(input: {
  manufacturer: ManufacturerConfig;
  items: RunItemRecord[];
  templatePath: string;
  outputPath: string;
}): Promise<PdtExportResult> {
  const { manufacturer, items, templatePath, outputPath } = input;
  const workbook = await loadTemplateWorkbook(templatePath);

  const included = items.filter((item) => item.result && (item.status === "found" || item.status === "partial"));
  const cleanup = await buildPdtRepairResult(included, manufacturer);
  const repairs = cleanup.repairs;

  // Uniform (property-per-column) tabs map to the ordered products written into each tab.
  const sheetItems = new Map<string, RunItemRecord[]>();
  const missingSheets = new Set<string>();
  const unmappedDeviceTypes = new Set<string>();

  for (const item of included) {
    const deviceType = classifyDeviceType(item.result).type;
    const sheets = targetSheets(deviceType);
    // Only constant tabs were chosen and no device tab matched → note for diagnostics.
    if (deviceType && sheets.length === CONSTANT_SHEETS.length) unmappedDeviceTypes.add(deviceType);
    for (const sheetName of sheets) {
      if (sheetName === DOCUMENTS_SHEET) continue; // handled separately below
      if (!sheetItems.has(sheetName)) sheetItems.set(sheetName, []);
      sheetItems.get(sheetName)!.push(item);
    }
  }

  const filledSheets: Record<string, number> = {};
  for (const [sheetName, sheetMembers] of sheetItems) {
    const ws = workbook.getWorksheet(sheetName);
    if (!ws) {
      missingSheets.add(sheetName);
      continue;
    }
    filledSheets[sheetName] = writeUniformSheet(ws, sheetMembers, manufacturer, repairs);
  }

  const documentsWs = workbook.getWorksheet(DOCUMENTS_SHEET);
  let documentRows = 0;
  if (documentsWs) {
    documentRows = writeDocumentsSheet(documentsWs, included);
    filledSheets[DOCUMENTS_SHEET] = documentRows;
  } else {
    missingSheets.add(DOCUMENTS_SHEET);
  }

  // Mirror the manual PDT: keep only the tabs actually in use (Material Master Data + the used
  // device tabs, both in `sheetItems`) plus Additional Documents and the always-kept placeholders.
  // Drop every other template tab so the workbook isn't cluttered with 50+ unused classifications.
  const keep = new Set<string>([...sheetItems.keys(), DOCUMENTS_SHEET, ...ALWAYS_KEPT_SHEETS]);
  const removedSheets: string[] = [];
  for (const ws of [...workbook.worksheets]) {
    if (!keep.has(ws.name)) {
      removedSheets.push(ws.name);
      workbook.removeWorksheet(ws.id);
    }
  }
  const cleanedInputPath = await writeAiCleanedInputWorkbook(cleanup.audit, outputPath);

  await workbook.xlsx.writeFile(outputPath);

  return {
    outputPath,
    productCount: included.length,
    documentRows,
    filledSheets,
    missingSheets: [...missingSheets],
    unmappedDeviceTypes: [...unmappedDeviceTypes],
    keptSheets: workbook.worksheets.map((ws) => ws.name),
    removedSheetCount: removedSheets.length,
    cleanup: cleanupSummary(cleanup.audit),
    cleanedInputPath
  };
}

function cleanupSummary(audit: PdtCleanupAudit): PdtCleanupSummary {
  const { products, ...summary } = audit;
  return { ...summary, productRows: products.length };
}

async function writeAiCleanedInputWorkbook(audit: PdtCleanupAudit, pdtOutputPath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Product Scraper";
  workbook.created = new Date();
  workbook.modified = new Date();
  const ws = workbook.addWorksheet("AI Cleaned Input", { views: [{ state: "frozen", ySplit: 11 }] });
  ws.columns = [
    { header: "Catalog number", key: "catalogNumber", width: 24 },
    { header: "Scraped title", key: "sourceTitle", width: 44 },
    { header: "Scraped catalog description", key: "sourceCatalogDescription", width: 56 },
    { header: "Scraped long description", key: "sourceLongDescription", width: 90 },
    { header: "Scraped ECLASS", key: "sourceEclass", width: 26 },
    { header: "Scraped control voltage", key: "sourceControlVoltage", width: 46 },
    { header: "Scraped AC-1 current", key: "sourceRatedCurrent", width: 46 },
    { header: "Scraped power loss", key: "sourcePowerLoss", width: 46 },
    { header: "Scraped operating temp", key: "sourceOperatingTemp", width: 32 },
    { header: "Scraped ambient temp", key: "sourceAmbientTemp", width: 32 },
    { header: "Scraped temp range", key: "sourceTempRange", width: 32 },
    { header: "Heuristic fields", key: "heuristicFields", width: 42 },
    { header: "Qwen fields", key: "qwenFields", width: 42 },
    { header: "Accepted fields", key: "acceptedFields", width: 42 },
    { header: "Rejected fields", key: "rejectedFields", width: 42 },
    { header: "ECLASS code", key: "eclassCode", width: 16 },
    { header: "ECLASS version", key: "eclassSystemVersion", width: 16 },
    { header: "Control voltage", key: "controlVoltage", width: 18 },
    { header: "Rated current", key: "ratedCurrent", width: 16 },
    { header: "Power loss/pole", key: "powerLossPerPole", width: 18 },
    { header: "Voltage type", key: "voltageType", width: 14 },
    { header: "Temp min", key: "operatingTemperatureMin", width: 12 },
    { header: "Temp max", key: "operatingTemperatureMax", width: 12 },
    { header: "Short description", key: "shortDescription", width: 48 },
    { header: "Long description", key: "longDescription", width: 90 },
    { header: "Notes", key: "notes", width: 72 }
  ];
  ws.spliceRows(1, 0, ["PDT AI Cleaned Input"]);
  ws.spliceRows(2, 0, ["Status", audit.status]);
  ws.spliceRows(3, 0, ["Model", audit.model]);
  ws.spliceRows(4, 0, ["Host", audit.host]);
  ws.spliceRows(5, 0, ["Items", audit.itemCount]);
  ws.spliceRows(6, 0, ["Qwen patches", audit.qwenPatchCount]);
  ws.spliceRows(7, 0, ["Accepted fields", audit.acceptedFieldCount]);
  ws.spliceRows(8, 0, ["Rejected fields", audit.rejectedFieldCount]);
  ws.spliceRows(9, 0, ["Message", audit.message]);
  ws.spliceRows(10, 0, []);
  ws.getRow(11).values = [
    "Catalog number",
    "Scraped title",
    "Scraped catalog description",
    "Scraped long description",
    "Scraped ECLASS",
    "Scraped control voltage",
    "Scraped AC-1 current",
    "Scraped power loss",
    "Scraped operating temp",
    "Scraped ambient temp",
    "Scraped temp range",
    "Heuristic fields",
    "Qwen fields",
    "Accepted fields",
    "Rejected fields",
    "ECLASS code",
    "ECLASS version",
    "Control voltage",
    "Rated current",
    "Power loss/pole",
    "Voltage type",
    "Temp min",
    "Temp max",
    "Short description",
    "Long description",
    "Notes"
  ];
  ws.getRow(1).font = { bold: true, size: 14 };
  for (let row = 2; row <= 9; row++) ws.getCell(row, 1).font = { bold: true };
  ws.getRow(11).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 11 }];
  let row = 12;
  for (const product of audit.products) {
    ws.getCell(row, 1).value = product.catalogNumber;
    ws.getCell(row, 2).value = product.sourceValues.title ?? null;
    ws.getCell(row, 3).value = product.sourceValues.catalogDescription ?? null;
    ws.getCell(row, 4).value = product.sourceValues.longDescription ?? null;
    ws.getCell(row, 5).value = product.sourceValues.eclass ?? null;
    ws.getCell(row, 6).value = product.sourceValues.ratedControlCircuitVoltage ?? null;
    ws.getCell(row, 7).value = product.sourceValues.ratedOperationalCurrentAc1 ?? null;
    ws.getCell(row, 8).value = product.sourceValues.powerLoss ?? null;
    ws.getCell(row, 9).value = product.sourceValues.operatingTemperature ?? null;
    ws.getCell(row, 10).value = product.sourceValues.ambientTemperature ?? null;
    ws.getCell(row, 11).value = product.sourceValues.temperatureRange ?? null;
    ws.getCell(row, 12).value = product.heuristicFields.join(", ");
    ws.getCell(row, 13).value = product.qwenFields.join(", ");
    ws.getCell(row, 14).value = product.acceptedFields.join(", ");
    ws.getCell(row, 15).value = product.rejectedFields.join(", ");
    ws.getCell(row, 16).value = product.finalValues.eclassCode ?? null;
    ws.getCell(row, 17).value = product.finalValues.eclassSystemVersion ?? null;
    ws.getCell(row, 18).value = product.finalValues.controlVoltage ?? null;
    ws.getCell(row, 19).value = product.finalValues.ratedCurrent ?? null;
    ws.getCell(row, 20).value = product.finalValues.powerLossPerPole ?? null;
    ws.getCell(row, 21).value = product.finalValues.voltageType ?? null;
    ws.getCell(row, 22).value = product.finalValues.operatingTemperatureMin ?? null;
    ws.getCell(row, 23).value = product.finalValues.operatingTemperatureMax ?? null;
    ws.getCell(row, 24).value = product.finalValues.shortDescription ?? null;
    ws.getCell(row, 25).value = product.finalValues.longDescription ?? null;
    ws.getCell(row, 26).value = product.notes.join(" ");
    row++;
  }
  for (const column of [3, 4, 6, 7, 8, 24, 25, 26]) ws.getColumn(column).alignment = { wrapText: true, vertical: "top" };
  const outputPath = pdtOutputPath.replace(/_PDT(?:_[^\\/]+)?\.xlsx$/i, "_AI_cleaned_input.xlsx");
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

/** Write one body row per product, placing each resolvable value in its property column. */
function writeUniformSheet(
  ws: ExcelJS.Worksheet,
  items: RunItemRecord[],
  manufacturer: ManufacturerConfig,
  repairs: Map<number, PdtRepair>
): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  clearBody(ws, descriptor.firstBodyRow);
  let row = descriptor.firstBodyRow;
  let written = 0;
  for (const item of items) {
    const ctx: ResolveContext = {
      result: item.result,
      item,
      manufacturer,
      deviceType: classifyDeviceType(item.result).type,
      sheetName: ws.name,
      repair: repairs.get(item.id)
    };
    let wroteCell = false;
    for (const column of descriptor.columns) {
      if (!shouldWriteColumn(ws.name, column)) continue;
      const value = resolveProperty(column.code, column.propName, ctx);
      if (value === undefined || value === "") continue;
      // Enum-coded columns expect a code (1/2/3). Encode the raw value via the column legend; if
      // it can't be encoded, leave the cell blank rather than writing an invalid free-text value.
      if (shouldEncodeEnum(ws.name, column) && isEnumColumn(column.description)) {
        const code = encodeEnum(column.description, value);
        if (code === undefined) continue;
        ws.getCell(row, column.col).value = code;
      } else {
        ws.getCell(row, column.col).value = cellValueFor(column, value);
      }
      wroteCell = true;
    }
    if (wroteCell) {
      written++;
      row++;
    }
  }
  removeTemplateLabelColumn(ws);
  return written;
}

function cellValueFor(column: { code: string; propName: string }, value: string): ExcelJS.CellValue {
  if (isProductUrlColumn(column) && /^https?:\/\//i.test(value)) return { text: value, hyperlink: value };
  if (!isTextColumn(column) && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function isProductUrlColumn(column: { code: string; propName: string }): boolean {
  const keys = [column.code, column.propName].map((key) => key.trim().toUpperCase());
  return keys.includes("AAQ326") || keys.includes("AAY811");
}

function isTextColumn(column: { code: string; propName: string }): boolean {
  const keys = [column.code, column.propName].map((key) => key.trim().toUpperCase());
  return keys.some((key) =>
    [
      "AAO676",
      "CNSORDERNO",
      "CNSTYPECODE",
      "AAV774",
      "AAQ326",
      "AAY811",
      "AAO677",
      "MANUFACTURER_URL",
      "AAO663",
      "CNS_EAN",
      "AAN743",
      "CNS_CTN",
      "AAD931",
      "CERTIFICATION",
      "CNS_DESCRIPTION_LONG",
      "CNS_DESCRIPTION_SHORT"
    ].includes(key)
  );
}

function shouldEncodeEnum(sheetName: string, column: { code: string; propName: string }): boolean {
  const keys = [column.code, column.propName].map((key) => key.trim().toUpperCase());
  return !(sheetName === "contactor a. fuses" && keys.includes("BAD915"));
}

function shouldWriteColumn(sheetName: string, column: { code: string; propName: string }): boolean {
  if (sheetName !== "contactor a. fuses") return true;
  const keys = [column.code, column.propName].flatMap((key) => key.trim().toUpperCase().split("/"));
  return keys.some((key) =>
    [
      "REFERENCE_FEATURE_GROUP_ID",
      "REFERENCE_FEATURE_SYSTEM_NAME",
      "AAO676",
      "BAH005",
      "AAS575",
      "AAF726",
      "BAD915",
      "AAC820",
      "AAC821"
    ].includes(key.trim())
  );
}

function removeTemplateLabelColumn(ws: ExcelJS.Worksheet): void {
  const labels = ["classid", "priority", "type", "propertyid", "propertyname", "description", "unit", "body"];
  const hasLabelColumn = labels.every((label, index) => {
    const value = ws.getCell(index + 1, 1).value;
    return typeof value === "string" && value.trim().toLowerCase() === label;
  });
  if (hasLabelColumn) ws.spliceColumns(1, 1);
}
