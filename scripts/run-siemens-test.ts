import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { RunManager } from "../src/server/run-manager.js";

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `siemens-test-${stamp}`;
}

async function main() {
  const inputPath = path.resolve(process.argv[2] ?? "C:/Users/dgecan/Downloads/Siemens.csv");
  const raw = await fs.readFile(inputPath, "utf8");
  let catalogNumbers = raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, "").trim())
    .filter((value) => value && !/^catalog|^part|^article|^number$/i.test(value));

  const limit = Number(process.env.SIE_LIMIT ?? "0");
  if (limit > 0) catalogNumbers = catalogNumbers.slice(0, limit);
  if (!catalogNumbers.length) throw new Error(`No catalog numbers found in ${inputPath}`);

  const appPaths = createAppPaths(process.cwd());
  const { initializeManufacturerConfig } = await import("../src/server/config/manufacturers.js");
  initializeManufacturerConfig(appPaths.dataDir);
  const db = new ScraperDb(appPaths);
  const runManager = new RunManager(db, appPaths);
  const downloads = process.env.SIE_DOWNLOADS === "1";

  try {
    const run = db.createRun({
      id: createRunId(),
      manufacturerId: "siemens",
      inputFileName: path.basename(inputPath),
      catalogNumbers,
      options: downloads
        ? { downloadDocuments: true, downloadPdfs: true, downloadImages: true, generateExcel: true }
        : { downloadDocuments: false, downloadPdfs: false, downloadImages: false, generateExcel: true }
    });
    console.log(`Started SIEMENS run ${run.id} for ${catalogNumbers.length} products (downloads=${downloads})`);
    await runManager.processRun(run.id);

    const items = db.getRunItems(run.id);
    const dumpPath = path.join(os.tmpdir(), `siemens-full-${run.id}.json`);
    await fs.writeFile(dumpPath, JSON.stringify(items.map((i) => i.result), null, 2), "utf8");
    console.log(`Full results written to ${dumpPath}`);
    console.log(
      JSON.stringify(
        items.map((item) => ({
          catalogNumber: item.catalogNumber,
          status: item.status,
          confidence: item.confidence,
          error: item.error,
          title: item.title,
          attrs: item.result?.attributes.length ?? 0,
          datasheets: item.result?.documents.filter((d) => d.type === "datasheet").length ?? 0,
          dsParse: item.result?.documents.filter((d) => d.type === "datasheet").map((d) => d.parseStatus),
          voltage: item.result?.normalized.voltage,
          weight: item.result?.normalized.weight,
          url: item.productUrl
        })),
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
