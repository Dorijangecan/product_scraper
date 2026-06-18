import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomerDocumentRecord, DocumentRecord, ManufacturerConfig, ProductResult, RunItemRecord } from "../src/shared/types.js";
import { getManufacturerConfig, initializeManufacturerConfig, listManufacturerConfigs } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { exportRunWorkbook } from "../src/server/excel.js";
import { createAppPaths } from "../src/server/paths.js";
import { attachEvidence } from "../src/server/scrapers/evidence.js";
import { enrichResultFromDownloadedDocuments } from "../src/server/scrapers/document-enrichment.js";
import { GenericFallbackScraper } from "../src/server/scrapers/generic.js";
import { CachedHttpClient } from "../src/server/scrapers/http-client.js";
import { getConnector } from "../src/server/scrapers/index.js";
import { finalizeQualityGate } from "../src/server/scrapers/quality-gate.js";
import { runDeterministicScrapePipeline } from "../src/server/scrapers/deterministic-pipeline.js";
import { BrowserRenderSession } from "../src/server/scrapers/browser-renderer.js";
import { exportRunPdt, type PdtExportResult } from "../src/server/pdt/exporter.js";
import { classifyDeviceType } from "../src/server/scrapers/device-type.js";
import { deviceSheetsFor, knownDeviceSheets } from "../src/server/pdt/device-sheet-map.js";
import { knownDeviceTypes } from "../src/server/scrapers/device-type.js";
import { DEVICE_TYPE_FAMILIES } from "../src/server/scrapers/device-type-families.js";
import {
  applyCustomerDocumentOverride,
  CustomerDocumentParseCache,
  extractCustomerDocumentAttributes
} from "../src/server/scrapers/customer-documents.js";
import { matchesExpectedOfficialUrl } from "./benchmark-utils.js";

interface BenchmarkFixture {
  manufacturerId: string;
  catalogNumber: string;
  caseType?: "electrical" | "mechanical" | "accessory" | "edge";
  expectedDeviceType?: string;
  riskTags?: string[];
  expectedOfficialUrlPatterns?: string[];
  requiredDocuments?: DocumentRecord["type"][];
  expectedNormalizedFields?: Array<keyof ProductResult["normalized"]>;
  knownRawAttributes?: string[];
  customerDocuments?: string[];
}

interface BenchmarkCaseReport {
  manufacturerId: string;
  catalogNumber: string;
  caseType?: BenchmarkFixture["caseType"];
  expectedDeviceType?: string;
  actualDeviceType?: string;
  deviceTypeMatched: boolean;
  riskTags: string[];
  status: ProductResult["status"] | "error";
  confidence: number;
  productUrl?: string;
  identityConfirmed: boolean;
  wrongProduct: boolean;
  officialUrlMatched: boolean;
  requiredDocumentsMatched: boolean;
  normalizedFieldsMatched: boolean;
  pdtAuditMatched: boolean;
  pdtAuditPath?: string;
  pdtWrittenCells: number;
  pdtBlankCells: number;
  pdtSkippedCells: number;
  pdtUnprovenSkipped: number;
  pdtUnprovenWritten: number;
  pdtWriteIssues: number;
  pdtRequiredFieldIssues: number;
  pdtUnexplainedRequiredFieldIssues: number;
  customerDocumentsExpected: number;
  customerDocumentsMatched: boolean;
  qualityMissing: string[];
  error?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const appPaths = createAppPaths(rootDir);
const benchmarkDir = path.join(rootDir, "benchmarks");
const outputDir = path.join(benchmarkDir, "output", timestamp());
const documentsDir = path.join(outputDir, "documents");
const imagesDir = path.join(outputDir, "images");
const pdtDir = path.join(outputDir, "pdt");
const pdtTemplatePath = path.join(rootDir, "templates", "master_pdt.xlsx");

initializeManufacturerConfig(appPaths.dataDir);
await fs.mkdir(documentsDir, { recursive: true });
await fs.mkdir(imagesDir, { recursive: true });
await fs.mkdir(pdtDir, { recursive: true });
const configuredManufacturerIds = new Set(listManufacturerConfigs().map((manufacturer) => manufacturer.id));

const db = new ScraperDb(appPaths);
const http = new CachedHttpClient(db, appPaths.cacheDir);
const fixtures = selectFixtures(await readFixtures(path.join(benchmarkDir, "products")));
const reports: BenchmarkCaseReport[] = [];
const browserRenderer = new BrowserRenderSession();
const fixtureTimeoutMs = envNumber("BENCHMARK_FIXTURE_TIMEOUT_MS", 180_000, 10_000, 900_000);
const fixtureCoverageRequired = !process.env.BENCHMARK_MANUFACTURER?.trim() && !process.env.BENCHMARK_LIMIT?.trim();

try {
  for (const [index, fixture] of fixtures.entries()) {
    const startedAt = Date.now();
    console.log(`[benchmark] ${index + 1}/${fixtures.length} ${fixture.manufacturerId} ${fixture.catalogNumber} start`);
    const report = await runFixture(fixture, browserRenderer);
    reports.push(report);
    console.log(
      `[benchmark] ${index + 1}/${fixtures.length} ${fixture.manufacturerId} ${fixture.catalogNumber} ${report.status}` +
      ` pdt=${report.pdtAuditMatched ? "ok" : "issue"} device=${report.actualDeviceType ?? "unknown"} ${Date.now() - startedAt}ms`
    );
    if (report.qualityMissing.includes("timeout")) {
      console.log("[benchmark] stopping after fixture timeout so unfinished async work cannot overlap the next fixture");
      break;
    }
    await delay(250);
  }
} finally {
  await browserRenderer.close();
  db.close();
}

const summary = summarize(reports);
const reportPath = benchmarkReportPath();
await fs.writeFile(
  reportPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), outputDir, filters: benchmarkFilters(), summary, reports }, null, 2),
  "utf8"
);

