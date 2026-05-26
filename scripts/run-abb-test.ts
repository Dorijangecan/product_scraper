import fs from "node:fs/promises";
import path from "node:path";
import { extractCatalogNumbers, previewCsv } from "../src/server/csv.js";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { RunManager } from "../src/server/run-manager.js";
import { initializeManufacturerConfig } from "../src/server/config/manufacturers.js";

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `abb-test-${stamp}`;
}

async function main() {
  const inputPath = path.resolve(process.argv[2] ?? path.join("Testing PDT", "ABB test.csv"));
  const buffer = await fs.readFile(inputPath);
  const preview = await previewCsv(buffer);
  const columnName = preview.detectedColumn ?? preview.columns[0];
  if (!columnName) throw new Error(`No catalog-number column detected in ${inputPath}`);

  const catalogNumbers = await extractCatalogNumbers(buffer, columnName);
  if (!catalogNumbers.length) throw new Error(`No catalog numbers found in ${inputPath}`);

  const appPaths = createAppPaths(process.cwd());
  initializeManufacturerConfig(appPaths.dataDir);
  const db = new ScraperDb(appPaths);
  const runManager = new RunManager(db, appPaths);

  try {
    const run = db.createRun({
      id: createRunId(),
      manufacturerId: "abb",
      inputFileName: path.basename(inputPath),
      catalogNumbers,
      options: {
        downloadDocuments: true
      }
    });

    console.log(`Started ABB run ${run.id} for ${catalogNumbers.length} products from ${inputPath}`);
    await runManager.processRun(run.id);

    const finalRun = db.getRun(run.id);
    const items = db.getRunItems(run.id);
    console.log(
      JSON.stringify(
        {
          run: finalRun,
          items: items.map((item) => ({
            catalogNumber: item.catalogNumber,
            status: item.status,
            title: item.title,
            productUrl: item.productUrl,
            confidence: item.confidence,
            stage: item.stage,
            error: item.error,
            documents: item.result?.documents.length ?? 0,
            images: item.result?.documents.filter((doc) => doc.type === "image").length ?? 0,
            downloadedImages:
              item.result?.documents.filter((doc) => doc.type === "image" && doc.downloadStatus === "downloaded").length ?? 0,
            attributes: item.result?.attributes.length ?? 0,
            qualityGate: item.result?.qualityGate,
            finalCompletenessAfterMissing: item.result?.diagnostics?.finalCompleteness?.afterMissing
          }))
        },
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
