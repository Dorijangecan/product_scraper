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
import { findRunLogPath, getAllowedRunOutputRoots, isPathInsideAny } from "./run-output.js";
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
      options: { downloadDocuments }
    });
    res.status(201).json(run);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not start run." });
  }
});

app.get("/api/runs", (_req, res) => {
  res.json(db.listRuns());
});

app.get("/api/runs/:id", (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  const items = db.getRunItems(run.id);
  res.json({ run, items: req.query.summary === "1" ? items.map(summarizeRunItem) : items });
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

function openLocalFile(filePath: string) {
  const resolved = path.resolve(filePath);
  let child;
  if (process.platform === "win32") {
    child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", resolved], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
  } else if (process.platform === "darwin") {
    child = spawn("open", [resolved], { detached: true, stdio: "ignore" });
  } else {
    child = spawn("xdg-open", [resolved], { detached: true, stdio: "ignore" });
  }
  child.unref();
}