console.log(`Benchmark fixtures: ${reports.length}`);
console.log(`Found: ${summary.foundRate}% | Official URL: ${summary.officialUrlRate}% | Documents: ${summary.documentRate}%`);
console.log(`Device type: ${summary.deviceTypeRate}%`);
console.log(`Customer documents: ${summary.customerDocumentRate}%`);
console.log(`PDT audit: ${summary.pdtAuditRate}% | PDT enum skips: ${summary.pdtWriteIssues} | unproven written: ${summary.pdtUnprovenWritten}`);
console.log(`PDT sheet fixture coverage: ${summary.fixtureCoverage.deviceSheetCoverage.covered}/${summary.fixtureCoverage.deviceSheetCoverage.total}`);
console.log(`Quality accepted: ${summary.qualityAccepted ? "yes" : "no"} | Coverage accepted: ${summary.fixtureCoverageAccepted ? "yes" : "no"}`);
console.log(`Wrong products: ${summary.wrongProducts}`);
console.log(`Thin fixture coverage: ${summary.fixtureCoverage.thinManufacturers.join(", ") || "none"}`);
if (summary.fixtureCoverage.uncoveredDeviceSheets.length) {
  console.log(`Next PDT sheet fixtures: ${formatCoverageRecommendations(summary.fixtureCoverage.missingDeviceSheetRecommendations).join("; ")}`);
}
console.log(`Report: ${reportPath}`);

if (!summary.accepted) {
  process.exitCode = 1;
}
if (reports.some((report) => report.qualityMissing.includes("timeout"))) {
  process.exit(process.exitCode ?? 0);
}

