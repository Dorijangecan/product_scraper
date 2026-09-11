/**
 * The offline discovery replay harness, shared by every audit that asks a question about discovery.
 *
 * `data/scraper.db` holds the body of every page any run ever fetched — including search-result pages
 * and search-API responses — and `run_items` records which product URL each catalog number actually
 * resolved to. That is a replayable network and ground truth, both already on disk.
 *
 * This module owns the pieces that must be IDENTICAL across audits, because the moment two scripts
 * model the cache or the per-host interval slightly differently, their numbers stop being comparable
 * and both become unfalsifiable:
 *
 *   - `loadCache` / `cacheBackedHttp` — the replay network (a cache miss answers 404, exactly as a
 *     dead URL would; throwing would measure the stub instead of discovery).
 *   - `loadTargets` — the sample, spread across vendors so one huge vendor cannot dominate a score.
 *   - `inMemoryLearnedEndpointStore` — cross-item learning, without which every catalog number starts
 *     from zero knowledge and anything that learns is structurally invisible.
 *   - `perHostIntervalMs` — the cost model.
 *
 * Read-only: opens `data/scraper.db` with `readonly: true` and writes nothing.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import type { LearnedEndpointRecord } from "../src/shared/types.js";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dbPath = path.join(repoRoot, "data", "scraper.db");

export interface CacheEntry {
  path: string;
  statusCode: number | null;
  contentType: string | null;
  effectiveUrl: string | null;
}

export interface Target {
  manufacturerId: string;
  catalogNumber: string;
  productUrl: string;
}

export interface TargetSelection {
  limit: number;
  vendor?: string;
}

/**
 * An in-memory `learned_endpoints` store, so the replay models a REAL run.
 *
 * Without it every catalog number starts from zero knowledge, which measures the cold first item and
 * calls it the average — and it makes anything that learns across items (remembering the vendor's
 * working search key) structurally invisible. Ordering and suppression mirror `db.ts`
 * (`success_count DESC, last_success_at DESC`; failure resets on success), because that ordering is
 * what decides which endpoint is tried first.
 */
export function inMemoryLearnedEndpointStore() {
  const records = new Map<string, LearnedEndpointRecord>();
  let tick = 0;
  return {
    list: (manufacturerId: string, limit = 20): LearnedEndpointRecord[] =>
      [...records.values()]
        .filter((record) => record.manufacturerId === manufacturerId)
        .sort((left, right) => right.successCount - left.successCount || right.lastSuccessAt.localeCompare(left.lastSuccessAt))
        .slice(0, limit),
    upsert: (endpoint: Omit<LearnedEndpointRecord, "id" | "successCount" | "lastSuccessAt">): void => {
      const key = `${endpoint.manufacturerId}\n${endpoint.method}\n${endpoint.urlTemplate}`;
      const existing = records.get(key);
      // Monotonic counter instead of a clock: the replay must be deterministic run to run.
      tick += 1;
      records.set(key, {
        ...endpoint,
        successCount: (existing?.successCount ?? 0) + 1,
        lastSuccessAt: new Date(tick * 1000).toISOString(),
        failureCount: 0,
        lastFailureAt: undefined
      });
    },
    recordFailure: (manufacturerId: string, method: "GET" | "POST", urlTemplate: string): void => {
      const record = records.get(`${manufacturerId}\n${method}\n${urlTemplate}`);
      if (!record) return;
      tick += 1;
      record.failureCount = (record.failureCount ?? 0) + 1;
      record.lastFailureAt = new Date(tick * 1000).toISOString();
    },
    size: (): number => records.size
  };
}

