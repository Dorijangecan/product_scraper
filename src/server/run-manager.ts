import { uniqueStrings } from "./text-util.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sanitize from "sanitize-filename";
import type {
  CustomerDocumentRecord,
  DocumentDownloadProfile as SharedDocumentDownloadProfile,
  DocumentProcessingDiagnostic,
  DocumentRecord,
  ManufacturerConfig,
  ManufacturerId,
  ProductResult,
  RunItemRecord,
  RunRecord
} from "../shared/types.js";
import {
  applyCustomerDocumentOverride,
  CustomerDocumentParseCache,
  extractCustomerDocumentAttributes,
  type CustomerDocumentProgressEvent
} from "./scrapers/customer-documents.js";
import { getManufacturerConfig } from "./config/manufacturers.js";
import type { ScraperDb } from "./db.js";
import { CachedHttpClient, delay } from "./scrapers/http-client.js";
import { getConnector } from "./scrapers/index.js";
import { emptyResult } from "./scrapers/normalizer.js";
import { finalizeQualityGate } from "./scrapers/quality-gate.js";
import {
  applyFinalCompletenessStatus,
  evaluateFinalCompleteness,
  finalNetworkRetryDecision,
  repairFinalCompletenessFromEvidence,
  withFinalCompletenessDiagnostics,
  withFinalCompletenessPolicy
} from "./scrapers/final-completeness.js";
import { canonicalDocumentUrlKey } from "./scrapers/dedupe.js";
import { attachEvidence } from "./scrapers/evidence.js";
import { BrowserRenderSession } from "./scrapers/browser-renderer.js";
import type { AppPaths } from "./paths.js";
import { buildRunOutputLayout, ensureRunOutputLayout, type RunOutputLayout } from "./run-output.js";
import { documentUrlLooksRelevant, isPdfLikeDocument } from "./scrapers/document-url.js";
import { isDocumentViewerUrl, resolveViewerPdfUrl } from "./scrapers/document-viewer-resolver.js";
import { isLikelySchematicImage } from "./scrapers/generic.js";

export type DocumentDownloadProfile = SharedDocumentDownloadProfile;

const INTERRUPTED_RUN_RESUME_WINDOW_MS = 5 * 60 * 1000;

// Some connectors (e.g. Eaton, when a catalog number has no real product page) fall through a
// long chain of discovery/reader/browser-render fallback stages. Under bot-mitigation or a slow
// host, a single stage can hang well past its own stated timeout, stalling one of the run's
// concurrency slots indefinitely — observed once as an 11+ minute freeze that required a manual
// cancel. This bounds the WORST case only: 4 minutes comfortably covers every legitimate
// fallback path's stated per-stage budgets, so a normal (even slow) scrape never gets cut off —
// only a genuinely stuck one does, and it then fails gracefully instead of hanging the slot.
const ITEM_SCRAPE_TIMEOUT_MS = 4 * 60 * 1000;

// Resolves once `signal` aborts, using the same rejection message on the timeout path and the
// parent-run-cancellation path so Promise.race always settles instead of leaving a scrape hung.
function abortSignalRejection(signal: AbortSignal, message: string): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error(message));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
  });
}

interface LocalDownloadSelection {
  images: boolean;
  pdfs: boolean;
  cad: boolean;
}

export class RunManager {
  private activeRuns = new Map<string, AbortController>();
  private instantlyCancelledRuns = new Set<string>();
  private pausedRuns = new Set<string>();
  private resumeAfterPauseRuns = new Set<string>();

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
    const resumable = this.db.listRunsByStatus(["queued", "running", "pausing", "cancelling"]);
    for (const run of resumable) {
      if (run.status === "pausing") {
        void this.finalizePausedRun(run.id);
        continue;
      }
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

    this.pausedRuns.delete(run.id);
    this.resumeAfterPauseRuns.delete(run.id);
    this.instantlyCancelledRuns.add(run.id);
    this.db.updateRun(run.id, { status: "cancelled", error: "Cancelled by user." });
    this.db.cancelActiveRunItems(run.id);
    this.db.recountRun(run.id);
    this.activeRuns.get(run.id)?.abort();
    return this.db.getRun(run.id);
  }

