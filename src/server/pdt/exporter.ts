import ExcelJS from "exceljs";
import type { AttributeRecord, ManufacturerConfig, PdtSheetOverrides, RunItemRecord } from "../../shared/types.js";
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
  requiredFieldIssues: PdtRequiredFieldIssue[];
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

  for (const item of included) {
    const deviceType = classifyDeviceType(item.result).type;
    if (!deviceType) unclassifiedCatalogNumbers.add(item.catalogNumber);
    const userOverride = sheetOverrides?.[item.id];
    const builtIn = overrideDeviceSheetsForItem(item, manufacturer);
    // User overrides win over the built-in (ABB 1SDA) rule; both replace device-type auto routing.
    const override = userOverride && userOverride.length > 0 ? userOverride : builtIn;
    const sheets = override
      ? [...CONSTANT_SHEETS, ...override]
      : [...targetSheets(deviceType), ...additionalDeviceSheetsForItem(item, manufacturer)];
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
    filledSheets[sheetName] = writeUniformSheet(ws, sheetMembers, manufacturer, repairs, writeIssues, requiredFieldIssues);
  }

  const documentsWs = workbook.getWorksheet(resolveSheetName(DOCUMENTS_SHEET) ?? DOCUMENTS_SHEET);
  let documentRows = 0;
  if (documentsWs) {
    documentRows = writeDocumentsSheet(documentsWs, included);
    filledSheets[documentsWs.name] = documentRows;
  } else {
    missingSheets.add(DOCUMENTS_SHEET);
  }

  // Connection Point Information stays as a template placeholder for now — the manual PDT keeps it
  // present but unfilled, and the auto-fill produces too many speculative rows to be useful yet.
  // (The tab itself is kept in the workbook via ALWAYS_KEPT_SHEETS below.)

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
    requiredFieldIssues,
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
  writeIssues: PdtWriteIssue[],
  requiredFieldIssues: PdtRequiredFieldIssue[]
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
      const writtenRequiredColumns = new Set<number>();
      for (const column of descriptor.columns) {
        if (!isColumnAllowedForItem(ws.name, item, manufacturer, column)) continue;
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
        if (isTrackedRequiredPdtColumn(ws.name, column)) writtenRequiredColumns.add(column.col);
        wroteCell = true;
      }
      for (const column of descriptor.columns) {
        if (!isColumnAllowedForItem(ws.name, item, manufacturer, column)) continue;
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

function additionalDeviceSheetsForItem(_item: RunItemRecord, _manufacturer: ManufacturerConfig): string[] {
  return [];
}

/** Hard override: when set, REPLACES device-type sheets entirely (only constant tabs + these are written). */
function overrideDeviceSheetsForItem(item: RunItemRecord, manufacturer: ManufacturerConfig): string[] | null {
  const isAbb = manufacturer.id === "abb" || item.result?.manufacturerId === "abb";
  if (isAbb && /^1SDA/i.test(item.catalogNumber)) return ["contactor a. fuses"];
  return null;
}

/**
 * Column-level allowlist for specific (manufacturer, catalog-pattern, sheet) combos. Returns true
 * when the column should be written for this item. Mirrors the manual PDT layout — e.g. ABB Emax 3
 * accessories on `contactor a. fuses` only carry ECLASS group/version, article number, and the
 * actual rated voltage / voltage type when present. Everything else (generic compliance markers,
 * scraped color, IP rating, etc.) is suppressed to avoid writing junk into ill-suited columns.
 */
function isColumnAllowedForItem(
  sheetName: string,
  item: RunItemRecord,
  manufacturer: ManufacturerConfig,
  column: PdtColumn
): boolean {
  const isAbb = manufacturer.id === "abb" || item.result?.manufacturerId === "abb";
  if (isAbb && /^1SDA/i.test(item.catalogNumber) && canonicalSheetKey(sheetName) === canonicalSheetKey("contactor a. fuses")) {
    const allowed = new Set([
      "REFERENCE_FEATURE_GROUP_ID",
      "REFERENCE_FEATURE_SYSTEM_NAME",
      "AAO676", // article number
      "BAH005", // rated voltage
      "BAD915"  // voltage type
    ]);
    return allowed.has(column.code);
  }
  return true;
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

function uniformRowVariantsFor(sheetName: string, item: RunItemRecord, ctx: ResolveContext): Array<Record<string, string> | undefined> {
  const sheetKey = canonicalSheetKey(sheetName);

  // ---- "cabinet" sheet: family-level defaults that the manual PDT operators fill ----
  if (sheetKey === "cabinet") {
    // Eaton ProfiSNAP families (PSN-*) share the same minimum cabinet defaults across all
    // sub-series: steel body + steel internal, powder-coated surface. The manual PDTs fill at
    // least these three so the cabinet tab isn't blank. We don't hardcode the ECLASS group id —
    // each PSN sub-family uses a different one and the resolver will fall back to the article's
    // scraped ECLASS code.
    if (item.result?.manufacturerId === "eaton") {
      const model = (eatonModelCode(item.result) ?? resolveProperty("CNSTYPECODE", "CNSTYPECODE", ctx) ?? "").toUpperCase();
      if (/^PSN-/i.test(model)) {
        return [{
          AAO676: item.catalogNumber,
          BAB664: "Steel",        // material
          BAF634: "Steel",        // (duplicate ECLASS code for material)
          BAF785: "Powder coating" // surface
        }];
      }
    }
    // Saginaw H_LP enclosures use a consistent set of family defaults (carbon steel powder-coated
    // body, IP66, NEMA Type 3R/4/4X/12/13, 1 front door, 2 locks). The manual PDTs fill these for
    // every H_LP article — we mirror them here so the generated PDT isn't blank in the cabinet tab.
    if (item.result?.manufacturerId === "sce" && /^SCE-\d+H\d+LP$/i.test(item.catalogNumber)) {
      return [{
        AAO676: item.catalogNumber,
        REFERENCE_FEATURE_GROUP_ID: "27180101",
        AAB681: "2",       // suitable for metric installation: Yes
        AAC265: "1",       // back door present: No (front-door-only)
        AAC929: "1",       // Number of doors: 1
        AAF507: "1",       // REACH registration present: No
        AAM117: "1",       // glazed door present: No
        AAM272: "2",       // wall build-in possible: Yes
        AAO191: "1",       // RoHS attention of conformity: No
        AAP429: "1",       // Number of front doors: 1
        AAP542: "2",       // Number of locks: 2
        BAA105: "2",       // Number of locks (duplicate ECLASS code): 2
        BAD290: "2",       // Assembly on floor is possible: Yes
        BAD308: "2",       // Wall assembly possible: Yes
        BAF728: "1",       // Mounting plate present: No
        AAW361: "NEMA Type 3R, 4, 4X, 12 and Type 13",
        AAZ486: "NEMA Type 3R, 4, 4X, 12 and Type 13",
        BAB664: "Carbon steel",
        BAC295: "White",
        BAF634: "Carbon steel",
        BAF785: "Powder coating",
        BAG975: "IP66"
      }];
    }
    return [undefined];
  }

  if (sheetKey !== "cabinet.mechanical") return [undefined];

  if (item.result?.manufacturerId === "eaton") {
    const model = (eatonModelCode(item.result) ?? resolveProperty("CNSTYPECODE", "CNSTYPECODE", ctx) ?? "").toUpperCase();
    if (/^PSN-FP-.+MU\b/.test(model)) {
      // Manual PDT for psn_fp_mu uses rows for p1, p2, p3 plus a final asmtab assembly row.
      // ECLASS 27400608, all rows tagged Plate@1.
      return ["psn_fp_mu_p1.prj", "psn_fp_mu_p2.prj", "psn_fp_mu_p3.prj", "psn_fp_mu_asmtab.prj"].map((proj) => ({
        AAO676: item.catalogNumber,
        REFERENCE_FEATURE_GROUP_ID: "27400608",
        CNS_PROJECT_PATH: proj,
        CNS_COMPONENT_GROUP: "Plate@1"
      }));
    }
    if (/^PSN-FPS\b/.test(model)) {
      // Manual PDT for psn_fps uses p1, p2, p3, asmtab (4 rows). ECLASS 27180907 in the variant
      // with project paths; 27182811 for the simple EP-prefixed variant (which uses 1 row).
      // The EP- prefix is applied to the article number per the manual PDT.
      return ["psn_fps_p1.prj", "psn_fps_p2.prj", "psn_fps_p3.prj", "psn_fps_asmtab.prj"].map((proj) => ({
        AAO676: `EP-${item.catalogNumber.replace(/^EP-/i, "")}`,
        REFERENCE_FEATURE_GROUP_ID: "27180907",
        CNS_PROJECT_PATH: proj,
        CNS_COMPONENT_FUNCTION_3D: "Bracket",
        CNS_COMPONENT_GROUP: "Bracket@1",
        "000038001": "Assembly.VariantParts"
      }));
    }
    // PSN-MT (DIN-rail mounting strip) — single row, ECLASS 27182811, Rail@1.
    if (/^PSN-MT\b/.test(model)) {
      return [{
        AAO676: item.catalogNumber,
        REFERENCE_FEATURE_GROUP_ID: "27182811",
        CNS_PROJECT_PATH: "psn_drs_mt.prj",
        CNS_COMPONENT_GROUP: "Rail@1"
      }];
    }
    // PSN-FP-NZM* / PSN-FP/S-NZM* (front-plate NZM) — single row, ECLASS 27182806, Plate@1.
    if (/^PSN-FP[/-].*NZM/.test(model)) {
      return [{
        AAO676: item.catalogNumber,
        REFERENCE_FEATURE_GROUP_ID: "27182806",
        CNS_PROJECT_PATH: "psn_fp_nzm.prj",
        CNS_COMPONENT_GROUP: "Plate@1"
      }];
    }
    // PSN-PIP-BN (side panel) — single row, ECLASS 27182806, Panel@1.
    if (/^PSN-PIP-BN\b/.test(model)) {
      return [{
        AAO676: item.catalogNumber,
        REFERENCE_FEATURE_GROUP_ID: "27182806",
        CNS_PROJECT_PATH: "psn_pip_bn.prj",
        CNS_COMPONENT_GROUP: "Panel@1"
      }];
    }
  }

  if (item.result?.manufacturerId === "sce") {
    // Saginaw H_LP enclosures (e.g. SCE-12H2408LP, SCE-16H1206LP) expand into 5 mechanical
    // sub-component rows in the manual PDT: body, door, mounting bracket, lock, assembly.
    // Each row carries its own ECLASS group id (REFERENCE_FEATURE_GROUP_ID), project path,
    // component function/group, and 000038001 label, per the h_lp_asmtab template.
    if (/^SCE-\d+H\d+LP$/i.test(item.catalogNumber)) {
      return [
        { project: "h_lp_base", eclass: "27180101", func: "Body", group: "Frame@1", label: "Body" },
        { project: "h_lp_door", eclass: "27182204", func: "Door", group: "Door@1", label: "Door" },
        { project: "mnt_ears", eclass: "27182811", func: "Bracket", group: "Bracket@1", label: "Bracket" },
        { project: "lp_clamp", eclass: "27400641", func: "Door lock", group: "Door lock@2", label: "Lock system" },
        { project: "h_lp_asmtab", eclass: "27180101", func: "Assembly.Enclosure", group: "Enclosure@1", label: "Assembly.Enclosure" }
      ].map((row) => ({
        AAO676: item.catalogNumber,
        REFERENCE_FEATURE_GROUP_ID: row.eclass,
        CNS_PROJECT_PATH: row.project,
        CNS_COMPONENT_FUNCTION_3D: row.func,
        CNS_COMPONENT_GROUP: row.group,
        "000038001": row.label
      }));
    }
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
