/**
 * WHERE does discovery stop when it fails? — the measurement COLD-START-PLAN §6.1 asks for.
 *
 * `audit:discovery` answers "did we find it, and what did it cost". It cannot answer the question P4
 * is built on, because today every failure looks identical from the outside: zero candidates. Those
 * zeros are at least five different problems with five different fixes, and without the split any
 * decision about which to fix first is a guess:
 *
 *   no-search-entry            the vendor answered and gave us nothing usable    -> P4.1 / P4.3 / P4.4
 *   no-search-entry-uncached   NOTHING was cached — offline this proves nothing   -> probe:vendor-search
 *   search-zero-hits           the site answered and said there is nothing       -> P4.5 / P4.6
 *   search-hits-unidentified   results exist, no card carried the catalog number -> P4.7
 *   search-js-only             static HTML is a shell, the list is client-drawn  -> P4.2 / P4.3
 *   search-blocked             bot mitigation, not a discovery problem at all    -> out of scope
 *   hit                        a candidate confirmed the known product page
 *
 * Method: replay `discoverOfficialProductCandidates` over the cached corpus (shared harness in
 * `discovery-replay.ts`, identical to `audit:discovery`), record every request it issued, then read
 * each search response with `searchResultVerdict` — the same detector P4.5 will later use at runtime.
 *
 * Honest limits, which must be quoted whenever these numbers are:
 *   - The replay has NO browser. `search-js-only` therefore counts pages the static path cannot read;
 *     it does not claim the browser path would also fail on them.
 *   - `page_cache` only holds URL shapes our code has historically requested. A shape we never tried
 *     (an OpenSearch template, a suggest endpoint) answers 404 here and lands in `no-search-entry`.
 *     That biases this audit TOWARDS no-search-entry, and it is the reason P4.4's real effect cannot
 *     be measured offline.
 *   - Targets are catalog numbers some run already resolved, so this is the "known-good" cohort. The
 *     vendor-with-unusable-search cohort is by construction under-represented.
 *
 * Read-only. Reads `data/scraper.db` and the cached bodies it points at; writes nothing except an
 * optional --json report.
 *
 * Usage:
 *   npx tsx scripts/audit-search-reachability.ts --limit 100
 *   npx tsx scripts/audit-search-reachability.ts --vendor gan --limit 20 --examples
 *   npx tsx scripts/audit-search-reachability.ts --limit 100 --json after.json --compare before.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { discoverOfficialProductCandidates, scoreFetchedDiscoveryEvidence } from "../src/server/scrapers/discovery.js";
import { countProductShapedLinks, discoverProductLinksWithDiagnostics } from "../src/server/scrapers/link-discovery.js";
import { searchResultVerdict } from "../src/server/scrapers/search-results.js";
import { getManufacturerConfig } from "../src/server/config/manufacturers.js";
import { sameNormalizedUrl } from "../src/server/url-util.js";
import type { FetchedText } from "../src/server/scrapers/http-client.js";
import {
  cacheBackedHttp,
  dbPath,
  inMemoryLearnedEndpointStore,
  loadCache,
  loadTargets,
  pad,
  padLeft,
  percentOf,
  repoRoot,
  type FetchStats,
  type Target
} from "./discovery-replay.js";

const STOP_CLASSES = [
  "hit",
  "search-hits-unidentified",
  "search-hits-unconfirmed",
  "search-zero-hits",
  "search-js-only",
  "search-blocked",
  "no-search-entry",
  "no-search-entry-uncached",
  "unknown"
] as const;

type StopClass = (typeof STOP_CLASSES)[number];

/** What each class means for the reader, printed with the table so the numbers are self-explaining. */
const CLASS_NEXT_STEP: Record<StopClass, string> = {
  hit: "-",
  "search-hits-unidentified": "P4.7 open the top results anyway",
  "search-hits-unconfirmed": "NOT a discovery gap — the PDP itself never confirmed",
  "search-zero-hits": "P4.5/P4.6 reformulate the query",
  "search-js-only": "P4.2/P4.3 browser input + suggest",
  "search-blocked": "out of scope (anti-bot)",
  "no-search-entry": "P4.1/P4.3/P4.4 find the search at all",
  "no-search-entry-uncached": "UNKNOWN offline — nothing was cached. Ask live: npm run probe:vendor-search",
  unknown: "needs a look by hand"
};

interface Options {
  limit: number;
  vendor?: string;
  jsonPath?: string;
  comparePath?: string;
  examples: boolean;
}