async function runFixture(fixture: BenchmarkFixture, browserRenderer: BrowserRenderSession): Promise<BenchmarkCaseReport> {
  const manufacturer = getManufacturerConfig(fixture.manufacturerId);
  if (!manufacturer) return errorReport(fixture, `Unknown manufacturer ${fixture.manufacturerId}`);
  const abort = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutReport = new Promise<BenchmarkCaseReport>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      abort.abort();
      resolve(errorReport(fixture, `Benchmark fixture timed out after ${fixtureTimeoutMs} ms.`));
    }, fixtureTimeoutMs);
  });

  try {
    const report = await Promise.race([runFixtureAttempt(fixture, manufacturer, browserRenderer, abort.signal), timeoutReport]);
    return timedOut ? { ...report, qualityMissing: [...report.qualityMissing, "timeout"] } : report;
  } catch (error) {
    return errorReport(fixture, error instanceof Error ? error.message : "Unexpected benchmark error");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runFixtureAttempt(
  fixture: BenchmarkFixture,
  manufacturer: ManufacturerConfig,
  browserRenderer: BrowserRenderSession,
  signal: AbortSignal
): Promise<BenchmarkCaseReport> {
  const connector = getConnector(manufacturer.id);
  const fallback = new GenericFallbackScraper(manufacturer.id, http, manufacturer);
  const customerDocumentCache = new CustomerDocumentParseCache();
  const context = {
    http,
    manufacturer,
    runDir: outputDir,
    documentsDir,
    signal,
    browserRenderer,
    learnedEndpoints: {
      list: (manufacturerId: string, limit?: number) => db.listLearnedEndpoints(manufacturerId, limit),
      upsert: (endpoint: Parameters<ScraperDb["upsertLearnedEndpoint"]>[0]) => db.upsertLearnedEndpoint(endpoint)
    },
    fallback: {
      scrape: (catalogNumber: string, sources: Parameters<GenericFallbackScraper["scrape"]>[1]) => fallback.scrape(catalogNumber, sources, signal)
    },
    downloadDocument: (doc: DocumentRecord) => downloadDocument(manufacturer, fixture.catalogNumber, doc, signal)
  };

  const stage = <T>(label: string, task: () => Promise<T>): Promise<T> => benchmarkStage(fixture, label, task);
  const customerOnly = finalizeQualityGate(
    await stage("customerDocuments.first", () => applyBenchmarkCustomerDocuments(fixture, baseCustomerResult(fixture, manufacturer), customerDocumentCache)),
    manufacturer
  );
  const initial = shouldUseBenchmarkCustomerFirst(manufacturer, fixture, customerOnly)
    ? customerOnly
    : finalizeQualityGate(
        await stage("customerDocuments.initial", async () => {
          const scraped = await stage("scrape", () => connector.scrape(fixture.catalogNumber, context));
          return applyBenchmarkCustomerDocuments(fixture, scraped, customerDocumentCache);
        }),
        manufacturer
      );
  const withDownloads = await stage("downloadDocuments.initial", () => downloadDocuments(manufacturer, fixture.catalogNumber, initial, signal));
  let result = finalizeQualityGate(await stage("enrich.initial", () => enrichResultFromDownloadedDocuments(withDownloads)), manufacturer);
  if (!result.qualityGate?.passed) {
    result = await stage("deterministicPipeline", () => runDeterministicScrapePipeline(result, fixture.catalogNumber, context));
    result = await stage("customerDocuments.retry", () => applyBenchmarkCustomerDocuments(fixture, result, customerDocumentCache));
    const fallbackDownloads = await stage("downloadDocuments.retry", () => downloadDocuments(manufacturer, fixture.catalogNumber, result, signal));
    result = finalizeQualityGate(await stage("enrich.retry", () => enrichResultFromDownloadedDocuments(fallbackDownloads)), manufacturer);
  }
  result = attachEvidence(result);
  await stage("writeWorkbook", () => writeSingleResultWorkbook(manufacturer, fixture, result));
  const pdt = await stage("exportPdt", () => exportSingleResultPdt(manufacturer, fixture, result));
  return reportFromResult(fixture, manufacturer, result, pdt);
}

async function applyBenchmarkCustomerDocuments(
  fixture: BenchmarkFixture,
  result: ProductResult,
  cache: CustomerDocumentParseCache
): Promise<ProductResult> {
  const documents = await benchmarkCustomerDocuments(fixture);
  if (!documents.length) return result;
  const extraction = await extractCustomerDocumentAttributes(fixture.catalogNumber, documents, { cache });
  return applyCustomerDocumentOverride(result, extraction);
}

function baseCustomerResult(fixture: BenchmarkFixture, manufacturer: ManufacturerConfig): ProductResult {
  return {
    manufacturerId: manufacturer.id,
    catalogNumber: fixture.catalogNumber,
    status: "failed",
    confidence: 0,
    normalized: {},
    attributes: [],
    documents: [],
    sources: [],
    error: "Official source not scraped yet."
  };
}

function shouldUseBenchmarkCustomerFirst(manufacturer: ManufacturerConfig, fixture: BenchmarkFixture, result: ProductResult): boolean {
  if (manufacturer.id !== "eaton" || !fixture.customerDocuments?.length) return false;
  if (result.status === "failed" || result.qualityGate?.identityConfirmed === false) return false;
  const normalized = result.normalized;
  const hasPhysicalCore = Boolean(normalized.weight && normalized.dimensions && normalized.material);
  const hasDutySpec = Boolean(normalized.voltage || normalized.current) || result.attributes.some((attr) => /^(?:pressure|flow rate|flow|power)$/i.test(attr.name));
  const hasDescriptiveIdentity = result.attributes.some((attr) => /^(?:product type|description|product short text|product name)$/i.test(attr.name));
  return result.attributes.length >= 5 && result.documents.some((doc) => doc.parser === "customer-document") && hasPhysicalCore && hasDutySpec && hasDescriptiveIdentity;
}

async function benchmarkCustomerDocuments(fixture: BenchmarkFixture): Promise<CustomerDocumentRecord[]> {
  if (!fixture.customerDocuments?.length) return [];
  const documents: CustomerDocumentRecord[] = [];
  for (const [index, entry] of fixture.customerDocuments.entries()) {
    const storedPath = path.isAbsolute(entry) ? entry : path.resolve(benchmarkDir, entry);
    const stat = await fs.stat(storedPath);
    documents.push({
      id: `benchmark-${safePart(fixture.manufacturerId)}-${safePart(fixture.catalogNumber)}-${index + 1}`,
      originalName: path.basename(storedPath),
      storedPath,
      mimeType: mimeTypeForPath(storedPath),
      size: stat.size,
      uploadedAt: "1970-01-01T00:00:00.000Z"
    });
  }
  return documents;
}

async function downloadDocuments(manufacturer: ManufacturerConfig, catalogNumber: string, result: ProductResult, signal: AbortSignal): Promise<ProductResult> {
  const ranked = benchmarkDocumentsToDownload(result.documents);
  const downloaded = new Map<string, DocumentRecord>();
  for (const doc of ranked) downloaded.set(doc.url, await downloadDocument(manufacturer, catalogNumber, doc, signal));
  return {
    ...result,
    documents: result.documents.map((doc) => downloaded.get(doc.url) ?? doc)
  };
}

async function downloadDocument(manufacturer: ManufacturerConfig, catalogNumber: string, doc: DocumentRecord, signal: AbortSignal): Promise<DocumentRecord> {
  if (doc.localPath) return doc;
  const request = createBenchmarkDownloadSignal(signal, doc.type === "image" ? 20_000 : 15_000);
  try {
    if (doc.type === "image") {
      const localPath = path.join(imagesDir, `${safePart(manufacturer.shortName)}.${safePart(catalogNumber)}.png`);
      await http.downloadImageAsPng([doc.url, ...(doc.candidateUrls ?? [])], localPath, request.signal);
      return { ...doc, localPath, downloadStatus: "downloaded" };
    }
    const localPath = await http.downloadFile(doc.url, documentsDir, `${safePart(catalogNumber)}-${doc.type}-${safePart(doc.label)}${documentExtension(doc)}`, request.signal);
    return { ...doc, localPath, downloadStatus: "downloaded" };
  } catch (error) {
    return { ...doc, downloadStatus: "failed", downloadError: error instanceof Error ? error.message : "download failed" };
  } finally {
    request.cleanup();
  }
}

async function writeSingleResultWorkbook(manufacturer: ManufacturerConfig, fixture: BenchmarkFixture, result: ProductResult) {
  await exportRunWorkbook({
    run: {
      id: `benchmark-${safePart(fixture.manufacturerId)}-${safePart(fixture.catalogNumber)}`,
      manufacturerId: manufacturer.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "completed",
      total: 1,
      processed: 1,
      found: result.status === "found" ? 1 : 0,
      partial: result.status === "partial" ? 1 : 0,
      failed: result.status === "failed" ? 1 : 0
    },
    manufacturer,
    items: [
      {
        id: 1,
        runId: "benchmark",
        rowIndex: 1,
        catalogNumber: fixture.catalogNumber,
        status: result.status,
        title: result.title,
        productUrl: result.productUrl,
        confidence: result.confidence,
        error: result.error,
        result,
        updatedAt: new Date().toISOString()
      }
    ],
    outputDir
  });
}

async function exportSingleResultPdt(manufacturer: ManufacturerConfig, fixture: BenchmarkFixture, result: ProductResult): Promise<PdtExportResult | undefined> {
  if (result.status === "failed") return undefined;
  const outputPath = path.join(pdtDir, `${safePart(fixture.manufacturerId)}-${safePart(fixture.catalogNumber)}-pdt.xlsx`);
  return exportRunPdt({
    manufacturer,
    items: [runItemFromResult(fixture, result)],
    templatePath: pdtTemplatePath,
    outputPath
  });
}

function runItemFromResult(fixture: BenchmarkFixture, result: ProductResult): RunItemRecord {
  return {
    id: 1,
    runId: "benchmark",
    rowIndex: 1,
    catalogNumber: fixture.catalogNumber,
    status: result.status,
    title: result.title,
    productUrl: result.productUrl,
    confidence: result.confidence,
    error: result.error,
    result,
    updatedAt: new Date().toISOString()
  };
}

function reportFromResult(fixture: BenchmarkFixture, manufacturer: ManufacturerConfig, result: ProductResult, pdt: PdtExportResult | undefined): BenchmarkCaseReport {
  const wrongProduct = result.status !== "failed" && result.qualityGate?.identityConfirmed === false;
  const pdtAudit = summarizePdtAudit(pdt);
  const actualDeviceType = classifyDeviceType(result).type;
  return {
    manufacturerId: fixture.manufacturerId,
    catalogNumber: fixture.catalogNumber,
    caseType: fixture.caseType,
    expectedDeviceType: fixture.expectedDeviceType,
    actualDeviceType,
    deviceTypeMatched: fixture.expectedDeviceType ? actualDeviceType === fixture.expectedDeviceType : true,
    riskTags: fixture.riskTags ?? [],
    status: result.status,
    confidence: result.confidence,
    productUrl: result.productUrl,
    identityConfirmed: result.qualityGate?.identityConfirmed ?? false,
    wrongProduct,
    officialUrlMatched: matchesExpectedOfficialUrl(result, manufacturer, fixture),
    requiredDocumentsMatched: matchesRequiredDocuments(result, fixture),
    normalizedFieldsMatched: matchesNormalizedFields(result, fixture),
    ...pdtAudit,
    customerDocumentsExpected: fixture.customerDocuments?.length ?? 0,
    customerDocumentsMatched: matchesCustomerDocuments(result, fixture),
    qualityMissing: result.qualityGate?.missing ?? []
  };
}

function matchesCustomerDocuments(result: ProductResult, fixture: BenchmarkFixture): boolean {
  if (!fixture.customerDocuments?.length) return true;
  return result.documents.some((doc) => doc.parser === "customer-document" && doc.parseStatus === "parsed");
}

function summarizePdtAudit(pdt: PdtExportResult | undefined): Pick<
  BenchmarkCaseReport,
  | "pdtAuditMatched"
  | "pdtAuditPath"
  | "pdtWrittenCells"
  | "pdtBlankCells"
  | "pdtSkippedCells"
  | "pdtUnprovenSkipped"
  | "pdtUnprovenWritten"
  | "pdtWriteIssues"
  | "pdtRequiredFieldIssues"
  | "pdtUnexplainedRequiredFieldIssues"
> {
  if (!pdt) {
    return {
      pdtAuditMatched: false,
      pdtWrittenCells: 0,
      pdtBlankCells: 0,
      pdtSkippedCells: 0,
      pdtUnprovenSkipped: 0,
      pdtUnprovenWritten: 0,
      pdtWriteIssues: 0,
      pdtRequiredFieldIssues: 0,
      pdtUnexplainedRequiredFieldIssues: 0
    };
  }
  const pdtUnprovenWritten = pdt.cellAudit.records.filter((record) => record.status === "written" && record.sourceKind === "unproven").length;
  const pdtUnexplainedRequiredFieldIssues = pdt.requiredFieldIssues.filter((issue) =>
    !pdt.cellAudit.records.some(
      (record) =>
        record.catalogNumber === issue.catalogNumber &&
        record.sheetName === issue.sheetName &&
        record.code === issue.code &&
        record.status !== "written"
    )
  ).length;
  const pdtAuditMatched =
    Boolean(pdt.pdtAuditPath) &&
    pdt.cellAudit.records.length > 0 &&
    pdtUnprovenWritten === 0 &&
    pdtUnexplainedRequiredFieldIssues === 0;
  return {
    pdtAuditMatched,
    pdtAuditPath: pdt.pdtAuditPath,
    pdtWrittenCells: pdt.cellAudit.written,
    pdtBlankCells: pdt.cellAudit.blank,
    pdtSkippedCells: pdt.cellAudit.skipped,
    pdtUnprovenSkipped: pdt.cellAudit.unprovenSkipped,
    pdtUnprovenWritten,
    pdtWriteIssues: pdt.writeIssues.length,
    pdtRequiredFieldIssues: pdt.requiredFieldIssues.length,
    pdtUnexplainedRequiredFieldIssues
  };
}

function matchesRequiredDocuments(result: ProductResult, fixture: BenchmarkFixture): boolean {
  if (!fixture.requiredDocuments?.length) return true;
  return fixture.requiredDocuments.every((type) => result.documents.some((doc) => doc.type === type));
}

function matchesNormalizedFields(result: ProductResult, fixture: BenchmarkFixture): boolean {
  if (!fixture.expectedNormalizedFields?.length) return true;
  return fixture.expectedNormalizedFields.every((field) => Boolean(result.normalized[field]));
}

function summarize(reports: BenchmarkCaseReport[]) {
  const total = Math.max(1, reports.length);
  const found = reports.filter((report) => report.status === "found").length;
  const officialUrl = reports.filter((report) => report.officialUrlMatched).length;
  const documents = reports.filter((report) => report.requiredDocumentsMatched).length;
  const pdtAudit = reports.filter((report) => report.pdtAuditMatched).length;
  const deviceTypes = reports.filter((report) => report.deviceTypeMatched).length;
  const customerDocumentExpected = reports.filter((report) => report.customerDocumentsExpected > 0);
  const customerDocuments = customerDocumentExpected.filter((report) => report.customerDocumentsMatched).length;
  const wrongProducts = reports.filter((report) => report.wrongProduct).length;
  const coverage = fixtureCoverage(reports);
  const summary = {
    foundRate: percent(found, total),
    officialUrlRate: percent(officialUrl, total),
    documentRate: percent(documents, total),
    pdtAuditRate: percent(pdtAudit, total),
    deviceTypeRate: percent(deviceTypes, total),
    customerDocumentRate: percent(customerDocuments, Math.max(1, customerDocumentExpected.length)),
    wrongProducts,
    partialWithoutMissing: reports.filter((report) => report.status === "partial" && report.qualityMissing.length === 0).length,
    pdtUnprovenWritten: reports.reduce((sum, report) => sum + report.pdtUnprovenWritten, 0),
    pdtUnexplainedRequiredFieldIssues: reports.reduce((sum, report) => sum + report.pdtUnexplainedRequiredFieldIssues, 0),
    pdtWriteIssues: reports.reduce((sum, report) => sum + report.pdtWriteIssues, 0)
  };
  const qualityAccepted =
    wrongProducts === 0 &&
    summary.partialWithoutMissing === 0 &&
    summary.pdtAuditRate >= 90 &&
    summary.pdtUnprovenWritten === 0 &&
    summary.pdtUnexplainedRequiredFieldIssues === 0 &&
    summary.deviceTypeRate >= 90 &&
    customerDocumentExpected.every((report) => report.customerDocumentsMatched) &&
    summary.foundRate >= 90 &&
    summary.officialUrlRate >= 85 &&
    summary.documentRate >= 80;
  const fixtureCoverageAccepted =
    !fixtureCoverageRequired ||
    (coverage.thinManufacturers.length === 0 && coverage.uncoveredDeviceSheets.length === 0);
  return {
    ...summary,
    qualityAccepted,
    fixtureCoverageAccepted,
    fixtureCoverage: coverage,
    fixtureCoverageRequired,
    accepted: qualityAccepted && fixtureCoverageAccepted
  };
}

function fixtureCoverage(reports: BenchmarkCaseReport[]) {
  const byManufacturer: Record<string, { total: number; caseTypes: string[]; riskTags: string[] }> = {};
  const byDeviceType: Record<string, { total: number; manufacturers: string[]; caseTypes: string[] }> = {};
  const byDeviceSheet: Record<string, { total: number; deviceTypes: string[]; manufacturers: string[] }> = {};
  for (const report of reports) {
    const current = byManufacturer[report.manufacturerId] ?? { total: 0, caseTypes: [], riskTags: [] };
    current.total++;
    if (report.caseType && !current.caseTypes.includes(report.caseType)) current.caseTypes.push(report.caseType);
    for (const tag of report.riskTags) {
      if (!current.riskTags.includes(tag)) current.riskTags.push(tag);
    }
    byManufacturer[report.manufacturerId] = current;

    const deviceType = report.actualDeviceType ?? report.expectedDeviceType;
    if (deviceType) {
      const typeCoverage = byDeviceType[deviceType] ?? { total: 0, manufacturers: [], caseTypes: [] };
      typeCoverage.total++;
      if (!typeCoverage.manufacturers.includes(report.manufacturerId)) typeCoverage.manufacturers.push(report.manufacturerId);
      if (report.caseType && !typeCoverage.caseTypes.includes(report.caseType)) typeCoverage.caseTypes.push(report.caseType);
      byDeviceType[deviceType] = typeCoverage;

      for (const sheetName of deviceSheetsFor(deviceType)) {
        const sheetCoverage = byDeviceSheet[sheetName] ?? { total: 0, deviceTypes: [], manufacturers: [] };
        sheetCoverage.total++;
        if (!sheetCoverage.deviceTypes.includes(deviceType)) sheetCoverage.deviceTypes.push(deviceType);
        if (!sheetCoverage.manufacturers.includes(report.manufacturerId)) sheetCoverage.manufacturers.push(report.manufacturerId);
        byDeviceSheet[sheetName] = sheetCoverage;
      }
    }
  }
  for (const coverage of Object.values(byManufacturer)) {
    coverage.caseTypes.sort();
    coverage.riskTags.sort();
  }
  for (const coverage of Object.values(byDeviceType)) {
    coverage.caseTypes.sort();
    coverage.manufacturers.sort();
  }
  for (const coverage of Object.values(byDeviceSheet)) {
    coverage.deviceTypes.sort();
    coverage.manufacturers.sort();
  }
  const thinManufacturers = Object.entries(byManufacturer)
    .filter(([, coverage]) => coverage.total < 2)
    .map(([manufacturerId]) => manufacturerId)
    .sort();
  const uncoveredDeviceSheets = knownDeviceSheets().filter((sheetName) => !byDeviceSheet[sheetName]).sort();
  const missingDeviceSheetRecommendations = coverageRecommendations(uncoveredDeviceSheets);
  return {
    byManufacturer,
    byDeviceType,
    byDeviceSheet,
    thinManufacturers,
    uncoveredDeviceSheets,
    missingDeviceSheetRecommendations,
    deviceSheetCoverage: {
      covered: Object.keys(byDeviceSheet).length,
      total: knownDeviceSheets().length
    }
  };
}

function coverageRecommendations(uncoveredDeviceSheets: string[]) {
  return uncoveredDeviceSheets.map((sheetName) => {
    const deviceTypes = knownDeviceTypes().filter((deviceType) => deviceSheetsFor(deviceType).includes(sheetName)).sort();
    return {
      sheetName,
      deviceTypes,
      examples: deviceTypes.flatMap((deviceType) => familyExamplesForDeviceType(deviceType)).slice(0, 5)
    };
  });
}

function formatCoverageRecommendations(recommendations: ReturnType<typeof coverageRecommendations>): string[] {
  return recommendations.slice(0, 6).map((recommendation) => {
    const example = recommendation.examples[0];
    const hint = example ? `${example.manufacturerId} ${example.pattern} (${example.deviceType})` : recommendation.deviceTypes.slice(0, 2).join("/");
    return `${recommendation.sheetName}: ${hint || "no family hint"}`;
  });
}

function familyExamplesForDeviceType(deviceType: string): Array<{ manufacturerId: string; pattern: string; deviceType: string; notes?: string }> {
  const examples: Array<{ manufacturerId: string; pattern: string; deviceType: string; notes?: string }> = [];
  for (const [manufacturerId, entries] of Object.entries(DEVICE_TYPE_FAMILIES)) {
    if (!configuredManufacturerIds.has(manufacturerId)) continue;
    for (const entry of entries) {
      if (entry.type !== deviceType) continue;
      for (const pattern of entry.patterns.slice(0, 2)) {
        examples.push({ manufacturerId, pattern, deviceType, notes: entry.notes });
      }
    }
  }
  examples.sort((left, right) => left.manufacturerId.localeCompare(right.manufacturerId) || left.pattern.localeCompare(right.pattern));
  return examples;
}

async function readFixtures(dir: string): Promise<BenchmarkFixture[]> {
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  const fixtures: BenchmarkFixture[] = [];
  for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as BenchmarkFixture | BenchmarkFixture[];
    fixtures.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return fixtures;
}

function errorReport(fixture: BenchmarkFixture, error: string): BenchmarkCaseReport {
  return {
    manufacturerId: fixture.manufacturerId,
    catalogNumber: fixture.catalogNumber,
    caseType: fixture.caseType,
    expectedDeviceType: fixture.expectedDeviceType,
    actualDeviceType: undefined,
    deviceTypeMatched: fixture.expectedDeviceType ? false : true,
    riskTags: fixture.riskTags ?? [],
    status: "error",
    confidence: 0,
    identityConfirmed: false,
    wrongProduct: false,
    officialUrlMatched: false,
    requiredDocumentsMatched: false,
    normalizedFieldsMatched: false,
    pdtAuditMatched: false,
    pdtWrittenCells: 0,
    pdtBlankCells: 0,
    pdtSkippedCells: 0,
    pdtUnprovenSkipped: 0,
    pdtUnprovenWritten: 0,
    pdtWriteIssues: 0,
    pdtRequiredFieldIssues: 0,
    pdtUnexplainedRequiredFieldIssues: 0,
    customerDocumentsExpected: fixture.customerDocuments?.length ?? 0,
    customerDocumentsMatched: !fixture.customerDocuments?.length,
    qualityMissing: ["error"],
    error
  };
}

function documentRank(doc: DocumentRecord): number {
  const label = `${doc.type} ${doc.label} ${doc.url}`.toLowerCase();
  let rank = 100;
  if (doc.type === "datasheet") rank = 10;
  if (doc.type === "certificate") rank = 20;
  if (doc.type === "manual") rank = 30;
  if (doc.type === "cad") rank = 40;
  if (doc.type === "image") rank = 50;
  if (doc.type === "other") rank = 90;
  if (/data.?sheet|specification|technical/.test(label)) rank -= 6;
  if (/certificate|declaration|conformity|rohs|weee|ul|ce\b/.test(label)) rank -= 5;
  if (/main|primary|product|iopmain|zoom|gallery/.test(label)) rank -= 4;
  if (/terms|privacy|warranty|brochure|catalogue|catalog\b/.test(label)) rank += 30;
  if (doc.type !== "image" && /\.pdf(?:[?#]|$)/i.test(doc.url)) rank -= 8;
  return rank;
}

function benchmarkDocumentsToDownload(documents: DocumentRecord[]): DocumentRecord[] {
  const selected: DocumentRecord[] = [];
  const seenTypes = new Set<string>();
  for (const doc of [...documents].sort((left, right) => documentRank(left) - documentRank(right))) {
    if (seenTypes.has(doc.type)) continue;
    selected.push(doc);
    seenTypes.add(doc.type);
  }
  return selected.slice(0, 5);
}

function documentExtension(doc: DocumentRecord): string {
  try {
    const ext = path.extname(new URL(doc.url).pathname);
    if (ext) return ext;
  } catch {
    // fall through
  }
  return doc.type === "datasheet" || doc.type === "certificate" || doc.type === "manual" ? ".pdf" : ".bin";
}

function mimeTypeForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".csv") return "text/csv";
  if (ext === ".tsv" || ext === ".txt") return "text/plain";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".xls") return "application/vnd.ms-excel";
  return undefined;
}

function safePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}

