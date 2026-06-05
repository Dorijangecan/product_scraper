import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ManufacturerConfig, ProductResult, RunItemRecord } from "../src/shared/types.js";
import { deviceSheetsFor } from "../src/server/pdt/device-sheet-map.js";
import { exportRunPdt } from "../src/server/pdt/exporter.js";
import { cellText } from "../src/server/pdt/sheet-descriptor.js";
import { knownDeviceTypes } from "../src/server/scrapers/device-type.js";

const manufacturer = {
  id: "audit",
  canonicalName: "PDT Audit Manufacturer",
  shortName: "PDT-AUDIT",
  rateLimitMs: 0,
  officialBaseUrls: ["https://audit.example.test"],
  fallbackSources: []
} as ManufacturerConfig;

const templatePath = path.resolve("templates", "master_pdt.xlsx");
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-pdt-export-audit-"));
const outputPath = path.join(outputDir, "audit-output.xlsx");
const deviceTypes = knownDeviceTypes();
const expectedCounts = new Map<string, number>();
const expectedCatalogsBySheet = new Map<string, string[]>();

const items = deviceTypes.map((deviceType, index) => {
  const catalogNumber = `AUDIT-${String(index + 1).padStart(3, "0")}`;
  for (const sheetName of deviceSheetsFor(deviceType)) {
    expectedCounts.set(sheetName, (expectedCounts.get(sheetName) ?? 0) + 1);
    const catalogs = expectedCatalogsBySheet.get(sheetName) ?? [];
    catalogs.push(catalogNumber);
    expectedCatalogsBySheet.set(sheetName, catalogs);
  }
  return itemFor(deviceType, catalogNumber, index + 1);
});

const result = await exportRunPdt({ manufacturer, items, templatePath, outputPath });
const failures: string[] = [];

check(result.missingSheets.length === 0, `Missing sheets: ${result.missingSheets.join(", ")}`);
check(result.unmappedDeviceTypes.length === 0, `Unmapped device types: ${result.unmappedDeviceTypes.join(", ")}`);
check(
  result.unclassifiedCatalogNumbers.length === 0,
  `Unclassified catalog numbers: ${result.unclassifiedCatalogNumbers.join(", ")}`
);
check(
  result.writeIssues.length === 0,
  `Write issues: ${result.writeIssues
    .map((issue) => `${issue.sheetName}/${issue.catalogNumber}/${issue.code}=${issue.value} (${issue.reason})`)
    .join("; ")}`
);
check(
  result.filledSheets["Material Master Data"] === items.length,
  `Material Master Data wrote ${result.filledSheets["Material Master Data"] ?? 0}, expected ${items.length}`
);
check(
  (result.filledSheets["Additional Documents"] ?? 0) >= items.length,
  `Additional Documents wrote ${result.filledSheets["Additional Documents"] ?? 0}, expected at least ${items.length}`
);
for (const [sheetName, count] of expectedCounts) {
  check(result.filledSheets[sheetName] === count, `${sheetName} wrote ${result.filledSheets[sheetName] ?? 0}, expected ${count}`);
}

const expectedKeptSheets = new Set([
  "Material Master Data",
  "Additional Documents",
  "Connection Point Information",
  "Product Accessory",
  ...expectedCounts.keys()
]);
check(
  sameSet(new Set(result.keptSheets), expectedKeptSheets),
  `Kept sheets differ. Actual=${sortStrings(result.keptSheets).join(", ")}`
);
check(!result.keptSheets.includes("connector.optical"), "connector.optical must not be retained in final PDT");
check(Boolean(result.pdtAuditPath), "PDT cell audit JSON path was not returned");
check((result.cellAudit?.written ?? 0) > 0, "PDT cell audit did not record written cells");
const unprovenWritten = result.cellAudit.records.filter((record) => record.status === "written" && record.sourceKind === "unproven");
check(
  unprovenWritten.length === 0,
  `Unproven PDT values were written: ${formatAuditRecords(unprovenWritten)}`
);
const generatedSpecWrites = result.cellAudit.records.filter(
  (record) => record.status === "written" && record.sourceKind === "generated-rule" && productSpecAuditRecord(record)
);
check(
  generatedSpecWrites.length === 0,
  `Generated rules wrote product-spec cells: ${formatAuditRecords(generatedSpecWrites)}`
);

const out = new ExcelJS.Workbook();
await out.xlsx.readFile(outputPath);
const allCatalogs = items.map((item) => item.catalogNumber);

checkCatalogs("Material Master Data", allCatalogs);
checkCatalogs("Additional Documents", allCatalogs);
for (const [sheetName, expectedCatalogs] of expectedCatalogsBySheet) {
  checkCatalogs(sheetName, expectedCatalogs);
  checkDeviceRowsHaveValues(sheetName, expectedCatalogs);
}

