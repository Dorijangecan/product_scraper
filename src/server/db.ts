import Database from "better-sqlite3";
import type { ItemStatus, ManufacturerId, ProductResult, RunItemRecord, RunRecord, RunStatus } from "../shared/types.js";
import type { AppPaths } from "./paths.js";

interface RunRow {
  id: string;
  manufacturer_id: ManufacturerId;
  created_at: string;
  updated_at: string;
  status: RunStatus;
  input_file_name?: string;
  total: number;
  processed: number;
  found: number;
  partial: number;
  failed: number;
  output_path?: string;
  error?: string;
}

interface ItemRow {
  id: number;
  run_id: string;
  row_index: number;
  catalog_number: string;
  status: ItemStatus;
  title?: string;
  product_url?: string;
  confidence?: number;
  error?: string;
  raw_json?: string;
  updated_at: string;
}

interface PageCacheRow {
  cache_key: string;
  method: string;
  url: string;
  request_hash: string;
  path: string;
  status_code?: number;
  content_type?: string;
  effective_url?: string;
  fetched_at: string;
}

export class ScraperDb {
  private db: Database.Database;

  constructor(private readonly paths: AppPaths) {
    this.db = new Database(paths.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  close() {
    this.db.close();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
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
        failed INTEGER NOT NULL DEFAULT 0,
        output_path TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS run_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        row_index INTEGER NOT NULL,
        catalog_number TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        product_url TEXT,
        confidence REAL,
        error TEXT,
        raw_json TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, row_index)
      );

      CREATE TABLE IF NOT EXISTS page_cache (
        cache_key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER,
        content_type TEXT,
        effective_url TEXT,
        fetched_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_run_items_run_id ON run_items(run_id, row_index);
      CREATE INDEX IF NOT EXISTS idx_page_cache_url ON page_cache(url);
    `);
  }

  createRun(input: {
    id: string;
    manufacturerId: ManufacturerId;
    inputFileName?: string;
    catalogNumbers: string[];
  }): RunRecord {
    const now = new Date().toISOString();
    const insertRun = this.db.prepare(`
      INSERT INTO runs (id, manufacturer_id, created_at, updated_at, status, input_file_name, total)
      VALUES (@id, @manufacturerId, @now, @now, 'queued', @inputFileName, @total)
    `);
    const insertItem = this.db.prepare(`
      INSERT INTO run_items (run_id, row_index, catalog_number, status, updated_at)
      VALUES (@runId, @rowIndex, @catalogNumber, 'pending', @now)
    `);
    const tx = this.db.transaction(() => {
      insertRun.run({
        id: input.id,
        manufacturerId: input.manufacturerId,
        inputFileName: input.inputFileName,
        total: input.catalogNumbers.length,
        now
      });
      input.catalogNumbers.forEach((catalogNumber, index) => {
        insertItem.run({
          runId: input.id,
          rowIndex: index + 1,
          catalogNumber,
          now
        });
      });
    });
    tx();
    return this.getRun(input.id)!;
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as RunRow[];
    return rows.map(mapRun);
  }

  listRunsByStatus(statuses: RunStatus[]): RunRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at`).all(...statuses) as RunRow[];
    return rows.map(mapRun);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  updateRun(id: string, patch: Partial<Pick<RunRecord, "status" | "processed" | "found" | "partial" | "failed" | "outputPath" | "error">>) {
    const current = this.getRun(id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare(`
        UPDATE runs
        SET status = @status,
            processed = @processed,
            found = @found,
            partial = @partial,
            failed = @failed,
            output_path = @outputPath,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @id
      `)
      .run({ ...next, id });
  }

  getRunItems(runId: string): RunItemRecord[] {
    const rows = this.db.prepare("SELECT * FROM run_items WHERE run_id = ? ORDER BY row_index").all(runId) as ItemRow[];
    return rows.map(mapItem);
  }

  getPendingRunItems(runId: string): RunItemRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM run_items WHERE run_id = ? AND status IN ('pending', 'processing') ORDER BY row_index")
      .all(runId) as ItemRow[];
    return rows.map(mapItem);
  }

  cancelPendingRunItems(runId: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE run_items SET status = 'cancelled', error = 'Cancelled by user.', updated_at = ? WHERE run_id = ? AND status = 'pending'"
      )
      .run(now, runId);
  }

  cancelActiveRunItems(runId: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE run_items SET status = 'cancelled', error = 'Cancelled by user.', updated_at = ? WHERE run_id = ? AND status IN ('pending', 'processing')"
      )
      .run(now, runId);
  }

  isCancellationRequested(runId: string): boolean {
    const row = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: RunStatus } | undefined;
    return row?.status === "cancelling" || row?.status === "cancelled";
  }

  updateRunItem(id: number, patch: Partial<Pick<RunItemRecord, "status" | "title" | "productUrl" | "confidence" | "error" | "result">>) {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE run_items
        SET status = COALESCE(@status, status),
            title = @title,
            product_url = @productUrl,
            confidence = @confidence,
            error = @error,
            raw_json = @rawJson,
            updated_at = @updatedAt
        WHERE id = @id
      `)
      .run({
        id,
        status: patch.status,
        title: patch.title,
        productUrl: patch.productUrl,
        confidence: patch.confidence,
        error: patch.error,
        rawJson: patch.result ? JSON.stringify(patch.result) : undefined,
        updatedAt
      });
  }

  recountRun(runId: string) {
    const row = this.db
      .prepare(`
        SELECT
          SUM(CASE WHEN status IN ('found', 'partial', 'failed', 'cancelled') THEN 1 ELSE 0 END) AS processed,
          SUM(CASE WHEN status = 'found' THEN 1 ELSE 0 END) AS found,
          SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM run_items
        WHERE run_id = ?
      `)
      .get(runId) as { processed: number; found: number; partial: number; failed: number };
    this.updateRun(runId, {
      processed: row.processed ?? 0,
      found: row.found ?? 0,
      partial: row.partial ?? 0,
      failed: row.failed ?? 0
    });
  }

  getPageCache(cacheKey: string): PageCacheRow | undefined {
    return this.db.prepare("SELECT * FROM page_cache WHERE cache_key = ?").get(cacheKey) as PageCacheRow | undefined;
  }

  setPageCache(row: PageCacheRow) {
    this.db
      .prepare(`
        INSERT INTO page_cache (cache_key, method, url, request_hash, path, status_code, content_type, effective_url, fetched_at)
        VALUES (@cache_key, @method, @url, @request_hash, @path, @status_code, @content_type, @effective_url, @fetched_at)
        ON CONFLICT(cache_key) DO UPDATE SET
          path = excluded.path,
          status_code = excluded.status_code,
          content_type = excluded.content_type,
          effective_url = excluded.effective_url,
          fetched_at = excluded.fetched_at
      `)
      .run(row);
  }
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    manufacturerId: row.manufacturer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    inputFileName: row.input_file_name,
    total: row.total,
    processed: row.processed,
    found: row.found,
    partial: row.partial,
    failed: row.failed,
    outputPath: row.output_path,
    error: row.error
  };
}

function mapItem(row: ItemRow): RunItemRecord {
  let result: ProductResult | undefined;
  if (row.raw_json) {
    try {
      result = JSON.parse(row.raw_json) as ProductResult;
    } catch {
      result = undefined;
    }
  }
  return {
    id: row.id,
    runId: row.run_id,
    rowIndex: row.row_index,
    catalogNumber: row.catalog_number,
    status: row.status,
    title: row.title,
    productUrl: row.product_url,
    confidence: row.confidence,
    error: row.error,
    result,
    updatedAt: row.updated_at
  };
}
