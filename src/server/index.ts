import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewCsv, extractCatalogNumbers } from "./csv.js";
import { ScraperDb } from "./db.js";
import { createAppPaths } from "./paths.js";
import { buildFieldCoverageMatrix, RunManager } from "./run-manager.js";
import { getManufacturerConfig, initializeManufacturerConfig, listManufacturerConfigs, resetManufacturerOverride, saveManufacturerConfig } from "./config/manufacturers.js";
import type {
  CustomerDocumentRecord,
  FieldCoverageMatrixResponse,
  LearnedExtractorApprovalRequest,
  ManufacturerId,
  ManufacturerOperationalSummary,
  ManufacturerTestResult,
  PdtGroupDefinition,
  PdtGroupExportRecord
} from "../shared/types.js";
import { buildRunOutputLayout, findRunLogPath, getAllowedRunOutputRoots, isPathInsideAny, runRootFromOutputPath } from "./run-output.js";
import { CachedHttpClient } from "./scrapers/http-client.js";
import { TRACKED_COVERAGE_FIELDS } from "./scrapers/field-coverage-drift.js";
import { summarizeRunItem } from "./run-item-summary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const appPaths = createAppPaths(rootDir);
initializeManufacturerConfig(appPaths.dataDir);
const db = new ScraperDb(appPaths);
const runManager = new RunManager(db, appPaths);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Customer-provided documents (PDF/XLSX/DOC/7z etc.) can run a lot bigger than the catalog
// CSV — Eaton's full e6 catalogue is ~3 MB and an Excel BOM workbook can easily exceed
// 50 MB. Use a dedicated upload pipeline with a roomier per-file cap.
const customerDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 20 }
});
const runUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 32 }
});
const app = express();
const port = Number(process.env.PORT ?? 3001);
const WIZARD_VALIDATION_TTL_MS = 30 * 60 * 1000;
const wizardRecipeValidations = new Map<string, { result: ManufacturerTestResult; expiresAt: number }>();

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/manufacturers", (_req, res) => {
  res.json(listManufacturerConfigs());
});

app.get("/api/field-coverage-matrix", (_req, res) => {
  const response: FieldCoverageMatrixResponse = { fields: TRACKED_COVERAGE_FIELDS, rows: buildFieldCoverageMatrix(db) };
  res.json(response);
});

app.get("/api/manufacturers/:id/operational-summary", (req, res) => {
  const manufacturer = getManufacturerConfig(req.params.id);
  if (!manufacturer) {
    res.status(404).json({ error: "Unknown manufacturer." });
    return;
  }
  const summary: ManufacturerOperationalSummary = {
    manufacturerId: manufacturer.id,
    targetHealth: db.listTargetHealth(manufacturer.id),
    learnedEndpoints: db.listLearnedEndpoints(manufacturer.id, 20)
  };
  res.json(summary);
});

