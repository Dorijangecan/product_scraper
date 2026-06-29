import fs from "node:fs/promises";
import path from "node:path";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { RunManager } from "../src/server/run-manager.js";
import { getManufacturerConfig, initializeManufacturerConfig } from "../src/server/config/manufacturers.js";
import { exportRunPdt } from "../src/server/pdt/exporter.js";
import { resolveTemplatePath } from "../src/server/pdt/template.js";

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `nvent-test-${stamp}`;
}

async function main() {
  const inputPath = path.resolve(
    process.argv[2] ?? "C:/Users/dgecan/Downloads/Nvent test.csv"
  );
  const raw = await fs.readFile(inputPath, "utf8");
  const catalogNumbers = raw
    .split(/\r?\n/)
    .map((line) => line.split(",")[0]?.trim() ?? "")
    .filter((value) => value && !/^catalog|^part|^article|^number$/i.test(value));

  if (!catalogNumbers.length) throw new Error(`No catalog numbers found in ${inputPath}`);

  const appPaths = createAppPaths(process.cwd());
  initializeManufacturerConfig(appPaths.dataDir);
  const db = new ScraperDb(appPaths);
  const runManager = new RunManager(db, appPaths);

  try {
    const run = db.createRun({
      id: createRunId(),
      manufacturerId: "nvent",
      inputFileName: path.basename(inputPath),
      catalogNumbers,
      options: { downloadDocuments: true }
    });

    console.log(`Started nVent run ${run.id} for ${catalogNumbers.length} products: ${catalogNumbers.join(", ")}`);
    await runManager.processRun(run.id);

    const items = db.getRunItems(run.id);

    // Dump full result of every item for inspection.
    await fs.writeFile(
      path.resolve("scratch-nvent-full.json"),
      JSON.stringify(items.map((i) => i.result), null, 2),
      "utf8"
    );

    // Generate the PDT workbook.
    try {
      const manufacturer = getManufacturerConfig("nvent");
      if (!manufacturer) throw new Error("nvent manufacturer config not found");
      const templatePath = resolveTemplatePath();
      const outputPath = path.resolve("scratch-nvent_PDT.xlsx");
      const pdt = await exportRunPdt({ manufacturer, items, templatePath, outputPath });
      console.log(`PDT written to ${outputPath}`);
      console.log(`PDT filledSheets: ${JSON.stringify(pdt.filledSheets)}`);
      console.log(`PDT requiredFieldIssues: ${pdt.requiredFieldIssues.length}`);
    } catch (err) {
      console.error("PDT export failed:", err);
    }

    console.log(
      JSON.stringify(
        items.map((item) => ({
          catalogNumber: item.catalogNumber,
          status: item.status,
          title: item.title,
          productUrl: item.productUrl,
          confidence: item.confidence,
          stage: item.stage,
          error: item.error,
          attributes: item.result?.attributes.length ?? 0,
          normalized: item.result?.normalized,
          documents: item.result?.documents.length ?? 0,
          images: item.result?.documents.filter((doc) => doc.type === "image").length ?? 0,
          qualityGate: item.result?.qualityGate
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
