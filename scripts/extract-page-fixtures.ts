/**
 * Build offline HTML fixtures out of real pages past runs already fetched.
 *
 * The offline corpus in `fixtures/` was seeded from PDFs and two stray HTML dumps, which left the HTML
 * path far less well evidenced than the PDF path — `npm run audit:spec-gate` only covers PDFs. But
 * `data/scraper.db`'s `page_cache` holds the body of every page any run ever fetched, and `run_items`
 * records which catalog number resolved to which product URL. Joining the two yields real,
 * vendor-diverse product pages that can be replayed offline forever.
 *
 * `data/` is gitignored, so the bodies are COPIED into `fixtures/<case>/page.html`.
 *
 * This writes `case.json` only. `expected.json` is left for a human to fill in after reading the page —
 * see fixtures/README.md: promoting `actual.json` would turn today's bugs into tomorrow's baseline.
 *
 * Usage:
 *   npx tsx scripts/extract-page-fixtures.ts --list                 # what is available, by vendor
 *   npx tsx scripts/extract-page-fixtures.ts --vendor abb --limit 2
 *   npx tsx scripts/extract-page-fixtures.ts --spread 8             # one page per vendor, up to 8
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.join(repoRoot, "data", "scraper.db");
const fixturesRoot = path.join(repoRoot, "fixtures");

interface Candidate {
  manufacturerId: string;
  catalogNumber: string;
  productUrl: string;
  cachePath: string;
  contentType: string | null;
  bytes: number;
}

export interface FixtureExtractOptions {
  help: boolean;
  list: boolean;
  vendor?: string;
  catalog?: string;
  url?: string;
  includeNonFound: boolean;
  limit: number;
  spread?: number;
}

function parseArgs(argv: string[]): FixtureExtractOptions {
  const options: FixtureExtractOptions = { help: false, list: false, includeNonFound: false, limit: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help" || argv[index] === "-h") options.help = true;
    else if (argv[index] === "--list") options.list = true;
    else if (argv[index] === "--vendor") options.vendor = argv[++index];
    else if (argv[index] === "--catalog") options.catalog = argv[++index]?.trim();
    else if (argv[index] === "--url") options.url = argv[++index]?.trim();
    else if (argv[index] === "--include-non-found") options.includeNonFound = true;
    else if (argv[index] === "--limit") options.limit = Number(argv[++index]) || options.limit;
    else if (argv[index] === "--spread") options.spread = Number(argv[++index]) || 8;
  }
  return options;
}

/**
 * A run item that succeeded, whose product URL we still have a cached HTML body for.
 *
 * `status = 'found'` plus a non-null product_url is the strongest available signal that the page really
 * was this catalog number's product page — the run's own quality gate said so at the time.
 */
function queryCandidates(db: Database.Database, options: FixtureExtractOptions): Candidate[] {
  const conditions = [
    "(i.status = 'found' OR ? = 1)",
    "i.product_url IS NOT NULL",
    "(c.content_type IS NULL OR c.content_type LIKE '%html%')",
    "(c.status_code IS NULL OR c.status_code = 200)"
  ];
  const values: Array<string | number> = [options.includeNonFound ? 1 : 0];
  if (options.vendor) {
    conditions.push("r.manufacturer_id = ?");
    values.push(options.vendor);
  }
  if (options.catalog) {
    conditions.push("i.catalog_number = ?");
    values.push(options.catalog);
  }
  const rows = db
    .prepare(
      `SELECT r.manufacturer_id AS manufacturerId,
              i.catalog_number   AS catalogNumber,
              i.product_url      AS productUrl,
              c.path             AS cachePath,
              c.content_type     AS contentType
         FROM run_items i
         JOIN runs r        ON r.id = i.run_id
         JOIN page_cache c  ON (c.effective_url = i.product_url OR c.url = i.product_url)
        WHERE ${conditions.join("\n          AND ")}
        GROUP BY r.manufacturer_id, i.catalog_number
        ORDER BY r.manufacturer_id, i.catalog_number`
    )
    .all(...values) as Array<Omit<Candidate, "bytes">>;
  return rows.map((row) => ({ ...row, bytes: 0 }));
}

/** Exact URL extraction is intentionally separate from the broad successful-run query above:
 * one catalog can have multiple cached routes (search, CAD, PDP), and GROUP BY would otherwise
 * choose an arbitrary body for a fixture. */
function queryExactUrlCandidates(db: Database.Database, options: FixtureExtractOptions): Candidate[] {
  const rows = db
    .prepare(
      `SELECT r.manufacturer_id AS manufacturerId,
              i.catalog_number   AS catalogNumber,
              COALESCE(c.effective_url, c.url) AS productUrl,
              c.path             AS cachePath,
              c.content_type     AS contentType
         FROM page_cache c
         JOIN run_items i ON (i.product_url = c.url OR i.product_url = c.effective_url)
         JOIN runs r ON r.id = i.run_id
        WHERE (c.url = ? OR c.effective_url = ?)
          AND i.catalog_number = ?
          AND (? IS NULL OR r.manufacturer_id = ?)
          AND (c.content_type IS NULL OR c.content_type LIKE '%html%')
          AND (c.status_code IS NULL OR c.status_code = 200)
        ORDER BY CASE WHEN i.status = 'found' THEN 0 ELSE 1 END, i.updated_at DESC`
    )
    .all(options.url, options.url, options.catalog, options.vendor ?? null, options.vendor ?? null) as Array<Omit<Candidate, "bytes">>;
  return rows.map((row) => ({ ...row, bytes: 0 }));
}

