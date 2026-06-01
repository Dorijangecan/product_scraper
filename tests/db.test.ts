import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ScraperDb } from "../src/server/db.js";
import type { AppPaths } from "../src/server/paths.js";
import type { ProductResult } from "../src/shared/types.js";

describe("scraper db run items", () => {
  it("updates activity stage without clearing stored scrape results", async () => {
    const { db, rootDir } = await createTempDb();
    try {
      const run = db.createRun({
        id: "run-activity",
        manufacturerId: "abb",
        catalogNumbers: ["A1"]
      });
      const item = db.getRunItems(run.id)[0];
      const result: ProductResult = {
        manufacturerId: "abb",
        catalogNumber: "A1",
        status: "found",
        confidence: 0.82,
        productUrl: "https://example.test/A1",
        title: "Original product",
        normalized: {},
        attributes: [],
        documents: [],
        sources: []
      };

      db.updateRunItem(item.id, {
        status: "found",
        title: result.title,
        productUrl: result.productUrl,
        confidence: result.confidence,
        result
      });
      db.updateRunItem(item.id, {
        stage: "downloads",
        stageMessage: "Downloading product documents",
        stageStartedAt: "2026-05-24T10:00:00.000Z"
      });

      const updated = db.getRunItems(run.id)[0];
      expect(updated.status).toBe("found");
      expect(updated.title).toBe("Original product");
      expect(updated.productUrl).toBe("https://example.test/A1");
      expect(updated.result?.title).toBe("Original product");
      expect(updated.stage).toBe("downloads");
      expect(updated.stageMessage).toBe("Downloading product documents");
    } finally {
      db.close();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("can clear a previous row error when work restarts", async () => {
    const { db, rootDir } = await createTempDb();
    try {
      const run = db.createRun({
        id: "run-clear-error",
        manufacturerId: "abb",
        catalogNumbers: ["A1"]
      });
      const item = db.getRunItems(run.id)[0];

      db.updateRunItem(item.id, { status: "failed", error: "Old error" });
      db.updateRunItem(item.id, { status: "processing", error: undefined });

      const updated = db.getRunItems(run.id)[0];
      expect(updated.status).toBe("processing");
      expect(updated.error).toBeUndefined();
    } finally {
      db.close();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("migrates older database files before writing new run/item/cache fields", async () => {
    const { paths, rootDir } = await createTempPaths();
    const sqlite = new Database(paths.dbPath);
    sqlite.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        manufacturer_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        input_file_name TEXT,
        total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        found INTEGER NOT NULL DEFAULT 0,
        partial INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE run_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        catalog_number TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, row_index)
      );
      CREATE TABLE page_cache (
        cache_key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
    sqlite.close();

    const db = new ScraperDb(paths);
    try {
      const run = db.createRun({
        id: "run-migrated",
        manufacturerId: "abb",
        catalogNumbers: ["A1"],
        options: { downloadDocuments: false }
      });
      const item = db.getRunItems(run.id)[0];
      const result: ProductResult = {
        manufacturerId: "abb",
        catalogNumber: "A1",
        status: "found",
        confidence: 0.82,
        productUrl: "https://example.test/A1",
        title: "Migrated product",
        normalized: {},
        attributes: [],
        documents: [],
        sources: []
      };

      db.updateRun(run.id, { outputPath: "out.xlsx" });
      db.updateRunItem(item.id, {
        status: "found",
        stage: "complete",
        stageMessage: "Done",
        title: result.title,
        productUrl: result.productUrl,
        confidence: result.confidence,
        result
      });
      db.setPageCache({
        cache_key: "cache-key",
        method: "GET",
        url: "https://example.test/A1",
        request_hash: "hash",
        path: path.join(paths.cacheDir, "cache-key.html"),
        status_code: 200,
        content_type: "text/html",
        effective_url: "https://example.test/A1",
        fetched_at: "2026-05-24T10:00:00.000Z"
      });

      expect(db.getRun(run.id)?.outputPath).toBe("out.xlsx");
      expect(db.getRunItems(run.id)[0].stage).toBe("complete");
      expect(db.getRunItems(run.id)[0].result?.title).toBe("Migrated product");
      expect(db.getPageCache("cache-key")?.status_code).toBe(200);
    } finally {
      db.close();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

async function createTempDb(): Promise<{ db: ScraperDb; rootDir: string }> {
  const { paths, rootDir } = await createTempPaths();
  return { db: new ScraperDb(paths), rootDir };
}

async function createTempPaths(): Promise<{ paths: AppPaths; rootDir: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "scraper-db-"));
  const paths: AppPaths = {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    cacheDir: path.join(rootDir, "data", "cache"),
    outputDir: path.join(rootDir, "outputs"),
    customerUploadsDir: path.join(rootDir, "data", "customer-uploads"),
    dbPath: path.join(rootDir, "data", "scraper.db")
  };
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
  await fs.mkdir(paths.outputDir, { recursive: true });
  await fs.mkdir(paths.customerUploadsDir, { recursive: true });
  return { paths, rootDir };
}
