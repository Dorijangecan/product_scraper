/**
 * ABB accuracy + speed bench.
 *
 * Runs the REAL ABBConnector (same context shape the RunManager builds) over a list of catalog
 * numbers, and reports per item: wall time, status, confidence, which required fields came out,
 * and the full network trace (url, ms, status, cache hit). The network trace is the point —
 * ABB's slowness is dominated by URL guesses that hang, and you cannot see those from the
 * result alone.
 *
 *   "C:\Program Files\nodejs\node.exe" --import tsx scripts/bench-abb.ts [--cold] [--csv "Testing PDT/ABB test.csv"] [--limit N] [cat1 cat2 ...]
 *
 * --cold uses a throwaway data dir (fresh SQLite + page cache) so timings are true cold-start.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getManufacturerConfig, initializeManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { GenericFallbackScraper } from "../src/server/scrapers/generic.js";
import { CachedHttpClient } from "../src/server/scrapers/http-client.js";
import { getConnector } from "../src/server/scrapers/index.js";
import { BrowserRenderSession } from "../src/server/scrapers/browser-renderer.js";
import { finalizeQualityGate } from "../src/server/scrapers/quality-gate.js";
import type { ProductResult } from "../src/shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const cold = argv.includes("--cold");
const csvFlag = argv.indexOf("--csv");
const limitFlag = argv.indexOf("--limit");
const limit = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : Number.POSITIVE_INFINITY;
/** Flags that consume the next argv entry, so its value is never mistaken for a catalog number. */
const VALUE_FLAGS = new Set(["--csv", "--limit", "--concurrency"]);
const inlineCatalogs = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1] ?? ""));

function readCatalogs(): string[] {
  if (inlineCatalogs.length) return inlineCatalogs;
  const csvPath = path.resolve(rootDir, csvFlag >= 0 ? argv[csvFlag + 1] : path.join("Testing PDT", "ABB test.csv"));
  return fs
    .readFileSync(csvPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.split(/[;,]/)[0].trim())
    .filter((v) => v && !/^(catalog|artikel|part)/i.test(v));
}

const catalogs = readCatalogs().slice(0, limit);

const benchRoot = cold ? fs.mkdtempSync(path.join(os.tmpdir(), "abb-bench-")) : rootDir;
const appPaths = createAppPaths(benchRoot);
initializeManufacturerConfig(path.join(rootDir, "data"));
const manufacturerConfig = getManufacturerConfig("abb");
if (!manufacturerConfig) throw new Error("ABB manufacturer not configured");
const manufacturer = manufacturerConfig;

const db = new ScraperDb(appPaths);
const http = new CachedHttpClient(db, appPaths.cacheDir);
const browserRenderer = new BrowserRenderSession();
const fallback = new GenericFallbackScraper(manufacturer.id, http, manufacturer);
const connector = getConnector(manufacturer.id);

type Call = { url: string; ms: number; status: number; cached: boolean; kind: string; at: number };
/**
 * One global, timestamped timeline rather than a per-item array. With --concurrency the items
 * overlap, so "which item issued this request" cannot be tracked by a mutable current-item variable
 * without mis-attributing; a timeline plus each item's start/end window is both honest and more
 * useful for spotting rate-limit bursts.
 */
const timeline: Call[] = [];
function recordCall(call: Call) {
  timeline.push(call);
}
const verbose = argv.includes("--trace");
function trace(call: Call) {
  if (!verbose) return;
  process.stdout.write(
    `    ${String(call.ms).padStart(6)}ms ${String(call.status).padStart(4)} ${call.cached ? "CACHE" : "live "} ${call.kind.padEnd(10)} ${call.url}\n`
  );
}

function instrument(kind: string, fn: (...args: any[]) => Promise<any>) {
  return async (url: string, ...rest: any[]) => {
    const started = Date.now();
    try {
      const res = await fn.call(http, url, ...rest);
      const call = { url, ms: Date.now() - started, status: res?.statusCode ?? 0, cached: Boolean(res?.fromCache), kind, at: started };
      recordCall(call);
      trace(call);
      return res;
    } catch (error) {
      const call = { url, ms: Date.now() - started, status: -1, cached: false, kind: `${kind}:throw`, at: started };
      recordCall(call);
      trace(call);
      throw error;
    }
  };
}
(http as any).fetchText = instrument("fetchText", (http as any).fetchText);
if ((http as any).fetchTextViaPowerShell) {
  (http as any).fetchTextViaPowerShell = instrument("powershell", (http as any).fetchTextViaPowerShell);
}

/** Normalized fields the ABB catalogue can realistically publish for an electrical device. */
const REQUIRED = ["weight", "dimensions", "voltage", "current", "certificates"];

/** Identity/ordering data that lives in attributes, not in `normalized` — the PDT columns. */
const KEY_ATTRIBUTES: Array<[string, RegExp]> = [
  ["typeCode", /^(Extended Product Type|Display Name)$/i],
  ["ean", /^EAN$/i],
  ["eclass", /^eClass$/i],
  ["etim", /^Etim\d*$/i],
  ["netWeight", /^Product Net Weight$/i],
  ["netWidth", /^Product Net Width$/i],
  ["netHeight", /^Product Net Height$/i],
  ["netDepth", /^Product Net Depth/i],
  ["customsTariff", /^Customs Tariff Number$/i],
  ["countryOfOrigin", /^Country of Origin$/i]
];

