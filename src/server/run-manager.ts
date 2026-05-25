import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentRecord, ManufacturerId, ProductResult, RunItemRecord, RunRecord } from "../shared/types.js";
import { getManufacturerConfig } from "./config/manufacturers.js";
import type { ScraperDb } from "./db.js";
import { exportRunWorkbook } from "./excel.js";
import { CachedHttpClient, delay } from "./scrapers/http-client.js";
import { getConnector } from "./scrapers/index.js";
import { GenericFallbackScraper } from "./scrapers/generic.js";
import { enrichResultFromDownloadedDocuments } from "./scrapers/document-enrichment.js";
import { finalizeQualityGate } from "./scrapers/quality-gate.js";
import { runDeterministicScrapePipeline } from "./scrapers/deterministic-pipeline.js";
import {
  applyFinalCompletenessStatus,
  evaluateFinalCompleteness,
  finalNetworkRetryDecision,
  repairFinalCompletenessFromEvidence,
  withFinalCompletenessDiagnostics,
  withFinalCompletenessPolicy
} from "./scrapers/final-completeness.js";
import { attachEvidence } from "./scrapers/evidence.js";
import { BrowserRenderSession } from "./scrapers/browser-renderer.js";
import type { AppPaths } from "./paths.js";
import { buildRunOutputLayout, ensureRunOutputLayout, type RunOutputLayout } from "./run-output.js";