  async pauseRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.db.getRun(runId);
    if (!run) return undefined;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "paused") return run;
    if (run.status === "pausing") return run;

    this.resumeAfterPauseRuns.delete(run.id);
    this.pausedRuns.add(run.id);
    this.db.updateRun(run.id, {
      status: "pausing",
      activityStage: "pausing",
      activityMessage: "Pausing active work. The current row will be retried on resume.",
      error: undefined
    });
    const controller = this.activeRuns.get(run.id);
    if (controller) {
      controller.abort();
      this.finalizePauseSoon(run.id);
      return this.db.getRun(run.id);
    }
    await this.finalizePausedRun(run.id);
    return this.db.getRun(run.id);
  }

  async resumeRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.db.getRun(runId);
    if (!run) return undefined;
    if (run.status !== "paused" && run.status !== "pausing") return run;

    if (this.activeRuns.has(run.id)) {
      this.resumeAfterPauseRuns.add(run.id);
      if (run.status === "pausing") {
        await this.finalizePausedRun(run.id);
      }
      return this.db.getRun(run.id);
    }

    this.pausedRuns.delete(run.id);
    this.resumeAfterPauseRuns.delete(run.id);
    this.db.updateRun(run.id, {
      status: "queued",
      activityStage: undefined,
      activityMessage: undefined,
      activityStartedAt: undefined,
      error: undefined
    });
    void this.processRun(run.id);
    return this.db.getRun(run.id);
  }

  private finalizePauseSoon(runId: string) {
    const timer = setTimeout(() => {
      const run = this.db.getRun(runId);
      if (run?.status === "pausing") {
        void this.finalizePausedRun(runId);
      }
    }, 2500);
    timer.unref?.();
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

  private updateRunActivity(runId: string, stage: string | undefined, message: string | undefined) {
    this.db.updateRun(runId, {
      activityStage: stage,
      activityMessage: message,
      activityStartedAt: stage ? new Date().toISOString() : undefined
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
      if (run.status === "paused") return;
      const rawManufacturer = getManufacturerConfig(run.manufacturerId);
      if (!rawManufacturer) throw new Error(`Unknown manufacturer ${run.manufacturerId}`);
      const connector = getConnector(run.manufacturerId);
      const downloadPdfsEnabled = run.options?.downloadPdfs ?? run.options?.downloadDocuments ?? false;
      const downloadCadEnabled = run.options?.downloadCad ?? run.options?.downloadDocuments ?? false;
      const downloadDocumentsEnabled = downloadPdfsEnabled || downloadCadEnabled;
      const downloadImagesEnabled = run.options?.downloadImages !== false;
      const finalCompletenessOptions = { requireImage: downloadImagesEnabled };
      const generateExcelEnabled = run.options?.generateExcel !== false;
      const generateLinksFileEnabled = run.options?.generateLinksFile === true;
      const localDownloads: LocalDownloadSelection = {
        images: downloadImagesEnabled,
        pdfs: downloadPdfsEnabled,
        cad: downloadCadEnabled
      };
      const documentDownloadsForEnrichmentEnabled = shouldDownloadDocumentsForRun(rawManufacturer, {
        downloadDocuments: downloadDocumentsEnabled,
        generateExcel: generateExcelEnabled
      });
      // "Images only" mode: no Excel, no documents, just the PNGs. Treat the whole pipeline
      // as a fast path — skip Playwright modal renders, fallback retries, and PDF
      // enrichment, since none of those affect the saved images.
      const imageOnlyMode = !generateExcelEnabled && !generateLinksFileEnabled && !downloadDocumentsEnabled && downloadImagesEnabled;
      const linksOnlyMode = generateLinksFileEnabled && !generateExcelEnabled && !downloadImagesEnabled && !downloadDocumentsEnabled;
      // When the user disables document downloads, the quality gate must not demand non-image
      // documents (datasheet/manual/etc.) — otherwise it always "fails", spawning fallback work
      // that re-fetches and re-renders pages to look for a PDF we never intend to download.
      const manufacturer = documentDownloadsForEnrichmentEnabled
        ? rawManufacturer
        : withoutNonImageRequiredDocuments(rawManufacturer);
      layout = buildRunOutputLayout(this.paths.outputDir, manufacturer, run);
      await ensureRunOutputLayout(layout);
      // Move any staged customer-provided documents into the run folder so the
      // authoritative source-of-truth lives next to the scraped output. The persisted
      // RunOptions get rewritten with the new paths so downstream code (parser, debug
      // bundle) always reads from the final location.
      const customerDocuments = await this.relocateCustomerDocuments(run.options?.customerDocuments ?? [], layout.customerDocumentsDir);
      if (customerDocuments.length) {
        this.db.updateRunOptions(run.id, { customerDocuments });
      }
      const assetOnlyMode = !generateExcelEnabled && customerDocuments.length === 0;
      await this.appendRunLog(layout, "RUN_START", {
        runId: run.id,
        manufacturer: manufacturer.shortName,
        inputFileName: run.inputFileName,
        total: run.total,
        downloadDocuments: downloadDocumentsEnabled,
        downloadPdfs: downloadPdfsEnabled,
        downloadCad: downloadCadEnabled,
        documentDownloadsForEnrichment: documentDownloadsForEnrichmentEnabled,
        downloadImages: downloadImagesEnabled,
        generateExcel: generateExcelEnabled,
        generateLinksFile: generateLinksFileEnabled,
        customerDocumentCount: customerDocuments.length,
        outputFolder: layout.runDir
      });
      if (this.db.isCancellationRequested(run.id)) {
        this.db.cancelActiveRunItems(run.id);
        if (!this.wasInstantlyCancelled(run.id)) {
          await this.finalizeRun(run.id, "cancelled");
        }
        return;
      }
      if (this.db.isPauseRequested(run.id)) {
        await this.finalizePausedRun(run.id, layout);
        return;
      }
      this.db.updateRun(run.id, { status: "running", error: undefined });

      const http = new CachedHttpClient(this.db, this.paths.cacheDir);
      // Per-host throttle keeps us polite even with N parallel workers hitting the same domain.
      // Manufacturer.rateLimitMs is now treated as the minimum interval between requests to the same host.
      http.setHostMinIntervalMs(Math.max(100, Math.floor(manufacturer.rateLimitMs / Math.max(1, manufacturer.concurrency ?? 3))));
      // Parse every customer document once and reuse for every catalog lookup. PDF page
      // walks are expensive — without this cache, a 60-page Eaton catalogue would be
      // re-walked once per catalog number in the run.
      const customerDocumentCache = new CustomerDocumentParseCache();
      const sharedDocumentDownloads = new Map<string, Promise<string>>();
      const browserRenderer = new BrowserRenderSession();
      const pending = this.db.getPendingRunItems(run.id);
      const { GenericFallbackScraper } = await import("./scrapers/generic.js");
      const { runDeterministicScrapePipeline } = await import("./scrapers/deterministic-pipeline.js");
      const fallback = new GenericFallbackScraper(run.manufacturerId, http, manufacturer);

      const layoutRef = layout!;
      const processItem = async (item: typeof pending[number]): Promise<void> => {
        if (this.db.isPauseRequested(run.id)) return;
        if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) return;
        await this.appendRunLog(layoutRef, "ITEM_START", { rowIndex: item.rowIndex, catalogNumber: item.catalogNumber });
        // layoutRef is captured via closure (declared above); avoid touching outer `layout` inside this hot path
        try {
          let customerExtractionFirst: Awaited<ReturnType<typeof extractCustomerDocumentAttributes>> | null = null;
          let customerExtractionEarly: Awaited<ReturnType<typeof extractCustomerDocumentAttributes>> | null = null;
          let customerFirstShortCircuit = false;
          let customerEarlyShortCircuit = false;
          let enriched: ProductResult | undefined;
          let fallbackStages: string[] | undefined;
          let initialAttributeCount = 0;

          // First pass: scan customer documents so the user gets early "customer doc matched"
          // feedback in the UI and so cached parse work primes for the override re-run later.
          // Generic customer-first short-circuiting happens only after quality-gate identity
          // and core technical completeness checks pass; otherwise website data is still merged.
          if (!imageOnlyMode && customerDocuments.length > 0) {
            this.updateItemStage(
              item.id,
              "customer-override",
              `Scanning ${customerDocuments.length} customer document${customerDocuments.length === 1 ? "" : "s"} before manufacturer website lookup`,
              { status: "processing", error: undefined }
            );
            customerExtractionFirst = await extractCustomerDocumentAttributes(item.catalogNumber, customerDocuments, {
              cache: customerDocumentCache,
              onProgress: (event) => {
                const message = formatCustomerProgress(event, item.catalogNumber);
                if (message) this.updateItemStage(item.id, "customer-override", message);
              }
            });
            if (customerExtractionFirst.attributes.length > 0) {
              const customerOnlyResult = finalizeQualityGate(
                applyCustomerDocumentOverride(
                  emptyResult(manufacturer.id, item.catalogNumber, "Official source skipped because customer document already supplied complete data."),
                  customerExtractionFirst
                ),
                manufacturer
              );
              if (shouldShortCircuitCustomerFirst(customerOnlyResult, customerExtractionFirst)) {
                customerFirstShortCircuit = true;
                enriched = customerOnlyResult;
                fallbackStages = enriched.diagnostics?.fallbackStages;
                await this.appendRunLog(layoutRef, "CUSTOMER_FIRST_SHORT_CIRCUIT", {
                  catalogNumber: item.catalogNumber,
                  attributesFound: customerExtractionFirst.attributes.length,
                  documentsFound: customerExtractionFirst.documents.length,
                  statusAfter: enriched.status,
                  qualityMissing: enriched.qualityGate?.missing ?? [],
                  reason: "Customer document supplied complete source-backed data; skipped slow official lookup."
                });
              }
              await this.appendRunLog(layoutRef, "CUSTOMER_FIRST_SCAN", {
                catalogNumber: item.catalogNumber,
                attributesFound: customerExtractionFirst.attributes.length,
                documentsFound: customerExtractionFirst.documents.length,
                reason: "Customer document matched — proceeding with website scrape so both sources contribute; customer values will override on conflict."
              });
            } else {
              await this.appendRunLog(layoutRef, "CUSTOMER_FIRST_SCAN_EMPTY", {
                catalogNumber: item.catalogNumber,
                parseFailures: customerExtractionFirst.parseFailures
              });
            }
          }

          if (!customerFirstShortCircuit) {
          this.updateItemStage(item.id, "official-source", "Scraping official source", { status: "processing", error: undefined });
          // Per-item scrape signal: aborts if the whole run is cancelled/paused (propagated from
          // controller.signal) OR if this single item's official-source scrape runs past
          // ITEM_SCRAPE_TIMEOUT_MS. Scoped to this item only — a slow/stuck catalog number can no
          // longer stall its concurrency slot forever; it fails and the run moves on.
          const itemScrapeController = new AbortController();
          const onParentAbort = () => itemScrapeController.abort(controller.signal.reason);
          if (controller.signal.aborted) itemScrapeController.abort(controller.signal.reason);
          else controller.signal.addEventListener("abort", onParentAbort, { once: true });
          const itemTimeoutHandle = setTimeout(
            () => itemScrapeController.abort(new Error(`Official-source scrape timed out after ${Math.round(ITEM_SCRAPE_TIMEOUT_MS / 1000)}s`)),
            ITEM_SCRAPE_TIMEOUT_MS
          );
          let result: ProductResult;
          try {
            result = await Promise.race([
              connector.scrape(item.catalogNumber, {
                http,
                manufacturer,
                runDir: layoutRef.runDir,
                documentsDir: layoutRef.documentsDir,
                signal: itemScrapeController.signal,
                browserRenderer,
                downloadDocuments: documentDownloadsForEnrichmentEnabled,
                saveDocuments: downloadDocumentsEnabled,
                imageOnly: imageOnlyMode,
                learnedEndpoints: {
                  list: (manufacturerId, limit) => this.db.listLearnedEndpoints(manufacturerId, limit),
                  upsert: (endpoint) => this.db.upsertLearnedEndpoint(endpoint)
                },
                learnedExtractors: {
                  list: (manufacturerId, host, limit) => this.db.listLearnedExtractors(manufacturerId, host, limit),
                  upsert: (extractor) => this.db.upsertLearnedExtractor(extractor)
                },
                targetHealth: {
                  record: (observation) => this.db.recordStageObservation(observation),
                  get: (manufacturerId, stage, host) => this.db.getTargetHealth(manufacturerId, stage, host)
                },
                fallback: {
                  scrape: (catalogNumber, sources) => fallback.scrape(catalogNumber, sources, itemScrapeController.signal)
                },
                downloadDocument: (doc) =>
                  this.downloadDocument(
                    http,
                    layout!.documentsDir,
                    layout!.cadDir,
                    layout!.imagesDir,
                    manufacturer.shortName,
                    item.catalogNumber,
                    doc,
                    localDownloads,
                    itemScrapeController.signal,
                    undefined,
                    sharedDocumentDownloads
                  )
              }),
              abortSignalRejection(
                itemScrapeController.signal,
                `Official-source scrape for ${item.catalogNumber} timed out after ${Math.round(ITEM_SCRAPE_TIMEOUT_MS / 1000)}s`
              )
            ]);
          } finally {
            clearTimeout(itemTimeoutHandle);
            controller.signal.removeEventListener("abort", onParentAbort);
          }
          if (this.db.isPauseRequested(run.id)) {
            await this.markItemPaused(run.id, item, layoutRef);
            return;
          }
          if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) {
            this.updateItemStage(item.id, "cancelled", "Cancelled by user.", { status: "cancelled", error: "Cancelled by user." });
            await this.appendRunLog(layoutRef, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            return;
          }
          this.updateItemStage(item.id, "quality-gate", "Checking required fields from official result");
          const initiallyGated = finalizeQualityGate(result, manufacturer);
          initialAttributeCount = initiallyGated.attributes.length;
          this.updateItemStage(item.id, "downloads", "Downloading product images and documents");
          const withInitialDownloads = await this.downloadDocuments(
            http,
            layoutRef.documentsDir,
            layoutRef.cadDir,
            layoutRef.imagesDir,
            manufacturer.shortName,
            initiallyGated,
            localDownloads,
            controller.signal,
            documentDownloadProfile(manufacturer, initiallyGated, { saveDocuments: downloadDocumentsEnabled }),
            item.catalogNumber,
            sharedDocumentDownloads
          );
          // In "Images only" mode the saved deliverable is just the PNG. Everything below this
          // line (PDF enrichment, fallback discovery, final completeness retry) exists only to
          // populate Excel columns we never write — so skip it all and treat the initial parse
          // as final. Cuts per-item time roughly in half on Balluff.
          // Initialize enriched to withInitialDownloads so every branch below has something to
          // refine; the customer-override / fallback paths overwrite as needed.
          enriched = withInitialDownloads;
          // Customer documents are authoritative. When the website couldn't find this
          // catalog AND the customer handed us a doc that covers it, scan the customer
          // payload first and short-circuit the heavy fallback chain — there's no point
          // burning minutes on browser fallback / final-network-retry for a catalog the
          // customer already explained to us.
          if (!imageOnlyMode && customerDocuments.length > 0 && initiallyGated.status === "failed") {
            this.updateItemStage(
              item.id,
              "customer-override",
              `Website returned nothing — scanning ${customerDocuments.length} customer document${customerDocuments.length === 1 ? "" : "s"} for ${item.catalogNumber}`
            );
            customerExtractionEarly =
              customerExtractionFirst ??
              (await extractCustomerDocumentAttributes(item.catalogNumber, customerDocuments, {
                cache: customerDocumentCache,
                onProgress: (event) => {
                  const message = formatCustomerProgress(event, item.catalogNumber);
                  if (message) this.updateItemStage(item.id, "customer-override", message);
                }
              }));
            if (customerExtractionEarly.attributes.length > 0) {
              customerEarlyShortCircuit = true;
              enriched = applyCustomerDocumentOverride(initiallyGated, customerExtractionEarly);
              fallbackStages = enriched.diagnostics?.fallbackStages;
              await this.appendRunLog(layoutRef, "CUSTOMER_EARLY_OVERRIDE", {
                catalogNumber: item.catalogNumber,
                attributesAdded: customerExtractionEarly.attributes.length,
                documentsAdded: customerExtractionEarly.documents.length,
                statusAfter: enriched.status,
                reason: "Website found nothing; customer document carried the data — skipping fallback chain."
              });
            } else {
              await this.appendRunLog(layoutRef, "CUSTOMER_EARLY_OVERRIDE_EMPTY", {
                catalogNumber: item.catalogNumber,
                parseFailures: customerExtractionEarly.parseFailures
              });
            }
          }
          if (imageOnlyMode || assetOnlyMode) {
            enriched = assetOnlyMode ? applyAssetOnlyStatus(withInitialDownloads) : withInitialDownloads;
            fallbackStages = enriched.diagnostics?.fallbackStages;
          } else if (linksOnlyMode) {
            enriched = withInitialDownloads;
            fallbackStages = enriched.diagnostics?.fallbackStages;
          } else if (customerEarlyShortCircuit) {
            // Already populated above. Skip the entire enrichment / fallback / final-audit chain.
          } else {
          this.updateItemStage(item.id, "document-enrichment", "Reading downloaded documents for missing values");
          enriched = finalizeQualityGate(await enrichFromDownloadedDocumentsIfPresent(withInitialDownloads), manufacturer);
          fallbackStages = enriched.diagnostics?.fallbackStages;
          // Evidence repair is local and deterministic. Do it before opening any remote PDF so
          // values already published on the Eaton SKU page (for example material or RoHS) do not
          // trigger a slow catalog/manual probe just to rediscover the same fact.
          if (!enriched.qualityGate?.passed) {
            const preliminaryCompleteness = evaluateFinalCompleteness(enriched, manufacturer, finalCompletenessOptions);
            const preliminaryRepair = repairFinalCompletenessFromEvidence(enriched, manufacturer, preliminaryCompleteness);
            if (preliminaryRepair.repairedFields.length) {
              enriched = finalizeQualityGate(preliminaryRepair.result, manufacturer);
              fallbackStages = enriched.diagnostics?.fallbackStages;
              await this.appendRunLog(layoutRef, "PRE_REMOTE_FIELD_REPAIR", {
                catalogNumber: item.catalogNumber,
                repairedFields: preliminaryRepair.repairedFields,
                repairs: preliminaryRepair.records
              });
            }
          }
          if (!enriched.qualityGate?.passed) {
            this.updateItemStage(item.id, "document-enrichment", "Reading datasheets/manuals for missing values");
            enriched = finalizeQualityGate(
              await enrichFromRemoteDocumentsForMissingValues(enriched, http, enriched.qualityGate?.missing ?? [], controller.signal),
              manufacturer
            );
            fallbackStages = enriched.diagnostics?.fallbackStages;
          }
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
                  layoutRef.cadDir,
                  layoutRef.imagesDir,
                  manufacturer.shortName,
                  item.catalogNumber,
                  doc,
                  localDownloads,
                  controller.signal,
                  undefined,
                  sharedDocumentDownloads
                )
            });
            this.updateItemStage(item.id, "downloads", "Downloading fallback images and documents");
            const withFallbackDownloads = await this.downloadDocuments(
              http,
              layoutRef.documentsDir,
              layoutRef.cadDir,
              layoutRef.imagesDir,
              manufacturer.shortName,
              withSmartFallbacks,
              localDownloads,
              controller.signal,
              documentDownloadProfile(manufacturer, withSmartFallbacks, { saveDocuments: downloadDocumentsEnabled }),
              item.catalogNumber,
              sharedDocumentDownloads
            );
            this.updateItemStage(item.id, "document-enrichment", "Reading fallback documents for missing values");
            enriched = finalizeQualityGate(await enrichFromDownloadedDocumentsIfPresent(withFallbackDownloads), manufacturer);
            fallbackStages = enriched.diagnostics?.fallbackStages;
          }
          this.updateItemStage(item.id, "final-audit", "Checking final missing fields");
          const beforeFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer, finalCompletenessOptions);
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
          let afterRepairFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer, finalCompletenessOptions);
          // Remote document enrichment parses PDFs and manuals; it cannot recover a missing
          // product image. Keep the image gap visible in final completeness, but never burn a
          // document-download timeout trying to resolve it.
          const remoteDocumentMissing = afterRepairFinalCompleteness.missing.filter((field) => field !== "image");
          if (remoteDocumentMissing.length) {
            const beforeRemoteMissing = remoteDocumentMissing;
            this.updateItemStage(item.id, "document-enrichment", `Reading datasheets/manuals for missing final fields: ${beforeRemoteMissing.join(", ")}`);
            enriched = finalizeQualityGate(
              await enrichFromRemoteDocumentsForMissingValues(enriched, http, beforeRemoteMissing, controller.signal),
              manufacturer
            );
            fallbackStages = enriched.diagnostics?.fallbackStages;
            afterRepairFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer, finalCompletenessOptions);
            const remoteFilledFields = beforeRemoteMissing.filter((field) => !afterRepairFinalCompleteness.missing.includes(field));
            if (remoteFilledFields.length) {
              repairedFinalFields = [...new Set([...repairedFinalFields, ...remoteFilledFields])];
              await this.appendRunLog(layoutRef, "REMOTE_DOCUMENT_FIELD_REPAIR", {
                catalogNumber: item.catalogNumber,
                repairedFields: remoteFilledFields,
                remainingMissing: afterRepairFinalCompleteness.missing
              });
            }
          }
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
                layoutRef.cadDir,
                layoutRef.imagesDir,
                manufacturer.shortName,
                item.catalogNumber,
                doc,
                localDownloads,
                controller.signal,
                undefined,
                sharedDocumentDownloads
              )
            });
            this.updateItemStage(item.id, "downloads", "Downloading final retry images and documents");
            const withFinalCompletenessDownloads = await this.downloadDocuments(
              http,
              layoutRef.documentsDir,
              layoutRef.cadDir,
              layoutRef.imagesDir,
              manufacturer.shortName,
              withFinalCompletenessFallbacks,
              localDownloads,
              controller.signal,
              documentDownloadProfile(manufacturer, withFinalCompletenessFallbacks, { saveDocuments: downloadDocumentsEnabled }),
              item.catalogNumber,
              sharedDocumentDownloads
            );
            this.updateItemStage(item.id, "document-enrichment", "Reading final retry documents for missing values");
            enriched = finalizeQualityGate(await enrichFromDownloadedDocumentsIfPresent(withFinalCompletenessDownloads), manufacturer);
            const postNetworkRepair = repairFinalCompletenessFromEvidence(
              enriched,
              manufacturer,
              evaluateFinalCompleteness(enriched, manufacturer, finalCompletenessOptions)
            );
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
          const afterFinalCompleteness = evaluateFinalCompleteness(enriched, manufacturer, finalCompletenessOptions);
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
          } // end of fallback-chain else branch
          } // end of official-source branch

          if (!enriched) {
            throw new Error("No product result was produced.");
          }

          // Apply customer override unless we already short-circuited above with the
          // same extraction. The early path skips the heavy pipeline entirely, so the
          // override has already been applied and re-running it would be a no-op.
          if (customerDocuments.length > 0 && !customerEarlyShortCircuit && !customerFirstShortCircuit) {
            this.updateItemStage(item.id, "customer-override", `Applying customer-provided document data for ${item.catalogNumber}`);
            const customerExtraction =
              customerExtractionFirst ??
              customerExtractionEarly ??
              (await extractCustomerDocumentAttributes(item.catalogNumber, customerDocuments, {
                cache: customerDocumentCache,
                onProgress: (event) => {
                  const message = formatCustomerProgress(event, item.catalogNumber);
                  if (message) this.updateItemStage(item.id, "customer-override", message);
                }
              }));
            const before = enriched;
            enriched = applyCustomerDocumentOverride(enriched, customerExtraction);
            await this.appendRunLog(layoutRef, "CUSTOMER_OVERRIDE", {
              catalogNumber: item.catalogNumber,
              attributesAdded: customerExtraction.attributes.length,
              documentsAdded: customerExtraction.documents.length,
              parseFailures: customerExtraction.parseFailures,
              statusBefore: before.status,
              statusAfter: enriched.status
            });
          }
          this.updateItemStage(item.id, "evidence", "Attaching source evidence");
          enriched = attachEvidence(enriched);
          if (this.db.isPauseRequested(run.id)) {
            await this.markItemPaused(run.id, item, layoutRef);
            return;
          }
          if (this.db.isCancellationRequested(run.id) || controller.signal.aborted) {
            this.updateItemStage(item.id, "cancelled", "Cancelled by user.", { status: "cancelled", error: "Cancelled by user." });
            await this.appendRunLog(layoutRef, "ITEM_CANCELLED", { catalogNumber: item.catalogNumber });
            return;
          }
          const dataSourceSummary = summarizeDataSource(enriched, { customerFirstShortCircuit, customerEarlyShortCircuit });
          this.updateItemStage(item.id, "complete", `${dataSourceSummary} — completed as ${enriched.status}`, {
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
            pdfAttributesAdded: Math.max(0, enriched.attributes.length - initialAttributeCount),
            downloadFailures: enriched.documents.filter((doc) => doc.downloadStatus === "failed").length,
            error: enriched.error
          });
        } catch (error) {
          if (this.db.isPauseRequested(run.id) || this.pausedRuns.has(run.id)) {
            await this.markItemPaused(run.id, item, layoutRef);
            return;
          }
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
        await runWithConcurrency(
          pending,
          concurrency,
          processItem,
          () => this.db.isPauseRequested(run.id) || this.db.isCancellationRequested(run.id) || controller.signal.aborted
        );
      } finally {
        await browserRenderer.close();
      }

      if (this.db.isPauseRequested(run.id) || this.pausedRuns.has(run.id)) {
        await this.finalizePausedRun(run.id, layout);
        return;
      }
      const status = this.db.isCancellationRequested(run.id) || controller.signal.aborted ? "cancelled" : "completed";
      if (status === "cancelled") this.db.cancelActiveRunItems(run.id);
      if (status === "cancelled" && this.wasInstantlyCancelled(run.id)) return;
      await this.finalizeRun(run.id, status);
    } catch (error) {
      if (this.db.isPauseRequested(runId) || this.pausedRuns.has(runId)) {
        await this.finalizePausedRun(runId, layout);
        return;
      }
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
      const shouldResumeAfterPause = this.resumeAfterPauseRuns.has(runId) && this.db.getRun(runId)?.status === "paused";
      this.activeRuns.delete(runId);
      this.instantlyCancelledRuns.delete(runId);
      this.pausedRuns.delete(runId);
      if (shouldResumeAfterPause) {
        this.resumeAfterPauseRuns.delete(runId);
        this.db.updateRun(runId, {
          status: "queued",
          activityStage: undefined,
          activityMessage: undefined,
          activityStartedAt: undefined,
          error: undefined
        });
        void this.processRun(runId);
      }
    }
  }

  private wasInstantlyCancelled(runId: string): boolean {
    return this.instantlyCancelledRuns.has(runId) || this.db.getRun(runId)?.status === "cancelled";
  }

  private async markItemPaused(runId: string, item: RunItemRecord, layout: RunOutputLayout) {
    this.updateItemStage(item.id, "paused", "Paused by user. This row will be retried on resume.", {
      status: "pending",
      error: undefined
    });
    await this.appendRunLog(layout, "ITEM_PAUSED", { catalogNumber: item.catalogNumber });
    this.db.recountRun(runId);
  }

  private async finalizePausedRun(runId: string, layout?: RunOutputLayout) {
    const run = this.db.getRun(runId);
    if (!run) return;
    this.db.pauseActiveRunItems(runId);
    this.db.recountRun(runId);
    this.db.updateRun(runId, {
      status: "paused",
      activityStage: undefined,
      activityMessage: undefined,
      activityStartedAt: undefined,
      error: undefined
    });
    const layoutRef =
      layout ??
      (() => {
        const manufacturer = getManufacturerConfig(run.manufacturerId);
        return manufacturer ? buildRunOutputLayout(this.paths.outputDir, manufacturer, run) : undefined;
      })();
    if (layoutRef) {
      await ensureRunOutputLayout(layoutRef);
      const updatedRun = this.db.getRun(runId);
      await this.appendRunLog(layoutRef, "RUN_PAUSED", {
        processed: updatedRun?.processed,
        total: updatedRun?.total,
        pending: Math.max(0, (updatedRun?.total ?? 0) - (updatedRun?.processed ?? 0))
      });
      await this.writeRunDebugBundle(layoutRef, runId);
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
    // "Images only" mode skips workbook generation; everything else still produces one.
    const shouldGenerateExcel = finalRun.options?.generateExcel !== false;
    const shouldGenerateLinksFile = finalRun.options?.generateLinksFile === true;
    const outputPath = shouldGenerateExcel
      ? await (async () => {
          const { exportRunWorkbook } = await import("./excel.js");
          this.updateRunActivity(runId, "workbook-build", "Preparing final Excel workbook.");
          return exportRunWorkbook({
            run: this.db.getRun(runId)!,
            manufacturer,
            items: this.db.getRunItems(runId),
            outputDir: layout.excelDir,
            onActivity: (activity) => this.updateRunActivity(runId, activity.stage, activity.message)
          });
        })()
      : undefined;
    const linksPath = shouldGenerateLinksFile
      ? await this.writeDeviceLinksFile(layout, this.db.getRunItems(runId))
      : undefined;
    this.db.updateRun(runId, {
      status,
      ...(outputPath ? { outputPath } : {}),
      activityStage: undefined,
      activityMessage: undefined,
      activityStartedAt: undefined,
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
      linksPath,
      logPath: layout.logPath,
      debugJsonPath: layout.debugJsonPath
    });
    await this.writeRunDebugBundle(layout, runId);
  }

  private async writeDeviceLinksFile(layout: RunOutputLayout, items: RunItemRecord[]): Promise<string> {
    await fs.mkdir(layout.linksDir, { recursive: true });
    const outputPath = path.join(layout.linksDir, "device-links.csv");
    const lines = [
      ["Row", "Catalog Number", "Status", "Title", "Device URL"].map(csvCell).join(","),
      ...items.map((item) =>
        [
          String(item.rowIndex),
          item.catalogNumber,
          item.status,
          item.title ?? item.result?.title ?? "",
          item.productUrl ?? item.result?.productUrl ?? ""
        ]
          .map(csvCell)
          .join(",")
      )
    ];
    await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
    return outputPath;
  }

  private async downloadDocuments(
    http: CachedHttpClient,
    documentsDir: string,
    cadDir: string,
    imagesDir: string,
    manufacturerShortName: string,
    result: ProductResult,
    selection: LocalDownloadSelection,
    signal?: AbortSignal,
    profile: DocumentDownloadProfile = "full",
    catalogNumberForFiles: string = result.catalogNumber,
    sharedDocumentDownloads?: Map<string, Promise<string>>
  ): Promise<ProductResult> {
    const documents: DocumentRecord[] = [];
    const maxDownloads = profile === "full" ? 200 : 8;
    const rankedDocuments = coalesceImageDocuments(result.documents).sort((left, right) => documentDownloadRank(left) - documentDownloadRank(right));
    let downloadCount = 0;
    let imageIndex = 0;
    let nonImageDownloadCount = 0;
    const profileTypeCounts = new Map<DocumentRecord["type"], number>();
    for (const doc of rankedDocuments) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      if (doc.type === "image" && !selection.images) {
        documents.push({
          ...doc,
          downloadStatus: "skipped",
          downloadError: "Image downloads disabled for this run."
        });
        continue;
      }
      const selectionCheck = shouldSaveForSelection(doc, selection);
      if (!selectionCheck.enabled) {
        documents.push({
          ...doc,
          downloadStatus: "skipped",
          downloadError: selectionCheck.reason
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
      if (doc.type !== "image" && documentDownloadCandidateUrls(doc).length === 0) {
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
      documents.push(
        await this.downloadDocument(
          http,
          documentsDir,
          cadDir,
          imagesDir,
          manufacturerShortName,
          catalogNumberForFiles,
          doc,
          selection,
          signal,
          indexForDoc,
          sharedDocumentDownloads
        )
      );
      if (doc.type === "image") imageIndex += 1;
      downloadCount += 1;
    }
    return { ...result, documents };
  }

  private async downloadDocument(
    http: CachedHttpClient,
    documentsDir: string,
    cadDir: string,
    imagesDir: string,
    manufacturerShortName: string,
    catalogNumber: string,
    doc: DocumentRecord,
    selection: LocalDownloadSelection,
    signal?: AbortSignal,
    imageIndex?: number,
    sharedDocumentDownloads?: Map<string, Promise<string>>
  ): Promise<DocumentRecord> {
    if (doc.localPath) return doc;
    if (doc.type === "image" && !selection.images) {
      return {
        ...doc,
        downloadStatus: "skipped",
        downloadError: "Image downloads disabled for this run."
      };
    }
    const selectionCheck = shouldSaveForSelection(doc, selection);
    if (!selectionCheck.enabled) {
      return {
        ...doc,
        downloadStatus: "skipped",
        downloadError: selectionCheck.reason
      };
    }
    if (doc.type !== "image" && documentDownloadCandidateUrls(doc).length === 0) {
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
      const candidateUrls = documentDownloadCandidateUrls(doc);
      const { urls, forcePdf } = await resolvePdfDownloadPlan(http, doc, candidateUrls, signal);
      const extension = forcePdf ? ".pdf" : documentExtension(urls[0] ?? doc.url, doc.type);
      const suggestedName = `${catalogNumber}-${doc.type}-${safeLabel(doc.label)}${extension}`;
      const targetDir = doc.type === "cad" ? cadDir : documentsDir;
      const downloaded = await downloadDocumentFromCandidates(http, sharedDocumentDownloads, urls, targetDir, suggestedName, signal);
      const localPath = downloaded.localPath;
      if (forcePdf || documentExtension(downloaded.url, doc.type).toLowerCase() === ".pdf") {
        await assertValidPdfFile(localPath);
      }
      // Keep the stable viewer link in the workbook when we resolved through it — the signed asset
      // URL we actually downloaded expires quickly and would be a dead link in the export.
      const exportUrl = forcePdf ? doc.url : downloaded.url;
      return {
        ...doc,
        url: exportUrl,
        candidateUrls: candidateUrls.filter((url) => url !== exportUrl),
        localPath,
        downloadStatus: "downloaded",
        downloadError: undefined
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("Cancelled by user.");
      return {
        ...doc,
        downloadStatus: "failed",
        downloadError: error instanceof Error ? error.message : "unknown error"
      };
    }
  }

  /**
   * Move any staged customer-provided documents from the upload area into the run's own
   * customer-documents folder. Returns the updated records pointing at the final paths.
   * Files that are already inside the target folder are left untouched — this lets a
   * resumed run pick up where it left off without duplicating the upload.
   */
  private async relocateCustomerDocuments(
    documents: CustomerDocumentRecord[],
    targetDir: string
  ): Promise<CustomerDocumentRecord[]> {
    if (!documents.length) return documents;
    await fs.mkdir(targetDir, { recursive: true });
    const updated: CustomerDocumentRecord[] = [];
    for (const doc of documents) {
      if (!doc.storedPath) continue;
      const currentDir = path.resolve(path.dirname(doc.storedPath));
      if (path.resolve(currentDir) === path.resolve(targetDir)) {
        updated.push(doc);
        continue;
      }
      const finalPath = await uniquePath(path.join(targetDir, path.basename(doc.storedPath)));
      try {
        await fs.rename(doc.storedPath, finalPath);
      } catch {
        // Cross-device rename or source missing: fall back to copy + best-effort cleanup.
        await fs.copyFile(doc.storedPath, finalPath);
        await fs.unlink(doc.storedPath).catch(() => undefined);
      }
      // Clean up the now-empty staging dir if no other files are left.
      await fs.rmdir(currentDir).catch(() => undefined);
      updated.push({ ...doc, storedPath: finalPath });
    }
    return updated;
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

function summarizeDataSource(
  result: ProductResult,
  flags: { customerFirstShortCircuit: boolean; customerEarlyShortCircuit: boolean }
): string {
  const customerAttrs = result.attributes.filter((attr) => attr.parser === "customer-document").length;
  const webAttrs = result.attributes.length - customerAttrs;
  if (flags.customerFirstShortCircuit) {
    return `Loaded from customer document only (website skipped) — ${customerAttrs} attrs`;
  }
  if (customerAttrs > 0 && webAttrs > 0) {
    return `Customer document overrode website — ${customerAttrs} customer attrs, ${webAttrs} web attrs`;
  }
  if (customerAttrs > 0) {
    return `Loaded from customer document — ${customerAttrs} attrs`;
  }
  if (flags.customerEarlyShortCircuit) {
    return `Customer document filled in (website returned nothing) — ${customerAttrs} attrs`;
  }
  return `Loaded from manufacturer website — ${webAttrs} attrs`;
}

function applyAssetOnlyStatus(result: ProductResult): ProductResult {
  const downloadedAssets = result.documents.filter((doc) => doc.downloadStatus === "downloaded" && doc.localPath);
  const availableAssets = result.documents.filter((doc) => doc.downloadStatus !== "failed" && doc.downloadStatus !== "skipped");
  const hasProductEvidence = Boolean(result.productUrl || result.title || result.attributes.length || result.sources.length);
  if (!downloadedAssets.length && !availableAssets.length && !hasProductEvidence) return result;

  const status = downloadedAssets.length ? "found" : result.status === "failed" ? "partial" : result.status;
  return {
    ...result,
    status,
    confidence: Math.max(result.confidence, downloadedAssets.length ? 0.74 : 0.55),
    error: undefined
  };
}

function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

async function downloadDocumentFromCandidates(
  http: CachedHttpClient,
  sharedDocumentDownloads: Map<string, Promise<string>> | undefined,
  urls: string[],
  targetDir: string,
  suggestedName: string,
  signal?: AbortSignal
): Promise<{ url: string; localPath: string }> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const localPath = await sharedDocumentDownload(sharedDocumentDownloads, url, targetDir, suggestedName, () =>
        http.downloadFile(url, targetDir, suggestedName, signal)
      );
      return { url, localPath };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw new Error("Cancelled by user.");
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Document download failed for every candidate URL");
}

export function documentDownloadCandidateUrls(doc: DocumentRecord): string[] {
  return uniqueStrings([doc.url, ...(doc.candidateUrls ?? [])]).filter((url) => shouldDownloadLocalDocument({ ...doc, url }));
}

/**
 * Some datasheet/certificate/manual links point at an HTML PDF-viewer wrapper (e.g. ABB's
 * `search.abb.com/library/Download.aspx?...&Action=Launch`) rather than the PDF itself. Fetch the
 * wrapper and resolve the embedded, signed PDF asset URL so the real PDF is what gets downloaded
 * and enriched. Returns the download URL list (asset first when resolved) plus `forcePdf`, which
 * tells the caller to name the file `.pdf` and validate the `%PDF-` header even though the
 * viewer link's own path ended in `.aspx`. Best-effort — an unresolved viewer falls back to the
 * original candidate URLs, preserving prior behaviour.
 */
async function resolvePdfDownloadPlan(
  http: CachedHttpClient,
  doc: DocumentRecord,
  urls: string[],
  signal?: AbortSignal
): Promise<{ urls: string[]; forcePdf: boolean }> {
  if (doc.type === "image" || doc.type === "cad") return { urls, forcePdf: false };
  const primary = urls[0] ?? doc.url;
  if (!primary || !isDocumentViewerUrl(primary)) return { urls, forcePdf: false };
  const asset = await resolveViewerPdfUrl(http, primary, signal);
  if (!asset) return { urls, forcePdf: false };
  return { urls: uniqueStrings([asset, ...urls]), forcePdf: true };
}

function safeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "document";
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function documentExtension(url: string, type: DocumentRecord["type"]): string {
  const fromPath = urlPathExtension(url);
  if (fromPath) return fromPath;
  if (isDownloadablePdfDocument({ url })) return ".pdf";
  if (/pdfengine\/pdf/i.test(url) || type === "datasheet" || type === "certificate" || type === "manual") return ".pdf";
  if (type === "cad") return ".bin";
  return ".bin";
}

function urlPathExtension(url: string): string {
  try {
    return path.extname(new URL(url, "https://scraper.local").pathname);
  } catch {
    return path.extname(url.split(/[?#]/, 1)[0] ?? "");
  }
}

export function documentDownloadProfile(
  manufacturer: { id: string; scrapeRecipe?: ManufacturerConfig["scrapeRecipe"] },
  result: ProductResult,
  options: { saveDocuments?: boolean } = {}
): DocumentDownloadProfile {
  if (options.saveDocuments === false) return "quality";
  if (options.saveDocuments === true) return "full";
  return manufacturer.scrapeRecipe?.fallbackPolicy?.documentDownloadProfile ?? "full";
}

export function shouldDownloadDocumentsForRun(
  manufacturer: { id: string },
  options: { downloadDocuments: boolean; generateExcel: boolean }
): boolean {
  if (options.downloadDocuments) return true;
  // Some manufacturers publish required electrical/dimensional data only inside the
  // technical-data PDF. When an Excel workbook is being generated, keep a tiny quality-profile
  // document path alive for enrichment even when the broad "save documents" option is off.
  if (!options.generateExcel) return false;
  return true;
}

export function shouldShortCircuitCustomerFirst(
  result: ProductResult,
  extraction: { attributes: AttributeRecordLike[]; documents: DocumentRecord[] }
): boolean {
  if (extraction.attributes.length < 5 || extraction.documents.length === 0) return false;
  if (result.qualityGate?.identityConfirmed === false) return false;
  if (result.status === "failed") return false;
  const normalized = result.normalized;
  // "material" rarely applies to electronic devices (drives, relays, PSUs) and "dimensions"
  // is frequently missing from a manufacturer's own feedback spreadsheet even when everything
  // else is well-documented — requiring ALL of weight+dimensions+material meant this never
  // fired for whole product categories no matter how complete the customer data was. One
  // physical descriptor alongside weight is still a meaningful signal of real coverage.
  const hasPhysicalCore = Boolean(normalized.weight && (normalized.dimensions || normalized.material));
  const hasDutySpec = Boolean(normalized.voltage || normalized.current) || extraction.attributes.some((attr) => /^(?:pressure|flow rate|flow|power)$/i.test(attr.name));
  // Was an exact-name match (^...$), so a real-world column header like "Product Description
  // (English)" or "Product Category (English)" — the norm for manufacturer feedback sheets,
  // which append a language/unit qualifier — never matched a bare "description"/"product
  // type". Matching on substring instead keeps the same intent (some clearly descriptive
  // field is present) without requiring the column to be named with surgical precision.
  const hasDescriptiveIdentity = extraction.attributes.some((attr) =>
    /\b(?:product\s*type|description|product\s*short\s*text|product\s*name|product\s*category)\b/i.test(attr.name)
  );
  // Customer feedback sheets almost never carry the manufacturer's own product URL or a
  // certifications list — both are still "Required Data Coverage" fields the exporter checks, and
  // skipping the official site entirely means the row permanently shows "no link found" even
  // though the manufacturer's page exists and would have supplied one (confirmed live for several
  // Rockwell 1606-XL catalogs that were short-circuited this way — see
  // [[rockwell-customer-first-short-circuit-fix]]). Only allow the short-circuit when the customer
  // extraction has ALREADY supplied one of these two itself; otherwise fall through to the normal
  // website scrape so it gets a real chance to fill them in.
  const hasLinkOrCertificates =
    Boolean(result.productUrl) || extraction.attributes.some((attr) => /\bcertificat/i.test(attr.name));
  return hasPhysicalCore && hasDutySpec && hasDescriptiveIdentity && hasLinkOrCertificates;
}

type AttributeRecordLike = Pick<ProductResult["attributes"][number], "name">;

function shouldDownloadForProfile(
  doc: DocumentRecord,
  profile: DocumentDownloadProfile,
  typeCounts: Map<DocumentRecord["type"], number>,
  nonImageDownloadCount: number
): boolean {
  if (doc.type === "image") return true;
  if (profile === "full") return true;
  if (profile === "images-only") return false;
  if (nonImageDownloadCount >= 4) return false;
  const countForType = typeCounts.get(doc.type) ?? 0;
  // Documents arrive pre-sorted by documentDownloadRank (best first — real PDFs beat HTML
  // stubs of the same type), so the first 1-2 kept per type are the highest-value ones.
  // Allow two datasheets/manuals: a "technical data" sheet and a dimensional/installation
  // sheet (or a real PDF alongside an HTML stub) often carry complementary specs.
  if (doc.type === "datasheet") return countForType < 2;
  if (doc.type === "certificate") return countForType < 1;
  if (doc.type === "manual") return countForType < 2;
  if (doc.type === "other" && countForType < 1) {
    return documentHasPdfLikeCandidate(doc);
  }
  return false;
}

function shouldDownloadLocalDocument(doc: DocumentRecord): boolean {
  if (doc.type === "image") return true;
  // A small number of official document handlers intentionally do not expose a `.pdf` suffix.
  // Trust only the shared URL classifier (which contains explicit known endpoints and PDF query
  // semantics), not merely the filename extension, so their response can be checked and parsed.
  if (isDownloadablePdfDocument(doc) || isRelevantPdfDownloadCandidate(doc)) return true;
  const extension = documentExtension(doc.url, doc.type).toLowerCase();
  if (doc.type === "cad") {
    return [".bin", ".zip", ".dwg", ".dxf", ".stp", ".step", ".igs", ".iges", ".sat", ".x_t", ".x_b", ".3dxml", ".prt", ".sldprt"].includes(extension);
  }
  return false;
}

function shouldSaveForSelection(doc: DocumentRecord, selection: LocalDownloadSelection): { enabled: boolean; reason?: string } {
  if (doc.type === "image") {
    return selection.images
      ? { enabled: true }
      : { enabled: false, reason: "Image downloads disabled for this run." };
  }
  if (doc.type === "cad") {
    return selection.cad
      ? { enabled: true }
      : { enabled: false, reason: "CAD downloads disabled for this run." };
  }
  if (!selection.pdfs) {
    return { enabled: false, reason: "PDF downloads disabled for this run." };
  }
  if (!documentHasPdfLikeCandidate(doc)) {
    return { enabled: false, reason: "Skipped non-PDF document; URL retained in workbook." };
  }
  return { enabled: true };
}

export function isDownloadablePdfDocument(doc: Pick<DocumentRecord, "url">): boolean {
  return isPdfLikeDocument(doc);
}

function documentHasPdfLikeCandidate(doc: DocumentRecord): boolean {
  return [doc.url, ...(doc.candidateUrls ?? [])].some((url) => isPdfLikeDocument({ url }) || isRelevantPdfDownloadCandidate({ ...doc, url }));
}

function isRelevantPdfDownloadCandidate(doc: DocumentRecord): boolean {
  if (!["datasheet", "manual", "certificate", "other"].includes(doc.type)) return false;
  if (!looksLikeDocumentEndpoint(doc.url)) return false;
  const context = [doc.label, doc.sourceUrl, doc.stage, doc.parser].filter(Boolean).join(" ");
  if (!documentUrlLooksRelevant(doc.url, context, doc.type)) return false;
  if (doc.type !== "other") return true;
  return /\b(?:pdf|data\s*sheet|datasheet|manual|instruction|installation|certificate|declaration|conformity|technical\s+(?:data|sheet|information)|spec(?:ification)?\s*sheet)\b/i.test(context);
}

function looksLikeDocumentEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
    if (segments.some((segment) => /^(?:download|downloads|file|files|document|documents|doc|docs|resource|resources|media|dam|asset|assets)$/.test(segment))) {
      return true;
    }
    return [...parsed.searchParams.keys()].some((key) => /^(?:doc|document|documentid|docid|docref|file|filename|asset|assetid|media|mediaid|download|p_doc_ref|p_endoctype)$/i.test(key));
  } catch {
    return false;
  }
}

async function sharedDocumentDownload(
  downloads: Map<string, Promise<string>> | undefined,
  url: string,
  targetDir: string,
  suggestedName: string,
  download: () => Promise<string>
): Promise<string> {
  if (!downloads) return download();
  const key = canonicalDownloadUrl(url);
  const existing = downloads.get(key);
  if (existing) {
    return copySharedDownload(await existing, targetDir, suggestedName);
  }
  const pending = download().catch((error) => {
    downloads.delete(key);
    throw error;
  });
  downloads.set(key, pending);
  return pending;
}

async function copySharedDownload(sourcePath: string, targetDir: string, suggestedName: string): Promise<string> {
  await fs.mkdir(targetDir, { recursive: true });
  const finalName = sanitize(suggestedName) || "document.pdf";
  const sourceResolved = path.resolve(sourcePath);
  let outputPath = path.join(targetDir, finalName);
  let index = 2;
  while (await exists(outputPath)) {
    const parsed = path.parse(finalName);
    outputPath = path.join(targetDir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  if (path.resolve(outputPath) === sourceResolved) return sourcePath;
  await fs.copyFile(sourcePath, outputPath);
  return outputPath;
}

async function assertValidPdfFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString("latin1");
    if (!header.includes("%PDF-")) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      throw new Error("Downloaded file is not a valid PDF; server returned a non-PDF response.");
    }
  } finally {
    await handle.close();
  }
}

function canonicalDownloadUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/^#(?:de-DE|en-US)$/i.test(parsed.hash)) {
      parsed.hash = "";
    }
    return canonicalDocumentUrlKey(parsed.toString());
  } catch {
    return canonicalDocumentUrlKey(url);
  }
}

async function enrichFromDownloadedDocumentsIfPresent(result: ProductResult): Promise<ProductResult> {
  if (!result.documents.some((doc) => shouldParseDownloadedDocument(doc))) return result;
  const { enrichResultFromDownloadedDocuments } = await import("./scrapers/document-enrichment.js");
  return enrichResultFromDownloadedDocuments(result);
}

async function enrichFromRemoteDocumentsForMissingValues(
  result: ProductResult,
  http: CachedHttpClient,
  missingFields: string[],
  signal?: AbortSignal
): Promise<ProductResult> {
  if (!missingFields.length) return result;
  if (!result.documents.some((doc) => shouldProbeRemoteDocument(doc))) {
    return withRemoteDocumentProbeSkippedDiagnostics(result, missingFields);
  }
  const { enrichResultFromRemoteDocuments } = await import("./scrapers/document-enrichment.js");
  return enrichResultFromRemoteDocuments(
    result,
    async (doc) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-doc-probe-"));
      const candidateUrls = documentDownloadCandidateUrls(doc);
      const { urls, forcePdf } = await resolvePdfDownloadPlan(http, doc, candidateUrls, signal);
      const extension = forcePdf ? ".pdf" : documentExtension(urls[0] ?? doc.url, doc.type);
      const suggestedName = `${result.catalogNumber}-${doc.type}-${safeLabel(doc.label)}${extension}`;
      try {
        const downloaded = await downloadDocumentFromCandidates(http, undefined, urls.length ? urls : [doc.url], tempDir, suggestedName, signal);
        return {
          localPath: downloaded.localPath,
          // Keep the stable viewer link as the parsed document's source URL, not the signed asset.
          url: forcePdf ? doc.url : downloaded.url,
          cleanup: () => fs.rm(tempDir, { recursive: true, force: true })
        };
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },
    // Eaton product pages publish their own per-SKU specification sheet. Probing a family
    // catalog after it is both slower and less precise; retain the page-derived values when the
    // direct sheet cannot satisfy the quality gate instead of holding a worker on four PDFs.
    { maxDocuments: result.manufacturerId === "eaton" ? 1 : 4 }
  );
}

export function withRemoteDocumentProbeSkippedDiagnostics(result: ProductResult, missingFields: string[]): ProductResult {
  const documents = result.documents.slice(0, 30);
  const skipped: DocumentProcessingDiagnostic[] = documents.map((doc) => ({
    url: doc.url,
    label: doc.label,
    type: doc.type,
    action: "skipped",
    stage: "remote-document-enrichment",
    reason: remoteDocumentProbeSkipReason(doc),
    localPath: doc.localPath,
    sourceUrl: doc.sourceUrl,
    parseError: doc.parseError
  }));
  const missing = missingFields.slice(0, 8).join(", ");
  const note = documents.length
    ? `Remote document enrichment skipped while missing ${missing}: no probeable PDF datasheet/manual candidates.`
    : `Remote document enrichment skipped while missing ${missing}: product has no document candidates.`;

  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      ...(skipped.length
        ? {
            documentProcessing: [
              ...(result.diagnostics?.documentProcessing ?? []),
              ...skipped
            ].slice(-80)
          }
        : {}),
      notes: uniqueStrings([...(result.diagnostics?.notes ?? []), note]).slice(0, 50)
    }
  };
}

