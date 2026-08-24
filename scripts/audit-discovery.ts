/**
 * Does discovery still find the right product page? Measured offline, against real cached pages.
 *
 * Discovery was the one part of this work with no real-material evidence: `benchmarks/` needs live
 * sites, and the offline corpus had no recorded search pages. But `data/scraper.db` holds the body of
 * every page any run ever fetched — including ~3900 search-result pages and search-API responses — and
 * `run_items` records which product URL each catalog number actually resolved to. That is ground truth
 * and a replayable network, both already on disk.
 *
 * So: replay `discoverOfficialProductCandidates` against the cache and ask whether the known-correct
 * PDP comes back, and at what rank. Rank matters as much as presence — the deterministic pipeline only
 * fetches the top `maxCandidates`, so a correct URL ranked 11th is nearly as useless as a missing one.
 *
 * Reading the numbers:
 *   - `hit@1` / `hit@3` / `hit` — how often the known PDP is the first / top-3 / any candidate.
 *   - `no candidates` — discovery produced nothing at all.
 *   - Absolute values are a LOWER BOUND: a catalog whose search page was never cached cannot be
 *     re-discovered offline. Use this to compare BEFORE vs AFTER a change, not as a live success rate.
 *
 * Usage:
 *   npx tsx scripts/audit-discovery.ts --limit 120
 *   npx tsx scripts/audit-discovery.ts --vendor schmersal --limit 40
 *   npx tsx scripts/audit-discovery.ts --limit 120 --json before.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { discoverOfficialProductCandidates, scoreFetchedDiscoveryEvidence } from "../src/server/scrapers/discovery.js";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
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
}

function printUsage(): void {
  console.log([
    "Usage: npx tsx scripts/audit-discovery.ts [--vendor <manufacturer-id>] [--limit <n>] [--json <report-path>]",
    "",
    "Read-only offline discovery replay over cached product pages."
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--limit") options.limit = Number(argv[++index]) || options.limit;
    else if (argv[index] === "--vendor") options.vendor = argv[++index];
    else if (argv[index] === "--json") options.jsonPath = path.resolve(argv[++index] ?? "discovery-report.json");
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

/** An http client that can only answer from the cache — the point is that nothing hits the network. */
function cacheBackedHttp(cache: Map<string, CacheEntry>, stats: { hits: number; misses: number }) {
  return {
    fetchText: async (url: string): Promise<FetchedText> => {
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
      stats.hits += 1
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
  candidateCount: number;
  topUrl?: string;
  error?: string;
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

  const stats = { hits: 0, misses: 0 };
  const http = cacheBackedHttp(cache, stats);
  const outcomes: Outcome[] = [];

  for (const target of targets) {
    const manufacturer = getManufacturerConfig(target.manufacturerId);
    if (!manufacturer) continue;
    try {
      const discovery = await discoverOfficialProductCandidates(target.catalogNumber, {
        manufacturer,
        http,
        learnedEndpoints: { list: () => [], upsert: () => undefined }
      } as never);

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
        candidateCount: discovery.candidates.length,
        topUrl: discovery.candidates[0]?.url
      });
      process.stdout.write(index === 0 ? "1" : index > 0 ? "+" : discovery.candidates.length ? "." : "0");
    } catch (error) {
      outcomes.push({ target, candidateCount: 0, error: error instanceof Error ? error.message : String(error) });
      process.stdout.write("x");
    }
  }
  process.stdout.write("\n\n");

  const measured = outcomes.filter((outcome) => !outcome.error);
  const hitAt1 = measured.filter((outcome) => outcome.rank === 1).length;
  const hitAt3 = measured.filter((outcome) => outcome.rank !== undefined && outcome.rank <= 3).length;
  const hit = measured.filter((outcome) => outcome.rank !== undefined).length;
  const noCandidates = measured.filter((outcome) => outcome.candidateCount === 0).length;
  const percent = (value: number): string => (measured.length ? `${((value / measured.length) * 100).toFixed(1)}%` : "n/a");

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

  const missed = measured.filter((outcome) => outcome.rank === undefined && outcome.candidateCount > 0).slice(0, 10);
  if (missed.length) {
    console.log("\n--- Candidates produced, but the known PDP was not among them ---");
    for (const outcome of missed) {
      console.log(`  ${outcome.target.manufacturerId}/${outcome.target.catalogNumber}`);
      console.log(`      want ${outcome.target.productUrl}`);
      console.log(`      top  ${outcome.topUrl ?? "(none)"}`);
    }
  }

  if (options.jsonPath) {
    await fs.writeFile(
      options.jsonPath,
      `${JSON.stringify({ summary: { measured: measured.length, hitAt1, hitAt3, hit, noCandidates }, outcomes }, null, 2)}\n`,
      "utf8"
    );
    console.log(`\nJSON report: ${path.relative(repoRoot, options.jsonPath)}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
