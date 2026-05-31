import fs from "node:fs/promises";
import path from "node:path";
import { extractCatalogNumbers, previewCsv } from "../src/server/csv.js";
import { initializeManufacturerConfig, getManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { exportRunPdt } from "../src/server/pdt/exporter.js";
import { resolveTemplatePath } from "../src/server/pdt/template.js";
import { buildRunOutputLayout } from "../src/server/run-output.js";
import { RunManager } from "../src/server/run-manager.js";
import type { AttributeRecord, RunItemRecord } from "../src/shared/types.js";

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `balluff-test-${stamp}`;
}

async function main() {
  const inputPath = path.resolve(process.argv[2] ?? path.join("Testing PDT", "Balluff test.csv"));
  const buffer = await fs.readFile(inputPath);
  const preview = await previewCsv(buffer);
  const columnName = preview.detectedColumn ?? preview.columns[0];
  if (!columnName) throw new Error(`No catalog-number column detected in ${inputPath}`);

  const catalogNumbers = await extractCatalogNumbers(buffer, columnName);
  if (!catalogNumbers.length) throw new Error(`No catalog numbers found in ${inputPath}`);

  const appPaths = createAppPaths(process.cwd());
  initializeManufacturerConfig(appPaths.dataDir);
  const manufacturer = getManufacturerConfig("balluff");
  if (!manufacturer) throw new Error("Balluff manufacturer config is missing.");

  const db = new ScraperDb(appPaths);
  const runManager = new RunManager(db, appPaths);

  try {
    const run = db.createRun({
      id: createRunId(),
      manufacturerId: "balluff",
      inputFileName: path.basename(inputPath),
      catalogNumbers,
      options: {
        downloadDocuments: true,
        downloadImages: true,
        generateExcel: true,
        forceFinalRetry: true
      }
    });

    console.log(`Started Balluff run ${run.id} for ${catalogNumbers.length} products from ${inputPath}`);
    await runManager.processRun(run.id);

    const finalRun = db.getRun(run.id);
    if (!finalRun) throw new Error(`Run disappeared: ${run.id}`);
    const items = db.getRunItems(run.id);
    const layout = buildRunOutputLayout(appPaths.outputDir, manufacturer, finalRun);
    const pdtOutputPath = path.join(layout.excelDir, `${finalRun.id}_PDT.xlsx`);
    const pdt = await exportRunPdt({
      manufacturer,
      items,
      templatePath: resolveTemplatePath(),
      outputPath: pdtOutputPath,
      aiCleanup: false
    });
    db.updateRun(finalRun.id, { pdtPath: pdt.outputPath });

    const statusCounts = items.reduce<Record<string, number>>((counts, item) => {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
      return counts;
    }, {});

    const summary = items.map(summarizeItem);
    const missingWeight = summary.filter((item) => item.status !== "failed" && item.weight === "-").map((item) => item.catalogNumber);
    const missingDppWeight = summary.filter((item) => item.status !== "failed" && item.dppWeight === "-").map((item) => item.catalogNumber);
    const missingDatasheetParse = summary
      .filter((item) => item.status !== "failed" && item.datasheet !== "parsed")
      .map((item) => item.catalogNumber);

    console.log(
      JSON.stringify(
        {
          run: {
            id: finalRun.id,
            status: db.getRun(finalRun.id)?.status,
            totals: statusCounts,
            outputPath: db.getRun(finalRun.id)?.outputPath,
            pdtPath: pdt.outputPath,
            cleanedInputPath: pdt.cleanedInputPath
          },
          pdt: {
            productCount: pdt.productCount,
            documentRows: pdt.documentRows,
            filledSheets: pdt.filledSheets,
            missingSheets: pdt.missingSheets,
            unmappedDeviceTypes: pdt.unmappedDeviceTypes,
            unclassifiedCatalogNumbers: pdt.unclassifiedCatalogNumbers,
            writeIssueCount: pdt.writeIssues.length,
            cleanup: pdt.cleanup
          },
          gaps: {
            missingWeight,
            missingDppWeight,
            missingDatasheetParse
          },
          items: summary
        },
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

function summarizeItem(item: RunItemRecord) {
  const result = item.result;
  const attrs = result?.attributes ?? [];
  const docs = result?.documents ?? [];
  const dppAttrs = attrs.filter((attr) => /digital product passport/i.test(attr.group ?? ""));
  const pdfAttrs = attrs.filter((attr) => /^PDF\b/i.test(attr.group ?? ""));
  const weight = result?.normalized.weight ?? findAttr(attrs, /\b(?:weight|gewicht|mass)\b/i);
  const dppWeight = findAttr(dppAttrs, /^weight$|^gewicht$/i);
  const tariff = findAttr(dppAttrs, /tariff|taric|hs code/i) ?? findAttr(attrs, /tariff|taric|hs code/i);
  const country = findAttr(dppAttrs, /country of origin|herkunftsland/i) ?? findAttr(attrs, /country of origin|herkunftsland/i);
  const datasheets = docs.filter((doc) => doc.type === "datasheet");
  const parsedDatasheet = datasheets.find((doc) => doc.parseStatus === "parsed");

  return {
    catalogNumber: item.catalogNumber,
    status: item.status,
    title: item.title,
    weight: weight ?? "-",
    dppWeight: dppWeight ?? "-",
    tariff: tariff ?? "-",
    country: country ?? "-",
    dppAttributes: dppAttrs.length,
    pdfAttributes: pdfAttrs.length,
    datasheet: parsedDatasheet ? "parsed" : datasheets.length ? datasheets[0]?.parseStatus ?? "linked" : "-",
    documents: docs.length,
    parsers: result?.sources.map((source) => source.parser).filter(Boolean).slice(0, 8) ?? [],
    fallbackStages: result?.diagnostics?.fallbackStages ?? [],
    finalMissing: result?.diagnostics?.finalCompleteness?.afterMissing ?? [],
    error: item.error ?? result?.error
  };
}

function findAttr(attributes: AttributeRecord[], pattern: RegExp): string | undefined {
  return attributes.find((attr) => pattern.test(attr.name) && attr.value.trim())?.value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