export function normalizeKey(url: string): string {
  return url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

export function loadCache(db: Database.Database): Map<string, CacheEntry> {
  const cache = new Map<string, CacheEntry>();
  const rows = db
    .prepare("SELECT url, path, status_code AS statusCode, content_type AS contentType, effective_url AS effectiveUrl FROM page_cache")
    .all() as Array<CacheEntry & { url: string }>;
  for (const row of rows) {
    const entry: CacheEntry = {
      path: row.path,
      statusCode: row.statusCode,
      contentType: row.contentType,
      effectiveUrl: row.effectiveUrl
    };
    cache.set(normalizeKey(row.url), entry);
    if (row.effectiveUrl) cache.set(normalizeKey(row.effectiveUrl), entry);
  }
  return cache;
}

export function loadTargets(db: Database.Database, selection: TargetSelection): Target[] {
  const rows = db
    .prepare(
      `SELECT r.manufacturer_id AS manufacturerId, i.catalog_number AS catalogNumber, i.product_url AS productUrl
         FROM run_items i JOIN runs r ON r.id = i.run_id
        WHERE i.status = 'found' AND i.product_url IS NOT NULL
        GROUP BY r.manufacturer_id, i.catalog_number
        ORDER BY r.manufacturer_id, i.catalog_number`
    )
    .all() as Target[];
  const filtered = selection.vendor ? rows.filter((row) => row.manufacturerId === selection.vendor) : rows;

  // Spread across vendors so one huge vendor (sce has 1600 items) cannot dominate the score.
  const byVendor = new Map<string, Target[]>();
  for (const row of filtered) {
    const list = byVendor.get(row.manufacturerId) ?? [];
    list.push(row);
    byVendor.set(row.manufacturerId, list);
  }
  const lists = [...byVendor.values()];
  const spread: Target[] = [];
  for (let index = 0; spread.length < selection.limit; index += 1) {
    let added = false;
    for (const list of lists) {
      if (index >= list.length) continue;
      spread.push(list[index]);
      added = true;
      if (spread.length >= selection.limit) break;
    }
    if (!added) break;
  }
  return spread;
}

/**
 * What one request costs this vendor at runtime, in ms of pure waiting.
 * Mirrors run-manager's host slot wiring: `max(100, floor(rateLimitMs / concurrency))`.
 */
export function perHostIntervalMs(manufacturerId: string): number {
  const manufacturer = getManufacturerConfig(manufacturerId);
  if (!manufacturer) return 500;
  const rateLimitMs = manufacturer.rateLimitMs ?? 1500;
  const concurrency = Math.max(1, manufacturer.concurrency ?? 3);
  return Math.max(100, Math.floor(rateLimitMs / concurrency));
}

export interface FetchStats {
  hits: number;
  misses: number;
  /** Requests attributed to the discovery call currently under measurement. */
  current: number;
  counting: boolean;
}

/** An http client that can only answer from the cache — the point is that nothing hits the network. */
export function cacheBackedHttp(cache: Map<string, CacheEntry>, stats: FetchStats) {
  return {
    fetchText: async (url: string): Promise<FetchedText> => {
      if (stats.counting) stats.current += 1;
      const entry = cache.get(normalizeKey(url));
      if (!entry) {
        stats.misses += 1;
        // Mirror a real 404 rather than throwing: discovery must handle a dead URL, and throwing here
        // would measure our stub's behaviour instead of discovery's.
        return {
          requestedUrl: url,
          effectiveUrl: url,
          statusCode: 404,
          contentType: "text/html",
          text: "",
          fetchedAt: new Date(0).toISOString(),
          fromCache: false
        };
      }
      stats.hits += 1;
      const absolute = path.isAbsolute(entry.path) ? entry.path : path.join(repoRoot, entry.path);
      let text = "";
      try {
        text = await fs.readFile(absolute, "utf8");
      } catch {
        text = "";
      }
      return {
        requestedUrl: url,
        effectiveUrl: entry.effectiveUrl ?? url,
        statusCode: entry.statusCode ?? 200,
        contentType: entry.contentType ?? "text/html",
        text,
        fetchedAt: new Date(0).toISOString(),
        fromCache: true
      };
    }
  };
}

export function quantile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function percentOf(value: number, total: number): string {
  return total ? `${((value / total) * 100).toFixed(1)}%` : "n/a";
}

export function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export function padLeft(value: string, width: number): string {
  return value.length >= width ? value : `${" ".repeat(width - value.length)}${value}`;
}
