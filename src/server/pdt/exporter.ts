import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AttributeRecord, ManufacturerConfig, PdtSheetOverrides, RunItemRecord } from "../../shared/types.js";
import { classifyDeviceType } from "../scrapers/device-type.js";
import { loadTemplateWorkbook } from "./template.js";
import { cellText, clearBody, describeSheet, type PdtColumn, type SheetDescriptor } from "./sheet-descriptor.js";
import { CONSTANT_SHEETS, targetSheets } from "./device-sheet-map.js";
import { resolveProperty, type ResolveContext } from "./eclass-resolvers.js";
import { writeDocumentsSheet } from "./documents-sheet.js";
import { encodeEnumLabel, isEnumColumn } from "./enum-encode.js";
import { buildPdtRepairResult, type PdtCleanupAudit, type PdtRepair } from "./ai-cleanup.js";
import { writeCleanedInputWorkbook } from "./cleaned-input-workbook.js";
import { normalizePdtCellNumber } from "./unit-cleanup.js";
import { writeProductAccessorySheet } from "./product-accessory-sheet.js";
import { bestFact, buildPdtFactIndex, factsMatchingValue, type PdtFact, type PdtFactIndex } from "./facts.js";
import { additionalPdtSheetsRule, pdtColumnAllowRule, pdtSheetOverrideRule } from "./rules.js";

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
  requiredFieldIssues: PdtRequiredFieldIssue[];
  /** Tabs retained in the final workbook (unused template tabs are removed). */
  keptSheets: string[];
  removedSheetCount: number;
  cleanup: PdtCleanupSummary;
  cleanedInputPath?: string;
  pdtAuditPath?: string;
  cellAudit: PdtCellAuditSummary;
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

export interface PdtRequiredFieldIssue {
  sheetName: string;
  catalogNumber: string;
  code: string;
  propName: string;
  description: string;
  priority: string;
  reason: "required-missing";
}

export type PdtCleanupSummary = Omit<PdtCleanupAudit, "products"> & { productRows: number };

export interface PdtCellAuditRecord {
  sheetName: string;
  catalogNumber: string;
  row: number;
  column: number;
  code: string;
  propName: string;
  description: string;
  priority: string;
  status: "written" | "blank" | "skipped";
  value?: string;
  reason: string;
  sourceKind?: string;
  sourceType?: string;
  sourceUrl?: string;
  parser?: string;
  stage?: string;
  confidence?: number;
  ruleName?: string;
}

export interface PdtCellAuditSummary {
  auditPath?: string;
  written: number;
  blank: number;
  skipped: number;
  unprovenSkipped: number;
  records: PdtCellAuditRecord[];
}

interface PdtResolvedCell {
  value: string;
  provenance: PdtCellProvenance;
  /** When set, write the cell as an Excel formula instead of a literal value. The `value` field becomes the cached result. */
  formula?: string;
}

interface PdtCellProvenance {
  sourceKind: string;
  sourceType?: string;
  sourceUrl?: string;
  parser?: string;
  stage?: string;
  confidence: number;
  ruleName?: string;
  reason: string;
}

export async function exportRunPdt(input: {
  manufacturer: ManufacturerConfig;
  items: RunItemRecord[];
  templatePath: string;
  outputPath: string;
  aiCleanup?: boolean;
  /** Optional user-chosen sheet routing (itemId → list of sheet names). Replaces auto-routing. */
  sheetOverrides?: PdtSheetOverrides;
}): Promise<PdtExportResult> {
  const { manufacturer, items, templatePath, outputPath, sheetOverrides } = input;
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
  const requiredFieldIssues: PdtRequiredFieldIssue[] = [];
  const cellAuditRecords: PdtCellAuditRecord[] = [];

  for (const item of included) {
    const deviceType = classifyDeviceType(item.result).type;
    if (!deviceType) unclassifiedCatalogNumbers.add(item.catalogNumber);
    const userOverride = sheetOverrides?.[item.id];
    const builtIn = overrideDeviceSheetsForItem(item, manufacturer, deviceType);
    // User overrides win over the built-in (ABB 1SDA) rule; both replace device-type auto routing.
    const override = userOverride && userOverride.length > 0 ? userOverride : builtIn;
    const sheets = override
      ? [...CONSTANT_SHEETS, ...override]
      : [...targetSheets(deviceType), ...additionalDeviceSheetsForItem(item, manufacturer, deviceType)];
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
    filledSheets[sheetName] = writeUniformSheet(ws, sheetMembers, manufacturer, repairs, writeIssues, requiredFieldIssues, cellAuditRecords);
  }

  const documentsWs = workbook.getWorksheet(resolveSheetName(DOCUMENTS_SHEET) ?? DOCUMENTS_SHEET);
  let documentRows = 0;
  if (documentsWs) {
    documentRows = writeDocumentsSheet(documentsWs, included);
    filledSheets[documentsWs.name] = documentRows;
  } else {
    missingSheets.add(DOCUMENTS_SHEET);
  }

  // Fill connection points only for manufacturers with PDT-example-backed connection rules.

  const connectionPointsWs = workbook.getWorksheet(resolveSheetName("Connection Point Information") ?? "Connection Point Information");
  if (connectionPointsWs) {
    filledSheets[connectionPointsWs.name] = 0;
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
  const cellAudit = buildCellAuditSummary(cellAuditRecords);
  const pdtAuditPath = pdtAuditPathFor(outputPath);
  cellAudit.auditPath = pdtAuditPath;
  await fs.writeFile(pdtAuditPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    outputPath,
    productCount: included.length,
    summary: {
      written: cellAudit.written,
      blank: cellAudit.blank,
      skipped: cellAudit.skipped,
      unprovenSkipped: cellAudit.unprovenSkipped
    },
    writeIssues,
    requiredFieldIssues,
    records: cellAudit.records
  }, null, 2), "utf8");

  return {
    outputPath,
    productCount: included.length,
    documentRows,
    filledSheets,
    missingSheets: [...missingSheets],
    unmappedDeviceTypes: [...unmappedDeviceTypes],
    unclassifiedCatalogNumbers: [...unclassifiedCatalogNumbers],
    writeIssues,
    requiredFieldIssues,
    keptSheets: workbook.worksheets.map((ws) => ws.name),
    removedSheetCount: removedSheets.length,
    cleanup: cleanupSummary(cleanup.audit),
    cleanedInputPath,
    pdtAuditPath,
    cellAudit
  };
}

