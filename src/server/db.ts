import Database from "better-sqlite3";
import type {
  ItemStatus,
  LearnedEndpointRecord,
  ManufacturerId,
  ProductResult,
  RunItemRecord,
  RunRecord,
  RunStatus
} from "../shared/types.js";
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
  pdt_path?: string;
  activity_stage?: string | null;
  activity_message?: string | null;
  activity_started_at?: string | null;
  options_json?: string;
  error?: string;
}

interface ItemRow {
  id: number;
  run_id: string;
  row_index: number;
  catalog_number: string;
  status: ItemStatus;
  stage?: string | null;
  stage_message?: string | null;
  stage_started_at?: string | null;
  title?: string | null;
  product_url?: string | null;
  confidence?: number | null;
  error?: string | null;
  raw_json?: string | null;
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

interface LearnedEndpointRow {
  id: number;
  manufacturer_id: ManufacturerId;
  host: string;
  method: "GET" | "POST";
  url_template: string;
  body_template?: string;
  headers_json?: string;
  discovered_from_url: string;
  parser_kind: string;
  success_count: number;
  last_success_at: string;
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
        activity_stage TEXT,
        activity_message TEXT,
        activity_started_at TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS run_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        row_index INTEGER NOT NULL,
        catalog_number TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT,
        stage_message TEXT,
        stage_started_at TEXT,
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

      CREATE TABLE IF NOT EXISTS learned_endpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manufacturer_id TEXT NOT NULL,
        host TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'GET',
        url_template TEXT NOT NULL,
        body_template TEXT,
        headers_json TEXT,
        discovered_from_url TEXT NOT NULL,
        parser_kind TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 1,
        last_success_at TEXT NOT NULL,
        UNIQUE(manufacturer_id, method, url_template)
      );

