import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import { extractDocumentTextAttributes } from "../src/server/scrapers/document-enrichment.js";
import { finalizeQualityGate } from "../src/server/scrapers/quality-gate.js";
import { normalizeFields } from "../src/server/scrapers/normalizer.js";
import { classifyDeviceType } from "../src/server/scrapers/device-type.js";
import { exportRunPdt } from "../src/server/pdt/exporter.js";
import { resolveTemplatePath } from "../src/server/pdt/template.js";
import type { AttributeRecord, DocumentRecord, ProductResult, RunItemRecord, SourceRecord } from "../src/shared/types.js";

const CSV_PATH = path.resolve("Testing PDT", "kiki.csv");
const OUTPUT_DIR = path.resolve("tmp", "eaton-cdvrl-pdt-audit");
const RAPID_LINK_CN_URL =
  "https://www.eaton.com.cn/content/dam/eaton/products/industrialcontrols-drives-automation-sensors/en-globalprime/rapid-link-5x/eaton-rapid-link-5x-catalog-zh-cn.pdf";
const RAPID_LINK_PDF_PATH = path.join(os.tmpdir(), "eaton-rapid-link-5x-catalog-zh-cn.pdf");

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await ensurePdf();

  const catalogNumbers = await readCatalogNumbers();
  console.log(`Loaded ${catalogNumbers.length} catalog numbers.`);
  const pdfText = await readPdfText(RAPID_LINK_PDF_PATH);
  console.log(`Loaded Rapid Link PDF text (${pdfText.length} chars).`);
  const manufacturer = getManufacturerConfig("eaton");
  if (!manufacturer) throw new Error("Eaton manufacturer config is not available.");

  const document = rapidLinkDocument();
  const now = new Date().toISOString();
  const items: RunItemRecord[] = [];
  const classificationCounts = new Map<string, number>();
  const missingNormalized: Record<string, string[]> = {};

  for (const [index, catalogNumber] of catalogNumbers.entries()) {
    const attributes = enrichAuditAttributes(
      extractDocumentTextAttributes({
        catalogNumber,
        document,
        text: pdfText
      })
    );
    const result = finalizeQualityGate(
      {
        manufacturerId: "eaton",
        catalogNumber,
        status: "found",
        confidence: 0.86,
        productUrl: RAPID_LINK_CN_URL,
        title: `${catalogNumber} - Eaton Rapid Link 5X RASP5X variable frequency drive`,
        description: "Eaton Rapid Link 5X RASP5X distributed variable frequency drive from the official Eaton China product catalog.",
        normalized: normalizeFields(attributes, [document]),
        attributes,
        documents: [document],
        sources: [rapidLinkSource(now)]
      },
      manufacturer
    );
    const type = classifyDeviceType(result).type ?? "(unclassified)";
    classificationCounts.set(type, (classificationCounts.get(type) ?? 0) + 1);
    const missing = ["voltage", "current", "dimensions", "weight", "protection"].filter((field) => !result.normalized[field as keyof ProductResult["normalized"]]);
    if (missing.length > 0) missingNormalized[catalogNumber] = missing;
    items.push({
      id: index + 1,
      runId: "audit-eaton-cdvrl-kiki",
      rowIndex: index + 1,
      catalogNumber,
      status: result.status,
      result,
      updatedAt: now
    });
    if ((index + 1) % 250 === 0) console.log(`Built ${index + 1}/${catalogNumbers.length} run items.`);
  }

  console.log(`Built ${items.length} run items. Exporting PDT workbook...`);
  const outputPath = path.join(OUTPUT_DIR, `eaton-cdvrl-kiki-pdt-${Date.now()}.xlsx`);
  const exportResult = await exportRunPdt({
    manufacturer,
    items,
    templatePath: resolveTemplatePath(),
    outputPath
  });

  const summary = {
    csvPath: CSV_PATH,
    outputPath,
    productCount: exportResult.productCount,
    documentRows: exportResult.documentRows,
    filledSheets: exportResult.filledSheets,
    missingSheets: exportResult.missingSheets,
    unmappedDeviceTypes: exportResult.unmappedDeviceTypes,
    unclassifiedCatalogNumbers: exportResult.unclassifiedCatalogNumbers.length,
    writeIssues: exportResult.writeIssues.length,
    requiredFieldIssues: exportResult.requiredFieldIssues.length,
    requiredFieldIssueGroups: groupRequiredIssues(exportResult.requiredFieldIssues),
    cellAudit: {
      written: exportResult.cellAudit.written,
      blank: exportResult.cellAudit.blank,
      skipped: exportResult.cellAudit.skipped,
      unprovenSkipped: exportResult.cellAudit.unprovenSkipped
    },
    classifications: Object.fromEntries([...classificationCounts.entries()].sort()),
    missingNormalizedCount: Object.keys(missingNormalized).length,
    missingNormalizedSamples: Object.entries(missingNormalized).slice(0, 20)
  };

  await fs.writeFile(path.join(OUTPUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function readCatalogNumbers(): Promise<string[]> {
  const text = await fs.readFile(CSV_PATH, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensurePdf() {
  try {
    const stat = await fs.stat(RAPID_LINK_PDF_PATH);
    if (stat.size > 100_000) return;
  } catch {
    // Download below.
  }
  const response = await fetch(RAPID_LINK_CN_URL);
  if (!response.ok) throw new Error(`Failed to download Rapid Link PDF: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(RAPID_LINK_PDF_PATH, bytes);
}

async function readPdfText(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });
  try {
    const parsed = await parser.getText();
    return parsed.text;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function rapidLinkDocument(): DocumentRecord {
  return {
    type: "datasheet",
    label: "Eaton Rapid Link 5X RASP5X product catalog",
    url: RAPID_LINK_CN_URL,
    localPath: RAPID_LINK_PDF_PATH,
    downloadStatus: "downloaded",
    parseStatus: "parsed",
    sourceType: "official-fallback",
    parser: "audit-eaton-cdvrl-pdt",
    confidence: 0.9
  };
}

function rapidLinkSource(fetchedAt: string): SourceRecord {
  return {
    url: RAPID_LINK_CN_URL,
    sourceType: "official-fallback",
    parser: "audit-eaton-cdvrl-pdt",
    stage: "official-family-catalog",
    reason: "Official Eaton Rapid Link 5X family catalog covers the CDVRL ordering table.",
    fetchedAt
  };
}

function enrichAuditAttributes(attributes: AttributeRecord[]): AttributeRecord[] {
  const fixed = attributes.map((attribute) => ({
    sourceType: "official-fallback" as const,
    parser: "audit-eaton-cdvrl-pdt",
    confidence: attribute.group?.includes("Inferred") ? 0.82 : 0.9,
    ...attribute
  }));
  fixed.push(
    {
      group: "PDF Catalog",
      name: "Product Type",
      value: "Variable frequency drive",
      sourceUrl: RAPID_LINK_CN_URL,
      sourceType: "official-fallback",
      parser: "audit-eaton-cdvrl-pdt",
      confidence: 0.9
    },
    {
      group: "PDF Catalog",
      name: "Product family",
      value: "Eaton Rapid Link 5X RASP5X distributed variable frequency drive",
      sourceUrl: RAPID_LINK_CN_URL,
      sourceType: "official-fallback",
      parser: "audit-eaton-cdvrl-pdt",
      confidence: 0.9
    }
  );
  return fixed;
}

function groupRequiredIssues(issues: Array<{ sheetName: string; code: string; propName: string; description: string }>) {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const key = `${issue.sheetName} | ${issue.code} | ${issue.propName} | ${issue.description}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