function fieldSnapshot(result: ProductResult): Record<string, string> {
  const out: Record<string, string> = {};
  const normalized = (result.normalized ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(normalized)) {
    const value = normalized[key];
    if (value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return out;
}

const concurrencyFlag = argv.indexOf("--concurrency");
const concurrency = concurrencyFlag >= 0 ? Math.max(1, Number(argv[concurrencyFlag + 1])) : 1;

const rows: any[] = [];
const totalStarted = Date.now();

async function benchOne(catalogNumber: string) {
  const started = Date.now();
  let result: ProductResult | undefined;
  let error: string | undefined;
  try {
    const scraped = await connector.scrape(catalogNumber, {
      http,
      manufacturer,
      runDir: benchRoot,
      documentsDir: path.join(benchRoot, "documents"),
      signal: undefined,
      browserRenderer,
      learnedEndpoints: {
        list: (id: string, l?: number) => db.listLearnedEndpoints(id, l),
        upsert: (endpoint: any) => db.upsertLearnedEndpoint(endpoint)
      },
      fallback: { scrape: (cn: string, sources: any) => fallback.scrape(cn, sources) },
      downloadDocument: async (doc: any) => doc
    } as any);
    result = finalizeQualityGate(scraped, manufacturer);
  } catch (e) {
    error = (e as Error).message;
  }
  const ms = Date.now() - started;
  const fields = result ? fieldSnapshot(result) : {};
  const row = {
    catalogNumber,
    ms,
    status: result?.status ?? "error",
    confidence: result?.confidence,
    title: result?.title,
    productUrl: result?.productUrl,
    attributes: result?.attributes.length ?? 0,
    documents: result?.documents.length ?? 0,
    images: result?.documents.filter((d) => d.type === "image").length ?? 0,
    description: result?.description,
    germanTitle: result?.localizedDescriptions?.de?.title,
    fieldsPresent: Object.keys(fields).length,
    missingRequired: REQUIRED.filter((f) => !fields[f]),
    missingKeyAttributes: KEY_ATTRIBUTES.filter(
      ([, pattern]) => !(result?.attributes ?? []).some((a) => pattern.test(a.name))
    ).map(([name]) => name),
    fields,
    error: error ?? result?.error,
    startedAt: started - totalStarted,
    finishedAt: Date.now() - totalStarted,
    calls: timeline
      .filter((c) => c.at >= started && c.at <= Date.now() && (c.url.includes(catalogNumber) || !/1[A-Z]{3}\d/.test(c.url)))
      .map((c) => `${String(c.at - started).padStart(7)}+ ${String(c.ms).padStart(6)}ms ${String(c.status).padStart(4)} ${c.cached ? "CACHE" : "live "} ${c.url}`)
  };
  rows.push(row);
  console.log(
    `${catalogNumber.padEnd(20)} ${String(ms).padStart(7)}ms  ${String(row.status).padEnd(8)} conf=${String(row.confidence ?? "-").padEnd(5)} attrs=${String(row.attributes).padStart(3)} docs=${String(row.documents).padStart(3)} fields=${String(row.fieldsPresent).padStart(3)} pis=${row.attributes && (result?.attributes ?? []).some((a) => a.group === "ABB Product Data") ? "Y" : "N"}`
  );
}

const queue = [...catalogs];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await benchOne(next);
    }
  })
);

const totalMs = Date.now() - totalStarted;
const times = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log("\n=== SUMMARY ===");
console.log(`items=${rows.length} totalMs=${totalMs} avg=${Math.round(totalMs / rows.length)} median=${times[Math.floor(times.length / 2)]} max=${times[times.length - 1]}`);
const byStatus: Record<string, number> = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log("status:", byStatus);
const missCount: Record<string, number> = {};
for (const r of rows) for (const f of r.missingRequired) missCount[f] = (missCount[f] ?? 0) + 1;
console.log("missing normalized field counts:", missCount);
const attrMiss: Record<string, number> = {};
for (const r of rows) for (const f of r.missingKeyAttributes) attrMiss[f] = (attrMiss[f] ?? 0) + 1;
console.log("missing key attribute counts:", attrMiss);
console.log("no title:", rows.filter((r) => !r.title).map((r) => r.catalogNumber));
console.log("no description:", rows.filter((r) => !r.description).map((r) => r.catalogNumber));
console.log("no german title:", rows.filter((r) => !r.germanTitle).map((r) => r.catalogNumber));

const outPath = path.join(rootDir, "tmp", `abb-bench-${cold ? "cold" : "warm"}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ cold, totalMs, rows }, null, 2), "utf8");
console.log(`\nfull trace -> ${outPath}`);

await browserRenderer.close();
db.close();
if (cold) console.log(`(cold data dir: ${benchRoot})`);
