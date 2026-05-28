import ExcelJS from "exceljs";
import path from "node:path";
import { describeSheet } from "../src/server/pdt/sheet-descriptor.js";
import { hasPropertyResolver } from "../src/server/pdt/eclass-resolvers.js";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path.resolve("templates/master_pdt.xlsx"));

const unmappedByTab: Record<string, Array<{ code: string; name: string; desc: string }>> = {};
const codeCounts: Record<string, number> = {};
for (const ws of wb.worksheets) {
  const descriptor = describeSheet(ws);
  if (!descriptor) continue;
  const missing: Array<{ code: string; name: string; desc: string }> = [];
  for (const column of descriptor.columns) {
    if (column.code === "ECLASS property") continue;
    if (!hasPropertyResolver(column.code, column.propName)) {
      missing.push({ code: column.code, name: column.propName, desc: String(column.description ?? "").slice(0, 80) });
      const key = `${column.code}|${column.propName}`;
      codeCounts[key] = (codeCounts[key] ?? 0) + 1;
    }
  }
  if (missing.length > 0) unmappedByTab[ws.name] = missing;
}

console.log("=== UNMAPPED PROPERTIES BY TAB ===");
for (const [tab, items] of Object.entries(unmappedByTab)) {
  console.log(`\n--- ${tab} (${items.length} unresolved) ---`);
  for (const it of items.slice(0, 40)) {
    console.log(`  ${it.code} / ${it.name}  ${it.desc ? "(" + it.desc + ")" : ""}`);
  }
  if (items.length > 40) console.log(`  ... +${items.length - 40} more`);
}

console.log("\n=== MOST COMMON UNRESOLVED CODES (appear on >=4 tabs) ===");
const common = Object.entries(codeCounts)
  .filter(([, n]) => n >= 4)
  .sort((a, b) => b[1] - a[1]);
for (const [key, n] of common) console.log(`  ${n}× ${key}`);