app.post("/api/manufacturers", async (req, res) => {
  try {
    const manufacturer = await saveManufacturerConfig(req.body);
    res.json({ manufacturer, manufacturers: listManufacturerConfigs() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not save manufacturer." });
  }
});

app.post("/api/manufacturers/inspect", async (req, res) => {
  try {
    const { inspectManufacturerDraft } = await import("./manufacturer-wizard.js");
    const http = new CachedHttpClient(db, appPaths.cacheDir);
    res.json(await inspectManufacturerDraft(req.body, http));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not inspect manufacturer." });
  }
});

app.post("/api/manufacturers/test", async (req, res) => {
  try {
    const { testManufacturerDraft, wizardValidationKey } = await import("./manufacturer-wizard.js");
    const http = new CachedHttpClient(db, appPaths.cacheDir);
    const result = await testManufacturerDraft(req.body, { db, http, paths: appPaths });
    wizardRecipeValidations.set(wizardValidationKey(req.body.manufacturer), { result, expiresAt: Date.now() + WIZARD_VALIDATION_TTL_MS });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not test manufacturer." });
  }
});

app.post("/api/manufacturers/:id/learned-extractors", async (req, res) => {
  try {
    const manufacturer = getManufacturerConfig(req.params.id);
    if (!manufacturer) throw new Error("Manufacturer must be saved before approving a learned recipe.");
    const payload = req.body as LearnedExtractorApprovalRequest;
    if (payload.manufacturerId !== manufacturer.id) throw new Error("The learned recipe belongs to a different manufacturer.");
    const { approveWizardLearnedExtractor, wizardValidationKey } = await import("./manufacturer-wizard.js");
    const validation = wizardRecipeValidations.get(wizardValidationKey(manufacturer));
    if (!validation || validation.expiresAt < Date.now()) {
      wizardRecipeValidations.delete(wizardValidationKey(manufacturer));
      throw new Error("Run a confirmed three-sample wizard test before approving a learned recipe.");
    }
    res.status(201).json({ extractor: approveWizardLearnedExtractor(payload.proposal, manufacturer, db, validation.result) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not approve learned recipe." });
  }
});

app.post("/api/manufacturers/:id/reset-override", async (req, res) => {
  try {
    const manufacturer = await resetManufacturerOverride(req.params.id);
    res.json({ manufacturer, manufacturers: listManufacturerConfigs() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not reset manufacturer override." });
  }
});

app.post("/api/csv/preview", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "CSV file is required." });
    return;
  }
  try {
    res.json(await previewCsv(req.file.buffer));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not parse CSV/XLSX." });
  }
});

/**
 * Preview an accessory matrix before a run exists: lists the main parts it declares, which can be
 * scraped directly instead of uploading a separate catalog CSV.
 */
app.post("/api/accessory-matrix/preview", customerDocUpload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Accessory matrix file is required." });
    return;
  }
  if (!isAccessoryMatrixFileName(file.originalname)) {
    res.status(400).json({ error: "The accessory matrix must be an .xlsx or .xlsm workbook." });
    return;
  }
  try {
    const { parseAccessoryMatrixBuffer, accessoryMatrixCatalogNumbers } = await import("./pdt/accessory-matrix.js");
    const plan = await parseAccessoryMatrixBuffer(file.buffer);
    res.json({
      fileName: file.originalname,
      mainParts: accessoryMatrixCatalogNumbers(plan),
      points: plan.points.map((point) => point.name),
      accessoryRows: plan.accessoryRows.filter((row) => row.kind === "accessory").length,
      conditionCount: plan.conditions.length,
      warnings: plan.warnings
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not read the accessory matrix." });
  }
});

app.post(
  "/api/runs",
  runUpload.fields([
    { name: "file", maxCount: 1 },
    { name: "customerDocuments", maxCount: 20 },
    { name: "accessoryMatrix", maxCount: 1 }
  ]),
  async (req, res) => {
  const filesMap = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const inputFile = filesMap.file?.[0];
  const customerFiles = filesMap.customerDocuments ?? [];
  const accessoryMatrixFile = filesMap.accessoryMatrix?.[0];
  if (!inputFile && !accessoryMatrixFile) {
    res.status(400).json({ error: "A catalog CSV/XLSX or an accessory matrix is required." });
    return;
  }
  const manufacturerId = String(req.body.manufacturerId ?? "") as ManufacturerId;
  const columnName = String(req.body.columnName ?? "");
  const legacyDownloadDocuments = req.body.downloadDocuments === undefined ? undefined : String(req.body.downloadDocuments) === "true";
  const downloadPdfs = req.body.downloadPdfs === undefined ? legacyDownloadDocuments ?? true : String(req.body.downloadPdfs) === "true";
  const downloadCad = req.body.downloadCad === undefined ? legacyDownloadDocuments ?? true : String(req.body.downloadCad) === "true";
  const downloadDocuments = downloadPdfs || downloadCad;
  const downloadImages = String(req.body.downloadImages ?? "true") === "true";
  const generateExcel = String(req.body.generateExcel ?? "true") === "true";
  const generateLinksFile = String(req.body.generateLinksFile ?? "false") === "true";
  const forceFinalRetry = String(req.body.forceFinalRetry ?? "false") === "true";
  const onlySelectedInfo = String(req.body.onlySelectedInfo ?? "false") === "true";
  // Per-run override of the manufacturer's custom coverage tiles. The client sends a JSON
  // string when the user touched the editor; `undefined` (missing field) means "fall back
  // to whatever the manufacturer has configured".
  const customCoverageFieldsRaw = req.body.customCoverageFields;
  const customCoverageFields = parseCustomCoverageFieldsFromRequest(customCoverageFieldsRaw);
  // `hiddenCoverageFields` arrives as a JSON-encoded string from FormData (or may be missing).
  // Treat anything malformed as "no list provided".
  let hiddenCoverageFields: string[] | undefined;
  if (typeof req.body.hiddenCoverageFields === "string" && req.body.hiddenCoverageFields.length > 0) {
    try {
      const parsedHidden = JSON.parse(req.body.hiddenCoverageFields) as unknown;
      if (Array.isArray(parsedHidden)) {
        hiddenCoverageFields = parsedHidden
          .map((entry) => String(entry ?? "").trim())
          .filter((entry) => entry.length > 0)
          .slice(0, 64);
      }
    } catch {
      // Ignore malformed JSON.
    }
  }
  const manufacturer = getManufacturerConfig(manufacturerId);
  if (!manufacturer) {
    res.status(400).json({ error: "Unknown manufacturer." });
    return;
  }
  if (onlySelectedInfo) {
    const hidden = new Set(hiddenCoverageFields ?? []);
    const selectedBuiltIns = ["weight", "certificates", "dimensions", "material", "voltage", "current"]
      .filter((field) => !hidden.has(field));
    const selectedCustom = (customCoverageFields ?? manufacturer.customCoverageFields ?? []).filter(
      (field) => field.id && field.label.trim() && field.pattern.trim()
    );
    if (selectedBuiltIns.length === 0 && selectedCustom.length === 0) {
      res.status(400).json({ error: "Only selected info needs at least one enabled value field in Required fields." });
      return;
    }
  }
  if (inputFile && !columnName) {
    res.status(400).json({ error: "CSV column is required." });
    return;
  }
  if (accessoryMatrixFile && !isAccessoryMatrixFileName(accessoryMatrixFile.originalname)) {
    res.status(400).json({ error: "The accessory matrix must be an .xlsx or .xlsm workbook." });
    return;
  }
  try {
    // Without a catalog CSV the accessory matrix is the input: its main parts are the catalog
    // numbers to scrape. The accessory part numbers themselves are not scraped — the PDT's
    // accessory rows come from the matrix verbatim.
    const catalogNumbers = inputFile
      ? await extractCatalogNumbers(inputFile.buffer, columnName)
      : await accessoryMatrixCatalogNumbersFromUpload(accessoryMatrixFile!.buffer);
    if (catalogNumbers.length === 0) {
      res.status(400).json({
        error: inputFile
          ? "No catalog numbers found in selected column."
          : "The accessory matrix declares no main part numbers in column A."
      });
      return;
    }
    const customerDocuments = await persistCustomerDocuments(customerFiles);
    const [accessoryMatrix] = accessoryMatrixFile ? await persistCustomerDocuments([accessoryMatrixFile]) : [];
    const run = runManager.createRun({
      manufacturerId,
      inputFileName: (inputFile ?? accessoryMatrixFile)!.originalname,
      catalogNumbers,
      options: {
        downloadDocuments,
        downloadPdfs,
        downloadCad,
        downloadImages,
        generateExcel,
        generateLinksFile,
        forceFinalRetry,
        onlySelectedInfo,
        ...(customCoverageFields !== undefined ? { customCoverageFields } : {}),
        ...(hiddenCoverageFields !== undefined ? { hiddenCoverageFields } : {}),
        ...(customerDocuments.length > 0 ? { customerDocuments } : {}),
        ...(accessoryMatrix ? { accessoryMatrix } : {})
      }
    });
    res.status(201).json(run);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not start run." });
  }
});

app.get("/api/runs", (_req, res) => {
  res.json(db.listRuns());
});

/**
 * Live-update the coverage tiles for an in-progress or finished run. Only the
 * `customCoverageFields` part of options is editable through this endpoint — everything
 * else (downloadDocuments, generateExcel, …) is fixed at run start because changing it
 * mid-flight would require re-scraping.
 */
app.patch("/api/runs/:id/coverage-fields", express.json(), (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const parsed = parseCustomCoverageFieldsFromRequest(req.body?.customCoverageFields);
  // Allow optional `hiddenCoverageFields` patching alongside the custom tiles. Sending
  // `null` or omitting the key leaves the existing value alone, while an array overwrites.
  const patch: { customCoverageFields: import("../shared/types.js").CustomCoverageField[]; hiddenCoverageFields?: string[] } = {
    customCoverageFields: parsed ?? []
  };
  if (Array.isArray(req.body?.hiddenCoverageFields)) {
    patch.hiddenCoverageFields = (req.body.hiddenCoverageFields as unknown[])
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 64);
  }
  db.updateRunOptions(run.id, patch);
  res.json(db.getRun(req.params.id));
});

app.get("/api/runs/:id", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const items = db.getRunItems(run.id);
  if (req.query.summary === "1") {
    // Run-level override wins over manufacturer defaults. `undefined` (not set) falls back
    // to the manufacturer's configured tiles; an explicit `[]` means "this run wants no
    // custom tiles", and that intent is preserved.
    const manufacturer = getManufacturerConfig(run.manufacturerId);
    const customCoverageFields =
      run.options?.customCoverageFields ?? manufacturer?.customCoverageFields ?? [];
    res.json({
      run,
      items: items.map((item) => summarizeRunItem(item, {
        customCoverageFields,
        includeImages: run.options?.downloadImages !== false
      }))
    });
    return;
  }
  res.json({ run, items });
});

