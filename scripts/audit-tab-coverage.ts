import ExcelJS from "exceljs";
import path from "node:path";
import { deviceSheetsFor } from "../src/server/pdt/device-sheet-map.js";
import { knownDeviceTypes } from "../src/server/scrapers/device-type.js";

// Source the list from the classifier so tab coverage cannot drift from classification rules.
const KNOWN_TYPES = knownDeviceTypes();

// Tabs that exist in the master PDT but are NOT device-type product tabs (metadata, ECAD
// library, helper sheets, sustainability reporting). We deliberately do not map any device type
// to these. Listed here so the audit can show them as "knowingly unused".
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
const masterTabs = wb.worksheets.map((ws) => ws.name);

// Index of which device types target which tabs.
const tabToTypes = new Map<string, string[]>();
for (const type of KNOWN_TYPES) {
  for (const tab of deviceSheetsFor(type)) {
    if (!tabToTypes.has(tab)) tabToTypes.set(tab, []);
    tabToTypes.get(tab)!.push(type);
  }
}

console.log("=== Master PDT tab coverage ===\n");
const lowerToCanonical = new Map<string, string>();
for (const tab of masterTabs) lowerToCanonical.set(tab.trim().toLowerCase(), tab);

let mapped = 0;
let nonDevice = 0;
let orphaned = 0;
for (const tab of masterTabs) {
  if (NON_DEVICE_TABS.has(tab)) {
    nonDevice += 1;
    console.log(`  [SKIP] ${tab}  - intentionally non-device tab`);
    continue;
  }
  const types = tabToTypes.get(tab) ?? [];
  if (types.length === 0) {
    orphaned += 1;
    console.log(`  [GAP ] ${tab}  - NO device type maps to this tab`);
  } else {
    mapped += 1;
    console.log(`  [OK  ] ${tab}  <- ${types.join(", ")}`);
  }
}

console.log(`\nTotal tabs: ${masterTabs.length}`);
console.log(`  Mapped (device-product): ${mapped}`);
console.log(`  Non-device (skipped):    ${nonDevice}`);
console.log(`  Orphaned (no mapping):   ${orphaned}`);

// Verify every device-type -> tab mapping points at an actual tab in the master workbook.
console.log("\n=== Sanity check: device types pointing at missing tabs ===");
let missingTargets = 0;
let unmappedTypes = 0;
let nonDeviceTargets = 0;
for (const type of KNOWN_TYPES) {
  const targets = deviceSheetsFor(type);
  if (targets.length === 0) {
    unmappedTypes += 1;
    console.log(`  ${type} -> NO DEVICE TAB`);
    continue;
  }
  for (const tab of targets) {
    if (!lowerToCanonical.has(tab.trim().toLowerCase())) {
      missingTargets += 1;
      console.log(`  ${type} -> "${tab}"  - TAB DOES NOT EXIST IN MASTER PDT`);
    }
    if (NON_DEVICE_TABS.has(tab)) {
      nonDeviceTargets += 1;
      console.log(`  ${type} -> "${tab}"  - TARGET IS LISTED AS NON-DEVICE TAB`);
    }
  }
}
if (missingTargets === 0 && unmappedTypes === 0 && nonDeviceTargets === 0) {
  console.log("  (clean - every known type maps to an existing device tab)");
}

if (orphaned > 0 || missingTargets > 0 || unmappedTypes > 0 || nonDeviceTargets > 0) {
  process.exitCode = 1;
}
