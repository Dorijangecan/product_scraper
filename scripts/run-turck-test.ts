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
  return `turck-test-${stamp}`;
}

async function main() {
  const argCatalogs = process.argv.slice(2).filter((value) => value && !value.startsWith("-"));
  const catalogNumbers = argCatalogs.length
    ? argCatalogs
    : ["NI12U-EG18SK-VP4X", "BI3U-EG12SK-VP4X"];

  const appPaths = createAppPaths(process.cwd());
  initializeManufacturerConfig(appPaths.dataDir);
  const db = new ScraperDb(appPaths);
  const runManager = new RunManager(db, appPaths);

  try {
    const run = db.createRun({
      id: createRunId(),
      manufacturerId: "turck",
      inputFileName: "turck-test.csv",
      catalogNumbers,
      options: { downloadDocuments: true, downloadPdfs: true }
    });

    console.log(`Started Turck run ${run.id} for ${catalogNumbers.length}: ${catalogNumbers.join(", ")}`);
    await runManager.processRun(run.id);

    const items = db.getRunItems(run.id);

    await fs.writeFile(
      path.resolve("scratch-turck-full.json"),
      JSON.stringify(items.map((i) => i.result), null, 2),
      "utf8"
    );

    try {
      const manufacturer = getManufacturerConfig("turck");
      if (!manufacturer) throw new Error("turck manufacturer config not found");
      const templatePath = resolveTemplatePath();
      const outputPath = path.resolve("scratch-turck_PDT.xlsx");
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
          description: item.result?.description,
          productUrl: item.productUrl,
          confidence: item.confidence,
          normalized: item.result?.normalized,
          attributes: item.result?.attributes.length ?? 0,
          documents: item.result?.documents.map((d) => ({ type: d.type, label: d.label, url: d.url })) ?? []
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
