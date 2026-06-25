import Database from "better-sqlite3";
import type {
  ItemStatus,
  LearnedExtractorRecord,
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

interface StageObservationInput {
  manufacturerId: ManufacturerId;
  host?: string;
  stage: string;
  status: "passed" | "partial" | "failed" | "skipped";
  qualityScore?: number;
  attributeCount?: number;
  documentCount?: number;
  elapsedMs?: number;
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

interface LearnedExtractorRow {
  id: number;
  manufacturer_id: ManufacturerId;
  host: string;
  kind: LearnedExtractorRecord["kind"];
  pattern: string;
  source_url: string;
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

      CREATE TABLE IF NOT EXISTS stage_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manufacturer_id TEXT NOT NULL,
        host TEXT,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        quality_score REAL,
        attribute_count INTEGER,
        document_count INTEGER,
        elapsed_ms INTEGER,
        error TEXT,
        observed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS target_health (
        manufacturer_id TEXT NOT NULL,
        host TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT '',
        sample_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        quality_score_sum REAL NOT NULL DEFAULT 0,
        attribute_count_sum INTEGER NOT NULL DEFAULT 0,
        document_count_sum INTEGER NOT NULL DEFAULT 0,
        last_observed_at TEXT NOT NULL,
        PRIMARY KEY (manufacturer_id, host, stage)
      );

      CREATE TABLE IF NOT EXISTS learned_extractors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manufacturer_id TEXT NOT NULL,
        host TEXT NOT NULL,
        kind TEXT NOT NULL,
        pattern TEXT NOT NULL,
        source_url TEXT NOT NULL,
        parser_kind TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 1,
        last_success_at TEXT NOT NULL,
        UNIQUE(manufacturer_id, host, kind, pattern)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_run_items_run_id ON run_items(run_id, row_index);
      CREATE INDEX IF NOT EXISTS idx_page_cache_url ON page_cache(url);
      CREATE INDEX IF NOT EXISTS idx_learned_endpoints_manufacturer ON learned_endpoints(manufacturer_id, success_count DESC, last_success_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stage_observations_target ON stage_observations(manufacturer_id, host, stage, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_learned_extractors_target ON learned_extractors(manufacturer_id, host, success_count DESC, last_success_at DESC);
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

  pauseActiveRunItems(runId: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE run_items SET status = 'pending', stage = 'paused', stage_message = 'Paused by user. Resume this run to continue.', stage_started_at = ?, error = NULL, updated_at = ? WHERE run_id = ? AND status = 'processing'"
      )
      .run(now, now, runId);
  }

  isCancellationRequested(runId: string): boolean {
    const row = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: RunStatus } | undefined;
    return row?.status === "cancelling" || row?.status === "cancelled";
  }

  isPauseRequested(runId: string): boolean {
    const row = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: RunStatus } | undefined;
    return row?.status === "pausing" || row?.status === "paused";
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

  recordStageObservation(observation: StageObservationInput) {
    const now = new Date().toISOString();
    const host = observation.host ?? "";
    const status = observation.status;
    const qualityScore = observation.qualityScore ?? 0;
    const attributeCount = observation.attributeCount ?? 0;
    const documentCount = observation.documentCount ?? 0;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO stage_observations (
              manufacturer_id,
              host,
              stage,
              status,
              quality_score,
              attribute_count,
              document_count,
              elapsed_ms,
              error,
              observed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          observation.manufacturerId,
          host || null,
          observation.stage,
          status,
          observation.qualityScore ?? null,
          observation.attributeCount ?? null,
          observation.documentCount ?? null,
          observation.elapsedMs ?? null,
          observation.error ?? null,
          now
        );
      this.db
        .prepare(
          `
            INSERT INTO target_health (
              manufacturer_id,
              host,
              stage,
              sample_count,
              success_count,
              quality_score_sum,
              attribute_count_sum,
              document_count_sum,
              last_observed_at
            )
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
            ON CONFLICT(manufacturer_id, host, stage) DO UPDATE SET
              sample_count = target_health.sample_count + 1,
              success_count = target_health.success_count + excluded.success_count,
              quality_score_sum = target_health.quality_score_sum + excluded.quality_score_sum,
              attribute_count_sum = target_health.attribute_count_sum + excluded.attribute_count_sum,
              document_count_sum = target_health.document_count_sum + excluded.document_count_sum,
              last_observed_at = excluded.last_observed_at
          `
        )
        .run(
          observation.manufacturerId,
          host,
          observation.stage,
          status === "passed" ? 1 : 0,
          qualityScore,
          attributeCount,
          documentCount,
          now
        );
    });
    tx();
  }

  getTargetHealth(manufacturerId: ManufacturerId, stage?: string, host?: string) {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM target_health
          WHERE manufacturer_id = ?
            AND stage = ?
            AND host = ?
        `
      )
      .get(manufacturerId, stage ?? "", host ?? "") as
        | {
            manufacturer_id: ManufacturerId;
            host: string;
            stage: string;
            sample_count: number;
            success_count: number;
            quality_score_sum: number;
            attribute_count_sum: number;
            document_count_sum: number;
          }
        | undefined;
    if (!row) return undefined;
    const sampleCount = row.sample_count || 0;
    return {
      manufacturerId: row.manufacturer_id,
      host: row.host || undefined,
      stage: row.stage || undefined,
      sampleCount,
      successRate: sampleCount ? row.success_count / sampleCount : 0,
      avgQualityScore: sampleCount ? row.quality_score_sum / sampleCount : undefined,
      avgAttributeCount: sampleCount ? row.attribute_count_sum / sampleCount : undefined,
      avgDocumentCount: sampleCount ? row.document_count_sum / sampleCount : undefined,
      driftSuspected: sampleCount >= 8 && (row.success_count / sampleCount < 0.45 || row.quality_score_sum / sampleCount < 45),
      reason: sampleCount >= 8 && (row.success_count / sampleCount < 0.45 || row.quality_score_sum / sampleCount < 45)
        ? "Recent target health is below the adaptive mining threshold."
        : "Target health is within the normal range."
    };
  }

  listLearnedExtractors(manufacturerId: ManufacturerId, host: string, limit = 20): LearnedExtractorRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM learned_extractors
          WHERE manufacturer_id = ? AND host = ?
          ORDER BY success_count DESC, last_success_at DESC
          LIMIT ?
        `
      )
      .all(manufacturerId, host, limit) as LearnedExtractorRow[];
    return rows.map(mapLearnedExtractor);
  }

  upsertLearnedExtractor(extractor: Omit<LearnedExtractorRecord, "id" | "successCount" | "lastSuccessAt">) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
          INSERT INTO learned_extractors (
            manufacturer_id,
            host,
            kind,
            pattern,
            source_url,
            parser_kind,
            success_count,
            last_success_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(manufacturer_id, host, kind, pattern) DO UPDATE SET
            source_url = excluded.source_url,
            parser_kind = excluded.parser_kind,
            success_count = learned_extractors.success_count + 1,
            last_success_at = excluded.last_success_at
        `
      )
      .run(
        extractor.manufacturerId,
        extractor.host,
        extractor.kind,
        extractor.pattern,
        extractor.sourceUrl,
        extractor.parserKind,
        now
      );
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

function mapLearnedExtractor(row: LearnedExtractorRow): LearnedExtractorRecord {
  return {
    id: row.id,
    manufacturerId: row.manufacturer_id,
    host: row.host,
    kind: row.kind,
    pattern: row.pattern,
    sourceUrl: row.source_url,
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