app.get("/api/runs/:id/items/:itemId", (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(itemId)) {
    res.status(400).json({ error: "Invalid run item id." });
    return;
  }
  const item = db.getRunItem(req.params.id, itemId);
  if (!item) {
    res.status(404).json({ error: "Run item not found." });
    return;
  }
  res.json(item);
});

app.post("/api/runs/:id/cancel", async (req, res) => {
  try {
    const run = await runManager.cancelRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    res.json(run);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not cancel run." });
  }
});

app.post("/api/runs/:id/pause", async (req, res) => {
  try {
    const run = await runManager.pauseRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    res.json(run);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not pause run." });
  }
});

app.post("/api/runs/:id/resume", async (req, res) => {
  try {
    const run = await runManager.resumeRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    res.json(run);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not resume run." });
  }
});

app.get("/api/runs/:id/files/result", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run?.outputPath || !fs.existsSync(run.outputPath)) {
    res.status(404).json({ error: "Result workbook is not ready." });
    return;
  }
  res.download(run.outputPath);
});

app.post("/api/runs/:id/files/result/open", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run?.outputPath || !fs.existsSync(run.outputPath)) {
    res.status(404).json({ error: "Result workbook is not ready." });
    return;
  }
  try {
    openLocalFile(run.outputPath);
    res.json({ ok: true, path: run.outputPath });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not open workbook." });
  }
});

app.post("/api/runs/:id/files/folder/open", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  // Prefer the workbook's parent when present, otherwise derive the run directory from the
  // manufacturer/layout — "Images only" runs have no outputPath but still write to a run dir.
  let outputFolder: string | undefined;
  if (run.outputPath && fs.existsSync(run.outputPath)) {
    outputFolder = runRootFromOutputPath(run.outputPath) ?? path.dirname(run.outputPath);
  } else {
    const manufacturer = getManufacturerConfig(run.manufacturerId);
    if (manufacturer) {
      outputFolder = buildRunOutputLayout(appPaths.outputDir, manufacturer, run).runDir;
    }
  }
  if (!outputFolder || !fs.existsSync(outputFolder)) {
    res.status(404).json({ error: "Output folder is not available yet." });
    return;
  }
  try {
    openLocalFile(outputFolder);
    res.json({ ok: true, path: outputFolder });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not open output folder." });
  }
});