/**
 * Limit by an explicit vendor/catalog in SQL before touching the filesystem. The cache may hold
 * thousands of old pages, so checking every path first made a one-page fixture extraction slower
 * than the audit it is meant to support.
 */
export function queryFixtureCandidates(db: Database.Database, options: FixtureExtractOptions): Candidate[] {
  return options.url ? queryExactUrlCandidates(db, options) : queryCandidates(db, options);
}

async function withSizes(candidates: Candidate[]): Promise<Candidate[]> {
  const resolved: Candidate[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(24, candidates.length) }, async () => {
    while (next < candidates.length) {
      const candidate = candidates[next++];
      const absolute = path.isAbsolute(candidate.cachePath)
        ? candidate.cachePath
        : path.join(repoRoot, candidate.cachePath);
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size < 2000) continue; // too small to be a real product page
        resolved.push({ ...candidate, cachePath: absolute, bytes: stat.size });
      } catch {
        // cache file pruned since the run — skip
      }
    }
  });
  await Promise.all(workers);
  return resolved;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

async function writeFixture(candidate: Candidate): Promise<string | undefined> {
  const id = `${candidate.manufacturerId}-${slug(candidate.catalogNumber)}-page`;
  const dir = path.join(fixturesRoot, id);
  try {
    await fs.access(path.join(dir, "case.json"));
    return undefined; // already present — never overwrite a reviewed fixture
  } catch {
    // new fixture
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(candidate.cachePath, path.join(dir, "page.html"));
  const caseJson = {
    id,
    manufacturerId: candidate.manufacturerId,
    catalogNumber: candidate.catalogNumber,
    note: `Recorded ${candidate.manufacturerId} product page (${Math.round(candidate.bytes / 1024)} kB), extracted from a past run's page cache. Guards the generic HTML understanding path for this vendor's page shape.`,
    pages: [{ path: "page.html", url: candidate.productUrl, sourceType: "official" }]
  };
  await fs.writeFile(path.join(dir, "case.json"), `${JSON.stringify(caseJson, null, 2)}\n`, "utf8");
  return id;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      "Usage: npx tsx scripts/extract-page-fixtures.ts [--list] [--vendor <id>] [--catalog <part>] [--url <url>] [--limit <n>] [--spread <n>]",
      "",
      "Reads cache candidates only until a fixture is explicitly selected. Writing a fixture never creates expected.json; ground truth must be reviewed by hand.",
      "--include-non-found requires --catalog. --url requires --catalog."
    ].join("\n"));
    return;
  }
  if (options.includeNonFound && !options.catalog) {
    console.error("--include-non-found requires an exact --catalog so the extractor cannot bulk-copy unreviewed failures.");
    process.exitCode = 1;
    return;
  }
  if (options.url && !options.catalog) {
    console.error("--url requires an exact --catalog so the fixture remains tied to a product identity.");
    process.exitCode = 1;
    return;
  }
  const db = new Database(dbPath, { readonly: true });
  let candidates: Candidate[];
  try {
    candidates = await withSizes(queryFixtureCandidates(db, options));
  } finally {
    db.close();
  }

  if (!candidates.length) {
    console.error(`No cached HTML product pages found${options.includeNonFound ? "" : " for any successful run item"}.`);
    process.exit(1);
  }

  const byVendor = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byVendor.get(candidate.manufacturerId) ?? [];
    list.push(candidate);
    byVendor.set(candidate.manufacturerId, list);
  }

  if (options.list) {
    console.log(`${candidates.length} cached product pages across ${byVendor.size} vendors:\n`);
    for (const [vendor, list] of [...byVendor.entries()].sort()) {
      const median = list[Math.floor(list.length / 2)];
      console.log(`  ${vendor.padEnd(12)} ${String(list.length).padStart(4)} pages   e.g. ${median.catalogNumber} (${Math.round(median.bytes / 1024)} kB)`);
    }
    return;
  }

  let selected: Candidate[];
  if (options.catalog) {
    const catalogKey = options.catalog.toLocaleUpperCase();
    selected = candidates.filter(
      (candidate) =>
        candidate.catalogNumber.trim().toLocaleUpperCase() === catalogKey &&
        (!options.vendor || candidate.manufacturerId === options.vendor)
    );
    if (options.url) selected = selected.filter((candidate) => candidate.productUrl === options.url);
    if (!selected.length) {
      console.error(`No cached HTML product page found for catalog ${options.catalog}${options.vendor ? ` from ${options.vendor}` : ""}.`);
      process.exitCode = 1;
      return;
    }
  } else if (options.spread) {
    // One page per vendor gives the widest variety of page SHAPES per fixture added, which is what the
    // generic parser is judged on — not how many pages one vendor contributes.
    selected = [...byVendor.entries()]
      .sort()
      .map(([, list]) => list[Math.floor(list.length / 2)])
      .slice(0, options.spread);
  } else if (options.vendor) {
    selected = (byVendor.get(options.vendor) ?? []).slice(0, options.limit);
  } else {
    selected = candidates.slice(0, options.limit);
  }

  const written: string[] = [];
  for (const candidate of selected) {
    const id = await writeFixture(candidate);
    if (id) written.push(id);
  }

  console.log(`Wrote ${written.length} fixture(s):`);
  for (const id of written) console.log(`  fixtures/${id}`);
  console.log(
    "\nNext: run `npm run eval -- --write-actual`, READ each source page, then write expected.json by hand.\n" +
      "Never promote actual.json — that turns a bug into a baseline (fixtures/README.md)."
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
