import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentRecord, ManufacturerConfig, ProductResult } from "../src/shared/types.js";
import { getManufacturerConfig, initializeManufacturerConfig } from "../src/server/config/manufacturers.js";
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

interface BenchmarkFixture {
  manufacturerId: string;
  catalogNumber: string;
  expectedOfficialUrlPatterns?: string[];
  requiredDocuments?: DocumentRecord["type"][];
  expectedNormalizedFields?: Array<keyof ProductResult["normalized"]>;
  knownRawAttributes?: string[];
}

interface BenchmarkCaseReport {
  manufacturerId: string;
  catalogNumber: string;
  status: ProductResult["status"] | "error";
  confidence: number;
  productUrl?: string;
  identityConfirmed: boolean;
  wrongProduct: boolean;
  officialUrlMatched: boolean;
  requiredDocumentsMatched: boolean;
  normalizedFieldsMatched: boolean;
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

initializeManufacturerConfig(appPaths.dataDir);
await fs.mkdir(documentsDir, { recursive: true });
await fs.mkdir(imagesDir, { recursive: true });

const db = new ScraperDb(appPaths);
const http = new CachedHttpClient(db, appPaths.cacheDir);
const fixtures = await readFixtures(path.join(benchmarkDir, "products"));
const reports: BenchmarkCaseReport[] = [];
const browserRenderer = new BrowserRenderSession();

try {
  for (const fixture of fixtures) {
    reports.push(await runFixture(fixture, browserRenderer));
    await delay(250);
  }
} finally {
  await browserRenderer.close();
  db.close();
}

const summary = summarize(reports);
const reportPath = path.join(benchmarkDir, "benchmark-report.json");
await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), outputDir, summary, reports }, null, 2), "utf8");

console.log(`Benchmark fixtures: ${reports.length}`);
console.log(`Found: ${summary.foundRate}% | Official URL: ${summary.officialUrlRate}% | Documents: ${summary.documentRate}%`);
console.log(`Wrong products: ${summary.wrongProducts}`);
console.log(`Report: ${reportPath}`);

if (!summary.accepted) {
  process.exitCode = 1;
}

async function runFixture(fixture: BenchmarkFixture, browserRenderer: BrowserRenderSession): Promise<BenchmarkCaseReport> {
  const manufacturer = getManufacturerConfig(fixture.manufacturerId);
  if (!manufacturer) return errorReport(fixture, `Unknown manufacturer ${fixture.manufacturerId}`);
  const connector = getConnector(manufacturer.id);
  const fallback = new GenericFallbackScraper(manufacturer.id, http, manufacturer);

  try {
    const scraped = await connector.scrape(fixture.catalogNumber, {
      http,
      manufacturer,
      runDir: outputDir,
      documentsDir,
      signal: undefined,
      browserRenderer,
      learnedEndpoints: {
        list: (manufacturerId, limit) => db.listLearnedEndpoints(manufacturerId, limit),
        upsert: (endpoint) => db.upsertLearnedEndpoint(endpoint)
      },
      fallback: {
        scrape: (catalogNumber, sources) => fallback.scrape(catalogNumber, sources)
      },
      downloadDocument: (doc) => downloadDocument(manufacturer, fixture.catalogNumber, doc)
    });
    const initial = finalizeQualityGate(scraped, manufacturer);
    const withDownloads = await downloadDocuments(manufacturer, fixture.catalogNumber, initial);
    let result = finalizeQualityGate(await enrichResultFromDownloadedDocuments(withDownloads), manufacturer);
    if (!result.qualityGate?.passed) {
      result = await runDeterministicScrapePipeline(result, fixture.catalogNumber, {
        http,
        manufacturer,
        runDir: outputDir,
        documentsDir,
        signal: undefined,
        browserRenderer,
        learnedEndpoints: {
          list: (manufacturerId, limit) => db.listLearnedEndpoints(manufacturerId, limit),
          upsert: (endpoint) => db.upsertLearnedEndpoint(endpoint)
        },
        fallback: {
          scrape: (catalogNumber, sources) => fallback.scrape(catalogNumber, sources)
        },
        downloadDocument: (doc) => downloadDocument(manufacturer, fixture.catalogNumber, doc)
      });
      result = finalizeQualityGate(await enrichResultFromDownloadedDocuments(await downloadDocuments(manufacturer, fixture.catalogNumber, result)), manufacturer);
    }
    result = attachEvidence(result);
    await writeSingleResultWorkbook(manufacturer, fixture, result);
    return reportFromResult(fixture, manufacturer, result);
  } catch (error) {
    return errorReport(fixture, error instanceof Error ? error.message : "Unexpected benchmark error");
  }
}

