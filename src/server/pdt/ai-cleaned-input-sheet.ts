import type ExcelJS from "exceljs";
import type { PdtCleanupAudit } from "./ai-cleanup.js";

export const AI_CLEANED_INPUT_SHEET = "AI Cleaned Input";

const COLUMNS = [
  { header: "Catalog number", key: "catalogNumber", width: 24 },
  { header: "Cleanup status", key: "cleanupStatus", width: 18 },
  { header: "Device type", key: "deviceType", width: 28 },
  { header: "Device type confidence", key: "deviceTypeConfidence", width: 18 },
  { header: "Score margin", key: "deviceTypeScoreMargin", width: 14 },
  { header: "Alternative #1", key: "deviceTypeAlternative1", width: 28 },
  { header: "Alternative #2", key: "deviceTypeAlternative2", width: 28 },
  { header: "Sanity warnings", key: "deviceTypeWarnings", width: 56 },
  { header: "Device tab(s)", key: "deviceTabs", width: 36 },
  { header: "Device type evidence", key: "deviceTypeEvidence", width: 42 },
  { header: "Review reason", key: "reviewReason", width: 54 },
  { header: "Missing cleaned fields", key: "missingCleanFields", width: 42 },
  { header: "PDT unit values", key: "pdtUnitValues", width: 58 },
  { header: "Cleanup source", key: "cleanupSource", width: 28 },
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

export function writeAiCleanedInputSheet(
  ws: ExcelJS.Worksheet,
  audit: PdtCleanupAudit,
  options: { title?: string; purpose?: string } = {}
): void {
  ws.columns = COLUMNS.map((column) => ({ key: column.key, width: column.width }));
  ws.properties.tabColor = { argb: "FF0EA5E9" };
  const reviewRows = audit.products.map((product) => {
    const missingCleanFields = missingPdtCleanFields(product);
    const reviewReason = reviewReasonFor(product, missingCleanFields);
    return {
      product,
      missingCleanFields,
      cleanupStatus: reviewReason === "OK" ? "Ready" as const : "Review" as const,
      reviewReason
    };
  });
  const metaRows = buildMetaRows(
    audit,
    reviewRows,
    options.purpose ?? "Human-reviewed preparation of scraped product data before Master PDT import."
  );
  const headerRow = metaRows.length + 2;
  const firstDataRow = headerRow + 1;
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: headerRow }];

  ws.getCell("A1").value = options.title ?? "AI Cleaned Input";
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getCell("A1").alignment = { vertical: "middle" };

  for (const [index, values] of metaRows.entries()) {
    const row = ws.getRow(index + 2);
    row.values = values;
    row.getCell(1).font = { bold: true };
  }

  ws.getRow(headerRow).values = COLUMNS.map((column) => column.header);
  ws.getRow(headerRow).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(headerRow).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  ws.getRow(headerRow).alignment = { vertical: "middle", horizontal: "left", wrapText: true };

  let row = firstDataRow;
  for (const { product, cleanupStatus, reviewReason, missingCleanFields } of reviewRows) {
    const alternatives = product.deviceTypeAlternatives ?? [];
    const formatAlternative = (entry?: { type: string; score: number; channels: string[] }) =>
      entry ? `${entry.type} (${entry.score}; ${entry.channels.join("+")})` : null;
    ws.getRow(row).values = [
      product.catalogNumber,
      cleanupStatus,
      product.deviceType ?? "(unclassified)",
      product.deviceTypeConfidence !== undefined ? Number(product.deviceTypeConfidence.toFixed(2)) : null,
      product.deviceTypeScoreMargin ?? null,
      formatAlternative(alternatives[0]),
      formatAlternative(alternatives[1]),
      product.deviceTypeWarnings?.join(" | ") ?? null,
      product.deviceTabs.join(", "),
      product.deviceTypeEvidence ?? null,
      reviewReason,
      missingCleanFields.join(", "),
      pdtUnitValueSummary(product),
      cleanupSourceFor(product),
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

  for (const column of wrapColumnIndexes()) {
    ws.getColumn(column).alignment = { wrapText: true, vertical: "top" };
  }
  for (let rowNumber = firstDataRow; rowNumber < row; rowNumber += 1) {
    if (rowNumber % 2 === 0) {
      ws.getRow(rowNumber).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
    const status = String(ws.getRow(rowNumber).getCell(2).value ?? "");
    if (status === "Review") {
      ws.getRow(rowNumber).getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE68A" } };
    } else if (status === "Ready") {
      ws.getRow(rowNumber).getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBBF7D0" } };
    }
    ws.getRow(rowNumber).alignment = { vertical: "top", wrapText: true };
  }
  ws.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: Math.max(headerRow, row - 1), column: COLUMNS.length }
  };
}

