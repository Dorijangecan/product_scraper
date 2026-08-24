/**
 * Proves the shared confidence rubric against persisted, real connector output — no network and
 * no selector-only simulation. The newest N stored results for every manufacturer are checked so
 * a connector cannot silently emit an attribute outside the named evidence tiers.
 *
 * Usage:
 *   npm run audit:confidence
 *   npm run audit:confidence -- --per-manufacturer 25
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProductResult } from "../src/shared/types.js";
import { auditResultEvidence, type EvidenceAuditIssue } from "../src/server/scrapers/evidence-audit.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flagIndex = process.argv.indexOf("--per-manufacturer");
const perManufacturer = Number(flagIndex >= 0 ? process.argv[flagIndex + 1] : 10);
if (!Number.isInteger(perManufacturer) || perManufacturer < 1 || perManufacturer > 100) {
  throw new Error("--per-manufacturer must be an integer from 1 to 100.");
}

interface StoredRow {
  manufacturer_id: string;
  catalog_number: string;
  raw_json: string;
}

interface Totals {
  results: number;
  records: number;
  issues: number;
  tiers: Record<string, number>;
  provenance: Record<string, number>;
}

const db = new Database(path.join(repoRoot, "data", "scraper.db"), { readonly: true });
const rows = db.prepare(
  `WITH ranked AS (
     SELECT r.manufacturer_id, ri.catalog_number, ri.raw_json,
       ROW_NUMBER() OVER (PARTITION BY r.manufacturer_id ORDER BY ri.updated_at DESC, ri.id DESC) AS row_number
     FROM run_items ri
     JOIN runs r ON r.id = ri.run_id
     WHERE ri.raw_json IS NOT NULL
   )
   SELECT manufacturer_id, catalog_number, raw_json
   FROM ranked
   WHERE row_number <= ?
   ORDER BY manufacturer_id, row_number`
).all(perManufacturer) as StoredRow[];

const totals: Totals = {
  results: 0,
  records: 0,
  issues: 0,
  tiers: {},
  provenance: {}
};
const byManufacturer = new Map<string, Totals>();
const examples: Array<{ manufacturer: string; catalog: string; issue: EvidenceAuditIssue }> = [];

for (const row of rows) {
  let result: ProductResult;
  try {
    result = JSON.parse(row.raw_json) as ProductResult;
  } catch (error) {
    throw new Error(`Invalid raw_json for ${row.manufacturer_id}/${row.catalog_number}: ${String(error)}`);
  }
  const audit = auditResultEvidence(result);
  const manufacturerTotals = byManufacturer.get(row.manufacturer_id) ?? emptyTotals();
  add(manufacturerTotals, audit);
  add(totals, audit);
  byManufacturer.set(row.manufacturer_id, manufacturerTotals);
  for (const issue of audit.issues) {
    if (examples.length < 30) examples.push({ manufacturer: row.manufacturer_id, catalog: row.catalog_number, issue });
  }
}

console.log(`Evidence-confidence audit: ${totals.results} persisted connector result(s), newest ${perManufacturer} per manufacturer.`);
console.log(`records ${totals.records}; tiers ${formatCounts(totals.tiers)}; provenance ${formatCounts(totals.provenance)}.`);
for (const [manufacturer, total] of [...byManufacturer.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  console.log(`${manufacturer.padEnd(12)} ${total.results} result(s), ${total.records} record(s), ${total.issues} issue(s); ${formatCounts(total.tiers)}`);
}
if (examples.length > 0) {
  console.log("\nIssues:");
  for (const example of examples) {
    console.log(`  ${example.manufacturer}/${example.catalog}: ${example.issue.kind} ${example.issue.kindOfEvidence} "${example.issue.name}" — ${example.issue.detail}`);
  }
}
console.log(`\n${totals.issues === 0 ? "OK" : `${totals.issues} provenance issue(s) found`}`);
process.exitCode = totals.issues === 0 ? 0 : 1;

function emptyTotals(): Totals {
  return { results: 0, records: 0, issues: 0, tiers: {}, provenance: {} };
}

function add(target: Totals, audit: ReturnType<typeof auditResultEvidence>): void {
  target.results += 1;
  target.records += audit.records.length;
  target.issues += audit.issues.length;
  addCounts(target.tiers, audit.tiers);
  addCounts(target.provenance, audit.provenance);
}

function addCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}=${count}`)
    .join(", ") || "none";
}