function remoteDocumentProbeSkipReason(doc: DocumentRecord): string {
  if (doc.localPath) return "Skipped remote probe because the document is already downloaded locally.";
  if (doc.parseStatus === "parsed") return "Skipped remote probe because the document was already parsed.";
  if (doc.downloadStatus === "failed") return `Skipped remote probe because document download previously failed: ${doc.downloadError ?? "unknown error"}.`;
  if (!["datasheet", "manual", "other"].includes(doc.type)) return `Skipped remote probe because document type '${doc.type}' is not a datasheet/manual/technical PDF candidate.`;
  const text = `${doc.type} ${doc.label} ${doc.url} ${(doc.candidateUrls ?? []).join(" ")}`;
  if (doc.type === "other" && !/\b(?:data\s*sheet|datasheet|technical|spec(?:ification)?|manual|installation|instruction)\b/i.test(text)) {
    return "Skipped remote probe because the generic document does not look like a datasheet, manual, or technical PDF.";
  }
  if (!documentHasPdfLikeCandidate(doc)) return "Skipped remote probe because no PDF-like URL or candidate URL was available.";
  return "Skipped remote probe because the document was not eligible for remote enrichment.";
}

function shouldParseDownloadedDocument(doc: DocumentRecord): boolean {
  if (doc.downloadStatus && doc.downloadStatus !== "downloaded") return false;
  if (!doc.localPath) return false;
  if (!/\.pdf$/i.test(doc.localPath) && !isDownloadablePdfDocument(doc)) return false;
  return ["datasheet", "certificate", "manual", "other"].includes(doc.type);
}