function buildMetaRows(
  audit: PdtCleanupAudit,
  rows: Array<{ cleanupStatus: "Ready" | "Review" }>,
  purpose: string
): Array<[string, string | number]> {
  return [
    ["Purpose", purpose],
    ["Status", audit.status],
    ["Model", audit.model],
    ["Host", audit.host],
    ["Items", audit.itemCount],
    ["Ready rows", rows.filter((row) => row.cleanupStatus === "Ready").length],
    ["Review rows", rows.filter((row) => row.cleanupStatus === "Review").length],
    ["Qwen patches", audit.qwenPatchCount],
    ["Accepted fields", audit.acceptedFieldCount],
    ["Rejected fields", audit.rejectedFieldCount],
    ["Message", audit.message]
  ];
}

function reviewReasonFor(product: PdtCleanupAudit["products"][number], missingCleanFields: string[]): string {
  const reasons: string[] = [];
  if (!product.deviceType) {
    reasons.push("Device type unclassified — falls back to constant tabs only.");
  } else if ((product.deviceTypeConfidence ?? 0) < 0.78) {
    const pct = ((product.deviceTypeConfidence ?? 0) * 100).toFixed(0);
    reasons.push(`Low classification confidence (${pct}%) for "${product.deviceType}" — verify before import.`);
  } else if (product.deviceTabs.length === 0) {
    reasons.push(`No Master PDT device tab maps to "${product.deviceType}" — only constant tabs will be filled.`);
  }
  // Small score margin between winner and runner-up means the classifier was unsure even though
  // its absolute score may have been high — surface so reviewers can confirm.
  if (product.deviceType && (product.deviceTypeScoreMargin ?? 0) < 200 && product.deviceTypeAlternatives && product.deviceTypeAlternatives.length > 0) {
    reasons.push(
      `Tight call: "${product.deviceType}" only ${product.deviceTypeScoreMargin} ahead of "${product.deviceTypeAlternatives[0].type}".`
    );
  }
  if (product.deviceTypeWarnings && product.deviceTypeWarnings.length > 0) {
    reasons.push(...product.deviceTypeWarnings);
  }
  const missingRequired = missingCleanFields.filter((field) => ["shortDescription", "longDescription"].includes(field));
  if (missingRequired.length > 0) reasons.push(`Missing required text: ${missingRequired.join(", ")}`);
  if (missingCleanFields.length > missingRequired.length) {
    reasons.push(`Missing optional/derived fields: ${missingCleanFields.filter((field) => !missingRequired.includes(field)).join(", ")}`);
  }
  if (product.rejectedFields.length > 0) reasons.push(`Rejected AI fields: ${product.rejectedFields.join(", ")}`);
  reasons.push(...product.notes.filter((note) => /left blank|missing|not found/i.test(note)));
  return reasons.length > 0 ? reasons.join(" | ") : "OK";
}

function missingPdtCleanFields(product: PdtCleanupAudit["products"][number]): string[] {
  const fields = [
    "eclassCode",
    "eclassSystemVersion",
    "voltageMax",
    "currentMax",
    "shortDescription",
    "longDescription"
  ] as const;
  return fields.filter((field) => product.finalValues[field] === undefined || product.finalValues[field] === "");
}

function pdtUnitValueSummary(product: PdtCleanupAudit["products"][number]): string {
  const values = [
    product.finalValues.voltageMax ? `voltageMax=${product.finalValues.voltageMax} V` : undefined,
    product.finalValues.ratedCurrent ? `ratedCurrent=${product.finalValues.ratedCurrent} A` : undefined,
    product.finalValues.currentMax ? `currentMax=${product.finalValues.currentMax} A` : undefined,
    product.finalValues.powerLossPerPole ? `powerLossPerPole=${product.finalValues.powerLossPerPole} W` : undefined,
    product.finalValues.operatingTemperatureMin || product.finalValues.operatingTemperatureMax
      ? `temperature=${product.finalValues.operatingTemperatureMin ?? "?"}..${product.finalValues.operatingTemperatureMax ?? "?"} C`
      : undefined
  ].filter((value): value is string => Boolean(value));
  return values.join("; ");
}

function cleanupSourceFor(product: PdtCleanupAudit["products"][number]): string {
  if (product.acceptedFields.length > 0) return "Deterministic + AI accepted";
  if (product.qwenFields.length > 0) return "Deterministic + AI reviewed";
  return "Deterministic";
}

function wrapColumnIndexes(): number[] {
  const keys = new Set([
    "reviewReason",
    "missingCleanFields",
    "pdtUnitValues",
    "cleanupSource",
    "sourceTitle",
    "sourceCatalogDescription",
    "sourceLongDescription",
    "sourceControlVoltage",
    "sourceNormalizedVoltage",
    "sourceRatedCurrent",
    "sourceNormalizedCurrent",
    "operatingTemperatureMin",
    "operatingTemperatureMax",
    "shortDescription",
    "longDescription",
    "notes"
  ]);
  return COLUMNS.flatMap((column, index) => (keys.has(column.key) ? [index + 1] : []));
}
