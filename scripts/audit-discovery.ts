/**
 * Does discovery still find the right product page — and what does it COST to find it?
 *
 * Discovery was the one part of this work with no real-material evidence: `benchmarks/` needs live
 * sites, and the offline corpus had no recorded search pages. But `data/scraper.db` holds the body of
 * every page any run ever fetched — including ~3900 search-result pages and search-API responses — and
 * `run_items` records which product URL each catalog number actually resolved to. That is ground truth
 * and a replayable network, both already on disk.
 *
 * So: replay `discoverOfficialProductCandidates` against the cache and ask whether the known-correct
 * PDP comes back, at what rank, and after how many network requests. Rank matters as much as presence
 * — the deterministic pipeline only fetches the top `maxCandidates`, so a correct URL ranked 11th is
 * nearly as useless as a missing one. Request COUNT matters just as much for wall time: every request
 * a vendor's host serializes behind `max(100, rateLimitMs / concurrency)` ms, so 18 blind search
 * probes cost `gan` 54 s of pure waiting before a single byte is parsed.
 *
 * Reading the numbers:
 *   - `hit@1` / `hit@3` / `hit` — how often the known PDP is the first / top-3 / any candidate.
 *   - `no candidates` — discovery produced nothing at all.
 *   - `requests` — how many URLs discovery fetched for ONE catalog number (offline; a cache miss is
 *     answered as a 404 exactly as a dead URL would be, so the count is what a live run would pay).
 *   - `throttle` — MODELLED, not measured: `requests x perHostInterval(vendor)`. It is the floor of
 *     what a live run waits for that vendor, excluding response latency. Cache hits are free at
 *     runtime (`fetchText` returns before `acquireHostSlot`), so this is a cold-cache figure.
 *   - `won by` — which discovery stage produced the first confirmed candidate. A vendor whose hits
 *     all come from `direct-template` should never have paid for the search stage at all.
 *   - Absolute hit values are a LOWER BOUND: a catalog whose search page was never cached cannot be
 *     re-discovered offline. Use this to compare BEFORE vs AFTER a change, not as a live success rate.
 *
 * Usage:
 *   npx tsx scripts/audit-discovery.ts --limit 120
 *   npx tsx scripts/audit-discovery.ts --vendor schmersal --limit 40
 *   npx tsx scripts/audit-discovery.ts --limit 120 --json before.json
 *   npx tsx scripts/audit-discovery.ts --limit 120 --json after.json --compare before.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { discoverOfficialProductCandidates, scoreFetchedDiscoveryEvidence } from "../src/server/scrapers/discovery.js";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import type { LearnedEndpointRecord } from "../src/shared/types.js";
import { sameNormalizedUrl } from "../src/server/url-util.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(repoRoot, "data", "scraper.db");

interface CacheEntry {
  path: string;
  statusCode: number | null;
  contentType: string | null;
  effectiveUrl: string | null;
}

interface Target {
  manufacturerId: string;
  catalogNumber: string;
  productUrl: string;
}

interface Options {
  limit: number;
  vendor?: string;
  jsonPath?: string;
  comparePath?: string;
  learning: boolean;
}

/**
 * An in-memory `learned_endpoints` store, so the replay models a REAL run.
 *
 * Without it every catalog number starts from zero knowledge, which measures the cold first item and
 * calls it the average — and it makes anything that learns across items (D4: remembering the vendor's
 * working search key) structurally invisible. Ordering and suppression mirror `db.ts`
 * (`success_count DESC, last_success_at DESC`; failure resets on success), because that ordering is
 * what decides which endpoint is tried first.
 */