function printUsage(): void {
  console.log(
    [
      "Usage: npx tsx scripts/audit-search-reachability.ts [--vendor <id>] [--limit <n>] [--examples] [--json <out>] [--compare <baseline.json>]",
      "",
      "Read-only offline replay. Classifies WHY discovery stopped for each catalog number, so the",
      "P4 work in COLD-START-PLAN §6 can be prioritised by measured cause instead of by guess."
    ].join("\n")
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: 100, examples: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--limit") options.limit = Number(argv[++index]) || options.limit;
    else if (argv[index] === "--vendor") options.vendor = argv[++index];
    else if (argv[index] === "--examples") options.examples = true;
    else if (argv[index] === "--json") options.jsonPath = path.resolve(argv[++index] ?? "search-reachability.json");
    else if (argv[index] === "--compare") options.comparePath = path.resolve(argv[++index] ?? "search-reachability-baseline.json");
  }
  return options;
}

/**
 * Was this request an attempt to SEARCH, rather than to fetch a product page?
 *
 * Deliberately a reporting heuristic and deliberately NOT `discovery.ts`'s `isSearchLikeUrl`: that one
 * is a gate that decides whether a URL may become a product candidate, and widening it to catch more
 * shapes here would be a behaviour change smuggled in through an audit. This one only decides which
 * recorded response to read a verdict from, and a false positive costs nothing worse than reading one
 * extra page.
 */
function looksLikeSearchRequest(url: string, method: string): boolean {
  if (method === "POST") return true;
  return (
    /\/(?:search|suche|recherche|ricerca|busqueda|buscar|find|finder|catalog(?:ue)?search|produktsuche)\b/i.test(url) ||
    /[?&](?:q|s|query|search|searchterm|term|text|keyword|ntt|k|article|partnumber|sku)=/i.test(url)
  );
}

interface RecordedFetch {
  url: string;
  method: string;
  statusCode: number;
  text: string;
  /**
   * Did the corpus actually hold this response?
   *
   * The single most misleading number this audit ever produced. A URL shape our code has never sent
   * has no cache entry, and the replay answers it with a synthetic 404 — indistinguishable, until now,
   * from a vendor endpoint that is genuinely dead. `fath` sat at 5/6 `no-search-entry` for exactly that
   * reason, and the live probe then found its search working perfectly with the known-good PDP at rank
   * one, score 120. Reporting "we have no data" as "the vendor has no search" set the whole P4 priority
   * order once already.
   */
  fromCache: boolean;
}

interface Outcome {
  target: Target;
  stopClass: StopClass;
  evidence: string;
  requests: number;
  searchRequests: number;
  candidateCount: number;
  topUrl?: string;
  error?: string;
}

/**
 * Pick ONE class from everything the search stage saw for this catalog number.
 *
 * Order is not arbitrary. `blocked` outranks everything because a refused request says nothing about
 * whether the product is findable, and counting it as a discovery failure would inflate exactly the
 * numbers P4 is meant to move. `hits` outranks `zero` because one shape answering with results is
 * more informative than three others answering with none.
 */
function classifySearchResponses(responses: RecordedFetch[], catalogNumber: string): { stopClass: StopClass; evidence: string } {
  const usable = responses.filter((response) => response.statusCode < 400 && response.text.trim().length > 0);
  const blocked = responses.find((response) => response.statusCode === 403 || response.statusCode === 429 || response.statusCode === 503);
  if (blocked) return { stopClass: "search-blocked", evidence: `${blocked.url} -> HTTP ${blocked.statusCode}` };
  if (!usable.length) {
    // Separate "the corpus has nothing to say" from "the vendor answered and it was useless". Only the
    // second is a discovery gap; the first is a hole in the measurement and must be labelled as one,
    // not counted towards a class that then drives the plan's priorities.
    const cached = responses.filter((response) => response.fromCache);
    if (!cached.length) {
      return {
        stopClass: "no-search-entry-uncached",
        evidence: responses.length
          ? `${responses.length} search request(s), NONE present in the corpus — offline this proves nothing`
          : "no search request was issued at all"
      };
    }
    return {
      stopClass: "no-search-entry",
      evidence: `${cached.length} cached search response(s), none carried a usable body`
    };
  }

  const verdicts = usable.map((response) => {
    // Two different questions, deliberately asked with two different tools:
    //   identified — did any link on this page carry the catalog number? (the runtime's own gate)
    //   resultish  — does this page list products AT ALL? (structure only, identity-blind)
    // `search-hits-unidentified` is precisely `resultish > 0 && identified === 0`, and link discovery
    // alone cannot see it, because it rejects every link without exact catalog identity by design.
    const identified = discoverProductLinksWithDiagnostics(response.text, response.url, catalogNumber).candidates.length;
    const resultish = countProductShapedLinks(response.text);
    return {
      response,
      identified,
      resultish,
      verdict: searchResultVerdict({ html: response.text, statusCode: response.statusCode, candidateCount: identified })
    };
  });

  const blockedVerdict = verdicts.find((entry) => entry.verdict.kind === "blocked");
  if (blockedVerdict) {
    return { stopClass: "search-blocked", evidence: `${blockedVerdict.response.url} -> ${blockedVerdict.verdict.evidence}` };
  }

  // The search DID name links carrying the catalog number — they simply never confirmed downstream.
  // That is emphatically NOT the P4.7 case, and the first run of this audit proved why the distinction
  // has to exist: Siemens landed in `search-hits-unidentified` with `5 identified` printed right next
  // to it. Offline this is usually just an uncached PDP body; live it would be a wrong or dead target.
  // Either way, opening more results cannot fix it, so it must not inflate P4.7's justification.
  const identifiedButUnconfirmed = verdicts.find((entry) => entry.identified > 0);
  if (identifiedButUnconfirmed) {
    return {
      stopClass: "search-hits-unconfirmed",
      evidence: `${identifiedButUnconfirmed.response.url} -> ${identifiedButUnconfirmed.identified} link(s) carried the catalog number, none confirmed as the known PDP`
    };
  }

  for (const kind of ["hits", "js-only", "zero"] as const) {
    const match = verdicts.find((entry) => entry.verdict.kind === kind);
    if (!match) continue;
    const stopClass: StopClass = kind === "hits" ? "search-hits-unidentified" : kind === "js-only" ? "search-js-only" : "search-zero-hits";
    return { stopClass, evidence: `${match.response.url} -> ${match.verdict.evidence} (${match.resultish} product-shaped link(s), ${match.identified} identified)` };
  }

  // The page printed no counter and no zero-result sentence, but it clearly lists products. That is
  // still `search-hits-unidentified` — the page had the goods and we could not name them.
  const listing = verdicts.find((entry) => entry.resultish >= 3 && entry.identified === 0);
  if (listing) {
    return {
      stopClass: "search-hits-unidentified",
      evidence: `${listing.response.url} -> ${listing.resultish} product-shaped links, none carrying the catalog number, no result counter printed`
    };
  }
  return { stopClass: "unknown", evidence: `${verdicts[0].response.url} -> ${verdicts[0].verdict.evidence}` };
}


