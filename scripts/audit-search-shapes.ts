/**
 * Which search query-key shapes has any vendor ever actually ANSWERED?
 *
 * `GENERIC_SEARCH_SHAPES` in discovery.ts is ordered by this script's output, and must stay that way:
 * the generic search stage fires up to 18 shapes per catalog number, so their order is the difference
 * between one request and eighteen. Ordering by guesswork is how `/search/{part}` — the single
 * best-performing shape in the whole corpus — ended up unreachable for every vendor with two URL bases.
 *
 * "Answered" = the cached response body carries an href pointing at the requested catalog number.
 * Deliberately regex-only, no cheerio: the job is to RANK shapes, and running full link discovery over
 * every cached search page did not finish in 25 minutes.
 *
 * Read-only. Reads `data/scraper.db` and the cached bodies it points at; writes nothing.
 *
 * Caveat when reading the numbers: `tried` reflects what OUR code has historically requested, so the
 * volume column is biased. Distinct answering vendors is the less biased signal — rank by that first.
 *
 * Usage:
 *   npm run audit:search-shapes
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "Usage: npx tsx scripts/audit-search-shapes.ts",
    "",
    "Read-only: counts how often each generic search shape in page_cache answered with a link to the",
    "requested catalog number. Use its ordering for GENERIC_SEARCH_SHAPES in discovery.ts."
  ].join("\n"));
  process.exit(0);
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const db = new Database(path.join(repoRoot, "data", "scraper.db"), { readonly: true });
const rows = db
  .prepare("SELECT url, path, status_code AS statusCode FROM page_cache")
  .all() as Array<{ url: string; path: string; statusCode: number | null }>;
db.close();

const keys = ["q", "query", "search", "s", "text", "keyword", "searchTerm", "Ntt", "k", "article", "partNumber"];
interface Stat {
  tried: number;
  ok200: number;
  nonEmpty: number;
  answered: number;
  vendors: Set<string>;
  answeringVendors: Set<string>;
}
const stats = new Map<string, Stat>();
const bump = (key: string): Stat => {
  const existing =
    stats.get(key) ?? { tried: 0, ok200: 0, nonEmpty: 0, answered: 0, vendors: new Set<string>(), answeringVendors: new Set<string>() };
  stats.set(key, existing);
  return existing;
};

const compact = (value: string): string => value.replace(/[^a-z0-9]/gi, "").toLowerCase();

let scanned = 0;
for (const row of rows) {
  let parsed: URL;
  try {
    parsed = new URL(row.url);
  } catch {
    continue;
  }
  let shape: string | undefined;
  let catalog: string | undefined;
  for (const key of keys) {
    const value = parsed.searchParams.get(key);
    if (value && value.length >= 3) {
      shape = key;
      catalog = value;
      break;
    }
  }
  if (!shape && /\/(?:site-)?search\/[^/?]{3,}$/i.test(parsed.pathname)) {
    shape = "/search/{part}";
    catalog = parsed.pathname.split("/").filter(Boolean).pop();
  }
  if (!shape || !catalog) continue;

  const bucket = bump(shape);
  bucket.tried += 1;
  bucket.vendors.add(parsed.hostname.replace(/^www\./, ""));
  if ((row.statusCode ?? 0) >= 200 && (row.statusCode ?? 0) < 300) bucket.ok200 += 1;

  const absolute = path.isAbsolute(row.path) ? row.path : path.join(repoRoot, row.path);
  let text = "";
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch {
    continue;
  }
  if (text.trim().length < 200) continue;
  bucket.nonEmpty += 1;
  scanned += 1;
  if (scanned % 200 === 0) process.stderr.write(`scanned ${scanned}\n`);

  const wanted = compact(decodeURIComponent(catalog));
  if (wanted.length < 4) continue;
  let answered = false;
  for (const match of text.matchAll(/(?:href|url)\s*[=:]\s*["']([^"']{4,300})["']/gi)) {
    const href = match[1];
    if (/^(?:mailto|javascript|#)/i.test(href)) continue;
    if (compact(href).includes(wanted)) {
      answered = true;
      break;
    }
  }
  if (answered) {
    bucket.answered += 1;
    bucket.answeringVendors.add(parsed.hostname.replace(/^www\./, ""));
  }
}

const lines = ["shape           tried   200  body  answered   vendors-that-answered"];
for (const [shape, stat] of [...stats.entries()].sort((left, right) => right[1].answered - left[1].answered || right[1].tried - left[1].tried)) {
  lines.push(
    `${shape.padEnd(15)} ${String(stat.tried).padStart(5)} ${String(stat.ok200).padStart(5)} ${String(stat.nonEmpty).padStart(5)} ${String(stat.answered).padStart(9)}   ${[...stat.answeringVendors].join(",") || "-"}`
  );
}
console.log(lines.join("\n"));