export class RunManager {
  private activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly db: ScraperDb,
    private readonly paths: AppPaths
  ) {}

  createRun(input: { manufacturerId: ManufacturerId; inputFileName?: string; catalogNumbers: string[]; options?: RunRecord["options"] }): RunRecord {
    const run = this.db.createRun({
      id: createRunId(),
      manufacturerId: input.manufacturerId,
      inputFileName: input.inputFileName,
      catalogNumbers: input.catalogNumbers,
      options: input.options
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

  private updateItemStage(
    itemId: number,
    stage: string,
    stageMessage: string,
    patch: Partial<
      Pick<RunItemRecord, "status" | "title" | "productUrl" | "confidence" | "error" | "result">
    > = {}
  ) {
    this.db.updateRunItem(itemId, {
      ...patch,
      stage,
      stageMessage,
      stageStartedAt: new Date().toISOString()
    });
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
      const downloadDocumentsEnabled = run.options?.downloadDocuments !== false;
      layout = buildRunOutputLayout(this.paths.outputDir, manufacturer, run);
      await ensureRunOutputLayout(layout);
      await this.appendRunLog(layout, "RUN_START", {
        runId: run.id,
        manufacturer: manufacturer.shortName,
        inputFileName: run.inputFileName,
        total: run.total,
        downloadDocuments: downloadDocumentsEnabled,
        outputFolder: layout.runDir
      });
      if (this.db.isCancellationRequested(run.id)) {
        this.db.cancelActiveRunItems(run.id);
        await this.finalizeRun(run.id, "cancelled");
        return;
      }
      this.db.updateRun(run.id, { status: "running", error: undefined });

      const http = new CachedHttpClient(this.db, this.paths.cacheDir);
      const fallback = new GenericFallbackScraper(run.manufacturerId, http, manufacturer);
      const browserRenderer = new BrowserRenderSession();
      const pending = this.db.getPendingRunItems(run.id);
      try {
        for (const item of pending) {
        if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) break;
        this.updateItemStage(item.id, "official-source", "Scraping official source", { status: "processing", error: undefined });
        await this.appendRunLog(layout, "ITEM_START", { rowIndex: item.rowIndex, catalogNumber: item.catalogNumber });
        try {
          const result = await connector.scrape(item.catalogNumber, {
            http,
            manufacturer,
            runDir: layout.runDir,
            documentsDir: layout.documentsDir,
            signal: controller.signal,
            browserRenderer,
            learnedEndpoints: {
              list: (manufacturerId, limit) => this.db.listLearnedEndpoints(manufacturerId, limit),
              upsert: (endpoint) => this.db.upsertLearnedEndpoint(endpoint)
            },
            fallback: {
              scrape: (catalogNumber, sources) => fallback.scrape(catalogNumber, sources, controller.signal)
            },
            downloadDocument: (doc) =>
              this.downloadDocument(
                http,
                layout!.documentsDir,
                layout!.imagesDir,
                manufacturer.shortName,
                item.catalogNumber,
                doc,
                downloadDocumentsEnabled,
                controller.signal
              )
          });
          if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) {
            this.updateItemStage(item.id, "cancelled", "Cancelled by user.", { status: "cancelled", error: "Cancelled by user." });
            await this.appendRunLog(layout, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            break;
          }
          this.updateItemStage(item.id, "quality-gate", "Checking required fields from official result");
          const initiallyGated = finalizeQualityGate(result, manufacturer);
          this.updateItemStage(item.id, "downloads", "Downloading product images and documents");
          const withInitialDownloads = await this.downloadDocuments(
            http,
            layout.documentsDir,
            layout.imagesDir,
            manufacturer.shortName,
            initiallyGated,
            downloadDocumentsEnabled,
            controller.signal
          );
          this.updateItemStage(item.id, "document-enrichment", "Reading downloaded documents for missing values");
          let enriched = finalizeQualityGate(await enrichResultFromDownloadedDocuments(withInitialDownloads), manufacturer);
          let fallbackStages = enriched.diagnostics?.fallbackStages;
          if (!enriched.qualityGate?.passed) {
            this.updateItemStage(item.id, "quality-fallback", "Running fallback because required fields are missing");
            const withSmartFallbacks = await runDeterministicScrapePipeline(enriched, item.catalogNumber, {
              http,
              manufacturer,
              runDir: layout.runDir,
              documentsDir: layout.documentsDir,
              signal: controller.signal,
              browserRenderer,
              learnedEndpoints: {
                list: (manufacturerId, limit) => this.db.listLearnedEndpoints(manufacturerId, limit),
                upsert: (endpoint) => this.db.upsertLearnedEndpoint(endpoint)
              },
              fallback: {
                scrape: (catalogNumber, sources) => fallback.scrape(catalogNumber, sources, controller.signal)
              },
              downloadDocument: (doc) =>
                this.downloadDocument(
                  http,
                  layout!.documentsDir,
                  layout!.imagesDir,
                  manufacturer.shortName,
                  item.catalogNumber,
                  doc,
                  downloadDocumentsEnabled,
                  controller.signal
                )
            });
            this.updateItemStage(item.id, "downloads", "Downloading fallback images and documents");
            const withFallbackDownloads = await this.downloadDocuments(
              http,
              layout.documentsDir,
              layout.imagesDir,
              manufacturer.shortName,
              withSmartFallbacks,
              downloadDocumentsEnabled,
              controller.signal
            );
            this.updateItemStage(item.id, "document-enrichment", "Reading fallback documents for missing values");
            enriched = finalizeQualityGate(await enrichResultFromDownloadedDocuments(withFallbackDownloads), manufacturer);
            fallbackStages = enriched.diagnostics?.fallbackStages;
          }
          this.updateItemStage(item.id, "final-audit", "Checking final missing fields");
          const beforeFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer);
          const finalRepair = repairFinalCompletenessFromEvidence(enriched, manufacturer, beforeFinalCompleteness);
          let repairedFinalFields = finalRepair.repairedFields;
          if (repairedFinalFields.length) {
            this.updateItemStage(item.id, "final-field-repair", `Repairing ${repairedFinalFields.join(", ")} from existing evidence`);
            enriched = finalizeQualityGate(finalRepair.result, manufacturer);
            fallbackStages = enriched.diagnostics?.fallbackStages;
            await this.appendRunLog(layout, "FINAL_FIELD_REPAIR", {
              catalogNumber: item.catalogNumber,
              repairedFields: repairedFinalFields,
              repairs: finalRepair.records
            });
          }
          let afterRepairFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer);
          let networkRetry = {
            ...finalNetworkRetryDecision(enriched, manufacturer, afterRepairFinalCompleteness),
            attempted: false
          };
          if (networkRetry.shouldRetry) {
            await this.appendRunLog(layout, "FINAL_COMPLETENESS_START", {
              catalogNumber: item.catalogNumber,
              missing: afterRepairFinalCompleteness.missing,
              retryMissing: afterRepairFinalCompleteness.retryMissing,
              reason: networkRetry.reason,
              triedStages: networkRetry.triedStages,
              untriedStages: networkRetry.untriedStages
            });
            networkRetry = { ...networkRetry, attempted: true };
            this.updateItemStage(item.id, "final-network-retry", `Retrying final missing fields: ${afterRepairFinalCompleteness.retryMissing.join(", ")}`);
            const finalCompletenessManufacturer = withFinalCompletenessPolicy(manufacturer, afterRepairFinalCompleteness.retryMissing);
            const withFinalCompletenessFallbacks = await runDeterministicScrapePipeline(enriched, item.catalogNumber, {
              http,
              manufacturer: finalCompletenessManufacturer,
              runDir: layout.runDir,
              documentsDir: layout.documentsDir,
              signal: controller.signal,
              browserRenderer,
              learnedEndpoints: {
                list: (manufacturerId, limit) => this.db.listLearnedEndpoints(manufacturerId, limit),
                upsert: (endpoint) => this.db.upsertLearnedEndpoint(endpoint)
              },
              fallback: {
                scrape: (catalogNumber, sources) => fallback.scrape(catalogNumber, sources, controller.signal)
              },
              downloadDocument: (doc) =>
                this.downloadDocument(
                  http,
                  layout!.documentsDir,
                  layout!.imagesDir,
                  manufacturer.shortName,
                  item.catalogNumber,
                  doc,
                  downloadDocumentsEnabled,
                  controller.signal
                )
            });
            this.updateItemStage(item.id, "downloads", "Downloading final retry images and documents");
            const withFinalCompletenessDownloads = await this.downloadDocuments(
              http,
              layout.documentsDir,
              layout.imagesDir,
              manufacturer.shortName,
              withFinalCompletenessFallbacks,
              downloadDocumentsEnabled,
              controller.signal
            );
            this.updateItemStage(item.id, "document-enrichment", "Reading final retry documents for missing values");
            enriched = finalizeQualityGate(await enrichResultFromDownloadedDocuments(withFinalCompletenessDownloads), manufacturer);
            const postNetworkRepair = repairFinalCompletenessFromEvidence(enriched, manufacturer);
            if (postNetworkRepair.repairedFields.length) {
              this.updateItemStage(item.id, "final-field-repair", `Repairing ${postNetworkRepair.repairedFields.join(", ")} from final retry evidence`);
              enriched = finalizeQualityGate(postNetworkRepair.result, manufacturer);
              repairedFinalFields = [...new Set([...repairedFinalFields, ...postNetworkRepair.repairedFields])];
              await this.appendRunLog(layout, "FINAL_FIELD_REPAIR", {
                catalogNumber: item.catalogNumber,
                repairedFields: postNetworkRepair.repairedFields,
                repairs: postNetworkRepair.records
              });
            }
            fallbackStages = enriched.diagnostics?.fallbackStages;
          } else if (afterRepairFinalCompleteness.retryMissing.length) {
            await this.appendRunLog(layout, "FINAL_COMPLETENESS_SKIPPED", {
              catalogNumber: item.catalogNumber,
              missing: afterRepairFinalCompleteness.missing,
              retryMissing: afterRepairFinalCompleteness.retryMissing,
              reason: networkRetry.reason,
              triedStages: networkRetry.triedStages
            });
          }
          const afterFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer);
          if (beforeFinalCompleteness.missing.length || afterFinalCompleteness.missing.length) {
            enriched = withFinalCompletenessDiagnostics(enriched, beforeFinalCompleteness, afterFinalCompleteness, {
              repairedFields: repairedFinalFields,
              networkRetry
            });
            await this.appendRunLog(layout, "FINAL_COMPLETENESS_DONE", {
              catalogNumber: item.catalogNumber,
              beforeMissing: beforeFinalCompleteness.missing,
              retryMissing: beforeFinalCompleteness.retryMissing,
              repairedFields: repairedFinalFields,
              afterMissing: afterFinalCompleteness.missing,
              notApplicable: afterFinalCompleteness.notApplicable,
              networkRetry
            });
          }
          enriched = applyFinalCompletenessStatus(enriched, afterFinalCompleteness, manufacturer);
          this.updateItemStage(item.id, "evidence", "Attaching source evidence");
          enriched = attachEvidence(enriched);
          if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) {
            this.updateItemStage(item.id, "cancelled", "Cancelled by user.", { status: "cancelled", error: "Cancelled by user." });
            await this.appendRunLog(layout, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            break;
          }
          this.updateItemStage(item.id, "complete", `Completed as ${enriched.status}`, {
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
            qualityPassed: enriched.qualityGate?.passed,
            qualityScore: enriched.qualityGate?.score,
            qualityMissing: enriched.qualityGate?.missing,
            finalCompleteness: enriched.diagnostics?.finalCompleteness,
            fallbackStages,
            pdfAttributesAdded: Math.max(0, enriched.attributes.length - initiallyGated.attributes.length),
            downloadFailures: enriched.documents.filter((doc) => doc.downloadStatus === "failed").length,
            error: enriched.error
          });
        } catch (error) {
          if (controller.signal.aborted || this.db.isCancellationRequested(run.id)) {
            this.updateItemStage(item.id, "cancelled", "Cancelled by user.", {
              status: "cancelled",
              error: "Cancelled by user."
            });
            await this.appendRunLog(layout, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            break;
          }
          this.updateItemStage(item.id, "failed", error instanceof Error ? error.message : "Unexpected scrape error", {
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
      } finally {
        await browserRenderer.close();
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
    const layout = buildRunOutputLayout(this.paths.outputDir, manufacturer, finalRun);
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
    downloadDocumentsEnabled: boolean,
    signal?: AbortSignal
  ): Promise<ProductResult> {
    const documents: DocumentRecord[] = [];
    const maxDownloads = 25;
    const rankedDocuments = coalesceImageDocuments(result.documents).sort((left, right) => documentDownloadRank(left) - documentDownloadRank(right));
    let downloadCount = 0;
    for (const doc of rankedDocuments) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      if (doc.type !== "image" && !downloadDocumentsEnabled) {
        documents.push({
          ...doc,
          downloadStatus: "skipped",
          downloadError: "Document downloads disabled for this run."
        });
        continue;
      }
      if (downloadCount >= maxDownloads) {
        documents.push({
          ...doc,
          downloadStatus: "skipped",
          downloadError: `Skipped after ${maxDownloads} documents for this product.`
        });
        continue;
      }
      documents.push(await this.downloadDocument(http, documentsDir, imagesDir, manufacturerShortName, result.catalogNumber, doc, downloadDocumentsEnabled, signal));
      downloadCount += 1;
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
    downloadDocumentsEnabled: boolean,
    signal?: AbortSignal
  ): Promise<DocumentRecord> {
    if (doc.localPath) return doc;
    if (doc.type !== "image" && !downloadDocumentsEnabled) {
      return {
        ...doc,
        downloadStatus: "skipped",
        downloadError: "Document downloads disabled for this run."
      };
    }
    try {
      if (doc.type === "image") {
        const localPath = await uniquePath(path.join(imagesDir, imageFileName(manufacturerShortName, catalogNumber)));
        await http.downloadImageAsPng([doc.url, ...(doc.candidateUrls ?? [])], localPath, signal);
        return { ...doc, localPath, downloadStatus: "downloaded", downloadError: undefined };
      }
      const extension = documentExtension(doc.url, doc.type);
      const suggestedName = `${catalogNumber}-${doc.type}-${safeLabel(doc.label)}${extension}`;
      const localPath = await http.downloadFile(doc.url, documentsDir, suggestedName, signal);
      return { ...doc, localPath, downloadStatus: "downloaded", downloadError: undefined };
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      return {
        ...doc,
        downloadStatus: "failed",
        downloadError: error instanceof Error ? error.message : "unknown error"
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
    const learnedEndpoints = run ? this.db.listLearnedEndpoints(run.manufacturerId, 50) : [];
    const payload = {
      generatedAt: new Date().toISOString(),
      run,
      learnedEndpoints,
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
          const documentFailures = item.result?.documents.some(
            (doc) => doc.downloadStatus === "failed"
          );
          return item.status !== "found" || Boolean(item.error || item.result?.error || documentFailures);
        })
        .map((item) => ({
          rowIndex: item.rowIndex,
          catalogNumber: item.catalogNumber,
          status: item.status,
          stage: item.stage,
          stageMessage: item.stageMessage,
          stageStartedAt: item.stageStartedAt,
          title: item.title,
          productUrl: item.productUrl,
          confidence: item.confidence,
          error: item.error,
          resultError: item.result?.error,
          qualityGate: item.result?.qualityGate,
          diagnostics: item.result?.diagnostics,
          documents: item.result?.documents,
          sources: item.result?.sources,
          evidence: item.result?.evidence?.slice(0, 120)
        })),
      items: items.map((item) => ({
        rowIndex: item.rowIndex,
        catalogNumber: item.catalogNumber,
        status: item.status,
        stage: item.stage,
        stageMessage: item.stageMessage,
        stageStartedAt: item.stageStartedAt,
        title: item.title,
        productUrl: item.productUrl,
        confidence: item.confidence,
        error: item.error,
        resultStatus: item.result?.status,
        resultError: item.result?.error,
        qualityPassed: item.result?.qualityGate?.passed,
        qualityScore: item.result?.qualityGate?.score,
          qualityMissing: item.result?.qualityGate?.missing,
          finalCompleteness: item.result?.diagnostics?.finalCompleteness,
          fallbackStages: item.result?.diagnostics?.fallbackStages,
          documentCount: item.result?.documents.length ?? 0,
          sourceCount: item.result?.sources.length ?? 0,
          evidenceCount: item.result?.evidence?.length ?? 0,
          suggestedApiEndpoints: item.result?.diagnostics?.suggestedApiEndpoints,
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

function documentDownloadRank(doc: DocumentRecord): number {
  const label = `${doc.type} ${doc.label} ${doc.url}`.toLowerCase();
  let rank = 100;
  if (doc.type === "image") rank = 5;
  if (doc.type === "datasheet") rank = 10;
  if (doc.type === "certificate") rank = 20;
  if (doc.type === "manual") rank = 30;
  if (doc.type === "cad") rank = 40;
  if (/data.?sheet|specification|technical/.test(label)) rank -= 6;
  if (/certificate|declaration|conformity|rohs|weee|ul|ce\b/.test(label)) rank -= 5;
  if (/main|primary|product|iopmain|zoom|gallery/.test(label)) rank -= 4;
  if (/terms|privacy|warranty|brochure|catalogue|catalog\b/.test(label)) rank += 30;
  return rank;
}

export function coalesceImageDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const images = documents.filter((doc) => doc.type === "image");
  if (images.length <= 1) return documents;

  const rankedImages = [...images].sort((left, right) => imageDocumentRank(left) - imageDocumentRank(right));
  const primary = rankedImages[0];
  const candidateUrls = uniqueStrings([
    ...(primary.candidateUrls ?? []),
    ...rankedImages.slice(1).flatMap((doc) => [doc.url, ...(doc.candidateUrls ?? [])])
  ]).filter((url) => url !== primary.url);

  return [
    {
      ...primary,
      candidateUrls: candidateUrls.length ? candidateUrls : primary.candidateUrls
    },
    ...documents.filter((doc) => doc.type !== "image")
  ];
}

function imageDocumentRank(doc: DocumentRecord): number {
  const text = `${doc.label} ${doc.url}`.toLowerCase();
  let rank = documentDownloadRank(doc);
  if (doc.localPath || doc.downloadStatus === "downloaded") rank -= 50;
  if (/_400x400\b|[?&](?:width|w)=400\b|400\s*x\s*400/.test(text)) rank -= 25;
  if (/_master\b|master\./.test(text)) rank -= 15;
  if (/thumbnail|thumb|_100x100\b|[?&](?:width|w)=100\b|100\s*x\s*100/.test(text)) rank += 30;
  return rank;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