async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(dbPath, { readonly: true });
  let cache: ReturnType<typeof loadCache>;
  let targets: Target[];
  try {
    cache = loadCache(db);
    targets = loadTargets(db, { limit: options.limit, vendor: options.vendor });
  } finally {
    db.close();
  }

  console.log(`Classifying search reachability for ${targets.length} catalog numbers against ${cache.size} cached URLs.\n`);

  const stats: FetchStats = { hits: 0, misses: 0, current: 0, counting: false };
  const baseHttp = cacheBackedHttp(cache, stats);
  let recorded: RecordedFetch[] = [];
  // Wrap the shared cache client instead of writing a second one: the replay network must stay
  // byte-identical to `audit:discovery`, or the two audits stop being comparable.
  const http = {
    fetchText: async (url: string, init?: { method?: string }): Promise<FetchedText> => {
      const fetched = await baseHttp.fetchText(url);
      if (stats.counting) {
        recorded.push({
          url,
          method: init?.method ?? "GET",
          statusCode: fetched.statusCode,
          text: fetched.text,
          fromCache: fetched.fromCache === true
        });
      }
      return fetched;
    }
  };
  const learnedStore = inMemoryLearnedEndpointStore();
  const outcomes: Outcome[] = [];

  for (const target of targets) {
    const manufacturer = getManufacturerConfig(target.manufacturerId);
    if (!manufacturer) continue;
    stats.current = 0;
    stats.counting = true;
    recorded = [];
    try {
      const discovery = await discoverOfficialProductCandidates(target.catalogNumber, {
        manufacturer,
        http,
        learnedEndpoints: learnedStore
      } as never);
      stats.counting = false;
      const requests = stats.current;
      const searchResponses = recorded.filter((entry) => looksLikeSearchRequest(entry.url, entry.method));

      // Same ground-truth test as `audit:discovery`, so "hit" means the same thing in both reports.
      const confirmations = await Promise.all(
        discovery.candidates.map(async (candidate) => {
          if (sameNormalizedUrl(candidate.url, target.productUrl)) return true;
          const fetched = await baseHttp.fetchText(candidate.url);
          if (sameNormalizedUrl(fetched.effectiveUrl, target.productUrl)) return true;
          return scoreFetchedDiscoveryEvidence(fetched, target.catalogNumber).catalogConfirmed;
        })
      );
      const hitIndex = confirmations.findIndex(Boolean);

      const classified =
        hitIndex >= 0
          ? { stopClass: "hit" as StopClass, evidence: `rank ${hitIndex + 1} via ${discovery.candidates[hitIndex].stage}` }
          : classifySearchResponses(searchResponses, target.catalogNumber);

      outcomes.push({
        target,
        stopClass: classified.stopClass,
        evidence: classified.evidence,
        requests,
        searchRequests: searchResponses.length,
        candidateCount: discovery.candidates.length,
        topUrl: discovery.candidates[0]?.url
      });
      process.stdout.write(classified.stopClass === "hit" ? "1" : classified.stopClass === "no-search-entry" ? "0" : ".");
    } catch (error) {
      stats.counting = false;
      outcomes.push({
        target,
        stopClass: "unknown",
        evidence: "discovery threw",
        requests: stats.current,
        searchRequests: 0,
        candidateCount: 0,
        error: error instanceof Error ? error.message : String(error)
      });
      process.stdout.write("x");
    }
  }
  process.stdout.write("\n\n");

  const counts = new Map<StopClass, number>();
  for (const outcome of outcomes) counts.set(outcome.stopClass, (counts.get(outcome.stopClass) ?? 0) + 1);

  console.log("=== Where discovery stops ===");
  console.log(`catalog numbers measured  ${outcomes.length}`);
  console.log(`cache hits / misses       ${stats.hits} / ${stats.misses}\n`);
  console.log(`${pad("class", 26)}${padLeft("n", 5)}${padLeft("share", 9)}  next step`);
  for (const stopClass of STOP_CLASSES) {
    const value = counts.get(stopClass) ?? 0;
    if (!value) continue;
    console.log(`${pad(stopClass, 26)}${padLeft(String(value), 5)}${padLeft(percentOf(value, outcomes.length), 9)}  ${CLASS_NEXT_STEP[stopClass]}`);
  }

  const vendors = [...new Set(outcomes.map((outcome) => outcome.target.manufacturerId))].sort();
  console.log(
    `\n${pad("vendor", 14)}${padLeft("n", 4)}${padLeft("hit", 5)}${padLeft("unid", 6)}${padLeft("unconf", 8)}${padLeft("zero", 6)}${padLeft("js", 4)}${padLeft("noentry", 9)}${padLeft("nocache", 9)}${padLeft("blocked", 9)}`
  );
  for (const vendor of vendors) {
    const list = outcomes.filter((outcome) => outcome.target.manufacturerId === vendor);
    const count = (stopClass: StopClass): string => String(list.filter((outcome) => outcome.stopClass === stopClass).length);
    console.log(
      `${pad(vendor, 14)}${padLeft(String(list.length), 4)}${padLeft(count("hit"), 5)}${padLeft(count("search-hits-unidentified"), 6)}` +
        `${padLeft(count("search-hits-unconfirmed"), 8)}${padLeft(count("search-zero-hits"), 6)}${padLeft(count("search-js-only"), 4)}` +
        `${padLeft(count("no-search-entry"), 9)}${padLeft(count("no-search-entry-uncached"), 9)}${padLeft(count("search-blocked"), 9)}`
    );
  }

  if (options.examples) {
    console.log("\n=== Examples per class (first 3) ===");
    for (const stopClass of STOP_CLASSES) {
      if (stopClass === "hit") continue;
      const list = outcomes.filter((outcome) => outcome.stopClass === stopClass).slice(0, 3);
      if (!list.length) continue;
      console.log(`\n${stopClass}`);
      for (const outcome of list) {
        console.log(`  ${outcome.target.manufacturerId} ${outcome.target.catalogNumber}`);
        console.log(`    ${outcome.evidence}`);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    measured: outcomes.length,
    counts: Object.fromEntries(STOP_CLASSES.map((stopClass) => [stopClass, counts.get(stopClass) ?? 0])),
    outcomes: outcomes.map((outcome) => ({
      vendor: outcome.target.manufacturerId,
      catalogNumber: outcome.target.catalogNumber,
      stopClass: outcome.stopClass,
      evidence: outcome.evidence,
      requests: outcome.requests,
      searchRequests: outcome.searchRequests,
      candidateCount: outcome.candidateCount,
      topUrl: outcome.topUrl,
      error: outcome.error
    }))
  };

  if (options.comparePath) {
    try {
      const baseline = JSON.parse(await fs.readFile(options.comparePath, "utf8")) as typeof report;
      console.log(`\n=== vs ${path.relative(repoRoot, options.comparePath)} ===`);
      for (const stopClass of STOP_CLASSES) {
        const before = baseline.counts?.[stopClass] ?? 0;
        const after = counts.get(stopClass) ?? 0;
        if (!before && !after) continue;
        const delta = after - before;
        console.log(`${pad(stopClass, 26)}${padLeft(String(before), 5)} -> ${padLeft(String(after), 5)}  ${delta > 0 ? `+${delta}` : delta}`);
      }
      if ((counts.get("hit") ?? 0) < (baseline.counts?.hit ?? 0)) {
        console.log("\n  !! hit count DROPPED. That is a regression regardless of how the other classes moved.");
      }
    } catch (error) {
      console.log(`\n(could not read baseline: ${error instanceof Error ? error.message : String(error)})`);
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