app.get("/api/runs/:id/pdt-routing-preview", async (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const manufacturer = getManufacturerConfig(run.manufacturerId);
  if (!manufacturer) {
    res.status(404).json({ error: "Manufacturer not found." });
    return;
  }
  try {
    const [{ classifyDeviceType }, { knownDeviceSheets, deviceSheetsFor, pairCabinetSheets }] = await Promise.all([
      import("./scrapers/device-type.js"),
      import("./pdt/device-sheet-map.js")
    ]);
    const items = db.getRunItems(run.id).filter((it) => it.result && (it.status === "found" || it.status === "partial"));
    const previewItems = items.map((it) => {
      const deviceType = classifyDeviceType(it.result).type;
      let suggested: string[];
      if (manufacturer.id === "abb" && /^1SDA/i.test(it.catalogNumber)) {
        suggested = ["contactor a. fuses"];
      } else {
        suggested = deviceSheetsFor(deviceType);
      }
      suggested = pairCabinetSheets(suggested);
      return {
        itemId: it.id,
        catalogNumber: it.catalogNumber,
        title: it.title,
        deviceType,
        suggestedSheets: suggested
      };
    });
    res.json({
      runId: run.id,
      items: previewItems,
      availableSheets: knownDeviceSheets(),
      savedGroups: run.options?.pdtGroups
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not build routing preview." });
  }
});

/**
 * Attach (or replace) the accessory matrix used by the next PDT export of this run. Kept separate
 * from POST /api/runs/:id/pdt so that route stays a plain JSON call. The matrix is parsed here so
 * a wrong file is rejected while the operator is still looking at the file picker.
 */
app.post("/api/runs/:id/accessory-matrix", customerDocUpload.single("file"), async (req, res) => {
  const run = db.getRun(String(req.params.id));
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Accessory matrix file is required." });
    return;
  }
  if (!isAccessoryMatrixFileName(file.originalname)) {
    res.status(400).json({ error: "The accessory matrix must be an .xlsx or .xlsm workbook." });
    return;
  }
  try {
    const [record] = await persistCustomerDocuments([file]);
    const { loadAccessoryMatrix, accessoryMatrixMainPartsNotInRun } = await import("./pdt/accessory-matrix.js");
    let plan: Awaited<ReturnType<typeof loadAccessoryMatrix>>;
    try {
      plan = await loadAccessoryMatrix(record.storedPath);
    } catch (error) {
      await fs.promises.unlink(record.storedPath).catch(() => undefined);
      await fs.promises.rmdir(path.dirname(record.storedPath)).catch(() => undefined);
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not read the accessory matrix." });
      return;
    }
    db.updateRunOptions(run.id, { accessoryMatrix: record });
    res.json({
      ok: true,
      accessoryMatrix: {
        fileName: record.originalName,
        mainPartCount: plan.mainParts.length,
        pointCount: plan.points.length,
        accessoryRows: plan.accessoryRows.filter((row) => row.kind === "accessory").length,
        connectionPointRows: plan.connectionPointRows.filter((row) => row.kind === "point").length,
        conditionCount: plan.conditions.length,
        mainPartsNotInRun: accessoryMatrixMainPartsNotInRun(
          plan,
          db.getRunItems(run.id).map((item) => item.catalogNumber)
        ),
        warnings: plan.warnings
      }
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not store the accessory matrix." });
  }
});

app.delete("/api/runs/:id/accessory-matrix", async (req, res) => {
  const run = db.getRun(String(req.params.id));
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const detached = run.options?.accessoryMatrix;
  db.updateRunOptions(run.id, { accessoryMatrix: undefined });
  // Only clean up while the upload still sits in the staging area. Once a run has relocated it
  // into its own output folder it is part of that run's record and stays on disk.
  if (detached?.storedPath && isPathInsideAny(detached.storedPath, [appPaths.customerUploadsDir])) {
    await fs.promises.unlink(detached.storedPath).catch(() => undefined);
    await fs.promises.rmdir(path.dirname(detached.storedPath)).catch(() => undefined);
  }
  res.json({ ok: true });
});

app.post("/api/runs/:id/excel", async (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const manufacturer = getManufacturerConfig(run.manufacturerId);
  if (!manufacturer) {
    res.status(404).json({ error: "Manufacturer not found." });
    return;
  }
  if (!["completed", "cancelled"].includes(run.status)) {
    res.status(409).json({ error: "The run must finish before its Excel export can be retried." });
    return;
  }
  try {
    const { exportRunWorkbook } = await import("./excel.js");
    const layout = buildRunOutputLayout(appPaths.outputDir, manufacturer, run);
    await fs.promises.mkdir(layout.excelDir, { recursive: true });
    const items = db.getRunItems(run.id);
    const outputPath = await exportRunWorkbook({
      run,
      manufacturer,
      items,
      outputDir: layout.excelDir
    });
    db.updateRun(run.id, { outputPath, error: undefined });
    res.json({ ok: true, path: outputPath });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not generate Excel workbook." });
  }
});

app.post("/api/runs/:id/pdt", async (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const manufacturer = getManufacturerConfig(run.manufacturerId);
  if (!manufacturer) {
    res.status(404).json({ error: "Manufacturer not found." });
    return;
  }
  try {
    const [{ exportRunPdt }, { resolveTemplatePath }] = await Promise.all([
      import("./pdt/exporter.js"),
      import("./pdt/template.js")
    ]);
    const templatePath = resolveTemplatePath(typeof req.body?.templatePath === "string" ? req.body.templatePath : undefined);
    // Place the PDT next to the products workbook when available, otherwise in the run's excel dir.
    let baseDir: string;
    if (run.outputPath && fs.existsSync(run.outputPath)) {
      baseDir = path.dirname(run.outputPath);
    } else {
      baseDir = buildRunOutputLayout(appPaths.outputDir, manufacturer, run).excelDir;
      fs.mkdirSync(baseDir, { recursive: true });
    }
    const sheetOverrides = parseSheetOverrides(req.body?.sheetOverrides);
    const accessoryMatrix = run.options?.accessoryMatrix;
    const accessoryMatrixPath =
      accessoryMatrix?.storedPath && fs.existsSync(accessoryMatrix.storedPath) ? accessoryMatrix.storedPath : undefined;
    const items = db.getRunItems(run.id);
    const requestedGroups = parsePdtGroups(req.body?.groups);
    if (requestedGroups) {
      const { knownDeviceSheets } = await import("./pdt/device-sheet-map.js");
      const allowed = new Set(knownDeviceSheets().map((sheet) => sheet.toLocaleLowerCase("en-US")));
      const invalid = requestedGroups.find((group) => !allowed.has(group.sheetName.toLocaleLowerCase("en-US")));
      if (invalid) throw new Error(`'${invalid.sheetName}' is not a device sheet in the PDT template.`);
    }
    const commonInput = {
      manufacturer,
      templatePath,
      aiCleanup: req.body?.aiCleanup === true,
      accessoryMatrixPath,
      accessoryMatrixFileName: accessoryMatrixPath ? accessoryMatrix?.originalName : undefined,
      productsWorkbookPath: run.outputPath && fs.existsSync(run.outputPath) ? run.outputPath : undefined
    };
    if (!requestedGroups) {
      const result = await exportRunPdt({
        ...commonInput,
        items,
        outputPath: path.join(baseDir, `${run.id}_PDT.xlsx`),
        sheetOverrides
      });
      if (result.productCount === 0) {
        res.status(400).json({ error: "No found or partial products to import into the PDT." });
        return;
      }
      db.updateRun(run.id, { pdtPath: result.outputPath });
      res.json({ ok: true, path: result.outputPath, stats: result });
      return;
    }

    const eligible = items.filter((item) => item.result && (item.status === "found" || item.status === "partial"));
    const key = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
    const eligibleByNumber = new Map(eligible.map((item) => [key(item.catalogNumber), item]));
    const claimed = new Set<string>();
    const resolvedGroups = requestedGroups.map((group) => {
      const groupItems = group.catalogNumbers.map((catalogNumber) => {
        const normalized = key(catalogNumber);
        if (claimed.has(normalized)) throw new Error(`Catalog number ${catalogNumber} appears in more than one PDT group.`);
        claimed.add(normalized);
        const item = eligibleByNumber.get(normalized);
        if (!item) throw new Error(`Catalog number ${catalogNumber} is not an exportable product in this run.`);
        return item;
      });
      return { group, items: groupItems };
    });
    const remainder = eligible.filter((item) => !claimed.has(key(item.catalogNumber)));
    const exports: PdtGroupExportRecord[] = [];
    const stats: unknown[] = [];
    const safeStem = (value: string) => {
      const cleaned = value
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/[. ]+$/g, "")
        .slice(0, 80)
        .replace(/[. ]+$/g, "");
      if (!cleaned) return "PDT";
      return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(cleaned) ? `PDT-${cleaned}` : cleaned;
    };
    const jobs = [
      ...(remainder.length ? [{ id: "main", name: "Main", fileName: `${run.id}_PDT`, sheetName: "", items: remainder, main: true }] : []),
      ...resolvedGroups.map(({ group, items: groupItems }) => ({ ...group, items: groupItems, main: false }))
    ];
    if (jobs.length === 0) {
      res.status(400).json({ error: "No products were assigned to a PDT group." });
      return;
    }
    const fileStems = jobs.map((job) => safeStem(job.fileName.replace(/\.xlsx$/i, "")));
    if (new Set(fileStems.map((value) => value.toLocaleLowerCase("en-US"))).size !== fileStems.length) {
      throw new Error("PDT file names must be unique after removing characters that Windows does not allow.");
    }
    db.updateRunOptions(run.id, { pdtGroups: requestedGroups, pdtExports: [] });
    const persistGroupExport = (record: PdtGroupExportRecord) => {
      const existingIndex = exports.findIndex((entry) => entry.groupId === record.groupId);
      if (existingIndex >= 0) exports[existingIndex] = record;
      else exports.push(record);
      const currentPdtPath = exports.find((entry) => entry.groupId === "main")?.path ?? exports[0]?.path;
      if (currentPdtPath) db.updateRun(run.id, { pdtPath: currentPdtPath });
      db.updateRunOptions(run.id, { pdtGroups: requestedGroups, pdtExports: [...exports] });
    };
    for (const [jobIndex, job] of jobs.entries()) {
      const fileStem = fileStems[jobIndex];
      const outputPath = path.join(baseDir, `${fileStem}.xlsx`);
      const overrides: Record<number, string[]> = { ...(sheetOverrides ?? {}) };
      if (!job.main) for (const item of job.items) overrides[item.id] = [job.sheetName];
      const result = await exportRunPdt({
        ...commonInput,
        items: job.items,
        outputPath,
        sheetOverrides: overrides,
        accessoryMatrixFilter: job.items.map((item) => item.catalogNumber),
        accessoryMatrixRunCatalogNumbers: eligible.map((item) => item.catalogNumber),
        productsWorkbookPath: jobIndex === 0 ? commonInput.productsWorkbookPath : undefined,
        skipAccessoryConditionPatch: jobIndex > 0,
        onWorkbookReady: (publishedPath) => persistGroupExport({
          groupId: job.id,
          name: job.name,
          path: publishedPath,
          productCount: job.items.length,
          generatedAt: new Date().toISOString()
        })
      });
      if (result.productCount === 0) throw new Error(`PDT group '${job.name}' did not contain any exportable products.`);
      stats.push(result);
      persistGroupExport({
        groupId: job.id,
        name: job.name,
        path: result.outputPath,
        productCount: result.productCount,
        generatedAt: new Date().toISOString()
      });
    }
    const pdtPath = exports.find((entry) => entry.groupId === "main")?.path ?? exports[0].path;
    const savedGroups: PdtGroupDefinition[] = requestedGroups;
    const nextExports = [...exports];
    db.updateRun(run.id, { pdtPath });
    db.updateRunOptions(run.id, { pdtGroups: savedGroups, pdtExports: nextExports });
    res.json({ ok: true, path: pdtPath, paths: exports.map((entry) => entry.path), exports, stats: stats[0], groupStats: stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not generate PDT.";
    if (/^PDT groups|^PDT group|^PDT file name|^Catalog number|^'[^']+' is not a device sheet|^PDT group ids/i.test(message)) {
      res.status(400).json({ error: message });
      return;
    }
    if (/EBUSY|EPERM|resource busy or locked/i.test(message)) {
      res.status(409).json({ error: "Could not write the PDT — close it in Excel and try again." });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.post("/api/runs/:id/files/pdt/open", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run?.pdtPath || !fs.existsSync(run.pdtPath)) {
    res.status(404).json({ error: "PDT workbook is not ready." });
    return;
  }
  try {
    openLocalFile(run.pdtPath);
    res.json({ ok: true, path: run.pdtPath });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not open PDT." });
  }
});

app.get("/api/runs/:id/files/pdt/:groupId", (req, res) => {
  const run = db.getRun(req.params.id);
  const record = run?.options?.pdtExports?.find((entry) => entry.groupId === req.params.groupId);
  if (!record?.path || !fs.existsSync(record.path)) {
    res.status(404).json({ error: "The requested PDT group workbook is not available." });
    return;
  }
  res.download(record.path);
});

app.get("/api/runs/:id/files/pdt", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run?.pdtPath || !fs.existsSync(run.pdtPath)) {
    res.status(404).json({ error: "PDT workbook is not ready." });
    return;
  }
  res.download(run.pdtPath);
});

app.get("/api/runs/:id/files/log", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const manufacturer = getManufacturerConfig(run.manufacturerId);
  if (!manufacturer) {
    res.status(404).json({ error: "Manufacturer not found." });
    return;
  }
  const logPath = findRunLogPath(appPaths.outputDir, manufacturer, run);
  if (!logPath || !fs.existsSync(logPath)) {
    res.status(404).json({ error: "Run log is not available." });
    return;
  }
  res.download(logPath);
});

app.get("/api/runs/:id/files/document", (req, res) => {
  const requested = String(req.query.path ?? "");
  const run = db.getRun(req.params.id);
  if (!run || !requested) {
    res.status(404).json({ error: "Document not found." });
    return;
  }
  const manufacturer = getManufacturerConfig(run.manufacturerId);
  if (!manufacturer) {
    res.status(404).json({ error: "Manufacturer not found." });
    return;
  }
  const resolved = path.resolve(requested);
  const allowedRoots = getAllowedRunOutputRoots(appPaths.outputDir, manufacturer, run);
  if (!isPathInsideAny(resolved, allowedRoots) || !fs.existsSync(resolved)) {
    res.status(403).json({ error: "Document path is outside the run folder or does not exist." });
    return;
  }
  res.download(resolved);
});

const distDir = path.join(rootDir, "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : "Server error" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Product Scraper API running at http://127.0.0.1:${port}`);
  runManager.resumeInterruptedRuns();
});

function parseCustomCoverageFieldsFromRequest(raw: unknown): import("../shared/types.js").CustomCoverageField[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    // Malformed JSON — treat as "no override" rather than aborting the whole run start.
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const seen = new Set<string>();
  const cleaned: import("../shared/types.js").CustomCoverageField[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; label?: unknown; pattern?: unknown };
    const label = String(record.label ?? "").trim();
    const pattern = String(record.pattern ?? "").trim();
    const id = String(record.id ?? label)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id || !label || !pattern) continue;
    if (seen.has(id)) continue;
    try {
      new RegExp(pattern, "i");
    } catch {
      continue;
    }
    seen.add(id);
    cleaned.push({ id, label, pattern });
    if (cleaned.length >= 32) break;
  }
  return cleaned;
}

