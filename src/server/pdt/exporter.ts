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
import { writeConnectionPointsSheet } from "./connection-points-sheet.js";

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

  // Fill connection points only for manufacturers with PDT-example-backed connection rules.

  const connectionPointsWs = workbook.getWorksheet(resolveSheetName("Connection Point Information") ?? "Connection Point Information");
  if (connectionPointsWs) {
    const connectionPointRows = writeConnectionPointsSheet(connectionPointsWs, included.filter(shouldWriteConnectionPointsForItem));
    if (connectionPointRows > 0) filledSheets[connectionPointsWs.name] = connectionPointRows;
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

function shouldWriteConnectionPointsForItem(item: RunItemRecord): boolean {
  const manufacturerId = item.result?.manufacturerId;
  return manufacturerId === "abb" || manufacturerId === "eaton" || manufacturerId === "rockwell";
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

function additionalDeviceSheetsForItem(item: RunItemRecord, manufacturer: ManufacturerConfig): string[] {
  const isRockwell = manufacturer.id === "rockwell" || item.result?.manufacturerId === "rockwell";
  const text = `${item.catalogNumber} ${item.result?.title ?? ""} ${item.result?.description ?? ""}`;
  if (isRockwell && /\b(?:PowerFlex|755)\b/i.test(text) && classifyDeviceType(item.result).type === "Variable Speed Drive") {
    return ["power supply devices"];
  }
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
      "BAD915", // voltage type
      "AAS575"  // power loss per pole (manual PDT carries it for EMAX accessories when available)
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
      // PSN-DRS-MT / PSN-FPS share a richer set of cabinet defaults in the manual PDTs:
      // NEMA enclosure list, 2 doors, 2 locks, 2 assembly counts. Mirror those here.
      if (/^PSN-(?:DRS-MT|FPS)\b/i.test(model)) {
        return [{
          AAO676: item.catalogNumber,
          BAB664: "Steel",
          BAF634: "Steel",
          BAF785: "Powder coating",
          AAW361: "NEMA Type 3R, 4, 4X, 12 and Type 13",
          AAZ486: "NEMA Type 3R, 4, 4X, 12 and Type 13",
          AAC929: "2",        // Number of doors
          BAA105: "2",        // Number of locks
          BAD290: "2",        // Assembly on floor is possible
          BAD308: "2"         // Wall assembly possible
        }];
      }
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
    const lpplDefaults = sceLpplCabinetDefaults(item.catalogNumber);
    if (item.result?.manufacturerId === "sce" && lpplDefaults) {
      return [lpplDefaults];
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

function sceLpplCabinetDefaults(catalogNumber: string): Record<string, string> | undefined {
  const part = cleanString(catalogNumber) ?? catalogNumber.trim();
  if (!/^SCE-\d+EL\d+(?:SS6|SS)?LPPL$/i.test(part)) return undefined;
  const stainless316 = /SS6LPPL$/i.test(part);
  const stainless304 = !stainless316 && /SSLPPL$/i.test(part);
  const material = stainless316 ? "stainless steel Type 316/316L" : stainless304 ? "stainless steel Type 304" : "Carbon steel";
  const defaults: Record<string, string> = {
    AAO676: part,
    REFERENCE_FEATURE_GROUP_ID: "27180101",
    BAD308: "2", // Wall assembly possible: Yes
    AAW361: "NEMA Type 3R, 4, 12 and Type 13",
    AAZ486: "NEMA Type 3R, 4, 12 and Type 13",
    BAB664: material,
    BAF634: material,
    BAG975: "IP66"
  };
  if (!stainless316 && !stainless304) {
    defaults.BAC295 = "ANSI-61 gray";
    defaults.BAF785 = "Powder coating";
  }
  return defaults;
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

function resolvePdtColumnValue(
  ws: ExcelJS.Worksheet,
  descriptor: { firstBodyRow: number },
  column: PdtColumn,
  ctx: ResolveContext
): string | undefined {
  const variant = rowVariantValue(column, ctx);
  if (variant !== undefined) return variant;
  // For German description columns, resolve with language="de" so description resolvers pull from
  // result.localizedDescriptions.de instead of EN. If no localized DE text exists the resolver
  // returns undefined and the cell stays blank — we no longer fall back to EN→DE translation.
  const resolveCtx: ResolveContext = isGermanDescriptionColumn(ws, descriptor, column)
    ? { ...ctx, language: "de" }
    : ctx;
  const direct =
    resolveProperty(column.code, column.propName, resolveCtx) ??
    resolvePropertyByDescription(column, resolveCtx) ??
    resolvePropertyByColumnMetadata(column, resolveCtx);
  return direct ?? undefined;
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