const connectionWs = out.getWorksheet("Connection Point Information");
check(Boolean(connectionWs), "Connection Point Information placeholder sheet is missing");
if (connectionWs) {
  const connectionCatalogs = catalogsInWorksheet(connectionWs, allCatalogs);
  check(
    connectionCatalogs.length === 0,
    `Connection Point Information should be skipped, but contains generated catalogs: ${connectionCatalogs.join(", ")}`
  );
}

console.log("=== PDT export audit ===");
console.log(`  Known device types:       ${deviceTypes.length}`);
console.log(`  Device tabs used:         ${expectedCounts.size}`);
console.log(`  Output workbook:          ${outputPath}`);
console.log(`  Removed template sheets:  ${result.removedSheetCount}`);

if (failures.length > 0) {
  console.error("\nPDT export audit failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("  (clean - real Master PDT export routes every known type into common tabs and mapped device tabs)");
}

function itemFor(deviceType: string, catalogNumber: string, id: number): RunItemRecord {
  const attribute = (name: string, value: string) => ({
    group: "Audit Technical",
    name,
    value,
    sourceType: "official" as const
  });
  const result: ProductResult = {
    manufacturerId: manufacturer.id,
    catalogNumber,
    status: "found",
    confidence: 0.9,
    title: deviceType,
    productUrl: `https://audit.example.test/products/${catalogNumber}`,
    normalized: { voltage: "24 V DC", current: "2 A", weight: "1 kg" },
    attributes: [
      { group: "General", name: "Product Type", value: deviceType, sourceType: "official" },
      attribute("Rated voltage", "24 V"),
      attribute("Rated current", "2 A"),
      attribute("Operating temperature", "-25...+60 C"),
      attribute("Application standards", "IEC 60947"),
      attribute("Device type", "Assembly")
    ],
    documents: [],
    sources: []
  };
  return {
    id,
    runId: "pdt-export-audit",
    rowIndex: id,
    catalogNumber,
    status: "found",
    result,
    updatedAt: new Date().toISOString()
  };
}

function checkDeviceRowsHaveValues(sheetName: string, catalogs: string[]): void {
  const ws = out.getWorksheet(sheetName);
  if (!ws) return;
  for (const catalog of catalogs) {
    const row = rowValuesContaining(ws, catalog);
    const hasAuditReasons = (result.cellAudit?.records ?? []).some(
      (record) => record.sheetName === sheetName && record.catalogNumber === catalog && record.status !== "written"
    );
    check(
      row.length >= 2 || hasAuditReasons,
      `${sheetName}/${catalog} has only ${row.length} populated cells and no PDT cell-audit reason for blanks`
    );
  }
}

function checkCatalogs(sheetName: string, expected: string[]): void {
  const ws = out.getWorksheet(sheetName);
  check(Boolean(ws), `Expected output sheet ${sheetName} is missing`);
  if (!ws) return;
  const actual = catalogsInWorksheet(ws, allCatalogs);
  check(
    sameArray(sortStrings(actual), sortStrings([...expected])),
    `${sheetName} catalogs differ. Actual=${sortStrings(actual).join(", ")} Expected=${sortStrings(expected).join(", ")}`
  );
}

function rowValuesContaining(ws: ExcelJS.Worksheet, value: string): string[] {
  let values: string[] = [];
  ws.eachRow((row) => {
    const rowValues: string[] = [];
    row.eachCell((cell) => {
      const text = cellText(cell.value);
      if (text) rowValues.push(text);
    });
    if (rowValues.includes(value)) values = rowValues;
  });
  return values;
}

function catalogsInWorksheet(ws: ExcelJS.Worksheet, catalogs: string[]): string[] {
  const catalogSet = new Set(catalogs);
  const found = new Set<string>();
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      const text = cellText(cell.value);
      if (catalogSet.has(text)) found.add(text);
    });
  });
  return sortStrings([...found]);
}

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function productSpecAuditRecord(record: { sheetName: string; code: string; propName: string; description: string }): boolean {
  const key = (record.code || record.propName).trim().toUpperCase();
  if (["AAO676", "CNSORDERNO", "ABA671", "AAO677", "MANUFACTURER_URL", "ABA669", "AAQ326", "AAY811", "AAO057", "AAC314", "00001C001"].includes(key)) {
    return false;
  }
  if (record.sheetName === "Material Master Data") {
    return ["CNS_ELECTRO_MATERIAL", "CNS_MASSEXACT", "BAB577", "BAF016", "BAA020", "AAF040", "CERTIFICATION", "AAU731", "AAU732", "AAU733", "AAW338"].includes(key);
  }
  return /\b(voltage|current|power|loss|weight|mass|material|colour|color|protection|degree|temperature|dimension|width|height|depth|length|connection|standard|certificate|approval)\b/i.test(
    `${record.code} ${record.propName} ${record.description}`
  );
}

function formatAuditRecords(records: Array<{ sheetName: string; catalogNumber: string; code: string; propName: string; value?: string; reason: string }>): string {
  return records
    .slice(0, 20)
    .map((record) => `${record.sheetName}/${record.catalogNumber}/${record.code || record.propName}=${record.value ?? ""} (${record.reason})`)
    .join("; ");
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortStrings(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
