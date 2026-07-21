import fs from "node:fs/promises";
import path from "node:path";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { RunManager } from "../src/server/run-manager.js";

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `gan-test-${stamp}`;
}

async function main() {
  const inputPath = path.resolve(process.argv[2] ?? "C:/Users/dgecan/Downloads/Ganter.csv");
  const raw = await fs.readFile(inputPath, "utf8");
  // Ganter ordering codes can contain a comma (e.g. "GN 6284-...-KU-2,5"), so each line is one
  // catalog number verbatim (just strip surrounding quotes) rather than split on comma.
  let catalogNumbers = raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, "").trim())
    .filter((value) => value && !/^catalog|^part|^article|^number$/i.test(value));

  const limit = Number(process.env.GAN_LIMIT ?? "0");
  if (limit > 0) catalogNumbers = catalogNumbers.slice(0, limit);

  if (!catalogNumbers.length) throw new Error(`No catalog numbers found in ${inputPath}`);

  const appPaths = createAppPaths(process.cwd());
  const { initializeManufacturerConfig } = await import("../src/server/config/manufacturers.js");
  initializeManufacturerConfig(appPaths.dataDir);
  const db = new ScraperDb(appPaths);
  const runManager = new RunManager(db, appPaths);

  try {
    const run = db.createRun({
      id: createRunId(),
      manufacturerId: "gan",
      inputFileName: path.basename(inputPath),
      catalogNumbers,
      options: { downloadDocuments: true, downloadPdfs: true, downloadImages: true }
    });

    console.log(`Started GAN run ${run.id} for ${catalogNumbers.length} products`);
    await runManager.processRun(run.id);

    const items = db.getRunItems(run.id);
    await fs.writeFile(
      path.resolve("scratch-gan-full.json"),
      JSON.stringify(items.map((i) => i.result), null, 2),
      "utf8"
    );

    console.log(
      JSON.stringify(
        items.map((item) => ({
          catalogNumber: item.catalogNumber,
          status: item.status,
          confidence: item.confidence,
          error: item.error,
          attrs: item.result?.attributes.length ?? 0,
          docs: item.result?.documents.length ?? 0,
          datasheets: item.result?.documents.filter((d) => d.type === "datasheet").length ?? 0,
          dsDownloaded: item.result?.documents.filter((d) => d.type === "datasheet" && d.downloadStatus === "downloaded").length ?? 0,
          dsParse: item.result?.documents.filter((d) => d.type === "datasheet").map((d) => d.parseStatus),
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