async function persistCustomerDocuments(files: Express.Multer.File[]): Promise<CustomerDocumentRecord[]> {
  if (!files.length) return [];
  const fsAsync = await import("node:fs/promises");
  const records: CustomerDocumentRecord[] = [];
  // Stage files in a per-batch folder so we can reference them by absolute path before
  // the run-manager has built its run directory. The run-manager moves them into the
  // run output folder at processing time so each run keeps its source-of-truth nearby.
  const batchDir = path.join(appPaths.customerUploadsDir, `staging-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await fsAsync.mkdir(batchDir, { recursive: true });
  for (const file of files) {
    if (/\.7z$/i.test(file.originalname || "")) {
      const archivePath = path.join(batchDir, `${crypto.randomBytes(8).toString("hex")}.7z`);
      const extractDir = path.join(batchDir, crypto.randomBytes(8).toString("hex"));
      await fsAsync.writeFile(archivePath, file.buffer);
      const extracted = await extractCustomerArchive(archivePath, extractDir);
      for (const entry of extracted) {
        const id = crypto.randomBytes(8).toString("hex");
        records.push({
          id,
          originalName: entry.name,
          storedPath: entry.path,
          mimeType: customerDocumentMimeType(path.extname(entry.name).toLowerCase()),
          size: entry.size,
          uploadedAt: new Date().toISOString()
        });
      }
      continue;
    }
    const id = crypto.randomBytes(8).toString("hex");
    const safeName = sanitizeCustomerFileName(file.originalname || `document-${id}`);
    const storedPath = path.join(batchDir, `${id}-${safeName}`);
    await fsAsync.writeFile(storedPath, file.buffer);
    records.push({
      id,
      originalName: file.originalname || safeName,
      storedPath,
      mimeType: file.mimetype,
      size: file.size,
      uploadedAt: new Date().toISOString()
    });
  }
  return records;
}

function customerDocumentMimeType(extension: string): string {
  return ({
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

const CUSTOMER_ARCHIVE_MAX_FILES = 20;
const CUSTOMER_ARCHIVE_MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const CUSTOMER_ARCHIVE_DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".xls", ".csv", ".tsv", ".txt"]);

async function extractCustomerArchive(archivePath: string, outputDir: string): Promise<Array<{ name: string; path: string; size: number }>> {
  const fsAsync = await import("node:fs/promises");
  const sevenZip = await findSevenZipExecutable();
  if (!sevenZip) {
    throw new Error("Cannot read this customer .7z archive because 7-Zip is not installed. Install 7-Zip or attach the extracted PDF files.");
  }
  const listing = await runSevenZip(sevenZip, ["l", "-slt", archivePath]);
  const members = parseSevenZipListing(listing);
  const documents = members.filter((member) => CUSTOMER_ARCHIVE_DOCUMENT_EXTENSIONS.has(path.extname(member.name).toLowerCase()));
  if (documents.length === 0) throw new Error("The customer .7z archive contains no supported documents.");
  if (documents.length > CUSTOMER_ARCHIVE_MAX_FILES) {
    throw new Error(`The customer .7z archive contains ${documents.length} supported documents; the limit is ${CUSTOMER_ARCHIVE_MAX_FILES}.`);
  }
  const declaredBytes = documents.reduce((sum, member) => sum + member.size, 0);
  if (declaredBytes > CUSTOMER_ARCHIVE_MAX_UNPACKED_BYTES) {
    throw new Error("The customer .7z archive expands beyond the 500 MB document limit.");
  }
  await fsAsync.mkdir(outputDir, { recursive: true });
  // Name only the approved document members so large unrelated archive payloads are never extracted.
  await runSevenZip(sevenZip, ["x", "-y", `-o${outputDir}`, archivePath, ...documents.map((member) => member.name)]);
  const root = path.resolve(outputDir);
  const extracted: Array<{ name: string; path: string; size: number }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fsAsync.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.resolve(directory, entry.name);
      if (!fullPath.startsWith(`${root}${path.sep}`)) throw new Error("The customer archive contains a path outside its extraction folder.");
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && CUSTOMER_ARCHIVE_DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const stat = await fsAsync.stat(fullPath);
        extracted.push({ name: path.basename(entry.name), path: fullPath, size: stat.size });
      }
    }
  }
  await visit(root);
  const actualBytes = extracted.reduce((sum, entry) => sum + entry.size, 0);
  if (extracted.length !== documents.length || actualBytes > CUSTOMER_ARCHIVE_MAX_UNPACKED_BYTES) {
    throw new Error("The customer archive contents did not match its listing or exceeded the document limits.");
  }
  return extracted;
}

function parseSevenZipListing(output: string): Array<{ name: string; size: number }> {
  const members: Array<{ name: string; size: number }> = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    const values = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(" = ");
      if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 3));
    }
    const name = values.get("Path");
    if (!name || values.get("Folder") === "+" || values.has("Attributes") && /D/.test(values.get("Attributes")!)) continue;
    const normalized = name.replace(/\\/g, "/");
    if (/^(?:[a-z]:|\/)/i.test(normalized) || normalized.startsWith("-") || /[*?]/.test(normalized) || normalized.split("/").some((part) => part === "..")) {
      throw new Error("The customer archive contains an unsafe file path and was rejected.");
    }
    const size = Number(values.get("Size"));
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("The customer archive contains a file with an invalid size.");
    members.push({ name: normalized, size });
  }
  return members;
}

async function findSevenZipExecutable(): Promise<string | undefined> {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe", ...String(process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "7z.exe"))]
    : ["7z", "7zz", "7za"];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try { await (await import("node:fs/promises")).access(candidate); return candidate; } catch { continue; }
    }
    if (await canRunCommand(candidate, ["-h"])) return candidate;
  }
  return undefined;
}

function canRunCommand(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", () => resolve(true));
  });
}

function runSevenZip(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 8 * 1024 * 1024) stdout.push(chunk); else child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { if (Buffer.concat(stderr).length < 1024 * 1024) stderr.push(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      if (timedOut) return reject(new Error("Reading the customer archive timed out after 2 minutes."));
      if (bytes > 8 * 1024 * 1024) return reject(new Error("The customer archive listing is too large to process."));
      if (code !== 0) return reject(new Error(detail || `7-Zip exited with code ${code ?? "unknown"}.`));
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function parseSheetOverrides(raw: unknown): import("../shared/types.js").PdtSheetOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<number, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const itemId = Number(key);
    if (!Number.isFinite(itemId) || !Array.isArray(value)) continue;
    const sheets = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((s) => s.trim());
    if (sheets.length > 0) out[itemId] = [...new Set(sheets)];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePdtGroups(raw: unknown): PdtGroupDefinition[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("PDT groups must be a non-empty list.");
  const groups = raw.map((value, index): PdtGroupDefinition => {
    if (!value || typeof value !== "object") throw new Error(`PDT group ${index + 1} is invalid.`);
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const fileName = typeof row.fileName === "string" ? row.fileName.trim() : "";
    const sheetName = typeof row.sheetName === "string" ? row.sheetName.trim() : "";
    if (!id || id.length > 80 || !name || name.length > 120 || !fileName || fileName.length > 120 || !sheetName || sheetName.length > 120) {
      throw new Error(`PDT group ${index + 1} needs an id, name, file name and existing device sheet.`);
    }
    if (!Array.isArray(row.catalogNumbers) || row.catalogNumbers.length === 0 || row.catalogNumbers.length > 100_000) {
      throw new Error(`PDT group '${name}' needs at least one catalog number.`);
    }
    const catalogNumbers = [...new Set(row.catalogNumbers
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry, entryIndex, all) => all.findIndex((candidate) => candidate.replace(/\s+/g, " ").toLocaleLowerCase("en-US") === entry.replace(/\s+/g, " ").toLocaleLowerCase("en-US")) === entryIndex))];
    if (catalogNumbers.length === 0) throw new Error(`PDT group '${name}' has no valid catalog numbers.`);
    return { id, name, fileName, sheetName, catalogNumbers };
  });
  if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new Error("PDT group ids must be unique.");
  if (groups.some((group) => group.id === "main")) throw new Error("PDT group id 'main' is reserved for the remainder workbook.");
  if (new Set(groups.map((group) => group.fileName.replace(/\.xlsx$/i, "").toLocaleLowerCase("en-US"))).size !== groups.length) {
    throw new Error("PDT group file names must be unique.");
  }
  return groups;
}

/** Main part numbers of an uploaded accessory matrix, normalized like a catalog CSV's column. */
async function accessoryMatrixCatalogNumbersFromUpload(buffer: Uint8Array): Promise<string[]> {
  const { parseAccessoryMatrixBuffer, accessoryMatrixCatalogNumbers } = await import("./pdt/accessory-matrix.js");
  return accessoryMatrixCatalogNumbers(await parseAccessoryMatrixBuffer(buffer));
}

/** The accessory matrix is read with ExcelJS, so only real Excel workbooks are accepted. */
function isAccessoryMatrixFileName(name: string | undefined): boolean {
  return /\.(xlsx|xlsm)$/i.test((name ?? "").trim());
}

function sanitizeCustomerFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-").slice(0, 120).replace(/^-+|-+$/g, "");
  return cleaned || "customer-document";
}

function openLocalFile(filePath: string) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  let child;
  if (process.platform === "win32") {
    // `cmd /c start "" "<path>"` is the most reliable Windows launcher for both files and
    // directories. The empty "" is start's optional window-title argument; without it a
    // quoted path gets parsed as the title and start opens nothing. The previous code used
    // explorer.exe directly for directories, which silently no-ops when Explorer is already
    // running with the same folder, hence the "Folder" button appearing dead in the UI.
    child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "start", "", resolved], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
  } else if (process.platform === "darwin") {
    child = spawn("open", [resolved], { detached: true, stdio: "ignore" });
  } else {
    child = spawn("xdg-open", [resolved], { detached: true, stdio: "ignore" });
  }
  // Spawn failures (e.g. command not found) surface async via the "error" event. Without a
  // listener they become silent in production — log them so the next regression is visible.
  child.on("error", (error) => {
    console.error(`[openLocalFile] failed to open ${resolved}: ${error.message}`);
  });
  child.unref();
}
