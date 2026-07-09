/**
 * Feedback loop for the property ontology (ontology.ts): runs findUnmappedSpecLabels against
 * every attribute ever scraped and stored in the local run history (data/scraper.db), not just
 * the small benchmarks/ fixture set. Reports the most frequent labels that carry a recognizable
 * numeric value but map to no known ontology property — a concrete worklist for adding new
 * synonyms/properties, instead of guessing what's missing.
 *
 * Usage: npx tsx scripts/audit-unmapped-spec-labels.ts [--top N] [--limit-runs N]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { findUnmappedSpecLabels } from "../src/server/scrapers/ontology.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function argValue(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const topN = argValue("--top", 60);
const runLimit = argValue("--limit-runs", 100_000);

const appPaths = createAppPaths(rootDir);
const db = new ScraperDb(appPaths);

const labelCounts = new Map<string, number>();
let scannedRuns = 0;
let scannedItems = 0;
let scannedAttributes = 0;

try {
  const runs = db.listRuns(runLimit);
  console.log(`Scanning ${runs.length} run(s)...`);
  for (const run of runs) {
    const runStarted = Date.now();
    scannedRuns += 1;
    const items = db.getRunItems(run.id);
    for (const item of items) {
      const attributes = item.result?.attributes;
      if (!attributes?.length) continue;
      scannedItems += 1;
      scannedAttributes += attributes.length;
      for (const label of findUnmappedSpecLabels(attributes)) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }
    const runElapsedMs = Date.now() - runStarted;
    if (runElapsedMs > 1000 || scannedRuns % 20 === 0) {
      console.log(`  [${scannedRuns}/${runs.length}] run ${run.id} (${items.length} items) took ${runElapsedMs}ms`);
    }
  }
} finally {
  db.close();
}

const ranked = [...labelCounts.entries()].sort((left, right) => right[1] - left[1]);

console.log("=== Unmapped spec label audit ===");
console.log(`Scanned ${scannedRuns} run(s), ${scannedItems} item(s) with attributes, ${scannedAttributes} attribute(s) total.`);
console.log(`Found ${ranked.length} distinct unmapped label(s) carrying a recognizable numeric value.\n`);

if (ranked.length === 0) {
  console.log("(clean — every numeric-shaped label maps to a known ontology property)");
} else {
  console.log(`Top ${Math.min(topN, ranked.length)} by frequency (label -> occurrence count across stored run items):`);
  for (const [label, count] of ranked.slice(0, topN)) {
    console.log(`  ${count.toString().padStart(5)}  ${label}`);
  }
  if (ranked.length > topN) {
    console.log(`  ... and ${ranked.length - topN} more (rerun with --top ${ranked.length} to see all)`);
  }
}