function benchmarkFilters(): Record<string, string> {
  const filters: Record<string, string> = {};
  const manufacturer = process.env.BENCHMARK_MANUFACTURER?.trim();
  const limit = process.env.BENCHMARK_LIMIT?.trim();
  if (manufacturer) filters.manufacturer = manufacturer;
  if (limit) filters.limit = limit;
  return filters;
}

function benchmarkReportPath(): string {
  const filters = benchmarkFilters();
  const suffix = Object.entries(filters)
    .map(([key, value]) => `${key}-${safePart(value)}`)
    .join(".");
  return path.join(benchmarkDir, suffix ? `benchmark-report.${suffix}.json` : "benchmark-report.json");
}

function percent(count: number, total: number): number {
  return Math.round((count / total) * 1000) / 10;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function benchmarkStage<T>(fixture: BenchmarkFixture, label: string, task: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  debugBenchmark(`${fixture.manufacturerId} ${fixture.catalogNumber} ${label} start`);
  try {
    const result = await task();
    debugBenchmark(`${fixture.manufacturerId} ${fixture.catalogNumber} ${label} done ${Date.now() - startedAt}ms`);
    return result;
  } catch (error) {
    debugBenchmark(`${fixture.manufacturerId} ${fixture.catalogNumber} ${label} error ${Date.now() - startedAt}ms`);
    throw error;
  }
}

function debugBenchmark(message: string): void {
  if (process.env.DEBUG_BENCHMARK) console.log(`[benchmark:debug] ${message}`);
}

function createBenchmarkDownloadSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  parent.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectFixtures(fixtures: BenchmarkFixture[]): BenchmarkFixture[] {
  const manufacturerFilter = process.env.BENCHMARK_MANUFACTURER?.trim().toLowerCase();
  const limit = envNumber("BENCHMARK_LIMIT", fixtures.length, 1, fixtures.length);
  const filtered = manufacturerFilter
    ? fixtures.filter((fixture) => fixture.manufacturerId.toLowerCase() === manufacturerFilter)
    : fixtures;
  return filtered.slice(0, limit);
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
