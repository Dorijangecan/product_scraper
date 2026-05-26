import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentRecord, ManufacturerConfig, ManufacturerId, ProductResult, RunItemRecord, RunRecord } from "../shared/types.js";
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

export type DocumentDownloadProfile = "full" | "quality" | "images-only";

const INTERRUPTED_RUN_RESUME_WINDOW_MS = 5 * 60 * 1000;

export class RunManager {
  private activeRuns = new Map<string, AbortController>();
  private instantlyCancelledRuns = new Set<string>();

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
      if (this.isStaleInterruptedRun(run)) {
        this.db.cancelActiveRunItems(run.id);
        this.db.recountRun(run.id);
        this.db.updateRun(run.id, { status: "cancelled", error: "Interrupted while app was closed." });
        continue;
      }
      void this.processRun(run.id);
    }
  }

  private isStaleInterruptedRun(run: RunRecord): boolean {
    const updatedAt = Date.parse(run.updatedAt);
    if (!Number.isFinite(updatedAt)) return false;
    return Date.now() - updatedAt > INTERRUPTED_RUN_RESUME_WINDOW_MS;
  }

  async cancelRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.db.getRun(runId);
    if (!run) return undefined;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;

    this.instantlyCancelledRuns.add(run.id);
    this.db.updateRun(run.id, { status: "cancelled", error: "Cancelled by user." });
    this.db.cancelActiveRunItems(run.id);
    this.db.recountRun(run.id);
    this.activeRuns.get(run.id)?.abort();
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
      const rawManufacturer = getManufacturerConfig(run.manufacturerId);
      if (!rawManufacturer) throw new Error(`Unknown manufacturer ${run.manufacturerId}`);
      const connector = getConnector(run.manufacturerId);
      const downloadDocumentsEnabled = run.options?.downloadDocuments !== false;
      const downloadImagesEnabled = run.options?.downloadImages !== false;
      const generateExcelEnabled = run.options?.generateExcel !== false;
      const documentDownloadsForEnrichmentEnabled = shouldDownloadDocumentsForRun(rawManufacturer, {
        downloadDocuments: downloadDocumentsEnabled,
        generateExcel: generateExcelEnabled
      });
      // "Images only" mode: no Excel, no documents, just the PNGs. Treat the whole pipeline
      // as a fast path — skip Playwright modal renders, fallback retries, and PDF
      // enrichment, since none of those affect the saved images.
      const imageOnlyMode = !generateExcelEnabled && !downloadDocumentsEnabled && downloadImagesEnabled;
      // When the user disables document downloads, the quality gate must not demand non-image
      // documents (datasheet/manual/etc.) — otherwise it always "fails", spawning fallback work
      // that re-fetches and re-renders pages to look for a PDF we never intend to download.
      const manufacturer = documentDownloadsForEnrichmentEnabled
        ? rawManufacturer
        : withoutNonImageRequiredDocuments(rawManufacturer);
      layout = buildRunOutputLayout(this.paths.outputDir, manufacturer, run);
      await ensureRunOutputLayout(layout);
      await this.appendRunLog(layout, "RUN_START", {
        runId: run.id,
        manufacturer: manufacturer.shortName,
        inputFileName: run.inputFileName,
        total: run.total,
        downloadDocuments: downloadDocumentsEnabled,
        documentDownloadsForEnrichment: documentDownloadsForEnrichmentEnabled,
        downloadImages: downloadImagesEnabled,
        outputFolder: layout.runDir
      });
      if (this.db.isCancellationRequested(run.id)) {
        this.db.cancelActiveRunItems(run.id);
        if (!this.wasInstantlyCancelled(run.id)) {
          await this.finalizeRun(run.id, "cancelled");
        }
        return;
      }
      this.db.updateRun(run.id, { status: "running", error: undefined });

      const http = new CachedHttpClient(this.db, this.paths.cacheDir);
      // Per-host throttle keeps us polite even with N parallel workers hitting the same domain.
      // Manufacturer.rateLimitMs is now treated as the minimum interval between requests to the same host.
      http.setHostMinIntervalMs(Math.max(100, Math.floor(manufacturer.rateLimitMs / Math.max(1, manufacturer.concurrency ?? 3))));
      const fallback = new GenericFallbackScraper(run.manufacturerId, http, manufacturer);
      const browserRenderer = new BrowserRenderSession();
      const pending = this.db.getPendingRunItems(run.id);

      const layoutRef = layout!;
      const processItem = async (item: typeof pending[number]): Promise<void> => {
        if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) return;
        this.updateItemStage(item.id, "official-source", "Scraping official source", { status: "processing", error: undefined });
        await this.appendRunLog(layoutRef, "ITEM_START", { rowIndex: item.rowIndex, catalogNumber: item.catalogNumber });
        // layoutRef is captured via closure (declared above); avoid touching outer `layout` inside this hot path
        try {
          const result = await connector.scrape(item.catalogNumber, {
            http,
            manufacturer,
            runDir: layoutRef.runDir,
            documentsDir: layoutRef.documentsDir,
            signal: controller.signal,
            browserRenderer,
            downloadDocuments: documentDownloadsForEnrichmentEnabled,
            saveDocuments: downloadDocumentsEnabled,
            imageOnly: imageOnlyMode,
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
                documentDownloadsForEnrichmentEnabled,
                controller.signal,
                undefined,
                downloadImagesEnabled
              )
          });
          if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) {
            this.updateItemStage(item.id, "cancelled", "Cancelled by user.", { status: "cancelled", error: "Cancelled by user." });
            await this.appendRunLog(layoutRef, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            return;
          }
          this.updateItemStage(item.id, "quality-gate", "Checking required fields from official result");
          const initiallyGated = finalizeQualityGate(result, manufacturer);
          this.updateItemStage(item.id, "downloads", "Downloading product images and documents");
          const withInitialDownloads = await this.downloadDocuments(
            http,
            layoutRef.documentsDir,
            layoutRef.imagesDir,
            manufacturer.shortName,
            initiallyGated,
            documentDownloadsForEnrichmentEnabled,
            controller.signal,
            documentDownloadProfile(manufacturer, initiallyGated),
            downloadImagesEnabled
          );
          // In "Images only" mode the saved deliverable is just the PNG. Everything below this
          // line (PDF enrichment, fallback discovery, final completeness retry) exists only to
          // populate Excel columns we never write — so skip it all and treat the initial parse
          // as final. Cuts per-item time roughly in half on Balluff.
          let enriched: typeof withInitialDownloads;
          let fallbackStages: string[] | undefined;
          if (imageOnlyMode) {
            enriched = withInitialDownloads;
            fallbackStages = enriched.diagnostics?.fallbackStages;
          } else {
          this.updateItemStage(item.id, "document-enrichment", "Reading downloaded documents for missing values");
          enriched = finalizeQualityGate(await enrichFromDownloadedDocumentsIfPresent(withInitialDownloads), manufacturer);
          fallbackStages = enriched.diagnostics?.fallbackStages;
          if (!enriched.qualityGate?.passed) {
            this.updateItemStage(item.id, "quality-fallback", "Running fallback because required fields are missing");
            const withSmartFallbacks = await runDeterministicScrapePipeline(enriched, item.catalogNumber, {
              http,
              manufacturer,
              runDir: layoutRef.runDir,
              documentsDir: layoutRef.documentsDir,
              signal: controller.signal,
              browserRenderer,
              downloadDocuments: documentDownloadsForEnrichmentEnabled,
              saveDocuments: downloadDocumentsEnabled,
              imageOnly: imageOnlyMode,
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
                  layoutRef.documentsDir,
                  layoutRef.imagesDir,
                  manufacturer.shortName,
                  item.catalogNumber,
                  doc,
                  documentDownloadsForEnrichmentEnabled,
                  controller.signal,
                  undefined,
                  downloadImagesEnabled
                )
            });
            this.updateItemStage(item.id, "downloads", "Downloading fallback images and documents");
            const withFallbackDownloads = await this.downloadDocuments(
              http,
              layoutRef.documentsDir,
              layoutRef.imagesDir,
              manufacturer.shortName,
              withSmartFallbacks,
              documentDownloadsForEnrichmentEnabled,
              controller.signal,
              documentDownloadProfile(manufacturer, withSmartFallbacks),
              downloadImagesEnabled
            );
            this.updateItemStage(item.id, "document-enrichment", "Reading fallback documents for missing values");
            enriched = finalizeQualityGate(await enrichFromDownloadedDocumentsIfPresent(withFallbackDownloads), manufacturer);
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
            await this.appendRunLog(layoutRef, "FINAL_FIELD_REPAIR", {
              catalogNumber: item.catalogNumber,
              repairedFields: repairedFinalFields,
              repairs: finalRepair.records
            });
          }
          let afterRepairFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer);
          const exhaustedFields = this.db.listExhaustedFields(manufacturer.id, item.catalogNumber);
          const forceFinalRetry = run.options?.forceFinalRetry === true;
          let networkRetry = {
            ...finalNetworkRetryDecision(enriched, manufacturer, afterRepairFinalCompleteness, {
              exhaustedFields,
              force: forceFinalRetry
            }),
            attempted: false
          };
          if (networkRetry.shouldRetry) {
            await this.appendRunLog(layoutRef, "FINAL_COMPLETENESS_START", {
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
              runDir: layoutRef.runDir,
              documentsDir: layoutRef.documentsDir,
              signal: controller.signal,
              browserRenderer,
              downloadDocuments: documentDownloadsForEnrichmentEnabled,
              saveDocuments: downloadDocumentsEnabled,
              imageOnly: imageOnlyMode,
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
                  layoutRef.documentsDir,
                  layoutRef.imagesDir,
                  manufacturer.shortName,
                  item.catalogNumber,
                  doc,
                  documentDownloadsForEnrichmentEnabled,
                  controller.signal,
                  undefined,
                  downloadImagesEnabled
                )
            });
            this.updateItemStage(item.id, "downloads", "Downloading final retry images and documents");
            const withFinalCompletenessDownloads = await this.downloadDocuments(
              http,
              layoutRef.documentsDir,
              layoutRef.imagesDir,
              manufacturer.shortName,
              withFinalCompletenessFallbacks,
              documentDownloadsForEnrichmentEnabled,
              controller.signal,
              documentDownloadProfile(manufacturer, withFinalCompletenessFallbacks),
              downloadImagesEnabled
            );
            this.updateItemStage(item.id, "document-enrichment", "Reading final retry documents for missing values");
            enriched = finalizeQualityGate(await enrichFromDownloadedDocumentsIfPresent(withFinalCompletenessDownloads), manufacturer);
            const postNetworkRepair = repairFinalCompletenessFromEvidence(enriched, manufacturer);
            if (postNetworkRepair.repairedFields.length) {
              this.updateItemStage(item.id, "final-field-repair", `Repairing ${postNetworkRepair.repairedFields.join(", ")} from final retry evidence`);
              enriched = finalizeQualityGate(postNetworkRepair.result, manufacturer);
              repairedFinalFields = [...new Set([...repairedFinalFields, ...postNetworkRepair.repairedFields])];
              await this.appendRunLog(layoutRef, "FINAL_FIELD_REPAIR", {
                catalogNumber: item.catalogNumber,
                repairedFields: postNetworkRepair.repairedFields,
                repairs: postNetworkRepair.records
              });
            }
            fallbackStages = enriched.diagnostics?.fallbackStages;
          } else if (afterRepairFinalCompleteness.retryMissing.length) {
            await this.appendRunLog(layoutRef, "FINAL_COMPLETENESS_SKIPPED", {
              catalogNumber: item.catalogNumber,
              missing: afterRepairFinalCompleteness.missing,
              retryMissing: afterRepairFinalCompleteness.retryMissing,
              reason: networkRetry.reason,
              triedStages: networkRetry.triedStages
            });
          }
          const afterFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer);
          // If retry actually ran AND nothing new was found AND there are no untried stages left,
          // we can now be confident the manufacturer simply doesn't publish those preferred values
          // for this catalog number. Persist that finding so future runs skip the retry instantly.
          if (networkRetry.attempted && networkRetry.untriedStages.length === 0) {
            const stillMissingAfterRetry = afterFinalCompleteness.missing.filter(
              (field) => afterFinalCompleteness.requirements[field] !== "not-applicable"
            );
            for (const field of stillMissingAfterRetry) {
              this.db.markFieldExhausted(
                manufacturer.id,
                item.catalogNumber,
                field,
                `Exhausted stages ${networkRetry.triedStages.join(", ") || "(none)"} on ${new Date().toISOString()}`
              );
            }
            if (stillMissingAfterRetry.length) {
              await this.appendRunLog(layoutRef, "FIELDS_MARKED_EXHAUSTED", {
                catalogNumber: item.catalogNumber,
                fields: stillMissingAfterRetry,
                reason: "Final retry exhausted all stages without finding these fields; future runs will skip the retry unless forceFinalRetry is set."
              });
            }
          }
          if (beforeFinalCompleteness.missing.length || afterFinalCompleteness.missing.length) {
            enriched = withFinalCompletenessDiagnostics(enriched, beforeFinalCompleteness, afterFinalCompleteness, {
              repairedFields: repairedFinalFields,
              networkRetry
            });
            await this.appendRunLog(layoutRef, "FINAL_COMPLETENESS_DONE", {
              catalogNumber: item.catalogNumber,
              beforeMissing: beforeFinalCompleteness.missing,
              retryMissing: beforeFinalCompleteness.retryMissing,
              repairedFields: repairedFinalFields,
              afterMissing: afterFinalCompleteness.missing,
              notApplicable: afterFinalCompleteness.notApplicable,
              networkRetry,
              exhaustedFromCache: forceFinalRetry ? [] : [...exhaustedFields]
            });
          }
          enriched = applyFinalCompletenessStatus(enriched, afterFinalCompleteness, manufacturer);
          } // end of if (!imageOnlyMode)
          this.updateItemStage(item.id, "evidence", "Attaching source evidence");
          enriched = attachEvidence(enriched);
          if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) {
            this.updateItemStage(item.id, "cancelled", "Cancelled by user.", { status: "cancelled", error: "Cancelled by user." });
            await this.appendRunLog(layoutRef, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            return;
          }
          this.updateItemStage(item.id, "complete", `Completed as ${enriched.status}`, {
            status: enriched.status,
            title: enriched.title,
            productUrl: enriched.productUrl,
            confidence: enriched.confidence,
            error: enriched.error,
            result: enriched
          });
          await this.appendRunLog(layoutRef, "ITEM_DONE", {
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
            await this.appendRunLog(layoutRef, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            return;
          }
          this.updateItemStage(item.id, "failed", error instanceof Error ? error.message : "Unexpected scrape error", {
            status: "failed",
            error: error instanceof Error ? error.message : "Unexpected scrape error"
          });
          await this.appendRunLog(layoutRef, "ITEM_FAILED", {
            catalogNumber: item.catalogNumber,
            error: formatError(error)
          });
        }
        this.db.recountRun(run.id);
      };

      try {
        const concurrency = Math.max(1, Math.min(manufacturer.concurrency ?? 3, 8));
        await runWithConcurrency(pending, concurrency, processItem, () => this.db.isCancellationRequested(run.id) || controller.signal.aborted);
      } finally {
        await browserRenderer.close();
      }

      const status = this.db.isCancellationRequested(run.id) || controller.signal.aborted ? "cancelled" : "completed";
      if (status === "cancelled") this.db.cancelActiveRunItems(run.id);
      if (status === "cancelled" && this.wasInstantlyCancelled(run.id)) return;
      await this.finalizeRun(run.id, status);
    } catch (error) {
      if (controller.signal.aborted || this.db.isCancellationRequested(runId)) {
        this.db.cancelActiveRunItems(runId);
        if (!this.wasInstantlyCancelled(runId)) {
          await this.finalizeRun(runId, "cancelled");
        }
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
      this.instantlyCancelledRuns.delete(runId);
    }
  }

  private wasInstantlyCancelled(runId: string): boolean {
    return this.instantlyCancelledRuns.has(runId) || this.db.getRun(runId)?.status === "cancelled";
  }

  private async finalizeRun(runId: string, status: "completed" | "cancelled") {
    const finalRun = this.db.getRun(runId);
    if (!finalRun) return;
    const manufacturer = getManufacturerConfig(finalRun.manufacturerId);
    if (!manufacturer) throw new Error(`Unknown manufacturer ${finalRun.manufacturerId}`);
    this.db.recountRun(runId);
    const layout = buildRunOutputLayout(this.paths.outputDir, manufacturer, finalRun);
    await ensureRunOutputLayout(layout);
    // "Images only" mode skips workbook generation; everything else still produces one.
    const shouldGenerateExcel = finalRun.options?.generateExcel !== false;
    const outputPath = shouldGenerateExcel
      ? await exportRunWorkbook({
          run: this.db.getRun(runId)!,
          manufacturer,
          items: this.db.getRunItems(runId),
          outputDir: layout.excelDir
        })
      : undefined;
    this.db.updateRun(runId, {
      status,
      ...(outputPath ? { outputPath } : {}),
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
    signal?: AbortSignal,
    profile: DocumentDownloadProfile = "full",
    downloadImagesEnabled: boolean = true
  ): Promise<ProductResult> {
    const documents: DocumentRecord[] = [];
    const maxDownloads = profile === "full" ? 25 : 8;
    const rankedDocuments = coalesceImageDocuments(result.documents).sort((left, right) => documentDownloadRank(left) - documentDownloadRank(right));
    let downloadCount = 0;
    let imageIndex = 0;
    let nonImageDownloadCount = 0;
    const profileTypeCounts = new Map<DocumentRecord["type"], number>();
    for (const doc of rankedDocuments) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      if (doc.type === "image" && !downloadImagesEnabled) {
        documents.push({
          ...doc,
          downloadStatus: "skipped",
          downloadError: "Image downloads disabled for this run."
        });
        continue;
      }
      if (doc.type !== "image" && !downloadDocumentsEnabled) {
        documents.push({
          ...doc,
          downloadStatus: "skipped",
          downloadError: "Document downloads disabled for this run."
        });
        continue;
      }
      if (doc.type !== "image" && !shouldDownloadForProfile(doc, profile, profileTypeCounts, nonImageDownloadCount)) {
        documents.push({
          ...doc,
          downloadStatus: "skipped",
          downloadError: "Skipped non-essential local download; URL retained in workbook."
        });
        continue;
      }
      if (doc.type !== "image" && !shouldDownloadLocalDocument(doc)) {
        documents.push({
          ...doc,
          downloadStatus: "skipped",
          downloadError: "Skipped non-parseable binary document; URL retained in workbook."
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
      const indexForDoc = doc.type === "image" ? imageIndex : undefined;
      if (doc.type !== "image") {
        nonImageDownloadCount += 1;
        profileTypeCounts.set(doc.type, (profileTypeCounts.get(doc.type) ?? 0) + 1);
      }
      documents.push(await this.downloadDocument(http, documentsDir, imagesDir, manufacturerShortName, result.catalogNumber, doc, downloadDocumentsEnabled, signal, indexForDoc, downloadImagesEnabled));
      if (doc.type === "image") imageIndex += 1;
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
    signal?: AbortSignal,
    imageIndex?: number,
    downloadImagesEnabled: boolean = true
  ): Promise<DocumentRecord> {
    if (doc.localPath) return doc;
    if (doc.type === "image" && !downloadImagesEnabled) {
      return {
        ...doc,
        downloadStatus: "skipped",
        downloadError: "Image downloads disabled for this run."
      };
    }
    if (doc.type !== "image" && !downloadDocumentsEnabled) {
      return {
        ...doc,
        downloadStatus: "skipped",
        downloadError: "Document downloads disabled for this run."
      };
    }
    if (doc.type !== "image" && !shouldDownloadLocalDocument(doc)) {
      return {
        ...doc,
        downloadStatus: "skipped",
        downloadError: "Skipped non-parseable binary document; URL retained in workbook."
      };
    }
    try {
      if (doc.type === "image") {
        const localPath = await uniquePath(path.join(imagesDir, imageFileName(manufacturerShortName, catalogNumber, imageIndex)));
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

export function documentDownloadProfile(manufacturer: { id: string }, result: ProductResult): DocumentDownloadProfile {
  if (manufacturer.id === "balluff") return "quality";
  return "full";
}

export function shouldDownloadDocumentsForRun(
  manufacturer: { id: string },
  options: { downloadDocuments: boolean; generateExcel: boolean }
): boolean {
  if (options.downloadDocuments) return true;
  // Balluff often publishes required electrical and dimensional data only in the datasheet
  // modal/PDF. If an Excel workbook is being generated, keep the first datasheet in the
  // enrichment path even when the broad "save documents" option is off.
  return options.generateExcel && manufacturer.id === "balluff";
}

function shouldDownloadForProfile(
  doc: DocumentRecord,
  profile: DocumentDownloadProfile,
  typeCounts: Map<DocumentRecord["type"], number>,
  nonImageDownloadCount: number
): boolean {
  if (doc.type === "image") return true;
  if (profile === "full") return true;
  if (profile === "images-only") return false;
  if (nonImageDownloadCount >= 3) return false;
  const countForType = typeCounts.get(doc.type) ?? 0;
  if (doc.type === "datasheet") return countForType < 1;
  if (doc.type === "certificate") return countForType < 1;
  if (doc.type === "manual") return countForType < 1;
  if (doc.type === "other" && countForType < 1) {
    return /\.pdf(?:[?#]|$)/i.test(doc.url) || /pdfengine\/pdf/i.test(doc.url);
  }
  return false;
}

function shouldDownloadLocalDocument(doc: DocumentRecord): boolean {
  if (doc.type === "image") return true;
  const extension = documentExtension(doc.url, doc.type).toLowerCase();
  if (extension === ".pdf") return true;
  return false;
}

async function enrichFromDownloadedDocumentsIfPresent(result: ProductResult): Promise<ProductResult> {
  if (!result.documents.some((doc) => shouldParseDownloadedDocument(doc))) return result;
  return enrichResultFromDownloadedDocuments(result);
}

function shouldParseDownloadedDocument(doc: DocumentRecord): boolean {
  if (doc.downloadStatus && doc.downloadStatus !== "downloaded") return false;
  if (!doc.localPath || !/\.pdf$/i.test(doc.localPath)) return false;
  return ["datasheet", "certificate", "manual", "other"].includes(doc.type);
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

function imageFileName(manufacturerShortName: string, catalogNumber: string, index?: number): string {
  const suffix = index && index > 0 ? `_${index + 1}` : "";
  return `${safeImagePart(manufacturerShortName)}.${safeImagePart(catalogNumber)}${suffix}.png`;
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

// When the user disables document downloads, the quality gate must not require non-image
// documents — otherwise gate failures cascade into fallback retries that try to fetch
// a PDF we never intend to keep. We leave the "image" requirement intact (images are
// still downloaded) and drop everything else.
function withoutNonImageRequiredDocuments(manufacturer: ManufacturerConfig): ManufacturerConfig {
  const recipe = manufacturer.scrapeRecipe;
  if (!recipe?.requiredDocuments?.length) return manufacturer;
  const isImageRequirement = (pattern: string) => /(^|\|)\s*image\s*($|\|)/i.test(pattern);
  const filtered = recipe.requiredDocuments.filter((pattern) => isImageRequirement(String(pattern)));
  if (filtered.length === recipe.requiredDocuments.length) return manufacturer;
  return {
    ...manufacturer,
    scrapeRecipe: {
      ...recipe,
      requiredDocuments: filtered
    }
  };
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

const MAX_GALLERY_IMAGES = 5;

export function coalesceImageDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const images = documents.filter((doc) => doc.type === "image");
  if (images.length <= 1) return documents;

  // Group by image identity (same product image at different sizes/qualities collapses into one;
  // distinct gallery images keep their own groups).
  const groups = new Map<string, DocumentRecord[]>();
  for (const image of images) {
    const identity = imageIdentity(image.url);
    const existing = groups.get(identity);
    if (existing) existing.push(image);
    else groups.set(identity, [image]);
  }

  const coalescedGroups: DocumentRecord[] = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort((left, right) => imageDocumentRank(left) - imageDocumentRank(right));
    const primary = ranked[0];
    const candidateUrls = uniqueStrings([
      ...(primary.candidateUrls ?? []),
      ...ranked.slice(1).flatMap((doc) => [doc.url, ...(doc.candidateUrls ?? [])])
    ]).filter((url) => url !== primary.url);
    coalescedGroups.push({
      ...primary,
      candidateUrls: candidateUrls.length ? candidateUrls : primary.candidateUrls
    });
  }

  // Rank distinct gallery images and cap how many we'll keep / download.
  const rankedGroups = coalescedGroups.sort((left, right) => imageDocumentRank(left) - imageDocumentRank(right));
  const kept = rankedGroups.slice(0, MAX_GALLERY_IMAGES);

  return [...kept, ...documents.filter((doc) => doc.type !== "image")];
}

function imageIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").pop() ?? parsed.pathname;
    const stem = filename.replace(/\.(?:png|jpe?g|webp|gif|avif|svg)$/i, "");
    return stem
      .replace(/[-_](?:\d{2,4}x\d{2,4}|master|thumb(?:nail)?|small|medium|large|hd|original|main|crop(?:ped)?)$/i, "")
      .toLowerCase();
  } catch {
    return url.toLowerCase();
  }
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

/**
 * Runs an async worker over an iterable of items with a fixed concurrency limit.
 * Workers pull from a shared queue, so faster items don't wait behind slower ones.
 * Per-item errors are swallowed by `worker` (it logs them itself); a thrown error here
 * cancels the whole pool. `shouldStop` is polled before pulling each new item so
 * cancellations are observed promptly.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean
): Promise<void> {
  if (!items.length) return;
  const queue = [...items];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const runOne = async (): Promise<void> => {
    while (true) {
      if (shouldStop()) return;
      const index = cursor;
      if (index >= queue.length) return;
      cursor = index + 1;
      await worker(queue[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
}
