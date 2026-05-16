import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentRecord, ManufacturerId, ProductResult, RunRecord } from "../shared/types.js";
import { getManufacturerConfig } from "./config/manufacturers.js";
import type { ScraperDb } from "./db.js";
import { exportRunWorkbook } from "./excel.js";
import { CachedHttpClient, delay } from "./scrapers/http-client.js";
import { getConnector } from "./scrapers/index.js";
import { GenericFallbackScraper } from "./scrapers/generic.js";
import { enrichResultFromDownloadedDocuments } from "./scrapers/document-enrichment.js";
import type { AppPaths } from "./paths.js";
import { buildRunOutputLayout, ensureRunOutputLayout, type RunOutputLayout } from "./run-output.js";

export class RunManager {
  private activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly db: ScraperDb,
    private readonly paths: AppPaths
  ) {}

  createRun(input: { manufacturerId: ManufacturerId; inputFileName?: string; catalogNumbers: string[] }): RunRecord {
    const run = this.db.createRun({
      id: createRunId(),
      manufacturerId: input.manufacturerId,
      inputFileName: input.inputFileName,
      catalogNumbers: input.catalogNumbers
    });
    void this.processRun(run.id);
    return run;
  }

  resumeInterruptedRuns() {
    const resumable = this.db.listRunsByStatus(["queued", "running", "cancelling"]);
    for (const run of resumable) {
      void this.processRun(run.id);
    }
  }

  async cancelRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.db.getRun(runId);
    if (!run) return undefined;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;

    this.db.updateRun(run.id, { status: "cancelling", error: "Cancelled by user." });
    this.db.cancelPendingRunItems(run.id);
    this.db.recountRun(run.id);
    this.activeRuns.get(run.id)?.abort();

    if (!this.activeRuns.has(run.id)) {
      await this.finalizeRun(run.id, "cancelled");
    }
    return this.db.getRun(run.id);
  }

  async processRun(runId: string) {
    if (this.activeRuns.has(runId)) return;
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    let layout: RunOutputLayout | undefined;
    try {
      const run = this.db.getRun(runId);
      if (!run) return;
      const manufacturer = getManufacturerConfig(run.manufacturerId);
      if (!manufacturer) throw new Error(`Unknown manufacturer ${run.manufacturerId}`);
      const connector = getConnector(run.manufacturerId);
      layout = buildRunOutputLayout(this.paths.outputDir, manufacturer, run.id);
      await ensureRunOutputLayout(layout);
      await this.appendRunLog(layout, "RUN_START", {
        runId: run.id,
        manufacturer: manufacturer.shortName,
        inputFileName: run.inputFileName,
        total: run.total,
        outputFolder: layout.runDir
      });
      if (this.db.isCancellationRequested(run.id)) {
        this.db.cancelActiveRunItems(run.id);
        await this.finalizeRun(run.id, "cancelled");
        return;
      }
      this.db.updateRun(run.id, { status: "running", error: undefined });

      const http = new CachedHttpClient(this.db, this.paths.cacheDir);
      const fallback = new GenericFallbackScraper(run.manufacturerId, http);
      const pending = this.db.getPendingRunItems(run.id);
      for (const item of pending) {
        if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) break;
        this.db.updateRunItem(item.id, { status: "processing", error: undefined });
        await this.appendRunLog(layout, "ITEM_START", { rowIndex: item.rowIndex, catalogNumber: item.catalogNumber });
        try {
          const result = await connector.scrape(item.catalogNumber, {
            http,
            manufacturer,
            runDir: layout.runDir,
            documentsDir: layout.documentsDir,
            signal: controller.signal,
            fallback: {
              scrape: (catalogNumber, sources) => fallback.scrape(catalogNumber, sources, controller.signal)
            },
            downloadDocument: (doc) =>
              this.downloadDocument(http, layout!.documentsDir, layout!.imagesDir, manufacturer.shortName, item.catalogNumber, doc, controller.signal)
          });
          if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) {
            this.db.updateRunItem(item.id, { status: "cancelled", error: "Cancelled by user." });
            await this.appendRunLog(layout, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            break;
          }
          const withDownloads = await this.downloadDocuments(
            http,
            layout.documentsDir,
            layout.imagesDir,
            manufacturer.shortName,
            result,
            controller.signal
          );
          const enriched = await enrichResultFromDownloadedDocuments(withDownloads);
          if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) {
            this.db.updateRunItem(item.id, { status: "cancelled", error: "Cancelled by user." });
            await this.appendRunLog(layout, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            break;
          }
          this.db.updateRunItem(item.id, {
            status: enriched.status,
            title: enriched.title,
            productUrl: enriched.productUrl,
            confidence: enriched.confidence,
            error: enriched.error,
            result: enriched
          });
          await this.appendRunLog(layout, "ITEM_DONE", {
            catalogNumber: item.catalogNumber,
            status: enriched.status,
            confidence: enriched.confidence,
            documents: enriched.documents.length,
            attributes: enriched.attributes.length,
            pdfAttributesAdded: Math.max(0, enriched.attributes.length - result.attributes.length),
            downloadFailures: enriched.documents.filter((doc) => doc.localPath?.startsWith("DOWNLOAD_FAILED")).length,
            error: enriched.error
          });
        } catch (error) {
          if (controller.signal.aborted || this.db.isCancellationRequested(run.id)) {
            this.db.updateRunItem(item.id, {
              status: "cancelled",
              error: "Cancelled by user."
            });
            await this.appendRunLog(layout, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            break;
          }
          this.db.updateRunItem(item.id, {
            status: "failed",
            error: error instanceof Error ? error.message : "Unexpected scrape error"
          });
          await this.appendRunLog(layout, "ITEM_FAILED", {
            catalogNumber: item.catalogNumber,
            error: formatError(error)
          });
        }
        this.db.recountRun(run.id);
        if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) break;
        await delay(manufacturer.rateLimitMs, controller.signal);
      }

      const status = this.db.isCancellationRequested(run.id) || controller.signal.aborted ? "cancelled" : "completed";
      if (status === "cancelled") this.db.cancelActiveRunItems(run.id);
      await this.finalizeRun(run.id, status);
    } catch (error) {
      if (controller.signal.aborted || this.db.isCancellationRequested(runId)) {
        this.db.cancelActiveRunItems(runId);
        await this.finalizeRun(runId, "cancelled");
        return;
      }
      this.db.updateRun(runId, {
        status: "failed",
        error: error instanceof Error ? error.message : "Run failed"
      });
      if (layout) {
        await this.appendRunLog(layout, "RUN_FAILED", { error: formatError(error) });
        await this.writeRunDebugBundle(layout, runId);
      }
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private async finalizeRun(runId: string, status: "completed" | "cancelled") {
    const finalRun = this.db.getRun(runId);
    if (!finalRun) return;
    const manufacturer = getManufacturerConfig(finalRun.manufacturerId);
    if (!manufacturer) throw new Error(`Unknown manufacturer ${finalRun.manufacturerId}`);
    this.db.recountRun(runId);
    const layout = buildRunOutputLayout(this.paths.outputDir, manufacturer, runId);
    await ensureRunOutputLayout(layout);
    const outputPath = await exportRunWorkbook({
      run: this.db.getRun(runId)!,
      manufacturer,
      items: this.db.getRunItems(runId),
      outputDir: layout.excelDir
    });
    this.db.updateRun(runId, {
      status,
      outputPath,
      error: status === "cancelled" ? "Cancelled by user." : undefined
    });
    const updatedRun = this.db.getRun(runId);
    await this.appendRunLog(layout, "RUN_FINALIZED", {
      status,
      processed: updatedRun?.processed,
      found: updatedRun?.found,
      partial: updatedRun?.partial,
      failed: updatedRun?.failed,
      excelPath: outputPath,
      logPath: layout.logPath,
      debugJsonPath: layout.debugJsonPath
    });
    await this.writeRunDebugBundle(layout, runId);
  }

  private async downloadDocuments(
    http: CachedHttpClient,
    documentsDir: string,
    imagesDir: string,
    manufacturerShortName: string,
    result: ProductResult,
    signal?: AbortSignal
  ): Promise<ProductResult> {
    const documents: DocumentRecord[] = [];
    const maxDownloads = 25;
    for (const [index, doc] of result.documents.entries()) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      if (index >= maxDownloads) {
        documents.push({ ...doc, localPath: "SKIPPED_MAX_DOCUMENT_LIMIT" });
        continue;
      }
      documents.push(await this.downloadDocument(http, documentsDir, imagesDir, manufacturerShortName, result.catalogNumber, doc, signal));
    }
    return { ...result, documents };
  }

  private async downloadDocument(
    http: CachedHttpClient,
    documentsDir: string,
    imagesDir: string,
    manufacturerShortName: string,
    catalogNumber: string,
    doc: DocumentRecord,
    signal?: AbortSignal
  ): Promise<DocumentRecord> {
    if (doc.localPath) return doc;
    try {
      if (doc.type === "image") {
        const localPath = await uniquePath(path.join(imagesDir, imageFileName(manufacturerShortName, catalogNumber)));
        await http.downloadImageAsPng(doc.url, localPath, signal);
        return { ...doc, localPath };
      }
      const extension = documentExtension(doc.url, doc.type);
      const suggestedName = `${catalogNumber}-${doc.type}-${safeLabel(doc.label)}${extension}`;
      const localPath = await http.downloadFile(doc.url, documentsDir, suggestedName, signal);
      return { ...doc, localPath };
    } catch (error) {
      return {
        ...doc,
        localPath: `DOWNLOAD_FAILED: ${error instanceof Error ? error.message : "unknown error"}`
      };
    }
  }

  private async appendRunLog(layout: RunOutputLayout, event: string, data?: Record<string, unknown>) {
    await fs.mkdir(layout.logsDir, { recursive: true });
    const payload = data ? ` ${JSON.stringify(data)}` : "";
    await fs.appendFile(layout.logPath, `[${new Date().toISOString()}] ${event}${payload}\n`, "utf8");
  }

  private async writeRunDebugBundle(layout: RunOutputLayout, runId: string) {
    await fs.mkdir(layout.logsDir, { recursive: true });
    const run = this.db.getRun(runId);
    const items = this.db.getRunItems(runId);
    const payload = {
      generatedAt: new Date().toISOString(),
      run,
      outputFolders: {
        run: layout.runDir,
        excel: layout.excelDir,
        images: layout.imagesDir,
        documents: layout.documentsDir,
        logs: layout.logsDir,
        logFile: layout.logPath,
        debugFile: layout.debugJsonPath
      },
      problemItems: items
        .filter((item) => {
          const documentFailures = item.result?.documents.some((doc) => doc.localPath?.startsWith("DOWNLOAD_FAILED"));
          return item.status !== "found" || Boolean(item.error || item.result?.error || documentFailures);
        })
        .map((item) => ({
          rowIndex: item.rowIndex,
          catalogNumber: item.catalogNumber,
          status: item.status,
          title: item.title,
          productUrl: item.productUrl,
          confidence: item.confidence,
          error: item.error,
          resultError: item.result?.error,
          documents: item.result?.documents,
          sources: item.result?.sources
        })),
      items: items.map((item) => ({
        rowIndex: item.rowIndex,
        catalogNumber: item.catalogNumber,
        status: item.status,
        title: item.title,
        productUrl: item.productUrl,
        confidence: item.confidence,
        error: item.error,
        resultStatus: item.result?.status,
        resultError: item.result?.error,
        documentCount: item.result?.documents.length ?? 0,
        sourceCount: item.result?.sources.length ?? 0,
        attributeCount: item.result?.attributes.length ?? 0
      }))
    };
    await fs.writeFile(layout.debugJsonPath, JSON.stringify(payload, null, 2), "utf8");
  }
}

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function safeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "document";
}

function documentExtension(url: string, type: DocumentRecord["type"]): string {
  const parsed = new URL(url);
  const fromPath = path.extname(parsed.pathname);
  if (fromPath) return fromPath;
  if (/pdfengine\/pdf/i.test(url) || type === "datasheet" || type === "certificate" || type === "manual") return ".pdf";
  if (type === "cad") return ".bin";
  return ".bin";
}

async function uniquePath(filePath: string): Promise<string> {
  if (!(await exists(filePath))) return filePath;
  const parsed = path.parse(filePath);
  let index = 2;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!(await exists(candidate))) return candidate;
    index += 1;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function imageFileName(manufacturerShortName: string, catalogNumber: string): string {
  return `${safeImagePart(manufacturerShortName)}.${safeImagePart(catalogNumber)}.png`;
}

function safeImagePart(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "") || "image";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
