import type ExcelJS from "exceljs";
import type { PdtCleanupAudit } from "./ai-cleanup.js";

export const AI_CLEANED_INPUT_SHEET = "AI Cleaned Input";

const COLUMNS = [
  { header: "Catalog number", key: "catalogNumber", width: 24 },
  { header: "Scraped title", key: "sourceTitle", width: 44 },
  { header: "Scraped catalog description", key: "sourceCatalogDescription", width: 56 },
  { header: "Scraped long description", key: "sourceLongDescription", width: 90 },
  { header: "Scraped ECLASS", key: "sourceEclass", width: 26 },
  { header: "Scraped control voltage", key: "sourceControlVoltage", width: 46 },
  { header: "Normalized voltage", key: "sourceNormalizedVoltage", width: 36 },
  { header: "Scraped AC-1 current", key: "sourceRatedCurrent", width: 46 },
  { header: "Normalized current", key: "sourceNormalizedCurrent", width: 36 },
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
  { header: "Voltage max", key: "voltageMax", width: 14 },
  { header: "Rated current", key: "ratedCurrent", width: 16 },
  { header: "Current max", key: "currentMax", width: 14 },
  { header: "Power loss/pole", key: "powerLossPerPole", width: 18 },
  { header: "Voltage type", key: "voltageType", width: 14 },
  { header: "Temp min", key: "operatingTemperatureMin", width: 12 },
  { header: "Temp max", key: "operatingTemperatureMax", width: 12 },
  { header: "Short description", key: "shortDescription", width: 48 },
  { header: "Long description", key: "longDescription", width: 90 },
  { header: "Notes", key: "notes", width: 72 }
] as const;

export function writeAiCleanedInputSheet(ws: ExcelJS.Worksheet, audit: PdtCleanupAudit): void {
  ws.columns = COLUMNS.map((column) => ({ key: column.key, width: column.width }));
  ws.views = [{ state: "frozen", ySplit: 11 }];
  ws.properties.tabColor = { argb: "FF0EA5E9" };

  ws.getCell("A1").value = "AI Cleaned Input";
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getCell("A1").alignment = { vertical: "middle" };

  const metaRows: Array<[string, string | number]> = [
    ["Purpose", "Human-reviewed preparation of scraped product data; final PDT generation does not consume Qwen suggestions."],
    ["Status", audit.status],
    ["Model", audit.model],
    ["Host", audit.host],
    ["Items", audit.itemCount],
    ["Qwen patches", audit.qwenPatchCount],
    ["Accepted fields", audit.acceptedFieldCount],
    ["Rejected fields", audit.rejectedFieldCount],
    ["Message", audit.message]
  ];
  for (const [index, values] of metaRows.entries()) {
    const row = ws.getRow(index + 2);
    row.values = values;
    row.getCell(1).font = { bold: true };
  }

  ws.getRow(11).values = COLUMNS.map((column) => column.header);
  ws.getRow(11).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(11).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  ws.getRow(11).alignment = { vertical: "middle", horizontal: "left", wrapText: true };

  let row = 12;
  for (const product of audit.products) {
    ws.getRow(row).values = [
      product.catalogNumber,
      product.sourceValues.title ?? null,
      product.sourceValues.catalogDescription ?? null,
      product.sourceValues.longDescription ?? null,
      product.sourceValues.eclass ?? null,
      product.sourceValues.ratedControlCircuitVoltage ?? null,
      product.sourceValues.normalizedVoltage ?? null,
      product.sourceValues.ratedOperationalCurrentAc1 ?? null,
      product.sourceValues.normalizedCurrent ?? null,
      product.sourceValues.powerLoss ?? null,
      product.sourceValues.operatingTemperature ?? null,
      product.sourceValues.ambientTemperature ?? null,
      product.sourceValues.temperatureRange ?? null,
      product.heuristicFields.join(", "),
      product.qwenFields.join(", "),
      product.acceptedFields.join(", "),
      product.rejectedFields.join(", "),
      product.finalValues.eclassCode ?? null,
      product.finalValues.eclassSystemVersion ?? null,
      product.finalValues.controlVoltage ?? null,
      product.finalValues.voltageMax ?? null,
      product.finalValues.ratedCurrent ?? null,
      product.finalValues.currentMax ?? null,
      product.finalValues.powerLossPerPole ?? null,
      product.finalValues.voltageType ?? null,
      product.finalValues.operatingTemperatureMin ?? null,
      product.finalValues.operatingTemperatureMax ?? null,
      product.finalValues.shortDescription ?? null,
      product.finalValues.longDescription ?? null,
      product.notes.join(" ")
    ];
    row += 1;
  }

  for (const column of [2, 3, 4, 6, 7, 8, 9, 26, 27, 28]) {
    ws.getColumn(column).alignment = { wrapText: true, vertical: "top" };
  }
  for (let rowNumber = 12; rowNumber < row; rowNumber += 1) {
    if (rowNumber % 2 === 0) {
      ws.getRow(rowNumber).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
    ws.getRow(rowNumber).alignment = { vertical: "top", wrapText: true };
  }
  ws.autoFilter = {
    from: { row: 11, column: 1 },
    to: { row: Math.max(11, row - 1), column: COLUMNS.length }
  };
}