      CREATE TABLE IF NOT EXISTS exhausted_fields (
        manufacturer_id TEXT NOT NULL,
        catalog_number TEXT NOT NULL,
        field TEXT NOT NULL,
        reason TEXT,
        marked_at TEXT NOT NULL,
        PRIMARY KEY (manufacturer_id, catalog_number, field)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_run_items_run_id ON run_items(run_id, row_index);
      CREATE INDEX IF NOT EXISTS idx_page_cache_url ON page_cache(url);
      CREATE INDEX IF NOT EXISTS idx_learned_endpoints_manufacturer ON learned_endpoints(manufacturer_id, success_count DESC, last_success_at DESC);
    `);
    this.addColumnIfMissing("runs", "options_json", "TEXT");
    this.addColumnIfMissing("runs", "output_path", "TEXT");
    this.addColumnIfMissing("runs", "pdt_path", "TEXT");
    this.addColumnIfMissing("runs", "activity_stage", "TEXT");
    this.addColumnIfMissing("runs", "activity_message", "TEXT");
    this.addColumnIfMissing("runs", "activity_started_at", "TEXT");
    this.addColumnIfMissing("runs", "error", "TEXT");
    this.addColumnIfMissing("run_items", "stage", "TEXT");
    this.addColumnIfMissing("run_items", "stage_message", "TEXT");
    this.addColumnIfMissing("run_items", "stage_started_at", "TEXT");
    this.addColumnIfMissing("run_items", "title", "TEXT");
    this.addColumnIfMissing("run_items", "product_url", "TEXT");
    this.addColumnIfMissing("run_items", "confidence", "REAL");
    this.addColumnIfMissing("run_items", "error", "TEXT");
    this.addColumnIfMissing("run_items", "raw_json", "TEXT");
    this.addColumnIfMissing("page_cache", "status_code", "INTEGER");
    this.addColumnIfMissing("page_cache", "content_type", "TEXT");
    this.addColumnIfMissing("page_cache", "effective_url", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createRun(input: {
    id: string;
    manufacturerId: ManufacturerId;
    inputFileName?: string;
    catalogNumbers: string[];
    options?: RunRecord["options"];
  }): RunRecord {
    const now = new Date().toISOString();
    const insertRun = this.db.prepare(`
      INSERT INTO runs (id, manufacturer_id, created_at, updated_at, status, input_file_name, total, options_json)
      VALUES (@id, @manufacturerId, @now, @now, 'queued', @inputFileName, @total, @optionsJson)
    `);
    const insertItem = this.db.prepare(`
      INSERT INTO run_items (run_id, row_index, catalog_number, status, stage, stage_message, stage_started_at, updated_at)
      VALUES (@runId, @rowIndex, @catalogNumber, 'pending', 'pending', 'Waiting to start', @now, @now)
    `);
    const tx = this.db.transaction(() => {
      insertRun.run({
        id: input.id,
        manufacturerId: input.manufacturerId,
        inputFileName: input.inputFileName,
        total: input.catalogNumbers.length,
        optionsJson: input.options ? JSON.stringify(input.options) : undefined,
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

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        RunRecord,
        | "status"
        | "processed"
        | "found"
        | "partial"
        | "failed"
        | "outputPath"
        | "pdtPath"
        | "activityStage"
        | "activityMessage"
        | "activityStartedAt"
        | "error"
      >
    >
  ) {
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
            pdt_path = @pdtPath,
            activity_stage = @activityStage,
            activity_message = @activityMessage,
            activity_started_at = @activityStartedAt,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @id
      `)
      .run({
        ...next,
        pdtPath: next.pdtPath ?? null,
        activityStage: next.activityStage ?? null,
        activityMessage: next.activityMessage ?? null,
        activityStartedAt: next.activityStartedAt ?? null,
        id
      });
  }

  /**
   * Merge-update the run's `options` JSON column. Used by the dashboard editor to tweak
   * coverage tiles after a run has started without disturbing other status fields.
   */
  updateRunOptions(id: string, optionsPatch: NonNullable<RunRecord["options"]>) {
    const current = this.getRun(id);
    if (!current) return;
    const nextOptions = { ...(current.options ?? {}), ...optionsPatch };
    this.db
      .prepare("UPDATE runs SET options_json = @optionsJson, updated_at = @updatedAt WHERE id = @id")
      .run({ id, optionsJson: JSON.stringify(nextOptions), updatedAt: new Date().toISOString() });
  }

  getRunItems(runId: string): RunItemRecord[] {
    const rows = this.db.prepare("SELECT * FROM run_items WHERE run_id = ? ORDER BY row_index").all(runId) as ItemRow[];
    return rows.map(mapItem);
  }

  getRunItem(runId: string, itemId: number): RunItemRecord | undefined {
    const row = this.db.prepare("SELECT * FROM run_items WHERE run_id = ? AND id = ?").get(runId, itemId) as ItemRow | undefined;
    return row ? mapItem(row) : undefined;
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
        "UPDATE run_items SET status = 'cancelled', stage = 'cancelled', stage_message = 'Cancelled by user.', stage_started_at = ?, error = 'Cancelled by user.', updated_at = ? WHERE run_id = ? AND status = 'pending'"
      )
      .run(now, now, runId);
  }

  cancelActiveRunItems(runId: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE run_items SET status = 'cancelled', stage = 'cancelled', stage_message = 'Cancelled by user.', stage_started_at = ?, error = 'Cancelled by user.', updated_at = ? WHERE run_id = ? AND status IN ('pending', 'processing')"
      )
      .run(now, now, runId);
  }

  isCancellationRequested(runId: string): boolean {
    const row = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: RunStatus } | undefined;
    return row?.status === "cancelling" || row?.status === "cancelled";
  }

  updateRunItem(
    id: number,
    patch: Partial<
      Pick<
        RunItemRecord,
        "status" | "stage" | "stageMessage" | "stageStartedAt" | "title" | "productUrl" | "confidence" | "error" | "result"
      >
    >
  ) {
    const current = this.db.prepare("SELECT * FROM run_items WHERE id = ?").get(id) as ItemRow | undefined;
    if (!current) return;
    const hasPatch = (key: keyof typeof patch) => Object.prototype.hasOwnProperty.call(patch, key);
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE run_items
        SET status = @status,
            stage = @stage,
            stage_message = @stageMessage,
            stage_started_at = @stageStartedAt,
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
        status: hasPatch("status") && patch.status ? patch.status : current.status,
        stage: hasPatch("stage") ? patch.stage ?? null : current.stage ?? null,
        stageMessage: hasPatch("stageMessage") ? patch.stageMessage ?? null : current.stage_message ?? null,
        stageStartedAt: hasPatch("stageStartedAt") ? patch.stageStartedAt ?? null : current.stage_started_at ?? null,
        title: hasPatch("title") ? patch.title ?? null : current.title ?? null,
        productUrl: hasPatch("productUrl") ? patch.productUrl ?? null : current.product_url ?? null,
        confidence: hasPatch("confidence") ? patch.confidence ?? null : current.confidence ?? null,
        error: hasPatch("error") ? patch.error ?? null : current.error ?? null,
        rawJson: hasPatch("result") ? (patch.result ? JSON.stringify(patch.result) : null) : current.raw_json ?? null,
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

  listLearnedEndpoints(manufacturerId: ManufacturerId, limit = 20): LearnedEndpointRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM learned_endpoints
          WHERE manufacturer_id = ?
          ORDER BY success_count DESC, last_success_at DESC
          LIMIT ?
        `
      )
      .all(manufacturerId, limit) as LearnedEndpointRow[];
    return rows.map(mapLearnedEndpoint);
  }

  upsertLearnedEndpoint(endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
          INSERT INTO learned_endpoints (
            manufacturer_id,
            host,
            method,
            url_template,
            body_template,
            headers_json,
            discovered_from_url,
            parser_kind,
            success_count,
            last_success_at
          )
          VALUES (
            @manufacturerId,
            @host,
            @method,
            @urlTemplate,
            @bodyTemplate,
            @headersJson,
            @discoveredFromUrl,
            @parserKind,
            1,
            @now
          )
          ON CONFLICT(manufacturer_id, method, url_template) DO UPDATE SET
            host = excluded.host,
            body_template = excluded.body_template,
            headers_json = excluded.headers_json,
            discovered_from_url = excluded.discovered_from_url,
            parser_kind = excluded.parser_kind,
            success_count = learned_endpoints.success_count + 1,
            last_success_at = excluded.last_success_at
        `
      )
      .run({
        ...endpoint,
        headersJson: endpoint.headers ? JSON.stringify(endpoint.headers) : undefined,
        now
      });
  }

  /**
   * Returns the set of fields marked as definitively-unpublished for this catalog number,
   * based on prior runs that exhausted all available stages without finding them.
   */
  listExhaustedFields(manufacturerId: ManufacturerId, catalogNumber: string): Set<string> {
    const rows = this.db
      .prepare(`SELECT field FROM exhausted_fields WHERE manufacturer_id = ? AND catalog_number = ?`)
      .all(manufacturerId, catalogNumber) as Array<{ field: string }>;
    return new Set(rows.map((row) => row.field));
  }

  markFieldExhausted(manufacturerId: ManufacturerId, catalogNumber: string, field: string, reason?: string) {
    this.db
      .prepare(
        `
          INSERT INTO exhausted_fields (manufacturer_id, catalog_number, field, reason, marked_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(manufacturer_id, catalog_number, field) DO UPDATE SET
            reason = excluded.reason,
            marked_at = excluded.marked_at
        `
      )
      .run(manufacturerId, catalogNumber, field, reason ?? null, new Date().toISOString());
  }

  clearExhaustedFields(manufacturerId: ManufacturerId, catalogNumber?: string) {
    if (catalogNumber) {
      this.db.prepare(`DELETE FROM exhausted_fields WHERE manufacturer_id = ? AND catalog_number = ?`).run(manufacturerId, catalogNumber);
    } else {
      this.db.prepare(`DELETE FROM exhausted_fields WHERE manufacturer_id = ?`).run(manufacturerId);
    }
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
    pdtPath: row.pdt_path ?? undefined,
    activityStage: row.activity_stage ?? undefined,
    activityMessage: row.activity_message ?? undefined,
    activityStartedAt: row.activity_started_at ?? undefined,
    options: parseRunOptions(row.options_json),
    error: row.error
  };
}

function parseRunOptions(value: string | undefined): RunRecord["options"] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as RunRecord["options"];
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
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
    stage: row.stage ?? undefined,
    stageMessage: row.stage_message ?? undefined,
    stageStartedAt: row.stage_started_at ?? undefined,
    title: row.title ?? undefined,
    productUrl: row.product_url ?? undefined,
    confidence: row.confidence ?? undefined,
    error: row.error ?? undefined,
    result,
    updatedAt: row.updated_at
  };
}

function mapLearnedEndpoint(row: LearnedEndpointRow): LearnedEndpointRecord {
  return {
    id: row.id,
    manufacturerId: row.manufacturer_id,
    host: row.host,
    method: row.method,
    urlTemplate: row.url_template,
    bodyTemplate: row.body_template,
    headers: parseHeaders(row.headers_json),
    discoveredFromUrl: row.discovered_from_url,
    parserKind: row.parser_kind,
    successCount: row.success_count,
    lastSuccessAt: row.last_success_at
  };
}

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return undefined;
  }
}