function inMemoryLearnedEndpointStore() {
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

function printUsage(): void {
  console.log([
    "Usage: npx tsx scripts/audit-discovery.ts [--vendor <manufacturer-id>] [--limit <n>] [--json <report-path>] [--compare <baseline.json>]",
    "",
    "Read-only offline discovery replay over cached product pages.",
    "Reports hit-rate AND cost (requests per catalog number, modelled throttle wait, winning stage)."
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: 100, learning: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--limit") options.limit = Number(argv[++index]) || options.limit;
    else if (argv[index] === "--vendor") options.vendor = argv[++index];
    else if (argv[index] === "--json") options.jsonPath = path.resolve(argv[++index] ?? "discovery-report.json");
    else if (argv[index] === "--compare") options.comparePath = path.resolve(argv[++index] ?? "discovery-baseline.json");
    else if (argv[index] === "--no-learning") options.learning = false;
  }
  return options;
}

function normalizeKey(url: string): string {
  return url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

function loadCache(db: Database.Database): Map<string, CacheEntry> {
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

function loadTargets(db: Database.Database, options: Options): Target[] {
  const rows = db
    .prepare(
      `SELECT r.manufacturer_id AS manufacturerId, i.catalog_number AS catalogNumber, i.product_url AS productUrl
         FROM run_items i JOIN runs r ON r.id = i.run_id
        WHERE i.status = 'found' AND i.product_url IS NOT NULL
        GROUP BY r.manufacturer_id, i.catalog_number
        ORDER BY r.manufacturer_id, i.catalog_number`
    )
    .all() as Target[];
  const filtered = options.vendor ? rows.filter((row) => row.manufacturerId === options.vendor) : rows;

  // Spread across vendors so one huge vendor (sce has 1600 items) cannot dominate the score.
  const byVendor = new Map<string, Target[]>();
  for (const row of filtered) {
    const list = byVendor.get(row.manufacturerId) ?? [];
    list.push(row);
    byVendor.set(row.manufacturerId, list);
  }
  const lists = [...byVendor.values()];
  const spread: Target[] = [];
  for (let index = 0; spread.length < options.limit; index += 1) {
    let added = false;
    for (const list of lists) {
      if (index >= list.length) continue;
      spread.push(list[index]);
      added = true;
      if (spread.length >= options.limit) break;
    }
    if (!added) break;
  }
  return spread;
}

/**
 * What one request costs this vendor at runtime, in ms of pure waiting.
 * Mirrors run-manager's host slot wiring: `max(100, floor(rateLimitMs / concurrency))`.
 */
function perHostIntervalMs(manufacturerId: string): number {
  const manufacturer = getManufacturerConfig(manufacturerId);
  if (!manufacturer) return 500;
  const rateLimitMs = manufacturer.rateLimitMs ?? 1500;
  const concurrency = Math.max(1, manufacturer.concurrency ?? 3);
  return Math.max(100, Math.floor(rateLimitMs / concurrency));
}

interface FetchStats {
  hits: number;
  misses: number;
  /** Requests attributed to the discovery call currently under measurement. */
  current: number;
  counting: boolean;
}

/** An http client that can only answer from the cache — the point is that nothing hits the network. */
function cacheBackedHttp(cache: Map<string, CacheEntry>, stats: FetchStats) {
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

interface Outcome {
  target: Target;
  rank?: number;
  rankReason?: "recorded-url" | "redirected-url" | "fetched-identity";
  /** Discovery stage that produced the first confirmed candidate — where the answer actually came from. */
  wonByStage?: string;
  candidateCount: number;
  /** Network requests discovery itself issued for this one catalog number. */
  requests: number;
  /** Modelled cold-cache throttle wait for those requests, in ms. */
  throttleMs: number;
  /** Wall time of the offline replay (parsing cost only — no network). */
  parseMs: number;
  topUrl?: string;
  error?: string;
}

function quantile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function percentOf(value: number, total: number): string {
  return total ? `${((value / total) * 100).toFixed(1)}%` : "n/a";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : `${" ".repeat(width - value.length)}${value}`;
}

interface VendorSummary {
  vendor: string;
  measured: number;
  hitAt1: number;
  hit: number;
  medianRequests: number;
  p95Requests: number;
  intervalMs: number;
  medianThrottleMs: number;
  p95ThrottleMs: number;
  stages: Record<string, number>;
}

function summarizeByVendor(measured: Outcome[]): VendorSummary[] {
  const byVendor = new Map<string, Outcome[]>();
  for (const outcome of measured) {
    const list = byVendor.get(outcome.target.manufacturerId) ?? [];
    list.push(outcome);
    byVendor.set(outcome.target.manufacturerId, list);
  }
  const summaries: VendorSummary[] = [];
  for (const [vendor, list] of byVendor) {
    const requests = list.map((outcome) => outcome.requests);
    const throttles = list.map((outcome) => outcome.throttleMs);
    const stages: Record<string, number> = {};
    for (const outcome of list) {
      if (!outcome.wonByStage) continue;
      stages[outcome.wonByStage] = (stages[outcome.wonByStage] ?? 0) + 1;
    }
    summaries.push({
      vendor,
      measured: list.length,
      hitAt1: list.filter((outcome) => outcome.rank === 1).length,
      hit: list.filter((outcome) => outcome.rank !== undefined).length,
      medianRequests: quantile(requests, 0.5),
      p95Requests: quantile(requests, 0.95),
      intervalMs: perHostIntervalMs(vendor),
      medianThrottleMs: quantile(throttles, 0.5),
      p95ThrottleMs: quantile(throttles, 0.95),
      stages
    });
  }
  // Slowest first: the point of this table is to name who needs work, not to list alphabetically.
  return summaries.sort((left, right) => right.medianThrottleMs - left.medianThrottleMs);
}

function dominantStage(stages: Record<string, number>): string {
  const entries = Object.entries(stages).sort((left, right) => right[1] - left[1]);
  if (!entries.length) return "-";
  return `${entries[0][0]} ${entries[0][1]}/${entries.reduce((total, entry) => total + entry[1], 0)}`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(dbPath, { readonly: true });
  let cache: Map<string, CacheEntry>;
  let targets: Target[];
  try {
    cache = loadCache(db);
    targets = loadTargets(db, options);
  } finally {
    db.close();
  }

  console.log(`Replaying discovery for ${targets.length} known-good catalog numbers against ${cache.size} cached URLs.\n`);

  const stats: FetchStats = { hits: 0, misses: 0, current: 0, counting: false };
  const http = cacheBackedHttp(cache, stats);
  const learnedStore = inMemoryLearnedEndpointStore();
  const outcomes: Outcome[] = [];

  for (const target of targets) {
    const manufacturer = getManufacturerConfig(target.manufacturerId);
    if (!manufacturer) continue;
    stats.current = 0;
    stats.counting = true;
    const startedAt = performance.now();
    try {
      const discovery = await discoverOfficialProductCandidates(target.catalogNumber, {
        manufacturer,
        http,
        learnedEndpoints: options.learning ? learnedStore : { list: () => [], upsert: () => undefined }
      } as never);
      // Stop counting BEFORE the confirmation fetches below: those are the audit's own ground-truth
      // check, not work the runtime pays for. Counting them would inflate every vendor equally and
      // hide the difference the audit exists to show.
      stats.counting = false;
      const requests = stats.current;
      const parseMs = performance.now() - startedAt;

      // A historical run URL is useful ground truth, but it is not immutable canonical identity:
      // ABB's official Smartlink, for example, redirects to the current global PDP while the old
      // run stored a Polish legacy path. The runtime fetches and validates the candidate page after
      // discovery, so the offline replay must use that same post-fetch evidence before calling it a
      // miss. A cache miss remains a miss here; this never turns a URL-shaped guess into a hit.
      const confirmations = await Promise.all(
        discovery.candidates.map(async (candidate) => {
          if (sameNormalizedUrl(candidate.url, target.productUrl)) return "recorded-url" as const;
          const fetched = await http.fetchText(candidate.url);
          if (sameNormalizedUrl(fetched.effectiveUrl, target.productUrl)) return "redirected-url" as const;
          return scoreFetchedDiscoveryEvidence(fetched, target.catalogNumber).catalogConfirmed ? "fetched-identity" as const : undefined;
        })
      );
      const index = confirmations.findIndex(Boolean);
      outcomes.push({
        target,
        rank: index >= 0 ? index + 1 : undefined,
        rankReason: index >= 0 ? confirmations[index] : undefined,
        wonByStage: index >= 0 ? discovery.candidates[index]?.stage : undefined,
        candidateCount: discovery.candidates.length,
        requests,
        throttleMs: requests * perHostIntervalMs(target.manufacturerId),
        parseMs,
        topUrl: discovery.candidates[0]?.url
      });
      process.stdout.write(index === 0 ? "1" : index > 0 ? "+" : discovery.candidates.length ? "." : "0");
    } catch (error) {
      stats.counting = false;
      outcomes.push({
        target,
        candidateCount: 0,
        requests: stats.current,
        throttleMs: stats.current * perHostIntervalMs(target.manufacturerId),
        parseMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      process.stdout.write("x");
    }
  }
  process.stdout.write("\n\n");

  const measured = outcomes.filter((outcome) => !outcome.error);
  const hitAt1 = measured.filter((outcome) => outcome.rank === 1).length;
  const hitAt3 = measured.filter((outcome) => outcome.rank !== undefined && outcome.rank <= 3).length;
  const hit = measured.filter((outcome) => outcome.rank !== undefined).length;
  const noCandidates = measured.filter((outcome) => outcome.candidateCount === 0).length;
  const percent = (value: number): string => percentOf(value, measured.length);

  console.log("=== Discovery replay over cached pages ===");
  console.log(`catalog numbers measured  ${measured.length} (${outcomes.length - measured.length} errored)`);
  console.log(`cache hits / misses       ${stats.hits} / ${stats.misses}`);
  const identityConfirmed = measured.filter((outcome) => outcome.rankReason === "fetched-identity").length;
  const redirected = measured.filter((outcome) => outcome.rankReason === "redirected-url").length;
  console.log(`known/confirmed PDP #1    ${hitAt1}  (${percent(hitAt1)})`);
  console.log(`known/confirmed top 3     ${hitAt3}  (${percent(hitAt3)})`);
  console.log(`known/confirmed found     ${hit}  (${percent(hit)})`);
  console.log(`  via fetched identity    ${identityConfirmed}`);
  console.log(`  via recorded redirect   ${redirected}`);
  console.log(`no candidates at all      ${noCandidates}  (${percent(noCandidates)})`);

  const allRequests = measured.map((outcome) => outcome.requests);
  const allThrottles = measured.map((outcome) => outcome.throttleMs);
  console.log("\n=== Cost per catalog number ===");
  console.log(`requests   median ${quantile(allRequests, 0.5)}   p95 ${quantile(allRequests, 0.95)}   total ${allRequests.reduce((total, value) => total + value, 0)}`);
  console.log(
    `throttle   median ${(quantile(allThrottles, 0.5) / 1000).toFixed(1)}s   p95 ${(quantile(allThrottles, 0.95) / 1000).toFixed(1)}s   (modelled: requests x per-host interval, cold cache)`
  );

  const stageTotals: Record<string, number> = {};
  for (const outcome of measured) {
    if (!outcome.wonByStage) continue;
    stageTotals[outcome.wonByStage] = (stageTotals[outcome.wonByStage] ?? 0) + 1;
  }
  console.log("\n=== Which stage actually produced the answer ===");
  for (const [stage, count] of Object.entries(stageTotals).sort((left, right) => right[1] - left[1])) {
    console.log(`  ${pad(stage, 20)} ${padLeft(String(count), 4)}  (${percentOf(count, hit)} of hits)`);
  }

  const vendorSummaries = summarizeByVendor(measured);
  console.log("\n=== Per manufacturer (slowest first) ===");
  console.log(
    `  ${pad("vendor", 12)} ${padLeft("n", 4)} ${padLeft("hit@1", 7)} ${padLeft("hit", 7)} ${padLeft("req med", 8)} ${padLeft("req p95", 8)} ${padLeft("ms/req", 7)} ${padLeft("wait med", 9)} ${padLeft("wait p95", 9)}  won by`
  );
  for (const summary of vendorSummaries) {
    console.log(
      `  ${pad(summary.vendor, 12)} ${padLeft(String(summary.measured), 4)} ${padLeft(percentOf(summary.hitAt1, summary.measured), 7)} ${padLeft(percentOf(summary.hit, summary.measured), 7)} ${padLeft(String(summary.medianRequests), 8)} ${padLeft(String(summary.p95Requests), 8)} ${padLeft(String(summary.intervalMs), 7)} ${padLeft(`${(summary.medianThrottleMs / 1000).toFixed(1)}s`, 9)} ${padLeft(`${(summary.p95ThrottleMs / 1000).toFixed(1)}s`, 9)}  ${dominantStage(summary.stages)}`
    );
  }

  const missed = measured.filter((outcome) => outcome.rank === undefined && outcome.candidateCount > 0).slice(0, 10);
  if (missed.length) {
    console.log("\n--- Candidates produced, but the known PDP was not among them ---");
    for (const outcome of missed) {
      console.log(`  ${outcome.target.manufacturerId}/${outcome.target.catalogNumber}`);
      console.log(`      want ${outcome.target.productUrl}`);
      console.log(`      top  ${outcome.topUrl ?? "(none)"}`);
    }
  }

  const report = {
    summary: {
      measured: measured.length,
      hitAt1,
      hitAt3,
      hit,
      noCandidates,
      medianRequests: quantile(allRequests, 0.5),
      p95Requests: quantile(allRequests, 0.95),
      totalRequests: allRequests.reduce((total, value) => total + value, 0),
      medianThrottleMs: quantile(allThrottles, 0.5),
      p95ThrottleMs: quantile(allThrottles, 0.95)
    },
    stageTotals,
    vendors: vendorSummaries,
    outcomes
  };

  if (options.comparePath) {
    try {
      const baseline = JSON.parse(await fs.readFile(options.comparePath, "utf8")) as typeof report;
      console.log(`\n=== Compared with ${path.relative(repoRoot, options.comparePath)} ===`);
      const delta = (label: string, before: number, after: number, unit = ""): void => {
        const sign = after > before ? "+" : "";
        console.log(`  ${pad(label, 22)} ${padLeft(`${before}${unit}`, 10)} -> ${padLeft(`${after}${unit}`, 10)}   ${sign}${(after - before).toFixed(unit === "%" ? 1 : 0)}${unit}`);
      };
      const rate = (value: number, total: number): number => (total ? Number(((value / total) * 100).toFixed(1)) : 0);
      delta("hit@1", rate(baseline.summary.hitAt1, baseline.summary.measured), rate(hitAt1, measured.length), "%");
      delta("hit", rate(baseline.summary.hit, baseline.summary.measured), rate(hit, measured.length), "%");
      delta("requests (median)", baseline.summary.medianRequests, quantile(allRequests, 0.5));
      delta("requests (total)", baseline.summary.totalRequests, report.summary.totalRequests);
      delta("throttle p95 (ms)", baseline.summary.p95ThrottleMs, quantile(allThrottles, 0.95));
      // A speed-up that costs hit-rate is a regression, not an optimisation — say so out loud.
      if (rate(hit, measured.length) < rate(baseline.summary.hit, baseline.summary.measured)) {
        console.log("\n  !! hit-rate DROPPED. This is a regression regardless of the request count.");
      }
    } catch (error) {
      console.log(`\n(could not read baseline ${options.comparePath}: ${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (options.jsonPath) {
    await fs.writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nJSON report: ${path.relative(repoRoot, options.jsonPath)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