function shouldProbeRemoteDocument(doc: DocumentRecord): boolean {
  if (doc.localPath || doc.parseStatus === "parsed" || doc.downloadStatus === "failed") return false;
  if (!["datasheet", "manual", "other"].includes(doc.type)) return false;
  const text = `${doc.type} ${doc.label} ${doc.url} ${(doc.candidateUrls ?? []).join(" ")}`;
  if (doc.type === "other" && !/\b(?:data\s*sheet|datasheet|technical|spec(?:ification)?|manual|installation|instruction)\b/i.test(text)) {
    return false;
  }
  return documentHasPdfLikeCandidate(doc);
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

export function imageFileName(manufacturerShortName: string, catalogNumber: string, index?: number): string {
  const suffix = index && index > 0 ? `_${index + 1}` : "";
  const manufacturer = safeImagePart(manufacturerShortName);
  const catalog = safeImagePart(catalogNumber);
  return `${manufacturer}.${catalog}_preview${suffix}.png`;
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

/**
 * Turns a CustomerDocumentProgressEvent into the short stage message that lands on the
 * run dashboard. We keep the line tight so it fits next to the other stages, while still
 * naming the file the scraper is currently scanning — the user wants to see exactly what
 * is being looked at.
 */
function formatCustomerProgress(event: CustomerDocumentProgressEvent, catalogNumber: string): string | undefined {
  const name = event.document.originalName || "customer document";
  switch (event.kind) {
    case "start":
      return `Scanning ${name} (${event.documentIndex + 1}/${event.documentTotal}) for ${catalogNumber}`;
    case "scan-pdf-page": {
      const total = event.totalPages ?? "?";
      return `Reading ${name} — page ${event.pageNumber}/${total}, ${event.matchesSoFar} match${event.matchesSoFar === 1 ? "" : "es"} for ${catalogNumber}`;
    }
    case "ocr-pdf":
      return `${name}: ${event.message}`;
    case "matched":
      return `Matched ${name}: pulled ${event.attributeCount} attribute${event.attributeCount === 1 ? "" : "s"} for ${catalogNumber}`;
    case "no-match":
      return `${name}: no rows mention ${catalogNumber}`;
    case "parse-error":
      return `${name}: ${event.message}`;
    default:
      return undefined;
  }
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
  // Real PDFs beat HTML stand-ins that share the same type tag (e.g. Rockwell's
  // configurator /cutsheet endpoint is HTML but gets tagged as "datasheet" so the
  // workbook can link to it). When the quality profile only downloads one datasheet
  // per item, we want the actual literature.* PDF to win over the HTML page.
  if (doc.type !== "image" && /\.pdf(?:[?#]|$)/i.test(doc.url)) rank -= 8;
  return rank;
}

// Only one photo of the device itself is wanted per item — not a gallery. Newer manufacturer
// connectors mostly lean on the generic fallback for images (see isLikelySchematicImage) instead
// of hand-picking a single product shot, so schematics/wiring/dimension drawings can otherwise
// slip through as one of several "gallery" images. Excluding them here applies uniformly to
// every connector, old and new, at the single choke point all image documents pass through.
const MAX_GALLERY_IMAGES = 1;

function isSchematicImageDocument(doc: DocumentRecord): boolean {
  return isLikelySchematicImage(`${doc.label} ${doc.url}`.toLowerCase());
}

export function coalesceImageDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const images = documents.filter((doc) => doc.type === "image");
  if (images.length <= 1 && !images.some((doc) => doc.candidateUrls?.length)) return documents;

  // Group by image identity (same product image at different sizes/qualities collapses into one;
  // distinct gallery images keep their own groups).
  const groups = new Map<string, DocumentRecord[]>();
  for (const image of images.flatMap(expandImageCandidates)) {
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
      ...ranked.slice(1).flatMap((doc) => [doc.url, ...(doc.candidateUrls ?? [])])
    ]).filter((url) => url !== primary.url);
    coalescedGroups.push({
      ...primary,
      candidateUrls: candidateUrls.length ? candidateUrls : primary.candidateUrls
    });
  }

  // Rank distinct gallery images and cap how many we'll keep / download. Prefer real product
  // photos over schematics/drawings; only fall back to a schematic if it's the only image found.
  const rankedGroups = coalescedGroups.sort((left, right) => imageDocumentRank(left) - imageDocumentRank(right));
  const nonSchematic = rankedGroups.filter((doc) => !isSchematicImageDocument(doc));
  const kept = (nonSchematic.length ? nonSchematic : rankedGroups).slice(0, MAX_GALLERY_IMAGES);

  return [...kept, ...documents.filter((doc) => doc.type !== "image")];
}

function expandImageCandidates(image: DocumentRecord): DocumentRecord[] {
  const urls = uniqueStrings([image.url, ...(image.candidateUrls ?? [])]);
  if (urls.length <= 1) return [image];
  return urls.map((url) => ({
    ...image,
    url,
    candidateUrls: urls.filter((candidate) => candidate !== url)
  }));
}

function imageIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").pop() ?? parsed.pathname;
    let stem = filename.replace(/\.(?:png|jpe?g|webp|gif|avif|svg)$/i, "");
    let previous = "";
    while (stem !== previous) {
      previous = stem;
      stem = stem.replace(/[-_](?:\d{2,5}x\d{2,5}|master|thumb(?:nail)?|small|medium|large|hd|original|main|crop(?:ped)?)$/i, "");
    }
    return stem.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function imageDocumentRank(doc: DocumentRecord): number {
  const text = `${doc.label} ${doc.url}`.toLowerCase();
  let rank = documentDownloadRank(doc);
  if (doc.localPath || doc.downloadStatus === "downloaded") rank -= 50;
  const dimensions = imageDimensionsFromUrl(doc.url);
  if (dimensions) {
    const area = dimensions.width * dimensions.height;
    if (area >= 900_000) rank -= 35;
    else if (area >= 160_000) rank -= 25;
    else if (area <= 40_000) rank += 35;
    const ratio = Math.max(dimensions.width / dimensions.height, dimensions.height / dimensions.width);
    if (ratio > 3) rank += 20;
  }
  if (!dimensions && /_400x400\b|[?&](?:width|w)=400\b|400\s*x\s*400/.test(text)) rank -= 25;
  if (/_master\b|master\./.test(text)) rank -= 15;
  if (/thumbnail|thumb|_100x100\b|[?&](?:width|w)=100\b|100\s*x\s*100/.test(text)) rank += 30;
  if (/\b(?:schematic|wiring|diagram|drawing|dimension|dimensional|cad|2d|3d|technical|sketch)\b/.test(text)) rank += 70;
  return rank;
}

function imageDimensionsFromUrl(url: string): { width: number; height: number } | undefined {
  const match = url.match(/(?:^|[_/?&=-])(\d{2,5})\s*x\s*(\d{2,5})(?=$|[_.?&#/-])/i);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { width, height };
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