async function downloadDocuments(manufacturer: ManufacturerConfig, catalogNumber: string, result: ProductResult): Promise<ProductResult> {
  const ranked = [...result.documents].sort((left, right) => documentRank(left) - documentRank(right)).slice(0, 12);
  const downloaded = new Map<string, DocumentRecord>();
  for (const doc of ranked) downloaded.set(doc.url, await downloadDocument(manufacturer, catalogNumber, doc));
  return {
    ...result,
    documents: result.documents.map((doc) => downloaded.get(doc.url) ?? doc)
  };
}

async function downloadDocument(manufacturer: ManufacturerConfig, catalogNumber: string, doc: DocumentRecord): Promise<DocumentRecord> {
  if (doc.localPath) return doc;
  try {
    if (doc.type === "image") {
      const localPath = path.join(imagesDir, `${safePart(manufacturer.shortName)}.${safePart(catalogNumber)}.png`);
      await http.downloadImageAsPng([doc.url, ...(doc.candidateUrls ?? [])], localPath);
      return { ...doc, localPath, downloadStatus: "downloaded" };
    }
    const localPath = await http.downloadFile(doc.url, documentsDir, `${safePart(catalogNumber)}-${doc.type}-${safePart(doc.label)}${documentExtension(doc)}`);
    return { ...doc, localPath, downloadStatus: "downloaded" };
  } catch (error) {
    return { ...doc, downloadStatus: "failed", downloadError: error instanceof Error ? error.message : "download failed" };
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

function reportFromResult(fixture: BenchmarkFixture, manufacturer: ManufacturerConfig, result: ProductResult): BenchmarkCaseReport {
  const wrongProduct = result.status !== "failed" && result.qualityGate?.identityConfirmed === false;
  return {
    manufacturerId: fixture.manufacturerId,
    catalogNumber: fixture.catalogNumber,
    status: result.status,
    confidence: result.confidence,
    productUrl: result.productUrl,
    identityConfirmed: result.qualityGate?.identityConfirmed ?? false,
    wrongProduct,
    officialUrlMatched: matchesExpectedOfficialUrl(result, manufacturer, fixture),
    requiredDocumentsMatched: matchesRequiredDocuments(result, fixture),
    normalizedFieldsMatched: matchesNormalizedFields(result, fixture),
    qualityMissing: result.qualityGate?.missing ?? []
  };
}

function matchesExpectedOfficialUrl(result: ProductResult, manufacturer: ManufacturerConfig, fixture: BenchmarkFixture): boolean {
  const url = result.productUrl ?? "";
  if (!url) return false;
  if (fixture.expectedOfficialUrlPatterns?.some((pattern) => safeRegExp(pattern).test(url))) return true;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return manufacturer.officialBaseUrls.some((baseUrl) => {
      try {
        const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
        return host === baseHost || host.endsWith(`.${baseHost}`);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
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
  const wrongProducts = reports.filter((report) => report.wrongProduct).length;
  const summary = {
    foundRate: percent(found, total),
    officialUrlRate: percent(officialUrl, total),
    documentRate: percent(documents, total),
    wrongProducts,
    partialWithoutMissing: reports.filter((report) => report.status === "partial" && report.qualityMissing.length === 0).length
  };
  return {
    ...summary,
    accepted:
      wrongProducts === 0 &&
      summary.partialWithoutMissing === 0 &&
      summary.foundRate >= 90 &&
      summary.officialUrlRate >= 85 &&
      summary.documentRate >= 80
  };
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
    status: "error",
    confidence: 0,
    identityConfirmed: false,
    wrongProduct: false,
    officialUrlMatched: false,
    requiredDocumentsMatched: false,
    normalizedFieldsMatched: false,
    qualityMissing: ["error"],
    error
  };
}

function documentRank(doc: DocumentRecord): number {
  return ["datasheet", "certificate", "manual", "cad", "image", "other"].indexOf(doc.type);
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

function safePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}

function safeRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function percent(count: number, total: number): number {
  return Math.round((count / total) * 1000) / 10;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