function cleanupSummary(audit: PdtCleanupAudit): PdtCleanupSummary {
  const { products, ...summary } = audit;
  return { ...summary, productRows: products.length };
}

function buildCellAuditSummary(records: PdtCellAuditRecord[]): PdtCellAuditSummary {
  return {
    written: records.filter((record) => record.status === "written").length,
    blank: records.filter((record) => record.status === "blank").length,
    skipped: records.filter((record) => record.status === "skipped").length,
    unprovenSkipped: records.filter((record) => record.status === "skipped" && /unproven/i.test(record.reason)).length,
    records
  };
}

function pdtAuditPathFor(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}_pdt-audit.json`);
}

function auditRecord(
  sheetName: string,
  item: RunItemRecord,
  row: number,
  column: PdtColumn,
  status: PdtCellAuditRecord["status"],
  reason: string,
  value?: string,
  provenance?: PdtCellProvenance
): PdtCellAuditRecord {
  return {
    sheetName,
    catalogNumber: item.catalogNumber,
    row,
    column: column.col,
    code: column.code,
    propName: column.propName,
    description: column.description,
    priority: column.priority,
    status,
    value,
    reason,
    sourceKind: provenance?.sourceKind,
    sourceType: provenance?.sourceType,
    sourceUrl: provenance?.sourceUrl,
    parser: provenance?.parser,
    stage: provenance?.stage,
    confidence: provenance?.confidence,
    ruleName: provenance?.ruleName
  };
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
  writeIssues: PdtWriteIssue[],
  requiredFieldIssues: PdtRequiredFieldIssue[],
  cellAuditRecords: PdtCellAuditRecord[]
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
    const facts = buildPdtFactIndex({
      item,
      manufacturer,
      deviceType: baseCtx.deviceType,
      repair: baseCtx.repair
    });
    for (const rowVariant of uniformRowVariantsFor(ws.name, item, baseCtx)) {
      const ctx: ResolveContext = { ...baseCtx, rowVariant };
      let wroteCell = false;
      const writtenRequiredColumns = new Set<number>();
      for (const column of descriptor.columns) {
        const columnRule = columnAllowRuleForItem(ws.name, item, manufacturer, baseCtx.deviceType, column);
        if (columnRule && !columnRule.value) {
          cellAuditRecords.push(auditRecord(
            ws.name,
            item,
            row,
            column,
            "skipped",
            columnRule.rationale,
            undefined,
            {
              sourceKind: "generated-rule",
              confidence: 0.99,
              ruleName: columnRule.name,
              reason: columnRule.rationale
            }
          ));
          continue;
        }
        const resolved = resolvePdtColumnCell(ws, descriptor, column, row, ctx, facts);
        if (!resolved || resolved.value === "") {
          cellAuditRecords.push(auditRecord(ws.name, item, row, column, "blank", "No source-backed PDT value resolved for this column."));
          continue;
        }
        if (!canWriteResolvedCell(resolved, ws.name, column)) {
          cellAuditRecords.push(auditRecord(
            ws.name,
            item,
            row,
            column,
            "skipped",
            skippedCellReason(resolved, ws.name, column),
            resolved.value,
            resolved.provenance
          ));
          continue;
        }
        const value = resolved.value;
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
            cellAuditRecords.push(auditRecord(
              ws.name,
              item,
              row,
              column,
              "skipped",
              "Resolved value did not match the PDT enum legend.",
              value,
              resolved.provenance
            ));
            continue;
          }
          ws.getCell(row, column.col).value = label;
        } else if (resolved.formula) {
          ws.getCell(row, column.col).value = { formula: resolved.formula, result: value } as ExcelJS.CellFormulaValue;
        } else {
          ws.getCell(row, column.col).value = cellValueFor(column, value);
        }
        cellAuditRecords.push(auditRecord(ws.name, item, row, column, "written", resolved.provenance.reason, value, resolved.provenance));
        if (isTrackedRequiredPdtColumn(ws.name, column)) writtenRequiredColumns.add(column.col);
        wroteCell = true;
      }
      for (const column of descriptor.columns) {
        const columnRule = columnAllowRuleForItem(ws.name, item, manufacturer, baseCtx.deviceType, column);
        if (columnRule && !columnRule.value) continue;
        if (!isTrackedRequiredPdtColumn(ws.name, column)) continue;
        if (writtenRequiredColumns.has(column.col)) continue;
        requiredFieldIssues.push({
          sheetName: ws.name,
          catalogNumber: item.catalogNumber,
          code: column.code,
          propName: column.propName,
          description: column.description,
          priority: column.priority,
          reason: "required-missing"
        });
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

function additionalDeviceSheetsForItem(item: RunItemRecord, manufacturer: ManufacturerConfig, deviceType: string | undefined): string[] {
  return additionalPdtSheetsRule({ item, manufacturer, deviceType })?.value ?? [];
}

/** Hard override: when set, REPLACES device-type sheets entirely (only constant tabs + these are written). */
function overrideDeviceSheetsForItem(item: RunItemRecord, manufacturer: ManufacturerConfig, deviceType: string | undefined): string[] | null {
  return pdtSheetOverrideRule({ item, manufacturer, deviceType })?.value ?? null;
}

/**
 * Column-level allowlist for specific (manufacturer, catalog-pattern, sheet) combos. Returns true
 * when the column should be written for this item. Mirrors the manual PDT layout — e.g. ABB Emax 3
 * accessories on `contactor a. fuses` only carry ECLASS group/version, article number, and the
 * actual rated voltage / voltage type when present. Everything else (generic compliance markers,
 * scraped color, IP rating, etc.) is suppressed to avoid writing junk into ill-suited columns.
 */
function columnAllowRuleForItem(
  sheetName: string,
  item: RunItemRecord,
  manufacturer: ManufacturerConfig,
  deviceType: string | undefined,
  column: PdtColumn
): ReturnType<typeof pdtColumnAllowRule> {
  return pdtColumnAllowRule({ sheetName, item, manufacturer, deviceType, column });
}

function isTrackedRequiredPdtColumn(sheetName: string, column: PdtColumn): boolean {
  const priority = column.priority.trim();
  if (!/\b(?:must|should)\b/i.test(priority)) return false;
  const sheet = canonicalSheetKey(sheetName);
  const key = pdtColumnKey(column);

  // These are the minimum import-critical fields read from the Master PDT template tabs the
  // user works with most. "If available / ECADPORT" classification columns are included when
  // they are on those tabs, because the exporter can usually derive at least the system/version.
  const requiredBySheet: Record<string, Set<string>> = {
    [canonicalSheetKey("Material Master Data")]: new Set([
      "AAO677",
      "MANUFACTURER_URL",
      "AAQ326",
      "AAO676",
      "CNSORDERNO",
      "AAV774/AAO057",
      "CNSTYPECODE",
      "AAO057",
      "AAU731",
      "AAU732",
      "CNS_DESCRIPTION_LONG / AAU734",
      "CNS_DESCRIPTION_LONG",
      "AAU734",
      "CNS_DESCRIPTION_SHORT",
      "CNS_ELECTRO_MATERIAL",
      "AAF040",
      "CNS_MASSEXACT"
    ]),
    [canonicalSheetKey("Additional Documents")]: new Set(["ARTICLENUMBER"]),
    [canonicalSheetKey("cabinet")]: new Set(["REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_SYSTEM_NAME", "AAO676"]),
    [canonicalSheetKey("cabinet.mechanical")]: new Set([
      "REFERENCE_FEATURE_GROUP_ID",
      "REFERENCE_FEATURE_SYSTEM_NAME",
      "AAO676",
      "CNS_COMPONENT_FUNCTION_3D"
    ]),
    [canonicalSheetKey("cabinet.rack")]: new Set(["REFERENCE_FEATURE_GROUP_ID", "REFERENCE_FEATURE_SYSTEM_NAME", "AAO676"]),
    [canonicalSheetKey("Wire ID Information")]: new Set([
      "AAO676",
      "CABLE ELEMENT IDENTIFIER",
      "AAN528",
      "AAN529",
      "CNS_CROSSECTION_AWG",
      "AAN524",
      "CNS_DESIGN_OF_WIRE",
      "AAN525",
      "CNS_FUNCTION_OF_WIRE",
      "AAN526",
      "CNS_CONSTRUCTION_OF_WIRE",
      "AAN530",
      "CNS_CORE_MATERIAL",
      "AAN523",
      "CNS_CONNECTION_DESCRIPTION",
      "AAN506",
      "CNS_TYPE_OF_CONNECTION",
      "AAN527",
      "BAC469",
      "BAH005",
      "CNS_RATED_VOLTAGE",
      "AAB485",
      "CNS_RATED_CURRENT",
      "CABLE ELEMENT IDENTIFIER A"
    ]),
    [canonicalSheetKey("cable")]: new Set([
      "REFERENCE_FEATURE_GROUP_ID",
      "REFERENCE_FEATURE_SYSTEM_NAME",
      "AAO676",
      "BAD974",
      "00003D001",
      "BAD821",
      "00003C001",
      "AAP775",
      "\"00003E001\"",
      "BAD979"
    ]),
    [canonicalSheetKey("contactor a. fuses")]: new Set([
      "REFERENCE_FEATURE_GROUP_ID",
      "REFERENCE_FEATURE_SYSTEM_NAME",
      "AAO676",
      "AAF726",
      "AAB821",
      "AAC824",
      "AAB460",
      "AAS574",
      "AAB485",
      "AAS575"
    ]),
    [canonicalSheetKey("subcircuit")]: new Set([
      "REFERENCE_FEATURE_GROUP_ID",
      "REFERENCE_FEATURE_SYSTEM_NAME",
      "AAO676",
      "AAB733",
      "HELP"
    ])
  };

  return requiredBySheet[sheet]?.has(key) ?? false;
}

function pdtColumnKey(column: PdtColumn): string {
  return (column.code || column.propName).trim().toUpperCase();
}

function uniformRowVariantsFor(_sheetName: string, _item: RunItemRecord, _ctx: ResolveContext): Array<Record<string, string> | undefined> {
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
  // NEMA enclosure rating columns (AAW361, AAZ486): manual PDTs use a compound string like
  // "NEMA Type 3R, 4, 4X, 12 and Type 13" that doesn't match any single enum legend value.
  // Write it raw so the cell isn't stripped to blank by enum encoding.
  if ((keys.includes("AAW361") || keys.includes("AAZ486")) && /\bNEMA\b.*\bType\b/i.test(value)) return false;
  return true;
}

function resolvePdtColumnCell(
  ws: ExcelJS.Worksheet,
  descriptor: SheetDescriptor,
  column: PdtColumn,
  row: number,
  ctx: ResolveContext,
  facts: PdtFactIndex
): PdtResolvedCell | undefined {
  const variant = rowVariantValue(column, ctx);
  if (variant !== undefined) {
    return {
      value: variant,
      provenance: {
        sourceKind: "generated-rule",
        confidence: 0.72,
        ruleName: "row-variant",
        reason: "Value came from an explicit PDT row variant rule."
      }
    };
  }

  const isDeDescription = isGermanDescriptionColumn(ws, descriptor, column);
  const resolveCtx: ResolveContext = isDeDescription ? { ...ctx, language: "de" } : ctx;
  const factResolved = resolveColumnFromFacts(column, resolveCtx, facts);
  const direct = factResolved
    ? factResolved
    : (() => {
        const value =
          resolveProperty(column.code, column.propName, resolveCtx) ??
          resolvePropertyByDescription(column, resolveCtx) ??
          resolvePropertyByColumnMetadata(column, resolveCtx);
        if (!value) return undefined;
        // Resolvers often DERIVE / transform attribute text (units converted, color summarized,
        // material canonicalised). The transformed value rarely substring-matches the raw scraped
        // attribute, so inferCellProvenance falls through to "unproven" and the cell gets skipped.
        // For known-derived columns, borrow the upstream fact's provenance directly.
        const borrowedFactKey = derivedFactKeyForColumn(column);
        if (borrowedFactKey) {
          const upstream = bestFact(facts, borrowedFactKey);
          if (upstream) return { value, provenance: provenanceFromFact(upstream) };
        }
        return { value, provenance: inferCellProvenance(column, value, resolveCtx, facts) };
      })();
  if (!direct) return undefined;

  // DE description columns fall back to the EN string when no localized German source exists.
  // Wrap that placeholder in an Excel TRANSLATE() formula so spreadsheet readers (Excel 2024+/M365)
  // render the actual German translation via Microsoft Translator. We only emit the formula when
  // the underlying value really came from the EN fallback — if the scraper got a localized DE
  // text, we keep that authoritative string as a literal.
  if (isDeDescription && !hasLocalizedGermanSource(ctx, column)) {
    const enTwin = findEnDescriptionTwin(ws, descriptor, column);
    if (enTwin) {
      const enAddress = ws.getCell(row, enTwin.col).address;
      return {
        ...direct,
        formula: `=IFERROR(TRANSLATE(${enAddress},"en","de"),${enAddress})`,
        provenance: {
          ...direct.provenance,
          reason: `${direct.provenance.reason} Wrapped in Excel TRANSLATE() formula pointing at the EN twin cell ${enAddress}.`
        }
      };
    }
  }
  return direct;
}

function isWeightColumn(column: PdtColumn): boolean {
  const keys = propertyKeysForColumn(column);
  return keys.includes("CNS_MASSEXACT") || keys.includes("AAF040") || keys.includes("BAD875");
}

/**
 * Map a column to an upstream fact key whose provenance the column's resolved value should
 * inherit. Used when the resolver derives a transformed value that won't substring-match the
 * raw scraped attribute (weight conversions, color/finish summaries, material canonicalisation).
 */
function derivedFactKeyForColumn(column: PdtColumn): string | undefined {
  if (isWeightColumn(column)) return "weight";
  const keys = propertyKeysForColumn(column);
  if (keys.includes("BAC295") || keys.includes("AAN521")) return "color";
  if (keys.includes("CNS_ELECTRO_MATERIAL") || keys.includes("BAB664") || keys.includes("BAF634")) return "material";
  return undefined;
}

function hasLocalizedGermanSource(ctx: ResolveContext, column: PdtColumn): boolean {
  const de = ctx.result?.localizedDescriptions?.de;
  if (!de) return false;
  const key = `${column.code} ${column.propName}`.toUpperCase();
  const compare = (deValue: string | undefined, enValue: string | undefined): boolean => {
    const trimmed = deValue?.trim();
    if (!trimmed) return false;
    // When the localized "DE" text is byte-for-byte the EN string (manufacturers occasionally
    // echo English back from their /de/ page), treat it as no real DE source so the cell still
    // gets wrapped in TRANSLATE() rather than shipped as-is.
    const enTrimmed = enValue?.trim();
    if (enTrimmed && trimmed.toLowerCase().replace(/[\s._-]+/g, "") === enTrimmed.toLowerCase().replace(/[\s._-]+/g, "")) return false;
    return true;
  };
  if (/SHORT/.test(key)) return compare(de.title, ctx.result?.title);
  return compare(de.description, ctx.result?.description);
}

function findEnDescriptionTwin(
  ws: ExcelJS.Worksheet,
  descriptor: SheetDescriptor,
  column: PdtColumn
): PdtColumn | undefined {
  const key = pdtColumnKey(column);
  return descriptor.columns.find(
    (candidate) =>
      candidate.col !== column.col &&
      pdtColumnKey(candidate) === key &&
      columnLanguage(ws, candidate.col, descriptor.firstBodyRow) === "en"
  );
}

function resolveColumnFromFacts(column: PdtColumn, ctx: ResolveContext, facts: PdtFactIndex): PdtResolvedCell | undefined {
  for (const key of factKeysForColumn(column, ctx)) {
    const fact = bestFact(facts, key);
    if (fact) return { value: fact.value, provenance: provenanceFromFact(fact) };
  }
  return undefined;
}

function factKeysForColumn(column: PdtColumn, ctx: ResolveContext): string[] {
  const keys = propertyKeysForColumn(column);
  const factKeys: string[] = [];
  const add = (key: string) => {
    if (!factKeys.includes(key)) factKeys.push(key);
  };

  if (keys.some((key) => ["AAO676", "CNSORDERNO", "ABA671"].includes(key))) add("articleNumber");
  if (keys.includes("AAO677")) add("manufacturerName");
  if (keys.includes("MANUFACTURER_URL") || keys.includes("ABA669")) add("manufacturerUrl");
  if (keys.includes("AAQ326") || keys.includes("AAY811")) add("productUrl");
  if (keys.includes("AAO057")) add("deviceType");
  if (keys.includes("REFERENCE_FEATURE_GROUP_ID")) add("eclassCode");
  if (keys.includes("REFERENCE_FEATURE_SYSTEM_NAME")) add("eclassSystemVersion");
  const enumColumn = isEnumColumn(column.description);
  if (keys.includes("CNS_ELECTRO_MATERIAL") || keys.includes("BAB664") || keys.includes("BAF634") || (!enumColumn && /material/i.test(column.description))) add("material");
  if (keys.includes("AAN521") || keys.includes("BAC295") || (!enumColumn && /colou?r/i.test(column.description))) add("color");
  if (keys.includes("CERTIFICATION") || (!enumColumn && /certification|approval/i.test(column.description))) add("certificates");
  if (keys.includes("CNS_CTN") || keys.includes("AAD931")) add("customsTariff");
  if (keys.includes("AAO663") || keys.includes("CNS_EAN") || keys.includes("AAN743")) add("eanOrGtin");
  if (keys.includes("CNSTYPECODE") || keys.includes("AAV774")) add("typeCode");
  if (keys.includes("AAU731")) add("productFamily");
  if (keys.includes("AAW338")) add("productDesignation");
  if (keys.includes("AAU734") || keys.includes("CNS_DESCRIPTION_LONG")) add(ctx.language === "de" ? "localizedLongDescriptionDe" : "longDescription");
  if (keys.includes("CNS_DESCRIPTION_SHORT")) add(ctx.language === "de" ? "localizedShortDescriptionDe" : "shortDescription");
  // Weight columns must run through the dedicated weight resolvers (AAF040 / BAD875 / CNS_MASSEXACT)
  // so imperial sources like Saginaw's "26.00 lbs (11.79 kg)" emit kg-only / g-only values instead of
  // the dual-unit display string the normalizer publishes for the UI.
  if (keys.includes("BAD915") || /\bvoltage type\b|\bcurrent type\b/i.test(column.description)) add("voltageType");

  return factKeys;
}

function inferCellProvenance(column: PdtColumn, value: string, ctx: ResolveContext, facts: PdtFactIndex): PdtCellProvenance {
  const matchedFact = factsMatchingValue(facts, value).find((fact) => fact.sourceKind !== "generated-rule" || generatedColumn(column));
  if (matchedFact) return provenanceFromFact(matchedFact);

  const attr = (ctx.result?.attributes ?? []).find((candidate) => attributeSupportsValue(candidate, value, column));
  if (attr) {
    return {
      sourceKind: "attribute",
      sourceType: attr.sourceType,
      sourceUrl: attr.sourceUrl,
      parser: attr.parser,
      stage: attr.stage,
      confidence: attr.confidence ?? (attr.sourceType === "official" ? 0.9 : attr.sourceType === "official-fallback" ? 0.78 : attr.sourceType === "distributor" ? 0.45 : 0.65),
      reason: `Resolved from scraped attribute "${attr.name}".`
    };
  }

  if (generatedColumn(column)) {
    return {
      sourceKind: "generated-rule",
      confidence: 0.86,
      ruleName: "deterministic-pdt-resolver",
      reason: "Deterministic non-spec PDT value derived from input/catalog context."
    };
  }

  return {
    sourceKind: "unproven",
    confidence: 0.1,
    reason: "Resolver returned a value, but no matching source-backed fact or attribute was found."
  };
}

function provenanceFromFact(fact: PdtFact): PdtCellProvenance {
  return {
    sourceKind: fact.sourceKind,
    sourceType: fact.sourceType,
    sourceUrl: fact.sourceUrl,
    parser: fact.parser,
    stage: fact.stage,
    confidence: fact.confidence,
    ruleName: fact.ruleName,
    reason: fact.reason
  };
}

function canWriteResolvedCell(resolved: PdtResolvedCell, sheetName: string, column: PdtColumn): boolean {
  if (resolved.provenance.sourceKind === "unproven") return false;
  if (resolved.provenance.sourceType === "distributor" && resolved.provenance.confidence < 0.6) return false;
  if (resolved.provenance.sourceKind === "generated-rule" && productSpecColumn(sheetName, column)) return false;
  if (productSpecColumn(sheetName, column) && productSpecMeasurementIssue(resolved.value, column)) return false;
  return true;
}

function skippedCellReason(resolved: PdtResolvedCell, sheetName: string, column: PdtColumn): string {
  if (resolved.provenance.sourceKind === "unproven") return `Skipped unproven PDT value: ${resolved.provenance.reason}`;
  if (resolved.provenance.sourceType === "distributor" && resolved.provenance.confidence < 0.6) {
    return `Skipped weak distributor-only PDT value: ${resolved.provenance.reason}`;
  }
  if (resolved.provenance.sourceKind === "generated-rule") {
    return `Skipped generated PDT value for product-spec cell: ${resolved.provenance.reason}`;
  }
  const measurementIssue = productSpecColumn(sheetName, column) ? productSpecMeasurementIssue(resolved.value, column) : undefined;
  if (measurementIssue) return `Skipped semantically invalid product-spec value: ${measurementIssue}`;
  return `Skipped PDT value: ${resolved.provenance.reason}`;
}

function productSpecMeasurementIssue(value: string, column: PdtColumn): string | undefined {
  const columnText = normalizedMetadataLabel(`${column.code} ${column.propName} ${descriptionWithoutEnumLegend(column.description)} ${column.unit}`);
  const cleanValue = cleanString(value);
  if (!cleanValue) return "empty product-spec value";
  if (/\b(?:voltage|current)\s+type\b/.test(columnText)) return undefined;

  if (/\bvoltage\b|\bvolt\b/.test(columnText) && !hasMeasuredValue(cleanValue, column.unit, /\b(?:m?v|kv|vac|vdc|v\s*(?:ac|dc)?)\b/i)) {
    return "voltage cell value does not contain a numeric voltage measurement";
  }
  if (/\bcurrent\b|\bamp\b/.test(columnText) && !hasMeasuredValue(cleanValue, column.unit, /\b(?:u?a|m?a|ka|amps?|amperes?)\b/i)) {
    return "current cell value does not contain a numeric current measurement";
  }
  if (/\b(?:power|loss|watt|horsepower)\b/.test(columnText) && !hasMeasuredValue(cleanValue, column.unit, /\b(?:w|kw|mw|hp|horsepower)\b/i)) {
    return "power cell value does not contain a numeric power measurement";
  }
  return undefined;
}

function hasMeasuredValue(value: string, declaredUnit: string, unitPattern: RegExp): boolean {
  if (!/-?\d+(?:[.,]\d+)?/.test(value)) return false;
  return unitPattern.test(value) || unitPattern.test(declaredUnit) || numericPdtCellValue(value);
}

function numericPdtCellValue(value: string): boolean {
  return /^\s*(?:[<>=~±+\-–—.\/,;:()\s]|\d)+(?:\.\.\.\s*(?:[<>=~±+\-–—.\/,;:()\s]|\d)+)?\s*$/.test(value);
}

function productSpecColumn(sheetName: string, column: PdtColumn): boolean {
  const key = pdtColumnKey(column);
  if (generatedColumn(column)) return false;
  if (canonicalSheetKey(sheetName) === canonicalSheetKey("Material Master Data")) {
    return [
      "CNS_ELECTRO_MATERIAL",
      "CNS_MASSEXACT",
      "BAB577",
      "BAF016",
      "BAA020",
      "AAF040",
      "CERTIFICATION",
      "AAU731",
      "AAU732",
      "AAU733",
      "AAW338"
    ].includes(key);
  }
  return /\b(voltage|current|power|loss|weight|mass|material|colour|color|protection|degree|temperature|dimension|width|height|depth|length|connection|standard|certificate|approval)\b/i.test(
    `${column.code} ${column.propName} ${column.description}`
  );
}

function generatedColumn(column: PdtColumn): boolean {
  const keys = propertyKeysForColumn(column);
  return keys.some((key) =>
    [
      "AAO676",
      "CNSORDERNO",
      "ABA671",
      "AAO677",
      "MANUFACTURER_URL",
      "ABA669",
      "AAQ326",
      "AAY811",
      "AAO057",
      "AAC314",
      "00001C001"
    ].includes(key)
  );
}

function attributeSupportsValue(attr: AttributeRecord, value: string, column: PdtColumn): boolean {
  if (!cleanString(attr.value)) return false;
  const labelCompatible =
    metadataLabelMatches(normalizedMetadataLabel(descriptionWithoutEnumLegend(column.description)), normalizedMetadataLabel(`${attr.group ?? ""} ${attr.name}`)) ||
    semanticPdtLabelCompatible(column, attr);
  if (labelCompatible && derivedResolverValue(value)) return true;

  const attrValue = comparableCellValue(attr.value);
  const resolved = comparableCellValue(value);
  if (!attrValue || !resolved) return false;
  if (!(attrValue === resolved || attrValue.includes(resolved) || resolved.includes(attrValue))) return false;
  if (!productSpecColumn("", column)) return true;
  return labelCompatible;
}

function semanticPdtLabelCompatible(column: PdtColumn, attr: AttributeRecord): boolean {
  const columnText = normalizedMetadataLabel(`${column.code} ${column.propName} ${descriptionWithoutEnumLegend(column.description)}`);
  const attrText = normalizedMetadataLabel(`${attr.group ?? ""} ${attr.name}`);
  const pairs: Array<[RegExp, RegExp]> = [
    [/\bvoltage\b/, /\b(voltage|spannung|volt)\b/],
    [/\bcurrent\b/, /\b(current|amp|amperage|strom)\b/],
    [/\bpower\b|\bloss\b/, /\b(power|loss|consumption|horse power|horsepower|hp|watt)\b/],
    [/\bmounting\b|\brail\b/, /\b(mounting|rail|din)\b/],
    [/\bconnection\b|\bterminal\b/, /\b(connection|terminal|wire|conductor|ring|screw|spring)\b/],
    [/\bmaterial\b/, /\b(material|housing|body|jacket|sheath|enclosure|construction|carbon|stainless|aluminum|aluminium|steel)\b/],
    [/\btemperature\b|\btemp\b/, /\b(temperature|temp|amb(?:ient)?\s*air\s*tem)\b/],
    [/\bprotection\b|\bip\b|\bnema\b/, /\b(protection|ip|nema|enclosure|industry\s*standard|standards?)\b/],
    [/\bcolou?r\b|\bfinish\b|\bral\b/, /\b(colou?r|finish|paint|coat|powder|ral|ansi)\b/],
    [/\b(?:wall|housing)\s*thickness\b|\bthickness\b|\bgauge\b/, /\b(thickness|gauge|construction|wall|steel)\b/],
    [/\bdeclaration\b|\bcertificate\b|\bapproval\b/, /\b(declaration|certificate|approval|rohs|reach|standard)\b/],
    [/\b(?:actuation|voltage type|current type)\b/, /\b(voltage|current|spannung|volt|control circuit|operation)\b/],
    [/\bpole\b/, /\b(pole|poles)\b/]
  ];
  return pairs.some(([columnPattern, attrPattern]) => columnPattern.test(columnText) && attrPattern.test(attrText));
}

function derivedResolverValue(value: string): boolean {
  return /^(?:yes|no|ac|dc|ac\/dc|ring cable connection|screw connection|spring pulley connection|plug\/coupler)$/i.test(value.trim()) ||
    /^-?\d+(?:\.\d+)?(?:\s*-\s*-?\d+(?:\.\d+)?)?$/.test(value.trim());
}

function propertyKeysForColumn(column: PdtColumn): string[] {
  const keys = new Set<string>();
  for (const raw of [column.code, column.propName]) {
    const normalized = raw?.trim().toUpperCase();
    if (!normalized) continue;
    keys.add(normalized.replace(/^"+|"+$/g, "").replace(/\s*\([^)]*\)\s*$/g, "").replace(/\*+$/g, ""));
    for (const part of normalized.split("/")) {
      const trimmed = part.trim();
      if (trimmed) keys.add(trimmed.replace(/^"+|"+$/g, ""));
    }
  }
  return [...keys];
}

function comparableCellValue(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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
    .filter(({ name, groupedName }) => labels.some((label) => metadataLabelMatches(label, name) || metadataLabelMatches(label, groupedName)));
  if (candidates.length === 0) return undefined;

  candidates.sort(
    (left, right) =>
      sourceRank(right.attribute.sourceType) - sourceRank(left.attribute.sourceType) ||
      metadataMatchScore(labels, right.name, right.groupedName) - metadataMatchScore(labels, left.name, left.groupedName)
  );
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
    .replace(/\brating\b/gi, "rated")
    .replace(/\bratings\b/gi, "rated")
    .replace(/\bcolou?r\b/gi, "color")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\bthe\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function metadataLabelMatches(target: string, candidate: string): boolean {
  if (target === candidate) return true;
  const targetTokens = metadataTokens(target);
  const candidateTokens = metadataTokens(candidate);
  if (targetTokens.length < 2 || candidateTokens.length < 2) return false;
  const targetSet = new Set(targetTokens);
  const candidateSet = new Set(candidateTokens);
  if (targetTokens.every((token) => candidateSet.has(token))) return true;
  if (candidateTokens.every((token) => targetSet.has(token))) return true;
  const overlap = targetTokens.filter((token) => candidateSet.has(token));
  return overlap.length >= 2 && overlap.some((token) => IMPORTANT_METADATA_TOKENS.has(token));
}

function metadataMatchScore(labels: string[], name: string, groupedName: string): number {
  let best = 0;
  for (const label of labels) {
    for (const candidate of [name, groupedName]) {
      if (label === candidate) best = Math.max(best, 100);
      else if (metadataLabelMatches(label, candidate)) best = Math.max(best, metadataTokens(label).filter((token) => metadataTokens(candidate).includes(token)).length * 10);
    }
  }
  return best;
}

const METADATA_STOPWORDS = new Set(["of", "the", "and", "for", "with", "to", "in", "by", "manufacturer", "product", "value"]);
const IMPORTANT_METADATA_TOKENS = new Set([
  "voltage",
  "current",
  "power",
  "frequency",
  "weight",
  "mass",
  "width",
  "height",
  "depth",
  "length",
  "material",
  "surface",
  "finish",
  "color",
  "protection",
  "certificate",
  "certification",
  "approval",
  "mounting",
  "connection",
  "temperature",
  "poles"
]);

function metadataTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.replace(/s$/i, ""))
    .filter((token) => token.length > 1 && !METADATA_STOPWORDS.has(token));
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

function removeTemplateLabelColumn(ws: ExcelJS.Worksheet): void {
  const labels = ["classid", "priority", "type", "propertyid", "propertyname", "description", "unit", "body"];
  const hasLabelColumn = labels.every((label, index) => {
    const value = ws.getCell(index + 1, 1).value;
    return typeof value === "string" && value.trim().toLowerCase() === label;
  });
  if (hasLabelColumn) ws.spliceColumns(1, 1);
}
