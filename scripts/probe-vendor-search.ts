/**
 * LIVE: what does this vendor's search actually do? (COLD-START-PLAN §6, the confirmation step.)
 *
 * Everything P4 added is unverifiable offline, and the plan says so in three places: the replay has no
 * browser, `page_cache` only holds URL shapes our code has already asked for, and the classes
 * `search-zero-hits` / `search-js-only` are empty on the cached corpus. So the offline audits can only
 * ever prove NON-REGRESSION. This script is the other half — it runs the real discovery stage against
 * the real site and prints what came back, so the three open questions get answers instead of
 * estimates:
 *
 *   1. Does any search shape answer at all, or is `no-search-entry` really just a cache miss?
 *   2. Does the vendor declare OpenSearch / expose a findable search form?
 *   3. When the first query returns nothing, does re-asking (P4.6) or opening an unidentified result
 *      (P4.7) actually reach the product?
 *
 * It calls `discoverOfficialProductCandidates` itself rather than re-implementing any of it, so what
 * it reports is what the scraper really does — including every budget and guard.
 *
 * Politeness and scope: sequential, one catalog number at a time, through the project's own
 * `CachedHttpClient` (per-host throttle, adaptive backoff, real headers). It issues exactly the
 * requests a normal run of this tool would. Nothing is written except the usual page cache — which is
 * a deliberate side benefit, since those responses are precisely the ones the offline corpus lacks.
 *
 * Usage:
 *   npx tsx scripts/probe-vendor-search.ts --vendor gan --catalog "GN 3310-19-LK-K2"
 *   npx tsx scripts/probe-vendor-search.ts --vendor fath --catalog 6SACP3J316B.2000 --catalog 6SACP3J316B.4000
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getManufacturerConfig, initializeManufacturerConfig } from "../src/server/config/manufacturers.js";
import { ScraperDb } from "../src/server/db.js";
import { createAppPaths } from "../src/server/paths.js";
import { CachedHttpClient } from "../src/server/scrapers/http-client.js";
import { discoverOfficialProductCandidates } from "../src/server/scrapers/discovery.js";
import { openSearchDescriptionUrls } from "../src/server/scrapers/opensearch.js";
import { searchResultVerdict } from "../src/server/scrapers/search-results.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

interface Options {
  vendor: string;
  catalogNumbers: string[];
}

function printUsage(): void {
  console.log(
    [
      'Usage: npx tsx scripts/probe-vendor-search.ts --vendor <id> --catalog "<number>" [--catalog "<number>"]',
      "",
      "LIVE probe. Runs the real discovery stage against the real vendor site and prints what came",
      "back: which search shapes answered, what verdict each page carried, and which candidates the",
      "pipeline would try. Read-only apart from the normal page cache."
    ].join("\n")
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = { vendor: "", catalogNumbers: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--vendor") options.vendor = argv[++index] ?? "";
    else if (argv[index] === "--catalog") options.catalogNumbers.push(argv[++index] ?? "");
  }
  options.catalogNumbers = options.catalogNumbers.filter(Boolean);
  return options;
}

/** In-memory learning, so one probe cannot teach the real database something a live run did not. */
function throwawayStores() {
  const endpoints = new Map<string, { successCount: number; lastSuccessAt: string; record: unknown }>();
  return {
    learnedEndpoints: {
      list: () => [],
      upsert: (endpoint: { urlTemplate: string }) => {
        endpoints.set(endpoint.urlTemplate, { successCount: 1, lastSuccessAt: "", record: endpoint });
      },
      recordFailure: () => undefined
    },
    learnedTemplates: endpoints
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (!options.vendor || !options.catalogNumbers.length) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const appPaths = createAppPaths(rootDir);
  initializeManufacturerConfig(appPaths.dataDir);
  const manufacturer = getManufacturerConfig(options.vendor);
  if (!manufacturer) {
    console.error(`Unknown manufacturer: ${options.vendor}`);
    process.exitCode = 1;
    return;
  }

  const db = new ScraperDb(appPaths);
  const http = new CachedHttpClient(db, appPaths.cacheDir);

  console.log(`\n=== LIVE search probe: ${manufacturer.canonicalName} (${manufacturer.id}) ===`);
  console.log(`homepage      ${manufacturer.homepageUrl ?? "(none configured)"}`);
  console.log(`official base ${manufacturer.officialBaseUrls.join(", ")}`);
  console.log(`rate limit    ${manufacturer.rateLimitMs ?? 1500} ms / concurrency ${manufacturer.concurrency ?? 3}\n`);

  // Question 2, asked once: does the entry point declare a search of its own?
  if (manufacturer.homepageUrl) {
    try {
      const fetched = await http.fetchText(manufacturer.homepageUrl, { maxAttempts: 1 });
      const declared = openSearchDescriptionUrls(fetched.text, fetched.effectiveUrl);
      console.log(`homepage HTTP ${fetched.statusCode}, ${fetched.text.length} bytes`);
      console.log(`OpenSearch declaration: ${declared.length ? declared.join(", ") : "none"}`);
      console.log(`homepage verdict:       ${searchResultVerdict({ html: fetched.text, statusCode: fetched.statusCode }).kind}\n`);
    } catch (error) {
      console.log(`homepage fetch failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  for (const catalogNumber of options.catalogNumbers) {
    console.log(`--- ${catalogNumber} ---`);
    const stores = throwawayStores();
    const startedAt = Date.now();
    try {
      const discovery = await discoverOfficialProductCandidates(catalogNumber, {
        manufacturer,
        http,
        learnedEndpoints: stores.learnedEndpoints
      } as never);

      const attempted = discovery.diagnostics.attemptedUrls ?? [];
      console.log(`elapsed ${Math.round((Date.now() - startedAt) / 100) / 10}s, ${attempted.length} URLs attempted`);
      // The attempt list is the whole point of a live probe: a count cannot tell you whether the
      // vendor's real search endpoint was ever asked, and that is exactly the question.
      console.log("attempted:");
      for (const url of attempted.slice(0, 30)) console.log(`  ${url}`);
      if (attempted.length > 30) console.log(`  ... and ${attempted.length - 30} more`);

      // Questions 1 and 3 are answered by discovery's own notes: verdicts, OpenSearch declarations,
      // re-ask decisions and unidentified-result openings all report themselves there.
      const notes = discovery.diagnostics.notes ?? [];
      if (notes.length) {
        console.log("notes:");
        for (const note of notes) console.log(`  - ${note}`);
      } else {
        console.log("notes: (none — every stage was silent, which is itself the finding)");
      }

      console.log(`candidates (${discovery.candidates.length}):`);
      for (const candidate of discovery.candidates.slice(0, 8)) {
        console.log(`  ${String(candidate.score).padStart(3)}  ${candidate.stage.padEnd(24)}  ${candidate.url}`);
      }
      if (!discovery.candidates.length) console.log("  (none)");

      const rejected = discovery.diagnostics.rejectedLinks ?? [];
      if (rejected.length) {
        console.log(`rejected (${rejected.length}, first 5):`);
        for (const link of rejected.slice(0, 5)) console.log(`  ${link.url}\n      ${link.reason}`);
      }
    } catch (error) {
      console.log(`discovery threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log("");
  }

  db.close?.();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
