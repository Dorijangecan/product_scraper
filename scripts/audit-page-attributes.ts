/**
 * Prints what the generic HTML path actually extracts, over the real recorded pages in `page_cache`.
 *
 * `audit:spec-gate` does this for PDFs; this is the HTML counterpart, and it exists because guessing is
 * how you write a rule that looks obviously right and destroys real data. Concretely: the undelimited
 * branch of `extractDelimitedPlainTextSpecAttributes` was chopping marketing prose into fake spec pairs,
 * and running this over the corpus showed the branch produced SEVEN pairs in total, all seven prose. That
 * made the fix safe to reason about — and it also showed the first rule tried (require a digit or a
 * capital) would have kept five of the seven, since prose about voltage ranges is full of numbers.
 *
 * Usage:
 *   npm run audit:page-attrs                     # every group, 200 pages
 *   npm run audit:page-attrs -- --group "Plain Text Specs" --limit 400
 *   npm run audit:page-attrs -- --host new.abb.com
 *
 * Reads only; needs no network. Output is deduplicated and sorted, so two runs are diffable.
 */
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGenericProductPage } from "../src/server/scrapers/generic.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const limit = Number(flag("limit") ?? 200);
const groupFilter = flag("group");
const hostFilter = flag("host");
const containsFilter = flag("contains")?.toLowerCase();
const trace = process.argv.includes("--trace");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "Usage: npx tsx scripts/audit-page-attributes.ts [--group <name>] [--host <hostname>] [--contains <text>] [--limit <n>] [--trace]",
    "",
    "Read-only offline audit over cached HTML product pages."
  ].join("\n"));
  process.exit(0);
}

const db = new Database(path.join(repoRoot, "data", "scraper.db"), { readonly: true });
const rows = db
  .prepare(
    `SELECT pc.url AS url, pc.path AS cachePath, MIN(ri.catalog_number) AS catalog
       FROM page_cache pc
       JOIN run_items ri ON ri.product_url = pc.url
      WHERE pc.status_code = 200
        AND (pc.content_type IS NULL OR pc.content_type LIKE '%html%')
        AND (? IS NULL OR pc.url LIKE '%' || ? || '%')
      GROUP BY pc.url
      LIMIT ?`
  )
  .all(hostFilter ?? null, hostFilter ?? null, limit) as Array<{
  url: string;
  cachePath: string;
  catalog: string;
}>;

const perGroup = new Map<string, Set<string>>();
let parsed = 0;
let failures = 0;

for (const [index, row] of rows.entries()) {
  if ((parsed + failures) % 25 === 0) console.error(`  …${parsed + failures}/${rows.length}`);
  if (trace) console.error(`  start ${index + 1}/${rows.length} ${row.url}`);
  let result;
  try {
    const absolute = path.isAbsolute(row.cachePath) ? row.cachePath : path.join(repoRoot, row.cachePath);
    const body = await fs.readFile(absolute, "utf8");
    result = parseGenericProductPage(
      new URL(row.url).hostname,
      row.catalog ?? "",
      {
        requestedUrl: row.url,
        effectiveUrl: row.url,
        statusCode: 200,
        contentType: "text/html; charset=utf-8",
        text: body,
        fetchedAt: new Date(0).toISOString(),
        fromCache: true
      },
      "official",
      "generic"
    );
    parsed += 1;
    if (trace) console.error(`  done ${index + 1}/${rows.length} ${row.url}`);
  } catch (error) {
    failures += 1;
    if (failures <= 3) console.error(`parse failed for ${row.url}: ${String(error)}`);
    continue;
  }

  for (const attribute of result.attributes ?? []) {
    const group = attribute.group ?? "(none)";
    if (groupFilter && group !== groupFilter) continue;
    const rendered = `${attribute.name} = ${String(attribute.value ?? "")}`;
    if (containsFilter && !rendered.toLowerCase().includes(containsFilter)) continue;
    const bucket = perGroup.get(group) ?? new Set<string>();
    bucket.add(`${rendered}   [${new URL(row.url).hostname}]`);
    perGroup.set(group, bucket);
    if (trace && containsFilter) console.error(`  hit ${row.catalog} ${row.url} :: ${group} :: ${rendered}`);
  }
}

console.log(`\npages parsed ${parsed}, unparseable ${failures}`);
for (const group of [...perGroup.keys()].sort()) {
  const lines = [...(perGroup.get(group) ?? [])].sort();
  console.log(`\n=== ${group} (${lines.length} distinct) ===`);
  console.log(lines.join("\n"));
}
