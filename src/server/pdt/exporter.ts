import ExcelJS from "exceljs";
import type { AttributeRecord, ManufacturerConfig, RunItemRecord } from "../../shared/types.js";
import { classifyDeviceType } from "../scrapers/device-type.js";
import { loadTemplateWorkbook } from "./template.js";
import { cellText, clearBody, describeSheet, type PdtColumn } from "./sheet-descriptor.js";
import { CONSTANT_SHEETS, targetSheets } from "./device-sheet-map.js";
import { resolveProperty, type ResolveContext } from "./eclass-resolvers.js";
import { writeDocumentsSheet } from "./documents-sheet.js";
import { encodeEnumLabel, isEnumColumn } from "./enum-encode.js";
import { buildPdtRepairResult, type PdtCleanupAudit, type PdtRepair } from "./ai-cleanup.js";
import { writeCleanedInputWorkbook } from "./cleaned-input-workbook.js";
import { normalizePdtCellNumber } from "./unit-cleanup.js";
import { writeConnectionPointsSheet } from "./connection-points-sheet.js";
import { writeProductAccessorySheet } from "./product-accessory-sheet.js";

const DOCUMENTS_SHEET = "Additional Documents";
/** Always kept even when empty (the manual PDT keeps this tab as a placeholder). */
const ALWAYS_KEPT_SHEETS = ["Connection Point Information", "Product Accessory"];

export interface PdtExportResult {
  outputPath: string;
  productCount: number;
  documentRows: number;
  filledSheets: Record<string, number>;
  missingSheets: string[];
  unmappedDeviceTypes: string[];
  unclassifiedCatalogNumbers: string[];
  writeIssues: PdtWriteIssue[];
  /** Tabs retained in the final workbook (unused template tabs are removed). */
  keptSheets: string[];
  removedSheetCount: number;
  cleanup: PdtCleanupSummary;
  cleanedInputPath?: string;
}

export interface PdtWriteIssue {
  sheetName: string;
  catalogNumber: string;
  code: string;
  propName: string;
  description: string;
  value: string;
  reason: "enum-unmatched";
}

export type PdtCleanupSummary = Omit<PdtCleanupAudit, "products"> & { productRows: number };

