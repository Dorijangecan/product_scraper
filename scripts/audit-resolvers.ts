import ExcelJS from "exceljs";
import path from "node:path";
import { describeSheet } from "../src/server/pdt/sheet-descriptor.js";
import { hasPropertyResolver } from "../src/server/pdt/eclass-resolvers.js";

const NON_DEVICE_TABS = new Set([
  "Material Master Data",
  "Additional Documents",
  "Connection Point Information",
  "Carbon Footprint (V2)",
  "Product Carbon Footprint PCF",
  "Carbon Footprint Transport TCF",
  "Critical environ. ingredient",
  "EMC electromag. compatibility",
  "connector.optical",
  "Product Accessory",
  "Help",
  "Sheet11",
  "Tabelle1",
  "Tabelle2",
  "subcircuit",
  "symbol",
  "symbol library",
  "symbol example",
  "PCB Footprint"
]);

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.resolve("templates/master_pdt.xlsx"));

const unmappedByTab: Record<string, Array<{ code: string; name: string; desc: string }>> = {};
const missingDescriptorTabs: string[] = [];
const codeCounts: Record<string, number> = {};
for (const ws of wb.worksheets) {
  if (NON_DEVICE_TABS.has(ws.name)) continue;
  const descriptor = describeSheet(ws);
  if (!descriptor) {
    missingDescriptorTabs.push(ws.name);
    continue;
  }
  const missing: Array<{ code: string; name: string; desc: string }> = [];
  for (const column of descriptor.columns) {
    if (column.code === "ECLASS property") continue;
    if (isTemplatePlaceholder(column.code, column.propName)) continue;
    if (!hasPropertyResolver(column.code, column.propName)) {
      missing.push({ code: column.code, name: column.propName, desc: String(column.description ?? "").slice(0, 80) });
      const key = `${column.code}|${column.propName}`;
      codeCounts[key] = (codeCounts[key] ?? 0) + 1;
    }
  }
  if (missing.length > 0) unmappedByTab[ws.name] = missing;
}

console.log("=== UNMAPPED DEVICE-TAB PROPERTIES BY TAB ===");
const unmappedTabCount = Object.keys(unmappedByTab).length;
if (missingDescriptorTabs.length > 0) {
  console.log("\n--- Device tabs without PDT descriptors ---");
  for (const tab of missingDescriptorTabs) console.log(`  ${tab}`);
}
if (unmappedTabCount === 0 && missingDescriptorTabs.length === 0) {
  console.log("  (clean - every device-tab property has a resolver or is an ignored template placeholder)");
}
for (const [tab, items] of Object.entries(unmappedByTab)) {
  console.log(`\n--- ${tab} (${items.length} unresolved) ---`);
  for (const it of items.slice(0, 40)) {
    console.log(`  ${it.code} / ${it.name}  ${it.desc ? "(" + it.desc + ")" : ""}`);
  }
  if (items.length > 40) console.log(`  ... +${items.length - 40} more`);
}

console.log("\n=== MOST COMMON UNRESOLVED DEVICE-TAB CODES (appear on >=4 tabs) ===");
const common = Object.entries(codeCounts)
  .filter(([, n]) => n >= 4)
  .sort((a, b) => b[1] - a[1]);
if (common.length === 0) console.log("  (clean)");
for (const [key, n] of common) console.log(`  ${n}x ${key}`);

if (unmappedTabCount > 0 || missingDescriptorTabs.length > 0) {
  process.exitCode = 1;
}

function isTemplatePlaceholder(code: string, propName: string): boolean {
  return code.trim() === "-" && propName.trim() === "-";
}
