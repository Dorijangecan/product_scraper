import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewCsv, extractCatalogNumbers } from "./csv.js";
import { ScraperDb } from "./db.js";
import { createAppPaths } from "./paths.js";
import { RunManager } from "./run-manager.js";
import { getManufacturerConfig, initializeManufacturerConfig, listManufacturerConfigs, resetManufacturerOverride, saveManufacturerConfig } from "./config/manufacturers.js";
import type { ManufacturerId } from "../shared/types.js";
import { buildRunOutputLayout, findRunLogPath, getAllowedRunOutputRoots, isPathInsideAny, runRootFromOutputPath } from "./run-output.js";
import { CachedHttpClient } from "./scrapers/http-client.js";
import { inspectManufacturerDraft, testManufacturerDraft } from "./manufacturer-wizard.js";
import { summarizeRunItem } from "./run-item-summary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const appPaths = createAppPaths(rootDir);
initializeManufacturerConfig(appPaths.dataDir);
const db = new ScraperDb(appPaths);
const runManager = new RunManager(db, appPaths);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/manufacturers", (_req, res) => {
  res.json(listManufacturerConfigs());
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
    const http = new CachedHttpClient(db, appPaths.cacheDir);
    res.json(await inspectManufacturerDraft(req.body, http));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not inspect manufacturer." });
  }
});

app.post("/api/manufacturers/test", async (req, res) => {
  try {
    const http = new CachedHttpClient(db, appPaths.cacheDir);
    res.json(await testManufacturerDraft(req.body, { db, http, paths: appPaths }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not test manufacturer." });
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

app.post("/api/runs", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "CSV file is required." });
    return;
  }
  const manufacturerId = String(req.body.manufacturerId ?? "") as ManufacturerId;
  const columnName = String(req.body.columnName ?? "");
  const downloadDocuments = String(req.body.downloadDocuments ?? "true") === "true";
  const downloadImages = String(req.body.downloadImages ?? "true") === "true";
  const generateExcel = String(req.body.generateExcel ?? "true") === "true";
  const forceFinalRetry = String(req.body.forceFinalRetry ?? "false") === "true";
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
  if (!columnName) {
    res.status(400).json({ error: "CSV column is required." });
    return;
  }
  try {
    const catalogNumbers = await extractCatalogNumbers(req.file.buffer, columnName);
    if (catalogNumbers.length === 0) {
      res.status(400).json({ error: "No catalog numbers found in selected column." });
      return;
    }
    const run = runManager.createRun({
      manufacturerId,
      inputFileName: req.file.originalname,
      catalogNumbers,
      options: {
        downloadDocuments,
        downloadImages,
        generateExcel,
        forceFinalRetry,
        ...(customCoverageFields !== undefined ? { customCoverageFields } : {}),
        ...(hiddenCoverageFields !== undefined ? { hiddenCoverageFields } : {})
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
    res.json({ run, items: items.map((item) => summarizeRunItem(item, { customCoverageFields })) });
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