export async function exportRunPdt(input: {
  manufacturer: ManufacturerConfig;
  items: RunItemRecord[];
  templatePath: string;
  outputPath: string;
  aiCleanup?: boolean;
}): Promise<PdtExportResult> {
  const { manufacturer, items, templatePath, outputPath } = input;
  const workbook = await loadTemplateWorkbook(templatePath);

  const included = items.filter((item) => item.result && (item.status === "found" || item.status === "partial"));
  const cleanup = await buildPdtRepairResult(included, manufacturer, { aiCleanup: input.aiCleanup === true });
  const repairs = cleanup.repairs;
  const cleanedInputPath = await writeCleanedInputWorkbook(outputPath, cleanup.audit);

  // Pre-index every sheet by a canonical (case- and whitespace-insensitive) name so template
  // casing tweaks ("Switch" vs "switch", "PLC" vs "Plc") never silently drop products.
  const sheetIndex = buildSheetIndex(workbook);
  const resolveSheetName = (name: string): string | undefined =>
    sheetIndex.get(canonicalSheetKey(name))?.name;

  // Uniform (property-per-column) tabs map to the ordered products written into each tab.
  const sheetItems = new Map<string, RunItemRecord[]>();
  const missingSheets = new Set<string>();
  const unmappedDeviceTypes = new Set<string>();
  const unclassifiedCatalogNumbers = new Set<string>();
  const writeIssues: PdtWriteIssue[] = [];

  for (const item of included) {
    const deviceType = classifyDeviceType(item.result).type;
    if (!deviceType) unclassifiedCatalogNumbers.add(item.catalogNumber);
    const sheets = [...targetSheets(deviceType), ...additionalDeviceSheetsForItem(item, manufacturer)];
    // Only constant tabs were chosen and no device tab matched → note for diagnostics.
    if (deviceType && sheets.length === CONSTANT_SHEETS.length) unmappedDeviceTypes.add(deviceType);
    for (const sheetName of sheets) {
      if (canonicalSheetKey(sheetName) === canonicalSheetKey(DOCUMENTS_SHEET)) continue; // handled separately below
      const resolved = resolveSheetName(sheetName);
      if (!resolved) {
        missingSheets.add(sheetName);
        continue;
      }
      if (!sheetItems.has(resolved)) sheetItems.set(resolved, []);
      sheetItems.get(resolved)!.push(item);
    }
  }

  const filledSheets: Record<string, number> = {};
  for (const [sheetName, sheetMembers] of sheetItems) {
    const ws = workbook.getWorksheet(sheetName);
    if (!ws) {
      missingSheets.add(sheetName);
      continue;
    }
    filledSheets[sheetName] = writeUniformSheet(ws, sheetMembers, manufacturer, repairs, writeIssues);
  }

  const documentsWs = workbook.getWorksheet(resolveSheetName(DOCUMENTS_SHEET) ?? DOCUMENTS_SHEET);
  let documentRows = 0;
  if (documentsWs) {
    documentRows = writeDocumentsSheet(documentsWs, included);
    filledSheets[documentsWs.name] = documentRows;
  } else {
    missingSheets.add(DOCUMENTS_SHEET);
  }

  const connectionPointWs = workbook.getWorksheet(resolveSheetName("Connection Point Information") ?? "Connection Point Information");
  if (connectionPointWs) {
    const connectionRows = writeConnectionPointsSheet(connectionPointWs, included);
    if (connectionRows > 0) filledSheets[connectionPointWs.name] = connectionRows;
  }

  const productAccessoryWs = workbook.getWorksheet(resolveSheetName("Product Accessory") ?? "Product Accessory");
  if (productAccessoryWs) {
    const accessoryRows = writeProductAccessorySheet(productAccessoryWs, included);
    if (accessoryRows > 0) filledSheets[productAccessoryWs.name] = accessoryRows;
  }

  // Mirror the manual PDT: keep only the tabs actually in use (Material Master Data + the used
  // device tabs, both in `sheetItems`) plus Additional Documents and the always-kept placeholders.
  // Drop every other template tab so the workbook isn't cluttered with 50+ unused classifications.
  const keepKeys = new Set<string>(
    [...sheetItems.keys(), DOCUMENTS_SHEET, ...ALWAYS_KEPT_SHEETS].map(canonicalSheetKey)
  );
  const removedSheets: string[] = [];
  for (const ws of [...workbook.worksheets]) {
    if (!keepKeys.has(canonicalSheetKey(ws.name))) {
      removedSheets.push(ws.name);
      workbook.removeWorksheet(ws.id);
    }
  }
  await workbook.xlsx.writeFile(outputPath);

  return {
    outputPath,
    productCount: included.length,
    documentRows,
    filledSheets,
    missingSheets: [...missingSheets],
    unmappedDeviceTypes: [...unmappedDeviceTypes],
    unclassifiedCatalogNumbers: [...unclassifiedCatalogNumbers],
    writeIssues,
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

/** Normalise a sheet name for tolerant lookup ("Switch" / "switch" / " SWITCH " → "switch"). */
function canonicalSheetKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function buildSheetIndex(workbook: ExcelJS.Workbook): Map<string, ExcelJS.Worksheet> {
  const index = new Map<string, ExcelJS.Worksheet>();
  for (const ws of workbook.worksheets) {
    const key = canonicalSheetKey(ws.name);
    if (!index.has(key)) index.set(key, ws);
  }
  return index;
}

/** Write one body row per product, placing each resolvable value in its property column. */
function writeUniformSheet(
  ws: ExcelJS.Worksheet,
  items: RunItemRecord[],
  manufacturer: ManufacturerConfig,
  repairs: Map<number, PdtRepair>,
  writeIssues: PdtWriteIssue[]
): number {
  const descriptor = describeSheet(ws);
  if (!descriptor) return 0;
  clearBody(ws, descriptor.firstBodyRow);
  let row = descriptor.firstBodyRow;
  let written = 0;
  for (const item of items) {
    const baseCtx: ResolveContext = {
      result: item.result,
      item,
      manufacturer,
      deviceType: classifyDeviceType(item.result).type,
      sheetName: ws.name,
      repair: repairs.get(item.id)
    };
    for (const rowVariant of uniformRowVariantsFor(ws.name, item, baseCtx)) {
      const ctx: ResolveContext = { ...baseCtx, rowVariant };
      let wroteCell = false;
      for (const column of descriptor.columns) {
        const value = resolvePdtColumnValue(ws, descriptor, column, ctx);
        if (value === undefined || value === "") continue;
        // Enum-coded columns: write the legend's canonical label (e.g. "Ring cable connection")
        // rather than its numeric code, so a human reviewer can spot bad mappings at a glance.
        // Leave the cell blank when the value doesn't strictly match any legend option.
        if (shouldEncodeEnum(ws.name, column, value) && isEnumColumn(column.description)) {
          const label = encodeEnumLabel(column.description, value);
          if (label === undefined) {
            writeIssues.push({
              sheetName: ws.name,
              catalogNumber: item.catalogNumber,
              code: column.code,
              propName: column.propName,
              description: column.description,
              value,
              reason: "enum-unmatched"
            });
            continue;
          }
          ws.getCell(row, column.col).value = label;
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
  }
  removeTemplateLabelColumn(ws);
  return written;
}

function additionalDeviceSheetsForItem(item: RunItemRecord, manufacturer: ManufacturerConfig): string[] {
  if (manufacturer.id === "abb" && /^1SDA/i.test(item.catalogNumber)) return ["contactor a. fuses"];
  return [];
}

function uniformRowVariantsFor(sheetName: string, item: RunItemRecord, ctx: ResolveContext): Array<Record<string, string> | undefined> {
  if (item.result?.manufacturerId !== "eaton" || canonicalSheetKey(sheetName) !== "cabinet.mechanical") return [undefined];
  const model = (eatonModelCode(item.result) ?? resolveProperty("CNSTYPECODE", "CNSTYPECODE", ctx) ?? "").toUpperCase();
  if (/^PSN-FP-.+MU\b/.test(model)) {
    return [1, 2, 3, 4].map((index) => ({
      AAO676: item.catalogNumber,
      CNS_PROJECT_PATH: `psn_fp_mu_p${index}.prj`,
      CNS_COMPONENT_GROUP: "Plate@1"
    }));
  }
  if (/^PSN-FPS\b/.test(model)) {
    return [1, 2, 3, 4].map((index) => ({
      AAO676: `EP-${item.catalogNumber.replace(/^EP-/i, "")}`,
      CNS_PROJECT_PATH: index === 4 ? "psn_fps_asmtab.prj" : `psn_fps_p${index}.prj`,
      CNS_COMPONENT_FUNCTION_3D: "Bracket",
      CNS_COMPONENT_GROUP: "Bracket@1",
      "000038001": "Assembly.VariantParts"
    }));
  }
  return [undefined];
}

function eatonModelCode(result: RunItemRecord["result"]): string | undefined {
  return cleanString(
    result?.attributes.find((attribute) => /\b(model code|modellcode)\b/i.test(`${attribute.group ?? ""} ${attribute.name}`) && attribute.value.trim())
      ?.value
  );
}

function cellValueFor(column: { code: string; propName: string; unit?: string }, value: string): ExcelJS.CellValue {
  if (isProductUrlColumn(column) && /^https?:\/\//i.test(value)) return { text: value, hyperlink: value };
  if (!isTextColumn(column)) {
    const normalized = normalizePdtCellNumber(value, column.unit);
    if (normalized !== undefined && normalized !== "") return Number(normalized);
  }
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
      "CNS_DESCRIPTION_SHORT",
      "AAW338",
      "AAY812",
      "AAU731",
      "AAU732",
      "AAU733",
      "AAU734",
      "ABA671",
      "AAC314",
      "00001C001",
      "AAC341",
      "IEC_81346_2_SUBCLASS_CODE",
      "ABC244",
      "IEC_81346_2_SUBCLASS_CODE_3",
      "AAO336",
      "CNS_MOUNTING_ORIENTATION"
    ].includes(key)
  );
}

function shouldEncodeEnum(sheetName: string, column: { code: string; propName: string; description: string }, value: string): boolean {
  const keys = [column.code, column.propName].map((key) => key.trim().toUpperCase());
  if (sheetName === "contactor a. fuses" && keys.includes("BAD915")) return false;
  if (sheetName === "contactor a. fuses" && /\bvoltage type\b|\bcurrent type\b/i.test(column.description) && /^AC\s*\/\s*DC$/i.test(value.trim())) {
    return false;
  }
  return true;
}

function resolvePdtColumnValue(
  ws: ExcelJS.Worksheet,
  descriptor: { firstBodyRow: number },
  column: PdtColumn,
  ctx: ResolveContext
): string | undefined {
  const variant = rowVariantValue(column, ctx);
  if (variant !== undefined) return variant;
  const direct =
    resolveProperty(column.code, column.propName, ctx) ??
    resolvePropertyByDescription(column, ctx) ??
    resolvePropertyByColumnMetadata(column, ctx);
  if (!direct) return undefined;
  if (isGermanDescriptionColumn(ws, descriptor, column)) return translateEnglishDescriptionToGerman(direct);
  return direct;
}

function rowVariantValue(column: PdtColumn, ctx: ResolveContext): string | undefined {
  const variant = ctx.rowVariant;
  if (!variant) return undefined;
  for (const key of [column.code, column.propName]) {
    const value = variant[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolvePropertyByDescription(column: PdtColumn, ctx: ResolveContext): string | undefined {
  const description = column.description.toLowerCase();
  if (/\bmin(?:imum)?\b.*\boperating\b.*\btemp/.test(description) || /\bmin\b.*\btemp/.test(description)) {
    return resolveProperty("AAC820", "AAC820", ctx);
  }
  if (/\bmax(?:imum)?\b.*\boperating\b.*\btemp/.test(description) || /\bmax\b.*\btemp/.test(description)) {
    return resolveProperty("AAC821", "AAC821", ctx);
  }
  if (/\bvoltage type\b|\bcurrent type\b/.test(description)) return resolveProperty("BAD915", "BAD915", ctx);
  return undefined;
}

function resolvePropertyByColumnMetadata(column: PdtColumn, ctx: ResolveContext): string | undefined {
  const labels = metadataLabels(column);
  if (labels.length === 0) return undefined;

  const candidates = (ctx.result?.attributes ?? [])
    .map((attribute) => ({
      attribute,
      name: normalizedMetadataLabel(attribute.name),
      groupedName: normalizedMetadataLabel(`${attribute.group ?? ""} ${attribute.name}`)
    }))
    .filter(({ attribute }) => Boolean(cleanString(attribute.value)))
    .filter(({ name, groupedName }) => labels.includes(name) || labels.includes(groupedName));
  if (candidates.length === 0) return undefined;

  candidates.sort((left, right) => sourceRank(right.attribute.sourceType) - sourceRank(left.attribute.sourceType));
  return cleanString(candidates[0].attribute.value);
}

function metadataLabels(column: PdtColumn): string[] {
  const labels = new Set<string>();
  for (const label of [column.code, column.propName, descriptionWithoutEnumLegend(column.description)]) {
    const normalized = normalizedMetadataLabel(label);
    if (isUsableMetadataLabel(normalized)) labels.add(normalized);
  }
  return [...labels];
}

function descriptionWithoutEnumLegend(description: string): string {
  return description.split(/\s+\d+\s*[-–]\s*/u)[0] ?? description;
}

function normalizedMetadataLabel(value: string): string {
  return value
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bmax\./gi, "maximum")
    .replace(/\bmin\./gi, "minimum")
    .replace(/\bcolou?r\b/gi, "color")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\bthe\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isUsableMetadataLabel(value: string): boolean {
  return (
    value.length >= 4 &&
    ![
      "body",
      "category",
      "classid",
      "coding",
      "connection type",
      "construction",
      "description",
      "design",
      "degree of protection",
      "degree of protection nema",
      "eclass property",
      "finish",
      "light source",
      "priority",
      "protection type nema",
      "propertyid",
      "propertyname",
      "surface",
      "type",
      "type of connector",
      "unit",
      "units"
    ].includes(value)
  );
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

function sourceRank(sourceType: AttributeRecord["sourceType"]): number {
  if (sourceType === "official") return 3;
  if (sourceType === "official-fallback") return 2;
  if (sourceType === "cache") return 1;
  if (sourceType === "distributor") return -1;
  return 0;
}

function resolvePropertyDescriptionKey(description: string): string | undefined {
  const text = description.toLowerCase();
  if (/\bmin(?:imum)?\b.*\boperating\b.*\btemp/.test(text) || /\bmin\b.*\btemp/.test(text)) return "AAC820";
  if (/\bmax(?:imum)?\b.*\boperating\b.*\btemp/.test(text) || /\bmax\b.*\btemp/.test(text)) return "AAC821";
  if (/\bvoltage type\b|\bcurrent type\b/.test(text)) return "BAD915";
  return undefined;
}

function descriptionColumnType(column: PdtColumn): "long" | "short" | undefined {
  const key = `${column.code} ${column.propName}`.toUpperCase();
  if (key.includes("CNS_DESCRIPTION_LONG") || key.includes("AAU734")) return "long";
  if (key.includes("CNS_DESCRIPTION_SHORT")) return "short";
  return undefined;
}

function isGermanDescriptionColumn(
  ws: ExcelJS.Worksheet,
  descriptor: { firstBodyRow: number },
  column: PdtColumn
): boolean {
  return Boolean(descriptionColumnType(column) && columnLanguage(ws, column.col, descriptor.firstBodyRow) === "de");
}

function columnLanguage(ws: ExcelJS.Worksheet, column: number, firstBodyRow: number): "en" | "de" | undefined {
  const samples: string[] = [];
  for (let row = 1; row < firstBodyRow; row += 1) {
    const text = cellText(ws.getCell(row, column).value);
    if (text) samples.push(text);
  }
  const joined = samples.join(" ").toLowerCase();
  if (/\b(description|desc|product description)\s*de\b|\bde\s*(description|desc)\b|\bdeutsch\b|\bgerman\b/.test(joined)) return "de";
  if (/\b(description|desc|product description)\s*en\b|\ben\s*(description|desc)\b|\benglish\b/.test(joined)) return "en";
  return undefined;
}

function translateEnglishDescriptionToGerman(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const exact = TECHNICAL_GERMAN_TRANSLATIONS.get(trimmed.toLowerCase());
  if (exact) return exact;
  return translateAbbAfContactorDescription(trimmed) ?? translateSimpleTechnicalDescription(trimmed) ?? trimmed;
}

const TECHNICAL_GERMAN_TRANSLATIONS = new Map<string, string>([
  ["wall mounted enclosure", "Wandmontiertes Gehäuse"],
  ["enclosure", "Gehäuse"],
  ["contactor", "Schütz"]
]);

function translateSimpleTechnicalDescription(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (/^[\w.-]+\s+contactor$/.test(normalized)) return value.replace(/\bcontactor\b/i, "Schütz");
  if (/^\d+\s*pole\s+contactor$/.test(normalized)) return value.replace(/^(\d+)\s*pole\s+contactor$/i, "$1-poliger Schütz");
  return undefined;
}

function translateAbbAfContactorDescription(value: string): string | undefined {
  const pattern =
    /^The\s+(?<model>[\w.-]+)\s+is\s+a\s+(?<poles>\d+)\s+pole\s*-\s*(?<iecVoltage>\d+(?:\.\d+)?)\s*V\s*IEC\s+or\s+(?<ulVoltage>\d+(?:\.\d+)?)\s*(?:V\s*)?UL\s+contactor\s+with\s+(?<terminals>[^,]+),\s+controlling\s+motors\s+up\s+to\s+(?<kw>\d+(?:\.\d+)?)\s*kW\s*\/\s*(?<motorVoltage>\d+(?:\.\d+)?)\s*V\s*AC\s*\(AC-3\)\s+or\s+(?<hp>\d+(?:\.\d+)?)\s*hp\s*\/\s*(?<hpVoltage>\d+(?:\.\d+)?)\s*V\s*UL\s+and\s+switching\s+power\s+circuits\s+up\s+to\s+(?<ac1>\d+(?:\.\d+)?)\s*A\s*\(AC-1\)\s+or\s+(?<ulCurrent>\d+(?:\.\d+)?)\s*A\s*UL\s+general\s+use\.\s+Thanks\s+to\s+(?:the\s+)?AF\s+technology,\s+the\s+contactor\s+has\s+a\s+wide\s+control\s+voltage\s+range\s+\((?<controlVoltage>[^)]+)\),\s+managing\s+large\s+control\s+voltage\s+variations,\s+reducing\s+panel\s+energy\s+consumptions\s+and\s+ensuring\s+distinct\s+operations\s+in\s+unstable\s+networks\.\s+Furthermore,\s+surge\s+protection\s+is\s+built-in,\s+offering\s+a\s+compact\s+solution\.\s+AF\s+contactors\s+have\s+a\s+block\s+type\s+design,\s+can\s+be\s+easily\s+extended\s+with\s+add-on\s+auxiliary\s+contact\s+blocks\s+and\s+an\s+additional\s+wide\s+range\s+of\s+accessories\.?$/i;
  const match = value.match(pattern);
  const groups = match?.groups;
  if (!groups) return undefined;
  const terminals = translateTerminalPhrase(groups.terminals);
  const controlVoltage = groups.controlVoltage.replace(/\s+and\s+DC\b/i, " und DC");
  return [
    `Der ${groups.model} ist ein ${groups.poles}-poliger Schütz für ${groups.iecVoltage} V IEC bzw. ${groups.ulVoltage} V UL mit ${terminals}.`,
    `Er steuert Motoren bis ${groups.kw} kW / ${groups.motorVoltage} V AC (AC-3) oder ${groups.hp} hp / ${groups.hpVoltage} V UL und schaltet Leistungskreise bis ${groups.ac1} A (AC-1) oder ${groups.ulCurrent} A UL General Use.`,
    `Dank AF-Technologie verfügt das Schütz über einen breiten Steuerspannungsbereich (${controlVoltage}), beherrscht große Steuerspannungsschwankungen, reduziert den Energieverbrauch im Schaltschrank und sorgt für zuverlässigen Betrieb in instabilen Netzen.`,
    "Der integrierte Überspannungsschutz bietet eine kompakte Lösung.",
    "AF-Schütze sind in Blockbauweise ausgeführt und können einfach mit anbaubaren Hilfskontaktblöcken sowie einem breiten Zubehörprogramm erweitert werden."
  ].join(" ");
}

function translateTerminalPhrase(value: string | undefined): string {
  const text = value?.trim() ?? "";
  if (/^RT\s+terminals$/i.test(text)) return "RT-Anschlüssen";
  if (/^screw\s+terminals$/i.test(text)) return "Schraubanschlüssen";
  if (/^ring\s+tongue\s+terminals$/i.test(text)) return "Ringkabelschuh-Anschlüssen";
  return text || "Anschlüssen";
}

function removeTemplateLabelColumn(ws: ExcelJS.Worksheet): void {
  const labels = ["classid", "priority", "type", "propertyid", "propertyname", "description", "unit", "body"];
  const hasLabelColumn = labels.every((label, index) => {
    const value = ws.getCell(index + 1, 1).value;
    return typeof value === "string" && value.trim().toLowerCase() === label;
  });
  if (hasLabelColumn) ws.spliceColumns(1, 1);
}
