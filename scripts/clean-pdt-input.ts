import fs from "node:fs";
import path from "node:path";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { buildPdtRepairResult } from "../src/server/pdt/ai-cleanup.js";
import { writeCleanedInputWorkbook } from "../src/server/pdt/cleaned-input-workbook.js";
import { createAppPaths } from "../src/server/paths.js";
import { buildRunOutputLayout } from "../src/server/run-output.js";

const runId = process.argv[2];
const aiCleanup = process.argv.includes("--ai");

if (!runId || runId === "--help" || runId === "-h") {
  console.log("Usage: npx tsx scripts/clean-pdt-input.ts <run-id> [--ai]");
  process.exit(runId ? 0 : 1);
}

const paths = createAppPaths();
const db = new ScraperDb(paths);

try {
  const run = db.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const manufacturer = getManufacturerConfig(run.manufacturerId);
  if (!manufacturer) throw new Error(`Manufacturer not found: ${run.manufacturerId}`);

  const items = db.getRunItems(run.id).filter((item) => item.result && (item.status === "found" || item.status === "partial"));
  if (items.length === 0) throw new Error("No found or partial products to clean.");

  const layout = buildRunOutputLayout(paths.outputDir, manufacturer, run);
  fs.mkdirSync(layout.excelDir, { recursive: true });
  const pdtOutputPath = path.join(layout.excelDir, `${run.id}_PDT.xlsx`);
  const cleanup = await buildPdtRepairResult(items, manufacturer, { aiCleanup });
  const cleanedPath = await writeCleanedInputWorkbook(pdtOutputPath, cleanup.audit);

  console.log(`Cleaned ${items.length} products`);
  console.log(`AI cleanup: ${aiCleanup ? cleanup.audit.status : "disabled"}`);
  console.log(cleanedPath);
} finally {
  db.close();
}
